use super::*;
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_02_classified_from_v3_error_01,
    build_v3_error_03_target_local_action_from_v3_error_02,
    build_v3_error_04_target_exhaustion_decision_from_v3_error_03,
    build_v3_error_05_execution_decision_from_v3_error_04,
    build_v3_error_06_client_projected_from_v3_error_05, V3ErrorActionScope, V3ErrorSourceKind,
    V3_ERROR_CHAIN_NODE_IDS,
};
use routecodex_v3_provider_responses::{
    build_v3_provider_12_responses_wire_payload,
    build_v3_transport_13_responses_http_request_from_parts, ReqwestResponsesTransport,
    ResponsesTransport, V3ProviderAuthHandle, V3ProviderAuthSecretHandle, V3ProviderError,
    V3ProviderResponseBody, V3ResponsesProviderTarget, V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_target::V3TargetInterpreter;
use routecodex_v3_virtual_router::V3VirtualRouter;
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::pin::Pin;

pub type V3OpenAiChatClientStream =
    Pin<Box<dyn futures_util::Stream<Item = Result<Vec<u8>, String>> + Send>>;

pub enum V3OpenAiChatRelayClientBody {
    Json(Value),
    Sse(V3OpenAiChatClientStream),
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3OpenAiChatRelayRuntimeInput {
    pub server_id: String,
    pub request_id: String,
    pub payload: Value,
}

pub struct V3OpenAiChatRelayRuntimeOutput {
    pub status: u16,
    pub client_body: V3OpenAiChatRelayClientBody,
    pub node_trace: Vec<&'static str>,
    pub error_chain: Option<Vec<&'static str>>,
}

impl std::fmt::Debug for V3OpenAiChatRelayRuntimeOutput {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("V3OpenAiChatRelayRuntimeOutput")
            .field("status", &self.status)
            .field(
                "client_body",
                &match self.client_body {
                    V3OpenAiChatRelayClientBody::Json(_) => "json",
                    V3OpenAiChatRelayClientBody::Sse(_) => "sse",
                },
            )
            .field("node_trace", &self.node_trace)
            .field("error_chain", &self.error_chain)
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum V3OpenAiChatRelayRuntimeError {
    #[error(transparent)]
    Request(#[from] V3HubRelayRequestError),
    #[error(transparent)]
    Response(#[from] V3HubRelayResponseError),
    #[error(transparent)]
    Codec(#[from] V3OpenAiChatCodecError),
    #[error("V3 Hub static hook registry failed: {0}")]
    StaticRegistry(String),
    #[error("V3 OpenAI Chat target resolution failed: {0}")]
    Target(String),
    #[error("V3 OpenAI Chat provider contract failed: {0}")]
    Provider(#[from] V3ProviderError),
    #[error("V3 OpenAI Chat JSON provider body is malformed: {0}")]
    ProviderJson(#[from] serde_json::Error),
    #[error("V3 OpenAI Chat structured SSE projection failed: {0}")]
    StructuredSse(String),
}

pub async fn execute_v3_openai_chat_relay_runtime_with_default_transport(
    manifest: &V3Config05ManifestPublished,
    input: V3OpenAiChatRelayRuntimeInput,
) -> Result<V3OpenAiChatRelayRuntimeOutput, V3OpenAiChatRelayRuntimeError> {
    execute_v3_openai_chat_relay_runtime(manifest, input, &ReqwestResponsesTransport::default())
        .await
}

pub async fn execute_v3_openai_chat_relay_runtime<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3OpenAiChatRelayRuntimeInput,
    transport: &T,
) -> Result<V3OpenAiChatRelayRuntimeOutput, V3OpenAiChatRelayRuntimeError> {
    compile_v3_hub_v1_static_registry()
        .map_err(|error| V3OpenAiChatRelayRuntimeError::StaticRegistry(error.to_string()))?;
    let mut trace = Vec::with_capacity(17);
    let transport_intent = if input.payload.get("stream").and_then(Value::as_bool) == Some(true) {
        V3HubTransportIntent::Sse
    } else {
        V3HubTransportIntent::Json
    };
    let req01 = build_v3_hub_req_inbound_01_client_raw(
        input.payload,
        V3HubEntryProtocol::OpenAiChat,
        V3HubInvocationSource::Client,
        transport_intent,
    );
    trace.push("V3HubReqInbound01ClientRaw");
    let semantic = characterize_v3_openai_chat_client_input_to_hub_semantic(
        req01.payload.0,
        V3HubEntryProtocol::OpenAiChat,
        transport_intent,
    )?;
    let req01 = build_v3_hub_req_inbound_01_client_raw(
        semantic.payload().clone(),
        V3HubEntryProtocol::OpenAiChat,
        V3HubInvocationSource::Client,
        transport_intent,
    );
    let req02 = build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(req01);
    trace.push("V3HubReqInbound02Normalized");
    let lookup = V3HubContinuationLookup::new(
        None,
        V3HubContinuationScope::new(
            V3HubEntryProtocol::OpenAiChat,
            &input.server_id,
            server_routing_group(manifest, &input.server_id)?,
            &input.request_id,
        ),
    );
    let request_outcome = compile_v3_hub_relay_request_hooks().run_from_normalized(
        req02,
        &lookup,
        &V3HubServertoolRequestProfile::disabled(),
    )?;
    trace.push("V3HubReqContinuation03Classified");
    trace.push("V3HubReqChatProcess04Governed");
    let req04 = request_outcome.into_governed();
    let req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
        req04,
        V3HubExecutionMode::Relay,
    );
    trace.push("V3HubReqExecution05Planned");
    let selected = resolve_target(
        manifest,
        &input.server_id,
        &req05.previous.previous.previous.previous.payload.0,
    )?;
    let selected_target_provider_id = selected.candidate.provider_id.clone();
    let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
        req05,
        V3HubTargetResolution::Routed,
        selected.candidate,
    );
    trace.push("V3HubReqTarget06Resolved");
    let req07 = build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
        req06,
        V3HubProviderWireProtocol::OpenAiChat,
    );
    trace.push("V3HubReqOutbound07ProviderSemantic");
    let target = provider_target(manifest, req07.selected_target())?;
    let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07);
    trace.push("ProviderReqCompat06ProviderCompat");
    let req08 = build_v3_provider_req_outbound_08_from_provider_req_compat_06(req_compat);
    let _req09 = build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(req08);
    let provider_semantic = characterize_v3_openai_chat_hub_semantic_to_provider_wire(semantic)?
        .payload()
        .clone();
    let wire =
        build_v3_provider_12_responses_wire_payload(&input.request_id, target, provider_semantic)?;
    trace.push("V3ProviderReqOutbound08WirePayload");
    let transport_request = build_v3_openai_chat_transport_09_from_v3_provider_08(wire)?;
    trace.push("V3ProviderReqOutbound09TransportRequest");
    let provider_raw = match transport.send(transport_request).await {
        Ok(raw) => raw,
        Err(V3ProviderError::HttpStatus { response }) => {
            return Ok(provider_error_output(
                response.status,
                &response.body,
                &selected_target_provider_id,
                trace,
            ));
        }
        Err(error) => {
            return Ok(provider_runtime_error_output(
                error,
                &selected_target_provider_id,
                trace,
            ))
        }
    };
    match provider_raw.into_body() {
        V3ProviderResponseBody::Json(bytes) => {
            let provider_value = serde_json::from_slice(&bytes)?;
            let client_response =
                project_json_response(provider_value, transport_intent, &mut trace)?;
            Ok(V3OpenAiChatRelayRuntimeOutput {
                status: 200,
                client_body: V3OpenAiChatRelayClientBody::Json(client_response),
                node_trace: trace,
                error_chain: None,
            })
        }
        V3ProviderResponseBody::Sse(stream) => Ok(V3OpenAiChatRelayRuntimeOutput {
            status: 200,
            client_body: V3OpenAiChatRelayClientBody::Sse(project_sse_stream(stream)),
            node_trace: trace,
            error_chain: None,
        }),
    }
}

fn build_v3_openai_chat_transport_09_from_v3_provider_08(
    wire: routecodex_v3_provider_responses::V3Provider12ResponsesWirePayload,
) -> Result<V3Transport13ResponsesHttpRequest, V3OpenAiChatRelayRuntimeError> {
    let request_id = wire.request_id().to_string();
    let target = wire.target().clone();
    let stream_intent = wire.stream_intent();
    let body = wire.body().clone();
    let url_text = format!("{}/chat/completions", target.base_url.trim_end_matches('/'));
    build_v3_transport_13_responses_http_request_from_parts(
        request_id,
        target.provider_id,
        url_text,
        target.auth,
        stream_intent,
        body,
    )
    .map_err(|error| V3OpenAiChatRelayRuntimeError::Target(error.to_string()))
}

pub fn project_v3_openai_chat_relay_runtime_failure(
    error: V3OpenAiChatRelayRuntimeError,
) -> V3OpenAiChatRelayRuntimeOutput {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::RuntimeFailure,
        "V3HubRuntime",
        "openai_chat_relay_runtime_error",
        error.to_string(),
    );
    error_output(
        source,
        500,
        json!({"error":{"type":"runtime_error","message":error.to_string()}}),
        "none",
        Vec::new(),
    )
}

fn project_json_response(
    provider_value: Value,
    transport_intent: V3HubTransportIntent,
    trace: &mut Vec<&'static str>,
) -> Result<Value, V3OpenAiChatRelayRuntimeError> {
    let semantic = characterize_v3_openai_chat_provider_raw_to_hub_response_semantic(
        provider_value,
        V3HubProviderWireProtocol::OpenAiChat,
        transport_intent,
    )?;
    let governance = build_openai_chat_json_governance_response(semantic.payload())?;
    let resp01 = build_v3_provider_resp_inbound_01_raw(
        governance,
        V3HubEntryProtocol::OpenAiChat,
        V3HubProviderWireProtocol::OpenAiChat,
        V3HubContinuationOwnership::New,
        V3HubExecutionMode::Relay,
        V3HubInvocationSource::Client,
        transport_intent,
    );
    trace.push("V3ProviderRespInbound01Raw");
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks.normalize(resp01)?;
    trace.push("ProviderRespCompat02ProviderCompat");
    trace.push("V3HubRespInbound02Normalized");
    let resp03 = hooks.govern(resp02, &V3HubRelayResponseHookProfile::empty())?;
    trace.push("V3HubRespChatProcess03Governed");
    let resp04 = hooks.commit(resp03)?;
    trace.push("V3HubRespContinuation04Committed");
    let client = characterize_v3_openai_chat_hub_response_semantic_to_client_projection(semantic)?;
    let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04);
    trace.push("V3HubRespOutbound05ClientSemantic");
    let _resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);
    trace.push("V3ServerRespOutbound06ClientFrame");
    Ok(client.payload().clone())
}

