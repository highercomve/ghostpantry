import React, { useState, useEffect, useCallback } from 'react';
import { invoke, listen } from './oriel';
import { InventoryItem } from './types';
import { InventoryView } from './components/InventoryView';
import { ScanView } from './components/ScanView';
import { ShoppingListView } from './components/ShoppingListView';
import { SettingsView } from './components/SettingsView';
import './style.css';

type Tab = 'inventory' | 'scan' | 'shopping' | 'settings';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('inventory');
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [lowStockCount, setLowStockCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);

  const fetchItems = useCallback(async () => {
    try {
      const res = await invoke('get_items', { category: null });
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
      console.error('Failed to load items:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchItems();

    // Listen to real-time events emitted from Zig backend
    const unlisten = listen('inventory_updated', () => {
      fetchItems();
    });

    return () => {
      if (typeof unlisten === 'function') unlisten();
    };
  }, [fetchItems]);

  return (
    <div className="app-layout">
      {/* Top Navbar */}
      <header className="app-header">
        <div className="header-brand">
          <span className="brand-logo">👻🥫</span>
          <div className="brand-titles">
            <h1 className="brand-name">GhostPantry</h1>
            <span className="brand-tagline">AI Vision Food & Fridge Manager</span>
          </div>
        </div>

        {/* Tab navigation */}
        <nav className="tab-nav">
          <button
            className={`tab-btn ${activeTab === 'inventory' ? 'active' : ''}`}
            onClick={() => setActiveTab('inventory')}
          >
            <span className="tab-icon">📦</span>
            <span className="tab-text">Inventory</span>
            <span className="tab-counter">{items.length}</span>
          </button>

          <button
            className={`tab-btn ${activeTab === 'scan' ? 'active' : ''}`}
            onClick={() => setActiveTab('scan')}
          >
            <span className="tab-icon">📸</span>
            <span className="tab-text">Scan Photo</span>
          </button>

          <button
            className={`tab-btn ${activeTab === 'shopping' ? 'active' : ''}`}
            onClick={() => setActiveTab('shopping')}
          >
            <span className="tab-icon">🛒</span>
            <span className="tab-text">Restock List</span>
            {lowStockCount > 0 && (
              <span className="badge-notification">{lowStockCount}</span>
            )}
          </button>

          <button
            className={`tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            <span className="tab-icon">⚙️</span>
            <span className="tab-text">Settings</span>
          </button>
        </nav>
      </header>

      {/* Main Content Area */}
      <main className="app-main-content">
        {loading ? (
          <div className="loading-fullscreen">
            <div className="spinner"></div>
            <p>Loading your pantry database...</p>
          </div>
        ) : (
          <>
            {activeTab === 'inventory' && (
              <InventoryView
                items={items}
                onRefresh={fetchItems}
                onNavigateToScan={() => setActiveTab('scan')}
              />
            )}

            {activeTab === 'scan' && (
              <ScanView
                onScanSuccess={() => {
                  fetchItems();
                  setActiveTab('inventory');
                }}
              />
            )}

            {activeTab === 'shopping' && (
              <ShoppingListView onRestock={fetchItems} />
            )}

            {activeTab === 'settings' && (
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
