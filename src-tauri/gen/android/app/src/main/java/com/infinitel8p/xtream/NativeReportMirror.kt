package com.infinitel8p.xtream

import android.util.Log
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject

data class NativeReportMirrorConfig(
  val port: Int,
  val token: String,
  val generation: Long,
  val contentKey: String,
  val title: String,
  val isLive: Boolean,
)

// Mirrors VideoActivity events into the receiver's HTTP server while its WebView is suspended.
object NativeReportMirror {
  private const val TAG = "NativeReportMirror"
  private const val HEADER_TOKEN = "X-XT-Internal"
  private const val EARLY_409_RETRY_DELAY_MS = 250L
  private const val EARLY_409_MAX_ATTEMPTS = 10
  private val JSON_MEDIA_TYPE = "application/json".toMediaType()

  private val reportClient = OkHttpClient.Builder()
    .connectTimeout(2, TimeUnit.SECONDS)
    .readTimeout(2, TimeUnit.SECONDS)
    .build()
  private val pollClient = OkHttpClient.Builder()
    .connectTimeout(2, TimeUnit.SECONDS)
    .readTimeout(35, TimeUnit.SECONDS)
    .build()
  private val pollExecutor = Executors.newSingleThreadExecutor()

  @Volatile private var currentSession: Session? = null

  // Isolated per launch so a stale response from a torn-down session can't touch a newer one.
  private class Session(val config: NativeReportMirrorConfig) {
    @Volatile var active = true
    @Volatile var confirmedAlive = false
    @Volatile var activePollCall: Call? = null
    var currentTitle = config.title
    var knownDurationSeconds: Double? = null
    var knownVolume: Double? = null
    var knownMuted: Boolean? = null
    var lastState = "loading"
    var lastPositionSeconds = 0.0
    var lastProgressReportAtMs = 0L
  }

  fun start(newConfig: NativeReportMirrorConfig) {
    stop()
    val session = Session(newConfig)
    currentSession = session
    pollExecutor.execute { pollLoop(session) }
  }

  fun stop() {
    val session = currentSession ?: return
    currentSession = null
    session.active = false
    session.activePollCall?.cancel()
  }

  fun onEvent(type: String, payload: JSONObject) {
    val session = currentSession ?: return
    if (!session.active) return
    val contentKey = payload.optString("contentKey")
    if (contentKey.isNotBlank() && !matchesSession(session.config, contentKey)) return
    when (type) {
      "xt:android-native-progress" -> handleProgress(session, payload)
      "xt:android-native-play-state" -> handlePlayState(session, payload)
      "xt:android-native-error" -> handleError(session, payload)
      "xt:android-native-channel-changed" -> handleChannelChanged(session, payload)
      "xt:android-native-finished" -> handleFinished(session, payload)
      "xt:android-native-volume" -> handleVolume(session, payload)
    }
  }

  // "live:<channelId>" is VideoActivity's contentKey for a live channel switch, not the launch key.
  private fun matchesSession(config: NativeReportMirrorConfig, contentKey: String): Boolean {
    if (contentKey == config.contentKey) return true
    return config.isLive && contentKey.startsWith("live:")
  }

  private fun handleProgress(session: Session, payload: JSONObject) {
    val now = System.currentTimeMillis()
    if (now - session.lastProgressReportAtMs < 1000) return
    session.lastProgressReportAtMs = now
    val durationMs = payload.optLong("durationMs", -1L)
    if (durationMs > 0) session.knownDurationSeconds = durationMs / 1000.0
    session.lastState = "playing"
    session.lastPositionSeconds = payload.optLong("positionMs", 0L).coerceAtLeast(0L) / 1000.0
    sendReport(session)
  }

  private fun handlePlayState(session: Session, payload: JSONObject) {
    session.lastState = if (payload.optBoolean("playing", false)) "playing" else "paused"
    session.lastPositionSeconds = payload.optLong("positionMs", 0L).coerceAtLeast(0L) / 1000.0
    sendReport(session)
  }

  private fun handleError(session: Session, payload: JSONObject) {
    session.lastState = "error"
    session.lastPositionSeconds = 0.0
    val code = payload.optString("code", "?")
    val message = payload.optString("message", "")
    sendReport(session, error = if (message.isNotBlank()) "$code: $message" else code)
  }