struct V3OpenAiChatSseState {
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    decoder: routecodex_v3_sse::SseIncrementalDecoder,
    pending: VecDeque<Result<Vec<u8>, String>>,
    tool_calls: BTreeMap<u64, (String, String)>,
    terminal: bool,
    seen_done: bool,
    done: bool,
}

fn project_sse_stream(
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
) -> V3OpenAiChatClientStream {
    use futures_util::StreamExt;
    let state = V3OpenAiChatSseState {
        provider,
        decoder: routecodex_v3_sse::SseIncrementalDecoder::new(
            routecodex_v3_sse::SseTransportLimits::default(),
        ),
        pending: VecDeque::new(),
        tool_calls: BTreeMap::new(),
        terminal: false,
        seen_done: false,
        done: false,
    };
    Box::pin(futures_util::stream::unfold(
        state,
        |mut state| async move {
            loop {
                if let Some(item) = state.pending.pop_front() {
                    return Some((item, state));
                }
                if state.done {
                    return None;
                }
                if state.seen_done {
                    return None;
                }
                let Some(chunk) = state.provider.next().await else {
                    state.done = true;
                    if !state.terminal || !state.seen_done {
                        return Some((
                            Err(
                                "OpenAI Chat SSE ended without terminal finish_reason or [DONE]"
                                    .to_string(),
                            ),
                            state,
                        ));
                    }
                    return None;
                };
                let result = chunk
                    .map_err(|error| error.to_string())
                    .and_then(|chunk| {
                        let raw = routecodex_v3_sse::build_v3_sse_transport_in_01_raw_chunk(&chunk);
                        state.decoder.push(raw).map_err(|error| error.to_string())
                    })
                    .and_then(|frames| enqueue_sse_client_chunks(&mut state, frames));
                if let Err(error) = result {
                    state.done = true;
                    return Some((Err(error), state));
                }
            }
        },
    ))
}

