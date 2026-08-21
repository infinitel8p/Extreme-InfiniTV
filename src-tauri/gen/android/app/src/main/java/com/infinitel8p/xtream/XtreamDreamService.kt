package com.infinitel8p.xtream

import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.service.dreams.DreamService
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.animation.LinearInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import coil.ImageLoader
import coil.disk.DiskCache
import coil.request.Disposable
import coil.request.ImageRequest
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.math.PI
import kotlin.math.sin
import kotlin.random.Random

/**
 * System screensaver (Settings > Display > Screen saver). Rotates
 * posters/backdrops from a manifest the web app writes to dataDir; falls
 * back to a drifting brand mark when offline or once every entry fails.
 */
class XtreamDreamService : DreamService() {

  companion object {
    private const val TAG = "XtreamDream"
    private const val MANIFEST_FILE_NAME = "ambient-screensaver.json"
    private const val INTRO_DURATION_MS = 2_000L
    private const val CROSSFADE_DURATION_MS = 900L
    private const val MIN_HOLD_MS = 20_000L
    private const val MAX_HOLD_MS = 30_000L
    private const val KEN_BURNS_TARGET_SCALE = 1.08f
    private const val MAX_FAILURES_PER_ENTRY = 2
    private const val OVERLAY_HEIGHT_FRACTION = 0.16f
    private const val OVERLAY_NUDGE_PX = 8
    private const val BRAND_ALPHA = 0.4f
    private const val BRAND_DRIFT_DURATION_MS = 60_000L
    private const val DISK_CACHE_MAX_BYTES = 64L * 1024 * 1024
  }

  private val mainHandler = Handler(Looper.getMainLooper())
  private val pendingRunnables = mutableListOf<Runnable>()

  private var imageLoader: ImageLoader? = null
  private var posterDisposable: Disposable? = null
  private var logoDisposable: Disposable? = null

  private var rootView: FrameLayout? = null
  private var frontLayer: ImageView? = null
  private var backLayer: ImageView? = null
  private var overlayContainer: FrameLayout? = null
  private var overlayLogo: ImageView? = null
  private var overlayTitle: TextView? = null
  private var brandMark: ImageView? = null

  private var activeEntries: MutableList<DreamEntry> = mutableListOf()
  private var userAgent: String? = null
  private var currentIndex = -1
  private val failureCounts = HashMap<String, Int>()

