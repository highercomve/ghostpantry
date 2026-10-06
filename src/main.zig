//! GhostPantry: AI-powered food inventory management for fridge & pantry.

const std = @import("std");
const builtin = @import("builtin");
const oriel = @import("oriel");
const app = @import("oriel_app");
const db_mod = @import("db.zig");
const ai_mod = @import("ai.zig");
const local_mod = @import("local.zig");
const system_ai = @import("system_ai.zig");
const embedding = @import("embedding.zig");

pub const std_options: std.Options = .{ .logFn = oriel.log.logFn };

const log = std.log.scoped(.ghostpantry);
const gpa = std.heap.smp_allocator;

pub var io: std.Io = undefined;
var database: ?db_mod.Db = null;
var db_mutex: std.Io.Mutex = .init;

pub const Events = struct {
    inventory_updated: struct { timestamp: i64 },
    scan_completed: struct { count: usize, summary: []const u8 },
    local_model_download: local_mod.DownloadEvent,
};
const events = oriel.App.events(Events);

fn notifyUpdated() void {
    const now_ms = @as(i64, @intCast(std.Io.Clock.awake.now(io).toMilliseconds()));
    events.emit(.inventory_updated, .{ .timestamp = now_ms });
}

fn getDbPath(alloc: std.mem.Allocator) ![:0]const u8 {
    if (builtin.target.os.tag == .linux and builtin.target.abi.isAndroid()) {
        if (@hasDecl(oriel, "android") and @hasDecl(oriel.android, "paths")) {
            if (oriel.android.paths.filesDir()) |fdir| {
                const p = try std.fs.path.join(alloc, &.{ fdir, "pantry.db" });
                return try alloc.dupeZ(u8, p);
            }
        }
    }
    const base_dir = oriel.store.dataDir(alloc, "GhostPantry") catch ".";
    std.Io.Dir.cwd().createDirPath(io, base_dir) catch {};
    const db_path = try std.fs.path.join(alloc, &.{ base_dir, "pantry.db" });
    return try alloc.dupeZ(u8, db_path);
}

fn getDb(_: std.mem.Allocator) !db_mod.Db {
    db_mutex.lockUncancelable(io);
    defer db_mutex.unlock(io);

    if (database) |d| return d;

    const zpath = try getDbPath(gpa);
    defer gpa.free(zpath);

    log.info("Opening database at {s}", .{zpath});
    const d = try db_mod.Db.init(zpath);
    database = d;
    return d;
}

pub const AppSettings = struct {
    provider: []const u8 = "local",
    baseUrl: []const u8 = "https://api.openai.com/v1",
    apiKey: []const u8 = "",
    model: []const u8 = "qwen2.5-vl-3b",
    defaultLocation: []const u8 = "fridge",
    localBackend: []const u8 = "auto",
    localScanMode: []const u8 = "balanced",
    embeddingBackend: []const u8 = "cpu",
    matchingLabels: []const u8 = @import("embedding_labels.zig").defaults,
};

fn readSettings(arena: std.mem.Allocator, d: db_mod.Db) AppSettings {
    var s = AppSettings{};
    if (d.getSetting(arena, "provider") catch null) |v| s.provider = v;
    if (d.getSetting(arena, "baseUrl") catch null) |v| s.baseUrl = v;
    if (d.getSetting(arena, "apiKey") catch null) |v| s.apiKey = v;
    if (d.getSetting(arena, "model") catch null) |v| s.model = v;
    if (d.getSetting(arena, "defaultLocation") catch null) |v| s.defaultLocation = v;
    if (d.getSetting(arena, "localBackend") catch null) |v| s.localBackend = v;
    if (d.getSetting(arena, "localScanMode") catch null) |v| s.localScanMode = v;
    if (d.getSetting(arena, "embeddingBackend") catch null) |v| s.embeddingBackend = v;
    if (d.getSetting(arena, "matchingLabels") catch null) |v| {
        if (v.len > 0) s.matchingLabels = v;
    }
    return s;
}

