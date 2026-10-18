use super::{
    encode_v3_anthropic_request_as_responses_semantic, V3HubEntryProtocol, V3HubInvocationSource,
    V3HubOpaquePayload, V3HubReqInbound01ClientRaw, V3HubRequestSemanticProtocol,
    V3HubTransportIntent,
};
use crate::operation_runner::{run_v3_single_node_operator, V3OperationGraph};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use serde_json::Value;
use std::sync::{Arc, Mutex};

const NORMALIZE_REQUEST_LOSSLESSLY_OPERATOR: &str =
    "routecodex.v3.operation.normalize_request_losslessly";
const NORMALIZE_REQUEST_LOSSLESSLY_NODE: &str = "normalize_request_losslessly";
const NORMALIZE_REQUEST_LOSSLESSLY_OPERATOR_VERSION: &str = "1";

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqInbound02Normalized {
    pub(crate) previous: V3HubReqInbound01ClientRaw,
    pub(crate) semantic_protocol: V3HubRequestSemanticProtocol,
    pub(crate) canonicalized_from_responses: bool,
    pub(crate) memory_raw_capture_guidance_injected: bool,
}

pub fn build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(
    input: V3HubReqInbound01ClientRaw,
) -> V3HubReqInbound02Normalized {
    build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(input)
        .expect("V3 ReqInbound02 normalization failed")
}

pub fn build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(
    mut input: V3HubReqInbound01ClientRaw,
) -> Result<V3HubReqInbound02Normalized, String> {
    let side_output = Arc::new(Mutex::new(None));
    let operator = NormalizeRequestLosslesslyOperator {
        entry_protocol: input.entry_protocol,
        invocation_source: input.invocation_source,
        transport_intent: input.transport_intent,
        side_output: Arc::clone(&side_output),
    };
    let payload = (*input.payload.0).clone();
    let runner_result = run_v3_single_node_operator(
        V3OperationGraph::Request,
        NORMALIZE_REQUEST_LOSSLESSLY_NODE,
        payload,
        operator,
    );
    let side_output = side_output
        .lock()
        .map_err(|_| "normalize_request_losslessly side-output holder is poisoned".to_string())?
        .take();
    match (runner_result, side_output) {
        (Err(_), Some(Err(error))) => Err(error),
        (Err(error), _) => Err(format!(
            "normalize_request_losslessly canonical execution failed: {error}"
        )),
        (Ok(canonical), Some(Ok(metadata))) => {
            input.payload.0 = Arc::new(canonical);
            Ok(V3HubReqInbound02Normalized {
                previous: input,
                semantic_protocol: metadata.semantic_protocol,
                canonicalized_from_responses: metadata.canonicalized_from_responses,
                memory_raw_capture_guidance_injected: metadata.memory_raw_capture_guidance_injected,
            })
        }
        (Ok(_), Some(Err(error))) => Err(error),
        (Ok(_), None) => Err(
            "normalize_request_losslessly operator completed without a typed side output"
                .to_string(),
        ),
    }
}

struct NormalizeRequestLosslesslySideOutput {
    semantic_protocol: V3HubRequestSemanticProtocol,
    canonicalized_from_responses: bool,
    memory_raw_capture_guidance_injected: bool,
}

struct NormalizeRequestLosslesslyOperator {
    entry_protocol: V3HubEntryProtocol,
    invocation_source: V3HubInvocationSource,
    transport_intent: V3HubTransportIntent,
    side_output: Arc<Mutex<Option<Result<NormalizeRequestLosslesslySideOutput, String>>>>,
}

