import { packager } from '@electron/packager';
const paths = await packager({
  dir: 'desktop/build',
  out: 'release',
  name: 'Crew',
  icon: 'desktop/icon',
  overwrite: true,
  asar: false,
  appBundleId: 'dev.crew.desktop',
  executableName: 'Crew',
  prune: false,
});
console.log(paths.join('\n'));
