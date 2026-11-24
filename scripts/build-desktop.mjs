import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bundlePlugin } from './bundle-plugin.mjs';

if (process.platform !== 'darwin') throw new Error('The native Crew app builds on macOS with Xcode 27 or newer.');
const run = (bin, args, options = {}) => execFileSync(bin, args, { stdio: 'inherit', ...options });
const build = path.resolve('native/build');
const app = path.join(build, 'Crew.app');
const contents = path.join(app, 'Contents');
const resources = path.join(contents, 'Resources');
const configuration = process.env.CREW_BUILD_CONFIGURATION ?? 'release';
if (!['debug', 'release'].includes(configuration)) throw new Error('CREW_BUILD_CONFIGURATION must be debug or release.');
fs.mkdirSync(build, { recursive: true });
const env = {
  ...process.env,
  CLANG_MODULE_CACHE_PATH: path.join(build, 'ModuleCache'),
  SWIFTPM_MODULECACHE_OVERRIDE: path.join(build, 'ModuleCache'),
};
const swiftArgs = ['--package-path', 'native', '--scratch-path', path.join(build, 'swift'), '--disable-sandbox', '-c', configuration];
run('swift', ['build', ...swiftArgs], { env });
const binPath = execFileSync('swift', ['build', ...swiftArgs, '--show-bin-path'], { env, encoding: 'utf8' }).trim();
fs.rmSync(path.join(build, 'bridge'), { recursive: true, force: true });
run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.native.json']);
fs.rmSync(app, { recursive: true, force: true });
fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
fs.mkdirSync(path.join(resources, 'runtime'), { recursive: true });
fs.cpSync('native/Resources/ko.lproj', path.join(resources, 'ko.lproj'), { recursive: true });
fs.copyFileSync(path.join(binPath, 'Crew'), path.join(contents, 'MacOS/Crew'));
fs.chmodSync(path.join(contents, 'MacOS/Crew'), 0o755);
fs.cpSync(path.join(build, 'bridge'), path.join(resources, 'bridge'), { recursive: true });
fs.writeFileSync(path.join(resources, 'bridge/package.json'), '{"type":"module"}\n');
await bundlePlugin(path.join(resources, 'bridge'), '../../runtime/node');

