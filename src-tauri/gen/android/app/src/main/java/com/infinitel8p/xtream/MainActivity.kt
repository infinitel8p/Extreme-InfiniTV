package com.infinitel8p.xtream

import android.app.ActivityManager
import android.content.ComponentCallbacks2
import android.content.Context
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebSettings
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.enableEdgeToEdge
import androidx.activity.OnBackPressedCallback
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import android.app.PictureInPictureParams
import android.util.Log
import android.util.Rational
import android.os.Build
import android.webkit.JavascriptInterface
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.graphics.Bitmap
import android.net.Uri
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Base64
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.RequiresApi
import app.tauri.plugin.PluginManager
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.IntentFilter
import android.graphics.BitmapFactory
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import java.net.URL

@RequiresApi(Build.VERSION_CODES.O)
private class RenderGoneGuardingClient(
  private val delegate: WebViewClient,
  private val onRenderGone: (WebView, RenderProcessGoneDetail) -> Unit,
) : WebViewClient() {
  override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
    delegate.shouldInterceptRequest(view, request)

  override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
    delegate.shouldOverrideUrlLoading(view, request)

  override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
    delegate.onPageStarted(view, url, favicon)
  }

  override fun onPageFinished(view: WebView, url: String) {
    delegate.onPageFinished(view, url)
  }

  override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
    delegate.onReceivedError(view, request, error)
  }

  override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
    onRenderGone(view, detail)
    return true
  }
}

// wry's RustWebChromeClient.onShowCustomView calls callback.onCustomViewHidden()
// and returns immediately, declining to host the HTML5 fullscreen custom view.
// We replace it with this plain subclass that actually attaches the SurfaceView
// to the activity decor, which is what `<video>`.requestFullscreen() needs.
private class FullscreenAwareChromeClient(
  private val onShow: (View, CustomViewCallback) -> Unit,
  private val onHide: () -> Unit,
) : WebChromeClient() {
  override fun onShowCustomView(view: View, callback: CustomViewCallback) {
    onShow(view, callback)
  }

  override fun onHideCustomView() {
    onHide()
  }
}

class StatusBarBridge(private val activity: TauriActivity) {
  @JavascriptInterface
  fun setAppearance(isLight: Boolean) {
    activity.runOnUiThread {
      val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
      controller.isAppearanceLightStatusBars = isLight
      controller.isAppearanceLightNavigationBars = isLight
    }
  }
}

class WebSettingsBridge(
  private val activity: TauriActivity,
  private val webViewRef: () -> WebView?,
  private val defaultUa: String,
) {
  @JavascriptInterface
  fun setUserAgent(ua: String?) {
    val target = if (ua.isNullOrEmpty()) defaultUa else ua
    activity.runOnUiThread {
      webViewRef()?.settings?.userAgentString = target
    }
  }
}

// JS focus() alone doesn't summon the IME in an Android WebView; needs an explicit showSoftInput.
class ImeBridge(
  private val activity: TauriActivity,
  private val webViewRef: () -> WebView?,
) {
  @JavascriptInterface
  fun show() {
    activity.runOnUiThread {
      try {
        val webView = webViewRef() ?: return@runOnUiThread
        // No requestFocus here: it resets the WebView's DOM focus to the first anchor.
        // Delay past the WebView's InputConnection rebuild; flag 0 = explicit request, SHOW_IMPLICIT gets ignored on TVs.
        webView.postDelayed({
          try {
            val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            if (!imm.showSoftInput(webView, 0)) {
              Log.w("xtream-rs", "AndroidIme.show: showSoftInput returned false")
            }
          } catch (e: Throwable) {
            Log.w("xtream-rs", "AndroidIme.show failed: $e")
          }
        }, 80L)
      } catch (e: Throwable) {
        Log.w("xtream-rs", "AndroidIme.show failed: $e")
      }
    }
  }

  @JavascriptInterface
  fun hide() {
    activity.runOnUiThread {
      try {
        val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(webViewRef()?.windowToken, 0)
      } catch (e: Throwable) {
        Log.w("xtream-rs", "AndroidIme.hide failed: $e")
      }
    }
  }
}

// Falls back to the system Vibrator when the view/system haptic path reports failure.
class HapticsBridge(
  private val activity: TauriActivity,
  private val webViewProvider: () -> WebView?,
) {
  @JavascriptInterface
  fun perform(kind: String) {
    activity.runOnUiThread {
      val view = webViewProvider() ?: return@runOnUiThread
      val constant = when (kind) {
        "confirm" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          HapticFeedbackConstants.CONFIRM
        } else {
          HapticFeedbackConstants.KEYBOARD_TAP
        }
        else -> HapticFeedbackConstants.CLOCK_TICK
      }
      view.isHapticFeedbackEnabled = true
      val performed = view.performHapticFeedback(constant)
      // False can mean "unsupported" or "user disabled the system setting" - only the former should fall back.
      if (!performed && systemHapticFeedbackEnabled()) {
        vibrateFallback(kind)
      }
    }
  }

  private fun systemHapticFeedbackEnabled(): Boolean {
    return try {
      Settings.System.getInt(activity.contentResolver, Settings.System.HAPTIC_FEEDBACK_ENABLED, 1) != 0
    } catch (error: Throwable) {
      true
    }
  }

  private fun vibrateFallback(kind: String) {
    try {
      val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val manager = activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
        manager.defaultVibrator
      } else {
        @Suppress("DEPRECATION")
        activity.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
      }
      if (!vibrator.hasVibrator()) return
      when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> {
          val effect = if (kind == "confirm") VibrationEffect.EFFECT_CLICK else VibrationEffect.EFFECT_TICK
          vibrator.vibrate(VibrationEffect.createPredefined(effect))
        }
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O -> {
          val durationMs = if (kind == "confirm") 20L else 10L
          vibrator.vibrate(VibrationEffect.createOneShot(durationMs, VibrationEffect.DEFAULT_AMPLITUDE))
        }
        else -> {
          @Suppress("DEPRECATION")
          vibrator.vibrate(if (kind == "confirm") 20L else 10L)
        }
      }
    } catch (error: Throwable) {
      Log.w("HapticsBridge", "vibrate fallback failed", error)
    }
  }
}

class DeviceInfoBridge(private val activity: TauriActivity) {
  @JavascriptInterface
  fun isLeanback(): Boolean =
    activity.packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)

  @JavascriptInterface
  fun isTelevisionUiMode(): Boolean {
    val uiMode = activity.resources.configuration.uiMode and
      Configuration.UI_MODE_TYPE_MASK
    return uiMode == Configuration.UI_MODE_TYPE_TELEVISION
  }

  @JavascriptInterface
  fun isTv(): Boolean = isLeanback() || isTelevisionUiMode()

  // Feeds motion.ts's classifyEffectTier: below ~256MB signals a low-end TV box even when
  // navigator.deviceMemory (Chromium WebView) doesn't reliably report one.
  @JavascriptInterface
  fun getMemoryClass(): Int {
    return try {
      val manager = activity.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      manager.memoryClass
    } catch (e: Throwable) {
      0
    }
  }

  @JavascriptInterface
  fun getInstallSource(): String {
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        activity.packageManager.getInstallSourceInfo(activity.packageName).installingPackageName ?: ""
      } else {
        @Suppress("DEPRECATION")
        activity.packageManager.getInstallerPackageName(activity.packageName) ?: ""
      }
    } catch (e: Throwable) {
      ""
    }
  }

  @JavascriptInterface
  fun getPackageName(): String = activity.packageName

  @JavascriptInterface
  fun getDeviceName(): String {
    return try {
      val name = Settings.Global.getString(activity.contentResolver, Settings.Global.DEVICE_NAME)
      if (!name.isNullOrBlank()) name else Build.MODEL ?: ""
    } catch (e: Throwable) {
      Build.MODEL ?: ""
    }
  }
}

// System screensaver handoff: Settings > Display > Screen saver has no API to preselect
// an entry, so this only opens the picker; the user still has to choose XtreamDreamService.
class ScreensaverBridge(private val activity: TauriActivity) {
  @JavascriptInterface
  fun isDreamSettingsAvailable(): Boolean {
    return try {
      resolveDreamSettingsActivity() != null
    } catch (e: Throwable) {
      false
    }
  }

  @JavascriptInterface
  fun openDreamSettings(): Boolean {
    if (resolveDreamSettingsActivity() == null) return false
    val intent = Intent(Settings.ACTION_DREAM_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    activity.runOnUiThread {
      try {
        activity.startActivity(intent)
      } catch (e: ActivityNotFoundException) {
        Log.w("xtream-rs", "openDreamSettings startActivity threw: $e")
      } catch (e: Throwable) {
        Log.w("xtream-rs", "openDreamSettings launch threw: $e")
      }
    }
    return true
  }

  private fun resolveDreamSettingsActivity(): ResolveInfo? {
    val intent = Intent(Settings.ACTION_DREAM_SETTINGS)
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      activity.packageManager.resolveActivity(intent, PackageManager.ResolveInfoFlags.of(0))
    } else {
      @Suppress("DEPRECATION")
      activity.packageManager.resolveActivity(intent, 0)
    }
  }
}

