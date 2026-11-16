import { createRequire } from 'node:module';
import { build, Platform, Arch } from 'electron-builder';

const require = createRequire(import.meta.url);
const paths = await build({
  targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
  publish: 'never',
  config: {
    appId: 'dev.crew.desktop',
    productName: 'Crew',
    electronVersion: require('electron/package.json').version,
    directories: { app: 'desktop/build', output: 'release' },
    asar: false,
    files: ['**/*', '!node_modules/**/*'],
    npmRebuild: false,
    executableName: 'Crew',
    // One-click NSIS uses the package name for its per-user install directory.
    extraMetadata: { name: 'Crew', author: { name: 'Crew' }, description: 'Crew' },
    publish: null,
    win: { icon: 'desktop/build/desktop/icon.ico' },
    nsis: {
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      createStartMenuShortcut: true,
      artifactName: 'Crew-Setup-${version}.exe',
    },
  },
});
console.log(paths.join('\n'));
