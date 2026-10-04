const std = @import("std");
const oriel = @import("oriel");

pub const Item = struct {
    id: i64 = 0,
    name: []const u8,
    category: []const u8, // 'fridge', 'pantry', 'freezer', 'other'
    location: []const u8, // e.g. "Pantry Shelf 1", "Fridge Top Shelf"
    quantity: f64 = 1.0,
    fill_percentage: f64 = 100.0, // 0 - 100 (e.g. 50.0 for half usage)
    unit: []const u8 = "unit",
    desired_quantity: f64 = 1.0,
    notes: []const u8 = "",
    last_scanned_at: []const u8 = "",
    updated_at: []const u8 = "",
};

pub const LowStockItem = struct {
    item: Item,
    missing_quantity: f64,
    status: []const u8, // 'out_of_stock', 'low', 'half', 'adequate'
};

pub const ScanLog = struct {
    id: i64 = 0,
    location: []const u8,
    items_detected_count: i64 = 0,
    summary: []const u8,
    created_at: []const u8,
};

pub const Db = struct {
    db: oriel.sql.Db,

    pub fn init(path: [:0]const u8) !Db {
        const db = try oriel.sql.Db.open(path);
        const self = Db{ .db = db };
        try self.initSchema();
        return self;
    }

    pub fn close(self: *Db) void {
        self.db.close();
    }

    fn initSchema(self: Db) !void {
        try self.db.exec(
            \\CREATE TABLE IF NOT EXISTS inventory_items (
            \\    id INTEGER PRIMARY KEY AUTOINCREMENT,
            \\    name TEXT NOT NULL,
            \\    category TEXT NOT NULL DEFAULT 'pantry',
            \\    location TEXT NOT NULL DEFAULT 'Pantry',
            \\    quantity REAL NOT NULL DEFAULT 1.0,
            \\    fill_percentage REAL NOT NULL DEFAULT 100.0,
            \\    unit TEXT NOT NULL DEFAULT 'unit',
            \\    desired_quantity REAL NOT NULL DEFAULT 1.0,
            \\    notes TEXT DEFAULT '',
            \\    last_scanned_at TEXT DEFAULT (datetime('now', 'localtime')),
            \\    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
            \\);
            \\CREATE TABLE IF NOT EXISTS scan_logs (
            \\    id INTEGER PRIMARY KEY AUTOINCREMENT,
            \\    location TEXT NOT NULL,
            \\    items_detected_count INTEGER NOT NULL DEFAULT 0,
            \\    summary TEXT NOT NULL DEFAULT '',
            \\    created_at TEXT DEFAULT (datetime('now', 'localtime'))
            \\);
            \\CREATE TABLE IF NOT EXISTS app_settings (
            \\    key TEXT PRIMARY KEY,
            \\    value TEXT NOT NULL
            \\);
        );
    }

    pub fn listItems(self: Db, arena: std.mem.Allocator, category_filter: ?[]const u8) ![]Item {
        const query = if (category_filter != null and category_filter.?.len > 0)
            "SELECT id, name, category, location, quantity, fill_percentage, unit, desired_quantity, notes, last_scanned_at, updated_at FROM inventory_items WHERE category = ?1 ORDER BY category ASC, name ASC"
        else
            "SELECT id, name, category, location, quantity, fill_percentage, unit, desired_quantity, notes, last_scanned_at, updated_at FROM inventory_items ORDER BY category ASC, name ASC";

        const stmt = try self.db.prepare(query);
        defer stmt.finalize();

        if (category_filter) |cat| {
            if (cat.len > 0) {
                try stmt.bindText(1, cat);
            }
        }

        var list: std.ArrayList(Item) = .empty;
        while (try stmt.step()) {
            const item = Item{
                .id = stmt.int(0),
                .name = try stmt.text(arena, 1),
                .category = try stmt.text(arena, 2),
                .location = try stmt.text(arena, 3),
                .quantity = stmt.float(4),
                .fill_percentage = stmt.float(5),
                .unit = try stmt.text(arena, 6),
                .desired_quantity = stmt.float(7),
                .notes = try stmt.text(arena, 8),
                .last_scanned_at = try stmt.text(arena, 9),
                .updated_at = try stmt.text(arena, 10),
            };
            try list.append(arena, item);
        }
        return list.items;
    }

    pub fn upsertItem(self: Db, item: Item) !i64 {
        if (item.id > 0) {
            const sql = "UPDATE inventory_items SET name = ?1, category = ?2, location = ?3, quantity = ?4, fill_percentage = ?5, unit = ?6, desired_quantity = ?7, notes = ?8, updated_at = datetime('now', 'localtime') WHERE id = ?9";
            const stmt = try self.db.prepare(sql);
            defer stmt.finalize();

            try stmt.bindText(1, item.name);
            try stmt.bindText(2, item.category);
            try stmt.bindText(3, item.location);
            _ = oriel.sql.c.sqlite3_bind_double(stmt.handle, 4, item.quantity);
            _ = oriel.sql.c.sqlite3_bind_double(stmt.handle, 5, item.fill_percentage);
            try stmt.bindText(6, item.unit);
            _ = oriel.sql.c.sqlite3_bind_double(stmt.handle, 7, item.desired_quantity);
            try stmt.bindText(8, item.notes);
            try stmt.bindInt(9, item.id);

            _ = try stmt.step();
            return item.id;
        } else {
            // Check if item with same name and category already exists
            const check_sql = "SELECT id, desired_quantity FROM inventory_items WHERE LOWER(name) = LOWER(?1) AND category = ?2 LIMIT 1";
            const check_stmt = try self.db.prepare(check_sql);
            defer check_stmt.finalize();
            try check_stmt.bindText(1, item.name);
            try check_stmt.bindText(2, item.category);

            if (try check_stmt.step()) {
                const existing_id = check_stmt.int(0);
                const update_sql = "UPDATE inventory_items SET quantity = ?1, fill_percentage = ?2, unit = ?3, notes = ?4, last_scanned_at = datetime('now', 'localtime'), updated_at = datetime('now', 'localtime') WHERE id = ?5";
                const upd = try self.db.prepare(update_sql);
                defer upd.finalize();
                _ = oriel.sql.c.sqlite3_bind_double(upd.handle, 1, item.quantity);
                _ = oriel.sql.c.sqlite3_bind_double(upd.handle, 2, item.fill_percentage);
                try upd.bindText(3, item.unit);
                try upd.bindText(4, item.notes);
                try upd.bindInt(5, existing_id);
                _ = try upd.step();
                return existing_id;
            }

            const insert_sql = "INSERT INTO inventory_items (name, category, location, quantity, fill_percentage, unit, desired_quantity, notes, last_scanned_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now', 'localtime'), datetime('now', 'localtime'))";
            const stmt = try self.db.prepare(insert_sql);
            defer stmt.finalize();

            try stmt.bindText(1, item.name);
            try stmt.bindText(2, item.category);
            try stmt.bindText(3, item.location);
            _ = oriel.sql.c.sqlite3_bind_double(stmt.handle, 4, item.quantity);
            _ = oriel.sql.c.sqlite3_bind_double(stmt.handle, 5, item.fill_percentage);
            try stmt.bindText(6, item.unit);
            _ = oriel.sql.c.sqlite3_bind_double(stmt.handle, 7, item.desired_quantity);
            try stmt.bindText(8, item.notes);

            _ = try stmt.step();
            return self.db.lastInsertRowId();
        }
    }

    pub fn deleteItem(self: Db, id: i64) !void {
        const stmt = try self.db.prepare("DELETE FROM inventory_items WHERE id = ?1");
        defer stmt.finalize();
        try stmt.bindInt(1, id);
        _ = try stmt.step();
    }

    pub fn updateStock(self: Db, id: i64, quantity: f64, fill_percentage: f64) !void {
        const stmt = try self.db.prepare("UPDATE inventory_items SET quantity = ?1, fill_percentage = ?2, updated_at = datetime('now', 'localtime') WHERE id = ?3");
        defer stmt.finalize();
        _ = oriel.sql.c.sqlite3_bind_double(stmt.handle, 1, quantity);
        _ = oriel.sql.c.sqlite3_bind_double(stmt.handle, 2, fill_percentage);
        try stmt.bindInt(3, id);
        _ = try stmt.step();
    }

    pub fn updateDesired(self: Db, id: i64, desired_quantity: f64) !void {
        const stmt = try self.db.prepare("UPDATE inventory_items SET desired_quantity = ?1, updated_at = datetime('now', 'localtime') WHERE id = ?2");
        defer stmt.finalize();
        _ = oriel.sql.c.sqlite3_bind_double(stmt.handle, 1, desired_quantity);
        try stmt.bindInt(2, id);
        _ = try stmt.step();
    }

    pub fn getLowStockAnalysis(self: Db, arena: std.mem.Allocator) ![]LowStockItem {
        const items = try self.listItems(arena, null);
        var result: std.ArrayList(LowStockItem) = .empty;

        for (items) |it| {
            // Effective quantity incorporates fill percentage: e.g. 1 box at 50% = 0.5 effective units
            const effective = it.quantity * (@max(0.0, @min(100.0, it.fill_percentage)) / 100.0);
            const is_missing = effective < it.desired_quantity or it.fill_percentage <= 25.0;

            if (is_missing) {
                const missing = @max(0.0, it.desired_quantity - effective);
                const status = if (it.quantity <= 0.0 or it.fill_percentage <= 5.0)
                    "out_of_stock"
                else if (it.fill_percentage <= 30.0 or effective <= 0.5 * it.desired_quantity)
                    "low"
                else if (it.fill_percentage <= 55.0)
                    "half"
                else
                    "missing";

                try result.append(arena, .{
                    .item = it,
                    .missing_quantity = missing,
                    .status = status,
                });
            }
        }
        return result.items;
    }

    pub fn recordScan(self: Db, location: []const u8, count: i64, summary: []const u8) !void {
        const stmt = try self.db.prepare("INSERT INTO scan_logs (location, items_detected_count, summary) VALUES (?1, ?2, ?3)");
        defer stmt.finalize();
        try stmt.bindText(1, location);
        try stmt.bindInt(2, count);
        try stmt.bindText(3, summary);
        _ = try stmt.step();
    }

    pub fn getScanLogs(self: Db, arena: std.mem.Allocator, limit: i64) ![]ScanLog {
        const stmt = try self.db.prepare("SELECT id, location, items_detected_count, summary, created_at FROM scan_logs ORDER BY id DESC LIMIT ?1");
        defer stmt.finalize();
        try stmt.bindInt(1, limit);

        var list: std.ArrayList(ScanLog) = .empty;
        while (try stmt.step()) {
            try list.append(arena, .{
                .id = stmt.int(0),
                .location = try stmt.text(arena, 1),
                .items_detected_count = stmt.int(2),
                .summary = try stmt.text(arena, 3),
                .created_at = try stmt.text(arena, 4),
            });
        }
        return list.items;
    }

    pub fn getSetting(self: Db, arena: std.mem.Allocator, key: []const u8) !?[]const u8 {
        const stmt = try self.db.prepare("SELECT value FROM app_settings WHERE key = ?1 LIMIT 1");
        defer stmt.finalize();
        try stmt.bindText(1, key);
        if (try stmt.step()) {
            return try stmt.text(arena, 0);
        }
        return null;
    }

    pub fn setSetting(self: Db, key: []const u8, value: []const u8) !void {
        const stmt = try self.db.prepare("INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
        defer stmt.finalize();
        try stmt.bindText(1, key);
        try stmt.bindText(2, value);
        _ = try stmt.step();
    }

    /// Seed sample data if database is empty so the user can immediately see how it works!
    pub fn seedSampleDataIfEmpty(self: Db) !void {
        const count = try self.db.scalarInt("SELECT count(*) FROM inventory_items");
        if (count == 0) {
            _ = try self.upsertItem(.{
                .name = "Harina Pan",
                .category = "pantry",
                .location = "Pantry Main Shelf",
                .quantity = 1.0,
                .fill_percentage = 50.0,
                .unit = "package",
                .desired_quantity = 2.0,
                .notes = "Half usage recognized from pantry photo",
            });
            _ = try self.upsertItem(.{
                .name = "Whole Milk",
                .category = "fridge",
                .location = "Fridge Door",
                .quantity = 1.0,
                .fill_percentage = 20.0,
                .unit = "carton",
                .desired_quantity = 2.0,
                .notes = "Running low",
            });
            _ = try self.upsertItem(.{
                .name = "Eggs",
                .category = "fridge",
                .location = "Fridge Middle Shelf",
                .quantity = 6.0,
                .fill_percentage = 50.0,
                .unit = "units",
                .desired_quantity = 12.0,
                .notes = "Half carton left",
            });
            _ = try self.upsertItem(.{
                .name = "Olive Oil",
                .category = "pantry",
                .location = "Pantry Top Shelf",
                .quantity = 1.0,
                .fill_percentage = 80.0,
                .unit = "bottle",
                .desired_quantity = 1.0,
                .notes = "Adequate stock",
            });
            _ = try self.upsertItem(.{
                .name = "Black Beans",
                .category = "pantry",
                .location = "Pantry Bottom Shelf",
                .quantity = 3.0,
                .fill_percentage = 100.0,
                .unit = "can",
                .desired_quantity = 4.0,
                .notes = "Cans in pantry",
            });
        }
    }
};

test "sqlite in-memory db operations" {
    var db = try Db.init(":memory:");
    defer db.close();

    try db.seedSampleDataIfEmpty();

    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const items = try db.listItems(arena, null);
    try std.testing.expect(items.len >= 5);

    // Verify Harina Pan at 50% fill
    var found_harina = false;
    for (items) |it| {
        if (std.mem.eql(u8, it.name, "Harina Pan")) {
            found_harina = true;
            try std.testing.expectEqual(@as(f64, 50.0), it.fill_percentage);
            try std.testing.expectEqual(@as(f64, 2.0), it.desired_quantity);
        }
    }
    try std.testing.expect(found_harina);

    // Test low stock analysis
    const low = try db.getLowStockAnalysis(arena);
    try std.testing.expect(low.len > 0);

    // Test settings upsert & get
    try db.setSetting("provider", "ollama_local");
    const val = (try db.getSetting(arena, "provider")).?;
    try std.testing.expectEqualStrings("ollama_local", val);
}
