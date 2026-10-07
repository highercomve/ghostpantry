package dev.ghostpantry

import java.nio.FloatBuffer
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Fixed-prompt YOLOE one-to-many output: pixel cxcywh, class probabilities, masks. */
object YoloePackageMath {
    data class Box(val x: Float, val y: Float, val width: Float, val height: Float, val label: String, val score: Float)
    fun isModelAsset(asset: String): Boolean = asset in setOf(
        "yoloe_packages_whole.onnx.bin", "yoloe_packages_tiles.onnx.bin", "yoloe_produce.onnx.bin",
    )

    data class Tile(val x: Int, val y: Int, val width: Int, val height: Int)
    data class Resize(val scale: Float, val width: Int, val height: Int, val left: Int, val top: Int,
                      val inputWidth: Int, val inputHeight: Int)

    fun resize(width: Int, height: Int, side: Int = 640): Resize {
        require(width > 0 && height > 0 && side > 0)
        val scale = min(side.toFloat() / width, side.toFloat() / height)
        val w = max(1, (width * scale).roundToInt())
        val h = max(1, (height * scale).roundToInt())
        val inputWidth = ((w+31)/32)*32
        val inputHeight = ((h+31)/32)*32
        return Resize(scale, w, h, (inputWidth-w)/2, (inputHeight-h)/2, inputWidth, inputHeight)
    }

    fun tiles(width: Int, height: Int): List<Tile> {
        val w = (width * .65f).roundToInt().coerceIn(1, width)
        val h = (height * .65f).roundToInt().coerceIn(1, height)
        return listOf(Tile(0, 0, w, h), Tile(width-w, 0, w, h),
            Tile(0, height-h, w, h), Tile(width-w, height-h, w, h))
    }

    fun normalize(pixels: IntArray, output: FloatBuffer) {
        require(output.capacity() == pixels.size * 3)
        for (channel in 0..2) {
            val shift = 16-channel*8
            for (pixel in pixels) output.put(((pixel shr shift) and 255)/255f)
        }
        output.rewind()
    }

    fun decode(rows: Array<FloatArray>, labels: List<String>, tile: Tile, photoWidth: Int,
               photoHeight: Int, threshold: Float): List<YoloePackageMath.Box> {
        require(photoWidth > 0 && photoHeight > 0 && threshold in 0f..1f)
        val resize = resize(tile.width, tile.height)
        return rows.mapNotNull { row ->
            if (row.size < 6 || row.take(6).any { !it.isFinite() }) return@mapNotNull null
            val score = row[4]
            val category = row[5].toInt()
            if (score < threshold || score > 1f || row[5] != category.toFloat() || category !in labels.indices) return@mapNotNull null
            val left = ((row[0]-resize.left)/resize.scale).coerceIn(0f, tile.width.toFloat())
            val top = ((row[1]-resize.top)/resize.scale).coerceIn(0f, tile.height.toFloat())
            val right = ((row[2]-resize.left)/resize.scale).coerceIn(0f, tile.width.toFloat())
            val bottom = ((row[3]-resize.top)/resize.scale).coerceIn(0f, tile.height.toFloat())
            if (right <= left || bottom <= top) return@mapNotNull null
            YoloePackageMath.Box((tile.x+left)/photoWidth, (tile.y+top)/photoHeight,
                (right-left)/photoWidth, (bottom-top)/photoHeight, labels[category], score)
        }
    }

    fun decodeChannels(channels: Array<FloatArray>, labels: List<String>, tile: Tile,
                       photoWidth: Int, photoHeight: Int, threshold: Float): List<YoloePackageMath.Box> {
        require(labels.size in 1..8 && channels.size == 4+labels.size+32)
        val count = channels[0].size
        require(count in 1..8400 && channels.all { it.size == count })
        val rows = mutableListOf<FloatArray>()
        for (index in 0 until count) {
            val category = labels.indices.filter { channels[4+it][index].isFinite() }
                .maxByOrNull { channels[4+it][index] } ?: continue
            val score = channels[4+category][index]
            if (score < threshold || score > 1f) continue
            val cx = channels[0][index]
            val cy = channels[1][index]
            val w = channels[2][index]
            val h = channels[3][index]
            if (w <= 0f || h <= 0f) continue
            rows.add(floatArrayOf(cx-w/2,cy-h/2,cx+w/2,cy+h/2,score,category.toFloat()))
        }
        return decode(rows.toTypedArray(),labels,tile,photoWidth,photoHeight,threshold)
    }

    fun iou(a: YoloePackageMath.Box, b: YoloePackageMath.Box): Float {
        val intersection = max(0f, min(a.x+a.width, b.x+b.width)-max(a.x,b.x)) *
            max(0f, min(a.y+a.height,b.y+b.height)-max(a.y,b.y))
        val union = a.width*a.height+b.width*b.height-intersection
        return if (union > 0f) intersection/union else 0f
    }

    fun suppress(boxes: List<YoloePackageMath.Box>, threshold: Float = .3f, limit: Int = 12): List<YoloePackageMath.Box> {
        require(threshold in 0f..1f && limit in 1..24)
        val result = mutableListOf<YoloePackageMath.Box>()
        for (box in boxes.sortedByDescending { it.score }.take(512)) {
            if (result.all { iou(box, it) < threshold }) result.add(box)
            if (result.size == limit) break
        }
        return result
    }
    fun mergePhases(packages: List<YoloePackageMath.Box>, produce: List<YoloePackageMath.Box>, threshold: Float = .3f): List<YoloePackageMath.Box> {
        // Each phase gets its own proposal budget before cross-phase deduplication.
        return suppress(suppress(packages,threshold) + suppress(produce,threshold),threshold,24)
    }

}
