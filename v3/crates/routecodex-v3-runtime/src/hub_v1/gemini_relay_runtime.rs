use super::*;
use crate::provider_action_gate::V3ProviderActionPermit;
use crate::provider_failure_runtime_policy::{
    v3_relay_provider_policy_now_epoch_ms, V3ProviderFailureRuntimeHealth,
    V3RelayProviderFailureRetryPolicy,
};
use routecodex_v3_config::{V3Config05ManifestPublished, V3WebSearchExecutionMode};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3ErrorSourceKind, V3ProviderFailureSessionScope,
};
use routecodex_v3_provider_responses::{
    build_v3_transport_13_responses_http_request_from_parts_with_timeout,
    ReqwestResponsesTransport, ResponsesTransport, V3ProviderError, V3ProviderRequestHeader,
    V3ProviderSseStream, V3ResponsesProviderTarget, V3ResponsesStreamIntent,
    V3Transport13ResponsesHttpRequest,
};
use serde_json::Value;
use std::collections::VecDeque;
use std::pin::Pin;
use std::time::Duration;
use std::sync::Arc;

pub type V3GeminiRelayClientStream =
    Pin<Box<dyn futures_util::Stream<Item = Result<Vec<u8>, String>> + Send>>;

pub enum V3GeminiRelayClientBody {
    Json(Value),
    Sse(V3GeminiRelayClientStream),
}

impl V3GeminiRelayClientBody {
    pub fn is_sse(&self) -> bool {
        matches!(self, Self::Sse(_))
    }
}

impl From<String> for V3GeminiRelayRuntimeError {
    fn from(value: String) -> Self {
        Self::Target(value)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3GeminiRelayRuntimeInput {
    pub server_id: String,
    pub failure_session_scope: V3ProviderFailureSessionScope,
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
    #[error("V3 Gemini requested direct provider model not found: {0}")]
    ModelNotFound(String),
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

pub async fn execute_v3_gemini_relay_runtime_with_default_transport_provider_health(
    manifest: &V3Config05ManifestPublished,
    input: V3GeminiRelayRuntimeInput,
    provider_health: V3ProviderFailureRuntimeHealth,
) -> Result<V3GeminiRelayRuntimeOutput, V3GeminiRelayRuntimeError> {
    execute_v3_gemini_relay_runtime_with_provider_health(
        manifest,
        input,
        &ReqwestResponsesTransport::default(),
        provider_health,
    )
    .await
}

pub async fn execute_v3_gemini_relay_runtime<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3GeminiRelayRuntimeInput,
    transport: &T,
) -> Result<V3GeminiRelayRuntimeOutput, V3GeminiRelayRuntimeError> {
    execute_v3_gemini_relay_runtime_with_provider_health(
        manifest,
        input,
        transport,
        V3ProviderFailureRuntimeHealth::from_manifest(manifest),
    )
    .await
}

pub async fn execute_v3_gemini_relay_runtime_with_provider_health<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3GeminiRelayRuntimeInput,
    transport: &T,
    provider_health: V3ProviderFailureRuntimeHealth,
) -> Result<V3GeminiRelayRuntimeOutput, V3GeminiRelayRuntimeError> {
    execute_v3_gemini_relay_runtime_inner(
        manifest,
        input,
        transport,
        provider_health,
        V3RelayProviderFailureRetryPolicy::default(),
    )
    .await
}

async fn execute_v3_gemini_relay_runtime_inner<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3GeminiRelayRuntimeInput,
    transport: &T,
    provider_health: V3ProviderFailureRuntimeHealth,
    retry_policy: V3RelayProviderFailureRetryPolicy,
) -> Result<V3GeminiRelayRuntimeOutput, V3GeminiRelayRuntimeError> {
    // 统一 relay 主循环骨架（大骨架）：生命周期与编排在 execute_v3_relay_runtime_core，
    // 协议差异收敛在 V3GeminiRelayCodec。
    let routing_group = server_routing_group(manifest, &input.server_id)
        .map_err(|error| V3GeminiRelayRuntimeError::Target(error.to_string()))?
        .to_string();
    let continuation_lookup = V3HubContinuationLookup::new(
        None,
        V3HubContinuationScope::new(
            V3HubEntryProtocol::Gemini,
            &input.server_id,
            routing_group,
            &input.request_id,
        ),
    );
    execute_v3_relay_runtime_core::<V3GeminiRelayCodec, T>(
        manifest,
        &input.server_id,
        input.failure_session_scope.clone(),
        &input.request_id,
        &input.endpoint_path,
        input.payload,
        transport,
        provider_health,
        retry_policy,
        continuation_lookup,
        Vec::new(),
    )
    .await
    .map_err(|error| match error {
        V3RelayCoreError::ModelNotFound(message) => {
            V3GeminiRelayRuntimeError::ModelNotFound(message)
        }
        V3RelayCoreError::EndpointPath(message) => {
            V3GeminiRelayRuntimeError::EndpointPath(message)
        }
        // 直接取内部消息，不叠加 V3RelayCoreError 的 Display 前缀（与原实现消息一致）。
        V3RelayCoreError::Target(message)
        | V3RelayCoreError::StaticRegistry(message)
        | V3RelayCoreError::WebSearchIntercepted(message) => {
            V3GeminiRelayRuntimeError::Target(message)
        }
    })
}

