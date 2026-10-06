const std = @import("std");
const builtin = @import("builtin");
const oriel = @import("oriel");

pub const VisionItem = struct {
    name: []const u8,
    category: []const u8 = "pantry",
    quantity: f64 = 1.0,
    fill_percentage: f64 = 100.0,
    unit: []const u8 = "unit",
    notes: []const u8 = "",
};

pub const ScanTiming = struct {
    total_ms: u64,
    load_ms: u64 = 0,
    vision_ms: u64 = 0,
    generation_ms: u64 = 0,
    input_tokens: u32 = 0,
    output_tokens: u32 = 0,
};

pub const VisionResult = struct {
    items: []VisionItem,
    summary: []const u8,
    timing: ?ScanTiming = null,
};

pub const ModelItem = struct {
    id: []const u8,
    name: []const u8,
    vision: bool = false,
};

pub const AiConfig = struct {
    baseUrl: []const u8 = "https://api.openai.com/v1",
    apiKey: []const u8 = "",
    model: []const u8 = "gpt-4o-mini",
    temperature: f32 = 0.2,
};

pub var last_api_error: ?[]const u8 = null;

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

    const first_brace = std.mem.indexOfScalar(u8, trimmed, '{');
    const first_bracket = std.mem.indexOfScalar(u8, trimmed, '[');

    if (first_bracket != null and (first_brace == null or first_bracket.? < first_brace.?)) {
        const end_bracket = std.mem.lastIndexOfScalar(u8, trimmed, ']') orelse return trimmed;
        if (end_bracket >= first_bracket.?) {
            return trimmed[first_bracket.? .. end_bracket + 1];
        }
    } else if (first_brace != null) {
        const end_brace = std.mem.lastIndexOfScalar(u8, trimmed, '}') orelse return trimmed;
        if (end_brace >= first_brace.?) {
            return trimmed[first_brace.? .. end_brace + 1];
        }
    }
    return trimmed;
}

fn isVisionModel(name: []const u8) bool {
    var lower_buf: [256]u8 = undefined;
    const len = @min(name.len, lower_buf.len);
    const lower = std.ascii.lowerString(lower_buf[0..len], name[0..len]);
    return std.mem.indexOf(u8, lower, "vision") != null or
        std.mem.indexOf(u8, lower, "vl") != null or
        std.mem.indexOf(u8, lower, "4o") != null or
        std.mem.indexOf(u8, lower, "gemini") != null or
        std.mem.indexOf(u8, lower, "llava") != null or
        std.mem.indexOf(u8, lower, "clip") != null;
}

pub fn fetchAvailableModels(
    io: std.Io,
    gpa: std.mem.Allocator,
    arena: std.mem.Allocator,
    base_url: []const u8,
    api_key: ?[]const u8,
) ![]const ModelItem {
    const trimmed = std.mem.trim(u8, base_url, " /");
    const base = if (std.mem.endsWith(u8, trimmed, "/chat/completions"))
        trimmed[0 .. trimmed.len - "/chat/completions".len]
    else
        trimmed;

    const endpoint_url = if (std.mem.endsWith(u8, base, "/models"))
        try arena.dupe(u8, base)
    else
        try std.fmt.allocPrint(arena, "{s}/models", .{base});

    var client: std.http.Client = .{ .allocator = gpa, .io = io };
    defer client.deinit();

    // Android has no /etc/resolv.conf: open the connection through bionic's
    // resolver first (std.http.Client alone fails with NameServerFailure).
    if (builtin.abi.isAndroid()) {
        if (std.Uri.parse(endpoint_url)) |uri| {
            oriel.android.preconnect(&client, uri) catch {};
        } else |_| {}
    }

    const auth_header: ?[]const u8 = if (api_key) |k| (if (k.len > 0) try std.fmt.allocPrint(arena, "Bearer {s}", .{k}) else null) else null;

    var response_buffer: std.Io.Writer.Allocating = .init(arena);

    const res = client.fetch(.{
        .location = .{ .url = endpoint_url },
        .method = .GET,
        .keep_alive = false,
        .headers = .{
            .accept_encoding = .{ .override = "identity" },
            .authorization = if (auth_header) |auth| .{ .override = auth } else .default,
        },
        .response_writer = &response_buffer.writer,
    }) catch |err| {
        std.log.err("HTTP fetch error for models: {s}", .{@errorName(err)});
        return error.AiNetworkError;
    };

    if (res.status.class() != .success) {
        std.log.err("HTTP error status fetching models: {d}", .{@intFromEnum(res.status)});
        return error.AiApiError;
    }

    const resp_raw = response_buffer.written();
    var list: std.ArrayList(ModelItem) = .empty;

    const OpenAIModel = struct {
        id: ?[]const u8 = null,
        name: ?[]const u8 = null,
        display_name: ?[]const u8 = null,
        capabilities: ?struct {
            vision: ?bool = null,
            chat: ?bool = null,
        } = null,
    };
    const OpenAIResponse = struct { data: ?[]const OpenAIModel = null, models: ?[]const OpenAIModel = null };

    if (std.json.parseFromSliceLeaky(OpenAIResponse, arena, resp_raw, .{ .ignore_unknown_fields = true })) |parsed| {
        const raw_slice = parsed.data orelse parsed.models orelse &.{};
        for (raw_slice) |m| {
            const id = m.id orelse m.name orelse continue;
            const name = m.display_name orelse m.name orelse id;
            var is_vis = false;
            if (m.capabilities) |caps| {
                if (caps.vision) |v| {
                    is_vis = v;
                } else {
                    is_vis = isVisionModel(id) or isVisionModel(name);
                }
            } else {
                is_vis = isVisionModel(id) or isVisionModel(name);
            }
            try list.append(arena, .{
                .id = id,
                .name = name,
                .vision = is_vis,
            });
        }
    } else |_| {}

    return list.items;
}

