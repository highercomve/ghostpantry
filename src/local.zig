//! Local vision models ("On this device" in Settings), the GhostPantry
//! counterpart of GhostPen's built-in models: a small catalog of
//! vision-capable GGUF models downloaded from Hugging Face into the app's
//! models directory, and llama.cpp (+ mtmd for the image projector) running
//! in-process: the shelf photo and the pantry prompt go straight to the
//! model, the reply is a JSON object forced by a grammar, so a scan needs no
//! server at all.
//!
//! Tuning follows oriel's chat module: phones run on the CPU with small
//! compute buffers and read the weights into memory; desktops try the GPU
//! (Vulkan/CUDA/Metal through `oriel.ggml_gpu`) and fall back to the CPU;
//! the KV cache is q8_0 with flash attention where available, else f16, and
//! a failing context halves until it fits. The model stays resident between
//! scans (loading is the slow part) and unloads on memory pressure and in the
//! background (`oriel.lifecycle`, main.zig).

const std = @import("std");
const builtin = @import("builtin");
const oriel = @import("oriel");
const llama = oriel.llama;
const c = llama.c;
const ai_mod = @import("ai.zig");

const log = std.log.scoped(.local);
const is_phone = builtin.abi.isAndroid() or builtin.os.tag == .ios;

pub const DownloadEvent = struct {
    id: []const u8,
    /// downloading | verifying | done | error | cancelled
    state: []const u8,
    done_mb: u32 = 0,
    total_mb: u32 = 0,
};

fn emitDownload(id: []const u8, state: []const u8, done_mb: u32, total_mb: u32) void {
    oriel.App.emit("local_model_download", DownloadEvent{ .id = id, .state = state, .done_mb = done_mb, .total_mb = total_mb });
}

// ---------------------------------------------------------------------------
// Catalog

pub const Entry = struct {
    id: []const u8,
    /// For people: "Qwen2.5-VL 3B".
    label: []const u8,
    repo: []const u8,
    revision: []const u8 = "main",
    model_sha256: ?[]const u8 = null,
    projector_sha256: ?[]const u8 = null,
    file: []const u8,
    size: u64,
    /// The vision projector (mmproj) in the same repo: what reads images.
    projector: []const u8,
    /// Unique local name: different repos often call their projector mmproj-F16.gguf.
    projector_local: ?[]const u8 = null,
    projector_size: u64,
    /// Relative 1-5 scores for the UI.
    speed: u8,
    quality: u8,
    note: []const u8,
    /// Too big for a phone's memory: hidden there.
    desktop_only: bool = false,
};

/// Smallest first. Sizes, revisions and SHA-256s from Hugging Face's API
/// (checked 2026-10): every entry pins a commit, so a re-uploaded file can't
/// change under a hash; the desktop entries are GhostPen's catalog, proven
/// with mtmd.
pub const catalog = [_]Entry{
    .{ .id = "qwen3.5-0.8b", .label = "Qwen3.5 0.8B", .repo = "unsloth/Qwen3.5-0.8B-GGUF", .revision = "6ab461498e2023f6e3c1baea90a8f0fe38ab64d0", .model_sha256 = "bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517", .projector_sha256 = "56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453", .file = "Qwen3.5-0.8B-Q4_K_M.gguf", .size = 532517120, .projector = "mmproj-F16.gguf", .projector_local = "mmproj-qwen3.5-0.8b-F16.gguf", .projector_size = 204987232, .speed = 5, .quality = 1, .note = "smallest download; try simple shelves first; speed and accuracy need device testing" },
    .{ .id = "qwen2.5-vl-3b", .label = "Qwen2.5-VL 3B", .repo = "ggml-org/Qwen2.5-VL-3B-Instruct-GGUF", .revision = "5037fcf163dd95d1e41d1974465f0898ed108ca2", .model_sha256 = "d02fe9b69ad8cadbbd228e387667af66612c44bed29ffc8eb1e7caf9ac486c12", .projector_sha256 = "980c9b2f78c04e6cff93d277ada09e768394f112d75db3b4e9dea8a69f9fb904", .file = "Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf", .size = 1929901056, .projector = "mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf", .projector_size = 844757728, .speed = 3, .quality = 4, .note = "balanced vision; the phone pick" },
    .{ .id = "qwen3.5-2b", .label = "Qwen3.5 2B", .repo = "unsloth/Qwen3.5-2B-GGUF", .revision = "f6d5376be1edb4d416d56da11e5397a961aca8ae", .model_sha256 = "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223", .projector_sha256 = "7035e9cb8d7c6a9681d07eef9a364783e86ea4cd73faab2eabb4f43a101830c7", .file = "Qwen3.5-2B-Q4_K_M.gguf", .size = 1280835840, .projector = "mmproj-F16.gguf", .projector_local = "mmproj-qwen3.5-2b-F16.gguf", .projector_size = 668227264, .speed = 5, .quality = 2, .note = "lighter than 3B; speed depends on the device" },
    .{ .id = "gemma-3-4b-it", .label = "Gemma 3 4B", .repo = "ggml-org/gemma-3-4b-it-GGUF", .revision = "d0976223747697cb51e056d85c532013931fe52e", .model_sha256 = "882e8d2db44dc554fb0ea5077cb7e4bc49e7342a1f0da57901c0802ea21a0863", .projector_sha256 = "8c0fb064b019a6972856aaae2c7e4792858af3ca4561be2dbf649123ba6c40cb", .file = "gemma-3-4b-it-Q4_K_M.gguf", .size = 2489757856, .projector = "mmproj-model-f16.gguf", .projector_size = 851251104, .speed = 4, .quality = 3, .note = "good all-rounder, many languages", .desktop_only = true },
    .{ .id = "qwen3.5-4b", .label = "Qwen3.5 4B", .repo = "unsloth/Qwen3.5-4B-GGUF", .revision = "e87f176479d0855a907a41277aca2f8ee7a09523", .model_sha256 = "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4", .projector_sha256 = "cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864", .file = "Qwen3.5-4B-Q4_K_M.gguf", .size = 2740937888, .projector = "mmproj-F16.gguf", .projector_local = "mmproj-qwen3.5-4b-F16.gguf", .projector_size = 672423616, .speed = 4, .quality = 3, .note = "balanced", .desktop_only = true },
    .{ .id = "gemma-4-e4b-it", .label = "Gemma 4 E4B", .repo = "unsloth/gemma-4-E4B-it-GGUF", .revision = "bfc15c382204943c3a8fff0c750b94ae2364d7a3", .model_sha256 = "85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87", .projector_sha256 = "ddf46c21d7078e95338cfc22306b19b276a29a5ad089023449dd54d4b6170a51", .file = "gemma-4-E4B-it-Q4_K_M.gguf", .size = 4977171584, .projector = "mmproj-F16.gguf", .projector_local = "mmproj-gemma-4-e4b-it-F16.gguf", .projector_size = 990372672, .speed = 3, .quality = 4, .note = "recommended on desktops", .desktop_only = true },
    .{ .id = "qwen3.5-9b", .label = "Qwen3.5 9B", .repo = "unsloth/Qwen3.5-9B-GGUF", .revision = "3885219b6810b007914f3a7950a8d1b469d598a5", .model_sha256 = "6f5d30666c2d8ae16a306e616d95341dcf3cc46810df84d7e6f5a7d1e4c1b293", .projector_sha256 = "f70dc3509053962b0d0d3ee8a7eacebf5d60aa560cad78254ae8698516ae029f", .file = "Qwen3.5-9B-UD-Q4_K_XL.gguf", .size = 5966095584, .projector = "mmproj-F16.gguf", .projector_local = "mmproj-qwen3.5-9b-F16.gguf", .projector_size = 918166080, .speed = 2, .quality = 5, .note = "best quality; needs ~8 GB of GPU memory", .desktop_only = true },
};

