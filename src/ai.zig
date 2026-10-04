const std = @import("std");

pub const VisionItem = struct {
    name: []const u8,
    category: []const u8 = "pantry",
    quantity: f64 = 1.0,
    fill_percentage: f64 = 100.0,
    unit: []const u8 = "unit",
    notes: []const u8 = "",
};

pub const VisionResult = struct {
    items: []VisionItem,
    summary: []const u8,
};

pub const AiConfig = struct {
    baseUrl: []const u8 = "https://api.openai.com/v1",
    apiKey: []const u8 = "",
    model: []const u8 = "gpt-4o-mini",
    temperature: f32 = 0.2,
};

pub const pantry_vision_system_prompt =
    \\You are an expert food pantry and refrigerator inventory tracker.
    \\Analyze the photo taken of the pantry, fridge, freezer, or food storage.
    \\Identify all visible food items, groceries, drinks, condiments, and ingredients.
    \\For each item, carefully inspect and provide:
    \\- name: Standard clear name of the food item (e.g. "Harina Pan", "Whole Milk", "Eggs", "Cheddar Cheese", "Black Beans").
    \\- category: One of "pantry", "fridge", "freezer", or "other".
    \\- quantity: The count of distinct containers/packages visible (e.g. 1.0, 2.0, 6.0).
    \\- fill_percentage: Estimated percentage remaining from 0.0 to 100.0. If a package or bottle is half full/half used, return 50.0. If unopened or full, return 100.0. If roughly a quarter left, return 25.0.
    \\- unit: Appropriate unit such as "package", "bottle", "carton", "can", "box", "jar", "bag", "units".
    \\- notes: Brief observation (e.g. "Half usage recognized", "Unopened", "In fridge door").
    \\
    \\Return ONLY a valid JSON object in this exact schema, with NO markdown backticks, no explanations:
    \\{"items":[{"name":"Harina Pan","category":"pantry","quantity":1.0,"fill_percentage":50.0,"unit":"package","notes":"Half usage"}],"summary":"Detected pantry items"}
;

pub fn cleanJson(raw: []const u8) []const u8 {
    var trimmed = std.mem.trim(u8, raw, " \t\r\n");
    if (std.mem.startsWith(u8, trimmed, "```json")) {
        trimmed = trimmed["```json".len..];
    } else if (std.mem.startsWith(u8, trimmed, "```")) {
        trimmed = trimmed["```".len..];
    }
    if (std.mem.endsWith(u8, trimmed, "```")) {
        trimmed = trimmed[0 .. trimmed.len - 3];
    }
    trimmed = std.mem.trim(u8, trimmed, " \t\r\n");

    const start = std.mem.indexOfScalar(u8, trimmed, '{') orelse return trimmed;
    const end = std.mem.lastIndexOfScalar(u8, trimmed, '}') orelse return trimmed;
    if (end >= start) {
        return trimmed[start .. end + 1];
    }
    return trimmed;
}

