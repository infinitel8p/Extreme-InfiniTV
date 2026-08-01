package com.infinitel8p.xtream

import android.app.PictureInPictureParams
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.Rational
import android.view.KeyEvent
import android.view.View
import android.widget.LinearLayout
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.session.MediaSession
import androidx.media3.ui.PlayerView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import org.json.JSONArray
import org.json.JSONObject

/**
 * Native ExoPlayer-backed playback activity.
 *
 * Opt-in path (Settings: "Use native Android video player"). Launched from JS
 * via [AndroidVideoBridge] on [MainActivity]. Two modes:
 *
 *  - VOD: single URL, optional resume position, progress events every 5s.
 *  - Live: ordered channel list (`ChannelLite[]`), in-Activity D-pad-driven
 *    channel switching via [ChannelListAdapter] overlay.
 */
@UnstableApi
class VideoActivity : AppCompatActivity() {

  companion object {
    private const val TAG = "VideoActivity"

    const val EXTRA_MODE = "mode"           // "vod" | "live"
    const val EXTRA_CONTENT_KEY = "contentKey"
    const val EXTRA_URL = "url"
    const val EXTRA_UA = "ua"
    const val EXTRA_REFERER = "referer"
    const val EXTRA_TITLE = "title"
    const val EXTRA_POSTER = "posterUrl"
    const val EXTRA_START_MS = "startMs"
    const val EXTRA_INITIAL_CHANNEL_ID = "initialChannelId"

    const val MODE_VOD = "vod"
    const val MODE_LIVE = "live"

    private const val PROGRESS_INTERVAL_MS = 5_000L
  }

  private var playerView: PlayerView? = null
  private var channelOverlay: LinearLayout? = null
  private var channelListView: RecyclerView? = null

  private var exoPlayer: ExoPlayer? = null
  private var mediaSession: MediaSession? = null

  private var mode: String = MODE_VOD
  private var contentKey: String = ""
  private var defaultUa: String = ""
  private var defaultReferer: String = ""
  private var initialTitle: String = ""
  private var posterUrl: String = ""
  private var resumeMs: Long = 0L

  private var channels: List<ChannelLite> = emptyList()
  private var currentChannelIndex: Int = -1
  private var channelAdapter: ChannelListAdapter? = null

  private var overlayVisible = false
  private var releaseSuppressed = false
  private var finishedEmitted = false

  private val progressHandler = Handler(Looper.getMainLooper())
  private val progressTick = object : Runnable {
    override fun run() {
      val player = exoPlayer ?: return
      if (player.isPlaying && mode == MODE_VOD) {
        EventQueue.append(
          this@VideoActivity,
          "xt:android-native-progress",
          JSONObject().apply {
            put("contentKey", contentKey)
            put("positionMs", player.currentPosition)
            put("durationMs", player.duration.coerceAtLeast(0))
          }
        )
      }
      progressHandler.postDelayed(this, PROGRESS_INTERVAL_MS)
    }
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.activity_video)

    playerView = findViewById(R.id.player_view)
    channelOverlay = findViewById(R.id.channel_list_overlay)
    channelListView = findViewById(R.id.channel_list)

    mode = intent.getStringExtra(EXTRA_MODE) ?: MODE_VOD
    contentKey = intent.getStringExtra(EXTRA_CONTENT_KEY) ?: ""
    defaultUa = intent.getStringExtra(EXTRA_UA) ?: ""
    defaultReferer = intent.getStringExtra(EXTRA_REFERER) ?: ""
    initialTitle = intent.getStringExtra(EXTRA_TITLE) ?: ""
    posterUrl = intent.getStringExtra(EXTRA_POSTER) ?: ""
    resumeMs = intent.getLongExtra(EXTRA_START_MS, 0L)