fn enqueue_sse_client_chunks(
    state: &mut V3OpenAiChatSseState,
    frames: Vec<routecodex_v3_sse::SseTransportIn03ValidatedFrameStream>,
) -> Result<(), String> {
    for frame in frames {
        let mut data = None;
        for field in frame.frame().fields() {
            if let routecodex_v3_sse::SseField::Named { name, value } = field {
                if name == "data" {
                    data = Some(value.clone());
                }
            }
        }
        let Some(data) = data else { continue };
        if state.seen_done {
            return Err("OpenAI Chat SSE emitted a frame after [DONE]".into());
        }
        if data == "[DONE]" {
            if !state.terminal {
                return Err("OpenAI Chat SSE emitted [DONE] before terminal finish_reason".into());
            }
            state.seen_done = true;
            state.pending.push_back(Ok(b"data: [DONE]\n\n".to_vec()));
            continue;
        }
        let payload: Value = serde_json::from_str(&data).map_err(|error| error.to_string())?;
        characterize_v3_openai_chat_provider_raw_to_hub_response_semantic(
            payload.clone(),
            V3HubProviderWireProtocol::OpenAiChat,
            V3HubTransportIntent::Sse,
        )
        .map_err(|error| error.to_string())?;
        let was_terminal = state.terminal;
        observe_openai_chat_sse_governance(&payload, &mut state.tool_calls, &mut state.terminal)?;
        if !was_terminal && state.terminal {
            let output = state
                .tool_calls
                .values()
                .map(
                    |(call_id, name)| json!({"type":"function_call","call_id":call_id,"name":name}),
                )
                .collect::<Vec<_>>();
            let status = if output.is_empty() {
                "completed"
            } else {
                "requires_action"
            };
            let mut trace = Vec::new();
            project_sse_response(json!({"status":status,"output":output}), &mut trace)
                .map_err(|error| error.to_string())?;
        }
        state
            .pending
            .push_back(Ok(format!("data: {payload}\n\n").into_bytes()));
    }
    Ok(())
}