pub const default_id = "qwen2.5-vl-3b";

/// The `catalog` this device offers: all on desktops, the small ones on
/// phones.
pub const device_catalog = blk: {
    var list: []const Entry = &.{};
    for (&catalog) |*e| if (!(is_phone and e.desktop_only)) {
        list = list ++ .{e.*};
    };
    break :blk list[0..list.len].*;
};

pub fn find(id: []const u8) ?Entry {
    for (&catalog) |e| if (std.mem.eql(u8, e.id, id)) return e;
    return null;
}

fn repoUrl(arena: std.mem.Allocator, repo: []const u8, revision: []const u8, file: []const u8) ![]const u8 {
    return std.fmt.allocPrint(arena, "https://huggingface.co/{s}/resolve/{s}/{s}", .{ repo, revision, file });
}

/// `<files dir>/models` on Android, `<data dir>/GhostPantry/models` elsewhere.
pub fn modelsDir(alloc: std.mem.Allocator) ![]const u8 {
    // Android: the app's files dir itself, where earlier releases kept it.
    // (store.dataDir is <filesDir>/<app id> there: moving would orphan data.)
    if (builtin.abi.isAndroid()) {
        if (oriel.android.paths.filesDir()) |fdir| {
            return try std.fs.path.join(alloc, &.{ fdir, "models" });
        }
    }
    const base = try oriel.store.dataDir(alloc, "GhostPantry");
    return try std.fs.path.join(alloc, &.{ base, "models" });
}

// ---------------------------------------------------------------------------
// State

var io: std.Io = undefined;
var gpa: std.mem.Allocator = undefined;
var initialized = false;

pub fn init(app_io: std.Io, app_gpa: std.mem.Allocator) void {
    io = app_io;
    gpa = app_gpa;
    llama.silenceLogs();
    initialized = true;
}

var mutex: std.Io.Mutex = .init;
/// Set last (release) by `ensureBackend`, under `mutex`: whoever sees it
/// true (acquire) also sees the names below, which never change after.
var backend_ready = std.atomic.Value(bool).init(false);
var backend_name: []const u8 = "CPU";
var gpu_name: ?[]const u8 = null;

var generating = std.atomic.Value(bool).init(false);
var cancelled = std.atomic.Value(bool).init(false);
var download_cancel = std.atomic.Value(bool).init(false);
var downloading_id: ?[]u8 = null;

/// The JSON schema a scan's reply must follow (the grammar).
const pantry_schema =
    \\{"type":"object","properties":{"items":{"type":"array","maxItems":20,"items":{"type":"object","properties":{"name":{"type":"string"},"category":{"type":"string","enum":["pantry","fridge","freezer","other"]},"quantity":{"type":"number"},"fill_percentage":{"type":"number"},"unit":{"type":"string"},"notes":{"type":"string"}},"required":["name","category","quantity","fill_percentage","unit","notes"]}},"summary":{"type":"string"}},"required":["items","summary"]}
;

const Loaded = struct {
    id: []u8,
    gpu: bool,
    requested_gpu: bool,
    fast: bool,
    handle: *c.llama_model,
    ctx: *c.llama_context,
    vision: ?*c.mtmd_context,
    threadpool: c.ggml_threadpool_t,
    n_ctx: u32,
    template: ?[]u8,
    load_ms: u64,

    fn deinit(self: *Loaded) void {
        if (self.vision) |v| c.mtmd_free(v);
        c.llama_free(self.ctx);
        c.ggml_threadpool_free(self.threadpool);
        c.llama_model_free(self.handle);
        gpa.free(self.id);
        if (self.template) |t| gpa.free(t);
    }
};
var loaded: ?Loaded = null;

/// Caller holds `mutex`, so only one thread ever initializes.
fn ensureBackend() void {
    if (backend_ready.load(.acquire)) return;
    c.llama_backend_init();
    if (oriel.ggml_gpu.load(io) > 0) {
        backend_name = oriel.ggml_gpu.backendName() orelse "GPU";
        gpu_name = oriel.ggml_gpu.gpuName();
    }
    log.info("llama backend: {s}{s}{s}", .{ backend_name, if (gpu_name != null) " on " else "", gpu_name orelse "" });
    backend_ready.store(true, .release);
}

fn threads() i32 {
    // Phones: the big cores (more threads land on the little ones and slow
    // it down). Desktops: every core, one thread per physical core on big CPUs.
    const cpus = std.Thread.getCpuCount() catch 4;
    if (is_phone) return @intCast(@min(cpus, 4));
    return @intCast(if (cpus >= 16) cpus / 2 else cpus);
}

