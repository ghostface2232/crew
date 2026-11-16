import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';

// macOS builds the native SwiftUI app; every other system builds the Electron shell around the web board.
const command = process.argv[2];
const native = process.platform === 'darwin';
const scripts = {
  build: native ? 'build-desktop.mjs' : 'build-electron.mjs',
  package: native ? 'package-desktop.mjs' : 'package-electron.mjs',
  smoke: native ? 'smoke-desktop.mjs' : 'smoke-electron.mjs',
};
const node = (script) => execFileSync(process.execPath, [`scripts/${script}`], { stdio: 'inherit' });
if (command === 'open') {
  if (native) execFileSync('open', ['native/build/Crew.app'], { stdio: 'inherit' });
  else {
    const electron = createRequire(import.meta.url)('electron');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    spawn(electron, ['desktop/build'], { stdio: 'ignore', detached: true, env }).unref();
  }
} else if (scripts[command]) node(scripts[command]);
else throw new Error('Usage: node scripts/desktop.mjs build|package|smoke|open');
