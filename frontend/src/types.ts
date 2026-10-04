export interface InventoryItem {
  id?: number;
  name: string;
  category: string; // 'fridge' | 'pantry' | 'freezer' | 'other'
  location: string;
  quantity?: number;
  fill_percentage?: number; // 0 - 100
  unit?: string;
  desired_quantity?: number;
  notes?: string;
  last_scanned_at?: string;
  updated_at?: string;
}

export interface LowStockItem {
  item: InventoryItem;
  missing_quantity: number;
  status: string; // 'out_of_stock' | 'low' | 'half' | 'missing'
}

export interface VisionDetectedItem {
  name: string;
  category?: string;
  quantity?: number;
  fill_percentage?: number;
  unit?: string;
  notes?: string;
}

export interface VisionResult {
  items: VisionDetectedItem[];
  summary: string;
}

export interface AppSettings {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  defaultLocation?: string;
}

export interface ScanLog {
  id?: number;
  location: string;
  items_detected_count?: number;
  summary: string;
  created_at: string;
}
