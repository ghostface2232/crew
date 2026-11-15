import { createElement } from 'react';
import type { ReactNode } from 'react';

export interface ReportBlock {
  type: 'heading' | 'code' | 'prose';
  text: string;
}

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong' | 'em'; children: InlineNode[] }
  | { type: 'link'; href: string; children: InlineNode[] };

export function reportBlocks(text: string): ReportBlock[] {
  const blocks: ReportBlock[] = [];
  let lines: string[] = [];
  let fenced = false;
  function flush(type: ReportBlock['type']) {
    const content = lines.join('\n').replace(/^\n+|\n+$/g, '');
    if (content) blocks.push({ type, text: content });
    lines = [];
  }
  for (const line of text.split(/\r\n|[\n\r\u0085\u2028\u2029]/)) {
    if (/^ *(?:```|~~~)/.test(line)) {
      flush(fenced ? 'code' : 'prose');
      fenced = !fenced;
    } else {
      const heading = !fenced && /^#{1,6}\s+(.*?)[\s#]*$/.exec(line);
      if (heading && heading[1]) {
        flush('prose');
        blocks.push({ type: 'heading', text: heading[1] });
      } else {
        lines.push(line);
      }
    }
  }
  flush(fenced ? 'code' : 'prose');
  return blocks;
}

export function inlineMarkdown(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  function plain(value: string) {
    const last = nodes.at(-1);
    if (last?.type === 'text') last.text += value;
    else nodes.push({ type: 'text', text: value });
  }
  function underscoreBoundary(start: number, length: number, opening: boolean): boolean {
    if (text[start - 1] === '_' || text[start + length] === '_') return false;
    const before = Array.from(text.slice(0, start)).at(-1) ?? '';
    const after = Array.from(text.slice(start + length))[0] ?? '';
    const beforeSpace = !before || /\s/u.test(before);
    const afterSpace = !after || /\s/u.test(after);
    const beforePunctuation = /[\p{P}\p{S}]/u.test(before);
    const afterPunctuation = /[\p{P}\p{S}]/u.test(after);
    const left = !afterSpace && (!afterPunctuation || beforeSpace || beforePunctuation);
    const right = !beforeSpace && (!beforePunctuation || afterSpace || afterPunctuation);
    return opening ? left && (!right || beforePunctuation) : right && (!left || afterPunctuation);
  }
  for (let i = 0; i < text.length;) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        nodes.push({ type: 'code', text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (text[i] === '[') {
      const labelEnd = text.indexOf('](', i + 1);
      if (labelEnd !== -1) {
        let end = labelEnd + 2;
        let depth = 1;
        for (; end < text.length; end++) {
          if (text[end] === '(') depth++;
          if (text[end] === ')' && --depth === 0) break;
        }
        if (depth === 0) {
          const href = text.slice(labelEnd + 2, end);
          if (/^(?:https?:\/\/|mailto:)/i.test(href)) {
            nodes.push({ type: 'link', href, children: inlineMarkdown(text.slice(i + 1, labelEnd)) });
          } else {
            plain(text.slice(i, end + 1));
          }
          i = end + 1;
          continue;
        }
      }
    }
    const delimiter = ['**', '__', '*', '_'].find((value) => text.startsWith(value, i)
      && (value[0] !== '_' || underscoreBoundary(i, value.length, true)));
    if (delimiter) {
      let end = text.indexOf(delimiter, i + delimiter.length);
      while (end !== -1 && delimiter[0] === '_' && !underscoreBoundary(end, delimiter.length, false)) {
        end = text.indexOf(delimiter, end + 1);
      }
      if (end > i + delimiter.length) {
        nodes.push({ type: delimiter.length === 2 ? 'strong' : 'em',
          children: inlineMarkdown(text.slice(i + delimiter.length, end)) });
        i = end + delimiter.length;
        continue;
      }
    }
    plain(text[i]);
    i++;
  }
  return nodes;
}

function renderInline(nodes: InlineNode[]): ReactNode[] {
  return nodes.map((node, key) => {
    if (node.type === 'text') return node.text;
    if (node.type === 'code') return createElement('code', { key }, node.text);
    if (node.type === 'link') {
      return createElement('a', { key, href: node.href, target: '_blank', rel: 'noreferrer' }, ...renderInline(node.children));
    }
    return createElement(node.type, { key }, ...renderInline(node.children));
  });
}

export function ReportText({ text }: { text: string }) {
  return createElement('div', { className: 'report selectable' }, ...reportBlocks(text).map((block, key) => {
    if (block.type === 'code') {
      return createElement('pre', { key, className: 'report-code' }, createElement('code', null, block.text));
    }
    return createElement('p', { key, className: `report-${block.type}`, style: { whiteSpace: 'pre-wrap' } },
      ...(block.type === 'heading' ? [block.text] : renderInline(inlineMarkdown(block.text))));
  }));
}
