use crate::V3ProviderError;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use routecodex_v3_config::V3ResponsesTransportKind;
use serde_json::Value;

const V3_HISTORICAL_TOOL_IMAGE_PLACEHOLDER_TEXT: &str = "[Image omitted]";

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
    replace_historical_responses_tool_output_data_images(&mut current_request_body);
    validate_current_responses_data_images(&request_id, &current_request_body)?;
    let actual_model = current_request_body
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string);
    if actual_model.as_deref() != Some(target.wire_model.as_str()) {
        return Err(V3ProviderError::ProviderModelBindingMismatch {
            request_id,
            provider_id: target.provider_id.clone(),
            expected_model: target.wire_model.clone(),
            actual_model,
        });
    }
    Ok(V3Provider12ResponsesWirePayload {
        request_id,
        target,
        stream_intent,
        body: current_request_body,
    })
}

fn replace_historical_responses_tool_output_data_images(body: &mut Value) {
    let Some(input) = body.get_mut("input").and_then(Value::as_array_mut) else {
        return;
    };
    let Some(latest_user_index) = input.iter().rposition(is_responses_user_input_item) else {
        return;
    };
    for item in input.iter_mut().take(latest_user_index) {
        replace_historical_function_call_output_data_images(item);
    }
}

fn is_responses_user_input_item(item: &Value) -> bool {
    item.as_object()
        .and_then(|object| object.get("role"))
        .and_then(Value::as_str)
        == Some("user")
}

fn replace_historical_function_call_output_data_images(item: &mut Value) {
    let Some(object) = item.as_object_mut() else {
        return;
    };
    if object.get("type").and_then(Value::as_str) != Some("function_call_output") {
        return;
    }
    let Some(output) = object.get_mut("output").and_then(Value::as_array_mut) else {
        return;
    };
    for output_part in output {
        if is_historical_tool_output_data_image_part(output_part) {
            *output_part = historical_tool_image_placeholder_part();
        }
    }
}

fn is_historical_tool_output_data_image_part(part: &Value) -> bool {
    let Some(object) = part.as_object() else {
        return false;
    };
    if object.get("type").and_then(Value::as_str) != Some("input_image") {
        return false;
    }
    object
        .get("image_url")
        .and_then(image_url_as_str)
        .map(|image_url| image_url.starts_with("data:image"))
        .unwrap_or(false)
}

fn historical_tool_image_placeholder_part() -> Value {
    let mut object = serde_json::Map::new();
    object.insert("type".to_string(), Value::String("input_text".to_string()));
    object.insert(
        "text".to_string(),
        Value::String(V3_HISTORICAL_TOOL_IMAGE_PLACEHOLDER_TEXT.to_string()),
    );
    Value::Object(object)
}

fn validate_current_responses_data_images(
    request_id: &str,
    body: &Value,
) -> Result<(), V3ProviderError> {
    let Some(input) = body.get("input").and_then(Value::as_array) else {
        return Ok(());
    };
    let Some(latest_user_index) = input.iter().rposition(is_responses_user_input_item) else {
        return Ok(());
    };
    for item in input.iter().skip(latest_user_index) {
        validate_data_image_urls_in_value(request_id, item)?;
    }
    Ok(())
}

