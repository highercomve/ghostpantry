package dev.ghostpantry

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/** One bounded, checksummed vocabulary per backend; invalid caches become misses. */
object EmbeddingCache {
    private const val MAX_BYTES = 2 * 1024 * 1024
    private fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)

    fun key(configuration: String, labels: List<String>): ByteArray {
        val bytes = ByteArrayOutputStream()
        DataOutputStream(bytes).use { output ->
            output.writeUTF(configuration)
            labels.forEach { output.writeUTF(it) }
        }
        return digest(bytes.toByteArray())
    }

    fun read(file: File, key: ByteArray, count: Int): List<FloatArray>? {
        if (count !in 2..1027 || key.size != 32 || file.length() !in 64L..MAX_BYTES.toLong()) return null
        return try {
            val bytes = file.readBytes()
            val body = bytes.copyOfRange(0, bytes.size - 32)
            if (!MessageDigest.isEqual(digest(body), bytes.copyOfRange(body.size, bytes.size))) return null
            DataInputStream(ByteArrayInputStream(body)).use { input ->
                val storedKey = ByteArray(32).also { input.readFully(it) }
                if (!MessageDigest.isEqual(key, storedKey) || input.readInt() != count) return null
                val vectors = List(count) { EmbeddingMath.normalize(FloatArray(256) { input.readFloat() }) }
                if (input.available() != 0) return null
                vectors
            }
        } catch (_: Exception) { null }
    }

    fun write(file: File, key: ByteArray, vectors: List<FloatArray>) {
        require(key.size == 32 && vectors.size in 2..1027)
        val bytes = ByteArrayOutputStream()
        DataOutputStream(bytes).use { output ->
            output.write(key)
            output.writeInt(vectors.size)
            vectors.forEach { vector -> EmbeddingMath.normalize(vector).forEach { output.writeFloat(it) } }
        }
        val body = bytes.toByteArray()
        require(body.size + 32 <= MAX_BYTES)
        val part = File(file.parentFile, file.name + ".tmp")
        try {
            FileOutputStream(part).use { output ->
                output.write(body)
                output.write(digest(body))
                output.fd.sync()
            }
            check(part.renameTo(file)) { "Cannot install label cache" }
        } finally { part.delete() }
    }
}