/// Prompt tokens per decode call. Phones: smaller compute buffers.
const n_batch: u32 = if (is_phone) 512 else 2048;
/// The context a scan needs: the system prompt, ~1000-2500 image tokens and
/// the reply, with headroom.
const n_ctx_want: u32 = if (is_phone) 6144 else 8192;
const max_tokens: u32 = 2048;
/// The photo the page sends (like system_ai's cap): a phone camera JPEG is
/// a few MB, more is not a shelf photo.
const max_image_bytes: usize = 7 * 1024 * 1024;
/// Decoded pixels: a 50 MP bitmap is already ~150 MB of RGB.
const max_image_pixels: u64 = 50_000_000;

/// Load `e` (replacing another loaded model). `pref` is "auto", "gpu" or
/// "cpu" (the Settings → Processor choice). Caller holds `mutex`.
fn ensureLoaded(e: Entry, pref: []const u8, fast: bool) !u64 {
    ensureBackend();
    const requested_gpu = if (std.mem.eql(u8, pref, "cpu")) false else if (std.mem.eql(u8, pref, "gpu")) gpu_name != null else (!is_phone and gpu_name != null);
    const dir = try modelsDir(gpa);
    defer gpa.free(dir);
    const projector_path = try std.fs.path.joinZ(gpa, &.{ dir, e.projector_local orelse e.projector });
    defer gpa.free(projector_path);
    if (loaded) |*l| {
        if (std.mem.eql(u8, l.id, e.id) and l.requested_gpu == requested_gpu) {
            if (l.fast == fast) return 0;
            // Only the scan mode changed: its image token limits live in the
            // vision context. Keep the model and its context: re-reading
            // 2-3 GB on a phone is slow and invites a low-memory kill.
            return reloadVision(l, projector_path, fast);
        }
        l.deinit();
        loaded = null;
    }
    const model_path = try std.fs.path.joinZ(gpa, &.{ dir, e.file });
    defer gpa.free(model_path);
    const id = try gpa.dupe(u8, e.id);
    errdefer gpa.free(id);
    const t0 = std.Io.Clock.awake.now(io);

    // The Processor setting: "gpu" asks for the GPU (the CPU when there is
    // none), "cpu" always the CPU, "auto" the GPU on desktops and the CPU
    // on phones.
    var gpu = requested_gpu;
    const model = while (true) {
        var mp = c.llama_model_default_params();
        mp.n_gpu_layers = if (gpu) 999 else 0;
        var no_devices = [_]c.ggml_backend_dev_t{null};
        if (!gpu) {
            mp.devices = &no_devices;
            mp.no_host = true;
        }
        // Phones: read the weights into memory. Models live in the app's
        // external files directory, behind Android's FUSE layer, where a
        // mapped file the CPU reads every token is slow.
        if (is_phone) mp.load_mode = c.LLAMA_LOAD_MODE_NONE;
        if (llama.loadModel(model_path, mp)) |m| break m.handle else |err| {
            if (gpu and err != error.CpuUnsupported) {
                log.warn("cannot load {s} on the GPU ({s}): using the CPU", .{ e.id, @errorName(err) });
                gpu = false;
                continue;
            }
            log.err("cannot load {s}: {s}", .{ model_path, @errorName(err) });
            return err;
        }
    };
    errdefer c.llama_model_free(model);

    const vision = initVision(model, projector_path, gpu, fast, e.id);
    errdefer if (vision) |v| c.mtmd_free(v);

    // The context: capped at what the model was trained for; a q8_0 KV cache
    // (half the memory of f16) needs flash attention, else f16; out of
    // memory halves the context down to 2048 tokens.
    const trained: u32 = @intCast(@max(c.llama_model_n_ctx_train(model), 512));
    var ctx_size = @max(@min(n_ctx_want, trained), 512);
    var kv_q8 = true;
    const n_threads = threads();
    const ctx = while (true) {
        var cp = c.llama_context_default_params();
        cp.n_ctx = ctx_size;
        cp.n_batch = n_batch;
        cp.n_ubatch = 512;
        cp.n_threads = n_threads;
        cp.n_threads_batch = n_threads;
        cp.no_perf = true;
        cp.flash_attn_type = c.LLAMA_FLASH_ATTN_TYPE_AUTO;
        cp.type_k = if (kv_q8) c.GGML_TYPE_Q8_0 else c.GGML_TYPE_F16;
        cp.type_v = cp.type_k;
        cp.offload_kqv = gpu;
        cp.op_offload = gpu;
        cp.abort_callback = abortCallback;
        if (c.llama_init_from_model(model, cp)) |ctx| break ctx;
        if (kv_q8) {
            kv_q8 = false;
            continue;
        }
        if (ctx_size <= 2048) return error.ContextFailed;
        ctx_size = @max(ctx_size / 2, 2048);
        kv_q8 = true;
        log.warn("retrying with a {d}-token context", .{ctx_size});
    };
    errdefer c.llama_free(ctx);

    // A resident threadpool (what llama-server does): without one, ggml
    // spawns and joins its threads for every graph, once per token.
    var tpp = c.ggml_threadpool_params_default(n_threads);
    const tp = c.ggml_threadpool_new(&tpp) orelse return error.OutOfMemory;
    c.llama_attach_threadpool(ctx, tp, tp);
    errdefer {
        c.llama_detach_threadpool(ctx);
        c.ggml_threadpool_free(tp);
    }

    var template_copy: ?[]u8 = null;
    if (c.llama_model_chat_template(model, null)) |tmpl| {
        template_copy = try gpa.dupe(u8, std.mem.span(tmpl));
    }
    errdefer if (template_copy) |t| gpa.free(t);
    const load_ms: u64 = @intCast(@max(t0.durationTo(std.Io.Clock.awake.now(io)).toMilliseconds(), 0));
    // Nothing fails from here on: `loaded` owns everything.
    loaded = .{
        .id = id,
        .gpu = gpu,
        .requested_gpu = requested_gpu,
        .fast = fast,
        .handle = model,
        .ctx = ctx,
        .vision = vision,
        .threadpool = tp,
        .n_ctx = ctx_size,
        .template = template_copy,
        .load_ms = load_ms,
    };
    log.info("{s} on the {s}: {d}-token context, {s} KV cache, {d} threads, vision {s}", .{ e.id, if (gpu) "GPU" else "CPU", ctx_size, if (kv_q8) "q8_0" else "f16", n_threads, if (vision != null) "yes" else "no" });
    if (gpu) warmUp(&loaded.?);
    return load_ms;
}

