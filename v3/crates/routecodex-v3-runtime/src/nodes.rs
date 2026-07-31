use futures_util::Stream;
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error01SourceRaised, V3ErrorSourceKind,
    V3ProviderFailureSessionScope,
};
use routecodex_v3_route_classifier::{
    classify_route, extract_active_turn_signals, RouteClassifierInput,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::pin::Pin;

#[derive(Debug, Clone, PartialEq)]
pub struct V3Server03HttpRequestRaw {
    pub server_id: String,
    pub failure_session_scope: V3ProviderFailureSessionScope,
    pub request_id: String,
    pub execution_id: String,
    pub method: String,
    pub path: String,
    pub body: Value,
}

pub fn build_v3_server_03_http_request_raw(
    server_id: String,
    failure_session_scope: V3ProviderFailureSessionScope,
    request_id: String,
    execution_id: String,
    method: String,
    path: String,
    body: Value,
) -> V3Server03HttpRequestRaw {
    V3Server03HttpRequestRaw {
        server_id,
        failure_session_scope,
        request_id,
        execution_id,
        method,
        path,
        body,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3Req04StandardizedResponses {
    pub body: Value,
    pub protocol_context: V3ProtocolContext,
    pub route_classifier_metadata: V3RouteClassifierMetadata,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct V3RouteClassifierMetadata {
    pub has_image_attachment: bool,
    pub stopless_followup: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProtocolContext {
    pub server_id: String,
    pub failure_session_scope: V3ProviderFailureSessionScope,
    pub request_id: String,
    pub execution_id: String,
    pub endpoint: String,
    pub method: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3ResponsesDirect11Policy {
    pub target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    pub request_id: String,
    pub request_body: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3Execution11ProtocolDecisionMode {
    SameProtocolDirect,
    HubRelay,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Execution11ProtocolDecision {
    pub mode: V3Execution11ProtocolDecisionMode,
    pub entry_protocol: crate::hub_v1::V3HubProviderWireProtocol,
    pub selected_provider_protocol: crate::hub_v1::V3HubProviderWireProtocol,
    pub target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
}

pub type V3ClientSseStream =
    Pin<Box<dyn Stream<Item = Result<Vec<u8>, V3Error01SourceRaised>> + Send>>;

pub enum V3ClientBody {
    Json(Value),
    Bytes(Vec<u8>),
    Sse(V3ClientSseStream),
}

impl fmt::Debug for V3ClientBody {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(value) => formatter.debug_tuple("Json").field(value).finish(),
            Self::Bytes(bytes) => formatter
                .debug_struct("Bytes")
                .field("byte_len", &bytes.len())
                .finish(),
            Self::Sse(_) => formatter.write_str("Sse(<client-event-stream>)"),
        }
    }
}

#[derive(Debug)]
pub struct V3Resp15ClientPayload {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: V3ClientBody,
}

pub fn build_v3_req_04_standardized_responses_from_v3_server_03(
    raw: V3Server03HttpRequestRaw,
) -> V3Req04StandardizedResponses {
    let route_classifier_metadata = extract_v3_route_classifier_metadata(&raw.body);
    V3Req04StandardizedResponses {
        protocol_context: V3ProtocolContext {
            server_id: raw.server_id,
            failure_session_scope: raw.failure_session_scope,
            request_id: raw.request_id,
            execution_id: raw.execution_id,
            endpoint: raw.path,
            method: raw.method,
        },
        body: raw.body,
        route_classifier_metadata,
    }
}

pub fn build_v3_router_request_facts_from_v3_req_04(
    standardized: &V3Req04StandardizedResponses,
    manifest: &routecodex_v3_config::V3Config05ManifestPublished,
) -> routecodex_v3_virtual_router::V3RouterRequestFacts {
    build_v3_router_request_facts_for_entry_with_metadata(
        &standardized.body,
        "responses",
        configured_v3_longcontext_threshold_tokens(
            manifest,
            &standardized.protocol_context.server_id,
        ),
        standardized.route_classifier_metadata,
    )
}

pub fn build_v3_router_request_facts_for_entry(
    body: &Value,
    entry_protocol: &str,
    longcontext_threshold_tokens: Option<u64>,
) -> routecodex_v3_virtual_router::V3RouterRequestFacts {
    build_v3_router_request_facts_for_entry_with_metadata(
        body,
        entry_protocol,
        longcontext_threshold_tokens,
        extract_v3_route_classifier_metadata(body),
    )
}

fn build_v3_router_request_facts_for_entry_with_metadata(
    body: &Value,
    entry_protocol: &str,
    longcontext_threshold_tokens: Option<u64>,
    route_classifier_metadata: V3RouteClassifierMetadata,
) -> routecodex_v3_virtual_router::V3RouterRequestFacts {
    let mut capabilities = BTreeSet::from(["text".to_string()]);
    let input_tokens = estimate_v3_routing_input_tokens(body);
    let active_turn = extract_active_turn_signals(body);
    let route_classification = classify_route(&RouteClassifierInput {
        reached_long_context: longcontext_threshold_tokens
            .is_some_and(|threshold| input_tokens >= threshold),
        has_image_attachment: route_classifier_metadata.has_image_attachment,
        latest_message_from_user: active_turn.latest_message_from_user,
        stopless_followup: route_classifier_metadata.stopless_followup,
        has_current_turn_tool_output: active_turn.has_current_turn_tool_output,
        last_assistant_tool_category: active_turn
            .last_assistant_tool
            .as_ref()
            .map(|tool| tool.category.clone()),
        current_user_text: active_turn.current_user_text,
        has_background_keyword: false,
    });
    for capability in &route_classification.required_capabilities {
        capabilities.insert(capability.clone());
    }
    if route_classifier_metadata.has_image_attachment {
        capabilities.insert("multimodal".to_string());
        capabilities.insert("vision".to_string());
    }
    if active_turn.has_current_turn_tool_output {
        capabilities.insert("tool_outputs".to_string());
    }
    routecodex_v3_virtual_router::V3RouterRequestFacts {
        entry_protocol: entry_protocol.to_string(),
        client_model: body
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        capabilities,
        input_tokens,
        route_classification,
    }
}

pub fn extract_v3_route_classifier_metadata(body: &Value) -> V3RouteClassifierMetadata {
    V3RouteClassifierMetadata {
        has_image_attachment: body
            .pointer("/metadata/hasImageAttachment")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        stopless_followup: body
            .pointer("/metadata/runtime_control/serverToolFollowup")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

pub fn configured_v3_longcontext_threshold_tokens(
    manifest: &routecodex_v3_config::V3Config05ManifestPublished,
    server_id: &str,
) -> Option<u64> {
    manifest
        .servers
        .get(server_id)
        .and_then(|server| manifest.route_groups.get(&server.routing_group))
        .and_then(|group| group.pools.get("longcontext"))
        .and_then(|pool| pool.match_rule.as_ref())
        .and_then(|match_rule| match_rule.min_input_tokens)
}

fn estimate_v3_routing_input_tokens(body: &Value) -> u64 {
    crate::token_estimation::estimate_v3_request_tokens(body)
}

pub(crate) fn detect_v3_media_kind(
    values: &serde_json::Map<String, Value>,
) -> Option<&'static str> {
    let type_value = values
        .get("type")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if type_value.contains("video") {
        return Some("video");
    }
    if type_value.contains("image") {
        return Some("image");
    }
    if values.contains_key("video_url") {
        return Some("video");
    }
    if values.contains_key("image_url") {
        return Some("image");
    }
    let data = values
        .get("data")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if data.starts_with("data:video/") {
        return Some("video");
    }
    if data.starts_with("data:image/") {
        return Some("image");
    }
    None
}

pub fn build_v3_responses_direct_11_policy_from_v3_target_10(
    selected: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    standardized: &V3Req04StandardizedResponses,
) -> V3ResponsesDirect11Policy {
    V3ResponsesDirect11Policy {
        target: selected,
        request_id: standardized.protocol_context.request_id.clone(),
        request_body: standardized.body.clone(),
    }
}

pub fn build_v3_execution_11_protocol_decision_from_v3_target_10(
    selected: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    entry_protocol: &str,
    allowed_modes: &[String],
) -> Result<V3Execution11ProtocolDecision, V3Error01SourceRaised> {
    let entry_protocol = entry_protocol_wire_protocol(entry_protocol)?;
    let selected_provider_protocol = crate::hub_v1::provider_wire_protocol_for_provider_type(
        &selected.candidate.provider_id,
        &selected.candidate.provider_type,
    )
    .map_err(|error| {
        build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Execution11ProtocolDecision",
            "provider_protocol_unresolved",
            error,
        )
    })?;
    let direct_allowed = allowed_modes
        .iter()
        .any(|mode| mode.trim().eq_ignore_ascii_case("direct"));
    let relay_allowed = allowed_modes
        .iter()
        .any(|mode| mode.trim().eq_ignore_ascii_case("relay"));
    let mode = if entry_protocol == selected_provider_protocol {
        if !direct_allowed {
            return Err(build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3Execution11ProtocolDecision",
                "protocol_same_direct_not_allowed",
                "same protocol selected target requires direct mode but direct is not allowed",
            ));
        }
        V3Execution11ProtocolDecisionMode::SameProtocolDirect
    } else if relay_allowed {
        V3Execution11ProtocolDecisionMode::HubRelay
    } else {
        return Err(build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Execution11ProtocolDecision",
            "protocol_mismatch_relay_not_allowed",
            format!(
                "entry protocol {:?} selected provider protocol {:?} requires relay but relay is not allowed",
                entry_protocol, selected_provider_protocol
            ),
        ));
    };
    Ok(V3Execution11ProtocolDecision {
        mode,
        entry_protocol,
        selected_provider_protocol,
        target: selected,
    })
}

fn entry_protocol_wire_protocol(
    entry_protocol: &str,
) -> Result<crate::hub_v1::V3HubProviderWireProtocol, V3Error01SourceRaised> {
    match entry_protocol.trim() {
        "responses" | "openai_responses" | "openai-responses" => {
            Ok(crate::hub_v1::V3HubProviderWireProtocol::Responses)
        }
        "anthropic" | "anthropic_messages" | "anthropic-messages" => {
            Ok(crate::hub_v1::V3HubProviderWireProtocol::Anthropic)
        }
        "openai_chat" | "openai-chat" | "chat_completions" | "chat-completions" => {
            Ok(crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat)
        }
        "gemini" | "gemini_chat" | "gemini-chat" => {
            Ok(crate::hub_v1::V3HubProviderWireProtocol::Gemini)
        }
        other => Err(build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Execution11ProtocolDecision",
            "entry_protocol_unresolved",
            format!("unsupported entry protocol for protocol decision: {other}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::build_v3_router_request_facts_for_entry;
    use serde_json::json;

    const TEST_LONGCONTEXT_THRESHOLD_TOKENS: Option<u64> = Some(180_000);

    #[test]
    fn v3_routing_token_estimate_omits_image_payload_bytes() {
        let base = json!({
            "model": "gpt-5.6-sol",
            "input": [
                {
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "Describe this image." }
                    ]
                }
            ],
            "tools": []
        });
        let with_image = json!({
            "model": "gpt-5.6-sol",
            "input": [
                {
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "Describe this image." },
                        {
                            "type": "input_image",
                            "image_url": {
                                "url": format!("data:image/png;base64,{}", "A".repeat(1_200_000))
                            }
                        }
                    ]
                }
            ],
            "tools": []
        });

        let base_tokens = build_v3_router_request_facts_for_entry(
            &base,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        )
        .input_tokens;
        let image_tokens = build_v3_router_request_facts_for_entry(
            &with_image,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        )
        .input_tokens;

        assert!(
            image_tokens <= base_tokens + 8,
            "V3 routing token estimate must omit image/base64 bytes like the V2 Rust estimator; base={base_tokens}, image={image_tokens}"
        );
    }

    #[test]
    fn v3_routing_facts_use_metadata_attachment_as_only_multimodal_signal() {
        let request = json!({
            "model": "gpt-5.6-sol",
            "metadata": {"hasImageAttachment": true},
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "Describe this image."},
                        {"type": "input_image", "image_url": {"url": "data:image/png;base64,AAAA"}}
                    ]
                }
            ],
            "tools": []
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert!(facts.capabilities.contains("multimodal"));
        assert!(facts.capabilities.contains("vision"));
    }

    #[test]
    fn v3_routing_facts_do_not_infer_multimodal_from_payload_image() {
        let request = json!({
            "model": "gpt-5.6-sol",
            "metadata": {"hasImageAttachment": false},
            "input": [{
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "Describe this image [Image #1]."},
                    {"type": "input_image", "image_url": {"url": "data:image/png;base64,AAAA"}}
                ]
            }]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert!(!facts.capabilities.contains("multimodal"));
        assert!(!facts.capabilities.contains("vision"));
    }

    #[test]
    fn v3_routing_facts_do_not_model_stream_as_capability() {
        let request = json!({
            "model": "gpt-5.5",
            "stream": true,
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "ping"}
                    ]
                }
            ]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert!(facts.capabilities.contains("text"));
        assert!(
            !facts.capabilities.contains("streaming"),
            "stream is a transport intent, not a routing/model capability"
        );
    }

    #[test]
    fn v3_routing_facts_do_not_use_reasoning_as_route_signal() {
        let request = json!({
            "model": "gpt-5.5",
            "reasoning": {"effort": "medium"},
            "input": [
                {"role":"user","content":"apply the patch"},
                {
                    "type":"custom_tool_call",
                    "name":"apply_patch",
                    "call_id":"call_patch",
                    "input":"*** Begin Patch\n*** Update File: a\n*** End Patch"
                },
                {
                    "type":"custom_tool_call_output",
                    "call_id":"call_patch",
                    "output":"Done!"
                }
            ]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert_eq!(facts.route_classification.route_name, "coding");
        assert!(!facts.capabilities.contains("coding"));
        assert!(!facts.capabilities.contains("thinking"));
        assert!(!facts.capabilities.contains("reasoning"));
    }

    #[test]
    fn v3_routing_facts_mark_current_user_input_as_thinking() {
        let request = json!({
            "model": "gpt-5.5",
            "input": [{"role":"user","content":"继续按照合同进行修复"}]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert!(
            !facts.capabilities.contains("thinking"),
            "thinking is a route classification, not a target capability: {:?}",
            facts.capabilities
        );
        assert_eq!(facts.route_classification.route_name, "thinking");
        assert_eq!(
            facts.route_classification.candidates,
            ["thinking", "default"]
        );
    }

    #[test]
    fn v3_routing_facts_use_configured_longcontext_threshold() {
        let request = json!({
            "model": "gpt-5.5",
            "input": [{"role":"user","content":"short request"}]
        });

        let below_configured_threshold =
            build_v3_router_request_facts_for_entry(&request, "responses", Some(10_000));
        assert_eq!(
            below_configured_threshold.route_classification.route_name,
            "thinking"
        );

        let at_configured_threshold =
            build_v3_router_request_facts_for_entry(&request, "responses", Some(1));
        assert_eq!(
            at_configured_threshold.route_classification.route_name,
            "longcontext"
        );
        assert_eq!(
            at_configured_threshold.route_classification.candidates,
            ["longcontext", "default"]
        );
    }

    #[test]
    fn v3_routing_facts_ignore_declared_codex_tool_surface() {
        let request = json!({
            "model": "gpt-5.5",
            "input": [
                {
                    "role": "developer",
                    "tools": [
                        {"type":"function","name":"exec_command"},
                        {"type":"function","name":"apply_patch"},
                        {"type":"function","name":"tool_search"}
                    ],
                    "type": "additional_tools"
                },
                {"role":"user","content":"继续实现并验证"}
            ]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert_eq!(facts.route_classification.route_name, "thinking");
        assert!(!facts.capabilities.contains("thinking"));
        assert!(!facts.capabilities.contains("tools"));
        assert!(!facts.capabilities.contains("coding"));
        assert!(!facts.capabilities.contains("search"));
    }

    #[test]
    fn v3_routing_facts_ignore_declared_web_search_tool_surface() {
        let request = json!({
            "model": "gpt-5.5",
            "tools": [
                {"type":"function","name":"web_search"},
                {"type":"function","name":"lookup"}
            ],
            "input": [{"role":"user","content":"continue the implementation"}]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert_eq!(facts.route_classification.route_name, "thinking");
        assert!(!facts.capabilities.contains("thinking"));
        assert!(!facts.capabilities.contains("tools"));
        assert!(!facts.capabilities.contains("web_search"));
        assert!(!facts.capabilities.contains("coding"));
    }

    #[test]
    fn v3_routing_facts_classify_actual_current_turn_tools() {
        let classify = |name: &str, arguments: serde_json::Value| {
            let request = json!({
                "model": "gpt-5.5",
                "tools": [{"type":"web_search"}],
                "input": [
                    {"role":"user","content":"continue"},
                    {
                        "type":"function_call",
                        "name":name,
                        "call_id":"call_tool",
                        "arguments":arguments
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_tool",
                        "output":"ok"
                    }
                ]
            });
            build_v3_router_request_facts_for_entry(
                &request,
                "responses",
                TEST_LONGCONTEXT_THRESHOLD_TOKENS,
            )
        };

        let thinking = classify("exec_command", json!({"cmd":"cat src/lib.rs"}));
        assert_eq!(thinking.route_classification.route_name, "thinking");
        assert!(!thinking.capabilities.contains("thinking"));
        assert!(!thinking.capabilities.contains("web_search"));

        let search = classify("exec_command", json!({"cmd":"rg -n route src"}));
        assert_eq!(search.route_classification.route_name, "search");
        assert!(!search.capabilities.contains("search"));

        let tools = classify("exec_command", json!({"cmd":"cargo test"}));
        assert_eq!(tools.route_classification.route_name, "tools");
        assert!(!tools.capabilities.contains("tools"));

        let web = classify("web_search", json!({"query":"latest release"}));
        assert_eq!(web.route_classification.route_name, "web_search");
        assert_eq!(
            web.route_classification.candidates,
            ["web_search", "default"]
        );
        assert!(web.capabilities.contains("web_search"));
    }

    #[test]
    fn v3_routing_facts_ignore_historical_tools_after_new_user_turn() {
        let request = json!({
            "model": "gpt-5.5",
            "input": [
                {"role":"user","content":"search the repo"},
                {
                    "type":"function_call",
                    "name":"exec_command",
                    "call_id":"call_old",
                    "arguments":{"cmd":"rg -n route src"}
                },
                {"type":"function_call_output","call_id":"call_old","output":"old"},
                {"role":"user","content":"now explain the result"}
            ]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert_eq!(facts.route_classification.route_name, "thinking");
        assert!(!facts.capabilities.contains("thinking"));
        assert!(!facts.capabilities.contains("search"));
        assert!(!facts.capabilities.contains("tools"));
    }

    #[test]
    fn v3_routing_facts_classify_old_failure_sample_as_coding_not_web_search() {
        let request = json!({
            "model": "gpt-5.5",
            "metadata": null,
            "reasoning": {"effort":"medium","summary":"detailed"},
            "tools": [
                {"type":"web_search"},
                {"type":"custom","name":"apply_patch"}
            ],
            "input": [
                {"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]},
                {
                    "type":"custom_tool_call",
                    "name":"apply_patch",
                    "call_id":"call_019fa961f9cc765083b8b8d3",
                    "input":"*** Update File: v3/crates/routecodex-v3-server/src/lib.rs"
                },
                {
                    "type":"custom_tool_call_output",
                    "call_id":"call_019fa961f9cc765083b8b8d3",
                    "output":"apply_patch verification failed"
                }
            ]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert_eq!(facts.route_classification.route_name, "coding");
        assert!(!facts.capabilities.contains("coding"));
        assert!(!facts.capabilities.contains("web_search"));
        assert_eq!(facts.route_classification.candidates, ["coding", "default"]);
    }

    #[test]
    fn v3_routing_token_estimate_omits_stringified_media_payloads() {
        let base_input = serde_json::to_string(&json!([
            { "type": "input_text", "text": "Summarize this clip." }
        ]))
        .unwrap();
        let base = json!({
            "model": "gpt-5.6-sol",
            "input": base_input,
            "tools": []
        });
        let stringified = serde_json::to_string(&json!([
            { "type": "input_text", "text": "Summarize this clip." },
            {
                "type": "input_video",
                "video_url": format!("data:video/mp4;base64,{}", "B".repeat(1_200_000))
            }
        ]))
        .unwrap();
        let with_video = json!({
            "model": "gpt-5.6-sol",
            "input": stringified,
            "tools": []
        });

        let base_tokens = build_v3_router_request_facts_for_entry(
            &base,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        )
        .input_tokens;
        let video_tokens = build_v3_router_request_facts_for_entry(
            &with_video,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        )
        .input_tokens;

        assert!(
            video_tokens <= base_tokens + 12,
            "V3 routing token estimate must omit stringified media/base64 bytes like the V2 Rust estimator; base={base_tokens}, video={video_tokens}"
        );
    }
}