  private fun handleChannelChanged(session: Session, payload: JSONObject) {
    val name = payload.optString("channelName")
    if (name.isNotBlank()) session.currentTitle = name
  }

  private fun handleFinished(session: Session, payload: JSONObject) {
    if (payload.optBoolean("completed", false)) {
      session.lastState = "ended"
      session.lastPositionSeconds = payload.optLong("finalPosMs", 0L).coerceAtLeast(0L) / 1000.0
    } else {
      session.lastState = "idle"
      session.currentTitle = ""
      session.knownDurationSeconds = null
      session.lastPositionSeconds = 0.0
    }
    sendReport(session)
    stop()
  }

  private fun handleVolume(session: Session, payload: JSONObject) {
    if (payload.has("volume")) session.knownVolume = payload.optDouble("volume")
    if (payload.has("muted")) session.knownMuted = payload.optBoolean("muted")
    sendReport(session)
  }

  private fun sendReport(session: Session, error: String? = null) {
    val report = JSONObject().apply {
      put("state", session.lastState)
      put("positionSeconds", session.lastPositionSeconds)
      putOrNull("durationSeconds", session.knownDurationSeconds)
      putOrNull("title", session.currentTitle.ifBlank { null })
      putOrNull("error", error)
      putOrNull("volume", session.knownVolume)
      putOrNull("muted", session.knownMuted)
    }
    val body = JSONObject().apply {
      put("generation", session.config.generation)
      put("report", report)
    }
    val request = Request.Builder()
      .url("http://127.0.0.1:${session.config.port}/internal/report")
      .header(HEADER_TOKEN, session.config.token)
      .post(body.toString().toRequestBody(JSON_MEDIA_TYPE))
      .build()
    reportClient.newCall(request).enqueue(object : Callback {
      override fun onFailure(call: Call, error: IOException) {
        Log.w(TAG, "report failed: $error")
      }
      override fun onResponse(call: Call, response: Response) {
        if (response.isSuccessful) session.confirmedAlive = true
        else if (response.code == 409 && session.confirmedAlive) session.active = false
        response.close()
      }
    })
  }

  private fun JSONObject.putOrNull(key: String, value: Any?) {
    put(key, value ?: JSONObject.NULL)
  }

  private fun pollLoop(session: Session) {
    var earlyAttempts = 0
    while (session.active && currentSession === session) {
      try {
        val request = Request.Builder()
          .url("http://127.0.0.1:${session.config.port}/internal/commands?generation=${session.config.generation}&wait=25")
          .header(HEADER_TOKEN, session.config.token)
          .get()
          .build()
        val call = pollClient.newCall(request)
        session.activePollCall = call
        call.execute().use { response ->
          if (response.code == 409) {
            // Early 409s mean Rust hasn't installed the mirror yet, not a stale session.
            if (session.confirmedAlive) {
              session.active = false
              return
            }
            earlyAttempts++
            if (earlyAttempts > EARLY_409_MAX_ATTEMPTS) {
              Log.w(TAG, "giving up: mirror never confirmed after $earlyAttempts attempts")
              session.active = false
              return
            }
            Thread.sleep(EARLY_409_RETRY_DELAY_MS)
            return@use
          }
          if (!response.isSuccessful) {
            Thread.sleep(1000)
            return@use
          }
          session.confirmedAlive = true
          val commands = JSONObject(response.body?.string() ?: "{}").optJSONArray("commands") ?: JSONArray()
          for (index in 0 until commands.length()) {
            val command = commands.optJSONObject(index) ?: continue
            dispatchCommand(session, command)
          }
        }
      } catch (error: IOException) {
        if (!session.active || currentSession !== session) break
        Log.w(TAG, "poll failed: $error")
        Thread.sleep(1000)
      }
    }
  }

  private fun dispatchCommand(session: Session, command: JSONObject) {
    when (command.optString("action")) {
      "pause" -> NativePlayerControl.setPlayWhenReady(false)
      "resume" -> NativePlayerControl.setPlayWhenReady(true)
      "stop" -> NativePlayerControl.finishPlayback()
      "seek" -> NativePlayerControl.seekToMs((command.optDouble("positionSeconds", 0.0) * 1000).toLong())
      "volume" -> NativePlayerControl.setVolume(
        command.optDouble("volume", session.knownVolume ?: 1.0).toFloat(),
        command.optBoolean("muted", session.knownMuted ?: false),
      )
    }
  }
}
