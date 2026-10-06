package dev.ghostpantry

import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Bundle
import android.os.Debug
import android.os.Looper
import android.util.Base64
import android.util.Log
import com.google.ai.edge.litertlm.ActivationDataType
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.EmbeddingEngine
import com.google.ai.edge.litertlm.EmbeddingEngineConfig
import com.google.ai.edge.litertlm.EmbeddingOptions
import com.google.ai.edge.litertlm.InputData
import dev.oriel.OrielAndroidExtension
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.locks.ReentrantLock

/** Downloadable, app-owned LiteRT experiment; no dependency on AICore support. */
class EmbeddingGemmaExtension : OrielAndroidExtension {
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
        context = activity.applicationContext
        bind()
    }

    companion object {
        @JvmStatic private external fun bind()
        private var context: Context? = null
        private const val MODEL_BYTES = 387710976L
        private const val MODEL_SHA = "92dcbea108899e5d6e30d919b0744f90d9967e80c67a4ab5503ac16d54f62eb0"
        private const val MODEL_URL = "https://huggingface.co/litert-community/embeddinggemma-2-text-vision-440m-litert-lm/resolve/e301f74d5551b0c2641bd5cb4652a76239d5c5f8/embeddinggemma-2-text-vision-440m.litertlm"
        private val lock = ReentrantLock()
        private val downloading = AtomicBoolean(false)
        private val cancelDownload = AtomicBoolean(false)
        @Volatile private var downloadState = ""
        @Volatile private var downloadBytes = 0L
        @Volatile private var downloadError: String? = null
        @Volatile private var connection: HttpURLConnection? = null
        private var engine: EmbeddingEngine? = null
        private var engineBackend = ""
        private var lastScanId = ""
        private var lastImageVector: FloatArray? = null
        private var lastFeedbackConfiguration = ""
        private var lastFeedbackBackend = "cpu"
        private var cachedLabels = emptyList<String>()
        private var cachedVectors = emptyList<FloatArray>()

        private fun folder(): File = File(checkNotNull(context).filesDir, "embeddinggemma").apply { mkdirs() }
        private fun modelFile() = File(folder(), "embeddinggemma-2-440m.litertlm")
        private fun partFile() = File(folder(), "embeddinggemma-2-440m.litertlm.part")
        private fun supported() = Build.VERSION.SDK_INT >= 29 && Build.SUPPORTED_ABIS.any { it == "arm64-v8a" || it == "x86_64" }
        private fun device() = "${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE}"

        @JvmStatic fun request(bytes: ByteArray): ByteArray {
            return try {
                check(Looper.myLooper() != Looper.getMainLooper()) { "Image matching must run off the UI thread" }
                require(bytes.size <= 8 * 1024 * 1024) { "Photo request is too large" }
                val input = JSONObject(String(bytes, Charsets.UTF_8))
                check(context != null) { "Android extension is not initialized" }
                val operation = input.getString("operation")
                check(lock.tryLock()) { "Image matching is busy. Wait for the current operation." }
                try {
                    val result = when (operation) {
                        "status" -> status()
                        "download" -> { startDownload(); status() }
                        "cancel" -> { cancelDownload.set(true); connection?.disconnect(); status() }
                        "prepare" -> { load(input.optString("backend", "cpu")); probe(); status() }
                        "detect" -> PantryDetector.detect(checkNotNull(context), input)
                        "match" -> try { match(input) } catch (failure: Exception) { release(); throw failure }
                        "feedback" -> feedback(input)
                        "clear_feedback" -> {
                            for (backend in listOf("cpu", "gpu")) {
                                val file = feedbackFile(backend)
                                check(!file.exists() || file.delete()) { "Cannot clear corrections" }
                            }
                            JSONObject().put("count", 0)
                        }
                        "release" -> { release(); status() }
                        "delete" -> {
                            check(!downloading.get()) { "Pause the download before deleting the model" }
                            release()
                            check(!modelFile().exists() || modelFile().delete()) { "Cannot delete model" }
                            check(!partFile().exists() || partFile().delete()) { "Cannot delete partial download" }
                            for (backend in listOf("cpu", "gpu")) File(folder(), "labels-$backend.bin").delete()
                            downloadError = null
                            status()
                        }
                        else -> throw IllegalArgumentException("Unknown image matching operation")
                    }
                    result.toString().toByteArray(Charsets.UTF_8)
                } finally { lock.unlock() }
            } catch (failure: Exception) {
                JSONObject().put("error", failure.message ?: failure.javaClass.simpleName).toString().toByteArray(Charsets.UTF_8)
            } catch (failure: LinkageError) {
                JSONObject().put("error", "LiteRT could not load on this device: ${failure.message}").toString().toByteArray(Charsets.UTF_8)
            }
        }

        private fun status(): JSONObject {
            val eligible = supported()
            val present = modelFile().isFile && modelFile().length() == MODEL_BYTES
            val state = when {
                !eligible -> "unavailable"
                downloading.get() -> downloadState.ifEmpty { "downloading" }
                downloadError != null -> "error"
                engine != null -> "ready"
                present -> "downloaded"
                else -> "downloadable"
            }
            val message = when (state) {
                "unavailable" -> "Requires Android 10+ and an ARM64 or x86-64 device."
                "downloading" -> "Downloading the image-and-text model. You can pause and resume."
                "verifying" -> "Checking the downloaded model's SHA-256 checksum."
                "error" -> downloadError
                "ready" -> "Image matching is ready on ${engineBackend.uppercase()}."
                "downloaded" -> "Model downloaded. Test CPU or GPU support on this phone."
                else -> "Download the 388 MB model once; photo matching then runs offline."
            }
            return JSONObject().put("state", state).put("message", message).put("supported", eligible)
                .put("device", device()).put("backend", engineBackend).put("loaded", engine != null)
                .put("bytes_downloaded", if (downloading.get()) downloadBytes else if (present) MODEL_BYTES else partFile().length())
                .put("total_bytes", MODEL_BYTES)
        }

        private fun startDownload() {
            check(supported()) { "This device is not supported" }
            if (modelFile().isFile && modelFile().length() == MODEL_BYTES) { downloadError = null; return }
            if (!downloading.compareAndSet(false, true)) return
            cancelDownload.set(false)
            downloadState = "downloading"
            downloadError = null
            Thread({
                try { downloadModel() }
                catch (failure: Exception) {
                    if (!cancelDownload.get()) downloadError = failure.message ?: "Model download failed"
                } finally {
                    connection?.disconnect()
                    connection = null
                    downloading.set(false)
                }
            }, "GhostPantry-model-download").start()
        }

        private fun openDownload(offset: Long): HttpURLConnection {
            var url = URL(MODEL_URL)
            repeat(8) {
                check(url.protocol == "https") { "Model download must use HTTPS" }
                val current = (url.openConnection() as HttpURLConnection).apply {
                    instanceFollowRedirects = false
                    connectTimeout = 30000
                    readTimeout = 30000
                    setRequestProperty("Accept-Encoding", "identity")
                    if (offset > 0) setRequestProperty("Range", "bytes=$offset-")
                }
                connection = current
                val code = current.responseCode
                if (code !in listOf(301, 302, 303, 307, 308)) return current
                val location = current.getHeaderField("Location") ?: error("Invalid download redirect")
                current.disconnect()
                url = URL(url, location)
            }
            error("Too many download redirects")
        }

        private fun downloadModel() {
            val part = partFile()
            if (part.length() > MODEL_BYTES) check(part.delete())
            var offset = part.length()
            downloadBytes = offset
            if (offset < MODEL_BYTES) {
                val http = openDownload(offset)
                val code = http.responseCode
                check(code == 200 || code == 206) { "Download failed (HTTP $code). Try again." }
                if (code == 200) { offset = 0; downloadBytes = 0 }
                else {
                    val range = http.getHeaderField("Content-Range") ?: error("Missing resume range")
                    check(range.startsWith("bytes $offset-") && range.endsWith("/$MODEL_BYTES")) { "Invalid resume range" }
                }
                FileOutputStream(part, offset > 0).use { output ->
                    http.inputStream.use { source ->
                        val buffer = ByteArray(65536)
                        var total = offset
                        while (true) {
                            check(!cancelDownload.get()) { "Download paused" }
                            val count = source.read(buffer)
                            if (count < 0) break
                            check(total + count <= MODEL_BYTES) { "Downloaded model exceeds its expected size" }
                            output.write(buffer, 0, count)
                            total += count
                            downloadBytes = total
                        }
                        output.fd.sync()
                    }
                }
                http.disconnect()
            }
            check(part.length() == MODEL_BYTES) { "Incomplete download. Try again to resume." }
            downloadState = "verifying"
            val digest = MessageDigest.getInstance("SHA-256")
            part.inputStream().use { source ->
                val buffer = ByteArray(65536)
                while (true) {
                    check(!cancelDownload.get()) { "Download paused" }
                    val count = source.read(buffer)
                    if (count < 0) break
                    digest.update(buffer, 0, count)
                }
            }
            val hash = digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
            if (hash != MODEL_SHA) { part.delete(); error("Model checksum failed. Download it again.") }
            check(part.renameTo(modelFile())) { "Cannot install the verified model" }
        }

        private fun load(backend: String): Long {
            require(backend == "cpu" || backend == "gpu") { "Choose CPU or GPU" }
            check(!downloading.get()) { "Wait for the model download to finish" }
            check(modelFile().length() == MODEL_BYTES) { "Download the model before testing" }
            if (engine != null && engineBackend == backend) return 0
            release()
            val started = System.nanoTime()
            val runtime = if (backend == "cpu") Backend.CPU(threadCount = Runtime.getRuntime().availableProcessors().coerceIn(1, 4)) else Backend.GPU()
            val config = EmbeddingEngineConfig(modelPath = modelFile().absolutePath, backend = runtime,
                visionBackend = runtime, cacheDir = File(checkNotNull(context).cacheDir, "embeddinggemma").apply { mkdirs() }.absolutePath,
                maxInputLength = 128, visionTokensPerImage = 70, activationDataType = ActivationDataType.FLOAT32)
            val candidate = EmbeddingEngine(config)
            try { candidate.initialize() }
            catch (failure: Throwable) {
                if (candidate.isInitialized()) candidate.close()
                throw IllegalStateException("${backend.uppercase()} could not initialize on this phone. ${if (backend == "gpu") "Try CPU. " else ""}${failure.message}", failure)
            }
            engine = candidate
            engineBackend = backend
            return elapsed(started)
        }

        private fun embed(input: InputData): FloatArray {
            val result = checkNotNull(engine).computeEmbedding(listOf(input), EmbeddingOptions(normalize = true, outputSize = 256, visionTokensPerImage = 70))
            return EmbeddingMath.normalize(result.embedding)
        }

        private fun probe() {
            try {
                embed(InputData.Text("A photo of an apple"))
                val bitmap = Bitmap.createBitmap(32, 32, Bitmap.Config.ARGB_8888)
                try {
                    val bytes = ByteArrayOutputStream().apply { bitmap.compress(Bitmap.CompressFormat.PNG, 100, this) }.toByteArray()
                    embed(InputData.Image(bytes))
                } finally { bitmap.recycle() }
            } catch (failure: Throwable) { release(); throw failure }
        }

        private fun match(input: JSONObject): JSONObject {
            val started = System.nanoTime()
            val labelsJson = input.getJSONArray("labels")
            require(labelsJson.length() in 2..1024) { "Provide 2–1,024 food labels" }
            val userLabels = (0 until labelsJson.length()).map { labelsJson.getString(it).trim() }.distinct()
            val backgroundLabels = listOf("other food", "non-food objects", "empty shelf")
            val labels = (userLabels + backgroundLabels).distinct()
            require(userLabels.size >= 2 && labels.all { it.isNotEmpty() && it.length <= 120 }) { "Each food label must contain 1–120 characters" }
            val image = input.getString("image")
            require(image.startsWith("data:image/") && image.contains(";base64,")) { "Invalid photo" }
            val bytes = Base64.decode(image.substringAfter(";base64,"), Base64.DEFAULT)
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            require(bounds.outWidth in 1..1600 && bounds.outHeight in 1..1600) { "Photo must be at most 1600 pixels per side" }
            val loadMs = load(input.optString("backend", "cpu"))
            val labelsStarted = System.nanoTime()
            val labelCache = prepareLabels(labels)
            val labelsMs = elapsed(labelsStarted)
            val imageStarted = System.nanoTime()
            val imageVector = embed(InputData.Image(bytes))
            val imageMs = elapsed(imageStarted)
            val personalized = input.optBoolean("personalized", false)
            val configuration = "$MODEL_SHA|litertlm-0.18|$engineBackend|fp32|256|128|70"
            var feedbackWarning = ""
            val examples = if (personalized) try { EmbeddingFeedback.read(feedbackFile(engineBackend), configuration) }
                catch (failure: Exception) { feedbackWarning = failure.message ?: "Could not read corrections"; emptyList() }
                else emptyList()
            val backgroundScore = labels.indices.filter { labels[it] in backgroundLabels }
                .maxOf { EmbeddingMath.similarity(imageVector, cachedVectors[it]) }
            val candidates = labels.mapIndexedNotNull { index, label ->
                if (label in backgroundLabels) null else label to cachedVectors[index]
            }.toMutableList()
            val known = labels.map { EmbeddingFeedback.canonical(it) }.toSet()
            val recalled = examples.asReversed().filter { it.accepted && EmbeddingMath.similarity(imageVector, it.vector) > 0.94 }
                .distinctBy { EmbeddingFeedback.canonical(it.label) }.filter { EmbeddingFeedback.canonical(it.label) !in known && it.label !in backgroundLabels }.take(16)
            for (example in recalled) candidates.add(example.label to embed(InputData.Text("A photo of ${example.label}")))
            val ranked = candidates.map { (label, vector) ->
                val score = EmbeddingMath.similarity(imageVector, vector)
                val adjustment = EmbeddingFeedback.adjustment(examples, label, imageVector)
                Triple(label, score, adjustment)
            }.sortedByDescending { it.second + it.third }.take(input.optInt("max_matches", 5).coerceIn(1, 10))
            val needsReview = ranked.isEmpty() || backgroundScore >= ranked.first().second + ranked.first().third
            val matches = JSONArray()
            ranked.forEach { matches.put(JSONObject().put("label", it.first).put("score", it.second).put("adjustment", it.third)) }
            val scanId = if (personalized) UUID.randomUUID().toString() else ""
            if (personalized) {
                lastScanId = scanId
                lastImageVector = imageVector.copyOf()
                lastFeedbackConfiguration = configuration
                lastFeedbackBackend = engineBackend
            }
            val memory = Debug.MemoryInfo().also { Debug.getMemoryInfo(it) }
            return JSONObject().put("matches", matches).put("device", device()).put("backend", engineBackend)
                .put("labels_count", userLabels.size).put("needs_review", needsReview).put("background_score", backgroundScore)
                .put("scan_id", scanId).put("correction_count", examples.size).put("feedback_warning", feedbackWarning)
                .put("total_ms", elapsed(started)).put("load_ms", loadMs).put("labels_ms", labelsMs).put("image_ms", imageMs)
                .put("pss_mb", memory.totalPss / 1024.0).put("dimensions", 256).put("vision_tokens", 70).put("labels_cached", labelCache != "computed").put("label_cache", labelCache)
        }

        private fun feedbackFile(backend: String) = File(folder(), "corrections-$backend.bin")

        private fun feedback(input: JSONObject): JSONObject {
            check(input.getString("scan_id") == lastScanId && lastScanId.isNotEmpty()) { "Scan this photo again before teaching a correction" }
            val vector = checkNotNull(lastImageVector) { "Scan this photo again before teaching a correction" }
            val examples = EmbeddingFeedback.read(feedbackFile(lastFeedbackBackend), lastFeedbackConfiguration)
            val updated = EmbeddingFeedback.remember(examples, input.getString("label"), input.getBoolean("accepted"), vector)
            EmbeddingFeedback.write(feedbackFile(lastFeedbackBackend), lastFeedbackConfiguration, updated)
            return JSONObject().put("count", updated.size)
        }

        private fun prepareLabels(labels: List<String>): String {
            if (labels == cachedLabels) return "memory"
            val key = EmbeddingCache.key("$MODEL_SHA|litertlm-0.18|$engineBackend|fp32|256|128|70|caption-v1", labels)
            val file = File(folder(), "labels-$engineBackend.bin")
            val restored = EmbeddingCache.read(file, key, labels.size)
            val vectors = restored ?: labels.map { embed(InputData.Text("A photo of $it")) }
            cachedLabels = labels
            cachedVectors = vectors
            if (restored == null) {
                try { EmbeddingCache.write(file, key, vectors) }
                catch (failure: Exception) { Log.w("GhostPantryEmbedding", "Label cache could not be saved", failure) }
            }
            return if (restored == null) "computed" else "disk"
        }

        private fun elapsed(started: Long) = (System.nanoTime() - started) / 1_000_000
        private fun release() {
            val previous = engine
            engine = null
            engineBackend = ""
            cachedLabels = emptyList()
            cachedVectors = emptyList()
            previous?.close()
        }
    }
}
