export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  score?: number;
}
export function drawnRegion(
  start: { x: number; y: number },
  end: { x: number; y: number },
  label: string,
): Region | null {
  if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) return null;
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const x = clamp(Math.min(start.x, end.x));
  const y = clamp(Math.min(start.y, end.y));
  const width = clamp(Math.max(start.x, end.x)) - x;
  const height = clamp(Math.max(start.y, end.y)) - y;
  if (width < 0.02 || height < 0.02) return null;
  return { x, y, width, height, label };
}
export function paddedRegion(region: Region): Region {
  const x = Math.max(0, region.x - region.width * 0.05);
  const y = Math.max(0, region.y - region.height * 0.05);
  return {
    ...region,
    x,
    y,
    width: Math.min(1, region.x + region.width * 1.05) - x,
    height: Math.min(1, region.y + region.height * 1.05) - y,
  };
}
