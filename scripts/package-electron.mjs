import { packager } from '@electron/packager';

const paths = await packager({
  dir: 'desktop/build',
  out: 'release',
  name: 'Crew',
  icon: 'desktop/build/desktop/icon.ico',
  overwrite: true,
  asar: false,
  appBundleId: 'dev.crew.desktop',
  executableName: 'Crew',
  prune: false,
  win32metadata: { CompanyName: 'Crew', FileDescription: 'Crew', ProductName: 'Crew', InternalName: 'Crew' },
});
console.log(paths.join('\n'));
