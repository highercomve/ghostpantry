//! The editable starting vocabulary for fast photo matching.
const std = @import("std");

pub const max_labels = 1024;
pub const defaults = "pasta\nspaghetti\nmacaroni\npenne\nlasagna sheets\nbaby pasta\nramen noodles\nrice noodles\nudon noodles\nsoba noodles\negg noodles\ncouscous\nquinoa\nbulgur\nrice\nwhite rice\nbrown rice\nrisotto rice\nbasmati rice\njasmine rice\nwild rice\noats\ngranola\nbreakfast cereal\nmuesli\ncorn flakes\nflour\nwhole wheat flour\ncorn flour\nrice flour\nalmond flour\ncornstarch\nbreadcrumbs\nbread\nsliced bread\nwhole wheat bread\nbread rolls\nbagels\npita bread\ntortillas\ncroissants\ncrackers\nrice cakes\nbreadsticks\nbiscuits\ncookies\nbeans\nblack beans\nwhite beans\nkidney beans\npinto beans\nlentils\nchickpeas\nsplit peas\ndried peas\ncanned beans\ncanned lentils\ncanned chickpeas\ncanned corn\ncanned peas\ncanned tomatoes\ntomato paste\ntomato sauce\npasta sauce\npesto\ncanned tuna\ncanned salmon\ncanned sardines\ncanned fish\ncanned soup\ncanned fruit\nolives\npickles\ncapers\nroasted peppers\ncoconut milk\nevaporated milk\ncondensed milk\npowdered milk\nsugar\nbrown sugar\nicing sugar\nhoney\nmaple syrup\njam\nmarmalade\npeanut butter\nalmond butter\nchocolate spread\ntahini\ncooking oil\nolive oil\nsunflower oil\ncanola oil\ncoconut oil\nsesame oil\nvinegar\nbalsamic vinegar\nsoy sauce\nfish sauce\nhot sauce\nketchup\nmustard\nmayonnaise\nbarbecue sauce\nsalad dressing\nsalt\nblack pepper\npaprika\ncumin\ncinnamon\noregano\nbasil\nthyme\nrosemary\nbay leaves\nturmeric\ncurry powder\nchili powder\ngarlic powder\nonion powder\nspices\nbaking powder\nbaking soda\nyeast\nvanilla extract\ncocoa powder\nchocolate chips\ngelatin\nstock cubes\nmilk\nlactose-free milk\noat milk\nalmond milk\nsoy milk\ncream\nsour cream\nyogurt\nGreek yogurt\nbutter\nmargarine\ncheese\ncheddar cheese\nmozzarella\nparmesan\ncream cheese\ncottage cheese\nfeta cheese\neggs\negg whites\nchicken\nchicken breasts\nchicken thighs\nchicken wings\nbeef\nground beef\nsteak\npork\npork chops\nbacon\nham\nsausages\nchorizo\nsalami\nturkey\nlamb\nfish\nsalmon\ntuna\nwhite fish\nshrimp\nmussels\nsquid\ntofu\ntempeh\nseitan\nhummus\napples\nbananas\noranges\nmandarins\nlemons\nlimes\ngrapefruit\npears\npeaches\nnectarines\nplums\napricots\ngrapes\nstrawberries\nblueberries\nraspberries\nblackberries\ncherries\nkiwi\npineapple\nmango\npapaya\nwatermelon\nmelon\navocados\ncoconut\ndates\nraisins\ndried apricots\nprunes\ndried cranberries\ntomatoes\ncherry tomatoes\npotatoes\nsweet potatoes\nonions\nred onions\nspring onions\ngarlic\ncarrots\nbroccoli\ncauliflower\nlettuce\nspinach\nkale\ncabbage\nred cabbage\ncucumbers\nzucchini\neggplant\nbell peppers\nchili peppers\nmushrooms\ncelery\nleeks\nasparagus\ngreen beans\npeas\ncorn\npumpkin\nsquash\nbeetroot\nradishes\nartichokes\nginger\nparsley\ncilantro\nfresh basil\nmint\nfrozen vegetables\nfrozen peas\nfrozen corn\nfrozen broccoli\nfrozen spinach\nfrozen berries\nfrozen fruit\nfrozen chicken\nfrozen fish\nfrozen shrimp\nfrozen pizza\nfrozen dumplings\nfrench fries\nice cream\nnuts\nalmonds\nwalnuts\ncashews\npeanuts\npistachios\nhazelnuts\nsunflower seeds\npumpkin seeds\nchia seeds\nflax seeds\nsesame seeds\npopcorn\npotato chips\ntortilla chips\npretzels\nchocolate\ncandy\ncereal bars\nprotein bars\nfruit snacks\ncoffee\ninstant coffee\ncoffee beans\ntea\nherbal tea\nhot chocolate\njuice\norange juice\napple juice\nsoda\nsparkling water\nbottled water\nsports drinks\nenergy drinks\nbeer\nwine\nbaby food\ninfant formula\nprotein powder\nmeal replacement shakes\nready-made meals\nsandwiches\nempanadas\npizza\nsoup\nsalad";

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
    try std.testing.expectEqual(@as(usize, 307), (try parse(alloc, defaults)).len);
    const many = try alloc.alloc([]const u8, max_labels + 1);
    for (many, 0..) |*label, index| label.* = try std.fmt.allocPrint(alloc, "food {d}", .{index});
    try std.testing.expectEqual(@as(usize, max_labels), (try parse(alloc, try std.mem.join(alloc, "\n", many[0..max_labels]))).len);
    try std.testing.expectError(error.TooManyLabels, parse(alloc, try std.mem.join(alloc, "\n", many)));
}
