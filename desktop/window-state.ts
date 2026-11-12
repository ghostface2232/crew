export interface Bounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}
export interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}
export function windowBounds(saved: Partial<Bounds>, displays: Area[]): Bounds {
  const width = Number.isFinite(saved.width) ? Math.max(640, Math.min(saved.width!, 3000)) : 1380;
  const height = Number.isFinite(saved.height) ? Math.max(480, Math.min(saved.height!, 2000)) : 900;
  const visible =
    Number.isFinite(saved.x) &&
    Number.isFinite(saved.y) &&
    displays.some(
      (area) =>
        saved.x! + width > area.x + 80 &&
        saved.x! < area.x + area.width - 80 &&
        saved.y! >= area.y &&
        saved.y! < area.y + area.height - 80,
    );
  return { width, height, ...(visible ? { x: saved.x, y: saved.y } : {}), maximized: Boolean(saved.maximized) };
}
export function isBoardNavigation(candidate: string, base: string) {
  try {
    const url = new URL(candidate);
    return url.origin === base && url.pathname === '/' && !url.username && !url.password;
  } catch {
    return false;
  }
}
