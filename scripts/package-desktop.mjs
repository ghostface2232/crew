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
// The disk image people download to install: the app beside an Applications link to drag it onto.
const stage = path.resolve('release/dmg');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage);
execFileSync('ditto', [output, path.join(stage, 'Crew.app')], { stdio: 'inherit' });
fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
const image = path.resolve(`release/Crew-macOS-${process.arch}-${version}.dmg`);
fs.rmSync(image, { force: true });
execFileSync('hdiutil', ['create', '-volname', 'Crew', '-srcfolder', stage, '-format', 'UDZO', '-fs', 'APFS', '-ov', image], { stdio: 'inherit' });
fs.rmSync(stage, { recursive: true, force: true });
console.log(output);
console.log(archive);
console.log(image);