/// Gemini relay 协议 codec：协议差异的唯一收敛面（骨架驱动）。
pub struct V3GeminiRelayCodec;

impl V3RelayProtocolCodec for V3GeminiRelayCodec {
    type Output = V3GeminiRelayRuntimeOutput;
    type SseStream = V3GeminiRelayClientStream;
    type SseOutcome = V3GeminiSseProviderOutcome;

    const ENTRY_PROTOCOL: V3HubEntryProtocol = V3HubEntryProtocol::Gemini;
    const ENTRY_KIND: &'static str = "gemini";
    const EXPECTED_PROVIDER_TYPE: Option<&'static str> = Some("Gemini");

    fn wire_protocol(
        _selected: &routecodex_v3_target::V3TargetCandidate,
    ) -> Result<V3HubProviderWireProtocol, V3RelayCoreError> {
        Ok(V3HubProviderWireProtocol::Gemini)
    }

    fn request_hook_profile(
        _manifest: &V3Config05ManifestPublished,
        _payload: &Value,
    ) -> Result<V3HubServertoolRequestProfile, V3RelayCoreError> {
        Ok(V3HubServertoolRequestProfile::disabled())
    }

    fn provider_http_failure(
        status: u16,
        body: &[u8],
        provider_id: &str,
    ) -> V3RelayProviderFailure {
        crate::hub_v1::relay_runtime_shared::provider_http_failure(status, body, provider_id)
    }

    fn model_from_endpoint_path(endpoint_path: &str) -> Result<String, V3RelayCoreError> {
        gemini_model_from_endpoint_path(endpoint_path)
            .map_err(|error| V3RelayCoreError::EndpointPath(error.to_string()))
    }

    fn validate_client_payload(payload: &Value) -> Result<(), V3RelayCoreError> {
        validate_v3_gemini_client_input_payload(payload, V3HubEntryProtocol::Gemini)
            .map_err(|error| V3RelayCoreError::Target(error.to_string()))
    }

    fn routing_payload(
        standardized: &std::sync::Arc<Value>,
        requested_model: &str,
    ) -> Result<std::sync::Arc<Value>, V3RelayCoreError> {
        Ok(gemini_routing_payload(standardized, requested_model))
    }

    fn build_transport_request(
        request_id: &str,
        target: V3ResponsesProviderTarget,
        transport_intent: V3HubTransportIntent,
        body: Value,
        _provider_header_overrides: Vec<V3ProviderRequestHeader>,
    ) -> Result<V3Transport13ResponsesHttpRequest, V3RelayCoreError> {
        build_v3_gemini_transport_09(request_id, target, transport_intent, body)
            .map_err(|error| V3RelayCoreError::Target(error.to_string()))
    }

