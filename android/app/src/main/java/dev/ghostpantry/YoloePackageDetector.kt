package dev.ghostpantry

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.os.Debug
import android.util.Log
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.security.MessageDigest
import java.util.zip.GZIPInputStream

/** Sequential CPU package and produce passes, merged before food matching. */
object YoloePackageDetector {
    private val environment by lazy { OrtEnvironment.getEnvironment() }

    // Parsed once per process; the asset never changes while the app runs.
    private var cachedContract: JSONObject? = null
    // Hashes of cached models whose SHA-256 was checked in this process.
    private val verifiedModels = mutableSetOf<String>()

    /** One model input reused by every tile of a scan, reallocated only when
        the padded input size changes (the whole photo and its tiles can differ
        by one stride after rounding). */
    private class Frame(val width: Int, val height: Int) {
        val bitmap: Bitmap = Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val pixels = IntArray(width*height)
        val buffer: FloatBuffer = ByteBuffer.allocateDirect(pixels.size*3*4).order(ByteOrder.nativeOrder()).asFloatBuffer()
    }

    private fun contract(context: Context): JSONObject {
        cachedContract?.let { return it }
        val parsed = context.assets.open("detectors/yoloe_packages.json").bufferedReader().use { JSONObject(it.readText()) }
        require(parsed.getInt("input_size") == 640 && parsed.getInt("stride") == 32 && parsed.getBoolean("dynamic_shape") && parsed.getDouble("tile_fraction") == .65)
        require(parsed.getJSONArray("profiles").length() == 3)
        cachedContract = parsed
        return parsed
    }

    @Synchronized
    fun detect(context: Context, bitmap: Bitmap, started: Long, threshold: Float): JSONObject {
        val contract = contract(context)
        val candidates = mutableListOf<YoloePackageMath.Box>()
        val produceCandidates = mutableListOf<YoloePackageMath.Box>()
        var loadMs = 0L
        var detectMs = 0L
        var peakPss = 0.0
        val profiles = contract.getJSONArray("profiles")
        val paint = Paint(Paint.FILTER_BITMAP_FLAG)
        val source = Rect()
        val target = RectF()
        var frame: Frame? = null
        try {
            for (index in 0..2) {
                val loading = System.nanoTime()
                val profile = profiles.getJSONObject(index)
                require(profile.getString("name") == when (index) { 0 -> "yoloe_packages_whole"; 1 -> "yoloe_packages_tiles"; else -> "yoloe_produce" })
                val promptsJson = profile.getJSONArray("prompts")
                val labels = (0 until promptsJson.length()).map { promptsJson.getString(it) }
                val model = unpack(context, profile)
                // Sessions are created per pass and closed before the next one on
                // purpose: keeping all three (plus their ORT arenas) alive next to
                // the 388 MB matching engine raises the resident peak on low-RAM
                // phones. The cost is the session load time, reported as load_ms.
                // (Caching them, released from the extension's onLifecycle on
                // memory pressure, is possible now; it needs peak-memory numbers
                // on a low-RAM phone first.)
                OrtSession.SessionOptions().use { options ->
                    options.setIntraOpNumThreads(4)
                    options.setInterOpNumThreads(1)
                    options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
                    environment.createSession(model.absolutePath, options).use { session ->
                        require(session.inputNames == setOf("images") && session.outputNames.contains("output0"))
                        loadMs += (System.nanoTime()-loading)/1_000_000
                        val detecting = System.nanoTime()
                        val whole = listOf(YoloePackageMath.Tile(0,0,bitmap.width,bitmap.height))
                        val tiles = when (index) { 0 -> whole; 1 -> YoloePackageMath.tiles(bitmap.width,bitmap.height); else -> whole + YoloePackageMath.tiles(bitmap.width,bitmap.height) }
                        val proposals = mutableListOf<YoloePackageMath.Box>()
                        for (tile in tiles) {
                            val geometry = YoloePackageMath.resize(tile.width,tile.height)
                            val current = frame?.takeIf { it.width == geometry.inputWidth && it.height == geometry.inputHeight }
                                ?: Frame(geometry.inputWidth,geometry.inputHeight).also { frame?.bitmap?.recycle(); frame = it }
                            // Scale the tile straight from the photo into the padded input:
                            // no per-tile crop or scaled bitmap.
                            current.bitmap.eraseColor(Color.rgb(114,114,114))
                            source.set(tile.x,tile.y,tile.x+tile.width,tile.y+tile.height)
                            target.set(geometry.left.toFloat(),geometry.top.toFloat(),(geometry.left+geometry.width).toFloat(),(geometry.top+geometry.height).toFloat())
                            current.canvas.drawBitmap(bitmap,source,target,paint)
                            current.bitmap.getPixels(current.pixels,0,current.width,0,0,current.width,current.height)
                            YoloePackageMath.normalize(current.pixels,current.buffer)
                            OnnxTensor.createTensor(environment,current.buffer,longArrayOf(1,3,current.height.toLong(),current.width.toLong())).use { tensor ->
                                session.run(mapOf("images" to tensor), setOf("output0")).use { result ->
                                    @Suppress("UNCHECKED_CAST")
                                    val channels = result.get("output0").orElseThrow { IllegalStateException("YOLOE output missing") }.value as Array<Array<FloatArray>>
                                    require(channels.size == 1)
                                    proposals.addAll(YoloePackageMath.decodeChannels(channels[0],labels,tile,bitmap.width,bitmap.height,if (index == 2) maxOf(threshold,.15f) else threshold))
                                }
                            }
                        }
                        // Same two-stage suppression and cap as the desktop candidate.
                        (if (index == 2) produceCandidates else candidates).addAll(YoloePackageMath.suppress(proposals,.5f))
                        detectMs += (System.nanoTime()-detecting)/1_000_000
                        val memory = Debug.MemoryInfo().also { Debug.getMemoryInfo(it) }
                        peakPss = maxOf(peakPss,memory.totalPss/1024.0)
                    }
                }
            }
        } finally { frame?.bitmap?.recycle() }
        val merging = System.nanoTime()
        val boxes = YoloePackageMath.mergePhases(candidates,produceCandidates,contract.getDouble("nms_iou").toFloat())
        detectMs += (System.nanoTime()-merging)/1_000_000
        val json = JSONArray()
        for (box in boxes) json.put(JSONObject().put("x",box.x.toDouble()).put("y",box.y.toDouble())
            .put("width",box.width.toDouble()).put("height",box.height.toDouble())
            .put("label",box.label).put("score",box.score.toDouble()))
        return JSONObject().put("boxes",json).put("detector","yoloe")
            .put("load_ms",loadMs).put("detect_ms",detectMs)
            .put("total_ms",(System.nanoTime()-started)/1_000_000).put("pss_mb",peakPss)
    }

