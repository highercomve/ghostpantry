package dev.ghostpantry

import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class EmbeddingCacheTest {
    @Test fun labelsSurviveRestartAndChangedConfigurationMisses() {
        val folder = Files.createTempDirectory("embedding-cache-test").toFile()
        try {
            val file = java.io.File(folder, "labels.bin")
            val key = EmbeddingCache.key("model|cpu|256|caption-v1", listOf("pasta", "rice"))
            val vectors = listOf(FloatArray(256).apply { this[0] = 1f }, FloatArray(256).apply { this[1] = 1f })
            EmbeddingCache.write(file, key, vectors)
            val restored = checkNotNull(EmbeddingCache.read(file, key, 2))
            assertEquals(1.0, EmbeddingMath.similarity(restored[0], vectors[0]), 1e-6)
            assertEquals(0.0, EmbeddingMath.similarity(restored[1], vectors[0]), 1e-6)
            assertNull(EmbeddingCache.read(file, EmbeddingCache.key("other-model|cpu|256|caption-v1", listOf("pasta", "rice")), 2))
            assertNull(EmbeddingCache.read(file, EmbeddingCache.key("model|cpu|256|caption-v1", listOf("rice", "pasta")), 2))
            assertNull(EmbeddingCache.read(file, key, 3))
            assertNull(EmbeddingCache.read(file, key, 49))
        } finally { folder.deleteRecursively() }
    }

    @Test fun corruptionOrInterruptedWriteBecomesACacheMiss() {
        val folder = Files.createTempDirectory("embedding-cache-test").toFile()
        try {
            val file = java.io.File(folder, "labels.bin")
            val key = EmbeddingCache.key("model|cpu", listOf("pasta", "rice"))
            val vectors = List(2) { FloatArray(256).apply { this[it] = 1f } }
            EmbeddingCache.write(file, key, vectors)
            val corrupt = file.readBytes().apply { this[45] = (this[45].toInt() xor 1).toByte() }
            file.writeBytes(corrupt)
            assertNull(EmbeddingCache.read(file, key, 2))
            file.writeBytes(corrupt.copyOf(100))
            assertNull(EmbeddingCache.read(file, key, 2))
            EmbeddingCache.write(file, key, vectors)
            assertNotNull(EmbeddingCache.read(file, key, 2))
        } finally { folder.deleteRecursively() }
    }
}
