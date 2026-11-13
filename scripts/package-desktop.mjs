import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const output = path.resolve('release/Crew.app');
fs.rmSync(output, { recursive: true, force: true });
fs.cpSync('native/build/Crew.app', output, { recursive: true });
execFileSync('codesign', ['--verify', '--deep', '--strict', output], { stdio: 'inherit' });
console.log(output);
