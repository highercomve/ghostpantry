import React, { useState } from "react";
import { InventoryItem } from "../types";
import { invoke } from "../oriel";
import { Icon } from "./Icon";

interface InventoryViewProps {
  items: InventoryItem[];
  onRefresh: () => void;
  onNavigateToScan: () => void;
}

export const InventoryView: React.FC<InventoryViewProps> = ({
  items,
  onRefresh,
  onNavigateToScan,
}) => {
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);

  // New item form state
  const [newItem, setNewItem] = useState<InventoryItem>({
    name: "",
    category: "pantry",
    location: "Pantry Shelf",
    quantity: 1,
    fill_percentage: 100,
    unit: "package",
    desired_quantity: 1,
    notes: "",
  });

  const filteredItems = items.filter((it) => {
    const matchesCat =
      filterCategory === "all" ||
      it.category.toLowerCase() === filterCategory.toLowerCase();
    const matchesSearch =
      it.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      it.location.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (it.notes && it.notes.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchesCat && matchesSearch;
  });

  const handleUpdateStock = async (
    id: number,
    deltaQty: number,
    deltaFill: number,
  ) => {
    const item = items.find((i) => i.id === id);
    if (!item) return;

    const newQty = Math.max(0, (item.quantity ?? 1) + deltaQty);
    const newFill = Math.max(
      0,
      Math.min(100, (item.fill_percentage ?? 100) + deltaFill),
    );

    try {
      await invoke("update_stock", {
        id,
        quantity: newQty,
        fill_percentage: newFill,
      });
      onRefresh();
    } catch (err: any) {
      console.error("Failed to update stock:", err);
    }
  };

  const handleDeleteItem = async (id: number, name: string) => {
    if (!confirm(`Are you sure you want to remove "${name}" from inventory?`))
      return;
    try {
      await invoke("delete_item", { id });
      onRefresh();
    } catch (err: any) {
      console.error("Failed to delete item:", err);
    }
  };

  const handleSaveItemModal = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = editingItem || newItem;
    if (!target.name.trim()) {
      alert("Please enter an item name.");
      return;
    }

    try {
      await invoke("save_item", { item: target as any });
      setIsAddModalOpen(false);
      setEditingItem(null);
      setNewItem({
        name: "",
        category: "pantry",
        location: "Pantry Shelf",
        quantity: 1,
        fill_percentage: 100,
        unit: "package",
        desired_quantity: 1,
        notes: "",
      });
      onRefresh();
    } catch (err: any) {
      console.error("Failed to save item:", err);
      alert("Error saving item: " + (err?.message || err));
    }
  };

  const stats = {
    total: items.length,
    fridge: items.filter((i) => i.category.toLowerCase() === "fridge").length,
    pantry: items.filter((i) => i.category.toLowerCase() === "pantry").length,
    low: items.filter(
      (i) =>
        (i.fill_percentage ?? 100) <= 30 ||
        (i.quantity ?? 1) < (i.desired_quantity ?? 1),
    ).length,
  };

  return (
    <div className="inventory-view-page">
      <div className="view-header pantry-heading">
        <div>
          <span className="eyebrow">
            KNOW WHAT YOU HAVE. USE WHAT YOU LOVE.
          </span>
          <h2>
            A fresh look at your kitchen<span>.</span>
          </h2>
          <p className="text-muted">
            Everything on your shelves, with a little more clarity.
          </p>
        </div>
      </div>
      <div className="pantry-banner">
        <div>
          <span className="eyebrow">YOUR NEXT SMALL HABIT</span>
          <h3>A shelf photo goes a long way.</h3>
          <p>Keep your pantry up to date in just a few taps.</p>
          <button className="btn banner-button" onClick={onNavigateToScan}>
            Scan your shelf <Icon name="arrow" size={18} />
          </button>
        </div>
        <div className="banner-art" aria-hidden="true">
          <span className="art-leaf" />
          <span className="art-jar">
            <i />
            <b>
              GOOD
              <br />
              THINGS
            </b>
          </span>
          <span className="art-bottle" />
          <span className="art-shelf" />
        </div>
      </div>
      {/* Metric summary badges */}
      <div className="stats-row">
        <button
          type="button"
          className="stat-card"
          onClick={() => setFilterCategory("all")}
        >
          <div className="stat-value">{stats.total}</div>
          <div className="stat-label">On your shelves</div>
        </button>
        <button
          type="button"
          className="stat-card"
          onClick={() => setFilterCategory("fridge")}
        >
          <div className="stat-value">{stats.fridge}</div>
          <div className="stat-label">In the fridge</div>
        </button>
        <button
          type="button"
          className="stat-card"
          onClick={() => setFilterCategory("pantry")}
        >
          <div className="stat-value">{stats.pantry}</div>
          <div className="stat-label">In the pantry</div>
        </button>
        <button
          type="button"
          className="stat-card warning"
          onClick={() => setFilterCategory("all")}
        >
          <div className="stat-value text-amber">{stats.low}</div>
          <div className="stat-label">Running low</div>
        </button>
      </div>

      <div className="section-heading">
        <h3>Your inventory</h3>
        <span>
          {filteredItems.length} {filteredItems.length === 1 ? "item" : "items"}
        </span>
      </div>
      {/* Toolbar */}
      <div className="inventory-toolbar">
        <div className="search-box">
          <span className="search-icon">
            <Icon name="search" size={18} />
          </span>
          <input
            type="text"
            aria-label="Search inventory"
            placeholder="Find something on your shelves…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="clear-search" onClick={() => setSearchQuery("")}>
              ✕
            </button>
          )}
        </div>

        <div className="category-filters">
          <button
            className={`pill-btn ${filterCategory === "all" ? "active" : ""}`}
            onClick={() => setFilterCategory("all")}
          >
            All Items
          </button>
          <button
            className={`pill-btn ${filterCategory === "fridge" ? "active" : ""}`}
            onClick={() => setFilterCategory("fridge")}
          >
            Fridge
          </button>
          <button
            className={`pill-btn ${filterCategory === "pantry" ? "active" : ""}`}
            onClick={() => setFilterCategory("pantry")}
          >
            Pantry
          </button>
          <button
            className={`pill-btn ${filterCategory === "freezer" ? "active" : ""}`}
            onClick={() => setFilterCategory("freezer")}
          >
            Freezer
          </button>
        </div>

        <div className="toolbar-actions">
          <button
            className="btn btn-secondary"
            onClick={() => setIsAddModalOpen(true)}
          >
            Add item
          </button>
          <button className="btn btn-primary" onClick={onNavigateToScan}>
            Scan shelf
          </button>
        </div>
      </div>

      {/* Items Grid */}
      {filteredItems.length === 0 ? (
        <div className="empty-state-card">
          <div className="empty-icon">
            <Icon name="pantry" size={34} />
          </div>
          <h3>
            {searchQuery || filterCategory !== "all"
              ? "Nothing on this shelf yet"
              : "Make yourself at home"}
          </h3>
          <p className="text-muted">
            {searchQuery
              ? `No items matched "${searchQuery}"`
              : filterCategory !== "all"
                ? "Try another shelf or add your first item here."
                : "Start with a shelf photo, or add a few kitchen staples by hand."}
          </p>
          <div className="empty-actions">
            <button className="btn btn-primary" onClick={onNavigateToScan}>
              Scan your first shelf
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => setIsAddModalOpen(true)}
            >
              Add an item
            </button>
          </div>
        </div>
      ) : (
        <div className="items-grid">
          {filteredItems.map((item) => {
            const fill = item.fill_percentage ?? 100;
            const desired = item.desired_quantity ?? 1;
            const qty = item.quantity ?? 1;
            const isLow = fill <= 30 || qty < desired;

            return (
              <div
                key={item.id}
                className={`item-card ${isLow ? "card-warning" : ""}`}
              >
                <div className="item-card-top">
                  <div className="item-title-group">
                    <span className="item-cat-icon">
                      {item.category === "fridge"
                        ? "❄️"
                        : item.category === "freezer"
                          ? "🧊"
                          : "🥫"}
                    </span>
                    <div>
                      <h4 className="item-name">{item.name}</h4>
                      <span className="item-location">{item.location}</span>
                    </div>
                  </div>

                  <div className="item-actions-dropdown">
                    <button
                      className="btn-icon-subtle"
                      onClick={() => setEditingItem(item)}
                      title="Edit item"
                    >
                      ✏️
                    </button>
                    <button
                      className="btn-icon-subtle"
                      onClick={() =>
                        item.id && handleDeleteItem(item.id, item.name)
                      }
                      title="Delete item"
                    >
                      🗑️
                    </button>
                  </div>
                </div>

                {/* Fill Level Meter */}
                <div className="fill-meter-section">
                  <div className="fill-meter-labels">
                    <span className="meter-label">Remaining:</span>
                    <span
                      className={`meter-percent ${getFillColorClass(fill)}`}
                    >
                      {fill}%{" "}
                      {fill === 50
                        ? "(Half Usage)"
                        : fill <= 25
                          ? "(Critically Low)"
                          : fill === 100
                            ? "(Full)"
                            : ""}
                    </span>
                  </div>
                  <div className="progress-track">
                    <div
                      className={`progress-fill ${getFillProgressClass(fill)}`}
                      style={{ width: `${Math.max(4, fill)}%` }}
                    />
                  </div>
                </div>

                {/* Quantity and Desired Target */}
                <div className="item-stats-details">
                  <div className="stock-info">
                    <span className="stock-main">
                      <strong>{qty}</strong> {item.unit || "unit"}
                    </span>
                    <span className="stock-desired">
                      Target: <strong>{desired}</strong>
                    </span>
                  </div>

                  {/* Quick adjuster buttons */}
                  <div className="quick-adjust-group">
                    <button
                      className="btn-adjust"
                      onClick={() =>
                        item.id && handleUpdateStock(item.id, -1, 0)
                      }
                      title="Minus 1 unit"
                      disabled={qty <= 0}
                    >
                      -1
                    </button>
                    <button
                      className="btn-adjust"
                      onClick={() =>
                        item.id && handleUpdateStock(item.id, 1, 0)
                      }
                      title="Plus 1 unit"
                    >
                      +1
                    </button>
                    <button
                      className="btn-adjust"
                      onClick={() =>
                        item.id && handleUpdateStock(item.id, 0, -25)
                      }
                      title="Usage: -25%"
                      disabled={fill <= 0}
                    >
                      -25%
                    </button>
                    <button
                      className="btn-adjust"
                      onClick={() =>
                        item.id && handleUpdateStock(item.id, 0, 25)
                      }
                      title="Restock: +25%"
                      disabled={fill >= 100}
                    >
                      +25%
                    </button>
                  </div>
                </div>

                {item.notes && (
                  <div className="item-notes">📝 {item.notes}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add / Edit Modal */}
      {(isAddModalOpen || editingItem) && (
        <div
          className="modal-backdrop"
          onClick={() => {
            setIsAddModalOpen(false);
            setEditingItem(null);
          }}
        >
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                {editingItem ? "Edit Food Item" : "Add New Item to Inventory"}
              </h3>
              <button
                className="btn-close"
                onClick={() => {
                  setIsAddModalOpen(false);
                  setEditingItem(null);
                }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveItemModal}>
              <div className="form-group">
                <label>Item Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Harina Pan, Whole Milk, Eggs"
                  value={editingItem ? editingItem.name : newItem.name}
                  onChange={(e) => {
                    if (editingItem)
                      setEditingItem({ ...editingItem, name: e.target.value });
                    else setNewItem({ ...newItem, name: e.target.value });
                  }}
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Category</label>
                  <select
                    value={
                      editingItem ? editingItem.category : newItem.category
                    }
                    onChange={(e) => {
                      if (editingItem)
                        setEditingItem({
                          ...editingItem,
                          category: e.target.value,
                        });
                      else setNewItem({ ...newItem, category: e.target.value });
                    }}
                  >
                    <option value="pantry">🥫 Food Pantry</option>
                    <option value="fridge">❄️ Refrigerator</option>
                    <option value="freezer">Freezer</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Storage Location</label>
                  <input
                    type="text"
                    placeholder="e.g. Top Shelf, Door, Drawer 2"
                    value={
                      editingItem ? editingItem.location : newItem.location
                    }
                    onChange={(e) => {
                      if (editingItem)
                        setEditingItem({
                          ...editingItem,
                          location: e.target.value,
                        });
                      else setNewItem({ ...newItem, location: e.target.value });
                    }}
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Current Quantity</label>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    value={
                      editingItem
                        ? (editingItem.quantity ?? 1)
                        : (newItem.quantity ?? 1)
                    }
                    onChange={(e) => {
                      const val = parseFloat(e.target.value) || 0;
                      if (editingItem)
                        setEditingItem({ ...editingItem, quantity: val });
                      else setNewItem({ ...newItem, quantity: val });
                    }}
                  />
                </div>

                <div className="form-group">
                  <label>Unit</label>
                  <input
                    type="text"
                    placeholder="package, carton, bottle, kg"
                    value={
                      editingItem
                        ? (editingItem.unit ?? "unit")
                        : (newItem.unit ?? "unit")
                    }
                    onChange={(e) => {
                      if (editingItem)
                        setEditingItem({
                          ...editingItem,
                          unit: e.target.value,
                        });
                      else setNewItem({ ...newItem, unit: e.target.value });
                    }}
                  />
                </div>

                <div className="form-group">
                  <label>Target Desired Amount</label>
                  <input
                    type="number"
                    step="1"
                    min="1"
                    value={
                      editingItem
                        ? (editingItem.desired_quantity ?? 1)
                        : (newItem.desired_quantity ?? 1)
                    }
                    onChange={(e) => {
                      const val = parseFloat(e.target.value) || 1;
                      if (editingItem)
                        setEditingItem({
                          ...editingItem,
                          desired_quantity: val,
                        });
                      else setNewItem({ ...newItem, desired_quantity: val });
                    }}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>
                  Remaining Usage / Fill:{" "}
                  <strong>
                    {editingItem
                      ? (editingItem.fill_percentage ?? 100)
                      : (newItem.fill_percentage ?? 100)}
                    %
                  </strong>
                </label>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  value={
                    editingItem
                      ? (editingItem.fill_percentage ?? 100)
                      : (newItem.fill_percentage ?? 100)
                  }
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (editingItem)
                      setEditingItem({ ...editingItem, fill_percentage: val });
                    else setNewItem({ ...newItem, fill_percentage: val });
                  }}
                />
              </div>

              <div className="form-group">
                <label>Notes</label>
                <input
                  type="text"
                  placeholder="e.g. half opened, use before Friday"
                  value={
                    editingItem
                      ? (editingItem.notes ?? "")
                      : (newItem.notes ?? "")
                  }
                  onChange={(e) => {
                    if (editingItem)
                      setEditingItem({ ...editingItem, notes: e.target.value });
                    else setNewItem({ ...newItem, notes: e.target.value });
                  }}
                />
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setIsAddModalOpen(false);
                    setEditingItem(null);
                  }}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  {editingItem ? "Save Changes" : "Add to Inventory"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

function getFillColorClass(pct: number): string {
  if (pct <= 25) return "text-red";
  if (pct <= 55) return "text-amber";
  if (pct <= 80) return "text-blue";
  return "text-green";
}

function getFillProgressClass(pct: number): string {
  if (pct <= 25) return "fill-danger";
  if (pct <= 55) return "fill-warning";
  if (pct <= 80) return "fill-info";
  return "fill-success";
}