fn extractErrorMessage(arena: std.mem.Allocator, raw: []const u8) ?[]const u8 {
    if (raw.len == 0) return null;
    const ErrSchema = struct {
        @"error": ?struct {
            message: ?[]const u8 = null,
        } = null,
    };
    if (std.json.parseFromSliceLeaky(ErrSchema, arena, raw, .{ .ignore_unknown_fields = true })) |parsed| {
        if (parsed.@"error") |err_obj| {
            if (err_obj.message) |msg| {
                // If message is itself JSON string:
                if (std.json.parseFromSliceLeaky(ErrSchema, arena, msg, .{ .ignore_unknown_fields = true })) |inner| {
                    if (inner.@"error") |inner_err| {
                        if (inner_err.message) |inner_msg| return inner_msg;
                    }
                } else |_| {}
                return msg;
            }
        }
    } else |_| {}
    return null;
}

pub fn analyzePantryImage(
    io: std.Io,
    gpa: std.mem.Allocator,
    arena: std.mem.Allocator,
    cfg: AiConfig,
    location_hint: []const u8,
    image_url_or_base64: []const u8,
) !VisionResult {
    last_api_error = null;
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

    // Android: open the connection through bionic's resolver first.
    if (builtin.abi.isAndroid()) {
        if (std.Uri.parse(endpoint_url)) |uri| {
            oriel.android.preconnect(&client, uri) catch {};
        } else |_| {}
    }

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

    const resp_raw = response_buffer.written();

    if (res.status.class() != .success) {
        std.log.err("HTTP error status: {d}, body: {s}", .{ @intFromEnum(res.status), resp_raw });
        if (extractErrorMessage(arena, resp_raw)) |msg| {
            last_api_error = msg;
        }
        return error.AiApiError;
    }

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
    return parseVisionContent(arena, ai_content, location_hint);
}