    private fun unpack(context: Context, profile: JSONObject): File {
        val hash = profile.getString("onnx_sha256")
        val asset = profile.getString("file")
        require(hash.matches(Regex("[0-9a-f]{64}"))) { "Invalid YOLOE model checksum" }
        require(YoloePackageMath.isModelAsset(asset)) { "Unsupported YOLOE model asset: $asset" }
        val directory = File(context.cacheDir,"yoloe").apply { mkdirs() }
        val target = File(directory,"$hash.onnx")
        if (target.isFile && target.length() == profile.getLong("onnx_bytes")) {
            // ORT parses the model natively, so a cached file is hashed once per
            // process before it is trusted; a mismatch is unpacked again below.
            if (hash in verifiedModels || sha256(target) == hash) { verifiedModels.add(hash); return target }
            if (!target.delete()) Log.w("GhostPantryYoloe", "Corrupt cached model could not be deleted: ${target.name}")
        }
        val temporary = File(directory,"$hash.tmp")
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            GZIPInputStream(context.assets.open("detectors/$asset")).use { source ->
                temporary.outputStream().use { output ->
                    val buffer = ByteArray(64*1024)
                    var total = 0L
                    while (true) {
                        val count = source.read(buffer)
                        if (count < 0) break
                        total += count
                        require(total <= profile.getLong("onnx_bytes"))
                        digest.update(buffer,0,count)
                        output.write(buffer,0,count)
                    }
                }
            }
            require(temporary.length() == profile.getLong("onnx_bytes") && digest.digest().joinToString("") { "%02x".format(it) } == hash)
            require(temporary.renameTo(target))
            verifiedModels.add(hash)
            return target
        } finally { temporary.delete() }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { source ->
            val buffer = ByteArray(64*1024)
            while (true) {
                val count = source.read(buffer)
                if (count < 0) break
                digest.update(buffer,0,count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