fn project_sse_response(
    canonical_response: Value,
    trace: &mut Vec<&'static str>,
) -> Result<(), V3OpenAiChatRelayRuntimeError> {
    let resp01 = build_v3_provider_resp_inbound_01_raw(
        canonical_response,
        V3HubEntryProtocol::OpenAiChat,
        V3HubProviderWireProtocol::OpenAiChat,
        V3HubContinuationOwnership::New,
        V3HubExecutionMode::Relay,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Sse,
    );
    trace.push("V3ProviderRespInbound01Raw");
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks.normalize(resp01)?;
    trace.push("ProviderRespCompat02ProviderCompat");
    trace.push("V3HubRespInbound02Normalized");
    let resp03 = hooks.govern(resp02, &V3HubRelayResponseHookProfile::empty())?;
    trace.push("V3HubRespChatProcess03Governed");
    let resp04 = hooks.commit(resp03)?;
    trace.push("V3HubRespContinuation04Committed");
    let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04);
    trace.push("V3HubRespOutbound05ClientSemantic");
    let _resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);
    trace.push("V3ServerRespOutbound06ClientFrame");
    Ok(())
}

fn build_openai_chat_json_governance_response(
    payload: &Value,
) -> Result<Value, V3OpenAiChatRelayRuntimeError> {
    let choices = payload
        .get("choices")
        .and_then(Value::as_array)
        .ok_or(V3OpenAiChatCodecError::ChoicesNotArray)?;
    let mut output = Vec::new();
    for choice in choices {
        for call in choice
            .pointer("/message/tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            output.push(json!({
                "type": "function_call",
                "call_id": call.get("id").cloned().unwrap_or(Value::Null),
                "name": call.pointer("/function/name").cloned().unwrap_or(Value::Null)
            }));
        }
    }
    let status = if output.is_empty() {
        "completed"
    } else {
        "requires_action"
    };
    Ok(json!({"status":status,"output":output}))
}

