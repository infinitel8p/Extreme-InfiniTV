// Shared HTTP Range/Content-Range helpers for the VOD and VOD-audio proxies (desktop only).

/// Explicit start of `Range: bytes=N-...`; suffix and multi-ranges stay unvalidated.
pub(crate) fn range_request_start(header_value: &str) -> Option<u64> {
    let spec = header_value.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (start_str, _end_str) = spec.split_once('-')?;
    if start_str.is_empty() {
        return None;
    }
    start_str.parse::<u64>().ok()
}

/// Start byte of a response `Content-Range` header.
pub(crate) fn content_range_start(header_value: &str) -> Option<u64> {
    let spec = header_value.trim().strip_prefix("bytes ")?;
    let (range_part, _total) = spec.split_once('/')?;
    let (start_str, _end_str) = range_part.split_once('-')?;
    start_str.parse::<u64>().ok()
}

/// A ranged request must get a 206 whose Content-Range starts at the requested byte.
pub(crate) fn ranged_response_matches_request(
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
    requested_start: u64,
) -> bool {
    if status != reqwest::StatusCode::PARTIAL_CONTENT {
        return false;
    }
    headers
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(content_range_start)
        == Some(requested_start)
}

/// True only for a corrupted 206 (Content-Range starts at the wrong byte). A 200 (Range
/// ignored) or any other status is the upstream's genuine answer and is always safe to
/// relay: at start 0 a 200 body is byte-identical, and a start-past-0 request answered
/// with a full body just makes the downstream player/demuxer restart from 0.
pub(crate) fn ranged_response_is_corrupted(
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
    requested_start: u64,
) -> bool {
    status == reqwest::StatusCode::PARTIAL_CONTENT
        && !ranged_response_matches_request(status, headers, requested_start)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_request_start_reads_an_explicit_start() {
        assert_eq!(range_request_start("bytes=1048576-"), Some(1_048_576));
        assert_eq!(range_request_start("bytes=0-499"), Some(0));
    }

    #[test]
    fn range_request_start_is_none_for_a_suffix_range() {
        assert_eq!(range_request_start("bytes=-500"), None);
    }

    #[test]
    fn range_request_start_is_none_for_a_multi_range() {
        assert_eq!(range_request_start("bytes=0-99,200-299"), None);
    }

    #[test]
    fn range_request_start_is_none_for_an_unparseable_header() {
        assert_eq!(range_request_start("not a range"), None);
    }

    #[test]
    fn content_range_start_reads_the_response_start() {
        assert_eq!(content_range_start("bytes 1048576-2097151/5000000"), Some(1_048_576));
    }

    #[test]
    fn content_range_start_is_none_for_an_unparseable_header() {
        assert_eq!(content_range_start("not a content-range"), None);
    }

    #[test]
    fn ranged_response_matches_request_requires_206_and_a_matching_start() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_RANGE,
            reqwest::header::HeaderValue::from_static("bytes 1000-1999/5000"),
        );
        assert!(ranged_response_matches_request(
            reqwest::StatusCode::PARTIAL_CONTENT,
            &headers,
            1_000
        ));
        assert!(!ranged_response_matches_request(
            reqwest::StatusCode::PARTIAL_CONTENT,
            &headers,
            0
        ));
        assert!(!ranged_response_matches_request(reqwest::StatusCode::OK, &headers, 1_000));
    }

    #[test]
    fn ranged_response_matches_request_rejects_a_206_without_content_range() {
        let headers = reqwest::header::HeaderMap::new();
        assert!(!ranged_response_matches_request(
            reqwest::StatusCode::PARTIAL_CONTENT,
            &headers,
            0
        ));
    }

    #[test]
    fn ranged_response_is_corrupted_flags_a_206_with_a_mismatched_content_range() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_RANGE,
            reqwest::header::HeaderValue::from_static("bytes 0-999/5000"),
        );
        assert!(ranged_response_is_corrupted(
            reqwest::StatusCode::PARTIAL_CONTENT,
            &headers,
            1_000
        ));
    }

    #[test]
    fn ranged_response_is_corrupted_allows_a_200_that_ignores_the_range() {
        let headers = reqwest::header::HeaderMap::new();
        assert!(!ranged_response_is_corrupted(reqwest::StatusCode::OK, &headers, 0));
        assert!(!ranged_response_is_corrupted(reqwest::StatusCode::OK, &headers, 1_000));
    }

    #[test]
    fn ranged_response_is_corrupted_allows_a_206_with_a_matching_content_range() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_RANGE,
            reqwest::header::HeaderValue::from_static("bytes 1000-1999/5000"),
        );
        assert!(!ranged_response_is_corrupted(
            reqwest::StatusCode::PARTIAL_CONTENT,
            &headers,
            1_000
        ));
    }
}