    if (mode == MODE_LIVE) {
      val json = NativePlayerPayload.takeChannels() ?: "[]"
      channels = ChannelLite.parseList(json)
      val initialId = intent.getStringExtra(EXTRA_INITIAL_CHANNEL_ID)
      currentChannelIndex = channels.indexOfFirst { it.id == initialId }
        .takeIf { it >= 0 } ?: 0
      setupChannelList()
    } else {
      channelOverlay?.visibility = View.GONE
    }

    // Keep the source-rect hint in sync with the player view so the PiP
    // transition animates from the visible video bounds.
    playerView?.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
      updatePictureInPictureParams(autoEnter = true)
    }

    initializePlayer()
  }

  override fun onStart() {
    super.onStart()
    if (exoPlayer == null) initializePlayer()
  }

  override fun onResume() {
    super.onResume()
    progressHandler.removeCallbacks(progressTick)
    if (mode == MODE_VOD) progressHandler.postDelayed(progressTick, PROGRESS_INTERVAL_MS)
  }

  override fun onPause() {
    super.onPause()
    progressHandler.removeCallbacks(progressTick)
    // Keep playing if we're transitioning into PiP. Android pauses the
    // Activity briefly during the PiP transition; we only really stop in
    // onStop().
    if (!isInPictureInPictureMode) {
      exoPlayer?.playWhenReady = false
    }
  }

  override fun onStop() {
    super.onStop()
    if (!releaseSuppressed && !isInPictureInPictureMode) {
      releasePlayer()
    }
  }

  override fun onDestroy() {
    progressHandler.removeCallbacks(progressTick)
    releasePlayer()
    if (!finishedEmitted) {
      EventQueue.append(
        this,
        "xt:android-native-finished",
        JSONObject().apply {
          put("contentKey", contentKey)
          put("mode", mode)
          if (mode == MODE_LIVE) {
            val finalChannel = channels.getOrNull(currentChannelIndex)
            if (finalChannel != null) put("finalChannelId", finalChannel.id)
          }
        }
      )
    }
    super.onDestroy()
  }

  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    // Pre-API-31 path. On API 31+ Android handles this via setAutoEnterEnabled.
    if (Build.VERSION.SDK_INT in Build.VERSION_CODES.O..Build.VERSION_CODES.R) {
      enterPipNow()
    }
  }

  // ---------------------------------------------------------------------
  // Player setup
  // ---------------------------------------------------------------------

  private fun initializePlayer() {
    val view = playerView ?: return
    val player = ExoPlayer.Builder(this)
      .setMediaSourceFactory(buildMediaSourceFactory(defaultUa, defaultReferer))
      .build()
    exoPlayer = player
    view.player = player

    player.addListener(object : Player.Listener {
      override fun onPlayerError(error: PlaybackException) {
        Log.e(TAG, "playback error: ${error.errorCodeName}", error)
        EventQueue.append(
          this@VideoActivity,
          "xt:android-native-error",
          JSONObject().apply {
            put("contentKey", contentKey)
            put("code", error.errorCodeName)
            put("message", error.message ?: "")
          }
        )
      }

      override fun onPlaybackStateChanged(state: Int) {
        if (state == Player.STATE_ENDED && mode == MODE_VOD) {
          finishedEmitted = true
          EventQueue.append(
            this@VideoActivity,
            "xt:android-native-finished",
            JSONObject().apply {
              put("contentKey", contentKey)
              put("mode", mode)
              put("completed", true)
              put("finalPosMs", player.currentPosition)
            }
          )
          finish()
        }
      }
    })

    when (mode) {
      MODE_VOD -> {
        val item = buildMediaItem(intent.getStringExtra(EXTRA_URL) ?: "", initialTitle, posterUrl)
        player.setMediaItem(item, resumeMs)
        player.prepare()
        player.playWhenReady = true
      }
      MODE_LIVE -> {
        val channel = channels.getOrNull(currentChannelIndex) ?: return
        if (!loadChannel(channel, fireEvent = false)) {
          finish()
          return
        }
      }
    }

    setupMediaSession(player)
    updatePictureInPictureParams(autoEnter = true)
  }

  private fun buildMediaSourceFactory(ua: String, referer: String): MediaSource.Factory {
    val httpFactory = DefaultHttpDataSource.Factory()
      .setAllowCrossProtocolRedirects(true)
    if (ua.isNotBlank()) httpFactory.setUserAgent(ua)
    if (referer.isNotBlank()) {
      httpFactory.setDefaultRequestProperties(mapOf("Referer" to referer))
    }
    return DefaultMediaSourceFactory(this).setDataSourceFactory(httpFactory)
  }

  private fun buildMediaItem(url: String, title: String, poster: String): MediaItem {
    val builder = MediaItem.Builder().setUri(url)
    val metaBuilder = MediaMetadata.Builder()
      .setTitle(title.ifBlank { null })
    if (poster.isNotBlank()) {
      try { metaBuilder.setArtworkUri(android.net.Uri.parse(poster)) } catch (_: Throwable) {}
    }
    builder.setMediaMetadata(metaBuilder.build())
    // Mime hint routes DefaultMediaSourceFactory to the right extractor.
    val lower = url.lowercase()
    if (lower.contains(".m3u8")) builder.setMimeType(MimeTypes.APPLICATION_M3U8)
    else if (lower.contains(".mpd")) builder.setMimeType(MimeTypes.APPLICATION_MPD)
    return builder.build()
  }

  private fun setupMediaSession(player: ExoPlayer) {
    try {
      mediaSession = MediaSession.Builder(this, player).build()
    } catch (error: Throwable) {
      Log.w(TAG, "MediaSession.Builder failed: $error")
    }
  }

  private fun releasePlayer() {
    mediaSession?.release()
    mediaSession = null
    exoPlayer?.release()
    exoPlayer = null
    playerView?.player = null
  }

  // ---------------------------------------------------------------------
  // Channel list (Live TV only)
  // ---------------------------------------------------------------------

  private fun setupChannelList() {
    val list = channelListView ?: return
    val adapter = ChannelListAdapter(channels, currentChannelIndex) { index ->
      switchChannelByIndex(index)
      hideChannelOverlay()
    }
    channelAdapter = adapter
    list.layoutManager = LinearLayoutManager(this)
    list.adapter = adapter
    applyOverlayHeight()
  }

  private fun applyOverlayHeight() {
    val overlay = channelOverlay ?: return
    val target = (resources.displayMetrics.heightPixels * 0.4f).toInt().coerceAtLeast(1)
    val lp = overlay.layoutParams ?: return
    if (lp.height != target) {
      lp.height = target
      overlay.layoutParams = lp
    }
  }

  override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
    super.onConfigurationChanged(newConfig)
    if (mode == MODE_LIVE) applyOverlayHeight()
  }

  private fun showChannelOverlay() {
    if (mode != MODE_LIVE) return
    val overlay = channelOverlay ?: return
    overlay.visibility = View.VISIBLE
    overlayVisible = true
    channelListView?.post {
      channelListView?.scrollToPosition(currentChannelIndex.coerceAtLeast(0))
      channelListView?.findViewHolderForAdapterPosition(currentChannelIndex)
        ?.itemView?.requestFocus()
    }
  }

  private fun hideChannelOverlay() {
    val overlay = channelOverlay ?: return
    overlay.visibility = View.GONE
    overlayVisible = false
    playerView?.requestFocus()
  }

  private fun switchChannelByIndex(newIndex: Int) {
    if (newIndex !in channels.indices) return
    if (newIndex == currentChannelIndex) return
    val previousIndex = currentChannelIndex
    currentChannelIndex = newIndex
    val channel = channels[newIndex]
    channelAdapter?.updateCurrentIndex(newIndex)
    if (!loadChannel(channel, fireEvent = true)) {
      currentChannelIndex = previousIndex
      channelAdapter?.updateCurrentIndex(previousIndex)
    }
  }

  private fun switchChannelByDelta(delta: Int) {
    if (channels.isEmpty()) return
    val next = ((currentChannelIndex + delta) % channels.size + channels.size) % channels.size
    switchChannelByIndex(next)
  }

  private fun loadChannel(channel: ChannelLite, fireEvent: Boolean): Boolean {
    val player = exoPlayer ?: return false
    val ua = channel.ua.ifBlank { defaultUa }
    val ref = channel.referer.ifBlank { defaultReferer }
    try {
      val factory = buildMediaSourceFactory(ua, ref)
      val item = buildMediaItem(channel.streamUrl, channel.name, channel.logo)
      val src = factory.createMediaSource(item)
      player.setMediaSource(src)
      player.prepare()
      player.playWhenReady = true
    } catch (error: Throwable) {
      // A missing codec module (e.g. DASH) throws here, not via onPlayerError.
      Log.e(TAG, "media source unsupported for channel ${channel.id}", error)
      EventQueue.append(
        this,
        "xt:android-native-error",
        JSONObject().apply {
          put("contentKey", "live:${channel.id}")
          put("code", "SOURCE_UNSUPPORTED")
          put("message", error.message ?: "")
        }
      )
      Toast.makeText(this, R.string.native_player_unsupported_stream, Toast.LENGTH_SHORT).show()
      return false
    }

    if (fireEvent) {
      EventQueue.append(
        this,
        "xt:android-native-channel-changed",
        JSONObject().apply {
          put("contentKey", "live:${channel.id}")
          put("channelId", channel.id)
          put("channelName", channel.name)
        }
      )
    }
    return true
  }

  // ---------------------------------------------------------------------
  // Key handling: D-pad + media keys for channel flipping.
  // ---------------------------------------------------------------------

  override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
    if (mode != MODE_LIVE) return super.onKeyDown(keyCode, event)
    // Overlay-visible nav: BACK closes it, OK selects, list rows handle up/down.
    if (overlayVisible) {
      if (keyCode == KeyEvent.KEYCODE_BACK) {
        hideChannelOverlay()
        return true
      }
      return super.onKeyDown(keyCode, event)
    }
    return when (keyCode) {
      KeyEvent.KEYCODE_DPAD_UP -> {
        showChannelOverlay(); true
      }
      KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_CHANNEL_DOWN -> {
        switchChannelByDelta(-1); true
      }
      KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_CHANNEL_UP -> {
        switchChannelByDelta(+1); true
      }
      else -> super.onKeyDown(keyCode, event)
    }
  }

  // ---------------------------------------------------------------------
  // Picture-in-Picture
  // ---------------------------------------------------------------------

  private fun updatePictureInPictureParams(autoEnter: Boolean) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    try {
      val builder = PictureInPictureParams.Builder()
        .setAspectRatio(Rational(16, 9))
      val rect = android.graphics.Rect()
      if (playerView?.getGlobalVisibleRect(rect) == true && !rect.isEmpty) {
        builder.setSourceRectHint(rect)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        builder.setAutoEnterEnabled(autoEnter)
      }
      setPictureInPictureParams(builder.build())
    } catch (error: Throwable) {
      Log.w(TAG, "setPictureInPictureParams failed: $error")
    }
  }

  private fun enterPipNow() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    try {
      val params = PictureInPictureParams.Builder()
        .setAspectRatio(Rational(16, 9))
        .build()
      enterPictureInPictureMode(params)
    } catch (error: Throwable) {
      Log.w(TAG, "enterPictureInPictureMode failed: $error")
    }
  }

  override fun onPictureInPictureModeChanged(isInPip: Boolean, newConfig: android.content.res.Configuration) {
    super.onPictureInPictureModeChanged(isInPip, newConfig)
    releaseSuppressed = isInPip
    val controls = playerView ?: return
    if (isInPip) {
      controls.useController = false
      hideChannelOverlay()
    } else {
      controls.useController = true
    }
  }
}