impl Operator for NormalizeRequestLosslesslyOperator {
    fn name(&self) -> &'static str {
        NORMALIZE_REQUEST_LOSSLESSLY_OPERATOR
    }

    fn version(&self) -> &'static str {
        NORMALIZE_REQUEST_LOSSLESSLY_OPERATOR_VERSION
    }

    fn input_type(&self) -> ValueType {
        ValueType::Any
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _: &OperatorContext) -> Result<Value, String> {
        let raw = V3HubReqInbound01ClientRaw {
            payload: V3HubOpaquePayload(Arc::new(input)),
            entry_protocol: self.entry_protocol,
            invocation_source: self.invocation_source,
            transport_intent: self.transport_intent,
        };
        let normalized = normalize_v3_hub_req_inbound_02_payload(raw);
        match normalized {
            Ok(normalized) => {
                let payload = (*normalized.previous.payload.0).clone();
                let metadata = NormalizeRequestLosslesslySideOutput {
                    semantic_protocol: normalized.semantic_protocol,
                    canonicalized_from_responses: normalized.canonicalized_from_responses,
                    memory_raw_capture_guidance_injected: normalized
                        .memory_raw_capture_guidance_injected,
                };
                *self.side_output.lock().map_err(|_| {
                    "normalize_request_losslessly side-output holder is poisoned".to_string()
                })? = Some(Ok(metadata));
                Ok(payload)
            }
            Err(error) => {
                *self.side_output.lock().map_err(|_| {
                    "normalize_request_losslessly side-output holder is poisoned".to_string()
                })? = Some(Err(error.clone()));
                Err(error)
            }
        }
    }
}

fn normalize_v3_hub_req_inbound_02_payload(
    mut input: V3HubReqInbound01ClientRaw,
) -> Result<V3HubReqInbound02Normalized, String> {
    if input.entry_protocol == V3HubEntryProtocol::Responses
        && (input.payload.0.get("input").is_some()
            || input
                .payload
                .0
                .get("messages")
                .and_then(serde_json::Value::as_array)
                .is_none())
    {
        let raw = Arc::make_mut(&mut input.payload.0);
        let mut canonical =
            super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload_for_req_inbound_compat(raw)
                .map_err(|error| format!("Responses inbound canonicalization failed: {error}"))?;
        if let Some(source) = raw.get("messages").filter(|value| !value.is_null()) {
            let source = source.as_array().ok_or_else(|| {
                "Responses inbound canonicalization failed: messages must be an array".to_string()
            })?;
            let decoded = canonical["messages"]
                .as_array()
                .expect("codec Chat messages");
            canonical["messages"] = Value::Array(merge_responses_chat_histories(source, decoded)?);
        }
        input.payload.0 = Arc::new(canonical);
        return Ok(V3HubReqInbound02Normalized {
            previous: input,
            semantic_protocol: V3HubRequestSemanticProtocol::Chat,
            canonicalized_from_responses: true,
            memory_raw_capture_guidance_injected: false,
        });
    }
    if input.entry_protocol == V3HubEntryProtocol::Anthropic {
        let source_payload = std::mem::replace(&mut input.payload.0, Arc::new(Value::Null));
        let source_payload = Arc::try_unwrap(source_payload).unwrap_or_else(|arc| (*arc).clone());
        let mut responses_semantic = if source_payload
            .get("input")
            .and_then(serde_json::Value::as_array)
            .is_some()
        {
            source_payload
        } else {
            encode_v3_anthropic_request_as_responses_semantic(source_payload)
                .map_err(|error| format!("Anthropic inbound semantic projection failed: {error}"))?
        };
        let mut anthropic_preserved_fields = Vec::new();
        let mut anthropic_reasoning_effort = None;
        let mut anthropic_request_extension = None;
        if let Some(object) = responses_semantic.as_object_mut() {
            anthropic_reasoning_effort = object.remove("reasoning_effort");
            anthropic_request_extension = object.remove("routecodex_chat_extension");
            for key in [
                "context_management",
                "output_config",
                "reasoning_budget_tokens",
                "reasoning_display_policy",
                "reasoning_thinking_mode",
            ] {
                if let Some(value) = object.remove(key) {
                    anthropic_preserved_fields.push((key.to_string(), value));
                }
            }
        }
        let mut canonical =
            super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
                &responses_semantic,
            )
            .map_err(|error| format!("Anthropic inbound Chat canonicalization failed: {error}"))?;
        if let Some(canonical_object) = canonical.as_object_mut() {
            for (key, value) in anthropic_preserved_fields {
                canonical_object.insert(key, value);
            }
            if let Some(value) = anthropic_reasoning_effort {
                canonical_object.insert("reasoning_effort".to_string(), value);
            }
            if let Some(value) = anthropic_request_extension {
                if canonical_object.contains_key("routecodex_chat_extension") {
                    return Err(
                        "Anthropic inbound produced conflicting registered Chat extensions"
                            .to_string(),
                    );
                }
                canonical_object.insert("routecodex_chat_extension".to_string(), value);
            }
        }
        input.payload.0 = Arc::new(canonical);
        return Ok(V3HubReqInbound02Normalized {
            previous: input,
            semantic_protocol: V3HubRequestSemanticProtocol::Chat,
            canonicalized_from_responses: true,
            memory_raw_capture_guidance_injected: false,
        });
    }
    if input.entry_protocol == V3HubEntryProtocol::Gemini {
        // Gemini 客户端请求经相邻 production codec 无损归一化为 canonical Chat +
        // 已登记扩展。归一化后 standard outbound 直接消费 `messages`，不再需要
        // Gemini→X 成对 converter；工具历史交给既有 Chat Process 治理。
        let source_payload = std::mem::replace(&mut input.payload.0, Arc::new(Value::Null));
        let source_payload = Arc::try_unwrap(source_payload).unwrap_or_else(|arc| (*arc).clone());
        let mut canonical =
            super::gemini_request_normalization::build_v3_chat_canonical_request_from_gemini_payload(
                &source_payload,
            )
            .map_err(|error| format!("Gemini inbound Chat canonicalization failed: {error}"))?;
        input.payload.0 = Arc::new(canonical);
        return Ok(V3HubReqInbound02Normalized {
            previous: input,
            semantic_protocol: V3HubRequestSemanticProtocol::Chat,
            canonicalized_from_responses: true,
            memory_raw_capture_guidance_injected: false,
        });
    }
    Ok(V3HubReqInbound02Normalized {
        previous: input,
        semantic_protocol: V3HubRequestSemanticProtocol::Chat,
        canonicalized_from_responses: false,
        memory_raw_capture_guidance_injected: false,
    })
}

