package dev.ghostpantry

import java.nio.FloatBuffer
import org.junit.Assert.*
import org.junit.Test

class PackageDetectionMathTest {
    @Test fun normalizationUsesRgbPlanesAndImageNetValues() {
        val output = FloatBuffer.allocate(6)
        PackageDetectionMath.normalizeRgb(intArrayOf(0xffff0000.toInt(), 0xff0000ff.toInt()), output)
        assertEquals((1f - .485f) / .229f, output.get(0), 1e-6f)
        assertEquals(-.485f / .229f, output.get(1), 1e-6f)
        assertEquals(-.456f / .224f, output.get(2), 1e-6f)
        assertEquals(-.456f / .224f, output.get(3), 1e-6f)
        assertEquals(-.406f / .225f, output.get(4), 1e-6f)
        assertEquals((1f - .406f) / .225f, output.get(5), 1e-6f)
        assertEquals(0, output.position())
    }

    @Test fun sparseCocoIdsKeepLastClassAndIgnoreUnusedSlots() {
        val row = FloatArray(91) { -20f }.apply { this[0] = 80f; this[12] = 80f; this[90] = 2f }
        val result = PackageDetectionMath.decode(arrayOf(floatArrayOf(.5f, .5f, .4f, .2f)), arrayOf(row), mapOf(1 to "person", 90 to "toothbrush"))
        assertEquals("toothbrush", result.single().label)
        assertEquals(.880797f, result.single().score, 1e-6f)
        assertEquals(.3f, result.single().x, 1e-6f)
        assertEquals(.4f, result.single().y, 1e-6f)
        assertEquals(.4f, result.single().width, 1e-6f)
    }

    @Test fun oneClassPerQueryThresholdAndRankingAreIndependentOfOtherLogits() {
        val boxes = Array(14) { floatArrayOf(.5f, .5f, .2f, .2f) }
        val logits = Array(14) { i -> floatArrayOf(-80f, i.toFloat() / 10, -.5f) }
        val result = PackageDetectionMath.decode(boxes, logits, mapOf(1 to "bottle", 2 to "cup"))
        assertEquals(12, result.size)
        assertTrue(result.all { it.label == "bottle" })
        assertTrue(result.zipWithNext().all { (a, b) -> a.score >= b.score })
        assertTrue(PackageDetectionMath.decode(boxes, logits, mapOf(1 to "bottle"), .99f).isEmpty())
    }

    @Test fun invalidBoxesCannotProduceCropsAndBorderBoxesAreClipped() {
        val boxes = arrayOf(floatArrayOf(Float.NaN, .5f, .5f, .5f), floatArrayOf(.5f, .5f, -1f, 1f), floatArrayOf(2f, 2f, .2f, .2f), floatArrayOf(.1f, .1f, .4f, .4f))
        val result = PackageDetectionMath.decode(boxes, Array(4) { floatArrayOf(0f, 2f) }, mapOf(1 to "bottle"))
        assertEquals(1, result.size)
        assertEquals(0f, result.single().x, 0f)
        assertEquals(.3f, result.single().width, 1e-6f)
        assertTrue(PackageDetectionMath.decode(arrayOf(boxes.last()), arrayOf(floatArrayOf(0f, Float.NaN)), mapOf(1 to "bottle")).isEmpty())
    }
}
