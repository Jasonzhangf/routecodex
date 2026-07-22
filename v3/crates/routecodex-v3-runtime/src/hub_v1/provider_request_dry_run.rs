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
            *captured = Some(request.redacted_provider_request_projection());
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

fn provider_request_dry_run_response_payload_for_request(
    request: &V3Transport13ResponsesHttpRequest,
    responses_payload: &Value,
) -> Value {
    let text = "routecodex provider-request dry-run stopped before provider send";
    if request
        .url()
        .trim_end_matches('/')
        .ends_with("/v1/messages")
    {
        return json!({
            "id": format!("dry_run_{}", request.request_id()),
            "type": "message",
            "role": "assistant",
            "model": request.body().get("model").cloned().unwrap_or(Value::Null),
            "content": [{"type":"text","text":text}],
            "stop_reason": "end_turn"
        });
    }
    if request
        .url()
        .trim_end_matches('/')
        .ends_with("/chat/completions")
    {
        return json!({
            "id": format!("dry_run_{}", request.request_id()),
            "object": "chat.completion",
            "model": request.body().get("model").cloned().unwrap_or(Value::Null),
            "choices": [{
                "index": 0,
                "message": {"role":"assistant","content":text},
                "finish_reason": "stop"
            }]
        });
    }
    responses_payload.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_provider_responses::{
        build_v3_transport_13_responses_http_request_from_parts, V3ProviderAuthHandle,
        V3ProviderAuthSecretHandle, V3ResponsesStreamIntent,
    };

    #[test]
    fn dry_run_terminal_payload_matches_anthropic_provider_protocol() {
        let request = build_v3_transport_13_responses_http_request_from_parts(
            "req-dry-run",
            "anthropic_provider",
            "http://provider.invalid/anthropic/v1/messages",
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
        assert_eq!(
            payload["content"][0]["text"],
            "routecodex provider-request dry-run stopped before provider send"
        );
    }
}
