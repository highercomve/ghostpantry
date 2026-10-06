//! The editable starting vocabulary for fast photo matching.
const std = @import("std");

pub const defaults = "pasta\nrice\nramen noodles\nrice noodles\noats\ncereal\nflour\nbread\ncrackers\nbiscuits\ntortillas\nbeans\nlentils\nchickpeas\ncanned fish\ntomato sauce\ncooking oil\nsugar\nsalt\nspices\ncoffee\ntea\nchocolate\nnuts\npeanut butter\njam\nhoney\nmilk\ncheese\nyogurt\nbutter\neggs\nchicken\nbeef\nfish\nsausages\napples\nbananas\noranges\nlemons\ntomatoes\npotatoes\nonions\ncarrots\nbroccoli\nlettuce\nfrozen vegetables\njuice";

pub fn parse(arena: std.mem.Allocator, text: []const u8) ![]const []const u8 {
    if (text.len > 24000) return error.TooManyLabels;
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
            if (labels.items.len == 48) return error.TooManyLabels;
            try labels.append(arena, label);
        }
    }
    if (labels.items.len < 2) return error.TooFewLabels;
    std.debug.assert(labels.items.len >= 2 and labels.items.len <= 48);
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
    try std.testing.expectEqual(@as(usize, 48), (try parse(alloc, defaults)).len);
    try std.testing.expectError(error.TooManyLabels, parse(alloc, defaults ++ "\nextra"));
}
