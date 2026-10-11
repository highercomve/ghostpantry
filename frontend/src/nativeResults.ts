import type { Commands } from "./oriel.ts";

// invoke() only casts what the native side returns; these guards check the
// scan and match results before their numbers reach the layout and crops.

type Detection = Commands["detect_regions"]["result"];
type Box = Detection["boxes"][number];
type Match = Commands["embedding_region_match"]["result"];

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Unexpected result from the phone's food scanner.");
  return value as Record<string, unknown>;
};
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const finiteOr = (value: unknown, fallback: number) =>
  finite(value) ? value : fallback;
const unit = (value: unknown): value is number =>
  finite(value) && value >= 0 && value <= 1;
const list = (value: unknown): unknown[] => {
  if (!Array.isArray(value))
    throw new Error("Unexpected result from the phone's food scanner.");
  return value;
};

/** Drops boxes outside the photo, empty boxes and non-finite scores. */
export function checkedDetection(value: unknown): Detection {
  const result = record(value);
  const boxes = list(result.boxes).filter((item): item is Box => {
    if (typeof item !== "object" || item === null) return false;
    const box = item as Record<string, unknown>;
    return (
      unit(box.x) &&
      unit(box.y) &&
      unit(box.width) &&
      unit(box.height) &&
      box.width > 0 &&
      box.height > 0 &&
      finite(box.score) &&
      typeof box.label === "string"
    );
  });
  return {
    boxes,
    detector: typeof result.detector === "string" ? result.detector : "",
    load_ms: finiteOr(result.load_ms, 0),
    detect_ms: finiteOr(result.detect_ms, 0),
    total_ms: finiteOr(result.total_ms, 0),
    pss_mb: finiteOr(result.pss_mb, 0),
  };
}

/** Keeps only matches with a label and finite scores; timings default to 0. */
export function checkedMatch(value: unknown): Match {
  const result = record(value);
  const matches = list(result.matches).flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const match = item as Record<string, unknown>;
    if (typeof match.label !== "string" || !finite(match.score)) return [];
    if (match.adjustment !== undefined && !finite(match.adjustment)) return [];
    return [{ label: match.label, score: match.score, adjustment: match.adjustment }];
  });
  return {
    ...(result as Match),
    matches,
    total_ms: finiteOr(result.total_ms, 0),
    load_ms: finiteOr(result.load_ms, 0),
    labels_ms: finiteOr(result.labels_ms, 0),
    image_ms: finiteOr(result.image_ms, 0),
    pss_mb: finiteOr(result.pss_mb, 0),
    background_score: finite(result.background_score)
      ? result.background_score
      : undefined,
  };
}
