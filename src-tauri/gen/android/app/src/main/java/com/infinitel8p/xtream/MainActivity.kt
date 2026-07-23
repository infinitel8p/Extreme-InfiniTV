package com.infinitel8p.xtream

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebSettings
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.enableEdgeToEdge
import androidx.activity.OnBackPressedCallback
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.WindowCompat
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
import android.util.Base64
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File
import android.os.Handler
import android.os.Looper
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

/**
 * Bridge for the native ExoPlayer-backed VideoActivity. Opt-in path (Settings:
 * "Use native Android video player"). JS calls one of launchVod / launchLive
 * to start playback in the native Activity. drainEvents() pulls queued
 * progress / channel-changed / finished events written by VideoActivity into
 * SharedPreferences; MainActivity.onResume also drains and dispatches them as
 * DOM CustomEvents on the WebView automatically.
 */
class AndroidVideoBridge(private val activity: android.app.Activity) {
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
  ): Boolean {
    return tryLaunch(VideoActivity.MODE_VOD) { intent ->
      intent.putExtra(VideoActivity.EXTRA_URL, url)
      intent.putExtra(VideoActivity.EXTRA_START_MS, startMs)
      intent.putExtra(VideoActivity.EXTRA_CONTENT_KEY, contentKey)
      intent.putExtra(VideoActivity.EXTRA_UA, ua)
      intent.putExtra(VideoActivity.EXTRA_REFERER, referer)
      intent.putExtra(VideoActivity.EXTRA_TITLE, title)
      intent.putExtra(VideoActivity.EXTRA_POSTER, posterUrl)
    }
  }

  @JavascriptInterface
  fun launchLive(
    contentKey: String,
    channelsJson: String,
    initialChannelId: String,
    ua: String,
    referer: String,
  ): Boolean {
    NativePlayerPayload.setChannels(channelsJson)
    return tryLaunch(VideoActivity.MODE_LIVE) { intent ->
      intent.putExtra(VideoActivity.EXTRA_INITIAL_CHANNEL_ID, initialChannelId)
      intent.putExtra(VideoActivity.EXTRA_CONTENT_KEY, contentKey)
      intent.putExtra(VideoActivity.EXTRA_UA, ua)
      intent.putExtra(VideoActivity.EXTRA_REFERER, referer)
    }
  }

  @JavascriptInterface
  fun drainEvents(): String {
    return EventQueue.drain(activity)
  }

  private fun tryLaunch(mode: String, configure: (android.content.Intent) -> Unit): Boolean {
    return try {
      val intent = android.content.Intent(activity, VideoActivity::class.java)
      intent.putExtra(VideoActivity.EXTRA_MODE, mode)
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

/**
 * "Add from website" stream sniffer: loads a page in a throwaway offscreen
 * WebView, watches every request for something that looks like an HLS/DASH
 * manifest, and reports hits to the hosted WebView as DOM CustomEvents (same
 * evaluateJavascript + document.dispatchEvent mechanism `drainAndDispatchVideoEvents`
 * uses, minus the SharedPreferences queue - this bridge and the hosted WebView
 * live in the same activity, so events go out immediately instead of waiting
 * for onResume). Classification of hits (kind / master / ranking) happens
 * JS-side in sniff-classify.ts; this only does a dumb extension/substring
 * prefilter so we don't intercept every image/script request on the page.
 */
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
  }

  private val handler = Handler(Looper.getMainLooper())
  private var throwawayWebView: WebView? = null
  private var timeoutRunnable: Runnable? = null
  private var lastFavicon: String? = null

  // shouldInterceptRequest can run off the UI thread, so this page-controlled bookkeeping needs thread-safe primitives.
  private val reportedCandidateUrls: MutableSet<String> =
    java.util.Collections.newSetFromMap(java.util.concurrent.ConcurrentHashMap<String, Boolean>())
  private val candidateDispatchCount = java.util.concurrent.atomic.AtomicInteger(0)
  private val drmReported = java.util.concurrent.atomic.AtomicBoolean(false)
  private val faviconReported = java.util.concurrent.atomic.AtomicBoolean(false)

  // addJavascriptInterface reflects every @JavascriptInterface method regardless of name, so the throwaway WebView gets this report-only object, never SnifferBridge itself.
  inner class SnifferReportBridge {
    @JavascriptInterface
    fun reportDrm() {
      this@SnifferBridge.reportDrm()
    }

    @JavascriptInterface
    fun reportFavicon(favicon: String?) {
      this@SnifferBridge.reportFavicon(favicon)
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
      // Silent teardown: firing xt:sniff-done here would race the listeners
      // the caller just attached for this very startSniff() call.
      teardown(fireDone = false)
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
            maybeEmitCandidate(request)
            return null
          }

          override fun onPageFinished(view: WebView, finishedUrl: String) {
            nudgePlayback(view)
          }
        }
        val decor = activity.window.decorView as? ViewGroup
        decor?.addView(webView, FrameLayout.LayoutParams(THROWAWAY_SIZE_PX, THROWAWAY_SIZE_PX))
        timeoutRunnable = Runnable { teardown(fireDone = true) }
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

  // Called by the injected nudge script the moment the page attempts an EME
  // handshake - the URL prefilter alone can't tell a DRM-guarded manifest
  // from a plain one.
  @JavascriptInterface
  fun reportDrm() {
    if (!drmReported.compareAndSet(false, true)) return
    dispatchEvent("xt:sniff-drm", JSONObject())
  }

  @JavascriptInterface
  fun reportFavicon(favicon: String?) {
    if (!faviconReported.compareAndSet(false, true)) return
    lastFavicon = favicon
  }

  private fun maybeEmitCandidate(request: WebResourceRequest) {
    val url = request.url?.toString() ?: return
    if (!looksLikeManifest(url)) return
    if (candidateDispatchCount.get() >= MAX_CANDIDATE_DISPATCHES) return
    if (!reportedCandidateUrls.add(url)) return
    if (candidateDispatchCount.incrementAndGet() > MAX_CANDIDATE_DISPATCHES) return
    val headers = request.requestHeaders ?: emptyMap()
    dispatchEvent(
      "xt:sniff-candidate",
      JSONObject().apply {
        put("url", url)
        put("userAgent", headerValue(headers, "User-Agent") ?: JSONObject.NULL)
        put("referer", headerValue(headers, "Referer") ?: JSONObject.NULL)
      }
    )
  }

  private fun looksLikeManifest(url: String): Boolean =
    MANIFEST_EXTENSION_RX.containsMatchIn(url) || MANIFEST_HINT_RX.containsMatchIn(url)

  private fun headerValue(headers: Map<String, String>, name: String): String? =
    headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value

  private fun nudgePlayback(view: WebView) {
    val script = """
      (function(){
        try {
          var originalRequestMediaKeySystemAccess = navigator.requestMediaKeySystemAccess;
          if (originalRequestMediaKeySystemAccess && !navigator.__xtSniffDrmWrapped) {
            navigator.__xtSniffDrmWrapped = true;
            navigator.requestMediaKeySystemAccess = function() {
              try { window.AndroidSnifferInternal && window.AndroidSnifferInternal.reportDrm(); } catch (_) {}
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
            window.AndroidSnifferInternal && window.AndroidSnifferInternal.reportFavicon(iconHref);
          }
        } catch (_) {}
      })();
    """.trimIndent()
    view.postDelayed({ view.evaluateJavascript(script, null) }, NUDGE_DELAY_MS)
  }

  private fun dispatchEvent(type: String, payload: JSONObject) {
    val webView = hostedWebViewRef() ?: return
    val script = """
      (function(){
        try {
          document.dispatchEvent(new CustomEvent(${JSONObject.quote(type)}, { detail: $payload }));
        } catch (_) {}
      })();
    """.trimIndent()
    webView.post { webView.evaluateJavascript(script, null) }
  }

  private fun teardown(fireDone: Boolean) {
    timeoutRunnable?.let { handler.removeCallbacks(it) }
    timeoutRunnable = null
    throwawayWebView?.let { webView ->
      val parent = webView.parent as? ViewGroup
      webView.stopLoading()
      webView.webViewClient = WebViewClient()
      parent?.removeView(webView)
      webView.destroy()
    }
    throwawayWebView = null
    if (fireDone) {
      dispatchEvent("xt:sniff-done", JSONObject().apply { put("favicon", lastFavicon ?: JSONObject.NULL) })
    }
  }

  // No xt:sniff-done: the WebView is going away with the activity.
  fun activityDestroyed() {
    teardown(fireDone = false)
  }
}