    fn project_json_response(
        provider_value: Value,
        _provider_wire_protocol: V3HubProviderWireProtocol,
        _chat_request: &Value,
        transport_intent: V3HubTransportIntent,
        trace: &mut Vec<&'static str>,
        compatibility_profile: Option<&str>,
        _web_search_execution_mode: V3WebSearchExecutionMode,
        _web_search_state: Option<&V3WebSearchCenterState>,
        retain_response_cipher: bool,
    ) -> Result<Value, V3RelayCoreError> {
        project_json_response(
            provider_value,
            transport_intent,
            trace,
            compatibility_profile,
            retain_response_cipher,
        )
        .map_err(|error| V3RelayCoreError::Target(error.to_string()))
    }

    fn build_sse_outcome(
        provider_health: &V3ProviderFailureRuntimeHealth,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: String,
        auth_alias: String,
        model_id: String,
        recorded: bool,
        permit: Option<V3ProviderActionPermit>,
    ) -> V3GeminiSseProviderOutcome {
        V3GeminiSseProviderOutcome {
            provider_health: provider_health.clone(),
            failure_session_scope: failure_session_scope.clone(),
            provider_id,
            auth_alias,
            model_id,
            recorded,
            _provider_action_permit: permit,
        }
    }

    fn project_sse(
        provider: V3ProviderSseStream,
        _provider_wire_protocol: V3HubProviderWireProtocol,
        compatibility_profile: Option<String>,
        _web_search_execution_mode: V3WebSearchExecutionMode,
        _web_search_state: Option<V3WebSearchCenterState>,
        _retain_response_cipher: bool,
        outcome: V3GeminiSseProviderOutcome,
    ) -> Result<V3GeminiRelayClientStream, V3RelayCoreError> {
        Ok(project_sse_stream(provider, compatibility_profile, _retain_response_cipher, outcome))
    }

    fn assemble_json_output(
        client_response: Value,
        trace: Vec<&'static str>,
    ) -> V3GeminiRelayRuntimeOutput {
        V3GeminiRelayRuntimeOutput {
            status: 200,
            client_body: V3GeminiRelayClientBody::Json(client_response),
            node_trace: trace,
            error_chain: None,
        }
    }

    fn assemble_sse_output(
        sse: V3GeminiRelayClientStream,
        trace: Vec<&'static str>,
    ) -> V3GeminiRelayRuntimeOutput {
        V3GeminiRelayRuntimeOutput {
            status: 200,
            client_body: V3GeminiRelayClientBody::Sse(sse),
            node_trace: trace,
            error_chain: None,
        }
    }

    fn assemble_failure_output(
        failure: V3RelayProviderFailure,
        trace: Vec<&'static str>,
    ) -> V3GeminiRelayRuntimeOutput {
        provider_failure_output(failure, trace)
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
    let endpoint = match stream_intent {
        V3ResponsesStreamIntent::Json => "generateContent",
        V3ResponsesStreamIntent::Sse => "streamGenerateContent",
    };
    let url_text = format!(
        "{}/models/{}:{}{}",
        target.base_url.trim_end_matches('/'),
        target.wire_model,
        endpoint,
        if stream_intent == V3ResponsesStreamIntent::Sse {
            "?alt=sse"
        } else {
            ""
        }
    );
    build_v3_transport_13_responses_http_request_from_parts_with_timeout(
        request_id,
        target.provider_id,
        url_text,
        target.auth,
        stream_intent,
        body,
        Vec::new(),
        Some(Duration::from_millis(target.request_timeout_ms)),
    )
    .map_err(|error| V3GeminiRelayRuntimeError::Target(error.to_string()))
}

pub fn project_v3_gemini_relay_runtime_failure(
    error: V3GeminiRelayRuntimeError,
) -> V3GeminiRelayRuntimeOutput {
    let display = error.to_string();
    let source = match error {
        V3GeminiRelayRuntimeError::ModelNotFound(message) => build_v3_error_01_source_raised(
            V3ErrorSourceKind::ModelNotFound,
            "V3Target10ConcreteProviderSelected",
            "direct_model_not_found",
            message,
        ),
        error => build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3HubRuntime",
            "gemini_relay_runtime_error",
            error.to_string(),
        ),
    };
    let (projected, trace) = error_output(source, 500, "none", Vec::new());
    V3GeminiRelayRuntimeOutput {
        status: projected.status,
        client_body: V3GeminiRelayClientBody::Json(projected.body),
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
    }
}

