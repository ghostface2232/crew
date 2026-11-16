import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isNewer } from '../plugin/bridge/client.ts';
import type { AppUpdate } from '../plugin/board/src/types.ts';

// The Windows app's updater. It reads the latest GitHub release, downloads its installer while the user is away, and
// keeps it staged across launches until the user chooses to install. GitHub's own SHA-256 digest of the asset proves
// the download is intact; it arrives over the same TLS connection as the download link, so it is no signature.

export const RELEASES = 'https://api.github.com/repos/ghostface2232/crew/releases/latest';
export const installerName = (version: string) => `Crew-Setup-${version}.exe`;

export interface Release {
  version: string;
  url: string;
  sha256: string;
  size: number;
  page?: string;
}

const VERSION = /^\d+(\.\d+){0,3}$/;

/** Downloads must be HTTPS; a loopback feed is allowed for testing an updater against a local server. */
function fetchable(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const { protocol, hostname } = new URL(url);
  return protocol === 'https:' || (protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(hostname));
}

/** The installer a GitHub release offers, or null when it is a draft, a prerelease, or lacks a usable asset or digest. */
export function parseRelease(data: unknown): Release | null {
  const release = data as {
    tag_name?: unknown; draft?: unknown; prerelease?: unknown; html_url?: unknown;
    assets?: { name?: unknown; browser_download_url?: unknown; digest?: unknown; size?: unknown }[];
  } | null;
  if (!release || release.draft || release.prerelease || typeof release.tag_name !== 'string') return null;
  const version = release.tag_name.replace(/^v/, '');
  if (!VERSION.test(version)) return null;
  const asset = Array.isArray(release.assets) ? release.assets.find((item) => item?.name === installerName(version)) : undefined;
  const sha256 = typeof asset?.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest)?.[1]?.toLowerCase() : undefined;
  const url = asset?.browser_download_url;
  if (!sha256 || typeof url !== 'string' || !fetchable(url)) return null;
  const page = typeof release.html_url === 'string' && fetchable(release.html_url) ? release.html_url : undefined;
  return { version, url, sha256, size: typeof asset!.size === 'number' ? asset!.size : 0, ...(page ? { page } : {}) };
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/** The installer a past launch downloaded and verified, kept beside it. */
interface Staged {
  version: string;
  sha256: string;
  page?: string;
}

export class Updater {
  status: AppUpdate;
  private release: Release | null = null;
  private busy: Promise<void> | null = null;
  private readonly dir: string;
  private readonly feed: string;
  private readonly onChange: (status: AppUpdate) => void;

  constructor(options: { dir: string; current: string; feed?: string; supported: boolean; onChange?: (status: AppUpdate) => void }) {
    this.dir = options.dir;
    this.feed = options.feed ?? RELEASES;
    this.onChange = options.onChange ?? (() => {});
    this.status = { current: options.current, state: options.supported ? 'idle' : 'unsupported' };
  }

  private get manifest() {
    return path.join(this.dir, 'staged.json');
  }

  /** The staged installer's path, while one is ready or being installed. */
  get installer(): string | null {
    const { state, latest } = this.status;
    return (state === 'ready' || state === 'installing') && latest ? path.join(this.dir, installerName(latest)) : null;
  }

  private set(next: Omit<AppUpdate, 'current'>) {
    this.status = { current: this.status.current, ...next };
    this.onChange(this.status);
  }

  /** Picks up an installer an earlier launch staged; one no newer than this app, or no longer intact, is removed. */
  async load(): Promise<void> {
    if (this.status.state === 'unsupported') return;
    let staged: Staged | null = null;
    try {
      staged = JSON.parse(fs.readFileSync(this.manifest, 'utf8'));
    } catch {
      /* Nothing staged. */
    }
    const file = staged && VERSION.test(staged.version) ? path.join(this.dir, installerName(staged.version)) : null;
    if (staged && file && isNewer(staged.version, this.status.current) && await hashFile(file).then((sha) => sha === staged.sha256, () => false)) {
      this.release = { version: staged.version, sha256: staged.sha256, url: '', size: 0, ...(staged.page ? { page: staged.page } : {}) };
      this.set({ state: 'ready', latest: staged.version, ...(staged.page ? { page: staged.page } : {}) });
      return;
    }
    this.clean();
  }

