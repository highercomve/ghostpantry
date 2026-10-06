package dev.ghostpantry

import java.io.*
import java.security.MessageDigest
import java.util.Locale

/** Bounded local examples; no photos and no model weight updates. */
object EmbeddingFeedback {
    const val MAX_EXAMPLES = 128
    data class Example(val label: String, val accepted: Boolean, val vector: FloatArray)
    private fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
    fun canonical(label: String) = label.trim().lowercase(Locale.ROOT)

    fun read(file: File, configuration: String): List<Example> {
        if (!file.exists()) return emptyList()
        check(file.length() in 32L..200_000L) { "Correction memory is damaged. Clear it to start again." }
        try {
            val bytes = file.readBytes()
            val body = bytes.copyOfRange(0, bytes.size - 32)
            check(MessageDigest.isEqual(digest(body), bytes.copyOfRange(body.size, bytes.size)))
            DataInputStream(ByteArrayInputStream(body)).use { input ->
                if (input.readUTF() != configuration) return emptyList()
                val count = input.readInt()
                require(count in 0..MAX_EXAMPLES)
                val examples = List(count) {
                    val label = input.readUTF()
                    validateLabel(label)
                    Example(label, input.readBoolean(), EmbeddingMath.normalize(FloatArray(256) { input.readFloat() }))
                }
                check(input.available() == 0)
                return examples
            }
        } catch (failure: Exception) {
            throw IOException("Correction memory is damaged. Clear it to start again.", failure)
        }
    }

    fun validateLabel(label: String) {
        require(label.isNotBlank() && label.length <= 120 && label.none { it.isISOControl() }) { "Use a food label of 1–120 characters" }
    }

    fun remember(examples: List<Example>, label: String, accepted: Boolean, vector: FloatArray): List<Example> {
        validateLabel(label)
        val normalized = EmbeddingMath.normalize(vector)
        // A newer decision replaces the same label on effectively the same photo.
        return (examples.filterNot { canonical(it.label) == canonical(label) && EmbeddingMath.similarity(it.vector, normalized) >= 0.995 }
            + Example(label.trim(), accepted, normalized)).takeLast(MAX_EXAMPLES)
    }

    fun adjustment(examples: List<Example>, label: String, vector: FloatArray): Double {
        var closest = 0.94
        var adjustment = 0.0
        // Newest wins a tie; feedback never affects dissimilar images.
        for (example in examples.asReversed()) {
            if (canonical(example.label) != canonical(label)) continue
            val similarity = EmbeddingMath.similarity(vector, example.vector)
            if (similarity <= closest) continue
            closest = similarity
            adjustment = ((similarity - 0.94) / 0.06).coerceIn(0.0, 1.0) * if (example.accepted) 0.12 else -0.12
        }
        return adjustment
    }

    fun write(file: File, configuration: String, examples: List<Example>) {
        require(examples.size <= MAX_EXAMPLES)
        val bytes = ByteArrayOutputStream()
        DataOutputStream(bytes).use { output ->
            output.writeUTF(configuration)
            output.writeInt(examples.size)
            examples.forEach {
                validateLabel(it.label)
                output.writeUTF(it.label)
                output.writeBoolean(it.accepted)
                EmbeddingMath.normalize(it.vector).forEach { value -> output.writeFloat(value) }
            }
        }
        val body = bytes.toByteArray()
        require(body.size + 32 <= 200_000)
        val part = File(file.parentFile, file.name + ".tmp")
        try {
            FileOutputStream(part).use { it.write(body); it.write(digest(body)); it.fd.sync() }
            check(part.renameTo(file)) { "Cannot save correction memory" }
        } finally { part.delete() }
    }
}

/** Retain bounded scan identities so feedback on an earlier crop cannot teach the last crop. */
class EmbeddingFeedbackSessions {
    data class Crop(val vector: FloatArray, val configuration: String, val backend: String, val scope: String)
    private val scans = linkedMapOf<String, Crop>()
    fun remember(id: String, vector: FloatArray, configuration: String, backend: String, scope: String) {
        require(scope == "photo" || scope == "crop")
        scans[id] = Crop(vector.copyOf(), configuration, backend, scope)
        while (scans.size > 64) scans.remove(scans.keys.first())
    }
    operator fun get(id: String) = scans[id]
    fun clear() = scans.clear()
}
