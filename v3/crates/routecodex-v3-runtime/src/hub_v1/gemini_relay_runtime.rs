use super::V3ProviderCompatErrorClassification;
use super::*;
use crate::nodes::{V3ClientBody, V3Resp15ClientPayload};
use crate::provider_action_gate::V3ProviderActionPermit;
use crate::provider_failure_runtime_policy::{
    V3ProviderFailureRuntimeHealth, V3RelayProviderFailureRetryPolicy,
};
use futures_util::StreamExt;
use routecodex_v3_config::{V3Config05ManifestPublished, V3WebSearchExecutionMode};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3ErrorSourceKind, V3ProviderFailureSessionScope,
};
use routecodex_v3_provider_responses::{
    build_v3_transport_13_responses_http_request_from_parts_with_timeout_and_concurrency,
    ReqwestResponsesTransport, ResponsesTransport, V3ProviderError, V3ProviderRequestHeader,
    V3ProviderSseStream, V3ResponsesProviderTarget, V3ResponsesStreamIntent,
    V3Transport13ResponsesHttpRequest,
};
use serde_json::Value;
use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

pub type V3GeminiRelayClientStream = V3RelayProjectedSseStream;
pub type V3GeminiRelayCommittedStream = V3RelayCommittedSseStream;

pub enum V3GeminiRelayClientBody {
    Json(Value),
    Sse(V3GeminiRelayCommittedStream),
}

impl V3GeminiRelayClientBody {
    pub fn is_sse(&self) -> bool {
        matches!(self, Self::Sse(_))
    }

