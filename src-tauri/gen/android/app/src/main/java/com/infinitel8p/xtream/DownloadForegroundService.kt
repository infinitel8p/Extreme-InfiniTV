package com.infinitel8p.xtream

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.provider.MediaStore
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject

// Native download record, mirrors the JS-side shape documented for window.AndroidDownload.
// id/url/uri/title/headers/dns/mediaStore are fixed for the lifetime of a record (a re-`start()`
// replaces the whole object); status/bytesDone/bytesTotal/error/userPaused/updatedAt mutate in place
// while a transfer runs, always under DownloadEngine's lock.
data class DownloadRecord(
  val id: String,
  val url: String,
  val uri: String,
  val title: String,
  val headers: Map<String, String>,
  val dns: String,
  val mediaStore: Boolean,
  var status: String = "queued",
  var bytesDone: Long = 0L,
  var bytesTotal: Long = 0L,
  var error: String = "",
  var userPaused: Boolean = false,
  var updatedAt: Long = System.currentTimeMillis(),
)

// SharedPreferences-backed persistence of the native download records, one JSON array under one key.
// Mirrors VideoActivity.EventQueue's @Synchronized-on-the-object idiom.
object DownloadStore {
  private const val PREF_NAME = "xt_native_downloads"
  private const val KEY_RECORDS = "records"
  private const val KEY_MAX_CONCURRENT = "maxConcurrent"

  @Synchronized
  fun load(context: Context): List<DownloadRecord> {
    val records = mutableListOf<DownloadRecord>()
    try {
      val raw = prefs(context).getString(KEY_RECORDS, "[]") ?: "[]"
      val array = JSONArray(raw)
      for (index in 0 until array.length()) {
        val entry = array.optJSONObject(index) ?: continue
        fromJson(entry)?.let { records.add(it) }
      }
    } catch (error: Throwable) {
      Log.w("DownloadStore", "load failed", error)
    }
    return records
  }

  @Synchronized
  fun save(context: Context, records: Collection<DownloadRecord>) {
    try {
      val array = JSONArray()
      for (record in records) array.put(toJson(record))
      prefs(context).edit().putString(KEY_RECORDS, array.toString()).apply()
    } catch (error: Throwable) {
      Log.w("DownloadStore", "save failed", error)
    }
  }

  @Synchronized
  fun loadMaxConcurrent(context: Context): Int =
    prefs(context).getInt(KEY_MAX_CONCURRENT, 1).coerceIn(1, 4)

  @Synchronized
  fun saveMaxConcurrent(context: Context, value: Int) {
    prefs(context).edit().putInt(KEY_MAX_CONCURRENT, value).apply()
  }

  fun toJson(record: DownloadRecord): JSONObject {
    val headersJson = JSONObject()
    for ((headerName, headerValue) in record.headers) headersJson.put(headerName, headerValue)
    return JSONObject().apply {
      put("id", record.id)
      put("url", record.url)
      put("uri", record.uri)
      put("title", record.title)
      put("headers", headersJson)
      put("dns", record.dns)
      put("mediaStore", record.mediaStore)
      put("status", record.status)
      put("bytesDone", record.bytesDone)
      put("bytesTotal", record.bytesTotal)
      put("error", record.error)
      put("userPaused", record.userPaused)
      put("updatedAt", record.updatedAt)
    }
  }

  private fun fromJson(json: JSONObject): DownloadRecord? {
    val id = json.optString("id")
    if (id.isBlank()) return null
    val headers = LinkedHashMap<String, String>()
    json.optJSONObject("headers")?.let { headersJson ->
      val keys = headersJson.keys()
      while (keys.hasNext()) {
        val key = keys.next()
        headers[key] = headersJson.optString(key)
      }
    }
    return DownloadRecord(
      id = id,
      url = json.optString("url"),
      uri = json.optString("uri"),
      title = json.optString("title"),
      headers = headers,
      dns = json.optString("dns"),
      mediaStore = json.optBoolean("mediaStore", false),
      status = json.optString("status", "queued"),
      bytesDone = json.optLong("bytesDone", 0L),
      bytesTotal = json.optLong("bytesTotal", 0L),
      error = json.optString("error", ""),
      userPaused = json.optBoolean("userPaused", false),
      updatedAt = json.optLong("updatedAt", System.currentTimeMillis()),
    )
  }

  private fun prefs(context: Context): SharedPreferences =
    context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
}

