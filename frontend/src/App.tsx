import React, { useState, useEffect, useCallback } from "react";
import { invoke, listen } from "./oriel";
import { InventoryItem } from "./types";
import { InventoryView } from "./components/InventoryView";
import { ScanView } from "./components/ScanView";
import { ShoppingListView } from "./components/ShoppingListView";
import { SettingsView } from "./components/SettingsView";
import "./style.css";
import { Icon, type IconName } from "./components/Icon";

type Tab = "inventory" | "scan" | "shopping" | "settings";

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>("inventory");
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [lowStockCount, setLowStockCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchItems = useCallback(async () => {
    try {
      if (!window.oriel) {
        setLoadError(
          "Open the desktop or Android app to access your saved pantry. Photo selection is available in this browser preview.",
        );
        return;
      }
      setLoadError(null);
      const res = await invoke("get_items", { category: null });
      setItems(res as InventoryItem[]);

      // Calculate low stock / missing items count
      const lowItems = (res as InventoryItem[]).filter((it) => {
        const fill = it.fill_percentage ?? 100;
        const qty = it.quantity ?? 1;
        const desired = it.desired_quantity ?? 1;
        return fill <= 30 || qty < desired;
      });
      setLowStockCount(lowItems.length);
    } catch (err: any) {
      console.error("Failed to load items:", err);
      setLoadError("Your pantry could not be loaded. Try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchItems();

    // Listen to real-time events emitted from Zig backend
    const unlisten = window.oriel
      ? listen("inventory_updated", () => {
          fetchItems();
        })
      : undefined;

    return () => {
      if (typeof unlisten === "function") unlisten();
    };
  }, [fetchItems]);

  return (
    <div className="app-layout">
      <aside className="app-sidebar">
        <a
          className="header-brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab("inventory");
          }}
        >
          <span className="brand-logo">
            <img
              src="/brand/ghostpantry-mark.svg"
              width="40"
              height="40"
              alt=""
            />
          </span>
          <div className="brand-titles">
            <h1 className="brand-name">
              GhostPantry<span>.</span>
            </h1>
            <span className="brand-tagline">A little less waste.</span>
          </div>
        </a>
        <span className="nav-label">YOUR KITCHEN</span>
        <nav className="tab-nav" aria-label="Main navigation">
          {(
            [
              ["inventory", "pantry", "My pantry"],
              ["scan", "camera", "Scan a shelf"],
              ["shopping", "shopping", "Shopping list"],
              ["settings", "settings", "Settings"],
            ] as [Tab, IconName, string][]
          ).map(([tab, icon, label]) => (
            <button
              key={tab}
              type="button"
              className={`tab-btn ${activeTab === tab ? "active" : ""}`}
              aria-current={activeTab === tab ? "page" : undefined}
              onClick={() => setActiveTab(tab)}
            >
              <Icon name={icon} />
              <span className="tab-text">{label}</span>
              {tab === "inventory" && (
                <span className="tab-counter">{items.length}</span>
              )}
              {tab === "shopping" && lowStockCount > 0 && (
                <span className="badge-notification">{lowStockCount}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <Icon name="leaf" size={26} />
          <p>
            Good food.
            <br />
            Less forgotten.
          </p>
          <span>A small habit for a happier kitchen.</span>
        </div>
        <div className="sidebar-footer">
          <span className="status-dot" /> Your pantry, on your device
        </div>
      </aside>
      {/* Main Content Area */}
      <main className="app-main-content">
        <div className="workspace-topline">
          <span>
            HOME /{" "}
            {activeTab === "inventory"
              ? "MY PANTRY"
              : activeTab === "scan"
                ? "SCAN A SHELF"
                : activeTab === "shopping"
                  ? "SHOPPING LIST"
                  : "SETTINGS"}
          </span>
          <span className="local-label">
            <span className="status-dot" /> Local inventory
          </span>
        </div>
        {loadError && (
          <div className="alert alert-info" role="status">
            {loadError}
            {window.oriel && (
              <button className="btn btn-sm" onClick={fetchItems}>
                Try again
              </button>
            )}
          </div>
        )}
        {loading ? (
          <div className="loading-fullscreen">
            <div className="spinner"></div>
            <p>Loading your pantry database...</p>
          </div>
        ) : (
          <>
            {activeTab === "inventory" && (
              <InventoryView
                items={items}
                onRefresh={fetchItems}
                onNavigateToScan={() => setActiveTab("scan")}
              />
            )}

            {activeTab === "scan" && (
              <ScanView
                onScanSuccess={() => {
                  fetchItems();
                  setActiveTab("inventory");
                }}
              />
            )}

            {activeTab === "shopping" && (
              <ShoppingListView onRestock={fetchItems} />
            )}

            {activeTab === "settings" && (
              <SettingsView
                onSettingsSaved={fetchItems}
                onResetData={fetchItems}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
};

export default App;
