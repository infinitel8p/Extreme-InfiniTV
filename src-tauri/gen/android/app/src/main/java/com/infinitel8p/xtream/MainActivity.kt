package com.infinitel8p.xtream

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebSettings
import android.widget.FrameLayout
import androidx.activity.enableEdgeToEdge
import androidx.activity.OnBackPressedCallback
import androidx.core.view.WindowCompat
import android.app.PictureInPictureParams
import android.util.Rational
import android.os.Build
import android.webkit.JavascriptInterface
import android.content.Intent
import android.content.pm.PackageManager

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
}

class MainActivity : TauriActivity() {

  private var fullscreenView: View? = null
  private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
  private var originalSystemUi: Int = 0

  // Cached so the back-press handler can call onHideCustomView without re-walking the view tree.
  private var hostedWebView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

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

  // See https://github.com/tauri-apps/tauri/issues/13049.
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    hostedWebView = webView

    webView.addJavascriptInterface(PipBridge(this), "AndroidPip")
    webView.addJavascriptInterface(StatusBarBridge(this), "AndroidStatusBar")
    webView.addJavascriptInterface(
      WebSettingsBridge(this, { hostedWebView }, webView.settings.userAgentString),
      "AndroidWebSettings"
    )
    WebView.setWebContentsDebuggingEnabled(true)

    webView.settings.javaScriptEnabled = true
    webView.settings.setSupportMultipleWindows(true)
    webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
    webView.settings.mediaPlaybackRequiresUserGesture = false

    webView.webChromeClient = object : WebChromeClient() {
      override fun onShowCustomView(view: View, callback: CustomViewCallback) {
        if (fullscreenView != null) {
          callback.onCustomViewHidden()
          return
        }
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

      override fun onHideCustomView() {
        val decor = window.decorView as FrameLayout
        fullscreenView?.let { decor.removeView(it) }
        decor.systemUiVisibility = originalSystemUi
        fullscreenCallback?.onCustomViewHidden()
        fullscreenView = null
        fullscreenCallback = null
      }
    }
  }

  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && fullscreenView != null) {
      val params = PictureInPictureParams.Builder()
        .setAspectRatio(Rational(16, 9))
        .build()
      enterPictureInPictureMode(params)
    }
  }

  override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode)
  }
}