class MainActivity : TauriActivity() {

  private var fullscreenView: View? = null
  private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
  private var originalSystemUi: Int = 0

  // Cached so the back-press handler can call onHideCustomView without re-walking the view tree.
  private var hostedWebView: WebView? = null

  // Cached so onDestroy() can tear down the throwaway sniffer WebView if it's still running.
  private var snifferBridge: SnifferBridge? = null

  // Set by PipBridge.setAutoEnter() whenever a <video> starts/stops playing
  @Volatile
  var autoEnterPipEnabled: Boolean = false

  private val rendererRecreating = AtomicBoolean(false)

  companion object {
    private const val RENDER_GONE_REPEAT_WINDOW_MS = 60_000L
    @Volatile
    private var lastRenderGoneAt: Long = 0L
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

    // Back button exits fullscreen first, then falls back to default behavior.
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          if (fullscreenView != null) {
            (hostedWebView?.webChromeClient as? WebChromeClient)?.onHideCustomView()
          } else {
            isEnabled = false
            onBackPressedDispatcher.onBackPressed()
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
    webView.addJavascriptInterface(IntentBridge(this), "AndroidIntent")
    webView.addJavascriptInterface(AndroidVideoBridge(this), "AndroidVideo")
    val sniffer = SnifferBridge(this, { hostedWebView })
    snifferBridge = sniffer
    webView.addJavascriptInterface(sniffer, "AndroidSniffer")
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
          originalSystemUi = decor.systemUiVisibility
          decor.addView(
            view,
            FrameLayout.LayoutParams(
              ViewGroup.LayoutParams.MATCH_PARENT,
              ViewGroup.LayoutParams.MATCH_PARENT
            )
          )
          decor.systemUiVisibility =
            (View.SYSTEM_UI_FLAG_FULLSCREEN
              or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
              or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY)
        }
      },
      onHide = {
        val decor = window.decorView as FrameLayout
        fullscreenView?.let { decor.removeView(it) }
        decor.systemUiVisibility = originalSystemUi
        fullscreenCallback?.onCustomViewHidden()
        fullscreenView = null
        fullscreenCallback = null
      }
    )
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
    }
  }

  override fun onResume() {
    super.onResume()
    drainAndDispatchVideoEvents()
  }

  // Tear down the throwaway sniffer WebView instead of leaving the remote page running until its timeout.
  override fun onDestroy() {
    snifferBridge?.activityDestroyed()
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