// Native -> JS event fan-out. Installed by DownloadBridge while the hosted WebView is alive.
object DownloadEvents {
  private const val PROGRESS_THROTTLE_MS = 500L

  @Volatile
  var pushListener: ((JSONObject) -> Unit)? = null

  private val lastEmitAtMs = ConcurrentHashMap<String, Long>()

  // Returns true when this call actually forwarded to the listener (or would have, absent one),
  // so callers can gate persistence on the same 500ms-per-id cadence for progress ticks.
  fun emit(record: DownloadRecord, statusChanged: Boolean): Boolean {
    val now = System.currentTimeMillis()
    if (!statusChanged) {
      val lastEmitAt = lastEmitAtMs[record.id] ?: 0L
      if (now - lastEmitAt < PROGRESS_THROTTLE_MS) return false
    }
    lastEmitAtMs[record.id] = now
    val listener = pushListener
    if (listener != null) {
      try {
        listener(DownloadStore.toJson(record))
      } catch (error: Throwable) {
        Log.w("DownloadEvents", "listener threw", error)
      }
    }
    return true
  }

  fun clear(id: String) {
    lastEmitAtMs.remove(id)
  }

  // Non-mutating throttle check, so a caller can decide whether a progress tick is worth persisting
  // before actually committing the throttle timestamp via emit().
  fun shouldEmitProgress(id: String): Boolean {
    val lastEmitAt = lastEmitAtMs[id] ?: 0L
    return System.currentTimeMillis() - lastEmitAt >= PROGRESS_THROTTLE_MS
  }
}

private enum class TransferOutcome { DONE, ERROR, RESTART }

// Process-wide transfer engine: owns the record map, FIFO queue and in-flight workers. The bridge
// mutates through this object directly (not via Intents, to avoid the binder size/latency cost of
// routing every call through the Service), then asks DownloadForegroundService to come up via
// ensureRunning(). All record/queue mutation happens under `lock`; every mutation persists.
object DownloadEngine {
  private const val TAG = "DownloadEngine"
  private const val STALL_TIMEOUT_MS = 30_000L
  private const val STALL_CHECK_INTERVAL_MS = 5_000L
  private const val MAX_AUTO_RETRIES = 5

  private val lock = Any()
  private var loaded = false

  // requireContext() reads this from worker threads without holding `lock`, so it needs to be
  // volatile even though every write happens inside ensureLoaded()'s synchronized block.
  @Volatile
  private var appContext: Context? = null

  private val records = LinkedHashMap<String, DownloadRecord>()
  private val queue = ArrayDeque<String>()
  private val active = HashMap<String, TransferWorker>()
  private val autoRetries = HashMap<String, Int>()
  private var maxConcurrent = 1

  @Volatile
  private var serviceRef: DownloadForegroundService? = null

  private val transferExecutor = Executors.newCachedThreadPool()
  private val watchdogExecutor = Executors.newSingleThreadScheduledExecutor()
  private var watchdogStarted = false
  private val clientCache = ConcurrentHashMap<String, OkHttpClient>()

  fun ensureLoaded(context: Context) {
    synchronized(lock) {
      if (loaded) return
      loaded = true
      appContext = context.applicationContext
      for (record in DownloadStore.load(appContext!!)) records[record.id] = record
      maxConcurrent = DownloadStore.loadMaxConcurrent(appContext!!)
      startWatchdogLocked()
    }
  }

  fun attachService(service: DownloadForegroundService) {
    serviceRef = service
  }

  fun detachService(service: DownloadForegroundService) {
    if (serviceRef === service) serviceRef = null
  }

  fun requireContext(): Context = appContext ?: throw IllegalStateException("DownloadEngine not initialized")

  // --- Bridge-facing mutations -------------------------------------------------------------

  fun start(context: Context, json: JSONObject): Boolean {
    ensureLoaded(context)
    val id = json.optString("id")
    if (id.isBlank()) return false
    var workerToCancel: TransferWorker? = null
    var recordForEvent: DownloadRecord? = null
    synchronized(lock) {
      val existing = records[id]
      val record = DownloadRecord(
        id = id,
        url = json.optString("url"),
        uri = json.optString("uri"),
        title = json.optString("title"),
        headers = parseHeaders(json.optJSONObject("headers")),
        dns = json.optString("dns"),
        mediaStore = json.optBoolean("mediaStore", false),
        status = "queued",
        bytesDone = existing?.bytesDone ?: 0L,
        bytesTotal = existing?.bytesTotal ?: 0L,
        error = "",
        userPaused = false,
        updatedAt = System.currentTimeMillis(),
      )
      records[id] = record
      autoRetries[id] = 0
      maxConcurrent = json.optInt("maxConcurrent", maxConcurrent).coerceIn(1, 4)
      DownloadStore.saveMaxConcurrent(requireContext(), maxConcurrent)
      workerToCancel = active.remove(id)
      queue.remove(id)
      enqueueLocked(id)
      persistLocked()
      recordForEvent = record
    }
    workerToCancel?.cancel("replaced")
    recordForEvent?.let { DownloadEvents.emit(it, statusChanged = true) }
    val started = DownloadForegroundService.ensureRunning(requireContext())
    pump()
    return started
  }