/// The projector (the part that reads images), or null when it's missing or
/// unusable: scans then fail, the rest still works. `fast` caps the image
/// tokens (dynamic-resolution vision encoders; other models may ignore it).
fn initVision(model: *c.llama_model, projector_path: [:0]const u8, gpu: bool, fast: bool, id: []const u8) ?*c.mtmd_context {
    std.Io.Dir.cwd().access(io, projector_path, .{}) catch return null;
    var vp = c.mtmd_context_params_default();
    vp.use_gpu = gpu;
    vp.n_threads = threads();
    if (fast) {
        vp.image_min_tokens = 64;
        vp.image_max_tokens = 512;
    }
    return c.mtmd_init_from_file(projector_path.ptr, model, vp) orelse {
        log.warn("no vision projector for {s}: scans will fail, texts still work", .{id});
        return null;
    };
}

/// Swap only the vision context of `l` for one with `fast`'s image token
/// limits. The old one goes first: two projectors at once may not fit.
fn reloadVision(l: *Loaded, projector_path: [:0]const u8, fast: bool) u64 {
    const t0 = std.Io.Clock.awake.now(io);
    if (l.vision) |v| c.mtmd_free(v);
    l.vision = initVision(l.handle, projector_path, l.gpu, fast, l.id);
    l.fast = fast;
    const ms: u64 = @intCast(@max(t0.durationTo(std.Io.Clock.awake.now(io)).toMilliseconds(), 0));
    log.info("{s}: vision reloaded for {s} scans in {d} ms", .{ l.id, if (fast) "fast" else "balanced", ms });
    return ms;
}

fn abortCallback(_: ?*anyopaque) callconv(.c) bool {
    return cancelled.load(.acquire);
}

/// One untimed decode on the GPU: backends build pipelines on first use.
fn warmUp(l: *Loaded) void {
    const vocab = c.llama_model_get_vocab(l.handle);
    var toks: [16]c.llama_token = undefined;
    const n = c.llama_tokenize(vocab, "Hello, how are you?", 19, &toks, toks.len, true, false);
    if (n <= 0) return;
    const rc = c.llama_decode(l.ctx, c.llama_batch_get_one(&toks, n));
    if (rc != 0) log.warn("GPU warm-up decode failed ({d}): the first scan builds the pipelines", .{rc});
    c.llama_memory_clear(c.llama_get_memory(l.ctx), true);
}

// ---------------------------------------------------------------------------
// Status, download, delete, unload

pub const ModelStatus = struct {
    id: []const u8,
    label: []const u8,
    /// Megabytes of the model + projector together.
    mb: u32,
    projector_mb: u32,
    speed: u8,
    quality: u8,
    note: []const u8,
    /// Both files are on the device.
    present: bool,
    /// The model is there, the projector isn't (or the other way round).
    partial: bool,
    /// Bytes of an interrupted download.
    partial_mb: u32,
};

pub const Status = struct {
    backend: []const u8,
    gpu: ?[]const u8,
    models_dir: []const u8,
    supported: bool,
    models: []ModelStatus,
    loaded: ?[]const u8,
    loaded_gpu: bool = false,
    load_ms: u64 = 0,
    downloading: ?[]const u8,
    generating: bool,
};

pub fn status(arena: std.mem.Allocator) !Status {
    if (!initialized) return error.NotInitialized;
    // The models list is pure file system: no lock. A scan holds the state
    // mutex for minutes, so the loaded-model snapshot only happens when the
    // lock is free — the page's spinner must not wait for a scan.
    ensureBackendIfIdle();
    var models: std.ArrayList(ModelStatus) = .empty;
    const dir = try modelsDir(arena);
    for (device_catalog) |e| {
        const model_path = try std.fs.path.join(arena, &.{ dir, e.file });
        const projector_path = try std.fs.path.join(arena, &.{ dir, e.projector_local orelse e.projector });
        const part_path = try std.fmt.allocPrint(arena, "{s}.part", .{model_path});
        const has_model = filePresent(model_path);
        const has_projector = filePresent(projector_path);
        var partial_mb: u32 = 0;
        if (!has_model) {
            if (std.Io.Dir.cwd().statFile(io, part_path, .{})) |st| {
                partial_mb = @intCast(st.size >> 20);
            } else |_| {}
        }
        try models.append(arena, .{
            .id = e.id,
            .label = e.label,
            .mb = @intCast(e.size >> 20),
            .projector_mb = @intCast(e.projector_size >> 20),
            .speed = e.speed,
            .quality = e.quality,
            .note = e.note,
            .present = has_model and has_projector,
            .partial = has_model != has_projector,
            .partial_mb = partial_mb,
        });
    }
    // The loaded-model snapshot only when the lock is free; during a scan
    // the page just sees "no model loaded" for a moment.
    var loaded_id: ?[]const u8 = null;
    var loaded_gpu = false;
    var load_ms: u64 = 0;
    var dl_id: ?[]const u8 = null;
    if (mutex.tryLock()) {
        defer mutex.unlock(io);
        if (loaded) |l| {
            // Dupes: `loaded` can be freed (delete, a model switch) while
            // the page is still serializing this snapshot.
            loaded_id = arena.dupe(u8, l.id) catch null;
            loaded_gpu = l.gpu;
            load_ms = l.load_ms;
        }
        // Dupe: the download thread frees `downloading_id` exactly when the
        // "done" event makes the page call this.
        if (downloading_id) |d| dl_id = arena.dupe(u8, d) catch null;
    }
    // Unlocked: the names are only read once the backend published them.
    const ready = backend_ready.load(.acquire);
    return .{
        .backend = if (ready) backend_name else "CPU",
        .gpu = if (ready) gpu_name else null,
        .models_dir = dir,
        .supported = oriel.ggml_gpu.cpuSupported(),
        .models = models.items,
        .loaded = loaded_id,
        .loaded_gpu = loaded_gpu,
        .load_ms = load_ms,
        .downloading = dl_id,
        .generating = generating.load(.acquire),
    };
}

