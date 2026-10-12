//! "System AI": the device's own model through `oriel.system_ai` (Gemini
//! Nano on Android, Foundation Models on iOS 26+), mapped to the states and
//! messages the page shows (frontend/src/hooks/useSystemAi.ts). Builds
//! without the module (desktop) report unavailable.
const std = @import("std");
const oriel = @import("oriel");
const ai = @import("ai.zig");

pub const Status = struct {
    /// available | downloadable | downloading | unavailable
    state: []const u8,
    message: []const u8,
};

/// Whether this build has the module at all (comptime, per target).
pub const available = oriel.system_ai.available;

const unavailable_here = "System AI isn't available on this platform. Choose a downloaded local model or a server here.";

pub fn status(arena: std.mem.Allocator) !Status {
    if (oriel.system_ai.available) {
        const st = oriel.system_ai.status();
        return describe(arena, st.state, st.reason());
    } else {
        return .{ .state = "unavailable", .message = unavailable_here };
    }
}

fn describe(arena: std.mem.Allocator, state: anytype, reason: []const u8) !Status {
    return switch (state) {
        .available => .{ .state = "available", .message = "The system model is ready. Photos are processed on this device." },
        .downloadable => .{ .state = "downloadable", .message = "This device supports system AI. Download the system model to enable scans." },
        .downloading => .{ .state = "downloading", .message = "The system is downloading its model. Check again shortly." },
        .unavailable => .{
            .state = "unavailable",
            .message = if (reason.len > 0)
                try std.fmt.allocPrint(arena, "System AI is unavailable: {s}{s} Use a downloaded local model or a server.", .{ reason, if (std.mem.endsWith(u8, reason, ".")) "" else "." })
            else
                "System AI is unavailable on this device. Use a downloaded local model or a server.",
        },
    };
}

/// Download the system model where the platform does it on demand; blocks
/// until it's ready (up to Oriel's 10 minute cap), then reports the status.
pub fn download(arena: std.mem.Allocator) !Status {
    if (oriel.system_ai.available) {
        oriel.system_ai.download(null) catch |err| switch (err) {
            error.Unavailable => return oriel.ipc.fail("System AI is unavailable. Use a downloaded local model.", .{}),
            // iOS: Apple Intelligence is still getting it ready.
            error.NotReady => {},
            else => return oriel.ipc.fail("System AI download failed: {s}", .{failure(err)}),
        };
        return status(arena);
    } else {
        return .{ .state = "unavailable", .message = unavailable_here };
    }
}

/// The platform's own words for the last failure, else the error's name.
fn failure(err: anyerror) []const u8 {
    if (oriel.system_ai.available) {
        const text = oriel.system_ai.lastError();
        if (text.len > 0) return text;
    }
    return @errorName(err);
}

pub fn analyze(io: std.Io, arena: std.mem.Allocator, location: []const u8, image: []const u8) !ai.VisionResult {
    if (!oriel.system_ai.available) return error.SystemAiUnavailable;
    if (image.len > 7 * 1024 * 1024) return error.ImageTooLarge;
    const photo = try decodeDataUrl(arena, image);
    const prompt = try std.fmt.allocPrint(arena, "{s}\nLocation: {s}. Return at most 20 visible items. Keep notes and summary short. Do not guess hidden contents; note when fill is unknown.", .{ ai.pantry_vision_system_prompt, location });
    const started_ms = std.Io.Clock.awake.now(io).toMilliseconds();
    const content = generate(arena, prompt, photo) catch |err| switch (err) {
        error.NotReady => return oriel.ipc.fail("The system model needs to be downloaded before scanning. Download it in Settings and wait for Ready to scan.", .{}),
        error.Unavailable => return oriel.ipc.fail("System AI is unavailable on this device. Check support again or choose a downloaded local model.", .{}),
        error.Busy => return oriel.ipc.fail("System AI is busy. Try again when the current operation finishes.", .{}),
        else => return oriel.ipc.fail("System AI: {s}", .{failure(err)}),
    };
    const elapsed_ms = std.Io.Clock.awake.now(io).toMilliseconds() - started_ms;
    var result = try ai.parseVisionContent(arena, content, location);
    result.timing = .{ .total_ms = @intCast(@max(0, elapsed_ms)) };
    return result;
}

fn generate(arena: std.mem.Allocator, prompt: []const u8, photo: Photo) ![]const u8 {
    if (oriel.system_ai.available) {
        return oriel.system_ai.generate(arena, .{
            .prompt = prompt,
            .images = &.{.{ .bytes = photo.bytes, .mime = photo.mime }},
            .temperature = 0.2,
            .max_tokens = 2048,
        }, null);
    } else {
        return error.Unavailable;
    }
}

const Photo = struct { mime: []const u8, bytes: []const u8 };

/// "data:image/jpeg;base64,..." (what the page sends) to its bytes.
fn decodeDataUrl(arena: std.mem.Allocator, url: []const u8) !Photo {
    const prefix = "data:";
    const marker = ";base64,";
    if (!std.mem.startsWith(u8, url, prefix)) return error.InvalidImage;
    const at = std.mem.indexOf(u8, url, marker) orelse return error.InvalidImage;
    const mime = url[prefix.len..at];
    if (!std.mem.startsWith(u8, mime, "image/") or mime.len > 64) return error.InvalidImage;
    const encoded = url[at + marker.len ..];
    const decoder = std.base64.standard.Decoder;
    const size = decoder.calcSizeForSlice(encoded) catch return error.InvalidImage;
    const bytes = try arena.alloc(u8, size);
    decoder.decode(bytes, encoded) catch return error.InvalidImage;
    return .{ .mime = mime, .bytes = bytes };
}

test decodeDataUrl {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const photo = try decodeDataUrl(arena.allocator(), "data:image/png;base64,aGk=");
    try std.testing.expectEqualStrings("image/png", photo.mime);
    try std.testing.expectEqualStrings("hi", photo.bytes);
    try std.testing.expectError(error.InvalidImage, decodeDataUrl(arena.allocator(), "data:text/plain;base64,aGk="));
}
