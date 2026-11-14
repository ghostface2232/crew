import fs from 'node:fs';

/**
 * Writes a fake agent executable at `bin` that runs `source` with Node.
 * Windows cannot run shebang files, so it gets a `.cmd` wrapper instead;
 * `agentCommand` resolves the extensionless `bin` to it.
 */
export function writeFakeBin(bin: string, source: string): void {
  if (process.platform !== 'win32') {
    fs.writeFileSync(bin, `#!${process.execPath}\n${source}`, { mode: 0o700 });
    return;
  }
  fs.writeFileSync(`${bin}.cjs`, source);
  fs.writeFileSync(`${bin}.cmd`, `@"${process.execPath}" "%~dp0${bin.split(/[\\/]/).pop()}.cjs" %*\r\n`);
}