// ---------------------------------------------------------------------
// ChannelLite payload schema. Built JS-side by `channel-lite.ts`.
// ---------------------------------------------------------------------

data class ChannelLite(
  val id: String,
  val name: String,
  val logo: String,
  val streamUrl: String,
  val ua: String,
  val referer: String,
  val nowProgramme: String,
) {
  companion object {
    fun parseList(json: String): List<ChannelLite> {
      return try {
        val arr = JSONArray(json)
        (0 until arr.length()).map { i ->
          val obj = arr.getJSONObject(i)
          ChannelLite(
            id = obj.optString("id"),
            name = obj.optString("name"),
            logo = obj.optString("logo"),
            streamUrl = obj.optString("streamUrl"),
            ua = obj.optString("ua"),
            referer = obj.optString("referer"),
            nowProgramme = obj.optString("nowProgramme"),
          )
        }.filter { it.id.isNotBlank() && it.streamUrl.isNotBlank() }
      } catch (error: Throwable) {
        Log.w("ChannelLite", "parse failed: $error")
        emptyList()
      }
    }
  }
}

// ---------------------------------------------------------------------
// Event queue: SharedPreferences-backed FIFO drained by MainActivity on
// resume and turned into DOM CustomEvents on the WebView. Simpler than
// bidirectional JNI; safe because progress is non-critical.
// ---------------------------------------------------------------------

