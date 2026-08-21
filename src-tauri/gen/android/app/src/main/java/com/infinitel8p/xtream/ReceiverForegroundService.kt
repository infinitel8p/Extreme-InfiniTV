package com.infinitel8p.xtream

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log

/**
 * Foreground service tied to the receiver server's lifetime: holds a partial
 * wake lock + Wi-Fi lock so casts still land while the app is backgrounded
 * or the device tries to doze.
 */
class ReceiverForegroundService : Service() {

  companion object {
    private const val TAG = "ReceiverKeepAlive"
    private const val CHANNEL_ID = "receiver"
    private const val NOTIFICATION_ID = 4201
    private const val LOCK_TAG = "xtream:receiver"
    private const val WAKE_LOCK_TIMEOUT_MS = 24 * 60 * 60 * 1000L

    const val ACTION_START = "com.infinitel8p.xtream.receiver.START"
    const val ACTION_STOP = "com.infinitel8p.xtream.receiver.STOP"
    const val EXTRA_DEVICE_NAME = "deviceName"
  }

  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
      }
      ACTION_START -> {
        val deviceName = intent.getStringExtra(EXTRA_DEVICE_NAME).orEmpty()
        startForegroundNotification(deviceName)
        acquireLocks()
      }
      else -> Log.w(TAG, "onStartCommand: unhandled action ${intent?.action}")
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    releaseLocks()
    super.onDestroy()
  }

  private fun startForegroundNotification(deviceName: String) {
    ensureNotificationChannel()
    val notification = buildNotification(deviceName)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun ensureNotificationChannel() {
    val manager = getSystemService(NotificationManager::class.java)
    val channel = NotificationChannel(
      CHANNEL_ID,
      getString(R.string.receiver_notification_channel),
      NotificationManager.IMPORTANCE_LOW
    )
    manager.createNotificationChannel(channel)
  }

  private fun buildNotification(deviceName: String): Notification {
    val contentIntent = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
      PendingIntent.FLAG_IMMUTABLE
    )
    return Notification.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_brand_mark)
      .setContentTitle(getString(R.string.receiver_notification_title))
      .setContentText(getString(R.string.receiver_notification_text, deviceName))
      .setContentIntent(contentIntent)
      .setOngoing(true)
      .build()
  }

  private fun acquireLocks() {
    if (wakeLock == null) {
      val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, LOCK_TAG).apply {
        setReferenceCounted(false)
      }
    }
    wakeLock?.let { if (!it.isHeld) it.acquire(WAKE_LOCK_TIMEOUT_MS) }

    if (wifiLock == null) {
      val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
      val lockType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        WifiManager.WIFI_MODE_FULL_LOW_LATENCY
      } else {
        WifiManager.WIFI_MODE_FULL_HIGH_PERF
      }
      wifiLock = wifiManager.createWifiLock(lockType, LOCK_TAG).apply {
        setReferenceCounted(false)
      }
    }
    wifiLock?.let { if (!it.isHeld) it.acquire() }
  }

  private fun releaseLocks() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wifiLock?.let { if (it.isHeld) it.release() }
  }
}
