import fs from 'node:fs';
import path from 'node:path';

/** A screenshot or recording kept with a job, for the lead, reviewers and the user to see. */
export interface Evidence {
  /** Name inside the job's evidence directory. */
  file: string;
  path: string;
  /** Turn it was last written in. */
  turn: number;
  /** Saved by the worker, or attached by the lead to a message. */
  from: 'worker' | 'lead';
  bytes: number;
  /** Modification time, so a file rewritten under the same name counts as new and viewers do not show a cached copy. */
  modified: number;
}

/** Media a browser and the desktop app can show. SVG is left out: it can carry script. */
export const EVIDENCE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};
const MAX_FILES = 50;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

export const evidenceType = (file: string): string | undefined => EVIDENCE_TYPES[path.extname(file).toLowerCase()];
export const isImage = (file: string) => evidenceType(file)?.startsWith('image/') ?? false;

/** Records files the worker saved or rewrote since the last look; anything else in the directory is ignored. */
export function collectEvidence(dir: string, known: Evidence[], turn: number): Evidence[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return known;
  }
  const kept: Evidence[] = [];
  for (const file of names.sort()) {
    const earlier = known.find((item) => item.file === file);
    if (!evidenceType(file) || (!earlier && kept.length >= MAX_FILES)) continue;
    const full = path.join(dir, file);
    // A link could point anywhere on the machine; only plain files are shown. The file may also vanish meanwhile.
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > MAX_BYTES) continue;
    if (earlier && earlier.modified === stat.mtimeMs && earlier.bytes === stat.size) kept.push(earlier);
    else kept.push({ file, path: full, turn, from: earlier?.from ?? 'worker', bytes: stat.size, modified: stat.mtimeMs });
  }
  return kept;
}

/**
 * Opens a recorded file for reading without following a link, since the worker can replace the file after it
 * was recorded. The descriptor is the caller's to close.
 */
export function openEvidence(item: Evidence): { fd: number; size: number } | null {
  let fd: number;
  try {
    fd = fs.openSync(item.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) {
    fs.closeSync(fd);
    return null;
  }
  return { fd, size: stat.size };
}

/** Checks the lead's attachments before anything is copied, so a refused message leaves nothing behind. */
export function checkAttachments(sources: unknown): string[] {
  if (sources === undefined) return [];
  if (!Array.isArray(sources) || sources.some((source) => typeof source !== 'string' || !source)) throw new Error('attachments must be a list of file paths.');
  if (sources.length > MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} attachments per message.`);
  return sources.map((source: string) => {
    // The daemon's working directory means nothing to the caller.
    if (!path.isAbsolute(source)) throw new Error(`Attachments must be absolute paths: ${source}`);
    if (!evidenceType(source)) throw new Error(`${source} is not an image or video: attach ${Object.keys(EVIDENCE_TYPES).join(', ')} files.`);
    const stat = fs.statSync(source, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error(`Attachment not found: ${source}`);
    if (stat.size > MAX_BYTES) throw new Error(`${source} is larger than ${MAX_BYTES / 1024 / 1024} MB.`);
    try {
      fs.accessSync(source, fs.constants.R_OK);
    } catch {
      throw new Error(`Attachment cannot be read: ${source}`);
    }
    return source;
  });
}

/** Copies checked attachments into the evidence directory, where the worker can open them for as long as the job is kept. */
export function attachEvidence(dir: string, sources: string[], turn: number): Evidence[] {
  fs.mkdirSync(dir, { recursive: true });
  const added: Evidence[] = [];
  for (const source of sources) {
    const data = fs.readFileSync(source);
    const ext = path.extname(source);
    const stem = `lead-${turn}-${path.basename(source, ext)}`;
    for (let n = 1; ; n++) {
      const file = `${stem}${n > 1 ? `-${n}` : ''}${ext}`;
      const full = path.join(dir, file);
      try {
        // Exclusive create: a name the worker planted, a link among them, is skipped rather than written through.
        fs.writeFileSync(full, data, { flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
      added.push({ file, path: full, turn, from: 'lead', bytes: data.length, modified: fs.statSync(full).mtimeMs });
      break;
    }
  }
  return added;
}

/** Undoes `attachEvidence` when the message it was for could not be sent. */
export function detachEvidence(items: Evidence[]): void {
  for (const item of items) fs.rmSync(item.path, { force: true });
}

/** What the worker is told about the lead's attachments. */
export const attachmentsNote = (items: Evidence[]) =>
  items.length ? `\n\n# Attached by the lead\nOpen these to see them:\n${items.map((item) => `- ${item.path}`).join('\n')}` : '';

/** Resolves the names a worker passes with a question to evidence it saved; anything else is refused. */
export function questionAttachments(dir: string, names: unknown): string[] {
  if (names === undefined) return [];
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !name)) throw new Error('attachments must be a list of file names in your evidence directory.');
  if (names.length > MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} attachments per question.`);
  return names.map((name: string) => {
    const file = path.basename(name);
    const full = path.join(dir, file);
    if (path.resolve(dir, name) !== full) throw new Error(`${name} is not in your evidence directory, ${dir}. Save it there first.`);
    if (!evidenceType(file)) throw new Error(`${name} is not an image or video.`);
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error(`${name} is not in your evidence directory, ${dir}. Save it there first.`);
    return file;
  });
}

/** Width and height from the header, or null when the bytes are not the image the name says. */
export function imageSize(data: Buffer, type: string): { width: number; height: number } | null {
  if (type === 'image/png' && data.length >= 24 && data.readUInt32BE(0) === 0x89504e47 && data.toString('ascii', 12, 16) === 'IHDR') {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (type === 'image/gif' && data.length >= 10 && data.toString('ascii', 0, 4) === 'GIF8') {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if (type === 'image/webp' && data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = data.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    if (chunk === 'VP8 ') return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = data.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    return null;
  }
  if (type === 'image/jpeg' && data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    // Walk the segments to the frame header, which holds the size.
    for (let at = 2; at + 9 < data.length;) {
      if (data[at] !== 0xff) return null;
      const marker = data[at + 1];
      const length = data.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: data.readUInt16BE(at + 7), height: data.readUInt16BE(at + 5) };
      }
      at += 2 + length;
    }
  }
  return null;
}

const MAX_IMAGES = 4;
// Claude refuses an image over 5 MB encoded or 8000 px on a side, and a refused image would fail the lead's next turns too.
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
const MAX_IMAGE_SIDE = 8000;

/** Only images Claude will take; the rest, and any beyond the first few, stay as the paths the text already lists. */
export function imageContent(items: Evidence[]): { type: 'image'; data: string; mimeType: string }[] {
  const content = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (content.length >= MAX_IMAGES || seen.has(item.path)) continue;
    seen.add(item.path);
    // Without following links: the worker may have swapped the file for one since it was recorded.
    const opened = openEvidence(item);
    if (!opened) continue;
    try {
      if (opened.size === 0 || opened.size > MAX_IMAGE_BYTES) continue;
      const data = Buffer.alloc(opened.size);
      fs.readSync(opened.fd, data, 0, opened.size, 0);
      const mimeType = evidenceType(item.file)!;
      const size = imageSize(data, mimeType);
      if (!size || !size.width || !size.height || size.width > MAX_IMAGE_SIDE || size.height > MAX_IMAGE_SIDE) continue;
      content.push({ type: 'image' as const, data: data.toString('base64'), mimeType });
    } finally {
      fs.closeSync(opened.fd);
    }
  }
  return content;
}
