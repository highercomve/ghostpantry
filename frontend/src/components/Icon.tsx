import type { CSSProperties } from "react";
import {
  Camera,
  Check,
  ArrowRight,
  Ghost,
  Leaf,
  Plus,
  Refrigerator,
  Search,
  Settings,
  ShoppingCart,
  Upload,
  type LucideIcon,
} from "lucide-react";

export type IconName =
  | "pantry"
  | "camera"
  | "shopping"
  | "settings"
  | "plus"
  | "arrow"
  | "leaf"
  | "upload"
  | "check"
  | "ghost"
  | "search";

const icons: Record<IconName, LucideIcon> = {
  pantry: Refrigerator,
  camera: Camera,
  shopping: ShoppingCart,
  settings: Settings,
  plus: Plus,
  arrow: ArrowRight,
  leaf: Leaf,
  upload: Upload,
  check: Check,
  ghost: Ghost,
  search: Search,
};

export function Icon({
  name,
  size = 20,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  const Glyph = icons[name];
  return (
    <Glyph
      width={size}
      height={size}
      strokeWidth={1.9}
      aria-hidden="true"
      style={style}
    />
  );
}
