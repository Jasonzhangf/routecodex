use crate::V3ProviderError;
use routecodex_v3_config::V3ResponsesTransportKind;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3ProviderAuthSecretHandle {
    Environment(String),
    TokenFile(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderAuthHandle {
    pub alias: String,
    pub secret: V3ProviderAuthSecretHandle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ResponsesProviderTarget {
    pub provider_id: String,
    pub provider_type: String,
    pub base_url: String,
    pub canonical_model_id: String,
    pub wire_model: String,
    pub auth: V3ProviderAuthHandle,
    pub responses_transport: V3ResponsesTransportKind,
    pub websocket_v2_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3ResponsesStreamIntent {
    Json,
    Sse,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3Provider12ResponsesWirePayload {
    request_id: String,
    target: V3ResponsesProviderTarget,
    stream_intent: V3ResponsesStreamIntent,
    body: Value,
}

impl V3Provider12ResponsesWirePayload {
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn target(&self) -> &V3ResponsesProviderTarget {
        &self.target
    }

    pub fn stream_intent(&self) -> V3ResponsesStreamIntent {
        self.stream_intent
    }

    pub fn body(&self) -> &Value {
        &self.body
    }

    pub(crate) fn into_parts(
        self,
    ) -> (
        String,
        V3ResponsesProviderTarget,
        V3ResponsesStreamIntent,
        Value,
    ) {
        (self.request_id, self.target, self.stream_intent, self.body)
    }
}

pub fn build_v3_provider_12_responses_wire_payload(
    request_id: impl Into<String>,
    target: V3ResponsesProviderTarget,
    mut current_request_body: Value,
) -> Result<V3Provider12ResponsesWirePayload, V3ProviderError> {
    let request_id = request_id.into();
    let stream_intent = match current_request_body
        .as_object()
        .ok_or_else(|| V3ProviderError::InvalidWireBody {
            request_id: request_id.clone(),
        })?
        .get("stream")
    {
        None | Some(Value::Bool(false)) => V3ResponsesStreamIntent::Json,
        Some(Value::Bool(true)) => V3ResponsesStreamIntent::Sse,
        Some(_) => {
            return Err(V3ProviderError::InvalidStreamIntent {
                request_id: request_id.clone(),
            })
        }
    };
    if let Some(field) = find_v3_routecodex_control_payload_key(&current_request_body) {
        return Err(V3ProviderError::ControlFieldInWireBody { request_id, field });
    }
    current_request_body
        .as_object_mut()
        .expect("wire body object was validated above")
        .insert(
            "model".to_string(),
            Value::String(target.wire_model.clone()),
        );
    Ok(V3Provider12ResponsesWirePayload {
        request_id,
        target,
        stream_intent,
        body: current_request_body,
    })
}

pub const V3_ROUTECODEX_CONTROL_PAYLOAD_KEYS: &[&str] = &[
    "routecodex_internal",
    "routecodexInternal",
    "route_hint",
    "routeHint",
    "metadata_center",
    "metadataCenter",
    "__metadataCenter",
    "debug_snapshot",
    "debugSnapshot",
    "provider_protocol",
    "providerProtocol",
    "provider_runtime",
    "providerRuntime",
    "resource_handle",
    "resourceHandle",
    "continuation_owner",
    "continuationOwner",
    "runtime_control",
    "runtimeControl",
    "request_truth",
    "requestTruth",
    "route_selection",
    "routeSelection",
    "retry_exclusion_set",
    "retryExclusionSet",
    "selected_target",
    "selectedTarget",
    "opaque_target",
    "opaqueTarget",
    "resume_meta",
    "resumeMeta",
    "servertool_state",
    "servertoolState",
    "stopless_state",
    "stoplessState",
    "stopless_center",
    "stoplessCenter",
    "__routecodex_stopless_center",
    "error_chain",
    "errorChain",
    "node_trace",
    "nodeTrace",
    "capturedChatRequest",
    "entryOriginRequest",
    "requestSemantics",
    "responsesRequestContext",
    "__raw_request_body",
    "__rt",
    "__rccDryRunSerialized",
    "request_capabilities",
    "requestCapabilities",
    "required_capabilities",
    "requiredCapabilities",
    "model_capabilities",
    "modelCapabilities",
    "selection_plan",
    "selectionPlan",
];

pub fn find_v3_routecodex_control_payload_key(value: &Value) -> Option<&'static str> {
    match value {
        Value::Array(items) => items
            .iter()
            .find_map(find_v3_routecodex_control_payload_key),
        Value::Object(object) => {
            for &key in V3_ROUTECODEX_CONTROL_PAYLOAD_KEYS {
                if object.contains_key(key) {
                    return Some(key);
                }
            }
            object
                .values()
                .find_map(find_v3_routecodex_control_payload_key)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn wire_moves_request_and_changes_only_selected_model() {
        let body = json!({
            "model":"client-model",
            "input":"hello",
            "metadata":{"client":"kept"},
            "unknown_client_field":true
        });
        let wire = build_v3_provider_12_responses_wire_payload(
            "req-1",
            V3ResponsesProviderTarget {
                provider_id: "neutral-provider".into(),
                provider_type: "responses".into(),
                base_url: "http://upstream.invalid/v1".into(),
                canonical_model_id: "canonical-model".into(),
                wire_model: "upstream-model".into(),
                auth: V3ProviderAuthHandle {
                    alias: "primary".into(),
                    secret: V3ProviderAuthSecretHandle::Environment("NEUTRAL_KEY".into()),
                },
                responses_transport: V3ResponsesTransportKind::Http,
                websocket_v2_url: None,
            },
            body,
        )
        .unwrap();
        assert_eq!(wire.body()["model"], "upstream-model");
        assert_eq!(wire.body()["input"], "hello");
        assert_eq!(wire.body()["metadata"], json!({"client":"kept"}));
        assert_eq!(wire.body()["unknown_client_field"], true);
        assert_eq!(wire.stream_intent(), V3ResponsesStreamIntent::Json);
    }

    #[test]
    fn non_object_or_non_boolean_stream_fails_without_rebuilding_payload() {
        let target = V3ResponsesProviderTarget {
            provider_id: "neutral-provider".into(),
            provider_type: "responses".into(),
            base_url: "http://upstream.invalid/v1".into(),
            canonical_model_id: "model".into(),
            wire_model: "model".into(),
            auth: V3ProviderAuthHandle {
                alias: "primary".into(),
                secret: V3ProviderAuthSecretHandle::Environment("NEUTRAL_KEY".into()),
            },
            responses_transport: V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
        };
        assert!(matches!(
            build_v3_provider_12_responses_wire_payload("req-array", target.clone(), json!([])),
            Err(V3ProviderError::InvalidWireBody { .. })
        ));
        assert!(matches!(
            build_v3_provider_12_responses_wire_payload(
                "req-stream",
                target,
                json!({"stream":"yes"})
            ),
            Err(V3ProviderError::InvalidStreamIntent { .. })
        ));
    }

    #[test]
    fn wire_rejects_routecodex_control_keys_before_provider_transport() {
        let body = json!({
            "model":"client-model",
            "input":[{
                "role":"user",
                "content":"hello",
                "metadataCenter":{"provider_key":"must-not-leak"}
            }],
            "metadata":{"client":"kept"},
            "client_metadata":{"session_id":"client-owned"}
        });
        let error = build_v3_provider_12_responses_wire_payload("req-control", target(), body)
            .expect_err("provider wire body must reject internal control fields");
        assert!(matches!(
            error,
            V3ProviderError::ControlFieldInWireBody {
                request_id,
                field: "metadataCenter"
            } if request_id == "req-control"
        ));
    }

    #[test]
    fn wire_rejects_routing_capability_control_keys_before_provider_transport() {
        let body = json!({
            "model":"client-model",
            "input":"hello",
            "request_capabilities":["vision"]
        });
        let error = build_v3_provider_12_responses_wire_payload("req-cap", target(), body)
            .expect_err("request capability facts are control-plane, not provider payload");
        assert!(matches!(
            error,
            V3ProviderError::ControlFieldInWireBody {
                request_id,
                field: "request_capabilities"
            } if request_id == "req-cap"
        ));
    }

    #[test]
    fn canonical_control_key_guard_rejects_route_facts_and_keeps_client_metadata_data_plane() {
        assert!(!V3_ROUTECODEX_CONTROL_PAYLOAD_KEYS.contains(&"metadata"));
        assert!(!V3_ROUTECODEX_CONTROL_PAYLOAD_KEYS.contains(&"client_metadata"));
        assert_eq!(
            find_v3_routecodex_control_payload_key(&json!({
                "metadata": {"client": "kept"},
                "client_metadata": {"session_id": "client-owned"}
            })),
            None
        );
        assert_eq!(
            find_v3_routecodex_control_payload_key(&json!({
                "input": "hello",
                "routeHint": {"route": "must-not-enter-wire"}
            })),
            Some("routeHint")
        );
        assert_eq!(
            find_v3_routecodex_control_payload_key(&json!({
                "input": "hello",
                "opaque_target": {"target": "must-not-enter-wire"}
            })),
            Some("opaque_target")
        );
    }

    fn target() -> V3ResponsesProviderTarget {
        V3ResponsesProviderTarget {
            provider_id: "neutral-provider".into(),
            provider_type: "responses".into(),
            base_url: "http://upstream.invalid/v1".into(),
            canonical_model_id: "canonical-model".into(),
            wire_model: "upstream-model".into(),
            auth: V3ProviderAuthHandle {
                alias: "primary".into(),
                secret: V3ProviderAuthSecretHandle::Environment("NEUTRAL_KEY".into()),
            },
            responses_transport: V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
        }
    }
}
