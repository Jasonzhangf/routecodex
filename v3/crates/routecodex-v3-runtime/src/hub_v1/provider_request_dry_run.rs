use futures_util::stream;
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

#[derive(Debug)]
pub(crate) struct V3ProviderRequestDryRunNoNetworkTransport {
    response_payload: Value,
    captured_provider_request: Arc<Mutex<Option<Value>>>,
}

impl V3ProviderRequestDryRunNoNetworkTransport {
    pub(crate) fn new(
        response_payload: Value,
        captured_provider_request: Arc<Mutex<Option<Value>>>,
    ) -> Self {
        Self {
            response_payload,
            captured_provider_request,
        }
    }
}

#[async_trait::async_trait]
impl ResponsesTransport for V3ProviderRequestDryRunNoNetworkTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        if let Ok(mut captured) = self.captured_provider_request.lock() {
            *captured = Some(request.provider_request_projection());
        }
        if let Some(response) =
            captured_provider_response_for_dry_run(&request, &self.response_payload)
        {
            return response;
        }
        let response_payload =
            provider_request_dry_run_response_payload_for_request(&request, &self.response_payload);
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&response_payload).map_err(|error| {
                V3ProviderError::ResponseBody {
                    request_id: request.request_id().to_string(),
                    provider_id: request.provider_id().to_string(),
                    reason: error.to_string(),
                }
            })?,
        ))
    }
}

pub(crate) fn is_captured_provider_response_for_dry_run(payload: &Value) -> bool {
    payload.get("object").and_then(Value::as_str)
        == Some("routecodex.v3.provider_response_snapshot")
        && payload.get("stage").and_then(Value::as_str) == Some("provider-response")
}

pub(crate) fn captured_provider_response_for_dry_run(
    request: &V3Transport13ResponsesHttpRequest,
    payload: &Value,
) -> Option<Result<V3ProviderResp14Raw, V3ProviderError>> {
    if !is_captured_provider_response_for_dry_run(payload) {
        return None;
    }
    let status = payload
        .get("status")
        .and_then(Value::as_u64)
        .and_then(|status| u16::try_from(status).ok())
        .unwrap_or(200);
    let response = match payload.get("bodyKind").and_then(Value::as_str) {
        Some("sse") => payload
            .get("rawSse")
            .and_then(Value::as_str)
            .filter(|raw_sse| !raw_sse.is_empty())
            .ok_or_else(|| V3ProviderError::ResponseBody {
                request_id: request.request_id().to_string(),
                provider_id: request.provider_id().to_string(),
                reason: "captured provider SSE response requires non-empty rawSse".to_string(),
            })
            .map(|raw_sse| {
                V3ProviderResp14Raw::from_sse(
                    request.request_id().to_string(),
                    request.provider_id().to_string(),
                    status,
                    vec![V3ProviderResponseHeader {
                        name: "content-type".to_string(),
                        value: b"text/event-stream".to_vec(),
                    }],
                    Box::pin(stream::iter(vec![Ok(raw_sse.as_bytes().to_vec())])),
                )
            }),
        Some("json") => payload
            .get("body")
            .ok_or_else(|| V3ProviderError::ResponseBody {
                request_id: request.request_id().to_string(),
                provider_id: request.provider_id().to_string(),
                reason: "captured provider JSON response requires body".to_string(),
            })
            .and_then(|body| {
                serde_json::to_vec(body)
                    .map_err(|error| V3ProviderError::ResponseBody {
                        request_id: request.request_id().to_string(),
                        provider_id: request.provider_id().to_string(),
                        reason: error.to_string(),
                    })
                    .map(|body| {
                        V3ProviderResp14Raw::from_json(
                            request.request_id(),
                            request.provider_id(),
                            status,
                            vec![V3ProviderResponseHeader {
                                name: "content-type".to_string(),
                                value: b"application/json".to_vec(),
                            }],
                            body,
                        )
                    })
            }),
        Some(body_kind) => Err(V3ProviderError::ResponseBody {
            request_id: request.request_id().to_string(),
            provider_id: request.provider_id().to_string(),
            reason: format!(
                "captured provider response bodyKind must be sse or json, got {body_kind}"
            ),
        }),
        None => Err(V3ProviderError::ResponseBody {
            request_id: request.request_id().to_string(),
            provider_id: request.provider_id().to_string(),
            reason: "captured provider response requires bodyKind".to_string(),
        }),
    };
    Some(response)
}

fn provider_request_dry_run_response_payload_for_request(
    request: &V3Transport13ResponsesHttpRequest,
    responses_payload: &Value,
) -> Value {
    let text = "routecodex provider-request dry-run stopped before provider send";
    if provider_request_url_path(request.url()).ends_with("/v1/messages") {
        return json!({
            "type": "message",
            "role": "assistant",
            "model": request.body().get("model").cloned().unwrap_or(Value::Null),
            "content": [{"type":"text","text":text}],
            "stop_reason": "end_turn"
        });
    }
    if provider_request_url_path(request.url()).ends_with("/chat/completions") {
        return json!({
            "object": "chat.completion",
            "model": request.body().get("model").cloned().unwrap_or(Value::Null),
            "choices": [{
                "index": 0,
                "message": {"role":"assistant","content":text},
                "finish_reason": "stop"
            }]
        });
    }
    if provider_request_url_path(request.url()).ends_with("/v1/responses")
        || provider_request_url_path(request.url()).ends_with("/responses")
    {
        return json!({
            "object": "response",
            "status": "completed",
            "output_text": text,
            "output": [{"type":"output_text","text":text}]
        });
    }
    responses_payload.clone()
}

fn provider_request_url_path(url: &str) -> String {
    url.split('?')
        .next()
        .unwrap_or(url)
        .trim_end_matches('/')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_provider_responses::{
        build_v3_transport_13_responses_http_request_from_parts, V3ProviderAuthHandle,
        V3ProviderAuthSecretHandle, V3ResponsesStreamIntent,
    };

    #[test]
    fn dry_run_terminal_payload_is_protocol_compatible_without_continuation_id() {
        let request = build_v3_transport_13_responses_http_request_from_parts(
            "req-dry-run",
            "anthropic_provider",
            "http://provider.invalid/anthropic/v1/messages?beta=true",
            V3ProviderAuthHandle {
                alias: "key".to_string(),
                secret: V3ProviderAuthSecretHandle::Environment("TEST_KEY".to_string()),
            },
            V3ResponsesStreamIntent::Json,
            json!({"model":"wire-model"}),
        )
        .expect("dry-run request");
        let payload = provider_request_dry_run_response_payload_for_request(
            &request,
            &json!({"unused":true}),
        );
        assert_eq!(payload["type"], "message");
        assert_eq!(payload["stop_reason"], "end_turn");
        assert!(payload.get("id").is_none());
        assert!(payload.get("previous_response_id").is_none());
    }
}
