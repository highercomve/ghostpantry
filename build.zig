const std = @import("std");
const oriel = @import("oriel");

pub fn build(b: *std.Build) void {
    const target = oriel.resolveTarget(b, b.standardTargetOptions(.{}));
    const optimize = b.standardOptimizeOption(.{});
    const is_android = target.result.abi.isAndroid();
    const app_version = b.option([]const u8, "app_version", "Version embedded in release packages") orelse "0.1.0";

    const dep = b.dependency("oriel", .{
        .target = target,
        .optimize = optimize,
        .tray = !is_android,
        .menu = false,
        .store = true,
        .dialog = !is_android,
        .notification = true,
        .updater = false,
        .sql = true,
        // Local models ("On this device" provider, like GhostPen's):
        // llama.cpp in-process, with the image projector (mtmd) for vision.
        .llama = true,
        .llama_mtmd = true,
        .fs_watch = false,
        .media_server = false,
        .global_shortcut = false,
        .input = false,
        .clipboard = true,
    });

    _ = oriel.addApp(b, dep, .{
        .name = "ghostpantry",
        .root_source_file = b.path("src/main.zig"),
        .icon = b.path("icon.png"),
        .frontend = .{ .dir = "frontend", .types_from = .root_decls },
        .package = .{
            .id = "dev.ghostpantry.app",
            .name = "GhostPantry",
            .summary = "AI-powered Fridge and Food Pantry Inventory Manager",
            .version = app_version,
        },
        .android = .{
            .sources = &.{ b.path("android/native/PantryCameraProvider.kt"), b.path("android/native/PantryAndroidExtension.kt"), b.path("android/native/SystemAiExtension.kt"), b.path("android/native/EmbeddingGemmaExtension.kt"), b.path("android/native/EmbeddingMath.kt"), b.path("android/native/EmbeddingCache.kt"), b.path("android/native/EmbeddingFeedback.kt") },
            .extensions = &.{ "dev.ghostpantry.PantryAndroidExtension", "dev.ghostpantry.SystemAiExtension", "dev.ghostpantry.EmbeddingGemmaExtension" },
            .dependencies = &.{ "com.google.mlkit:genai-prompt:1.0.0-beta4", "org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2", "com.google.ai.edge.litertlm:litertlm-android:0.18.0" },
            .native_libraries = &.{.{ .name = "libvndksupport.so" }},
            .proguard_rules = b.path("android/native/proguard-rules.pro"),
        },
        .permissions = .{
            .camera = "Scan fridge and pantry shelves to detect food items",
        },
    });
}
