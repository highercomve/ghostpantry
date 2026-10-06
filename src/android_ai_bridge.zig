//! JNI transport for app-owned Android AI extensions with request(byte[]) APIs.
const std = @import("std");
const builtin = @import("builtin");
const oriel = @import("oriel");

pub fn Bridge(comptime extension: []const u8) type {
    return if (builtin.abi.isAndroid()) struct {
        const jni = oriel.android.jni;
        var class_ref: std.atomic.Value(jni.jclass) = .init(null);

        pub fn bind(env: *jni.Env, cls: jni.jclass) callconv(.c) void {
            std.debug.assert(cls != null);
            if (class_ref.load(.acquire) != null) return;
            const global = env.functions.NewGlobalRef(env, cls);
            if (global != null) class_ref.store(global, .release);
        }

        pub fn request(arena: std.mem.Allocator, bytes: []const u8) ![]const u8 {
            const vm = oriel.android.runtime.vm orelse return error.SystemAiNotInitialized;
            const cls = class_ref.load(.acquire) orelse return error.SystemAiNotInitialized;
            std.debug.assert(bytes.len > 0 and extension.len > 0);
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
}
