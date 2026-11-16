import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const output = path.resolve('release/Crew.app');
fs.rmSync(output, { recursive: true, force: true });
fs.cpSync('native/build/Crew.app', output, { recursive: true });
execFileSync('codesign', ['--verify', '--deep', '--strict', output], { stdio: 'inherit' });
// The archive a release carries for the app's updater (native/Sources/Crew/Updater.swift), one per architecture since
// the bundled Node runtime is built for this Mac's.
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const archive = path.resolve(`release/Crew-macOS-${process.arch}-${version}.zip`);
fs.rmSync(archive, { force: true });
execFileSync('ditto', ['-c', '-k', '--keepParent', output, archive], { stdio: 'inherit' });
console.log(output);
console.log(archive);