// Process-local hand-off for the Live TV channel list. We can't pass the JSON
// blob through Intent extras: large playlists serialize to tens of MB which
// exceeds the binder transaction cap (~1 MB) and throws
// TransactionTooLargeException at startActivity. Same-process singleton has no
// such limit.
object NativePlayerPayload {
  @Volatile
  private var pendingChannelsJson: String? = null

  fun setChannels(json: String) {
    pendingChannelsJson = json
  }

  fun takeChannels(): String? {
    val payload = pendingChannelsJson
    pendingChannelsJson = null
    return payload
  }
}

object EventQueue {
  private const val PREF_NAME = "xt_native_events"
  private const val KEY_QUEUE = "queue"
  private const val MAX_ENTRIES = 200

  @Synchronized
  fun append(activity: android.content.Context, type: String, payload: JSONObject) {
    try {
      val prefs = prefs(activity)
      val raw = prefs.getString(KEY_QUEUE, "[]") ?: "[]"
      val arr = JSONArray(raw)
      val entry = JSONObject()
        .put("type", type)
        .put("ts", System.currentTimeMillis())
        .put("payload", payload)
      val lastIndex = arr.length() - 1
      if (lastIndex >= 0 && shouldCoalesce(type, payload, arr.optJSONObject(lastIndex))) {
        arr.put(lastIndex, entry)
        prefs.edit().putString(KEY_QUEUE, arr.toString()).apply()
        return
      }
      arr.put(entry)
      while (arr.length() > MAX_ENTRIES) arr.remove(0)
      prefs.edit().putString(KEY_QUEUE, arr.toString()).apply()
    } catch (error: Throwable) {
      Log.w("EventQueue", "append failed: $error")
    }
  }

  private fun shouldCoalesce(type: String, payload: JSONObject, last: JSONObject?): Boolean {
    if (last == null || last.optString("type") != type) return false
    val lastPayload = last.optJSONObject("payload") ?: return false
    return when (type) {
      "xt:android-native-progress" ->
        lastPayload.optString("contentKey") == payload.optString("contentKey")
      "xt:android-native-channel-changed" ->
        lastPayload.optString("channelId") == payload.optString("channelId")
      else -> false
    }
  }

  @Synchronized
  fun drain(activity: android.content.Context): String {
    val prefs = prefs(activity)
    val raw = prefs.getString(KEY_QUEUE, "[]") ?: "[]"
    if (raw != "[]") prefs.edit().putString(KEY_QUEUE, "[]").apply()
    return raw
  }

  private fun prefs(context: android.content.Context): SharedPreferences =
    context.getSharedPreferences(PREF_NAME, 0)
}