pub fn analyzePantryImage(
    io: std.Io,
    gpa: std.mem.Allocator,
    arena: std.mem.Allocator,
    cfg: AiConfig,
    location_hint: []const u8,
    image_url_or_base64: []const u8,
) !VisionResult {
    const formatted_image_url = if (std.mem.startsWith(u8, image_url_or_base64, "data:"))
        image_url_or_base64
    else
        try std.fmt.allocPrint(arena, "data:image/jpeg;base64,{s}", .{image_url_or_base64});

    const user_prompt = try std.fmt.allocPrint(arena, "Analyze this photo of the {s}. List all visible food items with their quantities and estimated remaining fill percentages.", .{location_hint});

    // Build OpenAI-compatible request body
    var body_writer: std.Io.Writer.Allocating = .init(arena);
    var jw: std.json.Stringify = .{ .writer = &body_writer.writer };

    try jw.beginObject();
    try jw.objectField("model");
    try jw.write(cfg.model);

    try jw.objectField("messages");
    try jw.beginArray();

    // System message
    try jw.beginObject();
    try jw.objectField("role");
    try jw.write("system");
    try jw.objectField("content");
    try jw.write(pantry_vision_system_prompt);
    try jw.endObject();

    // User message with text and image_url
    try jw.beginObject();
    try jw.objectField("role");
    try jw.write("user");
    try jw.objectField("content");
    try jw.beginArray();

    try jw.beginObject();
    try jw.objectField("type");
    try jw.write("text");
    try jw.objectField("text");
    try jw.write(user_prompt);
    try jw.endObject();

    try jw.beginObject();
    try jw.objectField("type");
    try jw.write("image_url");
    try jw.objectField("image_url");
    try jw.beginObject();
    try jw.objectField("url");
    try jw.write(formatted_image_url);
    try jw.endObject();
    try jw.endObject();

    try jw.endArray();
    try jw.endObject();

    try jw.endArray();

    try jw.objectField("temperature");
    try jw.write(cfg.temperature);
    try jw.objectField("max_tokens");
    try jw.write(@as(u32, 2048));

    try jw.endObject();

    const request_body = body_writer.written();

    const base = std.mem.trimEnd(u8, cfg.baseUrl, "/");
    const endpoint_url = if (std.mem.endsWith(u8, base, "/chat/completions"))
        try arena.dupe(u8, base)
    else
        try std.fmt.allocPrint(arena, "{s}/chat/completions", .{base});

    var client: std.http.Client = .{ .allocator = gpa, .io = io };
    defer client.deinit();

    const auth_header: ?[]const u8 = if (cfg.apiKey.len > 0)
        try std.fmt.allocPrint(arena, "Bearer {s}", .{cfg.apiKey})
    else
        null;

    var response_buffer: std.Io.Writer.Allocating = .init(arena);

    const res = client.fetch(.{
        .location = .{ .url = endpoint_url },
        .method = .POST,
        .payload = request_body,
        .keep_alive = false,
        .headers = .{
            .accept_encoding = .{ .override = "identity" },
            .content_type = .{ .override = "application/json" },
            .authorization = if (auth_header) |auth| .{ .override = auth } else .default,
        },
        .response_writer = &response_buffer.writer,
    }) catch |err| {
        std.log.err("HTTP fetch error: {s}", .{@errorName(err)});
        return error.AiNetworkError;
    };

    if (res.status.class() != .success) {
        std.log.err("HTTP error status: {d}", .{@intFromEnum(res.status)});
        return error.AiApiError;
    }

    const resp_raw = response_buffer.written();

    // Parse OpenAI chat completion JSON response
    const ChatResponse = struct {
        choices: []const struct {
            message: struct {
                content: ?[]const u8 = null,
            },
        } = &.{},
    };

    const parsed_chat = std.json.parseFromSliceLeaky(ChatResponse, arena, resp_raw, .{ .ignore_unknown_fields = true }) catch {
        return error.AiParseError;
    };

    if (parsed_chat.choices.len == 0 or parsed_chat.choices[0].message.content == null) {
        return error.AiEmptyResponse;
    }

    const ai_content = parsed_chat.choices[0].message.content.?;
    const cleaned_json = cleanJson(ai_content);

    const Schema = struct {
        items: []const struct {
            name: []const u8,
            category: ?[]const u8 = null,
            quantity: ?f64 = null,
            fill_percentage: ?f64 = null,
            unit: ?[]const u8 = null,
            notes: ?[]const u8 = null,
        } = &.{},
        summary: ?[]const u8 = null,
    };

    const parsed_data = std.json.parseFromSliceLeaky(Schema, arena, cleaned_json, .{ .ignore_unknown_fields = true }) catch {
        return error.AiJsonSchemaError;
    };

    var result_items: std.ArrayList(VisionItem) = .empty;
    for (parsed_data.items) |it| {
        try result_items.append(arena, .{
            .name = it.name,
            .category = it.category orelse (if (std.ascii.indexOfIgnoreCase(location_hint, "fridge") != null) "fridge" else "pantry"),
            .quantity = it.quantity orelse 1.0,
            .fill_percentage = it.fill_percentage orelse 100.0,
            .unit = it.unit orelse "unit",
            .notes = it.notes orelse "",
        });
    }

    return .{
        .items = result_items.items,
        .summary = parsed_data.summary orelse "Inventory scan complete",
    };
}