// {dataDir}/logs isn't a declared FileProvider root, so the newest log file is copied to the cache dir first and shared from there.
class LogShareBridge(private val activity: TauriActivity) {
  // Mirrors PathPlugin.kt's getConfigDir(): tauri-plugin-log writes to app_log_dir() = configDir/logs.
  private fun expectedLogDir(): File {
    val configDir = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      activity.dataDir
    } else {
      File(activity.applicationInfo.dataDir)
    }
    return File(configDir, "logs")
  }

  @JavascriptInterface
  fun shareNewestLog(logDirPath: String?): Boolean {
    if (logDirPath.isNullOrBlank()) return false
    val logDir = File(logDirPath)
    val matchesExpectedDir = try {
      logDir.canonicalFile == expectedLogDir().canonicalFile
    } catch (e: Throwable) {
      Log.w("xtream-rs", "shareNewestLog canonicalFile failed: $e")
      false
    }
    if (!matchesExpectedDir) {
      Log.w("xtream-rs", "shareNewestLog rejected untrusted path: $logDirPath")
      return false
    }
    val newestLogFile = logDir.listFiles { file -> file.isFile && file.name.endsWith(".log") }
      ?.maxByOrNull { it.lastModified() }
      ?: return false
    val shareDir = File(activity.cacheDir, "logshare").apply { mkdirs() }
    val shareCopy = File(shareDir, newestLogFile.name)
    try {
      newestLogFile.copyTo(shareCopy, overwrite = true)
    } catch (e: Throwable) {
      Log.w("xtream-rs", "shareNewestLog copyTo failed: $e")
      return false
    }
    val logUri = try {
      FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", shareCopy)
    } catch (e: Throwable) {
      Log.w("xtream-rs", "shareNewestLog getUriForFile failed: $e")
      return false
    }
    val sendIntent = Intent(Intent.ACTION_SEND).apply {
      type = "text/plain"
      putExtra(Intent.EXTRA_STREAM, logUri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    val chooser = Intent.createChooser(sendIntent, newestLogFile.name).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    activity.runOnUiThread {
      try {
        activity.startActivity(chooser)
      } catch (e: ActivityNotFoundException) {
        Log.w("xtream-rs", "shareNewestLog startActivity threw: $e")
      } catch (e: Throwable) {
        Log.w("xtream-rs", "shareNewestLog launch threw: $e")
      }
    }
    return true
  }
}

// External-video-app handoff:
//   viewStream(url, mime, ua, referer, title)
//       -> Intent.ACTION_VIEW with createChooser() so the user picks the
//          target app (MX Player / VLC / MPV-Android / Just Player / etc.).
//   openInVlc(url, mime, ua, referer, title)
//       -> Direct Intent.ACTION_VIEW pinned to org.videolan.vlc when
//          installed; throws if not. UI should call isVlcInstalled() first.
class IntentBridge(private val activity: TauriActivity) {
  companion object {
    private const val VLC_PACKAGE = "org.videolan.vlc"
    private const val MX_PRO_PACKAGE = "com.mxtech.videoplayer.pro"
    private const val MX_FREE_PACKAGE = "com.mxtech.videoplayer.ad"
    private const val DEFAULT_MIME = "video/*"
    private const val ICON_PX = 96
    private val ALLOWED_SCHEMES = setOf("http", "https", "content", "file")
  }

  @JavascriptInterface
  fun isVlcInstalled(): Boolean = isPackageInstalled(VLC_PACKAGE)

  @JavascriptInterface
  fun isMxPlayerInstalled(): Boolean =
    isPackageInstalled(MX_PRO_PACKAGE) || isPackageInstalled(MX_FREE_PACKAGE)

  /**
   * Open via system chooser. Returns true synchronously when a handler
   * exists; false when nothing on the device can play the URI. The
   * startActivity call is dispatched fire-and-forget so the JS bridge
   * thread never blocks waiting for the launch.
   */
  @JavascriptInterface
  fun viewStream(
    url: String?,
    mime: String?,
    userAgent: String?,
    referer: String?,
    title: String?,
  ): Boolean {
    val uri = parseUri(url) ?: return false
    val intent = buildViewIntent(uri, mime, userAgent, referer, title)
    if (intent.resolveActivity(activity.packageManager) == null) return false
    val chooser = Intent.createChooser(
      intent,
      title?.takeIf { it.isNotBlank() } ?: "Open with"
    )
    dispatchStartActivity(chooser, "viewStream")
    return true
  }

  /**
   * Open directly in VLC. Returns true synchronously when VLC is installed
   * and resolves the intent; false otherwise. UI should fall back to
   * viewStream() or hide the button on false.
   */
  @JavascriptInterface
  fun openInVlc(
    url: String?,
    mime: String?,
    userAgent: String?,
    referer: String?,
    title: String?,
  ): Boolean {
    val uri = parseUri(url) ?: return false
    if (!isPackageInstalled(VLC_PACKAGE)) return false
    val intent = buildViewIntent(uri, mime, userAgent, referer, title).apply {
      setPackage(VLC_PACKAGE)
    }
    if (intent.resolveActivity(activity.packageManager) == null) return false
    dispatchStartActivity(intent, "openInVlc")
    return true
  }

  /**
   * Enumerate installed apps that can handle a VIEW intent for the given
   * URI + MIME. Returns a compact JSON array of {pkg,label,activity}.
   *
   * We use this so the UI can present its own picker dialog and then
   * launch via openInPackage(). Bypassing Android's createChooser()
   * sidesteps a long-standing VLC-on-Android quirk: chooser-routed
   * intents sometimes resolve to VLC's main UI / playback service
   * instead of VideoPlayerActivity, which produces a "playing"
   * notification but no actual video. Direct setPackage launch always
   * resolves to the right activity.
   */
  @JavascriptInterface
  fun listVideoPlayerApps(url: String?, mime: String?): String {
    val uri = parseUri(url) ?: return "[]"
    val resolvedMime = mime?.trim()?.takeIf { it.isNotEmpty() } ?: DEFAULT_MIME
    val probe = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, resolvedMime)
    }
    val pm = activity.packageManager
    val resolved: List<ResolveInfo> = try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        pm.queryIntentActivities(probe, PackageManager.ResolveInfoFlags.of(0))
      } else {
        @Suppress("DEPRECATION")
        pm.queryIntentActivities(probe, 0)
      }
    } catch (e: Throwable) {
      Log.w("xtream-rs", "listVideoPlayerApps query failed: $e")
      return "[]"
    }
    val selfPackage = activity.packageName
    val seenPackages = HashSet<String>()
    val entries = ArrayList<String>(resolved.size)
    for (ri in resolved) {
      val info = ri.activityInfo ?: continue
      val pkg = info.packageName ?: continue
      if (pkg == selfPackage) continue
      if (!seenPackages.add(pkg)) continue
      val label = try {
        ri.loadLabel(pm)?.toString()?.takeIf { it.isNotBlank() } ?: pkg
      } catch (e: Throwable) {
        pkg
      }
      val activityName = info.name ?: ""
      val iconDataUri = try {
        encodeIconAsDataUri(ri.loadIcon(pm))
      } catch (e: Throwable) {
        Log.w("xtream-rs", "loadIcon for $pkg failed: $e")
        ""
      }
      entries.add(
        "{\"pkg\":\"${escapeJson(pkg)}\"," +
          "\"label\":\"${escapeJson(label)}\"," +
          "\"activity\":\"${escapeJson(activityName)}\"," +
          "\"icon\":\"${escapeJson(iconDataUri)}\"}"
      )
    }
    return "[${entries.joinToString(",")}]"
  }

  // Render the launcher Drawable into a fixed-size PNG and return a
  // data: URI so the WebView can paint it directly. Adaptive icons
  // (Android 8+ AdaptiveIconDrawable) draw correctly through the
  // standard Drawable.draw() path - we don't need special handling.
  private fun encodeIconAsDataUri(drawable: Drawable?): String {
    if (drawable == null) return ""
    val targetPx = ICON_PX
    val bitmap = if (
      drawable is BitmapDrawable &&
      drawable.bitmap != null &&
      !drawable.bitmap.isRecycled
    ) {
      Bitmap.createScaledBitmap(drawable.bitmap, targetPx, targetPx, true)
    } else {
      val intrinsicW = drawable.intrinsicWidth
      val intrinsicH = drawable.intrinsicHeight
      val w = if (intrinsicW > 0) intrinsicW.coerceAtMost(targetPx) else targetPx
      val h = if (intrinsicH > 0) intrinsicH.coerceAtMost(targetPx) else targetPx
      val out = Bitmap.createBitmap(targetPx, targetPx, Bitmap.Config.ARGB_8888)
      val canvas = Canvas(out)
      // Center the icon if its intrinsic aspect differs from the target.
      val left = (targetPx - w) / 2
      val top = (targetPx - h) / 2
      drawable.setBounds(left, top, left + w, top + h)
      drawable.draw(canvas)
      out
    }
    return try {
      val baos = ByteArrayOutputStream()
      bitmap.compress(Bitmap.CompressFormat.PNG, 100, baos)
      val base64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
      "data:image/png;base64,$base64"
    } finally {
      // Recycle only if we allocated; BitmapDrawable's source bitmap is
      // owned by the system and the scaled copy is what we encoded.
      try { bitmap.recycle() } catch (_: Throwable) {}
    }
  }

  /**
   * Launch a VIEW intent pinned to a specific package. Mirrors openInVlc
   * but for any app the UI's custom picker selected.
   *
   * We DO NOT setComponent() even though we receive an activity name from
   * the picker - setPackage() alone is essential. When both setPackage
   * and setComponent are present the component takes precedence and
   * Android skips intent-filter resolution inside the package. For VLC
   * (https://wiki.videolan.org/Android_Player_Intents/) the right entry
   * point is `org.videolan.vlc.gui.video.VideoPlayerActivity`, but
   * queryIntentActivities can also return aliased / non-player matches
   * (StartActivity, MainActivity, library entries) that fire VLC's
   * playback notification without ever loading the URL. Letting Android
   * pick the highest-priority match inside the package always lands us
   * on the player activity. `activityName` stays in the signature for
   * future / debug use.
   */
  @JavascriptInterface
  fun openInPackage(
    pkg: String?,
    @Suppress("UNUSED_PARAMETER") activityName: String?,
    url: String?,
    mime: String?,
    userAgent: String?,
    referer: String?,
    title: String?,
  ): Boolean {
    if (pkg.isNullOrBlank()) return false
    val uri = parseUri(url) ?: return false
    val intent = buildViewIntent(uri, mime, userAgent, referer, title).apply {
      setPackage(pkg)
    }
    if (intent.resolveActivity(activity.packageManager) == null) return false
    dispatchStartActivity(intent, "openInPackage($pkg)")
    return true
  }

  private fun escapeJson(value: String): String {
    val out = StringBuilder(value.length + 2)
    for (ch in value) {
      when {
        ch == '\\' -> out.append("\\\\")
        ch == '"' -> out.append("\\\"")
        ch == '\n' -> out.append("\\n")
        ch == '\r' -> out.append("\\r")
        ch == '\t' -> out.append("\\t")
        ch.code < 0x20 -> out.append(String.format("\\u%04x", ch.code))
        else -> out.append(ch)
      }
    }
    return out.toString()
  }


  private fun parseUri(url: String?): Uri? {
    val trimmed = url?.trim().orEmpty()
    if (trimmed.isEmpty()) return null
    val parsed = try {
      Uri.parse(trimmed)
    } catch (e: Throwable) {
      Log.w("xtream-rs", "IntentBridge.parseUri rejected '$trimmed': $e")
      return null
    }
    val scheme = parsed.scheme?.lowercase()
    if (scheme.isNullOrEmpty() || scheme !in ALLOWED_SCHEMES) {
      Log.w("xtream-rs", "IntentBridge.parseUri rejected scheme '$scheme'")
      return null
    }
    return parsed
  }

  private fun buildViewIntent(
    uri: Uri,
    mime: String?,
    userAgent: String?,
    referer: String?,
    title: String?,
  ): Intent {
    val resolvedMime = mime?.trim()?.takeIf { it.isNotEmpty() } ?: DEFAULT_MIME
    return Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, resolvedMime)
      // NEW_TASK on the target intent (not just on the chooser wrapper) so
      // the player launches in its own task. Without this VLC misbehaves
      // when chooser-routed - it inherits our app's task stack and the
      // HLS open path silently fails. GRANT_READ_URI_PERMISSION matters
      // for content:// URIs; harmless for http(s).
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      val headerPairs = mutableListOf<String>()
      if (!userAgent.isNullOrBlank()) {
        headerPairs += "User-Agent"
        headerPairs += userAgent
        putExtra(":http-user-agent", userAgent)
        putExtra("http-user-agent", userAgent)
      }
      if (!referer.isNullOrBlank()) {
        headerPairs += "Referer"
        headerPairs += referer
        putExtra(":http-referrer", referer)
      }
      if (headerPairs.isNotEmpty()) {
        putExtra("headers", headerPairs.toTypedArray())
      }
      if (!title.isNullOrBlank()) {
        putExtra("title", title)
        putExtra(Intent.EXTRA_TITLE, title)
      }
    }
  }

  private fun isPackageInstalled(pkg: String): Boolean {
    return try {
      val pm = activity.packageManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        pm.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(0))
      } else {
        @Suppress("DEPRECATION")
        pm.getPackageInfo(pkg, 0)
      }
      true
    } catch (e: PackageManager.NameNotFoundException) {
      false
    } catch (e: Throwable) {
      Log.w("xtream-rs", "isPackageInstalled($pkg) failed: $e")
      false
    }
  }

  // Fire-and-forget UI-thread launch
  private fun dispatchStartActivity(intent: Intent, context: String) {
    activity.runOnUiThread {
      try {
        activity.startActivity(intent)
      } catch (e: ActivityNotFoundException) {
        Log.w("xtream-rs", "$context startActivity threw: $e")
      } catch (e: SecurityException) {
        Log.w("xtream-rs", "$context blocked by SecurityException: $e")
      } catch (e: Throwable) {
        Log.w("xtream-rs", "$context launch threw: $e")
      }
    }
  }
}