/// Parse a reply's JSON (or bare array) into a VisionResult; shared by the
/// OpenAI-compatible client and the local model runner. A reply cut off by
/// the token budget is salvaged down to its last complete item; identical
/// repeated items (a small model's repetition loop) merge into one with
/// their quantities summed. Nothing is parsed: an error, never raw model
/// text on the screen.
pub fn parseVisionContent(arena: std.mem.Allocator, ai_content: []const u8, location_hint: []const u8) !VisionResult {
    const cleaned = cleanJson(ai_content);

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

    var result_items: std.ArrayList(VisionItem) = .empty;
    var result_summary: []const u8 = "Inventory scanned successfully";
    var parsed_ok = false;

    for ([_][]const u8{ cleaned, salvageJson(arena, cleaned) orelse "" }) |candidate| {
        if (candidate.len == 0) continue;
        const parsed_data = std.json.parseFromSliceLeaky(Schema, arena, candidate, .{ .ignore_unknown_fields = true }) catch continue;
        for (parsed_data.items) |it| {
            appendMerged(&result_items, arena, .{
                .name = it.name,
                .category = it.category orelse location_hint,
                .quantity = it.quantity orelse 1.0,
                .fill_percentage = it.fill_percentage orelse 100.0,
                .unit = it.unit orelse "package",
                .notes = it.notes orelse "",
            }) catch return error.OutOfMemory;
        }
        if (parsed_data.summary) |s| result_summary = s;
        if (parsed_data.items.len > 0) {
            parsed_ok = true;
            break;
        }
    }

    if (!parsed_ok) {
        const RawArrayItem = struct {
            name: ?[]const u8 = null,
            label: ?[]const u8 = null,
            category: ?[]const u8 = null,
            quantity: ?f64 = null,
            fill_percentage: ?f64 = null,
            unit: ?[]const u8 = null,
            notes: ?[]const u8 = null,
        };
        for ([_][]const u8{ cleaned, salvageJson(arena, cleaned) orelse "" }) |candidate| {
            if (candidate.len == 0) continue;
            const arr = std.json.parseFromSliceLeaky([]const RawArrayItem, arena, candidate, .{ .ignore_unknown_fields = true }) catch continue;
            for (arr) |it| {
                const item_name = it.name orelse it.label orelse continue;
                appendMerged(&result_items, arena, .{
                    .name = item_name,
                    .category = it.category orelse location_hint,
                    .quantity = it.quantity orelse 1.0,
                    .fill_percentage = it.fill_percentage orelse 100.0,
                    .unit = it.unit orelse "units",
                    .notes = it.notes orelse "",
                }) catch return error.OutOfMemory;
            }
            if (result_items.items.len > 0) {
                result_summary = "Detected items list";
                parsed_ok = true;
                break;
            }
        }
    }

    if (!parsed_ok) return error.AiParseError;

    return .{
        .items = result_items.items,
        .summary = result_summary,
    };
}

/// Same item already listed (a repetition loop, or two passes over the same
/// shelf): merge into it instead of showing "Bread" ten times.
fn appendMerged(
    list: *std.ArrayList(VisionItem),
    arena: std.mem.Allocator,
    item: VisionItem,
) !void {
    var lower_buf: [128]u8 = undefined;
    const len = @min(item.name.len, lower_buf.len);
    const new_name = std.ascii.lowerString(lower_buf[0..len], item.name[0..len]);
    for (list.items) |*existing| {
        var existing_buf: [128]u8 = undefined;
        const elen = @min(existing.name.len, existing_buf.len);
        const existing_name = std.ascii.lowerString(existing_buf[0..elen], existing.name[0..elen]);
        if (std.mem.eql(u8, new_name, existing_name)) {
            existing.quantity += item.quantity;
            existing.fill_percentage = @max(existing.fill_percentage, item.fill_percentage);
            return;
        }
    }
    try list.append(arena, item);
}

/// A reply the token budget cut mid-array: close the last complete item and
/// the JSON around it, so the items detected before the cut are saved.
/// Null when nothing usable is closed.
fn salvageJson(arena: std.mem.Allocator, text: []const u8) ?[]const u8 {
    var in_string = false;
    var escaped = false;
    var depth: usize = 0; // { and [ together
    var last_item_close: ?usize = null; // after an item's `}` (depth 3 → 2)
    var last_array_close: ?usize = null; // after the items' `]` (depth 2 → 1)
    for (text, 0..) |ch, i| {
        if (in_string) {
            if (escaped) {
                escaped = false;
            } else if (ch == '\\') {
                escaped = true;
            } else if (ch == '"') {
                in_string = false;
            }
            continue;
        }
        switch (ch) {
            '"' => in_string = true,
            '{', '[' => depth += 1,
            '}', ']' => {
                if (depth == 0) return null; // not a truncated array
                depth -= 1;
                // `{"items":[…]}`: the reply object sits at depth 1, the
                // items array at 2, an item object at 3.
                if (depth == 2 and ch == '}') last_item_close = i + 1;
                if (depth == 1 and ch == ']') last_array_close = i + 1;
                if (depth == 0) return null; // the JSON was complete
            },
            else => {},
        }
    }
    // Cut at the last boundary and close what is open around the items.
    if (last_array_close) |at| {
        return std.fmt.allocPrint(arena, "{s}}}", .{text[0..at]}) catch null;
    }
    if (last_item_close) |at| {
        return std.fmt.allocPrint(arena, "{s}]}}", .{text[0..at]}) catch null;
    }
    return null;
}
