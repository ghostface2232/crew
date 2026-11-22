import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { debatePoints, stanceCounts } from '../plugin/board/src/debate.ts';

// Node strips .ts but does not recognize .tsx; this file uses createElement, without JSX.
const reportURL = new URL('../plugin/board/src/Report.ts', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url !== reportURL) return nextLoad(url, context);
    return { format: 'module', shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8')) };
  },
});
const { reportBlocks, inlineMarkdown, ReportText } = await import(reportURL) as typeof import('../plugin/board/src/Report.ts');
hooks.deregister();

const plain = (text: string) => ({ type: 'text', text });

test('debate points accept list markers, stance brackets, bold and case differences', () => {
  const points = debatePoints('1. **[AGREE]** One\n- 2. [disagree]: Two\n* 3. **alternative** — Three\n4. agree Four');
  assert.deepEqual(points, [
    { number: 1, stance: 'agree', title: 'One' },
    { number: 2, stance: 'disagree', title: 'Two' },
    { number: 3, stance: 'alternative', title: 'Three' },
    { number: 4, stance: 'agree', title: 'Four' },
  ]);
  assert.deepEqual(stanceCounts(points), { agree: 2, disagree: 1, alternative: 1 });
  assert.deepEqual(stanceCounts([]), { agree: 0, disagree: 0, alternative: 0 });
});

test('basis prefixes require a separator and headline formatting is removed', () => {
  assert.deepEqual(debatePoints([
    '1. agree · inferred — **Use** `cache`',
    '2. disagree [**VERIFIED**]: Checked',
    '3. alternative (read), Reuse',
    '4. agree Read the implementation',
    '5. agree verified behavior',
  ].join('\n')).map((point) => point.title), [
    'Use cache', 'Checked', 'Reuse', 'Read the implementation', 'verified behavior',
  ]);
});

test('headlines cut only at a first sentence end beyond twelve characters', () => {
  for (const punctuation of ['.', '!', '?', '。']) {
    assert.equal(debatePoints(`1. agree A sufficiently long headline${punctuation} Next sentence`)[0].title,
      `A sufficiently long headline${punctuation}`);
  }
  assert.equal(debatePoints('1. agree Short. A longer sentence. More')[0].title, 'Short. A longer sentence. More');
  assert.equal(debatePoints('1. agree 123456789012. More')[0].title, '123456789012. More');
});

test('headlines truncate at 140 graphemes and ignore lines without numbered stances', () => {
  const emoji = '👩‍💻';
  assert.equal(debatePoints(`1. agree ${emoji.repeat(141)}`)[0].title, emoji.repeat(139) + '…');
  assert.equal(debatePoints(`1. agree ${'a'.repeat(140)}`)[0].title, 'a'.repeat(140));
  assert.deepEqual(debatePoints('agree hello\n1) agree hello\n1. agreement hello\nhello\n'), []);
});

test('report blocks preserve prose spacing and extract headings and fenced code', () => {
  assert.deepEqual(reportBlocks('Intro\n  next\n\n# Title ##\n```ts\n# code\n  x\n```\nAfter\n~~~\ny\n~~~'), [
    { type: 'prose', text: 'Intro\n  next' },
    { type: 'heading', text: 'Title' },
    { type: 'code', text: '# code\n  x' },
    { type: 'prose', text: 'After' },
    { type: 'code', text: 'y' },
  ]);
  assert.deepEqual(reportBlocks('###### Six\n####### Seven\n # Indented\n#'), [
    { type: 'heading', text: 'Six' },
    { type: 'prose', text: '####### Seven\n # Indented\n#' },
  ]);
  assert.deepEqual(reportBlocks(''), []);
});

test('CRLF and unclosed indented fences follow native block behavior', () => {
  assert.deepEqual(reportBlocks('# Heading\r\n\r\nProse\r\n  ~~~js\r\n# literal\r\n  code\r\n'), [
    { type: 'heading', text: 'Heading' },
    { type: 'prose', text: 'Prose' },
    { type: 'code', text: '# literal\n  code' },
  ]);
});

