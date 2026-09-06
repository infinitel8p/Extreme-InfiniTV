package com.infinitel8p.xtream

import android.util.Log
import java.net.InetAddress
import java.net.UnknownHostException
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap
import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.dnsoverhttps.DnsOverHttps
import org.xbill.DNS.AAAARecord
import org.xbill.DNS.ARecord
import org.xbill.DNS.Lookup
import org.xbill.DNS.SimpleResolver
import org.xbill.DNS.Type

private const val TAG = "CustomDns"
private const val DEFAULT_DNS_PORT = 53
private const val LOOKUP_TIMEOUT_SECONDS = 5L
private const val MIN_TTL_SECONDS = 30L
private const val MAX_TTL_SECONDS = 600L

// Per-playlist DNS override for the native player's OkHttp datasource. Server string is a
// raw IPv4/IPv6[:port] resolver or an https:// DNS-over-HTTPS URL; blank/invalid = system DNS.
object CustomDns {
  fun build(server: String?): Dns {
    val trimmed = server?.trim().orEmpty()
    if (trimmed.isEmpty()) return Dns.SYSTEM
    if (trimmed.startsWith("https://")) return buildDoh(trimmed)

    val target = parseServer(trimmed)
    if (target == null) {
      Log.w(TAG, "invalid dns server override: $trimmed")
      return Dns.SYSTEM
    }
    return try {
      FallbackDns(ResolverDns(target.first, target.second))
    } catch (error: Throwable) {
      Log.w(TAG, "failed to create dns resolver for $trimmed", error)
      Dns.SYSTEM
    }
  }

  private fun buildDoh(url: String): Dns {
    return try {
      // The DoH host itself must resolve through system DNS, or nothing would ever bootstrap.
      val bootstrapClient = OkHttpClient.Builder().dns(Dns.SYSTEM).build()
      val dohDns = DnsOverHttps.Builder()
        .client(bootstrapClient)
        .url(url.toHttpUrl())
        .build()
      FallbackDns(dohDns)
    } catch (error: Throwable) {
      Log.w(TAG, "invalid DoH dns override: $url", error)
      Dns.SYSTEM
    }
  }

  private fun parseServer(server: String): Pair<String, Int>? {
    if (server.startsWith("[")) {
      val closeBracket = server.indexOf(']')
      if (closeBracket < 0) return null
      val host = server.substring(1, closeBracket)
      if (host.isBlank()) return null
      val rest = server.substring(closeBracket + 1)
      val port = when {
        rest.isEmpty() -> DEFAULT_DNS_PORT
        rest.startsWith(":") -> rest.substring(1).toIntOrNull() ?: return null
        else -> return null
      }
      return host to port
    }
    val colonCount = server.count { it == ':' }
    return when {
      colonCount >= 2 -> server to DEFAULT_DNS_PORT
      colonCount == 1 -> {
        val parts = server.split(":", limit = 2)
        val port = parts[1].toIntOrNull() ?: return null
        parts[0] to port
      }
      else -> server to DEFAULT_DNS_PORT
    }
  }
}

// Falls back to system DNS on any resolver failure, warning once per host to avoid log spam.
private class FallbackDns(private val primary: Dns) : Dns {
  private val warnedHosts = ConcurrentHashMap.newKeySet<String>()

  override fun lookup(hostname: String): List<InetAddress> {
    return try {
      primary.lookup(hostname)
    } catch (error: Throwable) {
      if (warnedHosts.add(hostname)) {
        Log.w(TAG, "custom dns lookup failed for $hostname, falling back to system dns", error)
      }
      Dns.SYSTEM.lookup(hostname)
    }
  }
}

// A record and TTL, cached per hostname.
private data class DnsCacheEntry(val addresses: List<InetAddress>, val expiresAtMs: Long)

private class ResolverDns(host: String, port: Int) : Dns {
  private val resolver = SimpleResolver(host).apply {
    setPort(port)
    setTimeout(Duration.ofSeconds(LOOKUP_TIMEOUT_SECONDS))
  }
  private val cache = ConcurrentHashMap<String, DnsCacheEntry>()

  override fun lookup(hostname: String): List<InetAddress> {
    val cached = cache[hostname]
    if (cached != null && cached.expiresAtMs > System.currentTimeMillis()) return cached.addresses

    val addresses = mutableListOf<InetAddress>()
    var ttlSeconds = MAX_TTL_SECONDS

    val aLookup = Lookup(hostname, Type.A)
    aLookup.setResolver(resolver)
    val aRecords = aLookup.run()
    if (aLookup.result == Lookup.SUCCESSFUL && aRecords != null) {
      for (record in aRecords) {
        if (record is ARecord) {
          addresses.add(record.address)
          ttlSeconds = minOf(ttlSeconds, record.ttl)
        }
      }
    }

    val aaaaLookup = Lookup(hostname, Type.AAAA)
    aaaaLookup.setResolver(resolver)
    val aaaaRecords = aaaaLookup.run()
    if (aaaaLookup.result == Lookup.SUCCESSFUL && aaaaRecords != null) {
      for (record in aaaaRecords) {
        if (record is AAAARecord) {
          addresses.add(record.address)
          ttlSeconds = minOf(ttlSeconds, record.ttl)
        }
      }
    }

    if (addresses.isEmpty()) throw UnknownHostException("no address for $hostname via custom dns")
    cache[hostname] = DnsCacheEntry(addresses, System.currentTimeMillis() + ttlSeconds.coerceIn(MIN_TTL_SECONDS, MAX_TTL_SECONDS) * 1000)
    return addresses
  }
}