class PipBridge(private val activity: TauriActivity) {
  @JavascriptInterface
  fun isSupported(): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
    activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

  @JavascriptInterface
  fun isInPip(): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && activity.isInPictureInPictureMode

  @JavascriptInterface
  fun enter() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      activity.runOnUiThread {
        val params = PictureInPictureParams.Builder()
          .setAspectRatio(Rational(16, 9))
          .build()
        activity.enterPictureInPictureMode(params)
      }
    }
  }

  // Programmatically expand out of PiP by bringing the Activity to the front
  @JavascriptInterface
  fun expand() {
    activity.runOnUiThread {
      val intent = Intent(activity, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      activity.startActivity(intent)
    }
  }

  @JavascriptInterface
  fun toggle() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (activity.isInPictureInPictureMode) expand() else enter()
  }

  // Called by the JS auto-pip helper whenever a <video> starts/stops playing.
  // Two effects: persist the flag onto MainActivity so onUserLeaveHint can
  // auto-enter PiP on the home-button path (API 26-30), and on API 31+ push
  // setAutoEnterEnabled into PictureInPictureParams so Android handles the
  // gesture-home path itself (onUserLeaveHint isn't reliably fired for the
  // gesture nav).
  @JavascriptInterface
  fun setAutoEnter(enabled: Boolean) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    Log.d("xtream-pip", "setAutoEnter($enabled) bridge call, sdk=${Build.VERSION.SDK_INT}")
    activity.runOnUiThread {
      (activity as? MainActivity)?.autoEnterPipEnabled = enabled
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        try {
          val params = PictureInPictureParams.Builder()
            .setAspectRatio(Rational(16, 9))
            .setAutoEnterEnabled(enabled)
            .build()
          activity.setPictureInPictureParams(params)
          Log.d("xtream-pip", "setPictureInPictureParams(autoEnter=$enabled) applied")
        } catch (e: Throwable) {
          Log.w("xtream-pip", "setPictureInPictureParams failed", e)
        }
      }
    }
  }
}

// Receiver auto-discovery via mDNS/DNS-SD. Advertise runs on a receiving device,
// startDiscovery/drainDiscovered on a sender looking for one. NsdManager only
// allows one resolveService in flight, so found services queue and resolve one at a time.
class NsdBridge(private val activity: TauriActivity) {
  companion object {
    private const val TAG = "AndroidNsd"
    private const val SERVICE_TYPE = "_xtream-recv._tcp."
    private const val MAX_SERVICE_NAME_LEN = 63
  }

  private val nsdManager: NsdManager? by lazy {
    try {
      activity.getSystemService(Context.NSD_SERVICE) as? NsdManager
    } catch (error: Throwable) {
      Log.w(TAG, "getSystemService(NSD_SERVICE) failed", error)
      null
    }
  }

  private val lock = Any()
  private var registrationListener: NsdManager.RegistrationListener? = null
  private var requestedServiceName: String? = null
  private var advertisedServiceName: String? = null
  @Volatile private var lastAdvertiseState: String = "off"

  private var discoveryListener: NsdManager.DiscoveryListener? = null
  private var resolving = false
  private val resolveQueue = ArrayDeque<NsdServiceInfo>()
  private val discovered = mutableListOf<String>()
  private val seenKeys = mutableSetOf<String>()

  @JavascriptInterface
  fun isSupported(): Boolean = nsdManager != null

  @JavascriptInterface
  fun advertise(name: String?, port: Int, id: String?) {
    val manager = nsdManager ?: return
    val serviceName = (name?.trim().orEmpty()).take(MAX_SERVICE_NAME_LEN).ifEmpty { "xtream" }
    synchronized(lock) {
      registrationListener?.let { unregisterLocked(manager, it) }
      registrationListener = null
      lastAdvertiseState = "pending"
      val serviceInfo = NsdServiceInfo().apply {
        this.serviceName = serviceName
        this.serviceType = SERVICE_TYPE
        this.port = port
        if (!id.isNullOrEmpty()) {
          setAttribute("id", id)
        }
      }
      val listener = object : NsdManager.RegistrationListener {
        override fun onServiceRegistered(info: NsdServiceInfo) {
          Log.d(TAG, "advertise registered: ${info.serviceName}")
          advertisedServiceName = info.serviceName
          lastAdvertiseState = "registered"
        }
        override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) {
          Log.w(TAG, "advertise registration failed: $errorCode")
          lastAdvertiseState = "failed:$errorCode"
          synchronized(lock) { if (registrationListener === this) registrationListener = null }
        }
        override fun onServiceUnregistered(info: NsdServiceInfo) {
          Log.d(TAG, "advertise unregistered: ${info.serviceName}")
        }
        override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) {
          Log.w(TAG, "advertise unregistration failed: $errorCode")
        }
      }
      registrationListener = listener
      requestedServiceName = serviceName
      advertisedServiceName = serviceName
      try {
        manager.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, listener)
      } catch (error: Throwable) {
        Log.w(TAG, "registerService threw", error)
        lastAdvertiseState = "failed:exception"
        registrationListener = null
      }
    }
  }

  @JavascriptInterface
  fun stopAdvertise() {
    val manager = nsdManager ?: return
    synchronized(lock) {
      registrationListener?.let { unregisterLocked(manager, it) }
      registrationListener = null
      requestedServiceName = null
      advertisedServiceName = null
      lastAdvertiseState = "off"
    }
  }

  @JavascriptInterface
  fun advertiseState(): String = lastAdvertiseState

  @JavascriptInterface
  fun startDiscovery() {
    val manager = nsdManager ?: return
    synchronized(lock) {
      discoveryListener?.let { stopDiscoveryLocked(manager, it) }
      discoveryListener = null
      discovered.clear()
      seenKeys.clear()
      resolveQueue.clear()
      resolving = false
      val listener = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(serviceType: String) {
          Log.d(TAG, "discovery started")
        }
        override fun onServiceFound(info: NsdServiceInfo) {
          if (info.serviceName == advertisedServiceName || info.serviceName == requestedServiceName) return
          enqueueResolve(manager, info)
        }
        override fun onServiceLost(info: NsdServiceInfo) {
          Log.d(TAG, "service lost: ${info.serviceName}")
        }
        override fun onDiscoveryStopped(serviceType: String) {
          Log.d(TAG, "discovery stopped")
        }
        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
          Log.w(TAG, "start discovery failed: $errorCode")
          synchronized(lock) { if (discoveryListener === this) discoveryListener = null }
        }
        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
          Log.w(TAG, "stop discovery failed: $errorCode")
        }
      }
      discoveryListener = listener
      try {
        manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
      } catch (error: Throwable) {
        Log.w(TAG, "discoverServices threw", error)
        discoveryListener = null
      }
    }
  }

  @JavascriptInterface
  fun stopDiscovery() {
    val manager = nsdManager ?: return
    synchronized(lock) {
      discoveryListener?.let { stopDiscoveryLocked(manager, it) }
      discoveryListener = null
      resolveQueue.clear()
      resolving = false
    }
  }

  @JavascriptInterface
  fun drainDiscovered(): String {
    synchronized(lock) {
      if (discovered.isEmpty()) return "[]"
      val joined = discovered.joinToString(",")
      discovered.clear()
      return "[$joined]"
    }
  }

  private fun unregisterLocked(manager: NsdManager, listener: NsdManager.RegistrationListener) {
    try {
      manager.unregisterService(listener)
    } catch (error: Throwable) {
      Log.w(TAG, "unregisterService threw", error)
    }
  }

  private fun stopDiscoveryLocked(manager: NsdManager, listener: NsdManager.DiscoveryListener) {
    try {
      manager.stopServiceDiscovery(listener)
    } catch (error: Throwable) {
      Log.w(TAG, "stopServiceDiscovery threw", error)
    }
  }

  private fun enqueueResolve(manager: NsdManager, info: NsdServiceInfo) {
    synchronized(lock) {
      resolveQueue.add(info)
      if (!resolving) {
        resolving = true
        resolveNextLocked(manager)
      }
    }
  }

  private fun resolveNextLocked(manager: NsdManager) {
    val next = resolveQueue.removeFirstOrNull()
    if (next == null) {
      resolving = false
      return
    }
    val listener = object : NsdManager.ResolveListener {
      override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
        Log.w(TAG, "resolve failed for ${info.serviceName}: $errorCode")
        synchronized(lock) { resolveNextLocked(manager) }
      }
      override fun onServiceResolved(info: NsdServiceInfo) {
        addResolved(info)
        synchronized(lock) { resolveNextLocked(manager) }
      }
    }
    try {
      manager.resolveService(next, listener)
    } catch (error: Throwable) {
      Log.w(TAG, "resolveService threw", error)
      resolveNextLocked(manager)
    }
  }

  private fun addResolved(info: NsdServiceInfo) {
    val hosts = resolvedHostAddresses(info)
    if (hosts.isEmpty()) return
    val host = hosts.first()
    val port = info.port
    val id = readTxtAttribute(info, "id")
    val key = if (id != null) "id:$id" else "$host:$port"
    synchronized(lock) {
      if (!seenKeys.add(key)) return
      val hostsJson = hosts.joinToString(",") { "\"${escapeJson(it)}\"" }
      val idJson = id?.let { ",\"id\":\"${escapeJson(it)}\"" } ?: ""
      discovered.add(
        "{\"name\":\"${escapeJson(info.serviceName ?: "")}\"," +
          "\"host\":\"${escapeJson(host)}\"," +
          "\"port\":$port," +
          "\"hosts\":[$hostsJson]" +
          "$idJson}"
      )
    }
  }

  // API 34+ can report multiple resolved addresses (IPv4 first); older resolveService only ever gave one.
  private fun resolvedHostAddresses(info: NsdServiceInfo): List<String> {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      val addresses = info.hostAddresses
      val ipv4 = addresses.filterIsInstance<java.net.Inet4Address>().mapNotNull { it.hostAddress }
      val ipv6 = addresses.filter { it !is java.net.Inet4Address }.mapNotNull { it.hostAddress }
      val ordered = ipv4 + ipv6
      if (ordered.isNotEmpty()) return ordered
    }
    return info.host?.hostAddress?.let { listOf(it) } ?: emptyList()
  }

  private fun readTxtAttribute(info: NsdServiceInfo, key: String): String? {
    return try {
      info.attributes[key]?.let { String(it, Charsets.UTF_8) }
    } catch (error: Throwable) {
      Log.w(TAG, "reading txt attribute '$key' threw", error)
      null
    }
  }

  private fun escapeJson(value: String): String {
    val out = StringBuilder(value.length + 2)
    for (ch in value) {
      when {
        ch == '\\' -> out.append("\\\\")
        ch == '"' -> out.append("\\\"")
        ch.code < 0x20 -> out.append(String.format("\\u%04x", ch.code))
        else -> out.append(ch)
      }
    }
    return out.toString()
  }

  // Called from MainActivity.onDestroy so registration/discovery listeners never leak.
  fun activityDestroyed() {
    val manager = nsdManager
    synchronized(lock) {
      if (manager != null) {
        registrationListener?.let { unregisterLocked(manager, it) }
        discoveryListener?.let { stopDiscoveryLocked(manager, it) }
      }
      registrationListener = null
      discoveryListener = null
      resolveQueue.clear()
      resolving = false
    }
  }
}