fn observe_openai_chat_sse_governance(
    payload: &Value,
    tool_calls: &mut BTreeMap<u64, (String, String)>,
    terminal: &mut bool,
) -> Result<(), String> {
    let choices = payload
        .get("choices")
        .and_then(Value::as_array)
        .ok_or_else(|| "OpenAI Chat SSE choices are missing".to_string())?;
    for choice in choices {
        if choice
            .get("finish_reason")
            .is_some_and(|value| !value.is_null())
        {
            *terminal = true;
        }
        for call in choice
            .pointer("/delta/tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let index = call.get("index").and_then(Value::as_u64).unwrap_or(0);
            let entry = tool_calls
                .entry(index)
                .or_insert_with(|| (String::new(), String::new()));
            if let Some(call_id) = call.get("id").and_then(Value::as_str) {
                entry.0 = call_id.to_string();
            }
            if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                entry.1 = name.to_string();
            }
        }
    }
    if tool_calls
        .values()
        .any(|(call_id, name)| call_id.is_empty() || name.is_empty())
        && *terminal
    {
        return Err("OpenAI Chat SSE terminal tool call is missing id or name".to_string());
    }
    Ok(())
}

fn server_routing_group<'a>(
    manifest: &'a V3Config05ManifestPublished,
    server_id: &str,
) -> Result<&'a str, V3OpenAiChatRelayRuntimeError> {
    manifest
        .servers
        .get(server_id)
        .map(|server| server.routing_group.as_str())
        .ok_or_else(|| V3OpenAiChatRelayRuntimeError::Target(format!("server {server_id} missing")))
}

fn resolve_target(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    body: &Value,
) -> Result<routecodex_v3_target::V3Target10ConcreteProviderSelected, V3OpenAiChatRelayRuntimeError>
{
    let facts = crate::build_v3_router_request_facts_for_entry(body, "openai_chat");
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(manifest, server_id, "/v1/chat/completions", facts)
        .map_err(|error| V3OpenAiChatRelayRuntimeError::Target(format!("{error:?}")))?;
    let plan = router
        .resolve_route_pool_plan(manifest, classified)
        .map_err(|error| V3OpenAiChatRelayRuntimeError::Target(format!("{error:?}")))?;
    let hit = router
        .hit_opaque_target_plan_once(plan, 0)
        .map_err(|error| V3OpenAiChatRelayRuntimeError::Target(format!("{error:?}")))?;
    let target = V3TargetInterpreter::default();
    let kind = target.classify_kind(hit);
    let expanded = target
        .expand_candidates(manifest, kind, 0)
        .map_err(|error| V3OpenAiChatRelayRuntimeError::Target(error.to_string()))?;
    target
        .select_available(
            expanded,
            &routecodex_v3_provider_responses::V3ProviderAvailabilityRegistry::from_manifest(
                manifest,
            ),
            0,
        )
        .map_err(|error| V3OpenAiChatRelayRuntimeError::Target(format!("{error:?}")))
}

