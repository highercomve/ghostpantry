//! The editable starting vocabulary for fast photo matching.
const std = @import("std");

pub const max_labels = 1024;
// One label per line; app developers can edit this catalog without changing parsing.
pub const defaults = @embedFile("food_labels.txt");

pub fn parse(arena: std.mem.Allocator, text: []const u8) ![]const []const u8 {
    if (text.len > 512 * 1024) return error.TooManyLabels;
    var labels: std.ArrayList([]const u8) = .empty;
    var parts = std.mem.splitAny(u8, text, ",\n");
    while (parts.next()) |part| {
        const label = std.mem.trim(u8, part, " \t\r");
        if (label.len == 0) continue;
        if (label.len > 480) return error.LabelTooLong;
        const view = std.unicode.Utf8View.init(label) catch return error.InvalidLabel;
        var chars = view.iterator();
        var units: usize = 0;
        while (chars.nextCodepoint()) |point| {
            if (point < 32 or point == 127) return error.InvalidLabel;
            units += if (point > 0xffff) @as(usize, 2) else 1;
            if (units > 120) return error.LabelTooLong;
        }
        for (labels.items) |have| {
            if (std.ascii.eqlIgnoreCase(have, label)) break;
        } else {
            if (labels.items.len == max_labels) return error.TooManyLabels;
            try labels.append(arena, label);
        }
    }
    if (labels.items.len < 2) return error.TooFewLabels;
    std.debug.assert(labels.items.len >= 2 and labels.items.len <= max_labels);
    return labels.toOwnedSlice(arena);
}

test "vocabulary trims, deduplicates and rejects unusable inputs" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    const labels = try parse(alloc, " pasta, Rice\r\nPASTA\n \nrice ");
    try std.testing.expectEqual(@as(usize, 2), labels.len);
    try std.testing.expectEqualStrings("pasta", labels[0]);
    try std.testing.expectEqualStrings("Rice", labels[1]);
    try std.testing.expectError(error.LabelTooLong, parse(alloc, ("x" ** 121) ++ ",rice"));
    try std.testing.expectError(error.InvalidLabel, parse(alloc, "pasta\x00,rice"));
    try std.testing.expectEqual(@as(usize, 2), (try parse(alloc, "arroz,pasta de arroz")).len);
    try std.testing.expectError(error.TooFewLabels, parse(alloc, "pasta,PASTA"));
    try std.testing.expectEqual(@as(usize, 710), (try parse(alloc, defaults)).len);
    const many = try alloc.alloc([]const u8, max_labels + 1);
    for (many, 0..) |*label, index| label.* = try std.fmt.allocPrint(alloc, "food {d}", .{index});
    try std.testing.expectEqual(@as(usize, max_labels), (try parse(alloc, try std.mem.join(alloc, "\n", many[0..max_labels]))).len);
    try std.testing.expectError(error.TooManyLabels, parse(alloc, try std.mem.join(alloc, "\n", many)));
}
