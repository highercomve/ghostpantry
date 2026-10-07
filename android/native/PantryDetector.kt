package dev.ghostpantry

import android.content.Context
import android.graphics.BitmapFactory
import android.os.Debug
import android.util.Base64
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.objectdetector.ObjectDetector
import org.json.JSONArray
import org.json.JSONObject

/** Deliberately uses generic COCO detectors as a measurable baseline, not package detection. */
object PantryDetector {
    fun detect(context: Context, input: JSONObject): JSONObject {
        val model = input.getString("detector")
        require(model in listOf("efficientdet_lite0", "efficientdet_lite2", "rfdetr_nano", "yoloe"))
        val threshold = input.optDouble("threshold", 0.25).toFloat()
        require(threshold.isFinite() && threshold in .1f.. .9f)
        val image = input.getString("image")
        require(image.startsWith("data:image/") && image.contains(";base64,"))
        val bytes = Base64.decode(image.substringAfter(";base64,"), Base64.DEFAULT)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        require(bounds.outWidth in 1..1600 && bounds.outHeight in 1..1600)
        val bitmap = requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size)) { "Cannot decode photo" }
        val started = System.nanoTime()
        try {
            if (model == "rfdetr_nano") return RfDetrDetector.detect(context, bitmap, started, threshold)
            if (model == "yoloe") return YoloePackageDetector.detect(context, bitmap, started, threshold)
            val options = ObjectDetector.ObjectDetectorOptions.builder()
                .setBaseOptions(BaseOptions.builder().setModelAssetPath("detectors/$model.tflite").build())
                .setRunningMode(RunningMode.IMAGE).setMaxResults(12).setScoreThreshold(threshold).build()
            ObjectDetector.createFromOptions(context, options).use { detector ->
                val loadMs = (System.nanoTime() - started) / 1_000_000
                val detecting = System.nanoTime()
                val mpImage = BitmapImageBuilder(bitmap).build()
                val result = try { detector.detect(mpImage) } finally { mpImage.close() }
                val detectMs = (System.nanoTime() - detecting) / 1_000_000
                val boxes = JSONArray()
                for (detection in result.detections().take(12)) {
                    val box = detection.boundingBox()
                    val category = detection.categories().maxByOrNull { it.score() } ?: continue
                    val left = (box.left / bitmap.width).coerceIn(0f, 1f)
                    val top = (box.top / bitmap.height).coerceIn(0f, 1f)
                    val right = (box.right / bitmap.width).coerceIn(0f, 1f)
                    val bottom = (box.bottom / bitmap.height).coerceIn(0f, 1f)
                    if (right <= left || bottom <= top) continue
                    boxes.put(JSONObject().put("x", left.toDouble()).put("y", top.toDouble())
                        .put("width", (right-left).toDouble()).put("height", (bottom-top).toDouble())
                        .put("label", category.categoryName()).put("score", category.score().toDouble()))
                }
                val memory = Debug.MemoryInfo().also { Debug.getMemoryInfo(it) }
                return JSONObject().put("boxes", boxes).put("detector", model).put("load_ms", loadMs)
                    .put("detect_ms", detectMs).put("total_ms", (System.nanoTime()-started)/1_000_000)
                    .put("pss_mb", memory.totalPss / 1024.0)
            }
        } finally { bitmap.recycle() }
    }
}