/// Backend init for read-only callers (status): only when nothing else may
/// hold the state mutex, so the page never waits for a scan.
fn ensureBackendIfIdle() void {
    if (backend_ready.load(.acquire)) return;
    if (generating.load(.acquire)) return;
    if (!mutex.tryLock()) return;
    defer mutex.unlock(io);
    ensureBackend();
}

fn filePresent(path: []const u8) bool {
    std.Io.Dir.cwd().access(io, path, .{}) catch return false;
    const st = std.Io.Dir.cwd().statFile(io, path, .{}) catch return false;
    return st.size > 1024 * 1024;
}

/// Fetch a catalog model (then its projector) from Hugging Face. Blocks:
/// call it from a worker. Progress goes out as `local_model_download`.
pub fn download(id: []const u8) !void {
    const e = find(id) orelse return error.UnknownModel;
    if (!initialized) return error.NotInitialized;
    {
        mutex.lockUncancelable(io);
        defer mutex.unlock(io);
        if (downloading_id != null) return error.AlreadyDownloading;
        downloading_id = gpa.dupe(u8, id) catch return error.OutOfMemory;
    }
    defer {
        mutex.lockUncancelable(io);
        defer mutex.unlock(io);
        if (downloading_id) |d| {
            gpa.free(d);
            downloading_id = null;
        }
    }
    download_cancel.store(false, .release);
    const dir = try modelsDir(gpa);
    defer gpa.free(dir);

    const model_path = try std.fs.path.join(gpa, &.{ dir, e.file });
    defer gpa.free(model_path);
    if (!filePresent(model_path)) {
        const url = try repoUrl(gpa, e.repo, e.revision, e.file);
        defer gpa.free(url);
        try fetchFile(e, e.file, url, e.size);
    }
    const projector_path = try std.fs.path.join(gpa, &.{ dir, e.projector_local orelse e.projector });
    defer gpa.free(projector_path);
    if (!filePresent(projector_path)) {
        const url = try repoUrl(gpa, e.repo, e.revision, e.projector);
        defer gpa.free(url);
        try fetchFile(e, e.projector_local orelse e.projector, url, e.projector_size);
    }
    emitDownload(id, "done", @intCast((e.size + e.projector_size) >> 20), @intCast((e.size + e.projector_size) >> 20));
}

fn errSend(id: []const u8, err: anyerror) void {
    const state = switch (err) {
        error.Cancelled => "cancelled",
        else => "error",
    };
    emitDownload(id, state, 0, 0);
}

/// One file into `<models dir>/<name>`: resumed through a `.part`, hashed
/// while writing (Hugging Face publishes the SHA-256) and renamed. The
/// total is known, so progress is exact.
fn fetchFile(e: Entry, name: []const u8, url: []const u8, expected: u64) !void {
    // A server that ignores the range restarts once, from byte 0: that
    // attempt asks for no range, so it can't be ignored again.
    for (0..2) |_| if (try fetchAttempt(e, name, url, expected)) return;
    return error.BadHttpStatus;
}

/// Delete `path`; a missing file is fine, anything else is logged.
fn deleteIfPresent(path: []const u8) void {
    std.Io.Dir.cwd().deleteFile(io, path) catch |err| switch (err) {
        error.FileNotFound => {},
        else => log.warn("cannot delete {s}: {s}", .{ path, @errorName(err) }),
    };
}

