// SSRF-safe manifest probe: vets and pins the resolved IP before every request, including redirects.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

use serde::Serialize;

const MIN_TIMEOUT_MS: u64 = 500;
const MAX_TIMEOUT_MS: u64 = 10_000;
const MAX_BODY_BYTES: u64 = 4 * 1024 * 1024;
const MAX_REDIRECT_HOPS: usize = 3;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestProbe {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: String,
}

#[tauri::command]
pub async fn probe_manifest(
    url: String,
    user_agent: Option<String>,
    referer: Option<String>,
    timeout_ms: u64,
    max_bytes: u64,
) -> Result<ManifestProbe, String> {
    let timeout = Duration::from_millis(clamp_timeout_ms(timeout_ms));
    let max_bytes = clamp_max_bytes(max_bytes);
    let deadline = std::time::Instant::now() + timeout;

    let mut current_url = reqwest::Url::parse(&url).map_err(|error| format!("OTHER:{error}"))?;
    let mut hops = 0usize;

    loop {
        if deadline.saturating_duration_since(std::time::Instant::now()).is_zero() {
            return Err("TIMEOUT:deadline exceeded".to_string());
        }
        if current_url.scheme() != "http" && current_url.scheme() != "https" {
            return Err("BLOCKED:url must be http or https".to_string());
        }
        let host = current_url
            .host_str()
            .ok_or_else(|| "BLOCKED:url has no host".to_string())?
            .to_string();
        let port = current_url
            .port_or_known_default()
            .ok_or_else(|| "BLOCKED:url has no resolvable port".to_string())?;

        let vetted_addr = resolve_and_vet(&host, port).await?;
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err("TIMEOUT:deadline exceeded".to_string());
        }
        let client = build_pinned_client(&host, vetted_addr, remaining)?;

        let mut request = client.get(current_url.clone());
        if let Some(user_agent) = user_agent.as_deref().filter(|value| !value.is_empty()) {
            request = request.header(reqwest::header::USER_AGENT, user_agent);
        }
        if let Some(referer) = referer.as_deref().filter(|value| !value.is_empty()) {
            request = request.header(reqwest::header::REFERER, referer);
        }

        let response = request.send().await.map_err(classify_reqwest_error)?;

        if response.status().is_redirection() {
            hops += 1;
            if hops > MAX_REDIRECT_HOPS {
                return Err("OTHER:too many redirects".to_string());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string)
                .ok_or_else(|| "OTHER:redirect missing location".to_string())?;
            current_url = current_url
                .join(&location)
                .map_err(|error| format!("OTHER:{error}"))?;
            continue;
        }

        return read_probe_response(response, max_bytes).await;
    }
}

// ---------------------------------------------------------------------------
// DNS resolution + pinning
// ---------------------------------------------------------------------------

// std's DNS resolution is blocking, so it runs via spawn_blocking to avoid stalling the runtime.
async fn resolve_and_vet(host: &str, port: u16) -> Result<SocketAddr, String> {
    let host_owned = host.to_string();
    let resolved = tauri::async_runtime::spawn_blocking(move || {
        (host_owned.as_str(), port).to_socket_addrs().map(|addrs| addrs.collect::<Vec<_>>())
    })
    .await
    .map_err(|error| format!("OTHER:dns worker failed: {error}"))?
    .map_err(|error| format!("OTHER:dns resolution failed: {error}"))?;

    if resolved.is_empty() {
        return Err("BLOCKED:hostname did not resolve to any address".to_string());
    }
    if resolved.iter().any(|addr| !is_globally_routable(addr.ip())) {
        return Err("BLOCKED:hostname resolves to a non-public address".to_string());
    }
    Ok(resolved[0])
}

// Pinning closes the DNS-rebinding TOCTOU: a later re-resolution can never change where this connects.
fn build_pinned_client(host: &str, vetted_addr: SocketAddr, timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        // an ambient proxy would resolve the host itself and defeat the pin
        .no_proxy()
        .resolve_to_addrs(host, &[vetted_addr])
        .build()
        .map_err(|error| format!("OTHER:{error}"))
}

