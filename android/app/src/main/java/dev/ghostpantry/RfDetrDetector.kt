package dev.ghostpantry

import android.content.Context
import android.graphics.Bitmap
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

/** Pretrained COCO baseline, CPU only. No food-category filtering or memory-based box selection. */
object RfDetrDetector {
    private val environment by lazy { OrtEnvironment.getEnvironment() }

    @Synchronized
    fun detect(context: Context, bitmap: Bitmap, started: Long, threshold: Float): JSONObject {
        val contract = context.assets.open("detectors/rfdetr_nano.json").bufferedReader().use { JSONObject(it.readText()) }
        val classesJson = contract.getJSONObject("classes")
        val classes = classesJson.keys().asSequence().associate { it.toInt() to classesJson.getString(it) }
        val model = unpackModel(context, contract)
        OrtSession.SessionOptions().use { options ->
            // No NNAPI, GPU or automatic provider selection: compare CPU on the phone.
            options.setIntraOpNumThreads(4)
            options.setInterOpNumThreads(1)
            options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
            environment.createSession(model.absolutePath, options).use { session ->
                val loadMs = (System.nanoTime() - started) / 1_000_000
                val detecting = System.nanoTime()
                val side = contract.getInt("input_size")
                require(side == 384 && session.inputNames == setOf("input") && session.outputNames.containsAll(listOf("dets", "labels")))
                // RF-DETR stretches to its square input; there is no letterbox
                // padding to undo. Boxes remain normalized to the source photo.
                val resized = Bitmap.createScaledBitmap(bitmap, side, side, true)
                val pixels = IntArray(side * side)
                try { resized.getPixels(pixels, 0, side, 0, 0, side, side) }
                finally { if (resized !== bitmap) resized.recycle() }
                val buffer = ByteBuffer.allocateDirect(side * side * 3 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()
                PackageDetectionMath.normalizeRgb(pixels, buffer)
                OnnxTensor.createTensor(environment, buffer, longArrayOf(1, 3, side.toLong(), side.toLong())).use { tensor ->
                    session.run(mapOf("input" to tensor)).use { result ->
                        @Suppress("UNCHECKED_CAST")
                        val boxes = result.get("dets").orElseThrow { IllegalStateException("RF-DETR boxes output missing") }.value as Array<Array<FloatArray>>
                        @Suppress("UNCHECKED_CAST")
                        val logits = result.get("labels").orElseThrow { IllegalStateException("RF-DETR labels output missing") }.value as Array<Array<FloatArray>>
                        require(boxes.size == 1 && logits.size == 1 && boxes[0].size == 300 && logits[0].all { it.size == 91 })
                        val decoded = PackageDetectionMath.decode(boxes[0], logits[0], classes, threshold)
                        val jsonBoxes = JSONArray()
                        for (box in decoded) jsonBoxes.put(JSONObject()
                            .put("x", box.x.toDouble()).put("y", box.y.toDouble())
                            .put("width", box.width.toDouble()).put("height", box.height.toDouble())
                            .put("label", box.label).put("score", box.score.toDouble()))
                        val memory = Debug.MemoryInfo().also { Debug.getMemoryInfo(it) }
                        return JSONObject().put("boxes", jsonBoxes).put("detector", "rfdetr_nano")
                            .put("load_ms", loadMs).put("detect_ms", (System.nanoTime() - detecting) / 1_000_000)
                            .put("total_ms", (System.nanoTime() - started) / 1_000_000).put("pss_mb", memory.totalPss / 1024.0)
                    }
                }
            }
        }
    }

    private fun unpackModel(context: Context, contract: JSONObject): File {
        val hash = contract.getString("onnx_sha256")
        require(hash.matches(Regex("[0-9a-f]{64}")))
        val directory = File(context.cacheDir, "rfdetr").apply { mkdirs() }
        val target = File(directory, "$hash.onnx")
        if (target.isFile && target.length() == contract.getLong("onnx_bytes")) return target
        val temporary = File(directory, "$hash.tmp")
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            // A .gz asset is automatically expanded/renamed by Android's asset
            // merger. The opaque .bin suffix preserves the compressed bytes.
            GZIPInputStream(context.assets.open("detectors/rfdetr_nano.onnx.bin")).use { source ->
                temporary.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        val count = source.read(buffer)
                        if (count < 0) break
                        total += count
                        require(total <= contract.getLong("onnx_bytes")) { "RF-DETR model is larger than expected" }
                        digest.update(buffer, 0, count)
                        output.write(buffer, 0, count)
                    }
                }
            }
            require(temporary.length() == contract.getLong("onnx_bytes") && digest.digest().joinToString("") { "%02x".format(it) } == hash) { "RF-DETR model failed integrity verification" }
            require(temporary.renameTo(target)) { "Cannot prepare RF-DETR model" }
            return target
        } finally { temporary.delete() }
    }
}