  fun pause(id: String): Boolean {
    var workerToCancel: TransferWorker? = null
    var recordForEvent: DownloadRecord? = null
    synchronized(lock) {
      val record = records[id] ?: return false
      record.userPaused = true
      setStatusLocked(record, "paused")
      queue.remove(id)
      workerToCancel = active.remove(id)
      persistLocked()
      recordForEvent = record
    }
    workerToCancel?.cancel("pause")
    recordForEvent?.let { DownloadEvents.emit(it, statusChanged = true) }
    pump()
    return true
  }

  fun resume(id: String): Boolean {
    var recordForEvent: DownloadRecord? = null
    synchronized(lock) {
      val record = records[id] ?: return false
      record.userPaused = false
      setStatusLocked(record, "queued")
      autoRetries[id] = 0
      enqueueLocked(id)
      persistLocked()
      recordForEvent = record
    }
    recordForEvent?.let { DownloadEvents.emit(it, statusChanged = true) }
    pump()
    return true
  }

  fun remove(id: String): Boolean {
    var workerToCancel: TransferWorker? = null
    synchronized(lock) {
      records.remove(id) ?: return false
      queue.remove(id)
      workerToCancel = active.remove(id)
      autoRetries.remove(id)
      persistLocked()
    }
    workerToCancel?.cancel("remove")
    DownloadEvents.clear(id)
    pump()
    return true
  }

  // Used by the app's "Reset everything" flow: wipes every record, cancels anything in flight,
  // and pokes the service so it drops out of the foreground state.
  fun clearAll(context: Context): Boolean {
    ensureLoaded(context)
    val workersToCancel: List<TransferWorker>
    val idsToClear: List<String>
    synchronized(lock) {
      workersToCancel = active.values.toList()
      idsToClear = records.keys.toList()
      active.clear()
      queue.clear()
      records.clear()
      autoRetries.clear()
      persistLocked()
    }
    for (worker in workersToCancel) worker.cancel("remove")
    for (id in idsToClear) DownloadEvents.clear(id)
    notifyServiceStateChanged()
    return true
  }

  fun setMaxConcurrent(context: Context, requested: Int) {
    ensureLoaded(context)
    synchronized(lock) {
      maxConcurrent = requested.coerceIn(1, 4)
      DownloadStore.saveMaxConcurrent(requireContext(), maxConcurrent)
    }
    pump()
  }

  fun snapshot(context: Context): String {
    ensureLoaded(context)
    synchronized(lock) {
      val array = JSONArray()
      for (record in records.values) array.put(DownloadStore.toJson(record))
      return array.toString()
    }
  }

  // --- Service-facing lifecycle helpers -----------------------------------------------------

  fun reconcileAfterRestart() {
    synchronized(lock) {
      for (record in records.values) {
        if (active.containsKey(record.id)) continue
        val eligible = record.status == "queued" || record.status == "downloading" ||
          (record.status == "stalled" && !record.userPaused)
        if (!eligible) continue
        if (record.status == "downloading") record.status = "queued"
        enqueueLocked(record.id)
      }
      persistLocked()
    }
    pump()
  }

  fun pauseAll() {
    val changed = mutableListOf<DownloadRecord>()
    val workersToCancel = mutableListOf<TransferWorker>()
    synchronized(lock) {
      for (record in records.values) {
        if (record.status == "queued" || record.status == "downloading") {
          record.userPaused = true
          setStatusLocked(record, "paused")
          changed.add(record)
        }
      }
      for (record in changed) {
        queue.remove(record.id)
        active.remove(record.id)?.let { workersToCancel.add(it) }
      }
      persistLocked()
    }
    for (worker in workersToCancel) worker.cancel("pause")
    for (record in changed) DownloadEvents.emit(record, statusChanged = true)
    pump()
  }

