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
    build_v3_transport_13_responses_http_request_from_parts, ReqwestResponsesTransport,
    ResponsesTransport, V3ProviderAuthHandle, V3ProviderAuthSecretHandle, V3ProviderError,
    V3ProviderResponseBody, V3ResponsesProviderTarget, V3ResponsesStreamIntent,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_target::V3TargetInterpreter;
use routecodex_v3_virtual_router::V3VirtualRouter;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::pin::Pin;

pub type V3GeminiRelayClientStream =
    Pin<Box<dyn futures_util::Stream<Item = Result<Vec<u8>, String>> + Send>>;

pub enum V3GeminiRelayClientBody {
    Json(Value),
    Sse(V3GeminiRelayClientStream),
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3GeminiRelayRuntimeInput {
    pub server_id: String,
    pub request_id: String,
    pub endpoint_path: String,
    pub payload: Value,
}

pub struct V3GeminiRelayRuntimeOutput {
    pub status: u16,
    pub client_body: V3GeminiRelayClientBody,
    pub node_trace: Vec<&'static str>,
    pub error_chain: Option<Vec<&'static str>>,
}

impl std::fmt::Debug for V3GeminiRelayRuntimeOutput {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("V3GeminiRelayRuntimeOutput")
            .field("status", &self.status)
            .field(
                "client_body",
                &match self.client_body {
                    V3GeminiRelayClientBody::Json(_) => "json",
                    V3GeminiRelayClientBody::Sse(_) => "sse",
                },
            )
            .field("node_trace", &self.node_trace)
            .field("error_chain", &self.error_chain)
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum V3GeminiRelayRuntimeError {
    #[error(transparent)]
    Request(#[from] V3HubRelayRequestError),
    #[error(transparent)]
    Response(#[from] V3HubRelayResponseError),
    #[error(transparent)]
    Codec(#[from] V3GeminiCodecError),
    #[error("V3 Hub static hook registry failed: {0}")]
    StaticRegistry(String),
    #[error("V3 Gemini target resolution failed: {0}")]
    Target(String),
    #[error("V3 Gemini provider contract failed: {0}")]
    Provider(#[from] V3ProviderError),
    #[error("V3 Gemini provider compat failed: {0}")]
    ProviderCompat(#[from] V3ProviderCompatError),
    #[error("V3 Gemini JSON provider body is malformed: {0}")]
    ProviderJson(#[from] serde_json::Error),
    #[error("V3 Gemini structured SSE projection failed: {0}")]
    StructuredSse(String),
    #[error("V3 Gemini endpoint path is malformed: {0}")]
    EndpointPath(String),
}

pub async fn execute_v3_gemini_relay_runtime_with_default_transport(
    manifest: &V3Config05ManifestPublished,
    input: V3GeminiRelayRuntimeInput,
) -> Result<V3GeminiRelayRuntimeOutput, V3GeminiRelayRuntimeError> {
    execute_v3_gemini_relay_runtime(manifest, input, &ReqwestResponsesTransport::default()).await
}

pub async fn execute_v3_gemini_relay_runtime<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3GeminiRelayRuntimeInput,
    transport: &T,
) -> Result<V3GeminiRelayRuntimeOutput, V3GeminiRelayRuntimeError> {
    compile_v3_hub_v1_static_registry()
        .map_err(|error| V3GeminiRelayRuntimeError::StaticRegistry(error.to_string()))?;
    let mut trace = Vec::with_capacity(17);
    let transport_intent = if input.payload.get("stream").and_then(Value::as_bool) == Some(true) {
        V3HubTransportIntent::Sse
    } else {
        V3HubTransportIntent::Json
    };
    let requested_model = gemini_model_from_endpoint_path(&input.endpoint_path)?;
    let req01 = build_v3_hub_req_inbound_01_client_raw(
        input.payload,
        V3HubEntryProtocol::Gemini,
        V3HubInvocationSource::Client,
        transport_intent,
    );
    trace.push("V3HubReqInbound01ClientRaw");
    validate_v3_gemini_client_input_payload(&req01.payload.0, V3HubEntryProtocol::Gemini)?;
    let req02 = build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(req01);
    trace.push("V3HubReqInbound02Normalized");
    let lookup = V3HubContinuationLookup::new(
        None,
        V3HubContinuationScope::new(
            V3HubEntryProtocol::Gemini,
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
    let routing_payload = gemini_routing_payload(
        &req05.previous.previous.previous.previous.payload.0,
        &requested_model,
    );
    let selected = resolve_target(
        manifest,
        &input.server_id,
        &input.endpoint_path,
        &routing_payload,
    )?;
    let selected_target_provider_id = selected.candidate.provider_id.clone();
    let selected_target_compatibility_profile = selected.candidate.compatibility_profile.clone();
    let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
        req05,
        V3HubTargetResolution::Routed,
        selected.candidate,
    );
    trace.push("V3HubReqTarget06Resolved");
    let req07 = build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
        req06,
        V3HubProviderWireProtocol::Gemini,
    );
    trace.push("V3HubReqOutbound07ProviderSemantic");
    let target = provider_target(manifest, req07.selected_target())?;
    let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)?;
    trace.push("ProviderReqCompat06ProviderCompat");
    let req08 = build_v3_provider_req_outbound_08_from_provider_req_compat_06(req_compat);
    let req09 = build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(req08);
    let provider_semantic = req09.into_provider_semantic_payload();
    trace.push("V3ProviderReqOutbound08WirePayload");
    let transport_request = build_v3_gemini_transport_09(
        &input.request_id,
        target,
        transport_intent,
        provider_semantic,
    )?;
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
            let client_response = project_json_response(
                provider_value,
                transport_intent,
                &mut trace,
                selected_target_compatibility_profile.as_deref(),
            )?;
            Ok(V3GeminiRelayRuntimeOutput {
                status: 200,
                client_body: V3GeminiRelayClientBody::Json(client_response),
                node_trace: trace,
                error_chain: None,
            })
        }
        V3ProviderResponseBody::Sse(stream) => Ok(V3GeminiRelayRuntimeOutput {
            status: 200,
            client_body: V3GeminiRelayClientBody::Sse(project_sse_stream(stream)),
            node_trace: trace,
            error_chain: None,
        }),
    }
}

fn build_v3_gemini_transport_09(
    request_id: &str,
    target: V3ResponsesProviderTarget,
    transport_intent: V3HubTransportIntent,
    body: Value,
) -> Result<V3Transport13ResponsesHttpRequest, V3GeminiRelayRuntimeError> {
    let stream_intent = match transport_intent {
        V3HubTransportIntent::Json => V3ResponsesStreamIntent::Json,
        V3HubTransportIntent::Sse => V3ResponsesStreamIntent::Sse,
    };
    let url_text = format!(
        "{}/models/{}/generateContent",
        target.base_url.trim_end_matches('/'),
        target.wire_model
    );
    build_v3_transport_13_responses_http_request_from_parts(
        request_id,
        target.provider_id,
        url_text,
        target.auth,
        stream_intent,
        body,
    )
    .map_err(|error| V3GeminiRelayRuntimeError::Target(error.to_string()))
}

pub fn project_v3_gemini_relay_runtime_failure(
    error: V3GeminiRelayRuntimeError,
) -> V3GeminiRelayRuntimeOutput {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::RuntimeFailure,
        "V3HubRuntime",
        "gemini_relay_runtime_error",
        error.to_string(),
    );
    error_output(
        source,
        500,
        json!({"error":{"code":"runtime_error","message":error.to_string()}}),
        "none",
        Vec::new(),
    )
}

fn project_json_response(
    provider_value: Value,
    transport_intent: V3HubTransportIntent,
    trace: &mut Vec<&'static str>,
    compatibility_profile: Option<&str>,
) -> Result<Value, V3GeminiRelayRuntimeError> {
    validate_v3_gemini_provider_response_payload(
        &provider_value,
        V3HubProviderWireProtocol::Gemini,
    )?;
    let resp01 = build_v3_provider_resp_inbound_01_raw_with_compat_profile(
        provider_value,
        V3HubEntryProtocol::Gemini,
        V3HubProviderWireProtocol::Gemini,
        V3HubContinuationOwnership::New,
        V3HubExecutionMode::Relay,
        V3HubInvocationSource::Client,
        transport_intent,
        compatibility_profile,
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
    let client = resp04.finalized_payload().clone();
    let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04);
    trace.push("V3HubRespOutbound05ClientSemantic");
    let _resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);
    trace.push("V3ServerRespOutbound06ClientFrame");
    Ok(client)
}

struct V3GeminiSseState {
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    decoder: routecodex_v3_sse::SseIncrementalDecoder,
    pending: VecDeque<Result<Vec<u8>, String>>,
    terminal: bool,
    done: bool,
}

fn project_sse_stream(
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
) -> V3GeminiRelayClientStream {
    use futures_util::StreamExt;
    let state = V3GeminiSseState {
        provider,
        decoder: routecodex_v3_sse::SseIncrementalDecoder::new(
            routecodex_v3_sse::SseTransportLimits::default(),
        ),
        pending: VecDeque::new(),
        terminal: false,
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
                let Some(chunk) = state.provider.next().await else {
                    state.done = true;
                    if !state.terminal {
                        return Some((
                            Err("Gemini SSE ended without terminal finishReason".to_string()),
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
    state: &mut V3GeminiSseState,
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
        if state.terminal {
            return Err("Gemini SSE emitted a frame after terminal finishReason".into());
        }
        let payload: Value = serde_json::from_str(&data).map_err(|error| error.to_string())?;
        validate_v3_gemini_provider_response_payload(&payload, V3HubProviderWireProtocol::Gemini)
            .map_err(|error| error.to_string())?;
        state.terminal = gemini_payload_has_terminal_finish_reason(&payload);
        state
            .pending
            .push_back(Ok(format!("data: {payload}\n\n").into_bytes()));
    }
    Ok(())
}

fn gemini_payload_has_terminal_finish_reason(payload: &Value) -> bool {
    payload
        .get("candidates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|candidate| {
            candidate
                .get("finishReason")
                .is_some_and(|value| !value.is_null())
        })
}

fn server_routing_group<'a>(
    manifest: &'a V3Config05ManifestPublished,
    server_id: &str,
) -> Result<&'a str, V3GeminiRelayRuntimeError> {
    manifest
        .servers
        .get(server_id)
        .map(|server| server.routing_group.as_str())
        .ok_or_else(|| V3GeminiRelayRuntimeError::Target(format!("server {server_id} missing")))
}

fn resolve_target(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    endpoint_path: &str,
    body: &Value,
) -> Result<routecodex_v3_target::V3Target10ConcreteProviderSelected, V3GeminiRelayRuntimeError> {
    let facts = crate::build_v3_router_request_facts_for_entry(body, "gemini");
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(manifest, server_id, endpoint_path, facts)
        .map_err(|error| V3GeminiRelayRuntimeError::Target(format!("{error:?}")))?;
    let plan = router
        .resolve_route_pool_plan(manifest, classified)
        .map_err(|error| V3GeminiRelayRuntimeError::Target(format!("{error:?}")))?;
    let hit = router
        .hit_opaque_target_plan_once(plan, 0)
        .map_err(|error| V3GeminiRelayRuntimeError::Target(format!("{error:?}")))?;
    let target = V3TargetInterpreter::default();
    let kind = target.classify_kind(hit);
    let expanded = target
        .expand_candidates(manifest, kind, 0)
        .map_err(|error| V3GeminiRelayRuntimeError::Target(error.to_string()))?;
    target
        .select_available(
            expanded,
            &routecodex_v3_provider_responses::V3ProviderAvailabilityRegistry::from_manifest(
                manifest,
            ),
            0,
        )
        .map_err(|error| V3GeminiRelayRuntimeError::Target(format!("{error:?}")))
}

fn provider_target(
    manifest: &V3Config05ManifestPublished,
    selected: &routecodex_v3_target::V3TargetCandidate,
) -> Result<V3ResponsesProviderTarget, V3GeminiRelayRuntimeError> {
    if selected.provider_type != "gemini" {
        return Err(V3GeminiRelayRuntimeError::Target(format!(
            "no compatible Gemini provider target: selected provider {} has protocol {}",
            selected.provider_id, selected.provider_type
        )));
    }
    let provider = manifest
        .providers
        .get(&selected.provider_id)
        .ok_or_else(|| {
            V3GeminiRelayRuntimeError::Target("selected provider missing".to_string())
        })?;
    let auth = provider
        .auth
        .entries
        .iter()
        .find(|entry| entry.alias == selected.auth_alias)
        .ok_or_else(|| {
            V3GeminiRelayRuntimeError::Target("selected auth handle missing".to_string())
        })?;
    let secret = match (&auth.env, &auth.token_file) {
        (Some(env), None) => V3ProviderAuthSecretHandle::Environment(env.clone()),
        (None, Some(path)) => V3ProviderAuthSecretHandle::TokenFile(path.clone()),
        _ => {
            return Err(V3GeminiRelayRuntimeError::Target(
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
) -> V3GeminiRelayRuntimeOutput {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderReqOutbound09TransportRequest",
        format!("provider_http_{status}"),
        format!("provider returned HTTP {status}"),
    );
    let body = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(error) => json!({
            "error": {
                "code": "provider_error_body_malformed",
                "message": format!("provider returned HTTP {status} with malformed JSON error body: {error}")
            }
        }),
    };
    error_output(source, status, body, provider_id, trace)
}

fn provider_runtime_error_output(
    error: V3ProviderError,
    provider_id: &str,
    trace: Vec<&'static str>,
) -> V3GeminiRelayRuntimeOutput {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderReqOutbound09TransportRequest",
        "provider_transport_error",
        error.to_string(),
    );
    error_output(
        source,
        502,
        json!({"error":{"code":"provider_error","message":error.to_string()}}),
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
) -> V3GeminiRelayRuntimeOutput {
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
    V3GeminiRelayRuntimeOutput {
        status,
        client_body: V3GeminiRelayClientBody::Json(client_response),
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
    }
}

fn gemini_model_from_endpoint_path(
    endpoint_path: &str,
) -> Result<String, V3GeminiRelayRuntimeError> {
    let model = endpoint_path
        .strip_prefix("/v1beta/models/")
        .and_then(|value| value.strip_suffix("/generateContent"))
        .filter(|value| !value.is_empty() && !value.contains('/'))
        .ok_or_else(|| V3GeminiRelayRuntimeError::EndpointPath(endpoint_path.to_string()))?;
    Ok(model.to_string())
}

fn gemini_routing_payload(body: &Value, requested_model: &str) -> Value {
    let mut routing_body = body.clone();
    if let Some(object) = routing_body.as_object_mut() {
        object.insert(
            "model".to_string(),
            Value::String(requested_model.to_string()),
        );
    }
    routing_body
}
