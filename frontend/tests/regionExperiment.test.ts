import test from "node:test";
import assert from "node:assert/strict";
import {
  gridRegions,
  paddedRegion,
  mergeRegions,
} from "../src/regionExperiment.ts";

test("grid covers the complete photo and overlaps adjacent crops", () => {
  const regions = gridRegions();
  assert.equal(regions.length, 10);
  assert.deepEqual(regions[0], {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    label: "Whole photo",
  });
  for (const region of regions) {
    assert.ok(region.x >= 0 && region.y >= 0);
    assert.ok(region.x + region.width <= 1 && region.y + region.height <= 1);
  }
  assert.ok(regions[1].x + regions[1].width > regions[2].x);
  assert.equal(regions[9].x + regions[9].width, 1);
  assert.equal(regions[9].y + regions[9].height, 1);
});

test("detector padding preserves labels and clips photo edges", () => {
  const region = paddedRegion({
    x: 0,
    y: 0.9,
    width: 0.2,
    height: 0.1,
    label: "package",
    score: 0.7,
  });
  assert.equal(region.x, 0);
  assert.ok(Math.abs(region.width - 0.21) < 1e-9);
  assert.equal(region.y + region.height, 1);
  assert.equal(region.label, "package");
  assert.equal(region.score, 0.7);
});

test("regions merge repeated food labels without treating overlaps as quantity", () => {
  const results = mergeRegions([
    {
      matches: [
        { label: "eggs", score: 0.75 },
        { label: "milk", score: 0.65 },
      ],
      background_score: 0.68,
    },
    { matches: [{ label: "eggs", score: 0.8 }], background_score: 0.7 },
    { matches: [{ label: "pasta", score: 0.78 }], background_score: 0.6 },
    { matches: [{ label: "rice", score: 0.6 }], background_score: 0.7 },
  ]);
  assert.deepEqual(results, [
    { label: "eggs", score: 0.8, regions: [0, 1] },
    { label: "pasta", score: 0.78, regions: [2] },
  ]);
  assert.deepEqual(mergeRegions([]), []);
});