/// One try of `fetchFile`: false when the server ignored the range of a
/// resume (the `.part` is gone then; try again).
fn fetchAttempt(e: Entry, name: []const u8, url: []const u8, expected: u64) !bool {
    const dir_path = try modelsDir(gpa);
    defer gpa.free(dir_path);
    // The models directory doesn't exist yet on a fresh device.
    std.Io.Dir.cwd().createDirPath(io, dir_path) catch |err| log.warn("cannot create {s}: {s}", .{ dir_path, @errorName(err) });
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const final = try std.fs.path.join(arena, &.{ dir_path, name });
    const part = try std.fmt.allocPrint(arena, "{s}.part", .{final});
    const total_mb: u32 = @intCast(expected >> 20);
    var hasher: std.crypto.hash.sha2.Sha256 = .init(.{});
    var have: u64 = 0;

    // Resume: hash what a previous attempt left, then ask for the rest.
    if (std.Io.Dir.cwd().openFile(io, part, .{})) |f| {
        defer f.close(io);
        var rbuf: [256 * 1024]u8 = undefined;
        var r = f.reader(io, &rbuf);
        emitDownload(e.id, "verifying", 0, total_mb);
        while (true) {
            if (download_cancel.load(.acquire)) return error.Cancelled;
            const chunk = r.interface.peekGreedy(1) catch break;
            hasher.update(chunk);
            have += chunk.len;
            r.interface.toss(chunk.len);
        }
        if (have >= expected) {
            deleteIfPresent(part);
            hasher = .init(.{});
            have = 0;
        }
    } else |_| {}

    var file = if (have > 0)
        try std.Io.Dir.cwd().openFile(io, part, .{ .mode = .write_only })
    else
        try std.Io.Dir.cwd().createFile(io, part, .{});
    var closed = false;
    defer if (!closed) file.close(io);

    // Hugging Face redirects to its CDN; each host needs Android's resolver.
    var client: std.http.Client = .{ .allocator = gpa, .io = io };
    defer client.deinit();
    var url_bufs: [2][8 * 1024]u8 = undefined;
    var redirect_buf: [16 * 1024]u8 = undefined;
    var uri = try std.Uri.parse(url);
    var req: std.http.Client.Request = undefined;
    var response: std.http.Client.Response = undefined;
    var hops: u8 = 0;
    while (true) : (hops += 1) {
        if (hops == 6) return error.TooManyHttpRedirects;
        if (builtin.abi.isAndroid()) try oriel.android.preconnect(&client, uri);
        var range_buf: [64]u8 = undefined;
        const extra_headers: []const std.http.Header = if (have > 0) blk: {
            const range = try std.fmt.bufPrint(&range_buf, "bytes={d}-", .{have});
            break :blk &.{.{ .name = "Range", .value = range }};
        } else &.{};
        req = try client.request(.GET, uri, .{
            .headers = .{
                // Byte ranges of the file itself, never of a compressed body.
                .accept_encoding = .{ .override = "identity" },
            },
            .extra_headers = extra_headers,
            .redirect_behavior = .unhandled,
        });
        errdefer req.deinit();
        try req.sendBodiless();
        response = try req.receiveHead(&redirect_buf);
        if (response.head.status.class() != .redirect) break;
        const location = response.head.location orelse return error.HttpRedirectLocationMissing;
        const rbuf = &url_bufs[hops % 2];
        if (location.len > rbuf.len) return error.HttpRedirectLocationOversize;
        @memcpy(rbuf[0..location.len], location);
        var aux: []u8 = rbuf;
        uri = try uri.resolveInPlace(location.len, &aux);
        req.deinit();
    }
    defer req.deinit();
    if (have > 0) {
        // The server ignored the range: start over.
        if (response.head.status == .ok) {
            file.close(io);
            closed = true;
            deleteIfPresent(part);
            return false;
        }
        if (response.head.status != .partial_content) return error.BadHttpStatus;
        var start: ?u64 = null;
        var it = response.head.iterateHeaders();
        while (it.next()) |h| {
            if (std.ascii.eqlIgnoreCase(h.name, "content-range")) start = rangeStart(h.value);
        }
        if (start != have) return error.BadHttpStatus;
    } else if (response.head.status != .ok) return error.BadHttpStatus;

    var transfer_buf: [64 * 1024]u8 = undefined;
    const reader = response.reader(&transfer_buf);
    var chunk: [64 * 1024]u8 = undefined;
    var done = have;
    var last_mb: u64 = done >> 20;
    while (true) {
        if (download_cancel.load(.acquire)) return error.Cancelled;
        const n = reader.readSliceShort(&chunk) catch |err| switch (err) {
            error.ReadFailed => return response.bodyErr() orelse error.ReadFailed,
        };
        if (n == 0) break;
        hasher.update(chunk[0..n]);
        file.writePositionalAll(io, chunk[0..n], done) catch return error.WriteFailed;
        done += n;
        if (done >> 20 != last_mb) {
            last_mb = done >> 20;
            emitDownload(e.id, "downloading", @intCast(last_mb), total_mb);
            if (done > expected) return error.Truncated;
        }
    }
    file.close(io);
    closed = true;
    if (done != expected) return error.Truncated;
    var digest: [32]u8 = undefined;
    hasher.final(&digest);
    const expected_hash = if (std.mem.eql(u8, name, e.file)) e.model_sha256 else e.projector_sha256;
    if (expected_hash) |hex| {
        var wanted: [32]u8 = undefined;
        _ = try std.fmt.hexToBytes(&wanted, hex);
        if (!std.mem.eql(u8, &digest, &wanted)) {
            deleteIfPresent(part);
            return error.HashMismatch;
        }
    }
    try std.Io.Dir.cwd().rename(part, std.Io.Dir.cwd(), final, io);
    log.info("downloaded {s} ({d} MB)", .{ name, done >> 20 });
    return true;
}

/// `bytes 100-199/200` → 100.
fn rangeStart(value: []const u8) ?u64 {
    const v = std.mem.trim(u8, value, " ");
    if (!std.mem.startsWith(u8, v, "bytes ")) return null;
    const rest = v["bytes ".len..];
    const dash = std.mem.indexOfScalar(u8, rest, '-') orelse return null;
    return std.fmt.parseInt(u64, rest[0..dash], 10) catch null;
}

pub fn cancelDownload() void {
    download_cancel.store(true, .release);
}

/// Delete a model and its projector (unloading it first).
pub fn delete(id: []const u8) !void {
    const e = find(id) orelse return error.UnknownModel;
    if (!initialized) return error.NotInitialized;
    mutex.lockUncancelable(io);
    defer mutex.unlock(io);
    if (downloading_id) |d| if (std.mem.eql(u8, d, id)) return error.Downloading;
    if (generating.load(.acquire)) return error.Generating;
    if (loaded) |*l| if (std.mem.eql(u8, l.id, id)) {
        l.deinit();
        loaded = null;
    };
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const dir = try modelsDir(arena);
    const model_path = try std.fs.path.join(arena, &.{ dir, e.file });
    const projector_path = try std.fs.path.join(arena, &.{ dir, e.projector_local orelse e.projector });
    deleteIfPresent(model_path);
    deleteIfPresent(try std.fmt.allocPrint(arena, "{s}.part", .{model_path}));
    deleteIfPresent(projector_path);
    deleteIfPresent(try std.fmt.allocPrint(arena, "{s}.part", .{projector_path}));
}

/// Free the model (memory pressure; the next scan loads it again). Safe on
/// the main thread: returns at once while it is generating or loading.
pub fn unloadIdle() void {
    if (!initialized) return;
    if (generating.load(.acquire)) return;
    if (!mutex.tryLock()) return;
    defer mutex.unlock(io);
    if (loaded) |*l| {
        l.deinit();
        loaded = null;
        log.info("memory pressure: unloaded the local model", .{});
    }
}

pub fn unload() void {
    if (!initialized) return;
    if (generating.load(.acquire)) return;
    mutex.lockUncancelable(io);
    defer mutex.unlock(io);
    if (loaded) |*l| {
        l.deinit();
        loaded = null;
    }
}