  fun retryStalledRecords() {
    val changed = mutableListOf<DownloadRecord>()
    synchronized(lock) {
      for (record in records.values) {
        if (record.status != "stalled" || record.userPaused) continue
        val retries = autoRetries.getOrDefault(record.id, 0)
        if (retries >= MAX_AUTO_RETRIES) continue
        autoRetries[record.id] = retries + 1
        setStatusLocked(record, "queued")
        enqueueLocked(record.id)
        changed.add(record)
      }
      persistLocked()
    }
    for (record in changed) DownloadEvents.emit(record, statusChanged = true)
    pump()
  }

  fun hasActiveOrPendingWork(): Boolean {
    synchronized(lock) {
      if (active.isNotEmpty()) return true
      for (id in queue) {
        val record = records[id] ?: continue
        if (!record.userPaused) return true
      }
      return false
    }
  }

  // Only the records actually transferring right now, for the ongoing notification's aggregate.
  fun activeRecordsSnapshot(): List<DownloadRecord> {
    synchronized(lock) {
      return active.keys.mapNotNull { id -> records[id]?.copy() }
    }
  }

  fun bytesTotalHint(id: String): Long {
    synchronized(lock) { return records[id]?.bytesTotal ?: 0L }
  }

  fun clientFor(dns: String): OkHttpClient {
    return clientCache.getOrPut(dns) {
      OkHttpClient.Builder()
        .dns(CustomDns.build(dns))
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()
    }
  }

  // --- Transfer status callbacks, called from TransferWorker threads -----------------------

  fun onTransferStarted(id: String) {
    var recordForEvent: DownloadRecord? = null
    synchronized(lock) {
      val record = records[id] ?: return
      setStatusLocked(record, "downloading")
      persistLocked()
      recordForEvent = record
    }
    recordForEvent?.let { DownloadEvents.emit(it, statusChanged = true) }
    notifyServiceStateChanged()
  }

  fun onTransferProgress(id: String, bytesDone: Long, bytesTotal: Long) {
    var recordForEvent: DownloadRecord? = null
    var shouldEmit = false
    synchronized(lock) {
      val record = records[id] ?: return
      record.bytesDone = bytesDone
      if (bytesTotal > 0) record.bytesTotal = bytesTotal
      record.updatedAt = System.currentTimeMillis()
      autoRetries[id] = 0
      // Peek at the throttle instead of calling emit() here, so the actual emit (which commits the
      // throttle timestamp and calls the listener) happens after releasing the lock, like the other
      // onTransfer* callbacks.
      shouldEmit = DownloadEvents.shouldEmitProgress(id)
      if (shouldEmit) persistLocked()
      recordForEvent = record
    }
    if (shouldEmit) {
      recordForEvent?.let { DownloadEvents.emit(it, statusChanged = false) }
      notifyServiceStateChanged()
    }
  }

  fun onTransferDone(id: String, bytesWritten: Long) {
    var recordForEvent: DownloadRecord? = null
    var clearMediaStore = false
    synchronized(lock) {
      val record = records[id] ?: return
      record.bytesDone = bytesWritten
      if (record.bytesTotal <= 0) record.bytesTotal = bytesWritten
      setStatusLocked(record, "done")
      autoRetries.remove(id)
      clearMediaStore = record.mediaStore
      persistLocked()
      recordForEvent = record
    }
    val record = recordForEvent ?: return
    if (clearMediaStore) clearMediaStorePending(record.uri)
    DownloadEvents.emit(record, statusChanged = true)
    DownloadForegroundService.showCompletionNotification(requireContext(), record)
    notifyServiceStateChanged()
  }

  fun onTransferError(id: String, message: String) {
    var recordForEvent: DownloadRecord? = null
    synchronized(lock) {
      val record = records[id] ?: return
      setStatusLocked(record, "error", message)
      persistLocked()
      recordForEvent = record
    }
    recordForEvent?.let { DownloadEvents.emit(it, statusChanged = true) }
    notifyServiceStateChanged()
  }

  fun onTransferStalled(id: String, message: String) {
    var recordForEvent: DownloadRecord? = null
    synchronized(lock) {
      val record = records[id] ?: return
      setStatusLocked(record, "stalled", message)
      persistLocked()
      recordForEvent = record
    }
    recordForEvent?.let { DownloadEvents.emit(it, statusChanged = true) }
    notifyServiceStateChanged()
  }