test('inline Markdown parses both emphasis styles, code and safe links', () => {
  assert.deepEqual(inlineMarkdown('**bold** __also__ *italic* _also_ `**raw**`'), [
    { type: 'strong', children: [plain('bold')] }, plain(' '),
    { type: 'strong', children: [plain('also')] }, plain(' '),
    { type: 'em', children: [plain('italic')] }, plain(' '),
    { type: 'em', children: [plain('also')] }, plain(' '),
    { type: 'code', text: '**raw**' },
  ]);
  for (const href of ['https://example.com', 'http://example.com/a(b)', 'mailto:a@example.com']) {
    assert.deepEqual(inlineMarkdown(`[**label**](${href})`), [
      { type: 'link', href, children: [{ type: 'strong', children: [plain('label')] }] },
    ]);
  }
  assert.deepEqual(inlineMarkdown('**bold with _emphasis_**'), [
    { type: 'strong', children: [plain('bold with '), { type: 'em', children: [plain('emphasis')] }] },
  ]);
});

test('underscores respect word boundaries while asterisks work inside words', () => {
  for (const text of ['snake_case_name', 'a__b__c', '_word_tail', '__word__tail', '한글_단어_사이']) {
    assert.deepEqual(inlineMarkdown(text), [plain(text)]);
  }
  assert.deepEqual(inlineMarkdown('(_word_) __bold__ _snake_case_'), [
    plain('('), { type: 'em', children: [plain('word')] }, plain(') '),
    { type: 'strong', children: [plain('bold')] }, plain(' '),
    { type: 'em', children: [plain('snake_case')] },
  ]);
  assert.deepEqual(inlineMarkdown('a*b*c a**b**c'), [
    plain('a'), { type: 'em', children: [plain('b')] }, plain('c a'),
    { type: 'strong', children: [plain('b')] }, plain('c'),
  ]);
});

test('unsafe links, HTML and unmatched delimiters stay text', () => {
  for (const text of ['[bad](javascript:alert(1))', '[bad](data:text/html,hi)', '[relative](/path)', '<b>literal</b>', '**unclosed']) {
    assert.deepEqual(inlineMarkdown(text), [plain(text)]);
  }
});

test('asterisk bullets, file globs and unmatched runs stay literal beside emphasis', () => {
  for (const text of ['* item one\n* item two', 'src/*.ts and test/*.ts', 'src\\*.ts and test\\*.ts', '**unpaired*', '*word *']) {
    assert.deepEqual(inlineMarkdown(text), [plain(text)]);
  }
  assert.deepEqual(inlineMarkdown('* item one\n* *italic* and **bold**'), [
    plain('* item one\n* '), { type: 'em', children: [plain('italic')] }, plain(' and '),
    { type: 'strong', children: [plain('bold')] },
  ]);
});

test('only the matching brackets immediately before a destination form the link label', () => {
  const href = 'https://example.com';
  assert.deepEqual(inlineMarkdown(`see [1] and [the docs](${href})`), [
    plain('see [1] and '), { type: 'link', href, children: [plain('the docs')] },
  ]);
  const brackets = '['.repeat(4000);
  assert.deepEqual(inlineMarkdown(`${brackets}[the [nested] docs](${href})`), [
    plain(brackets), { type: 'link', href, children: [plain('the [nested] docs')] },
  ]);
  assert.deepEqual(inlineMarkdown(`[use \`[\`](${href})`), [
    { type: 'link', href, children: [plain('use '), { type: 'code', text: '[' }] },
  ]);
});

test('ReportText renders safe React elements with preserved whitespace', () => {
  const html = renderToStaticMarkup(ReportText({ text: '# Heading\n```\n<b>code</b>\n```\n<b>literal</b>\n**bold** [safe](https://example.com) [bad](javascript:alert(1))' }));
  assert.ok(html.startsWith('<div class="report selectable">'));
  assert.ok(html.includes('<p class="report-heading"'));
  assert.ok(html.includes('<pre class="report-code"><code>&lt;b&gt;code&lt;/b&gt;</code></pre>'));
  assert.ok(html.includes('white-space:pre-wrap'));
  assert.ok(html.includes('&lt;b&gt;literal&lt;/b&gt;'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<a href="https://example.com" target="_blank" rel="noreferrer">safe</a>'));
  assert.ok(html.includes('[bad](javascript:alert(1))'));
  assert.ok(!html.includes('href="javascript:'));
});
