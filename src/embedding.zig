//! Optional Android image/text matching experiment, independent of AICore.
const std = @import("std");
const builtin = @import("builtin");
const oriel = @import("oriel");
const is_android = builtin.abi.isAndroid();
const Android = @import("android_ai_bridge.zig").Bridge("dev.ghostpantry.EmbeddingGemmaExtension");

comptime {
    if (is_android) @export(&Android.bind, .{ .name = "Java_dev_ghostpantry_EmbeddingGemmaExtension_bind" });
}

pub const Status = struct {
    state: []const u8 = "unavailable",
    message: []const u8 = "This experiment runs in the Android app.",
    supported: bool = false,
    device: []const u8 = "",
    backend: []const u8 = "",
    loaded: bool = false,
    bytes_downloaded: u64 = 0,
    total_bytes: u64 = 387710976,
};
pub const Match = struct { label: []const u8, score: f64 };
pub const Result = struct {
    matches: []const Match,
    device: []const u8,
    backend: []const u8,
    total_ms: u64,
    load_ms: u64,
    labels_ms: u64,
    image_ms: u64,
    pss_mb: f64,
    dimensions: u32,
    vision_tokens: u32,
    labels_cached: bool,
    label_cache: []const u8 = "computed",
};
const Request = struct {
    operation: []const u8,
    backend: []const u8 = "cpu",
    image: []const u8 = "",
    labels: []const []const u8 = &.{},
    max_matches: u32 = 5,
};

fn request(comptime Reply: type, arena: std.mem.Allocator, input: Request) !Reply {
    if (!is_android) return oriel.ipc.fail("Image matching requires the Android app.", .{});
    const bytes = try std.json.Stringify.valueAlloc(arena, input, .{});
    const raw = Android.request(arena, bytes) catch |err| {
        return oriel.ipc.fail("Image matching could not connect to Android ({s}).", .{@errorName(err)});
    };
    const envelope = try std.json.parseFromSliceLeaky(struct { @"error": ?[]const u8 = null }, arena, raw, .{ .ignore_unknown_fields = true });
    if (envelope.@"error") |message| return oriel.ipc.fail("EmbeddingGemma: {s}", .{message});
    return std.json.parseFromSliceLeaky(Reply, arena, raw, .{ .ignore_unknown_fields = true });
}

pub fn status(arena: std.mem.Allocator) !Status {
    if (!is_android) return .{};
    return request(Status, arena, .{ .operation = "status" });
}

pub fn manage(arena: std.mem.Allocator, operation: []const u8, backend: []const u8) !Status {
    return request(Status, arena, .{ .operation = operation, .backend = backend });
}

pub fn match(arena: std.mem.Allocator, image: []const u8, backend: []const u8, labels: []const []const u8) !Result {
    if (image.len > 7 * 1024 * 1024) return oriel.ipc.fail("Photo is too large.", .{});
    if (labels.len < 2 or labels.len > 48) return oriel.ipc.fail("Provide 2–48 food labels.", .{});
    return request(Result, arena, .{ .operation = "match", .backend = backend, .image = image, .labels = labels });
}

pub fn scan(arena: std.mem.Allocator, image: []const u8, backend: []const u8, vocabulary: []const u8) !Result {
    if (image.len > 7 * 1024 * 1024) return oriel.ipc.fail("Photo is too large.", .{});
    const labels = @import("embedding_labels.zig").parse(arena, vocabulary) catch |err| {
        return oriel.ipc.fail("Set 2–48 food labels in Settings ({s}).", .{@errorName(err)});
    };
    return request(Result, arena, .{ .operation = "match", .backend = backend, .image = image, .labels = labels, .max_matches = 10 });
}

pub fn releaseForScan(arena: std.mem.Allocator) !void {
    if (is_android) _ = try manage(arena, "release", "cpu");
}
