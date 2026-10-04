//! GhostPantry: AI-powered food inventory management for fridge & pantry.

const std = @import("std");
const builtin = @import("builtin");
const oriel = @import("oriel");
const app = @import("oriel_app");
const db_mod = @import("db.zig");
const ai_mod = @import("ai.zig");

pub const std_options: std.Options = .{ .logFn = oriel.log.logFn };

const log = std.log.scoped(.ghostpantry);
const gpa = std.heap.smp_allocator;

pub var io: std.Io = undefined;
var database: ?db_mod.Db = null;
var db_mutex: std.Io.Mutex = .init;

pub const Events = struct {
    inventory_updated: struct { timestamp: i64 },
    scan_completed: struct { count: usize, summary: []const u8 },
};
const events = oriel.App.events(Events);

fn notifyUpdated() void {
    const now_ms = @as(i64, @intCast(std.Io.Clock.awake.now(io).toMilliseconds()));
    events.emit(.inventory_updated, .{ .timestamp = now_ms });
}

fn getDb(arena: std.mem.Allocator) !db_mod.Db {
    db_mutex.lockUncancelable(io);
    defer db_mutex.unlock(io);

    if (database) |d| return d;

    const base_dir = oriel.store.dataDir(arena, "GhostPantry") catch ".";
    std.Io.Dir.cwd().createDirPath(io, base_dir) catch {};
    const db_path = try std.fs.path.join(arena, &.{ base_dir, "pantry.db" });
    const zpath = try arena.dupeZ(u8, db_path);

    log.info("Opening database at {s}", .{zpath});
    var d = try db_mod.Db.init(zpath);
    try d.seedSampleDataIfEmpty();
    database = d;
    return d;
}

pub const AppSettings = struct {
    provider: []const u8 = "openai",
    baseUrl: []const u8 = "https://api.openai.com/v1",
    apiKey: []const u8 = "",
    model: []const u8 = "gpt-4o-mini",
    defaultLocation: []const u8 = "fridge",
};

fn readSettings(arena: std.mem.Allocator, d: db_mod.Db) AppSettings {
    var s = AppSettings{};
    if (d.getSetting(arena, "provider") catch null) |v| s.provider = v;
    if (d.getSetting(arena, "baseUrl") catch null) |v| s.baseUrl = v;
    if (d.getSetting(arena, "apiKey") catch null) |v| s.apiKey = v;
    if (d.getSetting(arena, "model") catch null) |v| s.model = v;
    if (d.getSetting(arena, "defaultLocation") catch null) |v| s.defaultLocation = v;
    return s;
}

pub const Commands = struct {
    pub const async_commands = .{
        "analyze_image",
    };

    pub fn get_items(arena: std.mem.Allocator, args: struct { category: ?[]const u8 = null }) ![]db_mod.Item {
        const d = try getDb(arena);
        return d.listItems(arena, args.category);
    }

    pub fn save_item(arena: std.mem.Allocator, args: struct { item: db_mod.Item }) !i64 {
        const d = try getDb(arena);
        const id = try d.upsertItem(args.item);
        notifyUpdated();
        return id;
    }

    pub fn delete_item(arena: std.mem.Allocator, args: struct { id: i64 }) !void {
        const d = try getDb(arena);
        try d.deleteItem(args.id);
        notifyUpdated();
    }

    pub fn update_stock(arena: std.mem.Allocator, args: struct { id: i64, quantity: f64, fill_percentage: f64 }) !void {
        const d = try getDb(arena);
        try d.updateStock(args.id, args.quantity, args.fill_percentage);
        notifyUpdated();
    }

    pub fn update_desired(arena: std.mem.Allocator, args: struct { id: i64, desired_quantity: f64 }) !void {
        const d = try getDb(arena);
        try d.updateDesired(args.id, args.desired_quantity);
        notifyUpdated();
    }

    pub fn get_low_stock_analysis(arena: std.mem.Allocator) ![]db_mod.LowStockItem {
        const d = try getDb(arena);
        return d.getLowStockAnalysis(arena);
    }

    pub fn get_settings(arena: std.mem.Allocator) !AppSettings {
        const d = try getDb(arena);
        return readSettings(arena, d);
    }

    pub fn save_settings(arena: std.mem.Allocator, args: struct { settings: AppSettings }) !void {
        const d = try getDb(arena);
        try d.setSetting("provider", args.settings.provider);
        try d.setSetting("baseUrl", args.settings.baseUrl);
        try d.setSetting("apiKey", args.settings.apiKey);
        try d.setSetting("model", args.settings.model);
        try d.setSetting("defaultLocation", args.settings.defaultLocation);
    }

    pub fn analyze_image(
        arena: std.mem.Allocator,
        args: struct { location: []const u8, image: []const u8 },
    ) !ai_mod.VisionResult {
        const d = try getDb(arena);
        const s = readSettings(arena, d);

        const cfg = ai_mod.AiConfig{
            .baseUrl = s.baseUrl,
            .apiKey = s.apiKey,
            .model = s.model,
            .temperature = 0.2,
        };

        log.info("Analyzing image for {s} using model {s} at {s}", .{ args.location, cfg.model, cfg.baseUrl });
        const res = ai_mod.analyzePantryImage(io, gpa, arena, cfg, args.location, args.image) catch |err| {
            log.err("Image analysis failed: {s}", .{@errorName(err)});
            return oriel.ipc.fail("Vision analysis failed ({s}). Check your endpoint URL, model name, and API key in Settings.", .{@errorName(err)});
        };

        return res;
    }

    pub fn apply_scan_results(
        arena: std.mem.Allocator,
        args: struct { location: []const u8, summary: []const u8, items: []const db_mod.Item },
    ) !void {
        const d = try getDb(arena);
        for (args.items) |it| {
            _ = try d.upsertItem(it);
        }
        try d.recordScan(args.location, @intCast(args.items.len), args.summary);
        notifyUpdated();
        events.emit(.scan_completed, .{ .count = args.items.len, .summary = args.summary });
    }

    pub fn get_scan_logs(arena: std.mem.Allocator, args: struct { limit: ?i64 = 20 }) ![]db_mod.ScanLog {
        const d = try getDb(arena);
        return d.getScanLogs(arena, args.limit orelse 20);
    }

    pub fn reset_sample_data(arena: std.mem.Allocator) !void {
        const d = try getDb(arena);
        try d.db.exec("DELETE FROM inventory_items;");
        try d.seedSampleDataIfEmpty();
        notifyUpdated();
    }

    pub fn app_info(_: std.mem.Allocator) struct { zig: []const u8, mode: []const u8, dev: bool } {
        return .{
            .zig = builtin.zig_version_string,
            .mode = @tagName(builtin.mode),
            .dev = app.dev != null,
        };
    }
};

pub fn main(init: std.process.Init) !u8 {
    io = init.io;
    return oriel.main(init, .{ .commands = Commands, .events = Events }, .{
        .id = "dev.ghostpantry.app",
        .title = "GhostPantry - Food & Fridge Inventory AI",
        .width = 1100,
        .height = 780,
        .assets = app.assets,
        .dev = app.dev,
        .deep_link_schemes = app.url_schemes,
        .permissions = app.permissions,
        .security = .{ .isolation = app.isolation },
    });
}