fn validate_data_image_urls_in_value(
    request_id: &str,
    value: &Value,
) -> Result<(), V3ProviderError> {
    match value {
        Value::Object(object) => {
            if object.get("type").and_then(Value::as_str) == Some("input_image") {
                if let Some(image_url) = object.get("image_url").and_then(image_url_as_str) {
                    validate_data_image_url(request_id, image_url)?;
                }
            }
            for child in object.values() {
                validate_data_image_urls_in_value(request_id, child)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                validate_data_image_urls_in_value(request_id, item)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn image_url_as_str(value: &Value) -> Option<&str> {
    value
        .as_str()
        .or_else(|| value.as_object()?.get("url")?.as_str())
}

fn validate_data_image_url(request_id: &str, image_url: &str) -> Result<(), V3ProviderError> {
    if !image_url.starts_with("data:image/") {
        return Ok(());
    }
    let Some((header, encoded)) = image_url.split_once(',') else {
        return Err(invalid_data_image(
            request_id,
            "image/*",
            "missing base64 separator",
        ));
    };
    let header_lower = header.to_ascii_lowercase();
    let Some(media_type) = header_lower
        .strip_prefix("data:")
        .and_then(|rest| rest.split(';').next())
        .filter(|media_type| media_type.starts_with("image/"))
    else {
        return Ok(());
    };
    if !header_lower.split(';').any(|part| part == "base64") {
        return Err(invalid_data_image(
            request_id,
            media_type,
            "data image must use base64 encoding",
        ));
    }
    let bytes = BASE64_STANDARD
        .decode(encoded.as_bytes())
        .map_err(|error| invalid_data_image(request_id, media_type, error.to_string()))?;
    validate_image_magic(request_id, media_type, &bytes)
}

fn validate_image_magic(
    request_id: &str,
    media_type: &str,
    bytes: &[u8],
) -> Result<(), V3ProviderError> {
    let valid = match media_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" | "image/jpg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && bytes[8..12] == *b"WEBP",
        _ => !bytes.is_empty(),
    };
    if valid {
        Ok(())
    } else {
        Err(invalid_data_image(
            request_id,
            media_type,
            "decoded bytes do not match declared image type",
        ))
    }
}

fn invalid_data_image(
    request_id: &str,
    media_type: impl Into<String>,
    reason: impl Into<String>,
) -> V3ProviderError {
    V3ProviderError::InvalidDataImage {
        request_id: request_id.to_string(),
        media_type: media_type.into(),
        reason: reason.into(),
    }
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

    const VALID_PNG_DATA_URL: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

    #[test]
    fn wire_accepts_only_prebound_selected_model() {
        let body = json!({
            "model":"upstream-model",
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
    fn wire_replaces_only_historical_tool_output_data_images_before_latest_user() {
        let current_user_image = VALID_PNG_DATA_URL;
        let current_tool_image = VALID_PNG_DATA_URL;
        let body = json!({
            "model": "upstream-model",
            "stream": true,
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "old turn"}]
                },
                {
                    "type": "function_call",
                    "name": "view_image",
                    "call_id": "call_old",
                    "arguments": "{}"
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_old",
                    "output": [
                        {"type": "input_image", "image_url": "data:image/png;base64,OLD", "detail": "high"},
                        {"type": "input_image", "image_url": {"url": "data:image/png;base64,OLD_OBJECT"}, "detail": "low"},
                        {"type": "input_text", "text": "tool text stays"}
                    ]
                },
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "current turn"},
                        {"type": "input_image", "image_url": current_user_image}
                    ]
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_after_latest_user",
                    "output": [
                        {"type": "input_image", "image_url": current_tool_image}
                    ]
                }
            ]
        });
        let wire =
            build_v3_provider_12_responses_wire_payload("req-images", target(), body).unwrap();
        let input = wire.body()["input"].as_array().unwrap();
        assert_eq!(
            input[2]["output"][0],
            json!({"type": "input_text", "text": "[Image omitted]"})
        );
        assert_eq!(
            input[2]["output"][1],
            json!({"type": "input_text", "text": "[Image omitted]"})
        );
        assert_eq!(
            input[2]["output"][2],
            json!({"type": "input_text", "text": "tool text stays"})
        );
        assert_eq!(input[3]["content"][1]["image_url"], current_user_image);
        assert_eq!(input[4]["output"][0]["image_url"], current_tool_image);
        assert_eq!(wire.stream_intent(), V3ResponsesStreamIntent::Sse);
    }

    #[test]
    fn wire_does_not_broadly_replace_text_or_non_data_historical_tool_images() {
        let body = json!({
            "model": "upstream-model",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": "old turn"
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_old",
                    "output": [
                        {"type": "input_text", "text": "literal data:image/png;base64,TEXT stays text"},
                        {"type": "input_image", "image_url": "https://example.invalid/old.png"}
                    ]
                },
                {
                    "type": "message",
                    "role": "user",
                    "content": "latest turn"
                }
            ]
        });
        let wire =
            build_v3_provider_12_responses_wire_payload("req-no-broad", target(), body).unwrap();
        let input = wire.body()["input"].as_array().unwrap();
        assert_eq!(
            input[1]["output"][0]["text"],
            "literal data:image/png;base64,TEXT stays text"
        );
        assert_eq!(
            input[1]["output"][1]["image_url"],
            "https://example.invalid/old.png"
        );
    }

    #[test]
    fn current_turn_invalid_png_data_image_is_rejected_before_provider_transport() {
        let body = json!({
            "model": "upstream-model",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "current turn"},
                        {"type": "input_image", "image_url": "data:image/png;base64,AAAA"}
                    ]
                }
            ]
        });
        let error =
            build_v3_provider_12_responses_wire_payload("req-invalid-image", target(), body)
                .expect_err("invalid current-turn data image must fail before provider transport");
        assert!(error.to_string().contains("invalid data:image/png payload"));
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
            "model":"upstream-model",
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
            "model":"upstream-model",
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
