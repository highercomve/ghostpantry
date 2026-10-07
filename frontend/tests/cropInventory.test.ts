import test from "node:test";
import assert from "node:assert/strict";
import { reviewCrop, type InventoryReviewItem } from "../src/cropInventory.ts";

test("three confirmed avocado crops become one product with three units", () => {
  let items: InventoryReviewItem[] = [];
  items = reviewCrop(items, "avocado", "crop-1");
  items = reviewCrop(items, " Avocado ", "crop-2");
  items = reviewCrop(items, "AVOCADO", "crop-3");
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "avocado");
  assert.equal(items[0].quantity, 3);
  assert.equal(items[0].desired, 3);
  assert.deepEqual(items[0].cropIds, ["crop-1", "crop-2", "crop-3"]);
});

test("repeated confirmation of the same crop does not increase quantity", () => {
  const items = reviewCrop([], "avocado", "crop-1");
  const repeated = reviewCrop([{ ...items[0], quantity: 5, selected: false }], "avocado", "crop-1");
  assert.equal(repeated[0].quantity, 5);
  assert.equal(repeated[0].selected, true);
  assert.equal(items[0].quantity, 1);
});

test("relabeling a confirmed crop transfers one unit to its new product", () => {
  const items = reviewCrop(reviewCrop([], "avocado", "crop-1"), "avocado", "crop-2");
  const changed = reviewCrop(items, "apple", "crop-2");
  assert.equal(changed.length, 2);
  assert.equal(changed.find((item) => item.name === "avocado")?.quantity, 1);
  assert.equal(changed.find((item) => item.name === "apple")?.quantity, 1);
  const allChanged = reviewCrop(changed, "apple", "crop-1");
  assert.equal(allChanged.length, 1);
  assert.equal(allChanged[0].quantity, 2);
  assert.equal(items[0].quantity, 2);
});

test("new crops preserve reviewed fill and increment manually edited quantities", () => {
  const items = reviewCrop([], "avocado", "crop-1");
  const edited = [{ ...items[0], quantity: 4, fill_percentage: 75 }];
  const next = reviewCrop(edited, "avocado", "crop-2");
  assert.equal(next[0].quantity, 5);
  assert.equal(next[0].fill_percentage, 75);
  assert.equal(edited[0].quantity, 4);
  assert.deepEqual(reviewCrop(next, " ", "crop-3"), next);
});
