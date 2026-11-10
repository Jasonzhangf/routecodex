use crate::transport::{
    v3_transport_13_request, V3ProviderRequestHeader, V3Transport13ResponsesHttpRequest,
    V3Transport13ResponsesRequestKind,
};
use crate::wire::{V3ProviderAuthHandle, V3ResponsesStreamIntent};
use crate::V3ProviderError;
use serde_json::Value;
use std::time::Duration;

#[allow(clippy::too_many_arguments)]
pub fn build_v3_transport_13_responses_http_request_from_parts_with_timeout_and_concurrency(
    request_id: impl Into<String>,
    provider_id: impl Into<String>,
    url_text: impl AsRef<str>,
    auth: V3ProviderAuthHandle,
    stream_intent: V3ResponsesStreamIntent,
    body: Value,
    provider_headers: Vec<V3ProviderRequestHeader>,
    timeout: Option<Duration>,
    concurrency_acquire_timeout_ms: u64,
    sse_first_frame_timeout_ms: Option<u64>,
) -> Result<V3Transport13ResponsesHttpRequest, V3ProviderError> {
    let request_id = request_id.into();
    let provider_id = provider_id.into();
    let url = reqwest::Url::parse(url_text.as_ref()).map_err(|error| {
        V3ProviderError::InvalidBaseUrl {
            request_id: request_id.clone(),
            provider_id: provider_id.clone(),
            reason: error.to_string(),
        }
    })?;
    let _ = concurrency_acquire_timeout_ms;
    Ok(v3_transport_13_request(
        V3Transport13ResponsesRequestKind::Http {
            request_id,
            provider_id,
            url,
            auth,
            stream_intent,
            body,
            provider_headers,
            timeout,
            sse_first_frame_timeout_ms,
            cancellation: None,
            compatibility_profile: None,
        },
    ))
}
