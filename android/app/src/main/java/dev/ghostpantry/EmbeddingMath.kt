package dev.ghostpantry

import kotlin.math.sqrt

/** Explicit normalization also detects malformed or numerically unstable SDK results. */
object EmbeddingMath {
    fun normalize(vector: FloatArray): FloatArray {
        require(vector.size == 256) { "Expected a 256-dimensional embedding" }
        require(vector.all { it.isFinite() }) { "Model returned non-finite embedding values" }
        val length = sqrt(vector.sumOf { it.toDouble() * it.toDouble() })
        require(length > 1e-12) { "Model returned an empty embedding" }
        return FloatArray(vector.size) { (vector[it] / length).toFloat() }
    }

    fun similarity(a: FloatArray, b: FloatArray): Double {
        require(a.size == b.size)
        return a.indices.sumOf { a[it].toDouble() * b[it].toDouble() }.coerceIn(-1.0, 1.0)
    }
}