  // --- Internals ---------------------------------------------------------------------------

  private fun pump() {
    val toSubmit = mutableListOf<TransferWorker>()
    synchronized(lock) {
      while (active.size < maxConcurrent && queue.isNotEmpty()) {
        val id = queue.removeFirst()
        val record = records[id] ?: continue
        if (record.userPaused) continue
        if (active.containsKey(id)) continue
        if (record.status != "queued" && record.status != "stalled" && record.status != "error") continue
        val worker = TransferWorker(record)
        active[id] = worker
        toSubmit.add(worker)
      }
    }
    for (worker in toSubmit) transferExecutor.execute { runWorker(worker) }
    notifyServiceStateChanged()
  }

  private fun runWorker(worker: TransferWorker) {
    try {
      worker.run()
    } finally {
      synchronized(lock) {
        if (active[worker.record.id] === worker) active.remove(worker.record.id)
      }
      pump()
    }
  }

  private fun clearMediaStorePending(uriString: String) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    try {
      val context = requireContext()
      val values = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
      context.contentResolver.update(Uri.parse(uriString), values, null, null)
    } catch (error: Throwable) {
      Log.w(TAG, "clearing IS_PENDING failed for $uriString", error)
    }
  }

  private fun notifyServiceStateChanged() {
    serviceRef?.onEngineStateChanged()
  }

  private fun enqueueLocked(id: String) {
    if (active.containsKey(id)) return
    if (queue.contains(id)) return
    queue.addLast(id)
  }

  private fun setStatusLocked(record: DownloadRecord, status: String, error: String = "") {
    record.status = status
    record.error = error
    record.updatedAt = System.currentTimeMillis()
  }

  private fun persistLocked() {
    DownloadStore.save(requireContext(), records.values)
  }

  private fun parseHeaders(headersJson: JSONObject?): LinkedHashMap<String, String> {
    val headers = LinkedHashMap<String, String>()
    if (headersJson == null) return headers
    val keys = headersJson.keys()
    while (keys.hasNext()) {
      val key = keys.next()
      headers[key] = headersJson.optString(key)
    }
    return headers
  }

  private fun startWatchdogLocked() {
    if (watchdogStarted) return
    watchdogStarted = true
    watchdogExecutor.scheduleWithFixedDelay(
      { checkStalledTransfers() },
      STALL_CHECK_INTERVAL_MS,
      STALL_CHECK_INTERVAL_MS,
      TimeUnit.MILLISECONDS
    )
  }

  private fun checkStalledTransfers() {
    val workersToCancel = mutableListOf<TransferWorker>()
    synchronized(lock) {
      val now = System.currentTimeMillis()
      for (worker in active.values) {
        if (now - worker.lastByteAtMs >= STALL_TIMEOUT_MS) workersToCancel.add(worker)
      }
    }
    for (worker in workersToCancel) worker.cancel("stall")
  }
}

// One per in-flight transfer, run on DownloadEngine's cached thread pool. `record` is the same
// mutable instance stored in DownloadEngine's map (safely published via the synchronized block
// that created this worker); only its immutable fields (id/url/uri/headers/dns/mediaStore/title)
// are read here, everything mutable is read/written through DownloadEngine's locked methods.
private class TransferWorker(val record: DownloadRecord) {
  companion object {
    private const val TAG = "DownloadTransfer"
    private const val BUFFER_SIZE = 64 * 1024
  }

  @Volatile var lastByteAtMs: Long = System.currentTimeMillis()
  @Volatile private var call: Call? = null
  @Volatile private var cancelReason: String? = null

  fun cancel(reason: String) {
    cancelReason = reason
    call?.cancel()
  }

  fun run() {
    DownloadEngine.onTransferStarted(record.id)
    try {
      performTransferWithRestart()
    } catch (error: IOException) {
      handleIOFailure(error)
    } catch (error: Throwable) {
      handleNonIOFailure(error)
    }
  }

  // Anything other than IOException (bad URL, SecurityException on the URI, etc.) is a permanent
  // problem with this transfer, not a transient network hiccup - goes to "error", not "stalled",
  // so the connectivity-triggered auto-retry (which only re-enqueues "stalled" records) skips it.
  private fun handleNonIOFailure(error: Throwable) {
    if (cancelReason != null) return
    Log.w(TAG, "transfer error for ${record.id}", error)
    val message = error.message?.takeIf { it.isNotBlank() } ?: error::class.java.simpleName
    DownloadEngine.onTransferError(record.id, message)
  }

