const std = @import("std");
const oriel = @import("oriel");

pub fn build(b: *std.Build) void {
    const target = oriel.resolveTarget(b, b.standardTargetOptions(.{}));
    const optimize = b.standardOptimizeOption(.{});
    const is_android = target.result.abi.isAndroid();

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
        .frontend = .{ .dir = "frontend" },
        .package = .{
            .id = "dev.ghostpantry.app",
            .name = "GhostPantry",
            .summary = "AI-powered Fridge and Food Pantry Inventory Manager",
            .version = "0.1.0",
        },
        .permissions = .{
            .camera = "Scan fridge and pantry shelves to detect food items",
        },
    });
}