  /** Removes everything staged. */
  private clean() {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      try {
        fs.rmSync(path.join(this.dir, name), { force: true, recursive: true, maxRetries: 0 });
      } catch {
        // An installer that is still running holds its file; a later launch removes it.
      }
    }
  }

  /** Asks GitHub for the latest release. A release already staged stays ready. */
  check(): Promise<void> {
    if (this.status.state === 'unsupported' || this.status.state === 'installing') return Promise.resolve();
    return this.exclusive(async () => {
      const before = this.status;
      if (before.state !== 'ready') this.set({ state: 'checking' });
      try {
        const response = await fetch(this.feed, {
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'Crew-Desktop' },
          signal: AbortSignal.timeout(15_000),
        });
        // A repository with no release yet answers 404: there is simply nothing newer.
        const release = response.status === 404 ? null : response.ok ? parseRelease(await response.json()) : undefined;
        if (release === undefined) throw new Error(`GitHub answered ${response.status}.`);
        const checkedAt = Date.now();
        // An install that started while this check ran keeps its installer.
        if (this.status.state === 'installing') return;
        if (release && !isNewer(release.version, this.status.current)) {
          // As new as the latest release: anything staged is out of date.
          this.release = null;
          this.clean();
          this.set({ state: 'idle', checkedAt });
        } else if (before.state === 'ready' && (!release || before.latest === release.version)) {
          // No release, or one without a usable installer, leaves the staged one ready.
          const { error: _, ...kept } = before;
          this.set({ ...kept, checkedAt, page: release?.page ?? before.page });
        } else if (!release) {
          this.release = null;
          this.set({ state: 'idle', checkedAt });
        } else {
          this.release = release;
          this.set({ state: 'available', latest: release.version, checkedAt, ...(release.page ? { page: release.page } : {}) });
        }
      } catch (error) {
        if (this.status.state === 'installing') return;
        // A failed check leaves a staged installer ready.
        if (before.state === 'ready') this.set({ ...before });
        else this.set({ state: 'idle', checkedAt: before.checkedAt, error: `Could not check for updates: ${(error as Error).message}` });
      }
    });
  }

  /** Downloads the release on offer to a partial file, verifies it, and stages it. */
  download(): Promise<void> {
    if (this.status.state !== 'available' || !this.release) return Promise.resolve();
    const release = this.release;
    return this.exclusive(async () => {
      const name = installerName(release.version);
      const file = path.join(this.dir, name);
      const partial = `${file}.partial`;
      const page = release.page ? { page: release.page } : {};
      this.set({ state: 'downloading', latest: release.version, progress: 0, checkedAt: this.status.checkedAt, ...page });
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        this.clean();
        // Ten minutes for the whole download: fetch's own timeout stops at the response headers.
        const response = await fetch(release.url, { signal: AbortSignal.timeout(600_000), headers: { 'user-agent': 'Crew-Desktop' } });
        if (!response.ok || !response.body) throw new Error(`the download answered ${response.status}`);
        const total = Number(response.headers.get('content-length')) || release.size;
        const hash = createHash('sha256');
        let received = 0;
        let shown = 0;
        const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
        body.on('data', (chunk: Buffer) => {
          hash.update(chunk);
          received += chunk.length;
          // Progress goes out in whole percents, not on every chunk.
          const progress = total ? Math.min(1, received / total) : 0;
          if (progress - shown >= 0.01) {
            shown = progress;
            this.set({ ...this.status, progress });
          }
        });
        await pipeline(body, fs.createWriteStream(partial));
        if (hash.digest('hex') !== release.sha256) throw new Error('the download did not match the release’s SHA-256 digest');
        fs.renameSync(partial, file);
        fs.writeFileSync(this.manifest, JSON.stringify({ version: release.version, sha256: release.sha256, ...page } satisfies Staged));
        this.set({ state: 'ready', latest: release.version, checkedAt: this.status.checkedAt, ...page });
      } catch (error) {
        fs.rmSync(partial, { force: true });
        this.set({ state: 'available', latest: release.version, checkedAt: this.status.checkedAt, ...page, error: `Could not download ${release.version}: ${(error as Error).message}` });
      }
    });
  }

  /**
   * Starts installing the staged update, so nothing replaces it while the app hands over; `waiting` counts the jobs
   * it waits for first. False unless an update is ready.
   */
  installing(waiting = 0): boolean {
    const { state, latest, page, checkedAt } = this.status;
    if (state !== 'ready') return false;
    this.set({ state: 'installing', latest, checkedAt, ...(page ? { page } : {}), waiting });
    return true;
  }

  /** Sets how many jobs an install waits for, which it can be called off during. An install called off stays off. */
  waitFor(waiting: number) {
    if (this.status.state !== 'installing' || this.status.waiting === waiting) return;
    this.set({ ...this.status, waiting });
  }

  /** The daemon is being asked to stop: from here the install can no longer be called off. */
  stoppingDaemon() {
    if (this.status.state !== 'installing' || this.status.waiting === undefined) return;
    const { waiting: _, ...rest } = this.status;
    this.set(rest);
  }

  /** Puts a staged installer back: the user cancelled, or the install could not start (`message`). */
  failed(message?: string) {
    if (this.status.state !== 'installing') return;
    const { latest, page, checkedAt } = this.status;
    this.set({ state: 'ready', latest, checkedAt, ...(page ? { page } : {}), ...(message ? { error: message } : {}) });
  }

  /** Checks and downloads never overlap; a second request while one runs joins it. */
  private exclusive(task: () => Promise<void>): Promise<void> {
    this.busy ??= task().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }
}