  private fun handleIOFailure(error: IOException) {
    Log.w(TAG, "transfer IO failure for ${record.id} (cancelReason=$cancelReason)", error)
    when (cancelReason) {
      "pause", "remove", "replaced" -> return
      "stall" -> DownloadEngine.onTransferStalled(record.id, "No data received for 30s.")
      else -> DownloadEngine.onTransferStalled(record.id, "Connection lost.")
    }
  }

  private fun performTransferWithRestart() {
    var attempt = 0
    var forceRestartFromZero = false
    while (true) {
      attempt++
      val context = DownloadEngine.requireContext()
      val uri = Uri.parse(record.uri)
      val existingSize = if (forceRestartFromZero) 0L else existingFileSize(context, uri)
      val requestBuilder = Request.Builder().url(record.url)
      for ((headerName, headerValue) in record.headers) requestBuilder.header(headerName, headerValue)
      if (existingSize > 0) requestBuilder.header("Range", "bytes=$existingSize-")
      val client = DownloadEngine.clientFor(record.dns)
      val call = client.newCall(requestBuilder.build())
      this.call = call
      val response = call.execute()
      val outcome = response.use { activeResponse -> handleResponse(context, uri, activeResponse, existingSize) }
      if (outcome != TransferOutcome.RESTART) return
      if (attempt >= 2) {
        DownloadEngine.onTransferError(record.id, "HTTP 416 Range Not Satisfiable")
        return
      }
      forceRestartFromZero = true
    }
  }

  private fun handleResponse(context: Context, uri: Uri, response: Response, existingSize: Long): TransferOutcome {
    return when (response.code) {
      206 -> {
        val contentLength = response.body?.contentLength() ?: -1L
        val bytesTotal = if (contentLength >= 0) existingSize + contentLength else 0L
        writeBody(context, uri, response, "wa", existingSize, bytesTotal)
      }
      200 -> {
        val contentLength = response.body?.contentLength() ?: -1L
        val bytesTotal = if (contentLength >= 0) contentLength else 0L
        writeBody(context, uri, response, "wt", 0L, bytesTotal)
      }
      416 -> {
        val knownTotal = DownloadEngine.bytesTotalHint(record.id)
        if (knownTotal > 0 && existingSize == knownTotal) {
          DownloadEngine.onTransferDone(record.id, existingSize)
          TransferOutcome.DONE
        } else {
          TransferOutcome.RESTART
        }
      }
      else -> {
        if (response.isSuccessful) {
          val contentLength = response.body?.contentLength() ?: -1L
          val bytesTotal = if (contentLength >= 0) existingSize + contentLength else 0L
          writeBody(context, uri, response, "wa", existingSize, bytesTotal)
        } else {
          DownloadEngine.onTransferError(record.id, "HTTP ${response.code} ${response.message}")
          TransferOutcome.ERROR
        }
      }
    }
  }

  private fun writeBody(
    context: Context,
    uri: Uri,
    response: Response,
    mode: String,
    startingBytes: Long,
    bytesTotal: Long,
  ): TransferOutcome {
    DownloadEngine.onTransferProgress(record.id, startingBytes, bytesTotal)
    val body = response.body ?: throw IOException("empty response body for ${record.id}")
    val outputStream = context.contentResolver.openOutputStream(uri, mode)
      ?: throw IOException("cannot open output stream for $uri")
    var bytesWritten = startingBytes
    outputStream.use { output ->
      body.byteStream().use { input ->
        val buffer = ByteArray(BUFFER_SIZE)
        lastByteAtMs = System.currentTimeMillis()
        while (true) {
          val readCount = input.read(buffer)
          if (readCount < 0) break
          output.write(buffer, 0, readCount)
          bytesWritten += readCount
          lastByteAtMs = System.currentTimeMillis()
          DownloadEngine.onTransferProgress(record.id, bytesWritten, bytesTotal)
        }
        output.flush()
      }
    }
    if (bytesTotal > 0 && bytesWritten != bytesTotal) {
      DownloadEngine.onTransferError(record.id, "Size mismatch: got $bytesWritten, expected $bytesTotal")
      return TransferOutcome.ERROR
    }
    DownloadEngine.onTransferDone(record.id, bytesWritten)
    return TransferOutcome.DONE
  }