/// Load a model so the next scan starts instantly (Settings' Test button).
/// Blocks: call it from a worker.
pub fn testLoad(id: []const u8, backend_pref: []const u8, fast: bool) !LoadInfo {
    const e = find(id) orelse return error.UnknownModel;
    if (!initialized) return error.NotInitialized;
    {
        mutex.lockUncancelable(io);
        defer mutex.unlock(io);
        if (downloading_id != null) return error.Downloading;
    }
    if (generating.load(.acquire)) return error.Generating;
    mutex.lockUncancelable(io);
    defer mutex.unlock(io);
    const ms = try ensureLoaded(e, backend_pref, fast);
    const l = &loaded.?;
    return .{
        .backend = backend_name,
        .gpu = if (l.gpu) gpu_name else null,
        .ctx = l.n_ctx,
        .vision = l.vision != null,
        .load_ms = ms,
    };
}

pub const LoadInfo = struct {
    backend: []const u8,
    gpu: ?[]const u8,
    ctx: u32,
    vision: bool,
    load_ms: u64,
};

// ---------------------------------------------------------------------------
// A scan

pub fn analyze(
    arena: std.mem.Allocator,
    model_id: []const u8,
    backend_pref: []const u8,
    fast: bool,
    location_hint: []const u8,
    image_data_url: []const u8,
) !ai_mod.VisionResult {
    if (!initialized) return error.NotInitialized;
    const started = std.Io.Clock.awake.now(io);
    const e = find(model_id) orelse return error.UnknownModel;
    if (generating.swap(true, .acq_rel)) return error.Busy;
    defer generating.store(false, .release);
    cancelled.store(false, .release);

    mutex.lockUncancelable(io);
    defer mutex.unlock(io);
    const load_ms = try ensureLoaded(e, backend_pref, fast);
    const vision_started = std.Io.Clock.awake.now(io);
    const l = &loaded.?;
    const vocab = c.llama_model_get_vocab(l.handle) orelse return error.NoVocab;
    const n_ctx: usize = c.llama_n_ctx(l.ctx);
    const vision = l.vision orelse return error.NoVisionProjector;

    // The image: a data URL from the page ("data:image/jpeg;base64,…").
    const prefix = std.mem.indexOf(u8, image_data_url, ";base64,") orelse return error.BadImageData;
    const b64 = image_data_url[prefix + ";base64,".len ..];
    const decoder = std.base64.standard.Decoder;
    const size = decoder.calcSizeForSlice(b64) catch return error.BadImageData;
    if (size > max_image_bytes) return error.ImageTooLarge;
    const bytes = arena.alloc(u8, size) catch return error.OutOfMemory;
    decoder.decode(bytes, b64) catch return error.BadImageData;

    // The vision path places its own tokens: nothing to reuse.
    c.llama_memory_clear(c.llama_get_memory(l.ctx), true);
    const wrapped = c.mtmd_helper_bitmap_init_from_buf(vision, bytes.ptr, bytes.len, false, c.mtmd_helper_init_opt_default());
    const bitmap = wrapped.bitmap orelse return error.BadImageData;
    defer c.mtmd_bitmap_free(bitmap);
    const pixels = @as(u64, c.mtmd_bitmap_get_nx(bitmap)) * c.mtmd_bitmap_get_ny(bitmap);
    if (pixels > max_image_pixels) return error.ImageTooLarge;

    const user_prompt = try std.fmt.allocPrint(arena, "{s}\nAnalyze this photo of the {s}. List all visible food items with their quantities and estimated remaining fill percentages.", .{ std.mem.span(c.mtmd_default_marker()), location_hint });
    const system_prompt = if (fast) ai_mod.pantry_vision_system_prompt ++ "\nReturn at most 12 visible items. Use empty notes and a very short summary. /no_think" else ai_mod.pantry_vision_system_prompt;
    const prompt_text = try applyTemplate(arena, l.template, system_prompt, user_prompt);
    const text_z = try arena.dupeZ(u8, prompt_text);
    const input: c.mtmd_input_text = .{ .text = text_z.ptr, .text_len = prompt_text.len, .add_special = true, .parse_special = true };
    const chunks = c.mtmd_input_chunks_init() orelse return error.OutOfMemory;
    defer c.mtmd_input_chunks_free(chunks);
    const bitmaps = [_]?*const c.mtmd_bitmap{bitmap};
    const trc = c.mtmd_tokenize(vision, chunks, &input, @ptrCast(&bitmaps), bitmaps.len);
    if (trc != 0) return error.VisionTokenize;
    const n_prompt: usize = @intCast(c.mtmd_helper_get_n_tokens(chunks));
    if (n_prompt + 16 > n_ctx) return error.ImageTooLarge;
    var n_past: c.llama_pos = 0;
    const rc = c.mtmd_helper_eval_chunks(vision, l.ctx, chunks, 0, 0, 512, true, &n_past);
    if (cancelled.load(.acquire)) return error.Cancelled;
    if (rc != 0) return error.VisionEval;
    const generation_started = std.Io.Clock.awake.now(io);

    // The reply: JSON, forced by the schema's grammar from the first token.
    const chain = c.llama_sampler_chain_init(c.llama_sampler_chain_default_params()) orelse return error.OutOfMemory;
    defer c.llama_sampler_free(chain);
    c.llama_sampler_chain_add(chain, c.llama_sampler_init_penalties(c.llama_vocab_n_tokens(vocab), 64, 1.05, 0, 0));
    c.llama_sampler_chain_add(chain, c.llama_sampler_init_top_k(40));
    c.llama_sampler_chain_add(chain, c.llama_sampler_init_top_p(0.95, 1));
    c.llama_sampler_chain_add(chain, c.llama_sampler_init_min_p(0.05, 1));
    c.llama_sampler_chain_add(chain, c.llama_sampler_init_temp(0.2));
    c.llama_sampler_chain_add(chain, c.llama_sampler_init_dist(0));

    var why: ?[]u8 = null;
    const gbnf = llama.jsonSchemaToGrammar(arena, pantry_schema, &why) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => {
            log.warn("unconstrained answer: the JSON schema isn't usable: {s}", .{why orelse "invalid"});
            return error.BadSchema;
        },
    };
    const grammar = c.llama_sampler_init_grammar(vocab, gbnf.ptr, "root") orelse return error.BadSchema;
    defer c.llama_sampler_free(grammar);
    const candidates = arena.alloc(c.llama_token_data, @intCast(c.llama_vocab_n_tokens(vocab))) catch return error.OutOfMemory;

    var out: std.ArrayList(u8) = .empty;
    const budget = @min(@as(usize, if (fast) 1024 else max_tokens), n_ctx - n_prompt);
    var generated: usize = 0;
    while (generated < budget) {
        if (cancelled.load(.acquire)) return error.Cancelled;
        var tok = try sampleWithGrammar(l.ctx, chain, grammar, candidates);
        if (c.llama_vocab_is_eog(vocab, tok)) break;
        generated += 1;
        var piece: [256]u8 = undefined;
        const n = c.llama_token_to_piece(vocab, tok, &piece, piece.len, 0, true);
        if (n > 0) {
            out.appendSlice(arena, piece[0..@intCast(n)]) catch return error.OutOfMemory;
        } else if (n < 0) {
            const big = arena.alloc(u8, @intCast(-n)) catch return error.OutOfMemory;
            const m = c.llama_token_to_piece(vocab, tok, big.ptr, @intCast(big.len), 0, true);
            if (m > 0) out.appendSlice(arena, big[0..@intCast(m)]) catch return error.OutOfMemory;
        }
        const dec = c.llama_decode(l.ctx, c.llama_batch_get_one(&tok, 1));
        if (dec != 0) {
            if (cancelled.load(.acquire)) return error.Cancelled;
            return error.GenerateFailed;
        }
    }
    if (out.items.len == 0) return error.EmptyResponse;

    var parsed = ai_mod.parseVisionContent(arena, out.items, location_hint) catch return error.BadResponse;
    const finished = std.Io.Clock.awake.now(io);
    parsed.timing = .{
        .total_ms = @intCast(@max(started.durationTo(finished).toMilliseconds(), 0)),
        .load_ms = load_ms,
        .vision_ms = @intCast(@max(vision_started.durationTo(generation_started).toMilliseconds(), 0)),
        .generation_ms = @intCast(@max(generation_started.durationTo(finished).toMilliseconds(), 0)),
        .input_tokens = @intCast(n_prompt),
        .output_tokens = @intCast(generated),
    };
    log.info("scan timing: total {d} ms, load {d} ms, vision {d} ms, generation {d} ms; {d} input, {d} output tokens", .{ parsed.timing.?.total_ms, load_ms, parsed.timing.?.vision_ms, parsed.timing.?.generation_ms, n_prompt, generated });
    return parsed;
}