// Starts/stops ReceiverForegroundService, which holds the wake lock + Wi-Fi
// lock keeping the receiver's HTTP server alive while the app is backgrounded.
class ReceiverKeepAliveBridge(private val activity: MainActivity) {
  companion object {
    private const val NOTIFICATION_PERMISSION_REQUEST_CODE = 4303
  }

  @JavascriptInterface
  fun start(deviceName: String): Boolean {
    return try {
      requestNotificationPermissionIfNeeded()
      val intent = Intent(activity, ReceiverForegroundService::class.java)
        .setAction(ReceiverForegroundService.ACTION_START)
        .putExtra(ReceiverForegroundService.EXTRA_DEVICE_NAME, deviceName)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        activity.startForegroundService(intent)
      } else {
        activity.startService(intent)
      }
      activity.receiverModeActive = true
      true
    } catch (error: Throwable) {
      Log.w("ReceiverKeepAlive", "start failed", error)
      false
    }
  }

  // The wake/status-poll notifications (ReceiverWakeBridge) need POST_NOTIFICATIONS
  // too, but that permission was only ever requested from the cast-media path.
  private fun requestNotificationPermissionIfNeeded() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    if (ActivityCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) ==
      PackageManager.PERMISSION_GRANTED
    ) {
      return
    }
    try {
      ActivityCompat.requestPermissions(
        activity,
        arrayOf(Manifest.permission.POST_NOTIFICATIONS),
        NOTIFICATION_PERMISSION_REQUEST_CODE
      )
    } catch (error: Throwable) {
      Log.w("ReceiverKeepAlive", "requestPermissions failed", error)
    }
  }

  @JavascriptInterface
  fun stop(): Boolean {
    activity.receiverModeActive = false
    return try {
      activity.startService(
        Intent(activity, ReceiverForegroundService::class.java)
          .setAction(ReceiverForegroundService.ACTION_STOP)
      )
      true
    } catch (error: Throwable) {
      Log.w("ReceiverKeepAlive", "stop failed", error)
      false
    }
  }

  // Scopes onPause()'s WebView keep-resumed workaround to when /receiver is actually visible,
  // rather than for the app's whole lifetime once receiver mode is enabled.
  @JavascriptInterface
  fun setReceiverPageForeground(active: Boolean) {
    activity.receiverPageForeground = active
  }
}

// A cast POST arriving while the WebView is backgrounded can only foreground the app on Android 9 and older.
// On Android 10+ background activity starts are blocked, so we post a tap-to-open notification instead.
class ReceiverWakeBridge(private val activity: MainActivity) {
  companion object {
    private const val TAG = "AndroidReceiverWake"
    private const val CHANNEL_ID = "receiver_wake"
    private const val NOTIFICATION_ID = 4401
  }

  @JavascriptInterface
  fun isSupported(): Boolean {
    return try {
      if (!NotificationManagerCompat.from(activity).areNotificationsEnabled()) return false
      true
    } catch (error: Throwable) {
      Log.w(TAG, "isSupported failed", error)
      false
    }
  }

  @JavascriptInterface
  fun wake(): Boolean {
    return try {
      XtreamDreamService.dismissActiveDream()
      val intent = wakeIntent()
      // Q+ can only be offered a tap-to-open notification, so wake() reports false there.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        postWakeNotification(intent)
        return false
      }
      activity.startActivity(intent)
      true
    } catch (error: Throwable) {
      Log.w(TAG, "wake failed", error)
      false
    }
  }

  private fun wakeIntent(): Intent =
    Intent(activity, MainActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)

  private fun postWakeNotification(intent: Intent) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ActivityCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) !=
        PackageManager.PERMISSION_GRANTED
    ) {
      return
    }
    ensureNotificationChannel()
    val pendingIntent = PendingIntent.getActivity(activity, 0, intent, PendingIntent.FLAG_IMMUTABLE)
    val notification = NotificationCompat.Builder(activity, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_brand_mark)
      .setContentTitle(activity.getString(R.string.receiver_wake_notification_title))
      .setContentText(activity.getString(R.string.receiver_wake_notification_text))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_EVENT)
      .setOngoing(false)
      .setAutoCancel(true)
      .setContentIntent(pendingIntent)
      .build()
    try {
      NotificationManagerCompat.from(activity).notify(NOTIFICATION_ID, notification)
    } catch (error: SecurityException) {
      Log.w(TAG, "notify blocked by SecurityException", error)
    }
  }

  fun clearWakeNotification() {
    try {
      NotificationManagerCompat.from(activity).cancel(NOTIFICATION_ID)
    } catch (error: Throwable) {
      Log.w(TAG, "cancel failed", error)
    }
  }

  private fun ensureNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = activity.getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    manager.createNotificationChannel(
      NotificationChannel(
        CHANNEL_ID,
        activity.getString(R.string.receiver_wake_notification_channel),
        NotificationManager.IMPORTANCE_HIGH
      )
    )
  }
}

/**
 * Bridge for the native ExoPlayer-backed VideoActivity. Opt-in path (Settings:
 * "Use native Android video player"). JS calls one of launchVod / launchLive
 * to start playback in the native Activity. drainEvents() pulls queued
 * progress / channel-changed / finished events written by VideoActivity into
 * SharedPreferences; MainActivity.onResume also drains and dispatches them as
 * DOM CustomEvents on the WebView automatically.
 *
 * receiverSessionStart/-End/-Control/-Volume back the TV receiver mode: while a cast
 * session is playing through VideoActivity, events are pushed straight into
 * the WebView instead of waiting for the SharedPreferences drain, and remote
 * control commands route to NativePlayerControl instead of a fresh Intent.
 */