  private var kenBurnsAnimator: AnimatorSet? = null
  private var brandDriftAnimator: ValueAnimator? = null
  private var fallbackActive = false

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    isInteractive = false
    isFullscreen = true
    isScreenBright = true
    buildViews()
  }

  override fun onDreamingStarted() {
    super.onDreamingStarted()
    Log.d(TAG, "onDreamingStarted")
    Thread {
      val data = readManifest()
      mainHandler.post { onManifestLoaded(data) }
    }.start()
  }

  override fun onDreamingStopped() {
    super.onDreamingStopped()
    teardown()
  }

  override fun onDetachedFromWindow() {
    teardown()
    super.onDetachedFromWindow()
  }

  // ---------------------------------------------------------------------
  // View setup
  // ---------------------------------------------------------------------

  private fun buildViews() {
    val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }

    val back = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_CROP; alpha = 0f }
    val front = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_CROP; alpha = 0f }
    root.addView(back, matchParentParams())
    root.addView(front, matchParentParams())

    val scrim = View(this).apply {
      background = GradientDrawable(
        GradientDrawable.Orientation.TOP_BOTTOM,
        intArrayOf(Color.TRANSPARENT, Color.argb(179, 0, 0, 0))
      )
    }
    root.addView(scrim, matchParentParams())

    val displayMetrics = resources.displayMetrics
    val overlayMaxHeightPx = (displayMetrics.heightPixels * OVERLAY_HEIGHT_FRACTION).toInt()
    val overlayMarginPx = (24 * displayMetrics.density).toInt()

    val logo = ImageView(this).apply {
      scaleType = ImageView.ScaleType.FIT_START
      adjustViewBounds = true
      maxHeight = overlayMaxHeightPx
      visibility = View.GONE
    }
    val title = TextView(this).apply {
      setTextColor(Color.WHITE)
      textSize = 28f
      setTypeface(typeface, Typeface.BOLD)
      setShadowLayer(6f, 0f, 2f, Color.argb(200, 0, 0, 0))
      visibility = View.GONE
    }
    val overlay = FrameLayout(this).apply {
      addView(logo, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
      addView(title, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }
    root.addView(
      overlay,
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        gravity = Gravity.BOTTOM or Gravity.START
        leftMargin = overlayMarginPx
        bottomMargin = overlayMarginPx
      }
    )

    val brand = ImageView(this).apply {
      setImageResource(R.drawable.ic_brand_mark)
      alpha = 0f
      visibility = View.GONE
    }
    root.addView(
      brand,
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        gravity = Gravity.CENTER
      }
    )

    rootView = root
    backLayer = back
    frontLayer = front
    overlayContainer = overlay
    overlayLogo = logo
    overlayTitle = title
    brandMark = brand
    setContentView(root)
  }

  private fun matchParentParams() =
    FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)

  // ---------------------------------------------------------------------
  // Manifest
  // ---------------------------------------------------------------------

  private fun readManifest(): DreamData {
    return try {
      val file = File(dataDir, MANIFEST_FILE_NAME)
      if (!file.exists()) return DreamData(0L, null, emptyList())
      DreamManifest.parse(file.readText())
    } catch (error: Throwable) {
      Log.w(TAG, "readManifest failed: $error")
      DreamData(0L, null, emptyList())
    }
  }

  private fun onManifestLoaded(data: DreamData) {
    val renderable = data.entries.filter { it.posterUrl != null || it.backdropUrl != null }
    activeEntries = renderable.toMutableList()
    userAgent = data.ua
    Log.d(TAG, "manifest loaded: entries=${activeEntries.size} ageMs=${System.currentTimeMillis() - data.at}")
    imageLoader = buildImageLoader()

    brandMark?.visibility = View.VISIBLE
    brandMark?.animate()?.alpha(BRAND_ALPHA)?.setDuration(CROSSFADE_DURATION_MS)?.start()
    postDelayed(INTRO_DURATION_MS) {
      if (activeEntries.isEmpty()) {
        startBrandFallback()
      } else {
        brandMark?.animate()?.alpha(0f)?.setDuration(CROSSFADE_DURATION_MS)?.withEndAction {
          brandMark?.visibility = View.GONE
        }?.start()
        showNextEntry()
      }
    }
  }

  private fun buildImageLoader(): ImageLoader {
    return ImageLoader.Builder(this)
      .diskCache {
        DiskCache.Builder()
          .directory(File(cacheDir, "dream_images"))
          .maxSizeBytes(DISK_CACHE_MAX_BYTES)
          .build()
      }
      .respectCacheHeaders(false)
      .bitmapConfig(Bitmap.Config.RGB_565)
      .build()
  }

  // ---------------------------------------------------------------------
  // Rotation
  // ---------------------------------------------------------------------

  private fun showNextEntry() {
    if (activeEntries.isEmpty()) {
      startBrandFallback()
      return
    }
    if (currentIndex >= activeEntries.size) currentIndex = -1
    currentIndex = (currentIndex + 1) % activeEntries.size
    val entry = activeEntries[currentIndex]
    val imageUrl = entry.backdropUrl ?: entry.posterUrl
    if (imageUrl == null) {
      onEntryFailed(entry)
      return
    }
    loadEntryImage(entry, imageUrl, isBackdrop = entry.backdropUrl != null)
  }

  private fun loadEntryImage(entry: DreamEntry, imageUrl: String, isBackdrop: Boolean) {
    val loader = imageLoader ?: return
    val back = backLayer ?: return
    back.scaleX = 1f
    back.scaleY = 1f
    val displayMetrics = resources.displayMetrics
    val requestBuilder = ImageRequest.Builder(this)
      .data(imageUrl)
      .size(displayMetrics.widthPixels, displayMetrics.heightPixels)
      .target(
        onSuccess = { drawable -> onEntryImageReady(entry, drawable, isBackdrop) },
        onError = { onEntryFailed(entry) },
      )
    userAgent?.takeIf { it.isNotBlank() }?.let { requestBuilder.setHeader("User-Agent", it) }
    posterDisposable?.dispose()
    posterDisposable = loader.enqueue(requestBuilder.build())
  }

  private fun onEntryImageReady(entry: DreamEntry, drawable: Drawable, isBackdrop: Boolean) {
    val front = frontLayer ?: return
    val back = backLayer ?: return
    back.setImageDrawable(drawable)
    failureCounts.remove(entry.id)

    val holdMs = Random.nextLong(MIN_HOLD_MS, MAX_HOLD_MS + 1)
    back.animate().alpha(1f).setDuration(CROSSFADE_DURATION_MS).start()
    front.animate().alpha(0f).setDuration(CROSSFADE_DURATION_MS).start()

    kenBurnsAnimator?.cancel()
    kenBurnsAnimator = if (isBackdrop) {
      AnimatorSet().apply {
        playTogether(
          ObjectAnimator.ofFloat(back, "scaleX", 1f, KEN_BURNS_TARGET_SCALE),
          ObjectAnimator.ofFloat(back, "scaleY", 1f, KEN_BURNS_TARGET_SCALE),
        )
        duration = holdMs
        start()
      }
    } else {
      null
    }

    frontLayer = back
    backLayer = front
    updateOverlay(entry)
    nudgeOverlay()
    scheduleNextEntry(holdMs)
  }

  private fun onEntryFailed(entry: DreamEntry) {
    val failures = (failureCounts[entry.id] ?: 0) + 1
    failureCounts[entry.id] = failures
    Log.w(TAG, "entry ${entry.id} failed (${failures}/$MAX_FAILURES_PER_ENTRY)")
    if (failures >= MAX_FAILURES_PER_ENTRY) {
      activeEntries.removeAll { it.id == entry.id }
      failureCounts.remove(entry.id)
    }
    if (activeEntries.isEmpty()) {
      startBrandFallback()
    } else {
      showNextEntry()
    }
  }

  private fun scheduleNextEntry(holdMs: Long) {
    postDelayed(holdMs) { showNextEntry() }
  }

  private fun updateOverlay(entry: DreamEntry) {
    val logo = overlayLogo ?: return
    val title = overlayTitle ?: return
    val logoUrl = entry.logoUrl
    if (logoUrl.isNullOrBlank()) {
      logo.visibility = View.GONE
      title.visibility = View.VISIBLE
      title.text = entry.title
      return
    }
    val loader = imageLoader ?: return
    logoDisposable?.dispose()
    val requestBuilder = ImageRequest.Builder(this)
      .data(logoUrl)
      .target(
        onSuccess = { drawable ->
          logo.setImageDrawable(drawable)
          logo.visibility = View.VISIBLE
          title.visibility = View.GONE
        },
        onError = {
          logo.visibility = View.GONE
          title.visibility = View.VISIBLE
          title.text = entry.title
        },
      )
    userAgent?.takeIf { it.isNotBlank() }?.let { requestBuilder.setHeader("User-Agent", it) }
    logoDisposable = loader.enqueue(requestBuilder.build())
  }

  // Small position shift each swap so the overlay never burns the same pixels in.
  private fun nudgeOverlay() {
    val overlay = overlayContainer ?: return
    overlay.translationX = Random.nextInt(-OVERLAY_NUDGE_PX, OVERLAY_NUDGE_PX + 1).toFloat()
    overlay.translationY = Random.nextInt(-OVERLAY_NUDGE_PX, OVERLAY_NUDGE_PX + 1).toFloat()
  }

  // ---------------------------------------------------------------------
  // Brand fallback
  // ---------------------------------------------------------------------

  private fun startBrandFallback() {
    if (fallbackActive) return
    fallbackActive = true
    Log.d(TAG, "switching to brand fallback")
    frontLayer?.animate()?.alpha(0f)?.setDuration(CROSSFADE_DURATION_MS)?.start()
    backLayer?.animate()?.alpha(0f)?.setDuration(CROSSFADE_DURATION_MS)?.start()
    overlayContainer?.visibility = View.GONE
    kenBurnsAnimator?.cancel()
    kenBurnsAnimator = null

    val brand = brandMark ?: return
    brand.visibility = View.VISIBLE
    brand.alpha = BRAND_ALPHA

    val displayMetrics = resources.displayMetrics
    val amplitudeX = displayMetrics.widthPixels * 0.1f
    val amplitudeY = displayMetrics.heightPixels * 0.1f
    brandDriftAnimator = ValueAnimator.ofFloat(0f, 1f).apply {
      duration = BRAND_DRIFT_DURATION_MS
      repeatCount = ValueAnimator.INFINITE
      interpolator = LinearInterpolator()
      addUpdateListener { animator ->
        val fraction = animator.animatedValue as Float
        val angle = fraction * 2f * PI.toFloat()
        brand.translationX = amplitudeX * sin(angle)
        brand.translationY = amplitudeY * sin(2f * angle + PI.toFloat() / 2f)
      }
      start()
    }
  }

  // ---------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------

  private fun postDelayed(delayMs: Long, action: () -> Unit) {
    val runnable = Runnable(action)
    pendingRunnables.add(runnable)
    mainHandler.postDelayed(runnable, delayMs)
  }

  private fun teardown() {
    pendingRunnables.forEach { mainHandler.removeCallbacks(it) }
    pendingRunnables.clear()
    kenBurnsAnimator?.cancel()
    kenBurnsAnimator = null
    brandDriftAnimator?.cancel()
    brandDriftAnimator = null
    posterDisposable?.dispose()
    logoDisposable?.dispose()
    posterDisposable = null
    logoDisposable = null
    imageLoader?.shutdown()
    imageLoader = null
    fallbackActive = false
    currentIndex = -1
    failureCounts.clear()
    activeEntries = mutableListOf()
    frontLayer = null
    backLayer = null
    overlayContainer = null
    overlayLogo = null
    overlayTitle = null
    brandMark = null
    rootView = null
  }
}

