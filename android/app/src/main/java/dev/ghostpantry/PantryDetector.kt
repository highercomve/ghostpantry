package dev.ghostpantry

import android.content.Context
import android.graphics.BitmapFactory
import android.util.Base64
import org.json.JSONObject

/** Decode a bounded photo for the two-phase YOLOE food detector. */
object PantryDetector {
    fun detect(context: Context, input: JSONObject): JSONObject {
        val model = input.getString("detector")
        require(model == "yoloe")
        val threshold = input.optDouble("threshold", 0.25).toFloat()
        require(threshold.isFinite() && threshold in .1f.. .9f)
        val image = input.getString("image")
        require(image.startsWith("data:image/") && image.contains(";base64,"))
        val bytes = Base64.decode(image.substringAfter(";base64,"), Base64.DEFAULT)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        require(bounds.outWidth in 1..1600 && bounds.outHeight in 1..1600)
        val bitmap = requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size)) { "Cannot decode photo" }
        val started = System.nanoTime()
        try {
            return YoloePackageDetector.detect(context, bitmap, started, threshold)
        } finally { bitmap.recycle() }
    }
}