fn provider_target(
    manifest: &V3Config05ManifestPublished,
    selected: &routecodex_v3_target::V3TargetCandidate,
) -> Result<V3ResponsesProviderTarget, V3OpenAiChatRelayRuntimeError> {
    let provider = manifest
        .providers
        .get(&selected.provider_id)
        .ok_or_else(|| {
            V3OpenAiChatRelayRuntimeError::Target("selected provider missing".to_string())
        })?;
    let auth = provider
        .auth
        .entries
        .iter()
        .find(|entry| entry.alias == selected.auth_alias)
        .ok_or_else(|| {
            V3OpenAiChatRelayRuntimeError::Target("selected auth handle missing".to_string())
        })?;
    let secret = match (&auth.env, &auth.token_file) {
        (Some(env), None) => V3ProviderAuthSecretHandle::Environment(env.clone()),
        (None, Some(path)) => V3ProviderAuthSecretHandle::TokenFile(path.clone()),
        _ => {
            return Err(V3OpenAiChatRelayRuntimeError::Target(
                "selected auth handle is invalid".to_string(),
            ))
        }
    };
    Ok(V3ResponsesProviderTarget {
        provider_id: selected.provider_id.clone(),
        provider_type: selected.provider_type.clone(),
        base_url: selected.base_url.clone(),
        canonical_model_id: selected.model_id.clone(),
        wire_model: selected.wire_model.clone(),
        auth: V3ProviderAuthHandle {
            alias: selected.auth_alias.clone(),
            secret,
        },
        responses_transport: selected.responses_transport,
        websocket_v2_url: selected.websocket_v2_url.clone(),
    })
}

fn provider_error_output(
    status: u16,
    body: &[u8],
    provider_id: &str,
    trace: Vec<&'static str>,
) -> V3OpenAiChatRelayRuntimeOutput {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderReqOutbound09TransportRequest",
        format!("provider_http_{status}"),
        format!("provider returned HTTP {status}"),
    );
    let body = serde_json::from_slice::<Value>(body)
        .unwrap_or_else(|_| json!({"error":{"type":"provider_error","message":"provider error"}}));
    error_output(source, status, body, provider_id, trace)
}

fn provider_runtime_error_output(
    error: V3ProviderError,
    provider_id: &str,
    trace: Vec<&'static str>,
) -> V3OpenAiChatRelayRuntimeOutput {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderReqOutbound09TransportRequest",
        "provider_transport_error",
        error.to_string(),
    );
    error_output(
        source,
        502,
        json!({"error":{"type":"provider_error","message":error.to_string()}}),
        provider_id,
        trace,
    )
}

fn error_output(
    source: routecodex_v3_error::V3Error01SourceRaised,
    status: u16,
    client_response: Value,
    provider_id: &str,
    mut trace: Vec<&'static str>,
) -> V3OpenAiChatRelayRuntimeOutput {
    let classified = build_v3_error_02_classified_from_v3_error_01(source);
    let local = build_v3_error_03_target_local_action_from_v3_error_02(
        classified,
        V3ErrorActionScope::ProviderInstance {
            provider_id: provider_id.to_string(),
        },
        0,
    );
    let exhausted = build_v3_error_04_target_exhaustion_decision_from_v3_error_03(local, 0);
    let decision = build_v3_error_05_execution_decision_from_v3_error_04(exhausted);
    let projected = build_v3_error_06_client_projected_from_v3_error_05(decision);
    trace.extend(V3_ERROR_CHAIN_NODE_IDS);
    V3OpenAiChatRelayRuntimeOutput {
        status,
        client_body: V3OpenAiChatRelayClientBody::Json(client_response),
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
    }
}
