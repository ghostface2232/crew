import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalPath, isProjectIcon, PROJECT_SWITCHES, resolveConfig, TURN_TOKEN_CHOICES, validTurnTokenBudget } from './config.ts';
import type { Config, ProjectSettings } from './config.ts';
import { readInstructions } from './instructions.ts';
import type { SharedScope } from './instructions.ts';

export { readInstructions };

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
 * Replaces the role table in config.json, keeping every other setting. `roles` is the table as the user
 * writes it, so a role left out or without an agent keeps following its parent. Blank fields are dropped:
 * a blank agent means "same as the parent", a blank model or effort "use the agent's own". Throws without writing if the table is invalid
 * or if the existing file cannot be parsed, so a save never destroys what it could not read.
 */
export function saveRoles(home: string, roles: unknown): Pick<Config, 'roles' | 'roleSettings'> {
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
        entry && typeof entry === 'object' && !Array.isArray(entry) ? blankless(entry) : entry,
      ]).filter(([, entry]) => !(entry && typeof entry === 'object' && !Array.isArray(entry) && !Object.keys(entry).length)))
    : roles;
  const next = { ...current, roles: cleaned };
  const resolved = resolveConfig(next as never);
  writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  return { roles: resolved.roles, roleSettings: resolved.roleSettings };
}

/** An entry without blank fields, or agent settings left empty by them: a blank field is one never set. */
function blankless(entry: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry)
    .map(([key, value]) => [key, value && typeof value === 'object' && !Array.isArray(value) ? blankless(value) : value] as const)
    .filter(([, value]) => value !== '' && !(value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length)));
}

/** Turns peer ratings on or off in config.json, keeping every other setting. */
export const savePeerRatings = (home: string, enabled: unknown) => saveSwitch(home, 'peerRatings', enabled);
/** Turns the progress card in a lead's chat on or off in config.json, keeping every other setting. */
export const saveProgressCards = (home: string, enabled: unknown) => saveSwitch(home, 'progressCards', enabled);

/** A setting that is on by default, so on is left unwritten. */
function saveSwitch<K extends 'peerRatings' | 'progressCards'>(home: string, key: K, enabled: unknown): Pick<Config, K> {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false.');
  const file = path.join(home, 'config.json');
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${file} is not valid JSON, so it was left untouched: ${(err as Error).message}`);
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(`${file} does not hold a settings object, so it was left untouched.`);
  const { [key]: _old, ...rest } = current;
  const next = enabled ? rest : { ...rest, [key]: false };
  const resolved = resolveConfig(next as never);
  writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  return { [key]: resolved[key] } as Pick<Config, K>;
}

/** Sets the turn token budget in config.json, keeping every other setting. Null, the default, is left unwritten. */
export function saveTurnTokenBudget(home: string, budget: unknown): Pick<Config, 'turnTokenBudget'> {
  if (budget === undefined || !validTurnTokenBudget(budget)) throw new Error(`budget must be one of ${TURN_TOKEN_CHOICES.join(', ')}, "unlimited", or null.`);
  const file = path.join(home, 'config.json');
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${file} is not valid JSON, so it was left untouched: ${(err as Error).message}`);
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(`${file} does not hold a settings object, so it was left untouched.`);
  const { turnTokenBudget: _old, ...rest } = current;
  const next = budget === null ? rest : { ...rest, turnTokenBudget: budget };
  const resolved = resolveConfig(next as never);
  writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  return { turnTokenBudget: resolved.turnTokenBudget };
}

/** Sets or clears the preset in config.json, keeping every other setting. Refused without writing if it is not a preset. */
export function savePreset(home: string, preset: unknown): Pick<Config, 'preset' | 'presets'> {
  const file = path.join(home, 'config.json');
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${file} is not valid JSON, so it was left untouched: ${(err as Error).message}`);
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(`${file} does not hold a settings object, so it was left untouched.`);
  const { preset: _old, ...rest } = current;
  const next = preset === null || preset === undefined || preset === '' ? rest : { ...rest, preset };
  const resolved = resolveConfig(next as never);
  writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  return { preset: resolved.preset, presets: resolved.presets };
}

/** Sets the interface language in config.json, or clears it to follow the system, keeping every other setting. */
export function saveLanguage(home: string, language: unknown): Pick<Config, 'language'> {
  const file = path.join(home, 'config.json');
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${file} is not valid JSON, so it was left untouched: ${(err as Error).message}`);
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(`${file} does not hold a settings object, so it was left untouched.`);
  const { language: _old, ...rest } = current;
  const next = language === null || language === undefined || language === '' ? rest : { ...rest, language };
  const resolved = resolveConfig(next as never);
  writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  return { language: resolved.language };
}

/**
 * Turns one project's switches on or off, or sets its icon, in config.json, keeping every other setting. Only the
 * keys named in `changes` move. Off and the folder icon are the defaults, so a switch turned off or an icon set to
 * null is dropped, and a project left with nothing is removed.
 */
export function saveProjectSettings(home: string, project: string, changes: unknown): Pick<Config, 'projects'> {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('changes must be an object such as {"autonomy": true}.');
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'icon') {
      if (value !== null && !isProjectIcon(value)) throw new Error('icon must be an icon name such as "star", or null for the folder.');
      continue;
    }
    if (!(PROJECT_SWITCHES as readonly string[]).includes(key)) throw new Error(`${key} is not a project setting; use icon, ${PROJECT_SWITCHES.join(', ')}.`);
    if (typeof value !== 'boolean') throw new Error(`${key} must be true or false.`);
  }
  const file = path.join(home, 'config.json');
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${file} is not valid JSON, so it was left untouched: ${(err as Error).message}`);
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(`${file} does not hold a settings object, so it was left untouched.`);
  const key = canonicalPath(project);
  // Read through resolveConfig so another spelling of the same folder is folded into this one.
  const projects = { ...resolveConfig(current as never).projects };
  const settings: ProjectSettings = { ...projects[key] };
  for (const [name, value] of Object.entries(changes) as [keyof ProjectSettings, boolean | string | null][]) {
    if (name === 'icon') {
      if (typeof value === 'string') settings.icon = value;
      else delete settings.icon;
    } else if (value) settings[name] = true;
    else delete settings[name];
  }
  if (Object.keys(settings).length) projects[key] = settings;
  else delete projects[key];
  const { projects: _old, ...rest } = current;
  const next = Object.keys(projects).length ? { ...rest, projects } : rest;
  const resolved = resolveConfig(next as never);
  writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  return { projects: resolved.projects };
}

/** File holding the shared instructions for one project, or for every project when `project` is null. */
export function instructionsFile(home: string, project: string | null): string {
  return project ? path.join(project, '.crew', 'instructions.md') : path.join(home, 'instructions.md');
}

/** Blank text removes the file: no instructions and an empty file mean the same, and one fewer file to wonder about. */
export function writeInstructions(file: string, text: string): void {
  const dir = path.dirname(file);
  if (isLink(dir)) throw new Error(`${dir} is a symbolic link, so it was not written to.`);
  // A link at the file itself can be removed safely, but a linked parent must not be followed.
  if (!text.trim()) fs.rmSync(file, { force: true });
  else writeAtomic(file, text.endsWith('\n') ? text : `${text}\n`);
}

/** Adds text to the shared instructions as a paragraph of its own. Blank text is refused: it would add nothing. */
export function appendInstructions(file: string, text: string, scope: SharedScope): void {
  const added = text.trim();
  if (!added) throw new Error('There is no text to add.');
  const current = readInstructions(file, scope).trimEnd();
  writeInstructions(file, current ? `${current}\n\n${added}` : added);
}
