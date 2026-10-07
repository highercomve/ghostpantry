package dev.ghostpantry

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Debug
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.zip.GZIPInputStream

/** CPU package proposals, whole-photo specific prompts + four material-prompt tiles. */
object YoloePackageDetector {
    private val environment by lazy { OrtEnvironment.getEnvironment() }

    @Synchronized
    fun detect(context: Context, bitmap: Bitmap, started: Long, threshold: Float): JSONObject {
        val contract = context.assets.open("detectors/yoloe_packages.json").bufferedReader().use { JSONObject(it.readText()) }
        require(contract.getInt("input_size") == 640 && contract.getInt("stride") == 32 && contract.getBoolean("dynamic_shape") && contract.getDouble("tile_fraction") == .65)
        val candidates = mutableListOf<PackageDetectionMath.Box>()
        var loadMs = 0L
        var detectMs = 0L
        var peakPss = 0.0
        val profiles = contract.getJSONArray("profiles")
        require(profiles.length() == 2)
        for (index in 0..1) {
            val loading = System.nanoTime()
            val profile = profiles.getJSONObject(index)
            require(profile.getString("name") == if (index == 0) "yoloe_packages_whole" else "yoloe_packages_tiles")
            val promptsJson = profile.getJSONArray("prompts")
            val labels = (0 until promptsJson.length()).map { promptsJson.getString(it) }
            val model = unpack(context, profile)
            OrtSession.SessionOptions().use { options ->
                options.setIntraOpNumThreads(4)
                options.setInterOpNumThreads(1)
                options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
                environment.createSession(model.absolutePath, options).use { session ->
                    require(session.inputNames == setOf("images") && session.outputNames.contains("output0"))
                    loadMs += (System.nanoTime()-loading)/1_000_000
                    val detecting = System.nanoTime()
                    val tiles = if (index == 0) listOf(YoloePackageMath.Tile(0,0,bitmap.width,bitmap.height))
                        else YoloePackageMath.tiles(bitmap.width,bitmap.height)
                    val proposals = mutableListOf<PackageDetectionMath.Box>()
                    for (tile in tiles) {
                        val crop = Bitmap.createBitmap(bitmap,tile.x,tile.y,tile.width,tile.height)
                        try {
                            val geometry = YoloePackageMath.resize(crop.width,crop.height)
                            val scaled = Bitmap.createScaledBitmap(crop,geometry.width,geometry.height,true)
                            val input = Bitmap.createBitmap(geometry.inputWidth,geometry.inputHeight,Bitmap.Config.ARGB_8888)
                            try {
                                input.eraseColor(Color.rgb(114,114,114))
                                Canvas(input).drawBitmap(scaled,geometry.left.toFloat(),geometry.top.toFloat(),null)
                                val pixels = IntArray(input.width*input.height)
                                input.getPixels(pixels,0,input.width,0,0,input.width,input.height)
                                val buffer = ByteBuffer.allocateDirect(pixels.size*3*4).order(ByteOrder.nativeOrder()).asFloatBuffer()
                                YoloePackageMath.normalize(pixels,buffer)
                                OnnxTensor.createTensor(environment,buffer,longArrayOf(1,3,input.height.toLong(),input.width.toLong())).use { tensor ->
                                    session.run(mapOf("images" to tensor), setOf("output0")).use { result ->
                                        @Suppress("UNCHECKED_CAST")
                                        val channels = result.get("output0").orElseThrow { IllegalStateException("YOLOE output missing") }.value as Array<Array<FloatArray>>
                                        require(channels.size == 1)
                                        proposals.addAll(YoloePackageMath.decodeChannels(channels[0],labels,tile,bitmap.width,bitmap.height,threshold))
                                    }
                                }
                            } finally {
                                input.recycle()
                                if (scaled !== crop) scaled.recycle()
                            }
                        } finally { if (crop !== bitmap) crop.recycle() }
                    }
                    // Same two-stage suppression and cap as the desktop candidate.
                    candidates.addAll(YoloePackageMath.suppress(proposals,.5f))
                    detectMs += (System.nanoTime()-detecting)/1_000_000
                    val memory = Debug.MemoryInfo().also { Debug.getMemoryInfo(it) }
                    peakPss = maxOf(peakPss,memory.totalPss/1024.0)
                }
            }
        }
        val merging = System.nanoTime()
        val boxes = YoloePackageMath.suppress(candidates,contract.getDouble("nms_iou").toFloat())
        detectMs += (System.nanoTime()-merging)/1_000_000
        val json = JSONArray()
        for (box in boxes) json.put(JSONObject().put("x",box.x.toDouble()).put("y",box.y.toDouble())
            .put("width",box.width.toDouble()).put("height",box.height.toDouble())
            .put("label",box.label).put("score",box.score.toDouble()))
        return JSONObject().put("boxes",json).put("detector","yoloe_packages")
            .put("load_ms",loadMs).put("detect_ms",detectMs)
            .put("total_ms",(System.nanoTime()-started)/1_000_000).put("pss_mb",peakPss)
    }

    private fun unpack(context: Context, profile: JSONObject): File {
        val hash = profile.getString("onnx_sha256")
        val asset = profile.getString("file")
        require(hash.matches(Regex("[0-9a-f]{64}")) && asset.matches(Regex("yoloe_packages_(whole|tiles)\\.onnx\\.bin")))
        val directory = File(context.cacheDir,"yoloe").apply { mkdirs() }
        val target = File(directory,"$hash.onnx")
        if (target.isFile && target.length() == profile.getLong("onnx_bytes")) return target
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
            return target
        } finally { temporary.delete() }
    }
}
