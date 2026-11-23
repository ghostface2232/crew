import { execFile } from 'node:child_process';
import path from 'node:path';

/** WM_SETTINGCHANGE, which Windows sends every top-level window when its light or dark mode changes. */
export const SETTING_CHANGE = 0x001a;
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';

/** What `reg query` printed for the Windows mode: dark, light, or undefined where the value is not there to read. */
export function taskbarDarkIn(output: string): boolean | undefined {
  const value = /^\s*SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/im.exec(output)?.[1];
  return value === undefined ? undefined : parseInt(value, 16) === 0;
}

/**
 * Whether the taskbar is dark. It follows the Windows mode, not the app mode, so this reads that mode from the
 * registry. Electron's `nativeTheme.shouldUseDarkColorsForSystemIntegratedUI` is not used for it: before the first
 * theme notification it answers with the app mode, and after one it keeps a value read at that notification, which
 * comes with the app mode's change and can precede the Windows mode's write, so the tray kept the old color until
 * a restart (electron/electron#52308, read in Electron 45.3.3's source on 2026-11-23).
 */
export function taskbarDark(): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    const reg = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
    execFile(reg, ['query', KEY, '/v', 'SystemUsesLightTheme'], { windowsHide: true, timeout: 2000 }, (error, stdout) =>
      resolve(error ? undefined : taskbarDarkIn(stdout)));
  });
}
