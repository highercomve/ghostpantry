import type { InventoryItem, VisionDetectedItem } from "./types.ts";

export type InventoryReviewItem = VisionDetectedItem & {
  selected: boolean;
  desired: number;
  similarity?: number;
  adjustment?: number;
  stronger?: boolean;
};

const productKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

export function inventoryItemForCrop(
  items: InventoryItem[],
  label: string,
  category: string,
): InventoryItem {
  const name = label.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Choose a product for this crop first.");
  const existing = items.find((item) => item.category === category && productKey(item.name) === productKey(name));
  if (existing) return { ...existing, quantity: (existing.quantity ?? 0) + 1 };
  return {
    name, category,
    location: category === "fridge" ? "Fridge" : category === "freezer" ? "Freezer" : "Pantry",
    quantity: 1, desired_quantity: 1, fill_percentage: 100, unit: "unit",
    notes: "Added from a confirmed image crop.",
  };
}
