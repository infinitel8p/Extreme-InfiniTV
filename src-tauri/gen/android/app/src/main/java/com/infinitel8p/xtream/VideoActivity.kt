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
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.session.MediaSession
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.DefaultTimeBar
import androidx.media3.ui.PlayerView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToInt

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
    const val EXTRA_DNS = "dns"
    const val EXTRA_TITLE = "title"
    const val EXTRA_POSTER = "posterUrl"
    const val EXTRA_START_MS = "startMs"
    const val EXTRA_INITIAL_CHANNEL_ID = "initialChannelId"
    const val EXTRA_TV_OVERSCAN_PERCENT = "tvOverscanPercent"

    const val MODE_VOD = "vod"
    const val MODE_LIVE = "live"

    private const val PROGRESS_INTERVAL_MS = 2_000L
    // DefaultTimeBar defaults to a 20-step key increment, so a 100-minute movie steps 5
    // minutes per D-pad press; pin a fixed 15s step instead.
    private const val TIME_BAR_KEY_INCREMENT_MS = 15_000L

    private const val PREF_PLAYER = "xt_native_player"
    private const val KEY_DISPLAY_MODE = "displayMode"

    // Dialog order; labels are index-matched.
    private val DISPLAY_MODES = intArrayOf(
      AspectRatioFrameLayout.RESIZE_MODE_FIT,
      AspectRatioFrameLayout.RESIZE_MODE_ZOOM,
      AspectRatioFrameLayout.RESIZE_MODE_FILL,
    )
    private val DISPLAY_MODE_LABELS = intArrayOf(
      R.string.xt_video_display_fit,
      R.string.xt_video_display_zoom,
      R.string.xt_video_display_stretch,
    )
    private val PLAYBACK_SPEEDS = floatArrayOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f)
  }

  private var playerView: PlayerView? = null
  private var channelOverlay: LinearLayout? = null
  private var channelListView: RecyclerView? = null

  private var controllerTitleView: TextView? = null
  private var timeBarRow: View? = null
  private var channelDownButton: View? = null
  private var channelUpButton: View? = null
  private var muteButton: ImageButton? = null
  private var volumeSeekBar: SeekBar? = null

  private var exoPlayer: ExoPlayer? = null
  private var mediaSession: MediaSession? = null

  private var mode: String = MODE_VOD
  private var contentKey: String = ""
  private var defaultUa: String = ""
  private var defaultReferer: String = ""
  private var defaultDns: String = ""
  private var initialTitle: String = ""
  private var posterUrl: String = ""
  private var resumeMs: Long = 0L
  private var tvOverscanPercent: Int = 0
  private var displayMode: Int = AspectRatioFrameLayout.RESIZE_MODE_FIT

  private var channels: List<ChannelLite> = emptyList()
  private var currentChannelIndex: Int = -1
  private var channelAdapter: ChannelListAdapter? = null

  private var overlayVisible = false
  private var controllerVisible = false
  private var volumeAdjustActive = false
  private var releaseSuppressed = false
  private var finishedEmitted = false
  // Records an onPause()-initiated stop so onResume() resumes without overriding a viewer pause.
  private var resumePlaybackOnReturn = false

  private val progressHandler = Handler(Looper.getMainLooper())
  private val progressTick = object : Runnable {
    override fun run() {
      val player = exoPlayer
      if (player != null && player.isPlaying) emitProgress(player)
      progressHandler.postDelayed(this, PROGRESS_INTERVAL_MS)
    }
  }

  // durationMs is omitted while unknown: C.TIME_UNSET must not reach JS as a zero-length media.
  private fun emitProgress(player: Player) {
    val durationMs = player.duration
    EventQueue.append(
      this,
      "xt:android-native-progress",
      JSONObject().apply {
        put("contentKey", contentKey)
        put("positionMs", player.currentPosition.coerceAtLeast(0))
        if (durationMs != C.TIME_UNSET && durationMs > 0) put("durationMs", durationMs)
      }
    )
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.activity_video)

    playerView = findViewById(R.id.player_view)
    // A focused PlayerView swallows D-pad into media3's show-controller path and derails
    // focus search, so keys must fall through to onKeyDown.
    playerView?.isFocusable = false
    playerView?.isFocusableInTouchMode = false
    channelOverlay = findViewById(R.id.channel_list_overlay)
    channelListView = findViewById(R.id.channel_list)

    controllerTitleView = playerView?.findViewById(R.id.tv_controller_title)
    timeBarRow = playerView?.findViewById(R.id.tv_time_row)
    channelDownButton = playerView?.findViewById(R.id.tv_channel_down)
    channelUpButton = playerView?.findViewById(R.id.tv_channel_up)
    muteButton = playerView?.findViewById(R.id.tv_mute_button)
    volumeSeekBar = playerView?.findViewById(R.id.tv_volume_seekbar)
    playerView?.findViewById<DefaultTimeBar>(androidx.media3.ui.R.id.exo_progress)
      ?.setKeyTimeIncrement(TIME_BAR_KEY_INCREMENT_MS)
    setupCustomControls()
    applyDisplayMode(storedDisplayMode())

    // Rewire on every show so the chain never points through buttons the control view hid meanwhile;
    // requestFocus is a no-op in touch mode so phone users are unaffected.
    playerView?.setControllerVisibilityListener(PlayerView.ControllerVisibilityListener { visibility ->
      controllerVisible = visibility == View.VISIBLE
      if (controllerVisible) {
        wireControllerFocusChain(mode == MODE_LIVE)
        if (currentFocus == null && !overlayVisible) {
          playerView?.findViewById<View>(androidx.media3.ui.R.id.exo_play_pause)?.requestFocus()
        }
      } else {
        setVolumeAdjustActive(false)
      }
    })

    // Keep the source-rect hint in sync with the player view so the PiP
    // transition animates from the visible video bounds.
    playerView?.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
      updatePictureInPictureParams(autoEnter = true)
    }

    NativePlayerControl.register(this)
    initializeFromIntent(intent)
  }

  private fun setupCustomControls() {
    channelDownButton?.setOnClickListener { switchChannelByDelta(-1) }
    channelUpButton?.setOnClickListener { switchChannelByDelta(+1) }
    muteButton?.setOnClickListener { applyVolume(ReceiverVolumeState.volume, !ReceiverVolumeState.muted) }
    volumeSeekBar?.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
      override fun onProgressChanged(seekBar: SeekBar, progress: Int, fromUser: Boolean) {
        if (fromUser) applyVolume(progress / 100f, muted = false)
      }
      override fun onStartTrackingTouch(seekBar: SeekBar) {}
      override fun onStopTrackingTouch(seekBar: SeekBar) {}
    })
    volumeSeekBar?.setOnFocusChangeListener { _, hasFocus ->
      if (!hasFocus) setVolumeAdjustActive(false)
    }
    // OK toggles adjust mode; otherwise LEFT/RIGHT traverse so the slider does not trap horizontal focus.
    volumeSeekBar?.setOnKeyListener { seekBar, keyCode, event ->
      val pressed = event.action == KeyEvent.ACTION_DOWN
      when (keyCode) {
        KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
          if (pressed) setVolumeAdjustActive(!volumeAdjustActive)
          true
        }
        KeyEvent.KEYCODE_BACK -> {
          if (!volumeAdjustActive) return@setOnKeyListener false
          if (pressed) setVolumeAdjustActive(false)
          true
        }
        KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT -> {
          if (volumeAdjustActive) return@setOnKeyListener false
          if (pressed) {
            val direction = if (keyCode == KeyEvent.KEYCODE_DPAD_LEFT) View.FOCUS_LEFT else View.FOCUS_RIGHT
            seekBar.focusSearch(direction)?.requestFocus()
          }
          true
        }
        KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN -> {
          if (pressed) setVolumeAdjustActive(false)
          false
        }
        else -> false
      }
    }
    // Replaces media3's built-in settings popup: display mode is what a TV viewer reaches for,
    // and the tracks that popup would offer already have their own buttons in this row.
    playerView?.findViewById<View>(androidx.media3.ui.R.id.exo_settings)?.setOnClickListener {
      showPlayerSettings()
    }
    updateVolumeControlsUi(ReceiverVolumeState.volume, ReceiverVolumeState.muted)
  }

  private fun storedDisplayMode(): Int {
    val stored = getSharedPreferences(PREF_PLAYER, 0).getInt(KEY_DISPLAY_MODE, DISPLAY_MODES[0])
    return if (DISPLAY_MODES.contains(stored)) stored else DISPLAY_MODES[0]
  }

  private fun applyDisplayMode(resizeMode: Int) {
    displayMode = resizeMode
    playerView?.resizeMode = resizeMode
    getSharedPreferences(PREF_PLAYER, 0).edit().putInt(KEY_DISPLAY_MODE, resizeMode).apply()
  }

  // Gear-button menu. Speed is VOD-only: a live edge has nowhere to run ahead to.
  private fun showPlayerSettings() {
    if (mode == MODE_LIVE) {
      showDisplayModeChooser()
      return
    }
    val labels = arrayOf(
      getString(R.string.xt_video_display_mode),
      getString(R.string.xt_video_playback_speed),
    )
    AlertDialog.Builder(this)
      .setTitle(R.string.xt_video_settings_title)
      .setItems(labels) { _, which ->
        if (which == 0) showDisplayModeChooser() else showPlaybackSpeedChooser()
      }
      .show()
  }

  private fun showDisplayModeChooser() {
    val labels = DISPLAY_MODE_LABELS.map { getString(it) }.toTypedArray()
    AlertDialog.Builder(this)
      .setTitle(R.string.xt_video_display_mode)
      .setSingleChoiceItems(labels, DISPLAY_MODES.indexOf(displayMode).coerceAtLeast(0)) { dialog, which ->
        applyDisplayMode(DISPLAY_MODES[which])
        dialog.dismiss()
      }
      .setOnDismissListener { playerView?.showController() }
      .show()
  }

  private fun showPlaybackSpeedChooser() {
    val player = exoPlayer ?: return
    val current = player.playbackParameters.speed
    val labels = PLAYBACK_SPEEDS.map { speed ->
      if (speed == 1f) getString(R.string.xt_video_speed_normal) else "${speed}x"
    }.toTypedArray()
    AlertDialog.Builder(this)
      .setTitle(R.string.xt_video_playback_speed)
      .setSingleChoiceItems(labels, PLAYBACK_SPEEDS.indexOfFirst { kotlin.math.abs(it - current) < 0.01f }) { dialog, which ->
        player.setPlaybackSpeed(PLAYBACK_SPEEDS[which])
        dialog.dismiss()
      }
      .setOnDismissListener { playerView?.showController() }
      .show()
  }

  private fun setVolumeAdjustActive(active: Boolean) {
    volumeAdjustActive = active
    volumeSeekBar?.isSelected = active
  }

  // singleTop delivery for a repeat launchVod/launchLive while this activity is on top.
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    progressHandler.removeCallbacks(progressTick)
    hideChannelOverlay()
    releasePlayer()
    finishedEmitted = false
    NativePlayerControl.register(this)
    initializeFromIntent(intent)
    progressHandler.postDelayed(progressTick, PROGRESS_INTERVAL_MS)
  }

  private fun initializeFromIntent(intent: Intent) {
    mode = intent.getStringExtra(EXTRA_MODE) ?: MODE_VOD
    contentKey = intent.getStringExtra(EXTRA_CONTENT_KEY) ?: ""
    defaultUa = intent.getStringExtra(EXTRA_UA) ?: ""
    defaultReferer = intent.getStringExtra(EXTRA_REFERER) ?: ""
    defaultDns = intent.getStringExtra(EXTRA_DNS) ?: ""
    initialTitle = intent.getStringExtra(EXTRA_TITLE) ?: ""
    posterUrl = intent.getStringExtra(EXTRA_POSTER) ?: ""
    resumeMs = intent.getLongExtra(EXTRA_START_MS, 0L)
    applyTvOverscanPadding(intent.getIntExtra(EXTRA_TV_OVERSCAN_PERCENT, 0))
    controllerTitleView?.text = initialTitle

    if (mode == MODE_LIVE) {
      val json = NativePlayerPayload.takeChannels() ?: "[]"
      channels = ChannelLite.parseList(json)
      val initialId = intent.getStringExtra(EXTRA_INITIAL_CHANNEL_ID)
      currentChannelIndex = channels.indexOfFirst { it.id == initialId }
        .takeIf { it >= 0 } ?: 0
      setupChannelList()
    } else {
      channels = emptyList()
      currentChannelIndex = -1
      channelAdapter = null
      channelOverlay?.visibility = View.GONE
    }

    updateControllerForMode()
    initializePlayer()
  }

  // Live has no timeline (hide the time bar); VOD has no channel list (hide the flip buttons).
  private fun updateControllerForMode() {
    val isLive = mode == MODE_LIVE
    timeBarRow?.visibility = if (isLive) View.GONE else View.VISIBLE
    channelDownButton?.visibility = if (isLive) View.VISIBLE else View.GONE
    channelUpButton?.visibility = if (isLive) View.VISIBLE else View.GONE
    wireControllerFocusChain(isLive)
  }

  // Explicit D-pad focus ring since the two modes show a different set of rows.
  private fun wireControllerFocusChain(isLive: Boolean) {
    val rewind = playerView?.findViewById<View>(androidx.media3.ui.R.id.exo_rew)
    val playPause = playerView?.findViewById<View>(androidx.media3.ui.R.id.exo_play_pause)
    val forward = playerView?.findViewById<View>(androidx.media3.ui.R.id.exo_ffwd)
    val progress = playerView?.findViewById<View>(androidx.media3.ui.R.id.exo_progress)
      ?.takeIf { !isLive }
    val subtitle = playerView?.findViewById<View>(androidx.media3.ui.R.id.exo_subtitle)
      ?.also { it.isFocusable = true }
    val audioTrack = playerView?.findViewById<View>(androidx.media3.ui.R.id.exo_audio_track)
      ?.also { it.isFocusable = true }
    val settings = playerView?.findViewById<View>(androidx.media3.ui.R.id.exo_settings)
      ?.also { it.isFocusable = true }
    val mute = muteButton
    val volume = volumeSeekBar
    val channelDown = channelDownButton
    val channelUp = channelUpButton

    // Bottom row (transport), left to right; hidden or disabled members are skipped (e.g. rew/ffwd
    // disabled on live) so the chain still connects across them.
    val transportRow = listOfNotNull(
      channelDown?.takeIf { isLive },
      rewind,
      playPause,
      forward,
      channelUp?.takeIf { isLive },
    ).filter { it.visibility == View.VISIBLE && it.isEnabled }
    for (index in transportRow.indices) {
      val current = transportRow[index]
      current.nextFocusLeftId = transportRow.getOrElse(index - 1) { current }.id
      current.nextFocusRightId = transportRow.getOrElse(index + 1) { current }.id
    }

    // Volume row: hidden or disabled members are skipped so the chain still connects across them.
    val volumeRow = listOfNotNull(mute, volume, subtitle, audioTrack, settings)
      .filter { it.visibility == View.VISIBLE && it.isEnabled }
    for (index in volumeRow.indices) {
      val current = volumeRow[index]
      current.nextFocusLeftId = volumeRow.getOrElse(index - 1) { current }.id
      current.nextFocusRightId = volumeRow.getOrElse(index + 1) { current }.id
    }

    // The volume row never escapes upward; down goes to the time bar (VOD) or transport row (live).
    val belowVolumeRow = progress ?: playPause
    volumeRow.forEach {
      it.nextFocusUpId = it.id
      it.nextFocusDownId = belowVolumeRow?.id ?: it.id
    }

    // Up entry into the transport row: from the time bar in VOD, straight from the volume row in live.
    val aboveTransport = progress ?: volume ?: mute
    transportRow.forEach { it.nextFocusUpId = aboveTransport?.id ?: it.id }

    // DefaultTimeBar can swallow DPAD_UP outright; force the escape to the volume row.
    progress?.let { timeBar ->
      timeBar.nextFocusUpId = volume?.id ?: mute?.id ?: timeBar.id
      timeBar.nextFocusDownId = playPause?.id ?: timeBar.id
      timeBar.setOnKeyListener { _, keyCode, event ->
        if (keyCode == KeyEvent.KEYCODE_DPAD_UP && event.action == KeyEvent.ACTION_DOWN) {
          (volume ?: mute)?.requestFocus()
          true
        } else {
          false
        }
      }
    }
  }

  override fun onStart() {
    super.onStart()
    if (exoPlayer == null) initializePlayer()
  }

  override fun onResume() {
    super.onResume()
    progressHandler.removeCallbacks(progressTick)
    progressHandler.postDelayed(progressTick, PROGRESS_INTERVAL_MS)
    // A transient background (overlay, CEC, assistant) would otherwise leave a cast paused for good.
    if (resumePlaybackOnReturn) {
      resumePlaybackOnReturn = false
      exoPlayer?.playWhenReady = true
    }
  }

  override fun onPause() {
    super.onPause()
    progressHandler.removeCallbacks(progressTick)
    // Keep playing if we're transitioning into PiP. Android pauses the
    // Activity briefly during the PiP transition; we only really stop in
    // onStop().
    if (!isInPictureInPictureMode) {
      resumePlaybackOnReturn = exoPlayer?.playWhenReady == true
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
    NativePlayerControl.unregister(this)
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
      .setMediaSourceFactory(buildMediaSourceFactory(defaultUa, defaultReferer, defaultDns))
      .build()
    exoPlayer = player
    view.player = player

    // Subs off by default; the controller's CC dialog re-enables the text type on pick.
    player.trackSelectionParameters = player.trackSelectionParameters
      .buildUpon()
      .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
      .build()

    player.addListener(object : Player.Listener {
      override fun onPlayerError(error: PlaybackException) {
        val httpStatus = httpStatusOf(error)
        Log.e(TAG, "playback error: ${error.errorCodeName} http=$httpStatus", error)
        EventQueue.append(
          this@VideoActivity,
          "xt:android-native-error",
          JSONObject().apply {
            put("contentKey", contentKey)
            put("code", error.errorCodeName)
            put("message", error.message ?: "")
            if (httpStatus > 0) put("httpStatus", httpStatus)
          }
        )
      }

      override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
        updateKeepScreenOn(player)
        // playWhenReady, not isPlaying: a buffer stall must not surface to the sender as a pause.
        EventQueue.append(
          this@VideoActivity,
          "xt:android-native-play-state",
          JSONObject().apply {
            put("contentKey", contentKey)
            put("playing", playWhenReady)
            put("positionMs", player.currentPosition.coerceAtLeast(0))
          }
        )
      }

      // Re-wire after the control view hides trackless buttons, so the chain never points through a GONE view.
      override fun onTracksChanged(tracks: Tracks) {
        playerView?.post { wireControllerFocusChain(mode == MODE_LIVE) }
      }

      override fun onPlaybackStateChanged(state: Int) {
        updateKeepScreenOn(player)
        // STATE_READY knows the timeline; ticks only fire while playing, so report it right away.
        if (state == Player.STATE_READY && mode == MODE_VOD) emitProgress(player)
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
    updateKeepScreenOn(player)
    updatePictureInPictureParams(autoEnter = true)
    applyVolume(ReceiverVolumeState.volume, ReceiverVolumeState.muted)
  }

  private fun updateKeepScreenOn(player: Player) {
    val active = player.playWhenReady &&
      player.playbackState != Player.STATE_IDLE &&
      player.playbackState != Player.STATE_ENDED
    if (active) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }

  // Digs the HTTP status out of Media3's cause chain; 0 when there was none.
  private fun httpStatusOf(error: Throwable?): Int {
    var cause: Throwable? = error
    var depth = 0
    while (depth < 8) {
      val current = cause ?: return 0
      if (current is HttpDataSource.InvalidResponseCodeException) return current.responseCode
      cause = current.cause
      depth++
    }
    return 0
  }

  private fun buildMediaSourceFactory(ua: String, referer: String, dns: String): MediaSource.Factory {
    val dataSourceFactory: DataSource.Factory = if (dns.isBlank()) {
      val httpFactory = DefaultHttpDataSource.Factory()
        .setAllowCrossProtocolRedirects(true)
      if (ua.isNotBlank()) httpFactory.setUserAgent(ua)
      if (referer.isNotBlank()) httpFactory.setDefaultRequestProperties(mapOf("Referer" to referer))
      httpFactory
    } else {
      // OkHttp follows cross-protocol redirects by default, matching DefaultHttpDataSource above.
      val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .followRedirects(true)
        .dns(CustomDns.build(dns))
        .build()
      val okHttpFactory = OkHttpDataSource.Factory(client)
      if (ua.isNotBlank()) okHttpFactory.setUserAgent(ua)
      if (referer.isNotBlank()) okHttpFactory.setDefaultRequestProperties(mapOf("Referer" to referer))
      okHttpFactory
    }
    return DefaultMediaSourceFactory(this).setDataSourceFactory(dataSourceFactory)
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
  // Remote control, called from NativePlayerControl (TV receiver mode).
  // ---------------------------------------------------------------------

  fun applyPlayWhenReady(playing: Boolean) {
    exoPlayer?.playWhenReady = playing
  }

  fun applySeekToMs(positionMs: Long) {
    if (mode != MODE_VOD) return
    exoPlayer?.seekTo(positionMs)
  }

  fun applyVolume(level: Float, muted: Boolean) {
    val clampedLevel = level.coerceIn(0f, 1f)
    exoPlayer?.volume = if (muted) 0f else clampedLevel
    ReceiverVolumeState.volume = clampedLevel
    ReceiverVolumeState.muted = muted
    updateVolumeControlsUi(clampedLevel, muted)
    EventQueue.append(
      this,
      "xt:android-native-volume",
      JSONObject().apply {
        put("contentKey", contentKey)
        put("volume", clampedLevel)
        put("muted", muted)
      }
    )
  }

  // Single UI update path for both the on-screen controls and remote-driven volume changes.
  private fun updateVolumeControlsUi(level: Float, muted: Boolean) {
    val progress = (level * 100).roundToInt().coerceIn(0, 100)
    volumeSeekBar?.let { if (it.progress != progress) it.progress = progress }
    val isMuted = muted || level <= 0f
    muteButton?.setImageResource(if (isMuted) R.drawable.ic_video_volume_mute else R.drawable.ic_video_volume)
    muteButton?.contentDescription = getString(
      if (isMuted) R.string.xt_video_unmute_description else R.string.xt_video_mute_description
    )
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

  // Insets the chrome (controller, subtitles, channel overlay) but never the picture: overscan is
  // a safe area for things that must stay readable, and padding the PlayerView pulled the video
  // itself off the screen edges.
  private fun applyTvOverscanPadding(percent: Int) {
    tvOverscanPercent = percent.coerceIn(0, 8)
    val metrics = resources.displayMetrics
    val horizontalPx = metrics.widthPixels * tvOverscanPercent / 100
    val verticalPx = metrics.heightPixels * tvOverscanPercent / 100

    playerView?.setPadding(0, 0, 0, 0)
    playerView?.findViewById<View>(androidx.media3.ui.R.id.exo_controller)
      ?.setPadding(horizontalPx, verticalPx, horizontalPx, verticalPx)
    playerView?.subtitleView?.setPadding(horizontalPx, verticalPx, horizontalPx, verticalPx)

    val overlay = channelOverlay
    val overlayParams = overlay?.layoutParams as? FrameLayout.LayoutParams
    if (overlayParams != null) {
      overlayParams.leftMargin = horizontalPx
      overlayParams.rightMargin = horizontalPx
      overlayParams.bottomMargin = verticalPx
      overlay.layoutParams = overlayParams
    }

    if (tvOverscanPercent > 0) {
      Log.d(TAG, "applied tv overscan safe margin: $tvOverscanPercent% -> ${horizontalPx}x${verticalPx}px")
    }
  }

  override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
    super.onConfigurationChanged(newConfig)
    if (mode == MODE_LIVE) applyOverlayHeight()
    applyTvOverscanPadding(tvOverscanPercent)
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
    if (controllerVisible) {
      playerView?.findViewById<View>(androidx.media3.ui.R.id.exo_play_pause)?.requestFocus()
    }
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
      val factory = buildMediaSourceFactory(ua, ref, defaultDns)
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

  // Keys only flip channels or open overlays while the controller is hidden; while visible,
  // unhandled D-pad falls through to the framework focus navigation.
  override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
    if (overlayVisible) {
      if (keyCode == KeyEvent.KEYCODE_BACK) {
        hideChannelOverlay()
        return true
      }
      return super.onKeyDown(keyCode, event)
    }
    if (mode == MODE_LIVE) {
      when (keyCode) {
        KeyEvent.KEYCODE_CHANNEL_DOWN -> { switchChannelByDelta(-1); return true }
        KeyEvent.KEYCODE_CHANNEL_UP -> { switchChannelByDelta(+1); return true }
      }
    }
    if (controllerVisible) {
      if (keyCode == KeyEvent.KEYCODE_BACK) {
        playerView?.hideController()
        return true
      }
      return super.onKeyDown(keyCode, event)
    }
    return when (keyCode) {
      KeyEvent.KEYCODE_DPAD_UP -> {
        if (mode == MODE_LIVE) showChannelOverlay() else playerView?.showController()
        true
      }
      KeyEvent.KEYCODE_DPAD_LEFT -> {
        if (mode == MODE_LIVE) switchChannelByDelta(-1) else playerView?.showController()
        true
      }
      KeyEvent.KEYCODE_DPAD_RIGHT -> {
        if (mode == MODE_LIVE) switchChannelByDelta(+1) else playerView?.showController()
        true
      }
      KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
        playerView?.showController()
        true
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

// Current TV safe-area overscan percent (0-8), pushed from JS via
// AndroidVideoBridge.setTvOverscan and read by tryLaunch for every launch intent.
object TvOverscanState {
  @Volatile
  var percent: Int = 0
}

// Remembered receiver volume/mute level, re-applied by initializePlayer() so a
// relaunch (channel switch, onNewIntent) doesn't reset the level a remote set.
object ReceiverVolumeState {
  @Volatile
  var volume: Float = 1f
  @Volatile
  var muted: Boolean = false
}

// In-process remote control for the TV receiver mode: AndroidVideoBridge
// routes xt:receiver-control commands here instead of round-tripping through
// an Intent/broadcast, since both live in the same process.
object NativePlayerControl {
  @Volatile
  private var activeActivity: VideoActivity? = null

  fun register(activity: VideoActivity) {
    activeActivity = activity
  }

  fun unregister(activity: VideoActivity) {
    if (activeActivity === activity) activeActivity = null
  }

  fun isActive(): Boolean = activeActivity != null

  fun setPlayWhenReady(playing: Boolean) {
    val activity = activeActivity ?: return
    activity.runOnUiThread { activity.applyPlayWhenReady(playing) }
  }

  fun seekToMs(positionMs: Long) {
    val activity = activeActivity ?: return
    activity.runOnUiThread { activity.applySeekToMs(positionMs) }
  }

  fun setVolume(level: Float, muted: Boolean) {
    val activity = activeActivity ?: return
    activity.runOnUiThread { activity.applyVolume(level, muted) }
  }

  fun finishPlayback() {
    val activity = activeActivity ?: return
    activity.runOnUiThread { activity.finish() }
  }
}

object EventQueue {
  private const val PREF_NAME = "xt_native_events"
  private const val KEY_QUEUE = "queue"
  private const val MAX_ENTRIES = 200

  // Installed by AndroidVideoBridge.receiverSessionStart(); returning false falls back to the queue below.
  @Volatile
  var pushListener: ((String, JSONObject) -> Boolean)? = null

  @Synchronized
  fun append(activity: android.content.Context, type: String, payload: JSONObject) {
    val listener = pushListener
    if (listener != null && listener(type, payload)) return
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
      "xt:android-native-volume" ->
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
