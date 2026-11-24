package app.alextran.immich.upload

import android.content.Context
import android.content.SharedPreferences
import io.tus.java.client.TusURLStore
import java.net.URL

/**
 * URL store implementation using SharedPreferences for persisting upload URLs
 * to enable resumable uploads across app restarts.
 */
class TusPreferencesURLStore(context: Context, private val uploadId: String) : TusURLStore {
  companion object {
    private const val PREFS_NAME = "tus_upload_urls"
  }

  private val prefs: SharedPreferences =
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  override fun set(fingerprint: String, url: URL) {
    prefs.edit().putString(getKey(fingerprint), url.toString()).apply()
  }

  override fun get(fingerprint: String): URL? {
    val urlString = prefs.getString(getKey(fingerprint), null)
    return urlString?.let { URL(it) }
  }

  override fun remove(fingerprint: String) {
    prefs.edit().remove(getKey(fingerprint)).apply()
  }

  private fun getKey(fingerprint: String): String {
    return "${uploadId}_$fingerprint"
  }

  /**
   * Clear all stored URLs for this upload
   */
  fun clear() {
    val editor = prefs.edit()
    prefs.all.keys
      .filter { it.startsWith("${uploadId}_") }
      .forEach { editor.remove(it) }
    editor.apply()
  }

  /**
   * Clear all stored upload URLs
   */
  fun clearAll() {
    prefs.edit().clear().apply()
  }
}