class AndroidVideoBridge(
  private val activity: MainActivity,
  private val hostedWebViewRef: () -> WebView?,
) {
  @JavascriptInterface
  fun isSupported(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.N

  @JavascriptInterface
  fun launchVod(
    contentKey: String,
    url: String,
    ua: String,
    referer: String,
    title: String,
    posterUrl: String,
    startMs: Long,
    dns: String,
  ): Boolean {
    return tryLaunch(VideoActivity.MODE_VOD) { intent ->
      intent.putExtra(VideoActivity.EXTRA_URL, url)
      intent.putExtra(VideoActivity.EXTRA_START_MS, startMs)
      intent.putExtra(VideoActivity.EXTRA_CONTENT_KEY, contentKey)
      intent.putExtra(VideoActivity.EXTRA_UA, ua)
      intent.putExtra(VideoActivity.EXTRA_REFERER, referer)
      intent.putExtra(VideoActivity.EXTRA_TITLE, title)
      intent.putExtra(VideoActivity.EXTRA_POSTER, posterUrl)
      intent.putExtra(VideoActivity.EXTRA_DNS, dns)
    }
  }

  @JavascriptInterface
  fun launchLive(
    contentKey: String,
    channelsJson: String,
    initialChannelId: String,
    ua: String,
    referer: String,
    dns: String,
  ): Boolean {
    NativePlayerPayload.setChannels(channelsJson)
    val launched = tryLaunch(VideoActivity.MODE_LIVE) { intent ->
      intent.putExtra(VideoActivity.EXTRA_INITIAL_CHANNEL_ID, initialChannelId)
      intent.putExtra(VideoActivity.EXTRA_CONTENT_KEY, contentKey)
      intent.putExtra(VideoActivity.EXTRA_UA, ua)
      intent.putExtra(VideoActivity.EXTRA_REFERER, referer)
      intent.putExtra(VideoActivity.EXTRA_DNS, dns)
    }
    // The Activity never started to consume it - don't leave a stale payload for a later launch.
    if (!launched) NativePlayerPayload.clearChannels()
    return launched
  }

  @JavascriptInterface
  fun drainEvents(): String {
    return EventQueue.drain(activity)
  }

  @JavascriptInterface
  fun receiverSessionStart(): Boolean {
    activity.receiverSessionActive = true
    EventQueue.pushListener = { type, payload ->
      val webView = hostedWebViewRef()
      if (webView == null) {
        false
      } else {
        val script = dispatchScript(type, payload)
        activity.runOnUiThread { webView.evaluateJavascript(script, null) }
        true
      }
    }
    return true
  }

  @JavascriptInterface
  fun receiverSessionEnd() {
    activity.receiverSessionActive = false
    EventQueue.pushListener = null
    if (NativePlayerControl.isActive()) NativePlayerControl.finishPlayback()
    setKeepScreenOn(false)
  }

  @JavascriptInterface
  fun setTvOverscan(percent: Int) {
    TvOverscanState.percent = percent.coerceIn(0, 8)
  }

  @JavascriptInterface
  fun setKeepScreenOn(enabled: Boolean) {
    activity.runOnUiThread {
      if (enabled) {
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (XtreamDreamService.dismissActiveDream()) {
          Log.d("AndroidVideoBridge", "dismissed active dream for receiver playback")
        }
      } else {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      }
    }
  }

  @JavascriptInterface
  fun receiverControl(action: String, positionMs: Long): Boolean {
    val wasActive = NativePlayerControl.isActive()
    when (action) {
      "pause" -> NativePlayerControl.setPlayWhenReady(false)
      "resume" -> NativePlayerControl.setPlayWhenReady(true)
      "seek" -> NativePlayerControl.seekToMs(positionMs)
      "stop" -> NativePlayerControl.finishPlayback()
    }
    return wasActive
  }

  @JavascriptInterface
  fun receiverVolume(level: Double, muted: Boolean): Boolean {
    val wasActive = NativePlayerControl.isActive()
    NativePlayerControl.setVolume(level.toFloat(), muted)
    return wasActive
  }

  // Mirrors MainActivity.drainAndDispatchVideoEvents' escaping approach for a single event.
  private fun dispatchScript(type: String, payload: JSONObject): String {
    val entry = JSONObject().put("type", type).put("payload", payload)
    return """
      (function(){
        try {
          var evt = $entry;
          document.dispatchEvent(new CustomEvent(evt.type, { detail: evt.payload }));
        } catch (_) {}
      })();
    """.trimIndent()
  }

  private fun tryLaunch(mode: String, configure: (android.content.Intent) -> Unit): Boolean {
    return try {
      val intent = android.content.Intent(activity, VideoActivity::class.java)
      intent.putExtra(VideoActivity.EXTRA_MODE, mode)
      intent.putExtra(VideoActivity.EXTRA_TV_OVERSCAN_PERCENT, TvOverscanState.percent)
      configure(intent)
      activity.runOnUiThread {
        try {
          activity.startActivity(intent)
        } catch (error: Throwable) {
          Log.w("AndroidVideoBridge", "launch $mode startActivity failed", error)
        }
      }
      true
    } catch (error: Throwable) {
      Log.w("AndroidVideoBridge", "launch $mode dispatch failed", error)
      false
    }
  }
}

// "Add from website" sniffer: throwaway offscreen WebView, URL prefilter only; sniff-classify.ts classifies.
class SnifferBridge(
  private val activity: TauriActivity,
  private val hostedWebViewRef: () -> WebView?,
) {
  companion object {
    private const val TAG = "AndroidSniffer"
    private val MANIFEST_EXTENSION_RX = Regex("\\.(m3u8|mpd)(?:[?#]|$)", RegexOption.IGNORE_CASE)
    private val MANIFEST_HINT_RX = Regex("mpegurl|dash", RegexOption.IGNORE_CASE)
    private const val NUDGE_DELAY_MS = 900L
    private const val THROWAWAY_SIZE_PX = 1
    private const val MAX_CANDIDATE_DISPATCHES = 100

    // Mirrors MAX_FIELD_LEN in sniffer.rs.
    private const val MAX_FIELD_BYTES = 8 * 1024
  }

  private val handler = Handler(Looper.getMainLooper())
  private var throwawayWebView: WebView? = null
  private var timeoutRunnable: Runnable? = null

  @Volatile
  private var lastFavicon: String? = null

  // shouldInterceptRequest can run off the UI thread, so this page-controlled bookkeeping needs thread-safe primitives.
  private val reportedCandidateUrls: MutableSet<String> =
    java.util.Collections.newSetFromMap(java.util.concurrent.ConcurrentHashMap<String, Boolean>())
  private val candidateDispatchCount = java.util.concurrent.atomic.AtomicInteger(0)
  private val drmReported = java.util.concurrent.atomic.AtomicBoolean(false)
  private val faviconReported = java.util.concurrent.atomic.AtomicBoolean(false)

  // Bumped on start/teardown so in-flight work from an old session is dropped.
  private val sniffGeneration = java.util.concurrent.atomic.AtomicLong(0L)

  // addJavascriptInterface reflects every @JavascriptInterface method regardless of name, so the throwaway WebView gets this report-only object, never SnifferBridge itself.
  inner class SnifferReportBridge {
    @JavascriptInterface
    fun reportDrm(generation: String?) {
      this@SnifferBridge.reportDrm(generation)
    }

    @JavascriptInterface
    fun reportFavicon(favicon: String?, generation: String?) {
      this@SnifferBridge.reportFavicon(favicon, generation)
    }
  }

  @JavascriptInterface
  fun startSniff(pageUrl: String?, timeoutMs: Int) {
    val url = pageUrl?.trim().orEmpty()
    if (url.isEmpty()) return
    val scheme = Uri.parse(url).scheme
    if (!scheme.equals("http", ignoreCase = true) && !scheme.equals("https", ignoreCase = true)) {
      Log.w(TAG, "startSniff rejected non-http(s) url")
      activity.runOnUiThread { teardown(fireDone = true) }
      return
    }
    activity.runOnUiThread {
      // Firing xt:sniff-done here would race the listeners this very call just attached.
      teardown(fireDone = false)
      val generation = sniffGeneration.incrementAndGet()
      lastFavicon = null
      reportedCandidateUrls.clear()
      candidateDispatchCount.set(0)
      drmReported.set(false)
      faviconReported.set(false)
      try {
        val webView = WebView(activity)
        throwawayWebView = webView
        webView.settings.javaScriptEnabled = true
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = false
        webView.addJavascriptInterface(SnifferReportBridge(), "AndroidSnifferInternal")
        webView.webViewClient = object : WebViewClient() {
          override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest,
          ): WebResourceResponse? {
            maybeEmitCandidate(request, generation)
            return null
          }

          override fun onPageFinished(view: WebView, finishedUrl: String) {
            nudgePlayback(view, generation)
          }
        }
        val decor = activity.window.decorView as? ViewGroup
        decor?.addView(webView, FrameLayout.LayoutParams(THROWAWAY_SIZE_PX, THROWAWAY_SIZE_PX))
        timeoutRunnable = Runnable {
          if (!isCurrentSniff(generation)) return@Runnable
          teardown(fireDone = true)
        }
        handler.postDelayed(timeoutRunnable!!, timeoutMs.coerceAtLeast(1000).toLong())
        webView.loadUrl(url)
      } catch (error: Throwable) {
        Log.w(TAG, "startSniff failed: $error")
        teardown(fireDone = true)
      }
    }
  }

  @JavascriptInterface
  fun cancelSniff() {
    activity.runOnUiThread { teardown(fireDone = true) }
  }

  // Called from the injected script on the page's first EME handshake; URLs alone can't reveal DRM.
  @JavascriptInterface
  fun reportDrm(generation: String?) {
    val reported = parseGeneration(generation) ?: return
    if (!isCurrentSniff(reported)) return
    if (!drmReported.compareAndSet(false, true)) return
    dispatchEvent("xt:sniff-drm", JSONObject(), reported)
  }

  @JavascriptInterface
  fun reportFavicon(favicon: String?, generation: String?) {
    val reported = parseGeneration(generation) ?: return
    if (!isCurrentSniff(reported)) return
    val trimmed = favicon?.trim().orEmpty()
    if (trimmed.isEmpty() || !withinFieldLimit(trimmed)) return
    if (!faviconReported.compareAndSet(false, true)) return
    lastFavicon = trimmed
  }

  private fun maybeEmitCandidate(request: WebResourceRequest, generation: Long) {
    if (!isCurrentSniff(generation)) return
    val url = request.url?.toString() ?: return
    if (!looksLikeManifest(url) || !withinFieldLimit(url)) return
    val headers = request.requestHeaders ?: emptyMap()
    val userAgent = headerValue(headers, "User-Agent")
    val referer = headerValue(headers, "Referer")
    if (userAgent != null && !withinFieldLimit(userAgent)) return
    if (referer != null && !withinFieldLimit(referer)) return
    if (candidateDispatchCount.get() >= MAX_CANDIDATE_DISPATCHES) return
    if (!reportedCandidateUrls.add(url)) return
    if (candidateDispatchCount.incrementAndGet() > MAX_CANDIDATE_DISPATCHES) return
    dispatchEvent(
      "xt:sniff-candidate",
      JSONObject().apply {
        put("url", url)
        put("userAgent", userAgent ?: JSONObject.NULL)
        put("referer", referer ?: JSONObject.NULL)
      },
      generation
    )
  }

  private fun isCurrentSniff(generation: Long): Boolean = sniffGeneration.get() == generation

  private fun parseGeneration(raw: String?): Long? = raw?.trim()?.toLongOrNull()

  // UTF-8 bytes to match sniffer.rs; the UTF-16 check avoids encoding huge values.
  private fun withinFieldLimit(value: String): Boolean =
    value.length <= MAX_FIELD_BYTES && value.toByteArray(Charsets.UTF_8).size <= MAX_FIELD_BYTES

  private fun looksLikeManifest(url: String): Boolean =
    MANIFEST_EXTENSION_RX.containsMatchIn(url) || MANIFEST_HINT_RX.containsMatchIn(url)

  private fun headerValue(headers: Map<String, String>, name: String): String? =
    headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value

  private fun nudgePlayback(view: WebView, generation: Long) {
    val generationLiteral = JSONObject.quote(generation.toString())
    val script = """
      (function(){
        var sniffGeneration = $generationLiteral;
        try {
          var originalRequestMediaKeySystemAccess = navigator.requestMediaKeySystemAccess;
          if (originalRequestMediaKeySystemAccess && !navigator.__xtSniffDrmWrapped) {
            navigator.__xtSniffDrmWrapped = true;
            navigator.requestMediaKeySystemAccess = function() {
              try { window.AndroidSnifferInternal && window.AndroidSnifferInternal.reportDrm(sniffGeneration); } catch (_) {}
              return originalRequestMediaKeySystemAccess.apply(navigator, arguments);
            };
          }
        } catch (_) {}
        try {
          ['button[class*="play" i]', '[class*="play-button" i]', '[aria-label*="play" i]', '.vjs-big-play-button', '.jw-icon-playback']
            .forEach(function(selector) {
              document.querySelectorAll(selector).forEach(function(el){ try { el.click(); } catch (_) {} });
            });
        } catch (_) {}
        try {
          document.querySelectorAll('video').forEach(function(v){ try { v.play(); } catch (_) {} });
        } catch (_) {}
        try {
          if (!navigator.__xtSniffFaviconReported) {
            navigator.__xtSniffFaviconReported = true;
            var link = document.querySelector("link[rel~='icon'], link[rel='shortcut icon'], link[rel='apple-touch-icon']");
            var iconHref = (link && link.href) || (location.origin + "/favicon.ico");
            window.AndroidSnifferInternal && window.AndroidSnifferInternal.reportFavicon(iconHref, sniffGeneration);
          }
        } catch (_) {}
      })();
    """.trimIndent()
    view.postDelayed({
      if (!isCurrentSniff(generation)) return@postDelayed
      view.evaluateJavascript(script, null)
    }, NUDGE_DELAY_MS)
  }

  private fun dispatchEvent(type: String, payload: JSONObject, generation: Long) {
    if (!isCurrentSniff(generation)) return
    val webView = hostedWebViewRef() ?: return
    val script = """
      (function(){
        try {
          document.dispatchEvent(new CustomEvent(${JSONObject.quote(type)}, { detail: $payload }));
        } catch (_) {}
      })();
    """.trimIndent()
    webView.post {
      if (!isCurrentSniff(generation)) return@post
      webView.evaluateJavascript(script, null)
    }
  }

  private fun teardown(fireDone: Boolean) {
    timeoutRunnable?.let { handler.removeCallbacks(it) }
    timeoutRunnable = null
    val endedGeneration = sniffGeneration.incrementAndGet()
    throwawayWebView?.let { webView ->
      val parent = webView.parent as? ViewGroup
      webView.stopLoading()
      webView.webViewClient = WebViewClient()
      parent?.removeView(webView)
      webView.destroy()
    }
    throwawayWebView = null
    if (fireDone) {
      dispatchEvent(
        "xt:sniff-done",
        JSONObject().apply { put("favicon", lastFavicon ?: JSONObject.NULL) },
        endedGeneration
      )
    }
  }

  // No xt:sniff-done: the WebView is going away with the activity.
  fun activityDestroyed() {
    teardown(fireDone = false)
  }
}

