package dev.ghostpantry

import org.junit.Assert.*
import org.junit.Test

class EmbeddingMathTest {
    private fun vector(first: Float, second: Float = 0f) = FloatArray(256).apply { this[0] = first; this[1] = second }

    @Test fun cosineRankingIsScaleIndependent() {
        val image = EmbeddingMath.normalize(vector(3f, 4f))
        val correct = EmbeddingMath.normalize(vector(6f, 8f))
        val opposite = EmbeddingMath.normalize(vector(-3f, -4f))
        val orthogonal = EmbeddingMath.normalize(vector(-4f, 3f))
        assertEquals(1.0, EmbeddingMath.similarity(image, correct), 1e-6)
        assertEquals(-1.0, EmbeddingMath.similarity(image, opposite), 1e-6)
        assertEquals(0.0, EmbeddingMath.similarity(image, orthogonal), 1e-6)
    }

    @Test fun invalidModelOutputCannotBecomeAConfidentMatch() {
        for (invalid in listOf(FloatArray(256), vector(Float.NaN), vector(Float.POSITIVE_INFINITY), FloatArray(128))) {
            try {
                EmbeddingMath.normalize(invalid)
                fail("Invalid embedding was accepted")
            } catch (_: IllegalArgumentException) { }
        }
    }

    @Test fun veryLargeFiniteValuesNormalizeWithoutFloatOverflow() {
        val result = EmbeddingMath.normalize(vector(Float.MAX_VALUE, Float.MAX_VALUE))
        assertTrue(result.all { it.isFinite() })
        assertEquals(1.0, EmbeddingMath.similarity(result, result), 1e-6)
    }
}