fn project_json_response(
    provider_value: Value,
    transport_intent: V3HubTransportIntent,
    trace: &mut Vec<&'static str>,
    compatibility_profile: Option<&str>,
    retain_response_cipher: bool,
) -> Result<Value, V3GeminiRelayRuntimeError> {
    validate_v3_gemini_provider_response_payload(
        &provider_value,
        V3HubProviderWireProtocol::Gemini,
    )?;
    let resp01 = build_v3_provider_resp_inbound_01_raw_with_compat_profile(
        provider_value,
        V3ProviderRespInbound01RawContext::new(
            V3HubEntryProtocol::Gemini,
            V3HubProviderWireProtocol::Gemini,
            V3HubContinuationOwnership::New,
            V3HubExecutionMode::Relay,
            V3HubInvocationSource::Client,
            transport_intent,
        )
        .with_compatibility_profile(compatibility_profile),
    );
    trace.push("V3ProviderRespInbound01Raw");
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks.normalize(resp01)?;
    trace.push("ProviderRespCompat02ProviderCompat");
    trace.push("V3HubRespInbound02Normalized");
    let resp03 = hooks.govern(
        resp02,
        &V3HubRelayResponseHookProfile::empty()
            .with_retain_response_cipher(retain_response_cipher),
    )?;
    trace.push("V3HubRespChatProcess03Governed");
    let resp04 = hooks.commit(resp03)?;
    trace.push("V3HubRespContinuation04Committed");
    let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04.into_data());
    trace.push("V3HubRespOutbound05ClientSemantic");
    let client = resp05.client_payload().clone();
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
    compatibility_profile: Option<String>,
    /// 请求侧 VR 路由决策算好的"保留响应密文"标记，SSE 帧级 Resp03 消费。
    retain_response_cipher: bool,
    provider_outcome: V3GeminiSseProviderOutcome,
}

pub(crate) struct V3GeminiSseProviderOutcome {
    provider_health: V3ProviderFailureRuntimeHealth,
    failure_session_scope: V3ProviderFailureSessionScope,
    provider_id: String,
    auth_alias: String,
    model_id: String,
    recorded: bool,
    _provider_action_permit: Option<V3ProviderActionPermit>,
}

impl V3GeminiSseProviderOutcome {
    async fn record_failure(&mut self, reason: &str) -> Result<(), String> {
        if self.recorded {
            return Ok(());
        }
        drop(self._provider_action_permit.take());
        self.provider_health
            .record_post_commit_provider_stream_failure(
                &self.failure_session_scope,
                &self.provider_id,
                Some(&self.auth_alias),
                Some(&self.model_id),
                "provider_response_protocol",
                reason,
            )?;
        self.recorded = true;
        Ok(())
    }

    fn record_success(&mut self) -> Result<(), String> {
        if self.recorded {
            return Ok(());
        }
        self.provider_health
            .record_provider_success_in_failure_scope(
                &self.failure_session_scope,
                &self.provider_id,
                Some(&self.auth_alias),
                Some(&self.model_id),
                v3_relay_provider_policy_now_epoch_ms()?,
            )?;
        self.recorded = true;
        Ok(())
    }
}

