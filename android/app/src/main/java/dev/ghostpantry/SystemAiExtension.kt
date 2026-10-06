package dev.ghostpantry

import android.app.Activity
import android.os.Bundle
import android.os.Looper
import android.graphics.BitmapFactory
import android.util.Base64
import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.ImagePart
import com.google.mlkit.genai.prompt.TextPart
import com.google.mlkit.genai.prompt.generateContentRequest
import dev.oriel.OrielAndroidExtension
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.util.concurrent.locks.ReentrantLock

/** System AI stays app-owned: Oriel copies and registers this extension. */
class SystemAiExtension : OrielAndroidExtension {
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) { bind() }

    companion object {
        @JvmStatic private external fun bind()
        private val lock = ReentrantLock()
        private val model by lazy { Generation.getClient() }

        /** Called only by a Zig IPC worker attached to the JVM, never the UI thread. */
        @JvmStatic fun request(bytes: ByteArray): ByteArray {
            if (Looper.myLooper() == Looper.getMainLooper()) return error("System AI must run off the UI thread")
            if (!lock.tryLock()) return error("System AI is busy. Try again when the current operation finishes.")
            return try {
                require(bytes.size <= 8 * 1024 * 1024) { "Photo request is too large" }
                val input = JSONObject(String(bytes, Charsets.UTF_8))
                val operation = input.getString("operation")
                val timeout = if (operation == "download") 600_000L else if (operation == "analyze") 180_000L else 20_000L
                val started = System.nanoTime()
                val reply = runBlocking {
                    withTimeout(timeout) {
                        when (operation) {
                            "status" -> status()
                            "download" -> {
                                when (model.checkStatus()) {
                                    FeatureStatus.DOWNLOADABLE -> model.download().collect { progress ->
                                        if (progress is DownloadStatus.DownloadFailed) throw progress.e
                                    }
                                    FeatureStatus.UNAVAILABLE -> throw IllegalStateException("System AI is unavailable. Use a downloaded local model.")
                                    else -> Unit
                                }
                                status()
                            }
                            "analyze" -> analyze(input)
                            else -> throw IllegalArgumentException("Unknown system AI operation")
                        }
                    }
                }
                reply.put("elapsed_ms", (System.nanoTime() - started) / 1_000_000).toString().toByteArray(Charsets.UTF_8)
            } catch (failure: Exception) {
                error(failure.message ?: failure.javaClass.simpleName)
            } finally { lock.unlock() }
        }

        private fun error(message: String) = JSONObject().put("error", message).toString().toByteArray(Charsets.UTF_8)

        private suspend fun status(): JSONObject {
            val state = when (model.checkStatus()) {
                FeatureStatus.AVAILABLE -> "available"
                FeatureStatus.DOWNLOADABLE -> "downloadable"
                FeatureStatus.DOWNLOADING -> "downloading"
                else -> "unavailable"
            }
            return JSONObject().put("state", state).put("message", when (state) {
                "available" -> "Gemini Nano is ready. Photos are processed on this phone."
                "downloadable" -> "This phone supports system AI. Download the system model to enable scans."
                "downloading" -> "Android is downloading the system model. Check again shortly."
                else -> "System AI is unavailable on this phone or its AICore configuration. Use a downloaded local model, or check again after updating AICore."
            })
        }

        private suspend fun analyze(input: JSONObject): JSONObject {
            check(model.checkStatus() == FeatureStatus.AVAILABLE) { "System AI is not ready. Check its status in Settings or choose a downloaded local model." }
            val image = input.getString("image")
            require(image.startsWith("data:image/") && image.contains(";base64,")) { "Invalid image data" }
            val data = Base64.decode(image.substringAfter(";base64,"), Base64.DEFAULT)
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
            require(bounds.outWidth in 1..1600 && bounds.outHeight in 1..1600) { "Photo must be at most 1600 pixels per side" }
            val bitmap = BitmapFactory.decodeByteArray(data, 0, data.size) ?: throw IllegalArgumentException("Cannot decode this photo")
            return try {
                val response = model.generateContent(generateContentRequest(ImagePart(bitmap), TextPart(input.getString("prompt"))) {
                    temperature = 0.2f
                    maxOutputTokens = 2048
                })
                val text = response.candidates.firstOrNull()?.text ?: throw IllegalStateException("System AI returned no result")
                JSONObject().put("content", text)
            } finally { bitmap.recycle() }
        }
    }
}
