import test from "node:test";
import assert from "node:assert/strict";
import {
  paddedRegion,
  drawnRegion,
} from "../src/foodRegions.ts";

test("drawn packages support reverse dragging and clip to the photo", () => {
  assert.deepEqual(
    drawnRegion({ x: 0.8, y: 1.2 }, { x: -0.1, y: 0.3 }, "Package 1"),
    {
      x: 0,
      y: 0.3,
      width: 0.8,
      height: 0.7,
      label: "Package 1",
    },
  );
  assert.equal(
    drawnRegion({ x: 0.1, y: 0.1 }, { x: 0.11, y: 0.8 }, "tap"),
    null,
  );
  assert.equal(drawnRegion({ x: NaN, y: 0 }, { x: 1, y: 1 }, "invalid"), null);
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

