package dev.ghostpantry

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File

/** Grants a camera app access only to the exact temporary JPEG we created. */
class PantryCameraProvider : ContentProvider() {
    override fun onCreate() = true

    private fun fileFor(uri: Uri): File {
        val root = File(requireNotNull(context).cacheDir, "pantry-captures").canonicalFile
        val name = uri.lastPathSegment ?: throw java.io.FileNotFoundException()
        if (!name.matches(Regex("shelf-[0-9]+\\.jpg"))) throw SecurityException("Invalid camera file")
        val file = File(root, name).canonicalFile
        if (file.parentFile != root || !file.isFile) throw java.io.FileNotFoundException()
        return file
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor =
        ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.parseMode(mode))

    override fun getType(uri: Uri) = "image/jpeg"
    override fun query(uri: Uri, projection: Array<String>?, selection: String?, selectionArgs: Array<String>?, sortOrder: String?): Cursor {
        val file = fileFor(uri)
        val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        return MatrixCursor(columns).apply {
            addRow(columns.map { when (it) { OpenableColumns.DISPLAY_NAME -> file.name; OpenableColumns.SIZE -> file.length(); else -> null } }.toTypedArray<Any?>())
        }
    }
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<String>?) = 0
}
