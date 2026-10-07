import { splitSuggestions, type FoodMatch } from "./foodSuggestions.ts";
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
export function gridRegions(): Region[] {
  const regions: Region[] = [
    { x: 0, y: 0, width: 1, height: 1, label: "Whole photo" },
  ];
  for (let row = 0; row < 3; row++)
    for (let column = 0; column < 3; column++) {
      regions.push({
        x: column * 0.25,
        y: row * 0.25,
        width: 0.5,
        height: 0.5,
        label: `Grid ${row * 3 + column + 1}`,
      });
    }
  return regions;
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
export function mergeRegions(
  results: { matches: FoodMatch[]; background_score?: number }[],
) {
  const foods = new Map<
    string,
    { label: string; score: number; regions: number[] }
  >();
  results.forEach((result, index) => {
    for (const match of splitSuggestions(
      result.matches,
      result.background_score,
    ).stronger) {
      const existing = foods.get(match.label);
      foods.set(match.label, {
        label: match.label,
        score: Math.max(existing?.score ?? -1, match.score),
        regions: [...(existing?.regions ?? []), index],
      });
    }
  });
  return [...foods.values()].sort((a, b) => b.score - a.score);
}
