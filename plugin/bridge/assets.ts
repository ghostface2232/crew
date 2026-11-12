import fs from 'node:fs';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};
export const BOARD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

/** Only Vite's flat, hashed asset names are public; source and arbitrary paths are not. */
export function boardAsset(root: string, pathname: string): { file: string; type: string; immutable: boolean } | null {
  const index = pathname === '/';
  if (!index && !/^\/assets\/[\w.-]+$/.test(pathname)) return null;
  const type = index ? 'text/html; charset=utf-8' : TYPES[path.extname(pathname)];
  if (!type) return null;
  const file = path.join(root, 'board', 'dist', index ? 'index.html' : pathname.slice(1));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return { file, type, immutable: !index };
}
