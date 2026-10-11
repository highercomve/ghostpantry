package dev.ghostpantry

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Log
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import dev.oriel.OrielAndroidExtension
import dev.oriel.OrielAndroidExtensionContext
import java.io.File
import java.util.WeakHashMap
import java.util.concurrent.Executors

/** App-owned photo behavior; Oriel only dispatches its generic extension hooks. */
class PantryAndroidExtension : OrielAndroidExtension {
    private class Capture(val view: WebView, var callback: ValueCallback<Array<Uri>>?, var file: File? = null, var uri: Uri? = null)
    private val captures = WeakHashMap<Activity, Capture>()
    private lateinit var context: OrielAndroidExtensionContext
    override fun onRegistered(context: OrielAndroidExtensionContext) { this.context = context }
    private val photoRequest get() = context.requestCode(1)
    private val permissionRequest get() = context.requestCode(2)
    private val galleryRequest get() = context.requestCode(3)
    // Gallery transcoding decodes whole photos: keep it off the UI thread.
    private val decoder by lazy { Executors.newSingleThreadExecutor { Thread(it, "GhostPantry-photo-decode") } }
    private val mainThread = Handler(Looper.getMainLooper())

    override fun onWebViewCreated(view: WebView, windowLabel: String) {
        // The system gallery hands WebView content:// URIs instead of file paths.
        view.settings.allowContentAccess = true
    }

    override fun onShowFileChooser(activity: Activity, view: WebView, callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        val wantsImages = params.acceptTypes.isNotEmpty() && params.acceptTypes.all { it.startsWith("image/") }
        if (!wantsImages) return false
        clear(activity)
        captures[activity] = Capture(view, callback)
        if (params.isCaptureEnabled && activity.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            launchCamera(activity)
        } else if (params.isCaptureEnabled) {
            try { activity.requestPermissions(arrayOf(Manifest.permission.CAMERA), permissionRequest) }
            catch (error: Exception) { Log.w(TAG, "Camera permission request failed", error); clear(activity) }
        } else {
            launchGallery(activity)
        }
        return true
    }

    private fun launchCamera(activity: Activity) {
        val capture = captures[activity] ?: return
        try {
            val directory = File(activity.cacheDir, "pantry-captures").apply { mkdirs() }
            directory.listFiles()?.filter { it.lastModified() < System.currentTimeMillis() - 86400000 }?.forEach { delete(it) }
            val file = File.createTempFile("shelf-", ".jpg", directory)
            val uri = Uri.Builder().scheme("content").authority("${activity.packageName}.pantry.camera").appendPath(file.name).build()
            capture.file = file
            capture.uri = uri
            val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                putExtra(MediaStore.EXTRA_OUTPUT, uri)
                clipData = ClipData.newRawUri("Shelf photo", uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }
            @Suppress("DEPRECATION")
            activity.startActivityForResult(intent, photoRequest)
        } catch (error: Exception) { Log.w(TAG, "Camera could not start", error); clear(activity) }
    }

