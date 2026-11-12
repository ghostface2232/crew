import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveConfig } from './config.ts';
import type { Config } from './config.ts';

/**
 * Writes made from the board's settings view. Each one edits a file the user could edit by hand,
 * so the board and a text editor stay interchangeable.
 */

const isLink = (target: string) => fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;

/**
 * Replaces `file` in one step. A project's `.crew` folder comes with its repository, which may not be
 * the user's own, so nothing here follows a link: a planted link would send the text to a file of the
 * repository author's choosing. The temporary file has an unguessable name and must not already exist.
 */
function writeAtomic(file: string, text: string): void {
  const dir = path.dirname(file);
  if (isLink(dir) || isLink(file)) throw new Error(`${isLink(dir) ? dir : file} is a symbolic link, so it was not written to.`);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temp, text, { flag: 'wx' });
  fs.renameSync(temp, file);
}

/**
 * Replaces the role table in config.json, keeping every other setting. Blank model and effort
 * fields are dropped, meaning "use the agent's own". Throws without writing if the table is invalid
 * or if the existing file cannot be parsed, so a save never destroys what it could not read.
 */
export function saveRoles(home: string, roles: unknown): Config['roles'] {
  const file = path.join(home, 'config.json');
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${file} is not valid JSON, so it was left untouched: ${(err as Error).message}`);
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(`${file} does not hold a settings object, so it was left untouched.`);
  const cleaned = roles && typeof roles === 'object' && !Array.isArray(roles)
    ? Object.fromEntries(Object.entries(roles).map(([role, entry]) => [
        role,
        entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== '')) : entry,
      ]))
    : roles;
  const next = { ...current, roles: cleaned };
  const resolved = resolveConfig(next as never);
  writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  return resolved.roles;
}

/** File holding the shared instructions for one project, or for every project when `project` is null. */
export function instructionsFile(home: string, project: string | null): string {
  return project ? path.join(project, '.crew', 'instructions.md') : path.join(home, 'instructions.md');
}

export function readInstructions(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) return '';
    throw new Error(`Could not read ${file}: ${(err as Error).message}`);
  }
}

/** Blank text removes the file: no instructions and an empty file mean the same, and one fewer file to wonder about. */
export function writeInstructions(file: string, text: string): void {
  const dir = path.dirname(file);
  if (isLink(dir)) throw new Error(`${dir} is a symbolic link, so it was not written to.`);
  // A link at the file itself can be removed safely, but a linked parent must not be followed.
  if (!text.trim()) fs.rmSync(file, { force: true });
  else writeAtomic(file, text.endsWith('\n') ? text : `${text}\n`);
}
