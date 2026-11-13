import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The user's own skills, shared by the agents on this machine. Workers are not shown them unless the lead picks some. */
export const SKILLS_ROOT = path.join(os.homedir(), '.agents', 'skills');

export interface Skill {
  name: string;
  description: string;
  /** The skill's SKILL.md; files it mentions are relative to its directory. */
  file: string;
}

/** Skills installed under `root`: each a directory holding a SKILL.md. */
export function listSkills(root = SKILLS_ROOT): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  return entries.filter((name) => fs.existsSync(path.join(root, name, 'SKILL.md'))).sort();
}

/** Resolves the lead's choice of skills, refusing a name that is not installed rather than dropping it unseen. */
export function findSkills(names: string[], root = SKILLS_ROOT): Skill[] {
  const installed = listSkills(root);
  const unknown = names.filter((name) => !installed.includes(name));
  if (unknown.length) {
    throw new Error(`Unknown skill(s): ${unknown.join(', ')}. Installed in ${root}: ${installed.join(', ') || 'none'}.`);
  }
  return [...new Set(names)].map((name) => {
    const file = path.join(root, name, 'SKILL.md');
    return { name, description: describe(fs.readFileSync(file, 'utf8')), file };
  });
}

/** The frontmatter's `description`, on one line; empty when there is none. */
function describe(text: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*$/m.exec(text);
  if (!front || front.index !== 0) return '';
  const lines = front[1].split(/\r?\n/);
  const at = lines.findIndex((line) => /^description:/.test(line));
  if (at < 0) return '';
  const value = lines[at].slice('description:'.length).trim();
  // A folded or literal block: the indented lines that follow.
  if (/^[>|][+-]?$/.test(value)) {
    const block: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (!/^\s/.test(line) && line !== '') break;
      block.push(line.trim());
    }
    return block.filter(Boolean).join(' ');
  }
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}

