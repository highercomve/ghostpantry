import test from "node:test";
import assert from "node:assert/strict";
import { inventoryItemForCrop } from "../src/cropInventory.ts";
import type { InventoryItem } from "../src/types.ts";

test("three directly saved avocado crops share one inventory item with quantity three", () => {
  let items: InventoryItem[] = [];
  for (const label of ["avocado", " Avocado ", "AVOCADO"]) {
    const item = inventoryItemForCrop(items, label, "fridge");
    items = [{ ...item, id: 1 }];
  }
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "avocado");
  assert.equal(items[0].quantity, 3);
  assert.equal(items[0].id, 1);
});

test("adding a crop increments existing stock and preserves fill and preferences", () => {
  const existing: InventoryItem = { id: 7, name: "avocado", category: "fridge", location: "Fridge", quantity: 4, fill_percentage: 75, desired_quantity: 8, unit: "unit", notes: "Keep ripe ones chilled" };
  const item = inventoryItemForCrop([existing], "Avocado", "fridge");
  assert.equal(item.quantity, 5);
  assert.equal(item.fill_percentage, 75);
  assert.equal(item.desired_quantity, 8);
  assert.equal(item.notes, existing.notes);
  assert.equal(existing.quantity, 4);
});

test("same product in a different storage area stays separate", () => {
  const fridge = inventoryItemForCrop([], "avocado", "fridge");
  const pantry = inventoryItemForCrop([fridge], "avocado", "pantry");
  assert.equal(pantry.category, "pantry");
  assert.equal(pantry.location, "Pantry");
  assert.equal(pantry.quantity, 1);
  assert.equal(pantry.id, undefined);
});

test("an empty crop product cannot be saved", () => {
  assert.throws(() => inventoryItemForCrop([], " ", "fridge"), /Choose a product/);
});