    /** The system photo picker: gallery photos arrive as content:// URIs. */
    private fun launchGallery(activity: Activity) {
        val capture = captures[activity] ?: return
        try {
            val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                type = "image/*"
                addCategory(Intent.CATEGORY_OPENABLE)
            }
            @Suppress("DEPRECATION")
            activity.startActivityForResult(intent, galleryRequest)
        } catch (error: Exception) { Log.w(TAG, "Photo picker could not start", error); clear(activity) }
    }

    /** Formats the WebView itself decodes; everything else (HEIC/HEIF, AVIF,
        BMP, files the provider mislabels) is transcoded to JPEG natively,
        which Android decodes even when the WebView cannot. */
    private val webviewReadableTypes = setOf("image/jpeg", "image/png", "image/webp", "image/gif")

    private class Served(val uri: Uri, val file: File?)

    /** Runs on the decoder thread: touches only the application context, never
        the Capture, which belongs to the UI thread. */
    private fun serveReadableImage(app: Context, picked: Uri): Served {
        val type = try { app.contentResolver.getType(picked) } catch (error: Exception) { Log.w(TAG, "Photo type unknown", error); null }
        if (type != null && type in webviewReadableTypes) return Served(picked, null)
        // Throwable: a large photo can still exhaust the heap, and an Error must
        // not escape the decoder thread.
        return try { transcodeToJpeg(app, picked) } catch (error: Throwable) { Log.w(TAG, "Photo transcoding failed", error); Served(picked, null) }
    }

    /** Decode with Android's codecs (HEIF orientation is applied at decode
        time) and re-encode as JPEG no larger than the webview and the AI
        providers need; on any failure the original URI keeps the webview's
        own error message. */
    private fun transcodeToJpeg(app: Context, picked: Uri): Served {
        val resolver = app.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(picked)?.use { input -> BitmapFactory.decodeStream(input, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IllegalStateException("Not a decodable image")
        // The frontend downsizes to 1600 px anyway (photos.ts), so decode at
        // most about twice that: a full-size photo is 50-90 MB as ARGB.
        var sample = 1
        var longest = maxOf(bounds.outWidth, bounds.outHeight)
        // Largest power-of-two step that keeps at least MAX_SIDE (the page
        // scales down to it): a 4000 px photo decodes at 2000, not 1000.
        while (longest / 2 >= MAX_SIDE && sample < 64) { sample *= 2; longest /= 2 }
        val options = BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 }
        val bitmap = resolver.openInputStream(picked)?.use { input -> BitmapFactory.decodeStream(input, null, options) }
            ?: throw IllegalStateException("Decoding this photo failed")
        val file = try {
            val directory = File(app.cacheDir, "pantry-captures").apply { mkdirs() }
            val output = File.createTempFile("shelf-", ".jpg", directory)
            try {
                output.outputStream().use { out -> bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out) }
                if (output.length() == 0L) throw IllegalStateException("Encoding this photo failed")
            } catch (error: Throwable) { delete(output); throw error }
            output
        } finally {
            bitmap.recycle()
        }
        return Served(Uri.Builder().scheme("content").authority("${app.packageName}.pantry.camera").appendPath(file.name).build(), file)
    }

    override fun onRequestPermissionsResult(activity: Activity, requestCode: Int, permissions: Array<String>, grantResults: IntArray): Boolean {
        if (requestCode != permissionRequest) return false
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) launchCamera(activity) else clear(activity)
        return true
    }

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != photoRequest && requestCode != galleryRequest) return false
        val capture = captures[activity] ?: return true
        val callback = capture.callback
        capture.callback = null
        val picked: Uri? = when {
            resultCode != Activity.RESULT_OK -> null
            requestCode == photoRequest ->
                if ((capture.file?.length() ?: 0L) > 0L && capture.uri != null) capture.uri else null
            else -> data?.data
        }
        if (picked != null) {
            if (requestCode == photoRequest) {
                capture.uri?.let { activity.revokeUriPermission(it, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) }
            }
            if (requestCode == photoRequest) callback?.onReceiveValue(arrayOf(picked))
            else deliverGalleryPhoto(activity, capture, callback, picked)
        } else {
            callback?.onReceiveValue(null)
            clear(activity)
        }
        return true
    }

    /** Transcode on the decoder thread, then answer the WebView on the UI
        thread, unless the chooser was cleared meanwhile (clear() already
        answered it with null). */
    private fun deliverGalleryPhoto(activity: Activity, capture: Capture, callback: ValueCallback<Array<Uri>>?, picked: Uri) {
        capture.callback = callback
        val app = activity.applicationContext
        decoder.execute {
            val served = serveReadableImage(app, picked)
            mainThread.post {
                val current = capture.callback
                if (captures[activity] !== capture || current == null) { served.file?.let { delete(it) }; return@post }
                capture.callback = null
                if (served.file != null) {
                    capture.file?.takeIf { it != served.file }?.let { delete(it) }
                    capture.file = served.file
                }
                current.onReceiveValue(arrayOf(served.uri))
            }
        }
    }

    override fun onActivityDestroyed(activity: Activity) { clear(activity) }
    override fun onWebViewDestroyed(view: WebView, windowLabel: String) {
        captures.entries.filter { it.value.view === view }.map { it.key }.forEach { clear(it) }
    }

    private fun clear(activity: Activity) {
        val capture = captures.remove(activity) ?: return
        capture.callback?.onReceiveValue(null)
        capture.uri?.let { activity.revokeUriPermission(it, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) }
        capture.file?.let { delete(it) }
    }

    /** Cache files only: a failed delete is logged, and launchCamera's sweep
        retries anything older than a day. */
    private fun delete(file: File) {
        if (file.exists() && !file.delete()) Log.w(TAG, "Cannot delete ${file.name}")
    }

    private companion object {
        const val TAG = "GhostPantryPhoto"
        const val MAX_SIDE = 1600
    }

}