  private fun existingFileSize(context: Context, uri: Uri): Long {
    try {
      context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { descriptor ->
        if (descriptor.length >= 0) return descriptor.length
      }
    } catch (error: Throwable) {
      // Fall through to the statSize fallback below.
    }
    try {
      context.contentResolver.openFileDescriptor(uri, "r")?.use { descriptor ->
        if (descriptor.statSize >= 0) return descriptor.statSize
      }
    } catch (error: Throwable) {
      // Treated as 0 below, matching the contract's "treat failures as 0".
    }
    return 0L
  }
}

// Foreground service hosting the download transfer engine so byte transfer survives page
// navigation, screen off, backgrounding and process death. Owns the ongoing/aggregate
// notification, wake/Wi-Fi locks and the connectivity-triggered auto-retry callback; the actual
// queue and transfer state live in DownloadEngine so bridge calls can mutate them even before this
// service has finished starting.
class DownloadForegroundService : Service() {

  companion object {
    private const val TAG = "DownloadForegroundService"
    private const val CHANNEL_ID = "downloads"
    // Kept well above NOTIFICATION_ID_COMPLETE_BASE's range (4500 + hash % 100000, so up to 104499)
    // so the ongoing notification can never collide with a completion notification.
    private const val NOTIFICATION_ID_ONGOING = 999999
    private const val NOTIFICATION_ID_COMPLETE_BASE = 4500
    private const val LOCK_TAG = "xtream:downloads"
    private const val WAKE_LOCK_TIMEOUT_MS = 24 * 60 * 60 * 1000L
    private const val NOTIFICATION_REBUILD_THROTTLE_MS = 1_000L

    const val ACTION_SYNC = "com.infinitel8p.xtream.download.SYNC"
    const val ACTION_PAUSE_ALL = "com.infinitel8p.xtream.download.PAUSE_ALL"

    fun ensureRunning(context: Context): Boolean {
      return try {
        val intent = Intent(context, DownloadForegroundService::class.java).setAction(ACTION_SYNC)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
        true
      } catch (error: Throwable) {
        Log.w(TAG, "ensureRunning failed", error)
        false
      }
    }

    fun ensureNotificationChannel(context: Context) {
      val manager = context.getSystemService(NotificationManager::class.java) ?: return
      if (manager.getNotificationChannel(CHANNEL_ID) != null) return
      manager.createNotificationChannel(
        NotificationChannel(
          CHANNEL_ID,
          context.getString(R.string.downloads_notification_channel),
          NotificationManager.IMPORTANCE_LOW
        )
      )
    }

    fun showCompletionNotification(context: Context, record: DownloadRecord) {
      ensureNotificationChannel(context)
      val notificationId = NOTIFICATION_ID_COMPLETE_BASE + stableNotificationId(record.id)
      val contentIntent = PendingIntent.getActivity(
        context,
        0,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_IMMUTABLE
      )
      val notification = Notification.Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_brand_mark)
        .setContentTitle(context.getString(R.string.downloads_notification_complete_title))
        .setContentText(context.getString(R.string.downloads_notification_complete_text, record.title))
        .setContentIntent(contentIntent)
        .setAutoCancel(true)
        .build()
      try {
        NotificationManagerCompat.from(context).notify(notificationId, notification)
      } catch (error: Throwable) {
        Log.w(TAG, "completion notify failed", error)
      }
    }

