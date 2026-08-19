use axum::http::HeaderMap;
use routecodex_v3_runtime::V3RequestPurpose;

const DSH_COMPACTION_HEADER: &str = "x-deepseek-harness-compact";
const ROUTECODEX_PURPOSE_HEADER: &str = "x-routecodex-request-purpose";

pub(super) fn classify_v3_request_purpose(
    path: &str,
    headers: &HeaderMap,
) -> Result<V3RequestPurpose, String> {
    validate_registered_header(headers, DSH_COMPACTION_HEADER, "1")?;
    validate_registered_header(headers, ROUTECODEX_PURPOSE_HEADER, "compaction")?;

    Ok(if path == "/v1/responses/compact" {
        V3RequestPurpose::NativeCompaction
    } else if headers.contains_key(DSH_COMPACTION_HEADER)
        || headers.contains_key(ROUTECODEX_PURPOSE_HEADER)
    {
        V3RequestPurpose::AuxiliaryCompaction
    } else {
        V3RequestPurpose::Conversation
    })
}

fn validate_registered_header(
    headers: &HeaderMap,
    name: &'static str,
    expected: &'static str,
) -> Result<(), String> {
    for value in headers.get_all(name) {
        let actual = value
            .to_str()
            .map_err(|_| format!("registered compaction header {name} must be valid ASCII"))?;
        if actual != expected {
            return Err(format!(
                "registered compaction header {name} only accepts exact value {expected}"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn recognizes_only_registered_compaction_ingress_contracts() {
        assert_eq!(
            classify_v3_request_purpose("/v1/responses/compact", &HeaderMap::new()).unwrap(),
            V3RequestPurpose::NativeCompaction
        );

        let mut dsh = HeaderMap::new();
        dsh.insert(DSH_COMPACTION_HEADER, HeaderValue::from_static("1"));
        assert_eq!(
            classify_v3_request_purpose("/v1/chat/completions", &dsh).unwrap(),
            V3RequestPurpose::AuxiliaryCompaction
        );

        let mut adapter = HeaderMap::new();
        adapter.insert(
            ROUTECODEX_PURPOSE_HEADER,
            HeaderValue::from_static("compaction"),
        );
        assert_eq!(
            classify_v3_request_purpose("/v1/chat/completions", &adapter).unwrap(),
            V3RequestPurpose::AuxiliaryCompaction
        );

        let mut unknown = HeaderMap::new();
        unknown.insert("x-compact", HeaderValue::from_static("1"));
        assert_eq!(
            classify_v3_request_purpose("/v1/chat/completions", &unknown).unwrap(),
            V3RequestPurpose::Conversation
        );
    }

    #[test]
    fn rejects_malformed_registered_compaction_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(DSH_COMPACTION_HEADER, HeaderValue::from_static("true"));
        assert!(
            classify_v3_request_purpose("/v1/chat/completions", &headers)
                .unwrap_err()
                .contains("only accepts exact value 1")
        );

        let mut headers = HeaderMap::new();
        headers.insert(
            ROUTECODEX_PURPOSE_HEADER,
            HeaderValue::from_static("compact"),
        );
        assert!(
            classify_v3_request_purpose("/v1/chat/completions", &headers)
                .unwrap_err()
                .contains("only accepts exact value compaction")
        );
    }
}