fn merge_responses_chat_histories(
    source: &[Value],
    decoded: &[Value],
) -> Result<Vec<Value>, String> {
    if source.len() == decoded.len() {
        if let Some(merged) = source
            .iter()
            .zip(decoded)
            .map(|(source, decoded)| merge_equivalent_chat_value(source, decoded))
            .collect::<Option<Vec<_>>>()
        {
            return Ok(merged);
        }
    }
    // Legacy public hook callers supply preceding Chat calls and current Responses
    // results. Decode the results first; Req04 still owns id/kind pairing.
    if decoded.iter().all(|message| message["role"] == "tool") {
        let mut merged = source.to_vec();
        for result in decoded {
            if let Some(existing) = merged.iter_mut().find(|message| {
                message["role"] == "tool"
                    && message.get("tool_call_id") == result.get("tool_call_id")
            }) {
                *existing = merge_equivalent_chat_value(existing, result).ok_or_else(|| {
                    "Responses inbound canonicalization failed: conflicting tool output representations".to_string()
                })?;
            } else {
                merged.push(result.clone());
            }
        }
        return Ok(merged);
    }
    Err(
        "Responses inbound canonicalization failed: conflicting input and messages representations"
            .to_string(),
    )
}

fn merge_equivalent_chat_value(source: &Value, decoded: &Value) -> Option<Value> {
    match (source, decoded) {
        (Value::Object(source), Value::Object(decoded)) => {
            let empty_assistant_content = |object: &serde_json::Map<String, Value>| {
                object.get("role").is_some_and(|role| role == "assistant")
                    && object
                        .get("tool_calls")
                        .and_then(Value::as_array)
                        .is_some_and(|calls| !calls.is_empty())
                    && object
                        .get("content")
                        .is_none_or(|content| content.is_null() || content.as_str() == Some(""))
            };
            let semantic_keys = |object: &serde_json::Map<String, Value>| {
                object
                    .keys()
                    .filter(|key| {
                        key.as_str() != "routecodex_chat_extension"
                            && !(key.as_str() == "content" && empty_assistant_content(object))
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            };
            if semantic_keys(source) != semantic_keys(decoded) {
                return None;
            }
            let mut merged = source.clone();
            for (key, value) in decoded {
                if key == "routecodex_chat_extension" {
                    let mut fields = match source.get(key) {
                        Some(source) => source.as_object()?.clone(),
                        None => serde_json::Map::new(),
                    };
                    for (field, value) in value.as_object()? {
                        if let Some(existing) = fields.get(field) {
                            if existing != value {
                                return None;
                            }
                        } else {
                            fields.insert(field.clone(), value.clone());
                        }
                    }
                    merged.insert(key.clone(), Value::Object(fields));
                } else if key == "content"
                    && empty_assistant_content(source)
                    && empty_assistant_content(decoded)
                {
                    // Chat assistant tool calls permit absent/null content; the
                    // Responses codec spells that same empty content as "".
                } else if key == "content"
                    && comparable_chat_content(&source[key]) == comparable_chat_content(value)
                {
                    // Preserve the source representation; only singleton plain text
                    // is equivalent to its scalar Chat spelling.
                } else {
                    merged.insert(
                        key.clone(),
                        merge_equivalent_chat_value(&source[key], value)?,
                    );
                }
            }
            Some(Value::Object(merged))
        }
        (Value::Array(source), Value::Array(decoded)) if source.len() == decoded.len() => source
            .iter()
            .zip(decoded)
            .map(|(source, decoded)| merge_equivalent_chat_value(source, decoded))
            .collect::<Option<Vec<_>>>()
            .map(Value::Array),
        _ if source == decoded => Some(source.clone()),
        _ => None,
    }
}

fn comparable_chat_content(content: &Value) -> &Value {
    if let Some(parts) = content.as_array() {
        if parts.len() == 1
            && parts[0].as_object().is_some_and(|part| part.len() == 2)
            && parts[0]["type"] == "text"
            && parts[0]["text"].is_string()
        {
            return &parts[0]["text"];
        }
    }
    content
}

pub fn build_v3_hub_req_inbound_02_responses_chat_canonical_from_v3_hub_req_inbound_01(
    input: V3HubReqInbound01ClientRaw,
) -> Result<V3HubReqInbound02Normalized, String> {
    if input.entry_protocol != V3HubEntryProtocol::Responses {
        return Err(
            "Responses inbound canonicalization requires the Responses entry protocol".to_string(),
        );
    }
    build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub_v1::{V3HubInvocationSource, V3HubTransportIntent};
    use serde_json::json;

    fn raw_request(
        payload: Value,
        entry_protocol: V3HubEntryProtocol,
        invocation_source: V3HubInvocationSource,
        transport_intent: V3HubTransportIntent,
    ) -> V3HubReqInbound01ClientRaw {
        super::super::build_v3_hub_req_inbound_01_client_raw(
            payload,
            entry_protocol,
            invocation_source,
            transport_intent,
        )
    }

    #[test]
    fn malformed_responses_inbound_canonicalization_failure_does_not_enter_chat_process() {
        let raw = super::super::build_v3_hub_req_inbound_01_client_raw(
            json!({
                "model": "gpt-5.5",
                "input": [{
                    "type": "unsupported_provider_private_event",
                    "payload": {"query": "RouteCodex"}
                }]
            }),
            V3HubEntryProtocol::Responses,
            super::super::V3HubInvocationSource::Client,
            super::super::V3HubTransportIntent::Json,
        );

        let result =
            build_v3_hub_req_inbound_02_responses_chat_canonical_from_v3_hub_req_inbound_01(raw);
        assert!(
            result.is_err(),
            "unsupported Responses inbound canonicalization must fail-fast before Chat Process instead of silently continuing as non-canonicalized Chat"
        );
    }

    #[test]
    fn responses_tool_history_is_normalized_to_chat_extension_without_raw_payload_carry() {
        let raw = super::super::build_v3_hub_req_inbound_01_client_raw(
            json!({
                "model": "gpt-5.5",
                "input": [{
                    "type": "web_search_call",
                    "status": "failed",
                    "action": {"type": "search", "query": "RouteCodex"}
                }]
            }),
            V3HubEntryProtocol::Responses,
            super::super::V3HubInvocationSource::Client,
            super::super::V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw).expect(
            "Responses inbound must normalize hosted tool history into Chat extension data",
        );
        assert!(normalized.canonicalized_from_responses);
        assert!(
            normalized.previous.payload.0.get("messages").is_some(),
            "ReqInbound must pass Chat-normalized data forward, not raw Responses payload"
        );
        assert!(
            normalized.previous.payload.0.get("input").is_none(),
            "raw Responses input must not be carried across ReqInbound after normalization"
        );
    }

    #[test]
    fn responses_request_data_fields_enter_typed_chat_extension_without_raw_field_carry() {
        let client_metadata = json!({
            "session_id": "session-1",
            "thread_id": "thread-1",
            "turn_id": "turn-1"
        });
        let raw = super::super::build_v3_hub_req_inbound_01_client_raw(
            json!({
                "model": "gpt-5.5",
                "input": "hello",
                "client_metadata": client_metadata,
                "prompt_cache_key": "session-1",
                "store": false,
                "text": {"verbosity": "high"}
            }),
            V3HubEntryProtocol::Responses,
            super::super::V3HubInvocationSource::Client,
            super::super::V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("Responses request fields must normalize into Chat extension data");
        let payload = &normalized.previous.payload.0;
        let extension = &payload["routecodex_chat_extension"]["responses_request"];

        assert_eq!(extension["client_metadata"], client_metadata);
        assert_eq!(extension["prompt_cache_key"], "session-1");
        assert_eq!(extension["store"], false);
        assert_eq!(extension["text"], json!({"verbosity":"high"}));
        for raw_field in ["client_metadata", "prompt_cache_key", "store", "text"] {
            assert!(
                payload.get(raw_field).is_none(),
                "Responses field {raw_field} must not cross ReqInbound as a raw top-level payload field: {payload}"
            );
        }
    }

    #[test]
    fn responses_continuation_locator_does_not_enter_chat_canonical_payload() {
        let raw = super::super::build_v3_hub_req_inbound_01_client_raw(
            json!({
                "model": "gpt-5.5",
                "previous_response_id": "resp_local_continuation",
                "input": [{
                    "type": "function_call_output",
                    "call_id": "call_lookup",
                    "output": "done"
                }]
            }),
            V3HubEntryProtocol::Responses,
            super::super::V3HubInvocationSource::Client,
            super::super::V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("Responses continuation input must normalize to Chat");

        assert!(normalized.previous.payload.0.get("messages").is_some());
        assert!(
            normalized
                .previous
                .payload
                .0
                .get("previous_response_id")
                .is_none(),
            "continuation control locator must be consumed by its owner and never cross ReqInbound02 as Chat payload"
        );
    }

    #[test]
    fn anthropic_system_extension_survives_req02_chat_canonicalization() {
        let system = json!([
            {"type":"text","text":"dynamic system"},
            {"type":"text","text":"cached system","cache_control":{"type":"ephemeral"}}
        ]);
        let raw = super::super::build_v3_hub_req_inbound_01_client_raw(
            json!({
                "model":"claude-test",
                "max_tokens":128,
                "system":system,
                "context_management":{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]},
                "output_config":{"effort":"high"},
                "thinking":{"type":"enabled","budget_tokens":1024,"display":"omitted"},
                "messages":[{"role":"user","content":"hello"}]
            }),
            super::super::V3HubEntryProtocol::Anthropic,
            super::super::V3HubInvocationSource::Client,
            super::super::V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("Anthropic system data must survive non-destructive Req02 normalization");

        assert_eq!(
            normalized.previous.payload.0["routecodex_chat_extension"]["anthropic_request"]
                ["system"],
            system
        );
        assert_eq!(
            normalized.previous.payload.0["context_management"],
            json!({"edits":[{"type":"clear_thinking_20251015","keep":"all"}]})
        );
        assert_eq!(normalized.previous.payload.0["reasoning_effort"], "high");
        assert_eq!(
            normalized.previous.payload.0["reasoning_thinking_mode"],
            "enabled"
        );
        assert_eq!(
            normalized.previous.payload.0["reasoning_budget_tokens"],
            1024
        );
        assert_eq!(
            normalized.previous.payload.0["reasoning_display_policy"],
            "omitted"
        );
        assert!(
            normalized.previous.payload.0.get("output_config").is_none(),
            "Anthropic effort must normalize into Chat reasoning_effort before Chat Process"
        );
    }

    #[test]
    fn responses_history_image_and_opaque_tool_data_survive_req02_losslessly() {
        let historical_image = json!({
            "type": "input_image",
            "image_url": "data:image/png;base64,AAAA",
            "detail": "original",
            "future_sibling": {"keep": true}
        });
        let raw = raw_request(
            json!({
                "model": "gpt-5.5",
                "input": [
                    {"type":"message","role":"user","content":[
                        {"type":"input_text","text":"inspect the image"}
                    ]},
                    {"type":"message","role":"user","content":[historical_image.clone()]},
                    {"type":"function_call","call_id":"call_history","name":"lookup","arguments":"{\"q\":\"x\"}"},
                    {"type":"function_call_output","call_id":"call_history","output":"done","future_status":{"keep":true}},
                    {"type":"message","role":"user","content":[
                        {"type":"input_text","text":"compare with this image"},
                        {"type":"input_image","image_url":"data:image/png;base64,BBBB","detail":"high"}
                    ]}
                ]
            }),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::ServertoolFollowup,
            V3HubTransportIntent::Sse,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("lossless Responses inbound normalization");
        assert_eq!(
            normalized.previous.entry_protocol,
            V3HubEntryProtocol::Responses
        );
        assert_eq!(
            normalized.previous.invocation_source,
            V3HubInvocationSource::ServertoolFollowup
        );
        assert_eq!(
            normalized.previous.transport_intent,
            V3HubTransportIntent::Sse
        );
        assert_eq!(
            normalized.semantic_protocol,
            V3HubRequestSemanticProtocol::Chat
        );
        assert!(normalized.canonicalized_from_responses);
        assert!(!normalized.memory_raw_capture_guidance_injected);
        let messages = normalized.previous.payload.0["messages"]
            .as_array()
            .expect("canonical Chat messages");
        assert_eq!(
            messages[1]["content"][0]["image_url"]["url"], "data:image/png;base64,AAAA",
            "ReqInbound02 must not replace historical image source data: {messages:#?}"
        );
        assert_eq!(
            messages[1]["content"][0]["image_url"]["detail"], "original",
            "ReqInbound02 must retain mapped image metadata: {messages:#?}"
        );
        assert_eq!(
            messages[1]["content"][0]["future_sibling"],
            json!({"keep": true}),
            "ReqInbound02 must retain opaque fields on historical image parts: {messages:#?}"
        );
        assert_eq!(messages[2]["tool_calls"][0]["id"], "call_history");
        assert_eq!(messages[2]["tool_calls"][0]["function"]["name"], "lookup");
        assert_eq!(
            messages[2]["tool_calls"][0]["function"]["arguments"],
            "{\"q\":\"x\"}"
        );
        assert_eq!(messages[3]["tool_call_id"], "call_history");
        assert_eq!(messages[3]["content"], "done");
    }

    #[test]
    fn openai_chat_history_image_and_opaque_siblings_survive_req02_losslessly() {
        let payload = json!({
            "model": "gpt-5.5",
            "messages": [
                {"role":"user","content":[
                    {"type":"input_text","text":"inspect"},
                    {"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"},"future_sibling":{"keep":true}}
                ]},
                {"role":"assistant","tool_calls":[{
                    "id":"call_history",
                    "type":"function",
                    "function":{"name":"lookup","arguments":"{\"q\":\"x\"}"}
                }]},
                {"role":"tool","tool_call_id":"call_history","content":"done"},
                {"role":"user","content":[
                    {"type":"text","text":"continue"},
                    {"type":"image_url","image_url":{"url":"data:image/png;base64,BBBB"}}
                ]}
            ]
        });
        let raw = raw_request(
            payload.clone(),
            V3HubEntryProtocol::OpenAiChat,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("lossless OpenAI Chat inbound normalization");
        assert_eq!(*normalized.previous.payload.0, payload);
        assert_eq!(
            normalized.previous.payload.0["messages"][0]["content"][1]["image_url"]["url"],
            "data:image/png;base64,AAAA"
        );
        assert_eq!(
            normalized.previous.payload.0["messages"][0]["content"][1]["future_sibling"],
            json!({"keep": true})
        );
        assert_eq!(
            normalized.previous.payload.0["messages"][1]["tool_calls"][0]["id"],
            "call_history"
        );
        assert_eq!(
            normalized.previous.payload.0["messages"][1]["tool_calls"][0]["function"]["name"],
            "lookup"
        );
        assert_eq!(
            normalized.previous.payload.0["messages"][1]["tool_calls"][0]["function"]["arguments"],
            "{\"q\":\"x\"}"
        );
        assert_eq!(
            normalized.previous.payload.0["messages"][2]["tool_call_id"],
            "call_history"
        );
        assert_eq!(
            normalized.previous.payload.0["messages"][2]["content"],
            "done"
        );
        assert!(!normalized.canonicalized_from_responses);
    }

    #[test]
    fn anthropic_history_image_and_paired_tool_history_survive_req02_losslessly() {
        let raw = raw_request(
            json!({
                "model":"claude-test",
                "max_tokens":128,
                "messages":[
                    {"role":"user","content":[
                        {"type":"text","text":"inspect"},
                        {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"},"future_sibling":{"keep":true}}
                    ]},
                    {"role":"assistant","content":[{"type":"tool_use","id":"call_history","name":"lookup","input":{"q":"x"}}]},
                    {"role":"user","content":[{"type":"tool_result","tool_use_id":"call_history","content":"done"}]},
                    {"role":"user","content":[
                        {"type":"text","text":"continue"},
                        {"type":"image","source":{"type":"base64","media_type":"image/png","data":"BBBB"}}
                    ]}
                ]
            }),
            V3HubEntryProtocol::Anthropic,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("lossless Anthropic inbound normalization");
        let messages = normalized.previous.payload.0["messages"]
            .as_array()
            .expect("canonical Chat messages");
        assert_eq!(
            messages[0]["content"][1]["image_url"]["url"],
            "data:image/png;base64,AAAA"
        );
        assert_eq!(
            messages[0]["content"][1]["future_sibling"],
            json!({"keep": true}),
            "Anthropic image siblings must remain associated with their source part"
        );
        assert_eq!(messages[1]["tool_calls"][0]["id"], "call_history");
        assert_eq!(messages[1]["tool_calls"][0]["function"]["name"], "lookup");
        assert_eq!(
            messages[1]["tool_calls"][0]["function"]["arguments"],
            "{\"q\":\"x\"}"
        );
        assert_eq!(messages[2]["tool_call_id"], "call_history");
        assert_eq!(messages[2]["content"], "done");
        assert_eq!(
            messages[3]["content"][1]["image_url"]["url"],
            "data:image/png;base64,BBBB"
        );
    }

    #[test]
    fn gemini_history_image_unknown_native_fields_and_tool_history_survive_req02_losslessly() {
        let raw = raw_request(
            json!({
                "model":"gemini-test",
                "contents":[
                    {"role":"user","parts":[
                        {"text":"inspect"},
                        {"inlineData":{"mimeType":"image/png","data":"AAAA"},"futureSibling":{"keep":true}}
                    ],"turnSibling":{"keep":"container"}},
                    {"role":"model","parts":[{"functionCall":{"id":"call_history","name":"lookup","args":{"q":"x"}}}]},
                    {"role":"user","parts":[{"functionResponse":{"id":"call_history","name":"lookup","response":{"result":"done"}}}]},
                    {"role":"user","parts":[
                        {"text":"continue"},
                        {"inlineData":{"mimeType":"image/png","data":"BBBB"}}
                    ]}
                ],
                "futureRequest":{"keep":true}
            }),
            V3HubEntryProtocol::Gemini,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("lossless Gemini inbound normalization");
        let payload = &normalized.previous.payload.0;
        let messages = payload["messages"]
            .as_array()
            .expect("canonical Chat messages");
        assert_eq!(
            messages[0]["content"][1]["image_url"]["url"],
            "data:image/png;base64,AAAA"
        );
        assert_eq!(
            messages[0]["content"][1]["routecodex_chat_extension"]["gemini_native_fields"][0]
                ["fields"]["futureSibling"],
            json!({"keep": true})
        );
        assert_eq!(
            messages[0]["routecodex_chat_extension"]["gemini_native_fields"][0]["fields"]
                ["turnSibling"],
            json!({"keep": "container"})
        );
        assert_eq!(
            payload["routecodex_chat_extension"]["gemini_native_fields"][0]["fields"]
                ["futureRequest"],
            json!({"keep": true})
        );
        assert_eq!(messages[1]["tool_calls"][0]["id"], "call_history");
        assert_eq!(messages[1]["tool_calls"][0]["function"]["name"], "lookup");
        assert_eq!(
            messages[1]["tool_calls"][0]["function"]["arguments"],
            "{\"q\":\"x\"}"
        );
        assert_eq!(messages[2]["tool_call_id"], "call_history");
        assert_eq!(messages[2]["content"], "{\"result\":\"done\"}");
        assert_eq!(
            messages[3]["content"][1]["image_url"]["url"],
            "data:image/png;base64,BBBB"
        );
    }

    #[test]
    fn canonical_execution_returns_the_operator_error_without_swallowing_it() {
        let raw = raw_request(
            json!({
                "model":"gpt-5.5",
                "input":[{"type":"unsupported_provider_private_event","payload":{"query":"x"}}]
            }),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );

        let error = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect_err("unsupported Responses input must preserve the canonical execution error");
        assert_eq!(
            error,
            "Responses inbound canonicalization failed: unsupported Responses input item type for OpenAI Chat provider encoding: unsupported_provider_private_event"
        );
    }

    #[test]
    fn canonical_execution_does_not_mask_a_runner_error_after_operator_side_output() {
        let raw = raw_request(
            json!([]),
            V3HubEntryProtocol::OpenAiChat,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );

        let error = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect_err("a canonical output-schema failure must not be masked by side output");
        assert!(
            error.contains("normalize_request_losslessly canonical execution failed"),
            "runner failure must remain explicit: {error}"
        );
    }

    #[test]
    fn responses_duplicate_image_urls_keep_their_occurrence_siblings() {
        let image_url = "data:image/png;base64,AAAA";
        let raw = raw_request(
            json!({
                "model":"gpt-5.5",
                "input":[
                    {"type":"message","role":"user","content":[
                        {"type":"input_image","image_url":image_url,"future_sibling":{"occurrence":1}}
                    ]},
                    {"type":"message","role":"user","content":[
                        {"type":"input_image","image_url":image_url,"future_sibling":{"occurrence":2}}
                    ]}
                ]
            }),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("duplicate Responses image URLs must normalize losslessly");
        let messages = normalized.previous.payload.0["messages"]
            .as_array()
            .expect("canonical Chat messages");
        assert_eq!(
            messages[0]["content"][0]["future_sibling"],
            json!({"occurrence":1})
        );
        assert_eq!(
            messages[1]["content"][0]["future_sibling"],
            json!({"occurrence":2}),
            "image siblings must follow source occurrence, not the first equal URL"
        );
    }
}
