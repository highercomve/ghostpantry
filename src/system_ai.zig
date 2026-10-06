//! Android system AI via an app-owned Kotlin extension; desktop reports unavailable.
const std = @import("std");
const builtin = @import("builtin");
const oriel = @import("oriel");
const ai = @import("ai.zig");
const is_android = builtin.abi.isAndroid();

pub const Status = struct {
    state: []const u8,
    message: []const u8,
};
const Request = struct {
    operation: []const u8,
    image: []const u8 = "",
    prompt: []const u8 = "",
};
const Reply = struct {
    state: []const u8 = "unavailable",
    message: []const u8 = "",
    content: []const u8 = "",
    elapsed_ms: u64 = 0,
    @"error": ?[]const u8 = null,
};

// Only instantiated on Android; binding captures the app's class loader on UI.
const Android = if (is_android) struct {
    const jni = oriel.android.jni;
    var class_ref: std.atomic.Value(jni.jclass) = .init(null);

    fn bind(env: *jni.Env, cls: jni.jclass) callconv(.c) void {
        std.debug.assert(cls != null);
        if (class_ref.load(.acquire) != null) return;
        const global = env.functions.NewGlobalRef(env, cls);
        if (global != null) class_ref.store(global, .release);
    }

    fn request(arena: std.mem.Allocator, bytes: []const u8) ![]const u8 {
        const vm = oriel.android.runtime.vm orelse return error.SystemAiNotInitialized;
        const cls = class_ref.load(.acquire) orelse return error.SystemAiNotInitialized;
        std.debug.assert(bytes.len > 0);
        if (oriel.android.runtime.isMainThread()) return error.SystemAiWrongThread;
        const existing = vm.getEnv();
        var attached: ?*jni.Env = existing;
        if (attached == null and vm.functions.AttachCurrentThread(vm, &attached, null) != jni.JNI_OK)
            return error.JvmAttachFailed;
        defer if (existing == null) {
            _ = vm.functions.DetachCurrentThread(vm);
        };
        const env = attached orelse return error.JvmAttachFailed;
        if (env.functions.PushLocalFrame(env, 8) != 0) return error.OutOfMemory;
        defer _ = env.functions.PopLocalFrame(env, null);
        const method = env.functions.GetStaticMethodID(env, cls, "request", "([B)[B");
        if (env.clearException() or method == null) return error.SystemAiMethodMissing;
        const input = env.newBytes(bytes) orelse return error.OutOfMemory;
        const args = [_]jni.jvalue{.{ .l = input }};
        const output = env.functions.CallStaticObjectMethodA(env, cls, method, &args);
        if (env.clearException()) return error.SystemAiFailed;
        return (try env.bytesAlloc(arena, output)) orelse error.SystemAiEmptyResponse;
    }
} else struct {};

comptime {
    if (is_android) @export(&Android.bind, .{ .name = "Java_dev_ghostpantry_SystemAiExtension_bind" });
}

fn request(arena: std.mem.Allocator, input: Request) !Reply {
    if (!is_android) return error.SystemAiUnavailable;
    const bytes = try std.json.Stringify.valueAlloc(arena, input, .{});
    const raw = try Android.request(arena, bytes);
    const reply = try std.json.parseFromSliceLeaky(Reply, arena, raw, .{ .ignore_unknown_fields = true });
    if (reply.@"error") |message| return oriel.ipc.fail("System AI: {s}", .{message});
    return reply;
}

pub fn status(arena: std.mem.Allocator) !Status {
    if (!is_android) return .{ .state = "unavailable", .message = "System AI is available only in the Android app. Choose a downloaded local model here." };
    const reply = try request(arena, .{ .operation = "status" });
    return .{ .state = reply.state, .message = reply.message };
}

pub fn download(arena: std.mem.Allocator) !Status {
    const reply = try request(arena, .{ .operation = "download" });
    return .{ .state = reply.state, .message = reply.message };
}

pub fn analyze(arena: std.mem.Allocator, location: []const u8, image: []const u8) !ai.VisionResult {
    if (image.len > 7 * 1024 * 1024) return error.ImageTooLarge;
    const prompt = try std.fmt.allocPrint(arena, "{s}\nLocation: {s}. Return at most 20 visible items. Keep notes and summary short. Do not guess hidden contents; note when fill is unknown.", .{ ai.pantry_vision_system_prompt, location });
    const reply = try request(arena, .{ .operation = "analyze", .image = image, .prompt = prompt });
    var result = try ai.parseVisionContent(arena, reply.content, location);
    result.timing = .{ .total_ms = reply.elapsed_ms };
    return result;
}