fn project_sse_stream(
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    compatibility_profile: Option<String>,
    retain_response_cipher: bool,
    provider_outcome: V3GeminiSseProviderOutcome,
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
        compatibility_profile,
        retain_response_cipher,
        provider_outcome,
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
                    let decoder = std::mem::replace(
                        &mut state.decoder,
                        routecodex_v3_sse::SseIncrementalDecoder::new(
                            routecodex_v3_sse::SseTransportLimits::default(),
                        ),
                    );
                    if let Err(error) = decoder.finish() {
                        let error = error.to_string();
                        let result = state
                            .provider_outcome
                            .record_failure(&error)
                            .await
                            .map(|()| error)
                            .and_then(Err);
                        return Some((result, state));
                    }
                    if !state.terminal {
                        let error = "Gemini SSE ended without terminal finishReason".to_string();
                        let result = state
                            .provider_outcome
                            .record_failure(&error)
                            .await
                            .map(|()| error)
                            .and_then(Err);
                        return Some((result, state));
                    }
                    if let Err(error) = state.provider_outcome.record_success() {
                        return Some((Err(error), state));
                    }
                    return None;
                };
                let result = match chunk {
                    Err(error @ V3ProviderError::ClientDisconnect { .. }) => {
                        state.done = true;
                        return Some((Err(error.to_string()), state));
                    }
                    Err(error) => Err(error.to_string()),
                    Ok(chunk) => {
                        let raw = routecodex_v3_sse::build_v3_sse_transport_in_01_raw_chunk(&chunk);
                        state.decoder.push(raw).map_err(|error| error.to_string())
                    }
                }
                .and_then(|frames| enqueue_sse_client_chunks(&mut state, frames));
                if let Err(error) = result {
                    state.done = true;
                    let result = state
                        .provider_outcome
                        .record_failure(&error)
                        .await
                        .map(|()| error)
                        .and_then(Err);
                    return Some((result, state));
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
        if state.terminal {
            return Err("Gemini SSE emitted a frame after terminal finishReason".into());
        }
        let mut data = None;
        for field in frame.frame().fields() {
            if let routecodex_v3_sse::SseField::Named { name, value } = field {
                if name == "data" {
                    data = Some(value.clone());
                }
            }
        }
        let Some(data) = data else { continue };
        let payload: Value = serde_json::from_str(&data).map_err(|error| error.to_string())?;
        let client_payload =
            project_sse_event_payload(payload, state.compatibility_profile.as_deref(), state.retain_response_cipher)?;
        state.terminal = gemini_payload_has_terminal_finish_reason(&client_payload)?;
        state
            .pending
            .push_back(Ok(format!("data: {client_payload}\n\n").into_bytes()));
    }
    Ok(())
}

fn project_sse_event_payload(
    payload: Value,
    compatibility_profile: Option<&str>,
    retain_response_cipher: bool,
) -> Result<Value, String> {
    let mut trace = Vec::new();
    project_json_response(
        payload,
        V3HubTransportIntent::Sse,
        &mut trace,
        compatibility_profile,
        retain_response_cipher,
    )
    .map_err(|error| error.to_string())
}

fn gemini_payload_has_terminal_finish_reason(payload: &Value) -> Result<bool, String> {
    let terminal = payload
        .get("candidates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|candidate| candidate.get("finishReason"))
        .try_fold(false, |terminal, finish_reason| match finish_reason {
            Value::Null => Ok(terminal),
            Value::String(value) if !value.trim().is_empty() => Ok(true),
            _ => Err("Gemini SSE finishReason must be null or a non-empty string".to_string()),
        })?;
    Ok(terminal)
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

fn provider_failure_output(
    failure: V3RelayProviderFailure,
    mut trace: Vec<&'static str>,
) -> V3GeminiRelayRuntimeOutput {
    let projected = failure
        .terminal_projection
        .expect("terminal Gemini provider failure must carry typed Error06 projection");
    trace.push("V3Error06ClientProjected");
    V3GeminiRelayRuntimeOutput {
        status: projected.status,
        client_body: V3GeminiRelayClientBody::Json(projected.body),
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

fn gemini_routing_payload(
    body: &std::sync::Arc<Value>,
    requested_model: &str,
) -> std::sync::Arc<Value> {
    let mut routing_body = std::sync::Arc::clone(body);
    if let Some(object) = Arc::make_mut(&mut routing_body).as_object_mut() {
        object.insert(
            "model".to_string(),
            Value::String(requested_model.to_string()),
        );
    }
    routing_body
}
