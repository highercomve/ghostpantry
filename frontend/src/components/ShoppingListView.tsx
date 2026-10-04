import React, { useState, useEffect } from 'react';
import { LowStockItem } from '../types';
import { invoke } from '../oriel';

interface ShoppingListViewProps {
  onRestock: () => void;
}

export const ShoppingListView: React.FC<ShoppingListViewProps> = ({ onRestock }) => {
  const [missingItems, setMissingItems] = useState<LowStockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const fetchAnalysis = async () => {
    setLoading(true);
    try {
      const res = await invoke('get_low_stock_analysis');
      setMissingItems(res as LowStockItem[]);
    } catch (err: any) {
      console.error('Failed to get low stock analysis:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAnalysis();
  }, []);

  const handleRestockItem = async (id: number, desiredQty: number) => {
    try {
      await invoke('update_stock', {
        id,
        quantity: desiredQty,
        fill_percentage: 100,
      });
      fetchAnalysis();
      onRestock();
    } catch (err: any) {
      console.error('Failed to restock item:', err);
    }
  };

  const copyToClipboard = () => {
    if (missingItems.length === 0) return;

    const lines = [
      '🛒 Grocery Shopping List (from GhostPantry):',
      '',
      ...missingItems.map((entry) => {
        const item = entry.item;
        const fill = item.fill_percentage ?? 100;
        const missing = Math.ceil(entry.missing_quantity) || 1;
        const reason = entry.status === 'out_of_stock'
          ? 'OUT OF STOCK'
          : fill <= 25
          ? `critically low (${fill}%)`
          : fill === 50
          ? 'at half usage (50%)'
          : `running low (${fill}%)`;

        return `• [ ] ${item.name} — buy ${missing} ${item.unit || 'unit'}(s) (${reason})`;
      }),
      '',
      `Generated on ${new Date().toLocaleDateString()} with GhostPantry AI`,
    ];

    navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div className="shopping-list-page">
      <div className="view-header">
        <div>
          <h2>Smart Restock & Shopping List</h2>
          <p className="text-muted">
            Automatically analyzed from your current stock and desired targets.
          </p>
        </div>

        <div className="header-actions">
          <button
            className="btn btn-secondary"
            onClick={fetchAnalysis}
            disabled={loading}
          >
            🔄 Refresh Analysis
          </button>
          <button
            className="btn btn-primary"
            onClick={copyToClipboard}
            disabled={missingItems.length === 0}
          >
            {copied ? '✓ Copied to Clipboard!' : '📋 Copy Shopping List'}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="loading-card">
          <div className="spinner"></div>
          <p>Analyzing stock levels against desired targets...</p>
        </div>
      ) : missingItems.length === 0 ? (
        <div className="all-stocked-card">
          <div className="stocked-icon">🎉</div>
          <h3>Everything is well stocked!</h3>
          <p className="text-muted">
            All items in your pantry and fridge meet your desired amounts and usage levels.
          </p>
        </div>
      ) : (
        <div className="shopping-list-grid">
          {missingItems.map((entry, idx) => {
            const item = entry.item;
            const fill = item.fill_percentage ?? 100;
            const desired = item.desired_quantity ?? 1;
            const qty = item.quantity ?? 1;

            return (
              <div key={idx} className={`shopping-item-card status-${entry.status}`}>
                <div className="shopping-card-body">
                  <div className="shopping-item-left">
                    <span className="item-cat-icon">
                      {item.category === 'fridge' ? '❄️' : '🥫'}
                    </span>
                    <div>
                      <h4 className="shopping-item-title">{item.name}</h4>
                      <span className="shopping-item-loc">
                        {item.location} ({item.category})
                      </span>
                    </div>
                  </div>

                  <div className="shopping-status-badge">
                    {entry.status === 'out_of_stock' ? (
                      <span className="badge badge-danger">Out of Stock</span>
                    ) : entry.status === 'low' ? (
                      <span className="badge badge-warning">Low ({fill}%)</span>
                    ) : entry.status === 'half' ? (
                      <span className="badge badge-info">Half Usage ({fill}%)</span>
                    ) : (
                      <span className="badge badge-subtle">Needs Restock</span>
                    )}
                  </div>
                </div>

                <div className="shopping-card-details">
                  <div className="detail-col">
                    <span className="detail-label">Current Count</span>
                    <span className="detail-val">{qty} {item.unit || 'unit'}</span>
                  </div>
                  <div className="detail-col">
                    <span className="detail-label">Fill / Usage</span>
                    <span className="detail-val">{fill}%</span>
                  </div>
                  <div className="detail-col">
                    <span className="detail-label">Desired Target</span>
                    <span className="detail-val">{desired} {item.unit || 'unit'}</span>
                  </div>
                  <div className="detail-col highlight-needed">
                    <span className="detail-label">To Buy</span>
                    <span className="detail-val-highlight">
                      +{Math.ceil(entry.missing_quantity) || 1} {item.unit || 'unit'}
                    </span>
                  </div>
                </div>

                {item.notes && <div className="item-notes">📝 {item.notes}</div>}

                <div className="shopping-card-footer">
                  <button
                    className="btn btn-restock"
                    onClick={() => item.id && handleRestockItem(item.id, desired)}
                  >
                    ✓ Mark as Bought (Restock to {desired})
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
