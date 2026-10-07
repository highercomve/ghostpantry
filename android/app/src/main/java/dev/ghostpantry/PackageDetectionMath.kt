package dev.ghostpantry

import java.nio.FloatBuffer
import kotlin.math.exp

/** RF-DETR's exported contract: RGB/ImageNet NCHW input, cxcywh boxes, sigmoid logits. */
object PackageDetectionMath {
    data class Box(val x: Float, val y: Float, val width: Float, val height: Float, val label: String, val score: Float)
    private val mean = floatArrayOf(.485f, .456f, .406f)
    private val std = floatArrayOf(.229f, .224f, .225f)

    fun normalizeRgb(pixels: IntArray, output: FloatBuffer) {
        require(output.capacity() == pixels.size * 3)
        for (channel in 0..2) {
            val shift = 16 - channel * 8
            for (pixel in pixels) output.put((((pixel shr shift) and 255) / 255f - mean[channel]) / std[channel])
        }
        output.rewind()
    }

    fun decode(boxes: Array<FloatArray>, logits: Array<FloatArray>, classes: Map<Int, String>, threshold: Float = .25f, limit: Int = 12): List<Box> {
        require(boxes.size == logits.size && threshold in 0f..1f && limit in 1..12)
        val candidates = boxes.indices.mapNotNull { index ->
            val box = boxes[index]
            if (box.size != 4 || box.any { !it.isFinite() } || box[2] <= 0f || box[3] <= 0f) return@mapNotNull null
            val row = logits[index]
            // The published COCO weights use sparse IDs 1..90. Slot 90 is
            // toothbrush, not background; unused COCO IDs and slot 0 are ignored.
            val category = classes.keys.filter { it < row.size && it >= 0 && row[it].isFinite() }
                .maxByOrNull { row[it] } ?: return@mapNotNull null
            val score = (1.0 / (1.0 + exp(-row[category].toDouble().coerceIn(-88.0, 88.0)))).toFloat()
            if (score < threshold) return@mapNotNull null
            val left = (box[0] - box[2] / 2f).coerceIn(0f, 1f)
            val top = (box[1] - box[3] / 2f).coerceIn(0f, 1f)
            val right = (box[0] + box[2] / 2f).coerceIn(0f, 1f)
            val bottom = (box[1] + box[3] / 2f).coerceIn(0f, 1f)
            if (right <= left || bottom <= top) return@mapNotNull null
            Box(left, top, right - left, bottom - top, classes.getValue(category), score)
        }
        // DETR's set prediction needs no additional NMS. One class per query
        // avoids returning the same query once for each plausible COCO label.
        return candidates.sortedByDescending { it.score }.take(limit)
    }
}