/// The next token under `grammar`: drawn from the usual chain and only
/// checked against the grammar; only when it's rejected does the grammar
/// filter the whole vocabulary before drawing again. Missing or NaN logits,
/// or no allowed token, end the scan with an error: only a token both
/// samplers can take is accepted.
fn sampleWithGrammar(
    ctx: *c.llama_context,
    chain: *c.llama_sampler,
    grammar: *c.llama_sampler,
    candidates: []c.llama_token_data,
) !c.llama_token {
    const logits = c.llama_get_logits_ith(ctx, -1);
    if (logits == null) return error.NoLogits;
    try fillCandidates(candidates, logits);
    var all: c.llama_token_data_array = .{ .data = candidates.ptr, .size = candidates.len, .selected = -1, .sorted = false };
    c.llama_sampler_apply(chain, &all);
    var tok = selectedToken(all) orelse return error.NoTokenSampled;

    var one = [1]c.llama_token_data{.{ .id = tok, .logit = 1, .p = 0 }};
    var single: c.llama_token_data_array = .{ .data = &one, .size = 1, .selected = -1, .sorted = false };
    c.llama_sampler_apply(grammar, &single);
    if (!std.math.isFinite(one[0].logit)) {
        try fillCandidates(candidates, logits);
        all = .{ .data = candidates.ptr, .size = candidates.len, .selected = -1, .sorted = false };
        c.llama_sampler_apply(grammar, &all);
        c.llama_sampler_apply(chain, &all);
        // Every token the grammar rejected is -inf: a -inf pick means none was allowed.
        tok = selectedToken(all) orelse return error.GrammarRejected;
    }
    c.llama_sampler_accept(grammar, tok);
    c.llama_sampler_accept(chain, tok);
    return tok;
}

/// The vocabulary with this step's logits. A NaN (or +inf) logit is a
/// broken step: refused before it reaches the samplers.
fn fillCandidates(candidates: []c.llama_token_data, logits: [*c]const f32) !void {
    for (candidates, 0..) |*cd, i| {
        const v = logits[i];
        if (std.math.isNan(v) or std.math.isPositiveInf(v)) return error.BadLogits;
        cd.* = .{ .id = @intCast(i), .logit = v, .p = 0 };
    }
}

/// The sampled token, or null when nothing was selected or the pick has a
/// non-finite logit.
fn selectedToken(all: c.llama_token_data_array) ?c.llama_token {
    if (all.selected < 0 or all.selected >= all.size) return null;
    const cd = all.data[@intCast(all.selected)];
    if (!std.math.isFinite(cd.logit)) return null;
    return cd.id;
}

/// The model's own chat template (from its GGUF), else ChatML.
fn applyTemplate(arena: std.mem.Allocator, template: ?[]const u8, system: []const u8, user: []const u8) ![]const u8 {
    const msgs = [_]c.llama_chat_message{
        .{ .role = "system", .content = (try arena.dupeZ(u8, system)).ptr },
        .{ .role = "user", .content = (try arena.dupeZ(u8, user)).ptr },
    };
    const tmpl: ?[*:0]const u8 = if (template) |t| (try arena.dupeZ(u8, t)).ptr else null;
    var cap: usize = (system.len + user.len) * 2 + 512;
    // A first guess, then the exact size the template reported.
    for (0..2) |_| {
        const buf = try arena.alloc(u8, cap);
        var n = c.llama_chat_apply_template(tmpl, &msgs, msgs.len, true, buf.ptr, @intCast(cap));
        if (n < 0 and tmpl != null) n = c.llama_chat_apply_template("chatml", &msgs, msgs.len, true, buf.ptr, @intCast(cap));
        if (n < 0) return error.UnsupportedChatTemplate;
        if (@as(usize, @intCast(n)) <= cap) return buf[0..@intCast(n)];
        cap = @intCast(n);
    }
    return error.UnsupportedChatTemplate;
}
