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
    const description = /^description:\s*(.+)$/m.exec(fs.readFileSync(file, 'utf8').split(/^---\s*$/m)[1] ?? '')?.[1].trim() ?? '';
    return { name, description, file };
  });
}
