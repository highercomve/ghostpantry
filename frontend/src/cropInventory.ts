import type { VisionDetectedItem } from "./types.ts";

export type InventoryReviewItem = VisionDetectedItem & {
  selected: boolean;
  desired: number;
  similarity?: number;
  adjustment?: number;
  stronger?: boolean;
  cropIds?: string[];
};

const productKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

// Only explicit crop confirmations contribute a unit. Repeated clicks do not.
export function reviewCrop(
  items: InventoryReviewItem[],
  label: string,
  cropId: string,
): InventoryReviewItem[] {
  const name = label.trim().replace(/\s+/g, " ");
  if (!name) return items;
  const key = productKey(name);
  const source = items.find((item) => item.cropIds?.includes(cropId));
  if (source && productKey(source.name) === key)
    return items.map((item) => item === source ? { ...item, selected: true } : item);

  // Changing a reviewed crop's label moves its unit to the new product.
  const remaining = items.flatMap((item) => {
    if (item !== source) return [item];
    const cropIds = (item.cropIds ?? []).filter((id) => id !== cropId);
    const quantity = Math.max(0, (item.quantity ?? 1) - 1);
    return cropIds.length === 0 && quantity === 0 ? [] : [{ ...item, cropIds, quantity }];
  });
  const existing = remaining.findIndex((item) => productKey(item.name) === key);
  if (existing >= 0)
    return remaining.map((item, index) => index === existing ? {
      ...item,
      selected: true,
      quantity: (item.quantity ?? 1) + 1,
      desired: Math.max(item.desired, (item.quantity ?? 1) + 1),
      cropIds: [...(item.cropIds ?? []), cropId],
    } : item);
  return [...remaining, {
    name, selected: true, desired: 1, quantity: 1, fill_percentage: 100,
    unit: "unit", cropIds: [cropId],
    notes: "Quantity from individually confirmed image crops; reviewed before saving.",
  }];
}
