package dev.ghostpantry

import android.graphics.BitmapFactory
import android.os.Debug
import android.util.Base64
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Offline bundled Latin OCR. Crops retain source pixels; never enlarge the preview. */
object PantryOcr {
    @Volatile private var outstanding: Task<Text>? = null
    fun read(input: JSONObject): JSONObject {
        require(outstanding?.isComplete != false) { "Previous OCR task is still finishing. Try again shortly." }
        val encoded = input.getString("image")
        require(encoded.startsWith("data:image/") && encoded.contains(";base64,")) { "Invalid OCR crop" }
        val bytes = Base64.decode(encoded.substringAfter(";base64,"), Base64.DEFAULT)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        require(bounds.outWidth > 0 && bounds.outHeight > 0 && bounds.outWidth.toLong()*bounds.outHeight <= 24_000_000) {
            "OCR crop exceeds 24 megapixels. Use smaller regions."
        }
        val bitmap = requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size)) { "Cannot decode OCR crop" }
        val started = System.nanoTime()
        val recognizer = try { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }
            catch (failure: Exception) { bitmap.recycle(); throw failure }
        var activeTask: Task<Text>? = null
        try {
            val angles = if (input.optBoolean("rotated", false)) listOf(0,90,180,270) else listOf(0)
            val lines = linkedSetOf<String>()
            for (angle in angles) {
                val task = recognizer.process(InputImage.fromBitmap(bitmap, angle))
                activeTask = task
                outstanding = task
                val result = Tasks.await(task, 30, TimeUnit.SECONDS)
                result.textBlocks.take(128).forEach { block -> block.lines.take(128).forEach { line ->
                    if (lines.size < 256) lines.add(line.text.take(256))
                } }
            }
            val memory = Debug.MemoryInfo().also { Debug.getMemoryInfo(it) }
            return JSONObject().put("text", lines.joinToString("\n").take(16_384))
                .put("total_ms", (System.nanoTime()-started)/1_000_000).put("width", bitmap.width).put("height", bitmap.height)
                .put("rotations", angles.size).put("pss_mb", memory.totalPss/1024.0)
        } finally {
            // Await timing out does not cancel ML Kit. Keep its pixels alive until
            // the outstanding task releases them, even if the caller has returned.
            val task = activeTask
            if (task != null && !task.isComplete) {
                task.addOnCompleteListener { recognizer.close(); bitmap.recycle() }
            } else {
                recognizer.close()
                bitmap.recycle()
            }
        }
    }
}