    private fun stableNotificationId(id: String): Int = (id.hashCode() and 0x7fffffff) % 100000
  }

  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null
  private var connectivityCallback: ConnectivityManager.NetworkCallback? = null
  private val notificationLock = Any()
  private var lastNotificationRebuildAtMs = 0L

  // Guards against calling Service.startForeground() again on every progress tick; only the
  // foreground <-> not-foreground transitions actually call it, everything else notify()s.
  private val foregroundStarted = AtomicBoolean(false)

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    DownloadEngine.ensureLoaded(applicationContext)
    DownloadEngine.attachService(this)
    registerConnectivityCallback()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Must run before anything else: the system requires a startForeground() call in response to
    // every startForegroundService(), even if we're about to immediately decide there's nothing
    // to do and stop again - otherwise it throws a RemoteServiceException.
    ensureForeground()
    when (intent?.action) {
      ACTION_PAUSE_ALL -> DownloadEngine.pauseAll()
      else -> DownloadEngine.reconcileAfterRestart()
    }
    onEngineStateChanged()
    return START_STICKY
  }

  override fun onDestroy() {
    DownloadEngine.detachService(this)
    unregisterConnectivityCallback()
    releaseLocks()
    super.onDestroy()
  }

  // Called by DownloadEngine (any thread) whenever active/queued work might have changed.
  fun onEngineStateChanged() {
    if (DownloadEngine.hasActiveOrPendingWork()) {
      if (!foregroundStarted.get()) {
        ensureForeground()
      } else {
        rebuildNotificationThrottled()
      }
      acquireLocks()
    } else if (foregroundStarted.getAndSet(false)) {
      releaseLocks()
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
    }
  }

  private fun ensureForeground() {
    ensureNotificationChannel(this)
    val notification = buildOngoingNotification()
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID_ONGOING, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else {
        startForeground(NOTIFICATION_ID_ONGOING, notification)
      }
      foregroundStarted.set(true)
    } catch (error: Throwable) {
      // ForegroundServiceStartNotAllowedException on 12+ when restarted from the background.
      Log.w(TAG, "startForeground failed", error)
      foregroundStarted.set(false)
      stopSelf()
    }
  }

  private fun rebuildNotificationThrottled() {
    val now = System.currentTimeMillis()
    synchronized(notificationLock) {
      if (now - lastNotificationRebuildAtMs < NOTIFICATION_REBUILD_THROTTLE_MS) return
      lastNotificationRebuildAtMs = now
    }
    try {
      val manager = getSystemService(NotificationManager::class.java) ?: return
      manager.notify(NOTIFICATION_ID_ONGOING, buildOngoingNotification())
    } catch (error: Throwable) {
      Log.w(TAG, "notify failed", error)
    }
  }

  private fun buildOngoingNotification(): Notification {
    val activeRecords = DownloadEngine.activeRecordsSnapshot()
    val count = activeRecords.size.coerceAtLeast(1)
    val title = if (activeRecords.size == 1) {
      activeRecords.first().title
    } else {
      // Also covers the brief window between one transfer finishing and the next starting.
      getString(R.string.downloads_notification_title_many, count)
    }
    val bytesDone = activeRecords.sumOf { it.bytesDone }
    val bytesTotal = activeRecords.sumOf { it.bytesTotal }
    val text = if (bytesTotal > 0) {
      "${formatBytes(bytesDone)} / ${formatBytes(bytesTotal)}"
    } else {
      formatBytes(bytesDone)
    }
    val builder = Notification.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_brand_mark)
      .setContentTitle(title)
      .setContentText(text)
      .setContentIntent(contentIntent())
      .addAction(pauseAllAction())
      .setOngoing(true)
    if (bytesTotal > 0) {
      builder.setProgress(100, ((bytesDone * 100) / bytesTotal).toInt().coerceIn(0, 100), false)
    } else {
      builder.setProgress(0, 0, true)
    }
    return builder.build()
  }

  private fun contentIntent(): PendingIntent = PendingIntent.getActivity(
    this,
    0,
    Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
    PendingIntent.FLAG_IMMUTABLE
  )

  private fun pauseAllAction(): Notification.Action {
    val pauseIntent = PendingIntent.getService(
      this,
      0,
      Intent(this, DownloadForegroundService::class.java).setAction(ACTION_PAUSE_ALL),
      PendingIntent.FLAG_IMMUTABLE
    )
    return Notification.Action.Builder(
      Icon.createWithResource(this, android.R.drawable.ic_media_pause),
      getString(R.string.downloads_notification_pause_all),
      pauseIntent
    ).build()
  }

  private fun formatBytes(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    val units = arrayOf("KB", "MB", "GB", "TB")
    var value = bytes.toDouble()
    var unitIndex = -1
    while (value >= 1024 && unitIndex < units.size - 1) {
      value /= 1024
      unitIndex++
    }
    return String.format("%.1f %s", value, units[unitIndex])
  }

  private fun registerConnectivityCallback() {
    if (connectivityCallback != null) return
    val connectivityManager = getSystemService(ConnectivityManager::class.java) ?: return
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        DownloadEngine.retryStalledRecords()
      }
    }
    try {
      connectivityManager.registerDefaultNetworkCallback(callback)
      connectivityCallback = callback
    } catch (error: Throwable) {
      Log.w(TAG, "registerDefaultNetworkCallback failed", error)
    }
  }

  private fun unregisterConnectivityCallback() {
    val callback = connectivityCallback ?: return
    connectivityCallback = null
    try {
      getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(callback)
    } catch (error: Throwable) {
      Log.w(TAG, "unregisterNetworkCallback failed", error)
    }
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
