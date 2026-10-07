package dev.ghostpantry

import org.junit.Assert.*
import org.junit.Test
import java.nio.FloatBuffer

class YoloePackageMathTest {
    @Test fun acceptsEveryBundledModelAssetIncludingProduce() {
        val contract = listOf(
            java.io.File("src/main/assets/detectors/yoloe_packages.json"),
            java.io.File("app/src/main/assets/detectors/yoloe_packages.json"),
        ).first { it.isFile }.readText()
        val assets = Regex("\"file\"\\s*:\\s*\"([^\"]+)\"").findAll(contract).map { it.groupValues[1] }.toList()
        assertEquals(3, assets.size)
        assertTrue(assets.contains("yoloe_produce.onnx.bin"))
        assets.forEach { assertTrue("Bundled model rejected: $it", YoloePackageMath.isModelAsset(it)) }
        assertFalse(YoloePackageMath.isModelAsset("../yoloe_produce.onnx.bin"))
        assertFalse(YoloePackageMath.isModelAsset("other.onnx.bin"))
    }

    @Test fun resizePreservesAspectAndUsesMinimalStridePadding() {
        val resize = YoloePackageMath.resize(594,739)
        assertEquals(514,resize.width)
        assertEquals(640,resize.height)
        assertEquals(544,resize.inputWidth)
        assertEquals(640,resize.inputHeight)
        assertEquals(15,resize.left)
        assertEquals(0,resize.top)
        assertEquals(640f/739,resize.scale,1e-6f)
    }

    @Test fun overlappingTilesStayInsideOriginalPhoto() {
        val tiles = YoloePackageMath.tiles(594,739)
        assertEquals(4,tiles.size)
        assertEquals(YoloePackageMath.Tile(0,0,386,480),tiles[0])
        assertEquals(YoloePackageMath.Tile(208,259,386,480),tiles[3])
        assertTrue(tiles.all { it.x >= 0 && it.y >= 0 && it.x+it.width <= 594 && it.y+it.height <= 739 })
    }

    @Test fun mapsTilePixelsToSourceCoordinatesWithoutSigmoid() {
        val row = floatArrayOf(0f,0f,320f,640f,.8f,0f,Float.NaN)
        val boxes = YoloePackageMath.decode(arrayOf(row),listOf("package"),YoloePackageMath.Tile(25,50,50,100),100,200,.1f)
        assertEquals(1,boxes.size)
        val box = boxes.single()
        assertEquals(.25f,box.x,1e-6f)
        assertEquals(.25f,box.y,1e-6f)
        assertEquals(.5f,box.width,1e-6f)
        assertEquals(.5f,box.height,1e-6f)
        assertEquals(.8f,box.score,1e-6f)
    }

    @Test fun undoesPaddingAndRejectsInvalidOrEmptyBoxes() {
        val tile = YoloePackageMath.Tile(0,0,594,739)
        val resize = YoloePackageMath.resize(tile.width,tile.height)
        val valid = floatArrayOf(15f,0f,529f,640f,.2f,0f)
        val invalid = listOf(valid.copyOf().also { it[0]=Float.NaN },
            valid.copyOf().also { it[5]=1.5f },valid.copyOf().also { it[5]=9f },
            valid.copyOf().also { it[4]=1.2f },floatArrayOf(0f,0f,14f,600f,.8f,0f))
        val boxes = YoloePackageMath.decode((listOf(valid)+invalid).toTypedArray(),listOf("bag"),tile,594,739,.1f)
        assertEquals(1,boxes.size)
        assertEquals(0f,boxes[0].x,1e-6f)
        assertEquals(514f/resize.scale/594,boxes[0].width,1e-6f)
    }

    @Test fun suppressesDuplicatesAcrossPromptClassesAndCapsTwelve() {
        val box = YoloePackageMath.Box(0f,0f,.1f,.1f,"bag",.9f)
        val duplicate = box.copy(label="box",score=.8f)
        val separated = (1..15).map { box.copy(x=it*.2f,score=.7f) }
        val boxes = YoloePackageMath.suppress(listOf(box,duplicate)+separated,.3f)
        assertEquals(12,boxes.size)
        assertEquals("bag",boxes[0].label)
        assertFalse(boxes.any { it.label=="box" })
        assertEquals(1f,YoloePackageMath.iou(box,duplicate),1e-6f)
    }

    @Test fun normalizesRgbInPlanarOrder() {
        val output = FloatBuffer.allocate(6)
        YoloePackageMath.normalize(intArrayOf(0xffff0000.toInt(),0xff0000ff.toInt()),output)
        val values = FloatArray(6)
        output.get(values)
        assertArrayEquals(floatArrayOf(1f,0f,0f,0f,0f,1f),values,1e-6f)
    }

    @Test fun decodesChannelMajorProbabilitiesAndIgnoresMaskCoefficients() {
        val channels = Array(38) { FloatArray(3) }
        channels[0] = floatArrayOf(160f,Float.NaN,160f)
        channels[1].fill(320f)
        channels[2].fill(320f)
        channels[3].fill(640f)
        channels[4].fill(.05f)
        channels[5] = floatArrayOf(.8f,.9f,.09f)
        channels[6].fill(Float.NaN)
        val boxes = YoloePackageMath.decodeChannels(channels,listOf("bag","box"),
            YoloePackageMath.Tile(0,0,100,200),100,200,.1f)
        assertEquals(1,boxes.size)
        assertEquals("box",boxes[0].label)
        assertEquals(.8f,boxes[0].score,1e-6f)
        assertEquals(1f,boxes[0].width,1e-6f)
        assertEquals(1f,boxes[0].height,1e-6f)
    }
    @Test fun decodesExpandedPackagePromptsIncludingJarsAndCartons() {
        val labels = listOf("bag of pasta", "bag of rice", "packet of instant noodles", "box of pasta", "glass jar", "plastic bottle", "milk carton")
        for (category in 4..6) {
            val channels = Array(4 + labels.size + 32) { FloatArray(1) }
            channels[0][0] = 320f
            channels[1][0] = 320f
            channels[2][0] = 640f
            channels[3][0] = 640f
            channels[4 + category][0] = .8f
            val boxes = YoloePackageMath.decodeChannels(channels, labels,
                YoloePackageMath.Tile(0,0,100,100),100,100,.1f)
            assertEquals(labels[category], boxes.single().label)
        }
    }

    @Test fun mergedPhasesKeepBothBudgetsAndRemoveSharedObjects() {
        val packages = (0..7).map { YoloePackageMath.Box(it*.1f,0f,.05f,.05f,"package",.7f) }
        val produce = (0..7).map { YoloePackageMath.Box(it*.1f,.5f,.05f,.05f,"avocado",.8f) }
        val merged = YoloePackageMath.mergePhases(packages,produce)
        assertEquals(16,merged.size)
        assertEquals(8,merged.count { it.label=="package" })
        assertEquals(8,merged.count { it.label=="avocado" })
        val duplicate = packages[0].copy(label="vegetable",score=.9f)
        val deduplicated = YoloePackageMath.mergePhases(packages,produce+duplicate)
        assertEquals(16,deduplicated.size)
        assertTrue(deduplicated.contains(duplicate))
        assertFalse(deduplicated.contains(packages[0]))
        assertEquals(24,YoloePackageMath.mergePhases(
            (0..15).map { packages[0].copy(x=it*.1f) },
            (0..15).map { produce[0].copy(x=it*.1f) }).size)
    }

}
