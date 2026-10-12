const std = @import("std");
const oriel = @import("oriel");

pub fn build(b: *std.Build) void {
    const target = oriel.resolveTarget(b, b.standardTargetOptions(.{}));
    const optimize = b.standardOptimizeOption(.{});
    const app_version = b.option([]const u8, "app_version", "Version embedded in release packages") orelse "0.1.5";

    const dep = b.dependency("oriel", .{
        .target = target,
        .optimize = optimize,
        // Intent, once for every target: each module resolves per target to
        // `oriel.<module>.available` (no tray or dialog on phones).
        .tray = true,
        .menu = false,
        .store = true,
        .dialog = true,
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
        // The phone's own model ("System AI"): Gemini Nano through ML Kit on
        // Android, Foundation Models on iOS 26+. Oriel adds the ML Kit
        // dependency; elsewhere `oriel.system_ai.available` is false.
        .system_ai = true,
    });

    // Fast local on iOS ships the CLIP merges and the YOLOE CoreML detectors
    // (a pinned release asset, build.zig.zon; fetched for iOS builds only).
    const clip: oriel.AppOptions.Asset = .{ .from = b.path("ios/native/resources/clip"), .to = "clip" };
    const yoloe_coreml = if (target.result.os.tag == .ios) b.lazyDependency("yoloe_coreml", .{}) else null;
    const ios_resources: []const oriel.AppOptions.Asset = if (yoloe_coreml) |d|
        &.{ clip, .{ .from = d.path(""), .to = "yoloe-coreml" } }
    else
        &.{clip};

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
        // Fast local matching, the app's own native code: YOLOE plus
        // EmbeddingGemma 2 on Android, YOLOE (CoreML) plus Apple's
        // MobileCLIP-S2 on iOS. Elsewhere `available()` is false and the UI
        // hides the provider.
        .extensions = &.{.{
            .name = "pantry.vision",
            .android = .{
                .class = "dev.ghostpantry.EmbeddingGemmaExtension",
                .sources = &.{ b.path("android/native/EmbeddingGemmaExtension.kt"), b.path("android/native/EmbeddingMath.kt"), b.path("android/native/EmbeddingCache.kt"), b.path("android/native/EmbeddingFeedback.kt"), b.path("android/native/PantryDetector.kt"), b.path("android/native/YoloePackageMath.kt"), b.path("android/native/YoloePackageDetector.kt") },
                .dependencies = &.{ "com.google.ai.edge.litertlm:litertlm-android:0.18.0", "com.microsoft.onnxruntime:onnxruntime-android:1.30.0" },
                // The YOLOE detectors (gzipped ONNX, AGPL: YOLOE-LICENSE),
                // read from the APK's assets/detectors.
                .assets = &.{.{ .from = b.path("android/native/detectors"), .to = "detectors" }},
            },
            // Swift raises the app's minimum to iOS 18. MobileCLIP-S2 is
            // downloaded at run time (apple-ascl licence); the CLIP merges and
            // the YOLOE detectors are in the bundle (ios_resources above).
            .ios = .{
                .class = "PantryVisionExtension",
                .swift_sources = &.{ b.path("ios/native/PantryVisionExtension.swift"), b.path("ios/native/MobileClip.swift"), b.path("ios/native/ClipTokenizer.swift"), b.path("ios/native/YoloeDetector.swift"), b.path("ios/native/EmbeddingStore.swift") },
                .frameworks = &.{ "CoreML", "CoreGraphics", "CoreVideo", "ImageIO", "CryptoKit" },
                .resources = ios_resources,
            },
            // Cancel and status answer while a long match or detection runs
            // (the extension serializes the rest itself and reports busy).
            .concurrency = 2,
        }},
        .android = .{
            .native_libraries = &.{.{ .name = "libvndksupport.so" }},
            .proguard_rules = b.path("android/native/proguard-rules.pro"),
        },
        // Also turns on oriel.camera: <input type=file accept=image/* capture>
        // opens the camera app, the photo picker and HEIC transcoding.
        .permissions = .{
            .camera = "Scan fridge and pantry shelves to detect food items",
        },
    });
}
