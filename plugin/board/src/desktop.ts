import { useEffect, useState } from 'react';
import type { AppUpdate, DesktopBridge } from './types.ts';

/** The desktop app's bridge (desktop/preload.cts); absent when the board runs in a browser. */
export const desktop = (window as Window & { crewDesktop?: DesktopBridge }).crewDesktop;

/** Follows the app's updater; null in a browser, or until the app answers. */
export function useAppUpdate(): AppUpdate | null {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  useEffect(() => {
    if (!desktop) return;
    let live = true;
    const unsubscribe = desktop.update.subscribe(setUpdate);
    // A change pushed before the first answer is newer than it.
    void desktop.update.state().then((state) => live && setUpdate((current) => current ?? state), () => {});
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return update;
}
