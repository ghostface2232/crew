import fs from 'node:fs';
import path from 'node:path';

interface Section {
  heading: string;
  file: string;
  text: string;
}

export interface Shared {
  /** Empty when there are none. */
  text: string;
  /** Files the text came from, for showing what a job was given. */
  sources: string[];
  sections: Section[];
}

function read(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    // No such file means "none", including when `.crew` is not a directory. Anything else must surface:
    // running without instructions that were written is worse than not running.
    if (['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) return '';
    throw new Error(`Could not read ${file}: ${(err as Error).message}`);
  }
}

const render = (section: Section) => `## ${section.heading}\n${section.text}`;

/**
 * Instructions for every agent on the crew, lead included: `instructions.md` in the Crew home, then
 * `.crew/instructions.md` in the project, which is read last so it can refine the first. Headings say
 * where each part comes from, because the project's file belongs to the repository, not necessarily to the user.
 * Crew hands them to each agent itself, so nothing is written into any service's own instruction files.
 */
export function sharedInstructions(home: string, project: string | null): Shared {
  const globalFile = path.join(home, 'instructions.md');
  const candidates: [heading: string, file: string][] = [['From the user, for every project', globalFile]];
  // With the home directory as the project, both names are one file.
  const projectFile = project && path.join(project, '.crew', 'instructions.md');
  if (projectFile && path.resolve(projectFile) !== path.resolve(globalFile)) candidates.push(['From this repository (`.crew/instructions.md`)', projectFile]);
  const sections = candidates.map(([heading, file]) => ({ heading, file, text: read(file) })).filter((s) => s.text);
  return { text: sections.map(render).join('\n\n'), sources: sections.map((s) => s.file), sections };
}

/** Claude Code replaces hook context longer than 10,000 characters with a 2,000-character preview. */
const CONTEXT_LIMIT = 9_000;

/** Hook context reporting that the instructions could not be loaded, so the failure is seen rather than skipped. */
export function loadFailure(err: unknown): string {
  return `Crew could not load the shared instructions for this session. ${(err as Error).message}. Crew jobs may fail the same way until this is fixed, so the user needs to know.`;
}

/** What a Claude session is told at its start. Empty when there is nothing to tell. */
export function leadContext(home: string, project: string): string {
  let shared: Shared;
  try {
    shared = sharedInstructions(home, project);
  } catch (err) {
    return loadFailure(err);
  }
  if (!shared.text) return '';
  const parts = ['The crew has shared instructions for every agent, and they apply to this session too. Agents started through the crew tools are given them automatically, so tasks handed to them need not repeat them.'];
  let used = parts[0].length;
  for (const section of shared.sections) {
    let part = render(section);
    // A part that does not fit is named, never cut: a cut-off copy would look complete.
    if (used + part.length > CONTEXT_LIMIT) part = `## ${section.heading}\nToo long to include here. The complete text is in ${section.file}, and none of it is in this session's context until that file is read.`;
    parts.push(part);
    used += part.length + 2;
  }
  return parts.join('\n\n');
}