// ---------------------------------------------------------------------------
// Response reading
// ---------------------------------------------------------------------------

async fn read_probe_response(mut response: reqwest::Response, max_bytes: u64) -> Result<ManifestProbe, String> {
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    if response.content_length().is_some_and(|length| length > max_bytes) {
        return Err("TOO_LARGE:content-length exceeds cap".to_string());
    }

    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(classify_reqwest_error)? {
        body.extend_from_slice(&chunk);
        if body.len() as u64 > max_bytes {
            return Err("TOO_LARGE:body exceeded cap".to_string());
        }
    }

    Ok(ManifestProbe {
        status,
        content_type,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

fn classify_reqwest_error(error: reqwest::Error) -> String {
    let is_timeout = error.is_timeout();
    let sanitized = error.without_url();
    log::warn!("[safe-fetch] request failed: {sanitized}");
    if is_timeout {
        format!("TIMEOUT:{sanitized}")
    } else {
        format!("OTHER:{sanitized}")
    }
}

// ---------------------------------------------------------------------------
// Clamping
// ---------------------------------------------------------------------------

fn clamp_timeout_ms(requested: u64) -> u64 {
    requested.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
}

fn clamp_max_bytes(requested: u64) -> u64 {
    requested.clamp(1, MAX_BODY_BYTES)
}

// ---------------------------------------------------------------------------
// IP classification
// ---------------------------------------------------------------------------

fn is_globally_routable(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_global_v4(v4),
        IpAddr::V6(v6) => is_global_v6(v6),
    }
}

fn is_global_v4(ip: Ipv4Addr) -> bool {
    if ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_broadcast()
    {
        return false;
    }
    let octets = ip.octets();
    let is_this_network = octets[0] == 0;
    let is_cgnat = octets[0] == 100 && (64..=127).contains(&octets[1]);
    let is_benchmarking = octets[0] == 198 && (octets[1] == 18 || octets[1] == 19);
    let is_reserved = octets[0] >= 240;
    !(is_this_network || is_cgnat || is_benchmarking || is_reserved)
}

fn is_global_v6(ip: Ipv6Addr) -> bool {
    if ip.is_unspecified() || ip.is_loopback() {
        return false;
    }
    if let Some(embedded_v4) = extract_embedded_v4(ip) {
        return is_global_v4(embedded_v4);
    }
    !is_unique_local_v6(ip) && !is_unicast_link_local_v6(ip) && !ip.is_multicast()
}

// std's Ipv6Addr helpers for these ranges are still unstable, so classify from the raw segments.
fn is_unique_local_v6(ip: Ipv6Addr) -> bool {
    ip.segments()[0] & 0xfe00 == 0xfc00
}

fn is_unicast_link_local_v6(ip: Ipv6Addr) -> bool {
    ip.segments()[0] & 0xffc0 == 0xfe80
}

// Unwraps IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), and NAT64 (64:ff9b::/96).
fn extract_embedded_v4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let segments = ip.segments();
    let is_mapped = segments[0..6] == [0, 0, 0, 0, 0, 0xffff];
    let is_compatible = segments[0..6] == [0, 0, 0, 0, 0, 0] && (segments[6] != 0 || segments[7] != 0);
    let is_nat64 = segments[0..6] == [0x64, 0xff9b, 0, 0, 0, 0];
    if is_mapped || is_compatible || is_nat64 {
        Some(Ipv4Addr::new(
            (segments[6] >> 8) as u8,
            segments[6] as u8,
            (segments[7] >> 8) as u8,
            segments[7] as u8,
        ))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v4_loopback_is_blocked() {
        assert!(!is_globally_routable("127.0.0.1".parse().unwrap()));
    }

    #[test]
    fn v4_private_ranges_are_blocked() {
        assert!(!is_globally_routable("10.0.0.1".parse().unwrap()));
        assert!(!is_globally_routable("172.16.0.1".parse().unwrap()));
        assert!(!is_globally_routable("192.168.1.1".parse().unwrap()));
    }

    #[test]
    fn v4_link_local_is_blocked() {
        assert!(!is_globally_routable("169.254.1.1".parse().unwrap()));
    }

    #[test]
    fn v4_cgnat_is_blocked() {
        assert!(!is_globally_routable("100.64.0.1".parse().unwrap()));
        assert!(is_globally_routable("100.63.255.255".parse().unwrap()));
        assert!(is_globally_routable("100.128.0.1".parse().unwrap()));
    }

    #[test]
    fn v4_unspecified_is_blocked() {
        assert!(!is_globally_routable("0.0.0.0".parse().unwrap()));
    }

    #[test]
    fn v4_this_network_block_is_blocked() {
        assert!(!is_globally_routable("0.0.0.1".parse().unwrap()));
        assert!(!is_globally_routable("0.255.255.255".parse().unwrap()));
    }

    #[test]
    fn v4_multicast_and_broadcast_are_blocked() {
        assert!(!is_globally_routable("224.0.0.1".parse().unwrap()));
        assert!(!is_globally_routable("255.255.255.255".parse().unwrap()));
    }

    #[test]
    fn v4_benchmarking_is_blocked() {
        assert!(!is_globally_routable("198.18.0.1".parse().unwrap()));
        assert!(!is_globally_routable("198.19.255.255".parse().unwrap()));
    }

    #[test]
    fn v4_reserved_is_blocked() {
        assert!(!is_globally_routable("240.0.0.1".parse().unwrap()));
        assert!(!is_globally_routable("255.0.0.1".parse().unwrap()));
    }

    #[test]
    fn v4_public_address_passes() {
        assert!(is_globally_routable("8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn v6_unspecified_and_loopback_are_blocked() {
        assert!(!is_globally_routable("::".parse().unwrap()));
        assert!(!is_globally_routable("::1".parse().unwrap()));
    }

    #[test]
    fn v6_link_local_and_unique_local_are_blocked() {
        assert!(!is_globally_routable("fe80::1".parse().unwrap()));
        assert!(!is_globally_routable("fc00::1".parse().unwrap()));
        assert!(!is_globally_routable("fd12:3456:789a::1".parse().unwrap()));
    }

    #[test]
    fn v6_multicast_is_blocked() {
        assert!(!is_globally_routable("ff02::1".parse().unwrap()));
    }

    #[test]
    fn v6_mapped_private_v4_is_blocked() {
        assert!(!is_globally_routable("::ffff:127.0.0.1".parse().unwrap()));
        assert!(!is_globally_routable("::ffff:10.0.0.1".parse().unwrap()));
    }

    #[test]
    fn v6_nat64_wrapped_private_v4_is_blocked() {
        assert!(!is_globally_routable("64:ff9b::192.168.1.1".parse().unwrap()));
    }

    #[test]
    fn v6_deprecated_ipv4_compatible_is_blocked() {
        assert!(!is_globally_routable("::2".parse().unwrap()));
    }

    #[test]
    fn v6_public_address_passes() {
        assert!(is_globally_routable("2001:4860:4860::8888".parse().unwrap()));
        assert!(is_globally_routable("::ffff:8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn clamp_timeout_ms_enforces_bounds() {
        assert_eq!(clamp_timeout_ms(0), MIN_TIMEOUT_MS);
        assert_eq!(clamp_timeout_ms(5000), 5000);
        assert_eq!(clamp_timeout_ms(999_999), MAX_TIMEOUT_MS);
    }

    #[test]
    fn clamp_max_bytes_enforces_bounds() {
        assert_eq!(clamp_max_bytes(0), 1);
        assert_eq!(clamp_max_bytes(1024), 1024);
        assert_eq!(clamp_max_bytes(u64::MAX), MAX_BODY_BYTES);
    }
}