    pub fn into_v3_client_body(self) -> V3ClientBody {
        match self {
            Self::Json(value) => V3ClientBody::Json(value),
            Self::Sse(stream) => V3ClientBody::CommittedSse(stream),
        }
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
    pub terminal_disposition: Option<routecodex_v3_error::V3ProviderTerminalDisposition>,
    pub client_body: V3GeminiRelayClientBody,
    pub node_trace: Vec<&'static str>,
    pub error_chain: Option<Vec<&'static str>>,
    pub observability: Option<V3RuntimeObservability>,
    pub provider_failure_attempts: Vec<V3RuntimeProviderFailureObservation>,
    pub diagnostic_source: Option<routecodex_v3_error::V3Error01SourceRaised>,
    pub diagnostic_cause: Option<routecodex_v3_error::V3Error01SourceRaised>,
    pub stream_observation: Option<V3RuntimeStreamObservation>,
    pub provider_snapshots: Option<V3RelayProviderSnapshots>,
}

impl V3GeminiRelayRuntimeOutput {
    pub fn into_v3_resp_15_client_payload(self) -> V3Resp15ClientPayload {
        let content_type = if self.client_body.is_sse() {
            "text/event-stream"
        } else {
            "application/json"
        };
        V3Resp15ClientPayload {
            status: self.status,
            headers: std::collections::BTreeMap::from([(
                "content-type".to_string(),
                content_type.to_string(),
            )]),
            body: self.client_body.into_v3_client_body(),
        }
    }
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
            .field("observability", &self.observability)
            .field("stream_observation", &self.stream_observation)
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
    #[error("V3 Gemini provider pool exhausted after {attempted_candidates:?}")]
    ProviderPoolExhausted { attempted_candidates: Vec<String> },
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

pub async fn execute_v3_gemini_relay_runtime_with_default_transport_provider_health_and_handoff(
    manifest: &V3Config05ManifestPublished,
    input: V3GeminiRelayRuntimeInput,
    provider_health: V3ProviderFailureRuntimeHealth,
    handoff: crate::V3ResponsesProtocolRelayHandoff,
) -> Result<V3GeminiRelayRuntimeOutput, V3GeminiRelayRuntimeError> {
    execute_v3_gemini_relay_runtime_inner(
        manifest,
        input,
        &ReqwestResponsesTransport::default(),
        provider_health,
        V3RelayProviderFailureRetryPolicy::from_manifest(manifest),
        Some(handoff),
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
        V3RelayProviderFailureRetryPolicy::from_manifest(manifest),
        None,
    )
    .await
}

async fn execute_v3_gemini_relay_runtime_inner<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3GeminiRelayRuntimeInput,
    transport: &T,
    provider_health: V3ProviderFailureRuntimeHealth,
    retry_policy: V3RelayProviderFailureRetryPolicy,
    mut initial_handoff: Option<crate::V3ResponsesProtocolRelayHandoff>,
) -> Result<V3GeminiRelayRuntimeOutput, V3GeminiRelayRuntimeError> {
    // 统一 relay 主循环骨架（大骨架）：生命周期与编排在 execute_v3_relay_runtime_core，
    // 协议差异收敛在 V3GeminiRelayCodec。
    let routing_group = server_routing_group(manifest, &input.server_id)
        .map_err(|error| V3GeminiRelayRuntimeError::Target(error.to_string()))?
        .to_string();
    let mut failure_events = initial_handoff
        .as_mut()
        .map(|handoff| std::mem::take(&mut handoff.provider_failure_events))
        .unwrap_or_default();
    execute_v3_relay_runtime_core::<V3GeminiRelayCodec, T>(
        manifest,
        &input.server_id,
        input.failure_session_scope.clone(),
        &input.request_id,
        &input.endpoint_path,
        V3HubExecutionMode::Relay,
        input.payload,
        transport,
        provider_health,
        retry_policy,
        Vec::new(),
        true,
        initial_handoff,
        &mut failure_events,
    )
    .await
    .map_err(|error| match error {
        V3RelayCoreError::EndpointPath(message) => V3GeminiRelayRuntimeError::EndpointPath(message),
        V3RelayCoreError::ResponseGovernance(error) => {
            V3GeminiRelayRuntimeError::Target(error.to_string())
        }
        V3RelayCoreError::ProviderPoolExhausted {
            attempted_candidates,
        } => V3GeminiRelayRuntimeError::ProviderPoolExhausted {
            attempted_candidates,
        },
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
    type SseOutcome = V3GeminiSseProviderOutcome;

    const ENTRY_PROTOCOL: V3HubEntryProtocol = V3HubEntryProtocol::Gemini;
    const ENTRY_KIND: &'static str = "gemini";
    const EXPECTED_PROVIDER_TYPE: Option<&'static str> = None;

    fn wire_protocol(
        selected: &routecodex_v3_target::V3TargetCandidate,
    ) -> Result<V3HubProviderWireProtocol, V3RelayCoreError> {
        super::provider_compat_shared::provider_wire_protocol_for_selected_candidate(selected)
            .map_err(V3RelayCoreError::Target)
    }

    fn request_hook_profile(
        manifest: &V3Config05ManifestPublished,
        server_id: &str,
        _payload: &Value,
    ) -> Result<V3HubServertoolRequestProfile, V3RelayCoreError> {
        let enabled = v3_tool_thinking_enabled_for_server(manifest, server_id);
        if enabled {
            Ok(
                V3HubServertoolRequestProfile::enabled(["servertool.request"])
                    .with_tool_thinking_enabled(true),
            )
        } else {
            Ok(V3HubServertoolRequestProfile::disabled())
        }
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

    fn project_json_response(
        request_id: &str,
        _session_id: &str,
        provider_value: Value,
        provider_wire_protocol: V3HubProviderWireProtocol,
        chat_request: &Value,
        transport_intent: V3HubTransportIntent,
        trace: &mut Vec<&'static str>,
        compatibility_profile: Option<&str>,
        _web_search_execution_mode: V3WebSearchExecutionMode,
        _web_search_state: Option<&V3WebSearchCenterState>,
        retain_response_cipher: bool,
        tool_thinking_enabled: bool,
        _expected_model_id: &str,
    ) -> Result<Value, V3RelayCoreError> {
        project_json_response_with_source(
            provider_value,
            Some(request_id),
            provider_wire_protocol,
            chat_request,
            transport_intent,
            trace,
            compatibility_profile,
            retain_response_cipher,
            tool_thinking_enabled,
            true,
        )
        .map_err(|error| match error {
            V3GeminiRelayRuntimeError::Response(error) => {
                V3RelayCoreError::ResponseGovernance(error)
            }
            other => V3RelayCoreError::Target(other.to_string()),
        })
    }

    fn build_sse_outcome(
        provider_health: &V3ProviderFailureRuntimeHealth,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: String,
        interface_id: String,
        auth_alias: String,
        model_id: String,
        recorded: bool,
        permit: Option<V3ProviderActionPermit>,
    ) -> V3GeminiSseProviderOutcome {
        V3GeminiSseProviderOutcome {
            response_control: V3RuntimeStreamObservation::default(),
            provider_health: provider_health.clone(),
            failure_session_scope: failure_session_scope.clone(),
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            recorded,
            _provider_action_permit: permit,
        }
    }

    fn project_sse(
        request_id: &str,
        provider: V3ProviderSseStream,
        provider_wire_protocol: V3HubProviderWireProtocol,
        compatibility_profile: Option<String>,
        _web_search_execution_mode: V3WebSearchExecutionMode,
        _web_search_state: Option<V3WebSearchCenterState>,
        _retain_response_cipher: bool,
        tool_thinking_enabled: bool,
        stream_observation: V3RuntimeStreamObservation,
        _client_include_usage: bool,
        mut outcome: V3GeminiSseProviderOutcome,
    ) -> Result<V3RelayProjectedSseStream, V3RelayCoreError> {
        outcome.response_control = stream_observation;
        if provider_wire_protocol != V3HubProviderWireProtocol::Gemini {
            let request_id = request_id.to_owned();
            let mut outcome = outcome;
            return Ok(Box::pin(futures_util::stream::once(async move {
                let projected = async {
                    let value = super::responses_relay_runtime::materialize_v3_provider_sse_as_canonical_response(
                        provider_wire_protocol, provider,
                    ).await.map_err(|error| error.to_string())?;
                    let projection = project_json_response_with_source(
                        value, Some(&request_id), provider_wire_protocol, &Value::Null,
                        V3HubTransportIntent::Sse, &mut Vec::new(),
                        compatibility_profile.as_deref(), _retain_response_cipher, tool_thinking_enabled, true,
                    );
                    if let Err(V3GeminiRelayRuntimeError::Response(error)) = &projection {
                        outcome.response_control.record_response_governance_failure(error.clone())?;
                    }
                    let client = projection.map_err(|error| error.to_string())?;
                    let mut frame = b"data: ".to_vec();
                    serde_json::to_writer(&mut frame, &client).map_err(|error| error.to_string())?;
                    frame.extend_from_slice(b"\n\n");
                    Ok::<_, String>(frame)
                }.await;
                match projected {
                    // Provider success is committed by Runtime only after complete
                    // governance and sealing.
                    Ok(frame) => Ok(frame),
                    Err(error) => {
                        let recorded = outcome.record_failure(&error).await;
                        Err(recorded.map(|_| error).unwrap_or_else(|error| error))
                    }
                }
            })));
        }
        Ok(project_sse_stream(
            provider,
            compatibility_profile,
            _retain_response_cipher,
            tool_thinking_enabled,
            outcome,
        ))
    }

    fn assemble_json_output(
        client_response: Value,
        trace: Vec<&'static str>,
        observability: V3RuntimeObservability,
        provider_snapshots: V3RelayProviderSnapshots,
    ) -> V3GeminiRelayRuntimeOutput {
        V3GeminiRelayRuntimeOutput {
            status: 200,
            terminal_disposition: None,
            client_body: V3GeminiRelayClientBody::Json(client_response),
            node_trace: trace,
            error_chain: None,
            observability: Some(observability),
            provider_failure_attempts: Vec::new(),
            diagnostic_source: None,
            diagnostic_cause: None,
            stream_observation: None,
            provider_snapshots: Some(provider_snapshots),
        }
    }

    fn assemble_sse_output(
        sse: V3RelayCommittedSseStream,
        trace: Vec<&'static str>,
        observability: V3RuntimeObservability,
        stream_observation: V3RuntimeStreamObservation,
        provider_snapshots: V3RelayProviderSnapshots,
    ) -> V3GeminiRelayRuntimeOutput {
        V3GeminiRelayRuntimeOutput {
            status: 200,
            terminal_disposition: None,
            client_body: V3GeminiRelayClientBody::Sse(sse),
            node_trace: trace,
            error_chain: None,
            observability: Some(observability),
            provider_failure_attempts: Vec::new(),
            diagnostic_source: None,
            diagnostic_cause: None,
            stream_observation: Some(stream_observation),
            provider_snapshots: Some(provider_snapshots),
        }
    }

    fn assemble_failure_output(
        failure: V3RelayProviderFailure,
        trace: Vec<&'static str>,
        provider_failure_events: Vec<V3RuntimeProviderFailureObservation>,
    ) -> V3GeminiRelayRuntimeOutput {
        provider_failure_output(failure, trace, provider_failure_events)
    }
}

pub(crate) fn build_v3_gemini_transport_09(
    request_id: &str,
    target: V3ResponsesProviderTarget,
    transport_intent: V3HubTransportIntent,
    body: Value,
) -> Result<V3Transport13ResponsesHttpRequest, V3GeminiRelayRuntimeError> {
    let sse_first_frame_timeout_ms = target.sse_first_frame_timeout_ms;
    let stream_intent = match transport_intent {
        V3HubTransportIntent::Json => V3ResponsesStreamIntent::Json,
        V3HubTransportIntent::Sse => V3ResponsesStreamIntent::Sse,
    };
    // The selected wire model is encoded in the Gemini URL path, never in the
    // provider body: the shared selected-model binding inserts `model` into the
    // payload for protocols that carry it in the body, so drop it here.
    let mut body = body;
    if let Some(object) = body.as_object_mut() {
        object.remove("model");
    }
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
    build_v3_transport_13_responses_http_request_from_parts_with_timeout_and_concurrency(
        request_id,
        target.provider_id,
        url_text,
        target.auth,
        stream_intent,
        body,
        Vec::new(),
        Some(Duration::from_millis(target.request_timeout_ms)),
        target.concurrency_acquire_timeout_ms,
        sse_first_frame_timeout_ms,
    )
    .map_err(|error| V3GeminiRelayRuntimeError::Target(error.to_string()))
}

pub fn project_v3_gemini_relay_runtime_failure(
    error: V3GeminiRelayRuntimeError,
) -> V3GeminiRelayRuntimeOutput {
    let request_payload_invalid = matches!(
        &error,
        V3GeminiRelayRuntimeError::ProviderCompat(error)
            if error.classification() == V3ProviderCompatErrorClassification::RequestPayloadInvalid
    );
    let provider_pool_exhausted = matches!(
        &error,
        V3GeminiRelayRuntimeError::ProviderPoolExhausted { .. }
    );
    let source = match error {
        V3GeminiRelayRuntimeError::ProviderPoolExhausted {
            attempted_candidates,
        } => provider_pool_exhausted_source(
            "V3Target10ConcreteProviderSelected",
            &attempted_candidates,
        ),
        V3GeminiRelayRuntimeError::ProviderCompat(error) => match error.classification() {
            V3ProviderCompatErrorClassification::PayloadBoundaryViolation => {
                super::provider_compat_boundary_source("ProviderRespCompat02ProviderCompat", &error)
            }
            V3ProviderCompatErrorClassification::RequestPayloadInvalid => {
                super::provider_request_payload_source("ProviderReqCompat06ProviderCompat", &error)
            }
            V3ProviderCompatErrorClassification::Other => crate::shared::direct_plain_error(
                V3ErrorSourceKind::RuntimeFailure,
                "V3HubRuntime",
                "gemini_relay_runtime_error",
                error.to_string(),
            ),
        },
        error => crate::shared::direct_plain_error(
            V3ErrorSourceKind::RuntimeFailure,
            "V3HubRuntime",
            "gemini_relay_runtime_error",
            error.to_string(),
        ),
    };
    let (projected, trace) = match source {
        Ok(source) => error_output(
            source,
            if request_payload_invalid { 400 } else { 500 },
            "none",
            Vec::new(),
        ),
        Err(fault) => (Err(fault), Vec::new()),
    };
    gemini_error_output_from_projection(projected, trace, provider_pool_exhausted)
}

fn gemini_error_output_from_projection(
    projected: Result<
        routecodex_v3_error::V3Error06ClientProjected,
        crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault,
    >,
    trace: Vec<&'static str>,
    provider_pool_exhausted: bool,
) -> V3GeminiRelayRuntimeOutput {
    let projected = match projected {
        Ok(projected) => projected,
        Err(fault) => {
            return V3GeminiRelayRuntimeOutput {
                status: 599,
                terminal_disposition: Some(
                    routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse,
                ),
                client_body: V3GeminiRelayClientBody::Json(Value::Null),
                node_trace: trace,
                error_chain: None,
                observability: None,
                provider_failure_attempts: Vec::new(),
                diagnostic_source: Some(fault.policy_failure),
                diagnostic_cause: fault.original_source,
                stream_observation: None,
                provider_snapshots: None,
            }
        }
    };
    V3GeminiRelayRuntimeOutput {
        status: projected.status,
        terminal_disposition: provider_pool_exhausted
            .then_some(routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse),
        client_body: V3GeminiRelayClientBody::Json(projected.body),
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
        observability: None,
        provider_failure_attempts: Vec::new(),
        diagnostic_source: Some(projected.diagnostic_source),
        diagnostic_cause: None,
        stream_observation: None,
        provider_snapshots: None,
    }
}

fn project_json_response(
    provider_value: Value,
    transport_intent: V3HubTransportIntent,
    trace: &mut Vec<&'static str>,
    compatibility_profile: Option<&str>,
    retain_response_cipher: bool,
    tool_thinking_enabled: bool,
) -> Result<Value, V3GeminiRelayRuntimeError> {
    project_json_response_with_source(
        provider_value,
        None,
        V3HubProviderWireProtocol::Gemini,
        &Value::Null,
        transport_intent,
        trace,
        compatibility_profile,
        retain_response_cipher,
        tool_thinking_enabled,
        false,
    )
}

fn project_json_response_with_source(
    provider_value: Value,
    request_id: Option<&str>,
    provider_protocol: V3HubProviderWireProtocol,
    chat_request: &Value,
    transport_intent: V3HubTransportIntent,
    trace: &mut Vec<&'static str>,
    compatibility_profile: Option<&str>,
    retain_response_cipher: bool,
    tool_thinking_enabled: bool,
    complete_provider_attempt: bool,
) -> Result<Value, V3GeminiRelayRuntimeError> {
    let resp01 = build_v3_provider_resp_inbound_01_raw_with_compat_profile(
        provider_value,
        V3ProviderRespInbound01RawContext::new(
            V3HubEntryProtocol::Gemini,
            provider_protocol,
            V3HubExecutionMode::Relay,
            V3HubInvocationSource::Client,
            transport_intent,
        )
        .with_compatibility_profile(compatibility_profile),
    );
    trace.push("V3ProviderRespInbound01Raw");
    let hooks = compile_v3_hub_relay_response_hooks();
    let mut resp02 = hooks.normalize_with_context(resp01, None, request_id)?;
    match provider_protocol {
        V3HubProviderWireProtocol::OpenAiChat => {
            let canonical = super::responses_relay_runtime::build_v3_responses_provider_response_from_openai_chat_payload(
                resp02.provider_payload(), chat_request,
            ).map_err(|error| V3GeminiRelayRuntimeError::Target(error.to_string()))?;
            resp02.set_responses_semantic_payload(canonical);
        }
        _ => {}
    }
    trace.push("ProviderRespCompat02ProviderCompat");
    trace.push("V3HubRespInbound02Normalized");
    let resp03 = hooks.govern(
        resp02,
        &V3HubRelayResponseHookProfile::empty()
            .with_complete_provider_attempt(complete_provider_attempt)
            .with_retain_response_cipher(retain_response_cipher)
            .with_tool_thinking_enabled(tool_thinking_enabled),
    )?;
    trace.push("V3HubRespChatProcess03Governed");
    let (resp03, _, _) = resp03.into_parts();
    let resp05 = if request_id.is_some() {
        try_build_v3_hub_resp_outbound_05_from_v3_hub_resp_chat_process_03_with_projector(
            resp03,
            move |payload| {
                super::gemini_responses_codec::project_responses_to_gemini_client(
                    &payload,
                    provider_protocol,
                )
            },
        )
        .map_err(|error| V3GeminiRelayRuntimeError::Target(error.to_string()))?
    } else {
        build_v3_hub_resp_outbound_05_from_v3_hub_resp_chat_process_03(resp03)
    };
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
    tool_thinking_enabled: bool,
    provider_outcome: V3GeminiSseProviderOutcome,
}

pub(crate) struct V3GeminiSseProviderOutcome {
    response_control: V3RuntimeStreamObservation,
    provider_health: V3ProviderFailureRuntimeHealth,
    failure_session_scope: V3ProviderFailureSessionScope,
    provider_id: String,
    interface_id: String,
    auth_alias: String,
    model_id: String,
    recorded: bool,
    _provider_action_permit: Option<V3ProviderActionPermit>,
}

impl V3GeminiSseProviderOutcome {
    async fn record_failure(&mut self, reason: &str) -> Result<(), String> {
        if self.recorded || self.response_control.has_response_governance_failure()? {
            return Ok(());
        }
        drop(self._provider_action_permit.take());
        let source = build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_response_sse_stream",
            reason,
        );
        self.provider_health
            .record_post_commit_provider_stream_failure_from_source_for_interface(
                &self.failure_session_scope,
                &self.provider_id,
                &self.interface_id,
                Some(&self.auth_alias),
                Some(&self.model_id),
                &source,
            )?;
        self.recorded = true;
        Ok(())
    }
}

fn project_sse_stream(
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    compatibility_profile: Option<String>,
    retain_response_cipher: bool,
    tool_thinking_enabled: bool,
    provider_outcome: V3GeminiSseProviderOutcome,
) -> V3RelayProjectedSseStream {
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
        tool_thinking_enabled,
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
                    // Provider success is committed by Runtime only after complete
                    // governance and sealing.
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
                        .record_failure(&error.to_string())
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
        let data = crate::hub_v1::normalize_v3_provider_sse_json_data_for_event_name(
            V3HubProviderWireProtocol::Gemini,
            frame.frame().fields(),
        )?;
        let Some(outcome) = crate::hub_v1::classify_v3_provider_sse_json_data(
            V3HubProviderWireProtocol::Gemini,
            &data,
        )?
        else {
            continue;
        };
        let terminal = match outcome {
            V3ProviderResponsesJsonFrameOutcome::Failure { code, message } => {
                return Err(format!("{code}: {message}"));
            }
            V3ProviderResponsesJsonFrameOutcome::Terminal
            | V3ProviderResponsesJsonFrameOutcome::TerminalWithoutOutput => true,
            V3ProviderResponsesJsonFrameOutcome::ContinueBuffering
            | V3ProviderResponsesJsonFrameOutcome::StartClientStream => false,
        };
        let payload = crate::hub_v1::parse_v3_provider_sse_json_data(&data)?
            .ok_or_else(|| "provider Gemini SSE semantic frame is empty".to_string())?;
        let client_payload = project_sse_event_payload(
            payload,
            state.compatibility_profile.as_deref(),
            state.retain_response_cipher,
            state.tool_thinking_enabled,
            &state.provider_outcome.response_control,
        )?;
        state.terminal = terminal;
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
    tool_thinking_enabled: bool,
    response_control: &V3RuntimeStreamObservation,
) -> Result<Value, String> {
    let mut trace = Vec::new();
    let result = project_json_response(
        payload,
        V3HubTransportIntent::Sse,
        &mut trace,
        compatibility_profile,
        retain_response_cipher,
        tool_thinking_enabled,
    );
    if let Err(V3GeminiRelayRuntimeError::Response(error)) = &result {
        response_control.record_response_governance_failure(error.clone())?;
    }
    result.map_err(|error| error.to_string())
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
    provider_failure_attempts: Vec<V3RuntimeProviderFailureObservation>,
) -> V3GeminiRelayRuntimeOutput {
    if let Some(fault) = failure.error_operator_fault {
        return V3GeminiRelayRuntimeOutput {
            status: 599,
            terminal_disposition: Some(
                failure
                    .terminal_disposition
                    .unwrap_or(routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse),
            ),
            client_body: V3GeminiRelayClientBody::Json(Value::Null),
            node_trace: trace,
            error_chain: None,
            observability: None,
            provider_failure_attempts,
            diagnostic_source: Some(fault.policy_failure),
            diagnostic_cause: fault.original_source,
            stream_observation: None,
            provider_snapshots: None,
        };
    }
    let projected = failure
        .terminal_projection
        .expect("terminal Gemini provider failure must carry typed Error06 projection");
    trace.push("V3Error06ClientProjected");
    V3GeminiRelayRuntimeOutput {
        status: projected.status,
        terminal_disposition: failure.terminal_disposition,
        client_body: V3GeminiRelayClientBody::Json(projected.body),
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
        observability: None,
        provider_failure_attempts,
        diagnostic_source: Some(projected.diagnostic_source),
        diagnostic_cause: None,
        stream_observation: None,
        provider_snapshots: None,
    }
}

pub(crate) fn gemini_model_from_endpoint_path(
    endpoint_path: &str,
) -> Result<String, V3GeminiRelayRuntimeError> {
    let model = endpoint_path
        .strip_prefix("/v1beta/models/")
        .and_then(|value| {
            [
                "/generateContent",
                ":generateContent",
                ":streamGenerateContent",
            ]
            .iter()
            .find_map(|action| value.strip_suffix(action))
        })
        .filter(|value| !value.is_empty() && !value.contains('/') && !value.contains(':'))
        .ok_or_else(|| V3GeminiRelayRuntimeError::EndpointPath(endpoint_path.to_string()))?;
    Ok(model.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_error_operator_fault_projects_internal_599_without_client_error() {
        let attempts = vec![
            V3RuntimeProviderFailureObservation {
                provider_id: "provider-a".to_string(),
                status: 502,
                message: "attempt-a".to_string(),
                ..Default::default()
            },
            V3RuntimeProviderFailureObservation {
                provider_id: "provider-b".to_string(),
                status: 503,
                message: "attempt-b".to_string(),
                ..Default::default()
            },
        ];
        let source = routecodex_v3_error::build_v3_error_01_source_raised(
            routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure,
            "V3Error06ClientProjected",
            "relay_error_projection_nonterminal",
            "Error06 SDK completed without a terminal client projection",
        );
        let fault = crate::provider_failure_runtime_policy::finish_v3_relay_error_projection(
            source.clone(),
            Ok(None),
        )
        .expect_err("Ok(None) must produce a typed operator fault");
        let witness = routecodex_v3_error::V3ExternalHttpWitness::new(
            429,
            vec![("x-upstream".to_string(), b"rate-limit".to_vec())],
            b"{\"error\":{\"code\":\"rate_limited\"}}".to_vec(),
        )
        .with_body_read_failure("truncated");
        let cases = [
            (
                None,
                routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse,
            ),
            (
                Some(
                    routecodex_v3_error::V3ProviderTerminalDisposition::ExternalHttp(
                        witness.clone(),
                    ),
                ),
                routecodex_v3_error::V3ProviderTerminalDisposition::ExternalHttp(witness),
            ),
        ];

        for (terminal_disposition, expected_disposition) in cases {
            let output = provider_failure_output(
                V3RelayProviderFailure {
                    status: 502,
                    provider_status: None,
                    client_response: Value::Null,
                    source_stage: "V3Error06ClientProjected",
                    terminal_projection: None,
                    terminal_disposition,
                    error_operator_fault: Some(fault.clone()),
                    failed_attempt_evidence: None,
                    error_type_fn: |_| None,
                    error_message_fn: |_| "unused".to_string(),
                },
                vec!["V3ProviderRespInbound01Raw"],
                attempts.clone(),
            );

            assert_eq!(output.status, 599);
            assert_eq!(output.terminal_disposition, Some(expected_disposition));
            assert!(matches!(
                &output.client_body,
                V3GeminiRelayClientBody::Json(value) if value.is_null()
            ));
            assert!(output.error_chain.is_none());
            assert!(!output.node_trace.contains(&"V3Error06ClientProjected"));
            assert_eq!(output.diagnostic_source, Some(fault.policy_failure.clone()));
            assert_eq!(output.diagnostic_cause, fault.original_source.clone());
            assert_eq!(
                fault.policy_failure.source_kind,
                routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure
            );
            assert_eq!(
                fault.policy_failure.code,
                "relay_error_projection_nonterminal"
            );
            assert_eq!(fault.original_source, Some(source.clone()));
            assert_eq!(output.provider_failure_attempts, attempts);
        }
    }

    #[test]
    fn local_error_sdk_fault_survives_consumer() {
        let source = routecodex_v3_error::build_v3_error_01_source_raised(
            routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure,
            "V3Error06ClientProjected",
            "local_error_sdk_failure",
            "local error SDK failure must remain the projected cause",
        );
        let error = crate::operation_runner::run_v3_error_02_to_05_decision_operators(
            Value::Null,
            source.clone(),
            routecodex_v3_error::V3ErrorActionScope::None,
            0,
            false,
            false,
            None,
        )
        .expect_err("a null source projection must fail the real Error operator SDK");
        let fault = crate::provider_failure_runtime_policy::finish_v3_relay_error_projection(
            source.clone(),
            Err(error),
        )
        .expect_err("the real Error operator SDK failure must remain a typed fault");
        let policy_failure = fault.policy_failure.clone();
        let original_source = fault
            .original_source
            .clone()
            .expect("the real original source must remain attached to the fault");
        let trace = vec![
            "V3Error02Classified",
            "V3Error03TargetLocalAction",
            "V3Error04TargetExhaustion",
            "V3Error05ExecutionDecision",
        ];

        let output = gemini_error_output_from_projection(Err(fault), trace.clone(), false);

        assert_eq!(output.status, 599);
        assert_eq!(
            output.terminal_disposition,
            Some(routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse)
        );
        assert!(matches!(
            &output.client_body,
            V3GeminiRelayClientBody::Json(value) if value.is_null()
        ));
        assert!(output.error_chain.is_none());
        assert_eq!(output.node_trace, trace);
        assert!(!output.node_trace.contains(&"V3Error06ClientProjected"));
        assert_eq!(output.diagnostic_source, Some(policy_failure.clone()));
        assert_eq!(output.diagnostic_cause, Some(original_source.clone()));
        assert_eq!(
            policy_failure.source_kind,
            routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure
        );
        assert_eq!(policy_failure.source_stage, "V3Error06ClientProjected");
        assert_eq!(policy_failure.code, "relay_error_operator_sdk_failure");
        assert_eq!(original_source, source);
    }

    #[test]
    fn provider_compat_source_fault_short_circuits_with_original_cause() {
        let error = V3ProviderCompatError::new_payload_boundary(
            "response",
            "passthrough".to_string(),
            "ProviderCompatPayloadBoundaryViolation field=metadata value=control".to_string(),
        );
        let source = crate::hub_v1::provider_compat_boundary_source(
            "ProviderRespCompat02ProviderCompat",
            &error,
        )
        .expect("compat boundary source must execute Error01 successfully");
        let fault = crate::provider_failure_runtime_policy::finish_v3_relay_error_projection(
            source.clone(),
            Ok(None),
        )
        .expect_err("missing terminal Error06 is a typed SDK fault");
        let diagnostic_source = fault.policy_failure.clone();
        let diagnostic_cause = fault
            .original_source
            .clone()
            .expect("the SDK fault keeps its original compat source");
        let trace = vec!["ProviderRespCompat02ProviderCompat"];

        let output = gemini_error_output_from_projection(Err(fault), trace.clone(), false);

        assert_eq!(output.status, 599);
        assert_eq!(
            output.terminal_disposition,
            Some(routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse)
        );
        assert!(matches!(
            &output.client_body,
            V3GeminiRelayClientBody::Json(value) if value.is_null()
        ));
        assert!(output.error_chain.is_none());
        assert_eq!(output.node_trace, trace);
        assert!(!output.node_trace.contains(&"V3Error06ClientProjected"));
        assert_eq!(output.diagnostic_source, Some(diagnostic_source));
        assert_eq!(output.diagnostic_cause, Some(diagnostic_cause.clone()));
        assert_eq!(diagnostic_cause, source);
    }

    #[test]
    fn other_provider_compat_uses_canonical_plain_error_source() {
        let error = V3ProviderCompatError::other(
            "response",
            "compat:passthrough".to_string(),
            "provider response compat failed".to_string(),
        );
        let expected = crate::shared::direct_plain_error(
            V3ErrorSourceKind::RuntimeFailure,
            "V3HubRuntime",
            "gemini_relay_runtime_error",
            error.to_string(),
        )
        .expect("plain Err01 must execute through the canonical Error graph");
        let output = project_v3_gemini_relay_runtime_failure(
            V3GeminiRelayRuntimeError::ProviderCompat(error),
        );

        assert_eq!(output.diagnostic_source, Some(expected));
        assert!(output.diagnostic_cause.is_none());
        assert_eq!(
            output.error_chain,
            Some(routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS.to_vec())
        );
        assert!(output.node_trace.contains(&"V3Error06ClientProjected"));
    }

    #[test]
    fn other_provider_compat_source_fault_short_circuits_gemini_projection() {
        let error = V3ProviderCompatError::other(
            "response",
            "compat:passthrough".to_string(),
            "provider response compat failed".to_string(),
        );
        let source = crate::shared::direct_plain_error(
            V3ErrorSourceKind::RuntimeFailure,
            "V3HubRuntime",
            "gemini_relay_runtime_error",
            error.to_string(),
        )
        .expect("plain Err01 must execute through the canonical Error graph");
        let fault = crate::provider_failure_runtime_policy::finish_v3_relay_error_projection(
            source.clone(),
            Ok(None),
        )
        .expect_err("missing terminal Error06 must produce a typed SDK fault");
        let diagnostic_source = fault.policy_failure.clone();
        let diagnostic_cause = fault
            .original_source
            .clone()
            .expect("the source fault preserves the canonical plain source");
        assert_eq!(diagnostic_cause, source);

        let output = gemini_error_output_from_projection(
            Err(fault),
            vec!["ProviderRespCompat02ProviderCompat"],
            false,
        );

        assert_eq!(output.status, 599);
        assert_eq!(
            output.terminal_disposition,
            Some(routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse)
        );
        assert!(matches!(
            &output.client_body,
            V3GeminiRelayClientBody::Json(value) if value.is_null()
        ));
        assert!(output.error_chain.is_none());
        assert!(!output.node_trace.contains(&"V3Error06ClientProjected"));
        assert_eq!(output.diagnostic_source, Some(diagnostic_source));
        assert_eq!(output.diagnostic_cause, Some(diagnostic_cause));
    }
}