pub const Commands = struct {
    pub const async_commands = .{
        "analyze_image",
        "get_available_models",
        "system_ai_status",
        "system_ai_download",
        "embedding_status",
        "embedding_download",
        "embedding_cancel",
        "embedding_prepare",
        "embedding_match",
        "fast_scan",
        "embedding_feedback",
        "embedding_clear_feedback",
        "embedding_release",
        "embedding_delete",
        "local_status",
        "local_download",
        "local_test",
        "local_delete",
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
        if (args.settings.matchingLabels.len > 0 or std.mem.eql(u8, args.settings.provider, "embedding")) _ = @import("embedding_labels.zig").parse(arena, args.settings.matchingLabels) catch |err| {
            return oriel.ipc.fail("Set 2–1,024 unique food labels ({s}).", .{@errorName(err)});
        };
        if (!std.mem.eql(u8, args.settings.embeddingBackend, "cpu") and !std.mem.eql(u8, args.settings.embeddingBackend, "gpu"))
            return oriel.ipc.fail("Choose CPU or GPU for fast local scans.", .{});
        const d = try getDb(arena);
        try d.setSetting("provider", args.settings.provider);
        try d.setSetting("baseUrl", args.settings.baseUrl);
        try d.setSetting("apiKey", args.settings.apiKey);
        try d.setSetting("model", args.settings.model);
        try d.setSetting("defaultLocation", args.settings.defaultLocation);
        try d.setSetting("localBackend", args.settings.localBackend);
        try d.setSetting("localScanMode", args.settings.localScanMode);
        try d.setSetting("embeddingBackend", args.settings.embeddingBackend);
        if (args.settings.matchingLabels.len > 0) try d.setSetting("matchingLabels", args.settings.matchingLabels);
    }

    pub fn get_available_models(
        arena: std.mem.Allocator,
        args: struct { baseUrl: []const u8, apiKey: ?[]const u8 = null },
    ) ![]const ai_mod.ModelItem {
        log.info("Fetching available models from {s}", .{args.baseUrl});
        const models = ai_mod.fetchAvailableModels(io, gpa, arena, args.baseUrl, args.apiKey) catch |err| {
            log.err("Failed to fetch models: {s}", .{@errorName(err)});
            return oriel.ipc.fail("Failed to fetch models ({s}) from {s}. Verify server address.", .{ @errorName(err), args.baseUrl });
        };
        return models;
    }

    pub fn analyze_image(
        arena: std.mem.Allocator,
        args: struct { location: []const u8, image: []const u8 },
    ) !ai_mod.VisionResult {
        const d = try getDb(arena);
        const s = readSettings(arena, d);

        if (std.mem.eql(u8, s.provider, "embedding"))
            return oriel.ipc.fail("Use fast local matching to get suggestions for review.", .{});
        try embedding.releaseForScan(arena);
        if (std.mem.eql(u8, s.provider, "system")) {
            local_mod.unload();
            return system_ai.analyze(arena, args.location, args.image) catch |err| {
                if (err == error.CommandFailed) return err;
                return oriel.ipc.fail("System AI scan failed ({s}). Check system AI in Settings or choose a downloaded local model.", .{@errorName(err)});
            };
        }

        if (std.mem.eql(u8, s.provider, "local")) {
            log.info("Analyzing image for {s} with the local model {s}", .{ args.location, s.model });
            const res = local_mod.analyze(arena, s.model, s.localBackend, std.mem.eql(u8, s.localScanMode, "fast"), args.location, args.image) catch |err| {
                log.err("Local vision failed: {s}", .{@errorName(err)});
                return oriel.ipc.fail("Local model analysis failed ({s}). Check that the model is downloaded in Settings, then try again.", .{@errorName(err)});
            };
            return res;
        }

        const cfg = ai_mod.AiConfig{
            .baseUrl = s.baseUrl,
            .apiKey = s.apiKey,
            .model = s.model,
            .temperature = 0.2,
        };

        log.info("Analyzing image for {s} using model {s} at {s}", .{ args.location, cfg.model, cfg.baseUrl });
        const res = ai_mod.analyzePantryImage(io, gpa, arena, cfg, args.location, args.image) catch |err| {
            log.err("Image analysis failed: {s}", .{@errorName(err)});
            if (ai_mod.last_api_error) |detail| {
                return oriel.ipc.fail("{s}", .{detail});
            }
            return oriel.ipc.fail("Vision analysis failed ({s}). Check your endpoint URL, model name, and API key in Settings.", .{@errorName(err)});
        };

        return res;
    }

    pub fn system_ai_status(arena: std.mem.Allocator) !system_ai.Status {
        return system_ai.status(arena);
    }

    pub fn system_ai_download(arena: std.mem.Allocator) !system_ai.Status {
        return system_ai.download(arena);
    }

    pub fn embedding_default_labels(arena: std.mem.Allocator) ![]const []const u8 {
        return @import("embedding_labels.zig").parse(arena, @import("embedding_labels.zig").defaults);
    }

    pub fn embedding_status(arena: std.mem.Allocator) !embedding.Status {
        return embedding.status(arena);
    }

    pub fn embedding_download(arena: std.mem.Allocator) !embedding.Status {
        return embedding.manage(arena, "download", "cpu");
    }

    pub fn embedding_cancel(arena: std.mem.Allocator) !embedding.Status {
        return embedding.manage(arena, "cancel", "cpu");
    }

    pub fn embedding_prepare(arena: std.mem.Allocator, args: struct { backend: []const u8 }) !embedding.Status {
        local_mod.unload();
        return embedding.manage(arena, "prepare", args.backend);
    }

    pub fn embedding_match(arena: std.mem.Allocator, args: struct { image: []const u8, backend: []const u8, labels: []const []const u8 }) !embedding.Result {
        local_mod.unload();
        return embedding.match(arena, args.image, args.backend, args.labels);
    }

    pub fn fast_scan(arena: std.mem.Allocator, args: struct { image: []const u8 }) !embedding.Result {
        const d = try getDb(arena);
        const settings = readSettings(arena, d);
        local_mod.unload();
        return embedding.scan(arena, args.image, settings.embeddingBackend, settings.matchingLabels);
    }

    pub fn embedding_feedback(arena: std.mem.Allocator, args: struct { scan_id: []const u8, label: []const u8, accepted: bool }) !embedding.FeedbackStatus {
        return embedding.feedback(arena, args.scan_id, args.label, args.accepted);
    }

    pub fn embedding_clear_feedback(arena: std.mem.Allocator) !embedding.FeedbackStatus {
        return embedding.clearFeedback(arena);
    }

    pub fn embedding_release(arena: std.mem.Allocator) !embedding.Status {
        return embedding.manage(arena, "release", "cpu");
    }

    pub fn embedding_delete(arena: std.mem.Allocator) !embedding.Status {
        return embedding.manage(arena, "delete", "cpu");
    }

    pub fn local_status(arena: std.mem.Allocator) !local_mod.Status {
        return local_mod.status(arena) catch |err| {
            return oriel.ipc.fail("The local model runner isn't available ({s}).", .{@errorName(err)});
        };
    }

    pub fn local_download(arena: std.mem.Allocator, args: struct { id: []const u8 }) !void {
        _ = arena;
        local_mod.download(args.id) catch |err| switch (err) {
            error.Cancelled => return,
            else => {
                log.err("Local model download failed: {s}", .{@errorName(err)});
                return oriel.ipc.fail("The model download failed ({s}). Check the connection and try again — it resumes where it stopped.", .{@errorName(err)});
            },
        };
    }

    pub fn local_cancel_download(arena: std.mem.Allocator) void {
        _ = arena;
        local_mod.cancelDownload();
    }

    pub fn local_delete(arena: std.mem.Allocator, args: struct { id: []const u8 }) !void {
        _ = arena;
        local_mod.delete(args.id) catch |err| {
            return oriel.ipc.fail("Could not delete the model ({s}).", .{@errorName(err)});
        };
    }

    pub fn local_unload(arena: std.mem.Allocator) void {
        _ = arena;
        local_mod.unload();
    }

    pub fn local_test(arena: std.mem.Allocator, args: struct { id: []const u8, backend: ?[]const u8 = null, fast: bool = false }) !local_mod.LoadInfo {
        try embedding.releaseForScan(arena);
        return local_mod.testLoad(args.id, args.backend orelse "auto", args.fast) catch |err| {
            log.err("Local model load failed: {s}", .{@errorName(err)});
            return oriel.ipc.fail("The model didn't load ({s}). Pick a smaller model or free some memory and try again.", .{@errorName(err)});
        };
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

    pub fn clear_all_items(arena: std.mem.Allocator) !void {
        const d = try getDb(arena);
        try d.clearAllItems();
        notifyUpdated();
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
    local_mod.init(init.io, gpa);
    if (@hasDecl(oriel, "android") and @hasDecl(oriel.android, "onSystemEvent")) {
        oriel.android.onSystemEvent(local_mod.handleSystemEvent);
    }
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