// Sender-side "casting to <TV>" media notification: MediaSessionCompat + NotificationCompat.MediaStyle,
// so playback can be controlled from the shade without reopening the app. Notification action taps and
// hardware media-button presses both funnel into dispatchAction(), which forwards to JS as xt:cast-media-action.
class CastMediaBridge(
  private val activity: TauriActivity,
  private val hostedWebViewRef: () -> WebView?,
) {
  companion object {
    private const val TAG = "AndroidCastMedia"
    private const val CHANNEL_ID = "cast_media"
    private const val NOTIFICATION_ID = 4301
    private const val NOTIFICATION_PERMISSION_REQUEST_CODE = 4302
    private const val ACTION_CAST_MEDIA = "com.infinitel8p.xtream.CAST_MEDIA_ACTION"
    private const val EXTRA_ACTION = "action"
    private const val MAX_ARTWORK_BYTES = 5 * 1024 * 1024
    private const val ARTWORK_TARGET_PX = 512
  }

  private var mediaSession: MediaSessionCompat? = null
  private var receiverRegistered = false
  @Volatile
  private var lastArtworkUrl: String? = null
  @Volatile
  private var lastArtworkBitmap: Bitmap? = null
  private val artworkGeneration = AtomicInteger(0)

  private val actionReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      val action = intent.getStringExtra(EXTRA_ACTION) ?: return
      dispatchAction(action)
    }
  }

  @JavascriptInterface
  fun update(
    title: String,
    deviceName: String,
    isPlaying: Boolean,
    isLive: Boolean,
    hasNext: Boolean,
    hasPrev: Boolean,
    artworkUrl: String,
  ) {
    val trimmedArtwork = artworkUrl.trim()
    val unchangedArtwork = trimmedArtwork.isNotEmpty() && trimmedArtwork == lastArtworkUrl
    val cachedArtwork = if (unchangedArtwork) lastArtworkBitmap else null
    activity.runOnUiThread {
      val session = ensureMediaSession()
      session.isActive = true
      session.setMetadata(buildMetadata(title, deviceName, cachedArtwork))
      session.setPlaybackState(buildPlaybackState(isPlaying, hasNext, hasPrev))
      postNotification(title, deviceName, isLive, isPlaying, hasNext, hasPrev, session, cachedArtwork)
    }
    if (trimmedArtwork.isEmpty()) {
      lastArtworkUrl = null
      lastArtworkBitmap = null
      return
    }
    if (unchangedArtwork) return
    lastArtworkUrl = trimmedArtwork
    lastArtworkBitmap = null
    loadArtwork(trimmedArtwork, title, deviceName, isLive, isPlaying, hasNext, hasPrev)
  }

  @JavascriptInterface
  fun clear() {
    activity.runOnUiThread {
      artworkGeneration.incrementAndGet()
      lastArtworkUrl = null
      lastArtworkBitmap = null
      NotificationManagerCompat.from(activity).cancel(NOTIFICATION_ID)
      mediaSession?.isActive = false
      mediaSession?.release()
      mediaSession = null
    }
  }

  private fun ensureMediaSession(): MediaSessionCompat {
    mediaSession?.let { return it }
    ensureReceiverRegistered()
    val contentIntent = PendingIntent.getActivity(
      activity,
      0,
      Intent(activity, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
      PendingIntent.FLAG_IMMUTABLE
    )
    val session = MediaSessionCompat(activity, TAG).apply {
      setSessionActivity(contentIntent)
      setCallback(object : MediaSessionCompat.Callback() {
        override fun onPlay() = dispatchAction("resume")
        override fun onPause() = dispatchAction("pause")
        override fun onSkipToNext() = dispatchAction("next")
        override fun onSkipToPrevious() = dispatchAction("prev")
        override fun onStop() = dispatchAction("stop")
      })
    }
    mediaSession = session
    return session
  }

  private fun ensureReceiverRegistered() {
    if (receiverRegistered) return
    try {
      ContextCompat.registerReceiver(
        activity,
        actionReceiver,
        IntentFilter(ACTION_CAST_MEDIA),
        ContextCompat.RECEIVER_NOT_EXPORTED
      )
      receiverRegistered = true
    } catch (error: Throwable) {
      Log.w(TAG, "registerReceiver failed", error)
    }
  }

  private fun ensureNotificationPermission(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
    if (ActivityCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) ==
      PackageManager.PERMISSION_GRANTED
    ) {
      return true
    }
    try {
      ActivityCompat.requestPermissions(
        activity,
        arrayOf(Manifest.permission.POST_NOTIFICATIONS),
        NOTIFICATION_PERMISSION_REQUEST_CODE
      )
    } catch (error: Throwable) {
      Log.w(TAG, "requestPermissions failed", error)
    }
    return false
  }

  private fun ensureNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = activity.getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    manager.createNotificationChannel(
      NotificationChannel(
        CHANNEL_ID,
        activity.getString(R.string.cast_media_notification_channel),
        NotificationManager.IMPORTANCE_LOW
      )
    )
  }

  private fun buildMetadata(title: String, deviceName: String, artwork: Bitmap?): MediaMetadataCompat {
    val builder = MediaMetadataCompat.Builder()
      .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
      .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, deviceName)
    if (artwork != null) builder.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artwork)
    return builder.build()
  }

  private fun buildPlaybackState(isPlaying: Boolean, hasNext: Boolean, hasPrev: Boolean): PlaybackStateCompat {
    var actions = PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_STOP
    if (hasNext) actions = actions or PlaybackStateCompat.ACTION_SKIP_TO_NEXT
    if (hasPrev) actions = actions or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
    val state = if (isPlaying) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
    return PlaybackStateCompat.Builder()
      .setActions(actions)
      .setState(state, PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, if (isPlaying) 1f else 0f)
      .build()
  }

  private fun buildAction(action: String, iconRes: Int, label: String): NotificationCompat.Action {
    val intent = Intent(ACTION_CAST_MEDIA).apply {
      setPackage(activity.packageName)
      putExtra(EXTRA_ACTION, action)
    }
    val pendingIntent = PendingIntent.getBroadcast(
      activity,
      action.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    return NotificationCompat.Action.Builder(iconRes, label, pendingIntent).build()
  }

  private fun postNotification(
    title: String,
    deviceName: String,
    isLive: Boolean,
    isPlaying: Boolean,
    hasNext: Boolean,
    hasPrev: Boolean,
    session: MediaSessionCompat,
    artwork: Bitmap?,
  ) {
    if (!ensureNotificationPermission()) return
    ensureNotificationChannel()
    val contentIntent = PendingIntent.getActivity(
      activity,
      0,
      Intent(activity, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
      PendingIntent.FLAG_IMMUTABLE
    )
    val builder = NotificationCompat.Builder(activity, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_brand_mark)
      .setContentTitle(title)
      .setContentText(if (isLive) "$deviceName · ${activity.getString(R.string.cast_media_live_suffix)}" else deviceName)
      .setContentIntent(contentIntent)
      .setOngoing(isPlaying)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
    if (artwork != null) builder.setLargeIcon(artwork)

    val compactIndices = mutableListOf<Int>()
    var actionCount = 0
    if (hasPrev) {
      builder.addAction(buildAction("prev", R.drawable.ic_notif_skip_previous, activity.getString(R.string.cast_media_previous)))
      compactIndices.add(actionCount)
      actionCount++
    }
    builder.addAction(
      buildAction(
        if (isPlaying) "pause" else "resume",
        if (isPlaying) R.drawable.ic_notif_pause else R.drawable.ic_notif_play,
        activity.getString(if (isPlaying) R.string.cast_media_pause else R.string.cast_media_resume)
      )
    )
    compactIndices.add(actionCount)
    actionCount++
    if (hasNext) {
      builder.addAction(buildAction("next", R.drawable.ic_notif_skip_next, activity.getString(R.string.cast_media_next)))
      compactIndices.add(actionCount)
    }

    builder.setStyle(
      androidx.media.app.NotificationCompat.MediaStyle()
        .setMediaSession(session.sessionToken)
        .setShowActionsInCompactView(*compactIndices.toIntArray())
    )

    try {
      NotificationManagerCompat.from(activity).notify(NOTIFICATION_ID, builder.build())
    } catch (error: SecurityException) {
      Log.w(TAG, "notify blocked by SecurityException: $error")
    }
  }

  private fun loadArtwork(
    url: String,
    title: String,
    deviceName: String,
    isLive: Boolean,
    isPlaying: Boolean,
    hasNext: Boolean,
    hasPrev: Boolean,
  ) {
    val generation = artworkGeneration.incrementAndGet()
    Thread {
      val bitmap = try {
        decodeScaledArtwork(url)
      } catch (error: Throwable) {
        Log.w(TAG, "artwork fetch failed: $error")
        null
      }
      if (bitmap == null || generation != artworkGeneration.get()) return@Thread
      activity.runOnUiThread {
        val session = mediaSession
        if (generation != artworkGeneration.get() || session == null) return@runOnUiThread
        lastArtworkBitmap = bitmap
        session.setMetadata(buildMetadata(title, deviceName, bitmap))
        postNotification(title, deviceName, isLive, isPlaying, hasNext, hasPrev, session, bitmap)
      }
    }.start()
  }

  // Reads bounded bytes then two-pass decodes so a 4K poster never lands as a
  // full-resolution bitmap in the MediaSession bundle on a low-RAM TV.
  private fun decodeScaledArtwork(url: String): Bitmap? {
    val connection = URL(url).openConnection().apply {
      connectTimeout = 4000
      readTimeout = 4000
    }
    if (connection.contentLengthLong > MAX_ARTWORK_BYTES) return null
    val bytes = connection.getInputStream().use { readBoundedBytes(it, MAX_ARTWORK_BYTES) } ?: return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    val options = BitmapFactory.Options().apply {
      inSampleSize = computeInSampleSize(bounds.outWidth, bounds.outHeight, ARTWORK_TARGET_PX)
    }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
  }

  private fun readBoundedBytes(input: java.io.InputStream, maxBytes: Int): ByteArray? {
    val output = ByteArrayOutputStream()
    val chunk = ByteArray(8192)
    var total = 0
    while (true) {
      val read = input.read(chunk)
      if (read == -1) break
      total += read
      if (total > maxBytes) return null
      output.write(chunk, 0, read)
    }
    return output.toByteArray()
  }

  private fun computeInSampleSize(width: Int, height: Int, targetPx: Int): Int {
    var sampleSize = 1
    var currentWidth = width
    var currentHeight = height
    while (currentWidth / 2 >= targetPx && currentHeight / 2 >= targetPx) {
      currentWidth /= 2
      currentHeight /= 2
      sampleSize *= 2
    }
    return sampleSize
  }

  private fun dispatchAction(action: String) {
    val webView = hostedWebViewRef() ?: return
    val script = """
      (function(){
        try {
          document.dispatchEvent(new CustomEvent('xt:cast-media-action', { detail: { action: ${JSONObject.quote(action)} } }));
        } catch (_) {}
      })();
    """.trimIndent()
    activity.runOnUiThread { webView.evaluateJavascript(script, null) }
  }

  // Called from MainActivity.onDestroy so the notification/session/receiver never outlive the activity.
  fun activityDestroyed() {
    if (receiverRegistered) {
      try {
        activity.unregisterReceiver(actionReceiver)
      } catch (error: Throwable) {
        Log.w(TAG, "unregisterReceiver failed", error)
      }
      receiverRegistered = false
    }
    NotificationManagerCompat.from(activity).cancel(NOTIFICATION_ID)
    mediaSession?.release()
    mediaSession = null
  }
}

class MainActivity : TauriActivity() {

  // Wry's own OnBackPressedCallback registers after ours and would win the LIFO dispatch otherwise.
  override val handleBackNavigation = false

  private var fullscreenView: View? = null
  private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null

  // Cached so the back-press handler can call onHideCustomView without re-walking the view tree.
  private var hostedWebView: WebView? = null

  // Cached so onDestroy() can tear down the throwaway sniffer WebView if it's still running.
  private var snifferBridge: SnifferBridge? = null

  // Cached so onDestroy() can unregister/stop NSD listeners.
  private var nsdBridge: NsdBridge? = null

  // Cached so onDestroy() can cancel the cast media notification + release its session.
  private var castMediaBridge: CastMediaBridge? = null

  // Cached so onResume() can clear the wake notification once the app is actually up.
  private var receiverWakeBridge: ReceiverWakeBridge? = null

  // Set by PipBridge.setAutoEnter() whenever a <video> starts/stops playing
  @Volatile
  var autoEnterPipEnabled: Boolean = false

  // Set by AndroidVideoBridge.receiverSessionStart()/receiverSessionEnd() while a TV-receiver cast plays through VideoActivity
  @Volatile
  var receiverSessionActive: Boolean = false

  // Set by ReceiverKeepAliveBridge.start()/stop() while the receiver HTTP server is running
  @Volatile
  var receiverModeActive: Boolean = false

  // Set by ReceiverKeepAliveBridge.setReceiverPageForeground() while /receiver is the visible page
  @Volatile
  var receiverPageForeground: Boolean = false

  private val rendererRecreating = AtomicBoolean(false)

  companion object {
    private const val RENDER_GONE_REPEAT_WINDOW_MS = 60_000L
    // Frees the back guard if the WebView dies before evaluateJavascript answers.
    private const val BACK_JS_TIMEOUT_MS = 1_500L
    @Volatile
    private var lastRenderGoneAt: Long = 0L
  }

  // Some WebViews emit no DOM event for DPAD_CENTER on inputmode="none" inputs, so the
  // TV input guard's OK-to-edit hook is fed from here; buttons still activate natively.
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (event.action == KeyEvent.ACTION_DOWN && event.keyCode == KeyEvent.KEYCODE_DPAD_CENTER) {
      try {
        hostedWebView?.evaluateJavascript("window.__xtRemoteOk && window.__xtRemoteOk()", null)
      } catch (e: Throwable) {
        Log.w("xtream-rs", "remote ok forward failed: $e")
      }
    }
    return super.dispatchKeyEvent(event)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // installSplashScreen() must run before super.onCreate so Theme.App.Starting
    // can hand control back to Theme.app once the WebView is ready to paint.
    installSplashScreen()
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Nothing in Tauri 2.11 calls PluginManager.onActivityCreate() automatically,
    // so SAF pickers (tauri-plugin-android-fs, tauri-plugin-dialog) otherwise
    // throw "lateinit property startActivityForResultLauncher has not been
    // initialized". Re-bind on every onCreate so the launchers also survive
    // recreate() after a WebView render-process-gone restart, where the
    // singleton's lateinit still points at the dead activity.
    bindPluginManagerLaunchers()

    // Back button order: exit fullscreen, page-level JS handler, WebView history, app exit.
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        private var awaitingJsBack = false

        override fun handleOnBackPressed() {
          if (fullscreenView != null) {
            (hostedWebView?.webChromeClient as? WebChromeClient)?.onHideCustomView()
            return
          }
          val webView = hostedWebView
          if (webView == null) {
            isEnabled = false
            onBackPressedDispatcher.onBackPressed()
            isEnabled = true
            return
          }
          // isEnabled only flips inside the callback, so a second press mid-round-trip would pop twice.
          if (awaitingJsBack) return
          awaitingJsBack = true
          val releaseGuard = Runnable { awaitingJsBack = false }
          webView.postDelayed(releaseGuard, BACK_JS_TIMEOUT_MS)
          webView.evaluateJavascript(
            "window.__xtHandleBack ? String(window.__xtHandleBack()) : \"false\""
          ) { result ->
            webView.removeCallbacks(releaseGuard)
            awaitingJsBack = false
            if (result == "true" || result == "\"true\"") return@evaluateJavascript
            if (webView.canGoBack()) {
              webView.goBack()
            } else {
              isEnabled = false
              onBackPressedDispatcher.onBackPressed()
              isEnabled = true
            }
          }
        }
      }
    )
  }

  private fun bindPluginManagerLaunchers() {
    val pm = PluginManager
    pm.activity = this
    val pmClass = pm.javaClass

    fun rebind(fieldName: String, callbackFieldName: String, launcher: Any) {
      try {
        pmClass.getDeclaredField(fieldName).apply {
          isAccessible = true
          set(pm, launcher)
        }
      } catch (e: Throwable) {
        Log.e("xtream-rs", "PluginManager.$fieldName rebind failed: $e")
      }
    }

    try {
      val saLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
      ) { result ->
        try {
          val cbField = pmClass.getDeclaredField("startActivityForResultCallback").apply {
            isAccessible = true
          }
          (cbField.get(pm) as? PluginManager.ActivityResultCallback)?.onResult(result)
        } catch (e: Throwable) {
          Log.w("xtream-rs", "startActivityForResult callback dispatch failed: $e")
        }
      }
      rebind("startActivityForResultLauncher", "startActivityForResultCallback", saLauncher)

      val isLauncher = registerForActivityResult(
        ActivityResultContracts.StartIntentSenderForResult()
      ) { result ->
        try {
          val cbField = pmClass.getDeclaredField("startIntentSenderForResultCallback").apply {
            isAccessible = true
          }
          (cbField.get(pm) as? PluginManager.ActivityResultCallback)?.onResult(result)
        } catch (e: Throwable) {
          Log.w("xtream-rs", "startIntentSenderForResult callback dispatch failed: $e")
        }
      }
      rebind("startIntentSenderForResultLauncher", "startIntentSenderForResultCallback", isLauncher)

      val permLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
      ) { result ->
        try {
          val cbField = pmClass.getDeclaredField("requestPermissionsCallback").apply {
            isAccessible = true
          }
          (cbField.get(pm) as? PluginManager.RequestPermissionsCallback)?.onResult(result)
        } catch (e: Throwable) {
          Log.w("xtream-rs", "requestPermissions callback dispatch failed: $e")
        }
      }
      rebind("requestPermissionsLauncher", "requestPermissionsCallback", permLauncher)
    } catch (e: Throwable) {
      Log.e("xtream-rs", "bindPluginManagerLaunchers reflection path failed, trying official init", e)
      try {
        PluginManager.onActivityCreate(this)
      } catch (e2: Throwable) {
        Log.e("xtream-rs", "PluginManager.onActivityCreate fallback also failed", e2)
      }
    }
  }

  // See https://github.com/tauri-apps/tauri/issues/13049.
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    hostedWebView = webView

    webView.addJavascriptInterface(PipBridge(this), "AndroidPip")
    webView.addJavascriptInterface(StatusBarBridge(this), "AndroidStatusBar")
    webView.addJavascriptInterface(DeviceInfoBridge(this), "AndroidDeviceInfo")
    webView.addJavascriptInterface(LogShareBridge(this), "AndroidLog")
    webView.addJavascriptInterface(ScreensaverBridge(this), "AndroidScreensaver")
    webView.addJavascriptInterface(IntentBridge(this), "AndroidIntent")
    webView.addJavascriptInterface(AndroidVideoBridge(this, { hostedWebView }), "AndroidVideo")
    webView.addJavascriptInterface(HapticsBridge(this, { hostedWebView }), "AndroidHaptics")
    webView.addJavascriptInterface(ImeBridge(this, { hostedWebView }), "AndroidIme")
    val sniffer = SnifferBridge(this, { hostedWebView })
    snifferBridge = sniffer
    webView.addJavascriptInterface(sniffer, "AndroidSniffer")
    val nsd = NsdBridge(this)
    nsdBridge = nsd
    webView.addJavascriptInterface(nsd, "AndroidNsd")
    webView.addJavascriptInterface(ReceiverKeepAliveBridge(this), "AndroidReceiverKeepAlive")
    val receiverWake = ReceiverWakeBridge(this)
    webView.addJavascriptInterface(receiverWake, "AndroidReceiverWake")
    receiverWakeBridge = receiverWake
    val castMedia = CastMediaBridge(this, { hostedWebView })
    castMediaBridge = castMedia
    webView.addJavascriptInterface(castMedia, "AndroidCastMedia")
    webView.addJavascriptInterface(
      WebSettingsBridge(this, { hostedWebView }, webView.settings.userAgentString),
      "AndroidWebSettings"
    )
    val isDebuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
    WebView.setWebContentsDebuggingEnabled(isDebuggable)

    // Keep the renderer process from being reclaimed under TV / low-RAM
    // pressure. Default WAIVED is what triggers most renderer-gone crashes
    // on cheap Android TV boxes.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
    }

    webView.settings.javaScriptEnabled = true
    webView.settings.setSupportMultipleWindows(true)
    webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
    webView.settings.mediaPlaybackRequiresUserGesture = false

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      webView.post {
        val tauriClient = webView.webViewClient
        webView.webViewClient = RenderGoneGuardingClient(tauriClient) { deadView, detail ->
          if (!rendererRecreating.compareAndSet(false, true)) {
            return@RenderGoneGuardingClient
          }
          val now = System.currentTimeMillis()
          val sinceLast = now - lastRenderGoneAt
          lastRenderGoneAt = now
          val didCrash = detail.didCrash()
          val isRepeat = sinceLast in 1..RENDER_GONE_REPEAT_WINDOW_MS
          Log.w(
            "xtream-rs",
            "WebView render process gone (didCrash=$didCrash, priority=${detail.rendererPriorityAtExit()}, sinceLast=${sinceLast}ms, repeat=$isRepeat)"
          )
          val messageRes = when {
            isRepeat -> R.string.render_gone_repeat
            didCrash -> R.string.render_gone_crash
            else -> R.string.render_gone_oom
          }
          Toast.makeText(applicationContext, messageRes, Toast.LENGTH_LONG).show()
          hostedWebView = null
          fullscreenView = null
          fullscreenCallback = null
          (deadView.parent as? ViewGroup)?.removeView(deadView)
          deadView.destroy()
          if (isRepeat) {
            return@RenderGoneGuardingClient
          }
          if (!isFinishing && !isDestroyed) {
            recreate()
          }
        }
      }
    }

    webView.webChromeClient = FullscreenAwareChromeClient(
      onShow = { view, callback ->
        if (fullscreenView != null) {
          callback.onCustomViewHidden()
        } else {
          fullscreenView = view
          fullscreenCallback = callback

          val decor = window.decorView as FrameLayout
          decor.addView(
            view,
            FrameLayout.LayoutParams(
              ViewGroup.LayoutParams.MATCH_PARENT,
              ViewGroup.LayoutParams.MATCH_PARENT
            )
          )
          applyImmersiveBars(true)
        }
      },
      onHide = {
        val decor = window.decorView as FrameLayout
        fullscreenView?.let { decor.removeView(it) }
        applyImmersiveBars(false)
        fullscreenCallback?.onCustomViewHidden()
        fullscreenView = null
        fullscreenCallback = null
      }
    )
  }

  // Legacy systemUiVisibility flags are ignored by HyperOS once the insets controller is in use.
  private fun applyImmersiveBars(hidden: Boolean) {
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    if (hidden) controller.hide(WindowInsetsCompat.Type.systemBars())
    else controller.show(WindowInsetsCompat.Type.systemBars())
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus && fullscreenView != null) applyImmersiveBars(true)
  }

  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    Log.d("xtream-pip", "onUserLeaveHint autoEnter=$autoEnterPipEnabled fullscreen=${fullscreenView != null} sdk=${Build.VERSION.SDK_INT}")
    // PiP on home-button press
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        (autoEnterPipEnabled || fullscreenView != null)) {
      try {
        val params = PictureInPictureParams.Builder()
          .setAspectRatio(Rational(16, 9))
          .build()
        val entered = enterPictureInPictureMode(params)
        Log.d("xtream-pip", "enterPictureInPictureMode returned $entered")
      } catch (e: Throwable) {
        Log.w("xtream-pip", "enterPictureInPictureMode failed", e)
      }
    }
  }

  override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode)
    // wry 0.55+ pauses the WebView in WryActivity.onPause() (wry 0.53/0.54 did
    // not). Android transitions the activity through onPause() into PiP and keeps
    // it paused for the whole PiP session, so without this resume the WebView
    // renderer stays frozen and the overlay renders black.
    if (isInPictureInPictureMode) {
      hostedWebView?.onResume()
      // PiP captures the whole Activity; promote the <video> into HTML5
      // fullscreen so the PiP window contains only the video, not the page chrome.
      hostedWebView?.evaluateJavascript("window.__xtPipFullscreen?.()", null)
    } else {
      hostedWebView?.evaluateJavascript("window.__xtPipExitFullscreen?.()", null)
      if (fullscreenView != null) applyImmersiveBars(true)
    }
  }

  override fun onResume() {
    super.onResume()
    drainAndDispatchVideoEvents()
    receiverWakeBridge?.clearWakeNotification()
  }

  override fun onPause() {
    super.onPause()
    // Same wry WebView-pause behavior as the PiP fix above; keep it alive so xt:receiver-play can still fire.
    if (receiverSessionActive || receiverPageForeground) hostedWebView?.onResume()
  }

  // Android memory pressure: release resident image/ambient/enrichment caches before the OS
  // starts killing background processes, and let the WebView drop its own HTTP cache.
  override fun onTrimMemory(level: Int) {
    super.onTrimMemory(level)
    if (level < ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) return
    val webView = hostedWebView ?: return
    webView.clearCache(false)
    val script = """
      document.dispatchEvent(new CustomEvent('xt:memory-pressure', { detail: { level: $level } }));
    """.trimIndent()
    webView.post { webView.evaluateJavascript(script, null) }
  }

  // Tear down the throwaway sniffer WebView instead of leaving the remote page running until its timeout.
  override fun onDestroy() {
    // Closes over this activity's WebView, so a recreate() would leave it swallowing every receiver event.
    if (receiverSessionActive) EventQueue.pushListener = null
    snifferBridge?.activityDestroyed()
    nsdBridge?.activityDestroyed()
    castMediaBridge?.activityDestroyed()
    if (isFinishing && receiverModeActive) {
      receiverModeActive = false
      try {
        startService(
          Intent(this, ReceiverForegroundService::class.java)
            .setAction(ReceiverForegroundService.ACTION_STOP)
        )
      } catch (error: Throwable) {
        Log.w("ReceiverKeepAlive", "stop on destroy failed", error)
      }
    }
    super.onDestroy()
  }

  private fun drainAndDispatchVideoEvents() {
    val webView = hostedWebView ?: return
    val raw = EventQueue.drain(this)
    if (raw == "[]" || raw.isBlank()) return
    val script = """
      (function(){
        try {
          var batch = $raw;
          for (var i = 0; i < batch.length; i++) {
            var evt = batch[i];
            try {
              document.dispatchEvent(new CustomEvent(evt.type, { detail: evt.payload }));
            } catch (_) {}
          }
        } catch (_) {}
      })();
    """.trimIndent()
    webView.post { webView.evaluateJavascript(script, null) }
  }
}