data class DreamEntry(
  val kind: String,
  val id: String,
  val title: String,
  val posterUrl: String?,
  val backdropUrl: String?,
  val logoUrl: String?,
  val tier: String,
)

data class DreamData(
  val at: Long,
  val ua: String?,
  val entries: List<DreamEntry>,
)

// Pure, JVM-testable manifest parser: tolerant of any malformed shape, skips bad entries.
object DreamManifest {
  private const val MAX_ENTRIES = 50
  private val VALID_KINDS = setOf("vod", "series")

  fun parse(json: String): DreamData {
    return try {
      val root = JSONObject(json)
      val at = root.optLong("at", 0L)
      val ua = root.optString("ua").takeIf { it.isNotBlank() }
      val entriesArray = root.optJSONArray("entries") ?: JSONArray()
      val entries = ArrayList<DreamEntry>()
      for (i in 0 until entriesArray.length()) {
        if (entries.size >= MAX_ENTRIES) break
        val obj = entriesArray.optJSONObject(i) ?: continue
        val entry = parseEntry(obj) ?: continue
        entries.add(entry)
      }
      DreamData(at, ua, entries)
    } catch (error: Throwable) {
      Log.w("XtreamDream", "manifest parse failed: $error")
      DreamData(0L, null, emptyList())
    }
  }

  private fun parseEntry(obj: JSONObject): DreamEntry? {
    val kind = obj.optString("kind")
    val id = obj.optString("id")
    val title = obj.optString("title")
    if (kind !in VALID_KINDS || id.isBlank() || title.isBlank()) return null
    return DreamEntry(
      kind = kind,
      id = id,
      title = title,
      posterUrl = obj.optString("posterUrl").takeIf { it.isNotBlank() },
      backdropUrl = obj.optString("backdropUrl").takeIf { it.isNotBlank() },
      logoUrl = obj.optString("logoUrl").takeIf { it.isNotBlank() },
      tier = obj.optString("tier"),
    )
  }
}