// A standalone Node distribution keeps Finder launches independent of shell setup and Homebrew.
const node = fs.realpathSync(process.execPath);
const dependencies = execFileSync('otool', ['-L', node], { encoding: 'utf8' }).split('\n').slice(1).filter(Boolean);
if (dependencies.some((line) => !/^\s+(\/usr\/lib\/|\/System\/Library\/)/.test(line))) {
  throw new Error('Use an official standalone Node.js distribution; this Node depends on external dynamic libraries.');
}
const licensePath = process.env.CREW_NODE_LICENSE ?? path.resolve(path.dirname(node), '..', 'LICENSE');
if (!fs.existsSync(licensePath)) throw new Error('Set CREW_NODE_LICENSE to the LICENSE shipped with this Node.js distribution.');
fs.copyFileSync(node, path.join(resources, 'runtime/node'));
fs.chmodSync(path.join(resources, 'runtime/node'), 0o755);
fs.copyFileSync(licensePath, path.join(resources, 'runtime/LICENSE'));
const catalog = path.join(build, 'Services.xcassets');
fs.mkdirSync(catalog, { recursive: true });
fs.writeFileSync(path.join(catalog, 'Contents.json'), JSON.stringify({ info: { version: 1, author: 'xcode' } }));
for (const name of ['ClaudeCode', 'Codex', 'Antigravity', 'Cursor']) {
  const set = path.join(catalog, `Service${name}.imageset`);
  fs.mkdirSync(set, { recursive: true });
  fs.copyFileSync(`assets/${name}.svg`, path.join(set, `${name}.svg`));
  fs.writeFileSync(path.join(set, 'Contents.json'), JSON.stringify({
    images: [{ filename: `${name}.svg`, idiom: 'universal' }],
    info: { version: 1, author: 'xcode' },
    properties: { 'preserves-vector-representation': true, 'template-rendering-intent': 'template' },
  }));
}
// The menu bar mark: a template image, so the system tints it for light and dark menu bars.
const menuBar = path.join(catalog, 'MenuBarCrew.imageset');
fs.mkdirSync(menuBar, { recursive: true });
fs.copyFileSync('assets/crew_menubar.svg', path.join(menuBar, 'crew_menubar.svg'));
fs.writeFileSync(path.join(menuBar, 'Contents.json'), JSON.stringify({
  images: [{ filename: 'crew_menubar.svg', idiom: 'universal' }],
  info: { version: 1, author: 'xcode' },
  properties: { 'preserves-vector-representation': true, 'template-rendering-intent': 'template' },
}));
// The app icon is an Icon Composer document. Compiled with the catalog, it becomes the layered icon in
// Assets.car and a flat crew.icns for the places that still read one.
const iconInfo = path.join(build, 'Icon.plist');
run('xcrun', ['actool', catalog, 'assets/crew.icon', '--compile', resources, '--app-icon', 'crew', '--output-partial-info-plist', iconInfo,
  '--platform', 'macosx', '--minimum-deployment-target', '26.0', '--output-format', 'human-readable-text']);
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const plist = {
  CFBundleName: 'Crew', CFBundleDisplayName: 'Crew', CFBundleExecutable: 'Crew',
  CFBundleIdentifier: 'dev.crew.native', CFBundlePackageType: 'APPL',
  CFBundleDevelopmentRegion: 'en', CFBundleLocalizations: ['en', 'ko'],
  CFBundleShortVersionString: version, CFBundleVersion: version,
  CFBundleIconFile: 'crew', CFBundleIconName: 'crew', LSMinimumSystemVersion: '26.0', NSPrincipalClass: 'NSApplication',
  NSHighResolutionCapable: true, NSSupportsAutomaticTermination: false,
  NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
};
const plistJSON = path.join(build, 'Info.json');
fs.writeFileSync(plistJSON, JSON.stringify(plist));
run('plutil', ['-convert', 'xml1', '-o', path.join(contents, 'Info.plist'), plistJSON]);
const licenses = [
  ['react', 'node_modules/react/LICENSE'],
  ['react-dom', 'node_modules/react-dom/LICENSE'],
  ['scheduler', 'node_modules/scheduler/LICENSE'],
  ['@fluentui/react-icons', 'plugin/board/fluentui-react-icons-LICENSE.txt'],
  ['@griffel/react', 'node_modules/@griffel/react/LICENSE.md'],
  ['@griffel/core', 'node_modules/@griffel/core/LICENSE.md'],
  ['@emotion/hash', 'node_modules/@emotion/hash/LICENSE'],
  ['Pretendard', 'plugin/board/pretendard-LICENSE.txt'],
].map(([name, file]) => `${name}\n${fs.readFileSync(file, 'utf8')}`);
licenses.push(`Node.js ${process.version}\nSee runtime/LICENSE for Node.js and its bundled dependencies.`);
fs.writeFileSync(path.join(resources, 'THIRD-PARTY-NOTICES.txt'), licenses.join('\n\n'));
// A release signs with one lasting certificate, so macOS keeps the folder access people grant across updates; an ad-hoc
// signature is tied to each build's hash. Local builds stay ad hoc.
const sign = ['--force', '--sign', process.env.CREW_SIGN_IDENTITY || '-', ...(process.env.CREW_SIGN_KEYCHAIN ? ['--keychain', process.env.CREW_SIGN_KEYCHAIN] : [])];
run('codesign', [...sign, path.join(resources, 'runtime/node')]);
run('codesign', [...sign, app]);
run('codesign', ['--verify', '--deep', '--strict', app]);
console.log(app);
