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
    // The app's private data dir (Android: the files dir itself, where
    // earlier releases kept it), created if missing.
    const base_dir = try oriel.paths.appData(alloc, .{ .name = "GhostPantry" });
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

/// What this build can scan with: fast local matching where the
/// "pantry.vision" extension has an implementation (Android), System AI
/// where `oriel.system_ai` exists (Android, iOS). Both are comptime facts;
/// whether the device has the model is the providers' own runtime status.
pub const Capabilities = struct {
    fastLocal: bool,
    systemAi: bool,
    /// The provider a new install starts with.
    defaultProvider: []const u8,
};
const fast_local = embedding.available();
/// Fast local where it exists; elsewhere the local LLM, which runs on every
/// platform (a server needs an address and usually a key first).
const default_provider = if (fast_local) "embedding" else "local";

/// Whether this build can use `provider` (servers and the local LLM always).
fn providerUsable(provider: []const u8) bool {
    if (std.mem.eql(u8, provider, "embedding")) return fast_local;
    if (std.mem.eql(u8, provider, "system")) return system_ai.available;
    return true;
}

pub const AppSettings = struct {
    provider: []const u8 = default_provider,
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
    // A provider this build can't use (a database copied from the phone, or
    // saved before providers were hidden) reads as the default.
    if (setting(arena, d, "provider")) |v| {
        if (providerUsable(v)) s.provider = v;
    }
    if (setting(arena, d, "baseUrl")) |v| s.baseUrl = v;
    if (setting(arena, d, "apiKey")) |v| s.apiKey = v;
    if (setting(arena, d, "model")) |v| s.model = v;
    if (setting(arena, d, "defaultLocation")) |v| s.defaultLocation = v;
    if (setting(arena, d, "localBackend")) |v| s.localBackend = v;
    if (setting(arena, d, "localScanMode")) |v| s.localScanMode = v;
    if (setting(arena, d, "embeddingBackend")) |v| s.embeddingBackend = v;
    if (setting(arena, d, "matchingLabels")) |v| {
        if (v.len > 0) s.matchingLabels = v;
    }
    return s;
}

/// One stored setting; a database error is logged and reads as unset (the
/// default), so a broken row never hides the whole Settings page.
fn setting(arena: std.mem.Allocator, d: db_mod.Db, key: []const u8) ?[]const u8 {
    return d.getSetting(arena, key) catch |err| {
        log.err("cannot read setting {s}: {s}", .{ key, @errorName(err) });
        return null;
    };
}

fn oneOf(value: []const u8, comptime allowed: []const []const u8) bool {
    inline for (allowed) |a| if (std.mem.eql(u8, value, a)) return true;
    return false;
}

/// The most items one scan may save, and scan log rows one call may list.
const max_scan_items = 200;
const max_scan_logs = 500;

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
        "detect_regions",
        "embedding_region_match",
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

    pub fn capabilities(_: std.mem.Allocator) Capabilities {
        return .{ .fastLocal = fast_local, .systemAi = system_ai.available, .defaultProvider = default_provider };
    }

    pub fn save_settings(arena: std.mem.Allocator, args: struct { settings: AppSettings }) !void {
        if (!providerUsable(args.settings.provider))
            return oriel.ipc.fail("{s} isn't available on this platform. Choose another provider.", .{args.settings.provider});
        if (args.settings.matchingLabels.len > 0 or std.mem.eql(u8, args.settings.provider, "embedding")) _ = @import("embedding_labels.zig").parse(arena, args.settings.matchingLabels) catch |err| {
            return oriel.ipc.fail("Set 2–1,024 unique food labels ({s}).", .{@errorName(err)});
        };
        if (!std.mem.eql(u8, args.settings.embeddingBackend, "cpu") and !std.mem.eql(u8, args.settings.embeddingBackend, "gpu"))
            return oriel.ipc.fail("Choose CPU or GPU for fast local scans.", .{});
        // Empty is the default (settings saved before these existed).
        if (!oneOf(args.settings.localScanMode, &.{ "", "fast", "balanced" }))
            return oriel.ipc.fail("Choose fast or balanced local scans.", .{});
        if (!oneOf(args.settings.localBackend, &.{ "", "auto", "gpu", "cpu" }))
            return oriel.ipc.fail("Choose Auto, GPU or CPU for the local model.", .{});
        // Other providers name their own models; a local one must be in the catalog.
        if (std.mem.eql(u8, args.settings.provider, "local") and local_mod.find(args.settings.model) == null)
            return oriel.ipc.fail("Unknown local model {s}.", .{args.settings.model});
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
            return system_ai.analyze(io, arena, args.location, args.image) catch |err| {
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
        var api_error: ?[]const u8 = null;
        const res = ai_mod.analyzePantryImage(io, gpa, arena, cfg, args.location, args.image, &api_error) catch |err| {
            log.err("Image analysis failed: {s}", .{@errorName(err)});
            if (api_error) |detail| {
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
        return system_ai.download(io, arena);
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

    pub fn detect_regions(arena: std.mem.Allocator, args: struct { image: []const u8, detector: []const u8, threshold: f64 = 0.25 }) !embedding.DetectionResult {
        return embedding.detect(arena, args.image, args.detector, args.threshold);
    }

    pub fn embedding_region_match(arena: std.mem.Allocator, args: struct { image: []const u8, backend: []const u8, labels: []const []const u8, use_feedback: bool }) !embedding.Result {
        local_mod.unload();
        return embedding.regionMatch(arena, args.image, args.backend, args.labels, args.use_feedback);
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
        if (args.items.len > max_scan_items)
            return oriel.ipc.fail("A scan can save at most {d} items.", .{max_scan_items});
        const d = try getDb(arena);
        // All or nothing: a failed write leaves the inventory as it was.
        try d.db.exec("BEGIN IMMEDIATE;");
        {
            errdefer d.db.exec("ROLLBACK;") catch |err| log.err("scan rollback failed: {s}", .{@errorName(err)});
            for (args.items) |it| {
                _ = try d.upsertItem(it);
            }
            try d.recordScan(args.location, @intCast(args.items.len), args.summary);
            try d.db.exec("COMMIT;");
        }
        notifyUpdated();
        events.emit(.scan_completed, .{ .count = args.items.len, .summary = args.summary });
    }

    pub fn get_scan_logs(arena: std.mem.Allocator, args: struct { limit: ?i64 = 20 }) ![]db_mod.ScanLog {
        const d = try getDb(arena);
        // Negative means "no limit" to SQLite: always 1..max_scan_logs.
        return d.getScanLogs(arena, std.math.clamp(args.limit orelse 20, 1, max_scan_logs));
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

/// Free the local model when the system wants memory back, and when the app
/// leaves the screen (phones only send `background`): the next scan loads it
/// again. A model that is answering stays (unloadIdle never waits).
fn onLifecycle(event: oriel.lifecycle.Event) void {
    switch (event) {
        .memory_pressure => |level| if (level == .critical) local_mod.unloadIdle(),
        .background => local_mod.unloadIdle(),
        else => {},
    }
}

pub fn main(init: std.process.Init) !u8 {
    io = init.io;
    local_mod.init(init.io, gpa);
    oriel.lifecycle.subscribe(onLifecycle) catch |err| log.err("lifecycle: {s}", .{@errorName(err)});
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
