package dev.ghostpantry

import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.io.File

class EmbeddingFeedbackTest {
    private fun vector(index: Int) = FloatArray(256).apply { this[index] = 1f }

    @Test fun explicitFeedbackAdjustsOnlySimilarPhotosAndNewerDecisionWins() {
        val photo = vector(0)
        val accepted = EmbeddingFeedback.remember(emptyList(), "Rice noodles", true, photo)
        assertEquals(0.12, EmbeddingFeedback.adjustment(accepted, "rice noodles", photo), 1e-6)
        assertEquals(0.0, EmbeddingFeedback.adjustment(accepted, "rice noodles", vector(1)), 1e-6)
        assertEquals(0.0, EmbeddingFeedback.adjustment(accepted, "pasta", photo), 1e-6)
        val rejected = EmbeddingFeedback.remember(accepted, "rice noodles", false, photo)
        assertEquals(1, rejected.size)
        assertEquals(-0.12, EmbeddingFeedback.adjustment(rejected, "RICE NOODLES", photo), 1e-6)
        val nearby = FloatArray(256).apply { this[0] = .97f; this[1] = kotlin.math.sqrt(1f - .97f * .97f) }
        val adjusted = EmbeddingFeedback.adjustment(rejected, "rice noodles", nearby)
        assertTrue(adjusted < 0 && adjusted > -0.12)
    }

    @Test fun correctionsSurviveRestartAndAreBoundedAndConfigurationSpecific() {
        val folder = Files.createTempDirectory("feedback-test").toFile()
        try {
            val file = File(folder, "corrections.bin")
            var examples = emptyList<EmbeddingFeedback.Example>()
            repeat(140) { examples = EmbeddingFeedback.remember(examples, "food $it", true, vector(0)) }
            assertEquals(128, examples.size)
            assertEquals("food 12", examples.first().label)
            EmbeddingFeedback.write(file, "model-v1|cpu", examples)
            val restored = EmbeddingFeedback.read(file, "model-v1|cpu")
            assertEquals(128, restored.size)
            assertEquals(0.12, EmbeddingFeedback.adjustment(restored, "food 139", vector(0)), 1e-6)
            assertTrue(EmbeddingFeedback.read(file, "model-v2|cpu").isEmpty())
            file.delete()
            assertTrue(EmbeddingFeedback.read(file, "model-v1|cpu").isEmpty())
        } finally { folder.deleteRecursively() }
    }

    @Test fun damagedMemoryIsReportedAndInvalidLabelsAreRejected() {
        val folder = Files.createTempDirectory("feedback-corrupt-test").toFile()
        try {
            val file = File(folder, "corrections.bin")
            EmbeddingFeedback.write(file, "model", EmbeddingFeedback.remember(emptyList(), "pasta", false, vector(0)))
            file.writeBytes(file.readBytes().apply { this[40] = (this[40].toInt() xor 1).toByte() })
            try { EmbeddingFeedback.read(file, "model"); fail("Expected corrupt memory error") } catch (_: java.io.IOException) { }
            for (label in listOf("", "x".repeat(121), "rice\nnoodles")) {
                try { EmbeddingFeedback.remember(emptyList(), label, true, vector(0)); fail("Expected invalid label") }
                catch (_: IllegalArgumentException) { }
            }
        } finally { folder.deleteRecursively() }
    }
}
