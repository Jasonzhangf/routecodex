use super::*;
use crate::{
    V3LocalContinuationError, V3LocalContinuationReq04RestoreRequest,
    V3LocalContinuationResp04SaveInput, V3LocalContinuationScopeKey, V3LocalContinuationStore,
    V3LocalContinuationTerminalOutcome,
};
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
    build_v3_transport_13_responses_http_request_from_v3_provider_12, ReqwestResponsesTransport,
    ResponsesTransport, V3ProviderAuthHandle, V3ProviderAuthSecretHandle, V3ProviderError,
    V3ProviderResponseBody, V3ResponsesProviderTarget,
};
use routecodex_v3_target::V3TargetInterpreter;
use routecodex_v3_virtual_router::V3VirtualRouter;
use serde_json::{json, Value};
use std::sync::{Mutex, MutexGuard};

const V3_ANTHROPIC_LOCAL_CONTINUATION_TTL_MS: u64 = 30 * 60 * 1_000;

#[derive(Debug, Clone, PartialEq)]
pub struct V3AnthropicRelayRuntimeInput {
    pub server_id: String,
    pub request_id: String,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3AnthropicRelayRuntimeOutput {
    pub status: u16,
    pub client_response: Value,
    pub node_trace: Vec<&'static str>,
    pub error_chain: Option<Vec<&'static str>>,
    pub servertool_followup_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3AnthropicRelayLocalContinuationScope {
    entry_endpoint: String,
    session_id: String,
    conversation_id: String,
    port: u16,
    routing_group: String,
}

impl V3AnthropicRelayLocalContinuationScope {
    pub fn anthropic(
        entry_endpoint: impl Into<String>,
        session_id: impl Into<String>,
        conversation_id: impl Into<String>,
        port: u16,
        routing_group: impl Into<String>,
    ) -> Self {
        Self {
            entry_endpoint: entry_endpoint.into(),
            session_id: session_id.into(),
            conversation_id: conversation_id.into(),
            port,
            routing_group: routing_group.into(),
        }
    }

    fn local_key(&self) -> V3LocalContinuationScopeKey {
        V3LocalContinuationScopeKey::anthropic(
            self.entry_endpoint.clone(),
            self.session_id.clone(),
            self.conversation_id.clone(),
            self.port,
            self.routing_group.clone(),
        )
    }

    fn hub_scope(&self, server_id: &str) -> V3HubContinuationScope {
        V3HubContinuationScope::new(
            V3HubEntryProtocol::Anthropic,
            server_id,
            self.routing_group.clone(),
            self.session_id.clone(),
        )
    }
}

#[derive(Debug, Default)]
pub struct V3AnthropicRelayLocalContinuationState {
    store: Mutex<V3LocalContinuationStore>,
}

impl V3AnthropicRelayLocalContinuationState {
    pub fn len(&self) -> Result<usize, V3AnthropicRelayRuntimeError> {
        Ok(self.lock_store()?.len())
    }

    pub fn is_empty(&self) -> Result<bool, V3AnthropicRelayRuntimeError> {
        Ok(self.lock_store()?.is_empty())
    }

    fn lock_store(
        &self,
    ) -> Result<MutexGuard<'_, V3LocalContinuationStore>, V3AnthropicRelayRuntimeError> {
        self.store
            .lock()
            .map_err(|_| V3AnthropicRelayRuntimeError::LocalContinuationStatePoisoned)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum V3AnthropicRelayRuntimeError {
    #[error(transparent)]
    Protocol(#[from] V3AnthropicRelayProtocolHookError),
    #[error(transparent)]
    Request(#[from] V3HubRelayRequestError),
    #[error(transparent)]
    Response(#[from] V3HubRelayResponseError),
    #[error(transparent)]
    Codec(#[from] V3AnthropicCodecError),
    #[error("V3 Hub static hook registry failed: {0}")]
    StaticRegistry(String),
    #[error("V3 Relay target resolution failed: {0}")]
    Target(String),
    #[error("V3 Relay provider contract failed: {0}")]
    Provider(#[from] V3ProviderError),
    #[error("V3 Relay provider compat failed: {0}")]
    ProviderCompat(#[from] V3ProviderCompatError),
    #[error("V3 Relay JSON provider body is malformed: {0}")]
    ProviderJson(#[from] serde_json::Error),
    #[error("V3 Relay structured SSE projection failed: {0}")]
    StructuredSse(String),
    #[error(transparent)]
    LocalContinuation(#[from] V3LocalContinuationError),
    #[error("V3 Anthropic local continuation scope routing group does not match server")]
    LocalContinuationScopeMismatch,
    #[error("V3 Anthropic local continuation clock overflow")]
    LocalContinuationClockOverflow,
    #[error("V3 Anthropic local continuation state lock is poisoned")]
    LocalContinuationStatePoisoned,
}

pub async fn execute_v3_anthropic_relay_runtime_with_default_transport(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
) -> Result<V3AnthropicRelayRuntimeOutput, V3AnthropicRelayRuntimeError> {
    execute_v3_anthropic_relay_runtime(manifest, input, &ReqwestResponsesTransport::default()).await
}

pub async fn execute_v3_anthropic_relay_runtime<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
    transport: &T,
) -> Result<V3AnthropicRelayRuntimeOutput, V3AnthropicRelayRuntimeError> {
    execute_v3_anthropic_relay_runtime_inner(
        manifest,
        input,
        transport,
        None,
        V3HubRelayResponseHookProfile::empty(),
    )
    .await
}

pub async fn execute_v3_anthropic_relay_runtime_with_local_continuation<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
    transport: &T,
    state: &V3AnthropicRelayLocalContinuationState,
    scope: V3AnthropicRelayLocalContinuationScope,
    now_epoch_ms: u64,
) -> Result<V3AnthropicRelayRuntimeOutput, V3AnthropicRelayRuntimeError> {
    execute_v3_anthropic_relay_runtime_with_local_continuation_and_servertool_profile(
        manifest,
        input,
        transport,
        state,
        scope,
        now_epoch_ms,
        std::iter::empty::<&'static str>(),
    )
    .await
}

pub async fn execute_v3_anthropic_relay_runtime_with_local_continuation_and_servertool_profile<
    T,
    I,
    S,
>(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
    transport: &T,
    state: &V3AnthropicRelayLocalContinuationState,
    scope: V3AnthropicRelayLocalContinuationScope,
    now_epoch_ms: u64,
    servertool_names: I,
) -> Result<V3AnthropicRelayRuntimeOutput, V3AnthropicRelayRuntimeError>
where
    T: ResponsesTransport,
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    execute_v3_anthropic_relay_runtime_inner(
        manifest,
        input,
        transport,
        Some(V3AnthropicRelayLocalContinuationExecution {
            state,
            scope,
            now_epoch_ms,
        }),
        V3HubRelayResponseHookProfile::new(servertool_names),
    )
    .await
}

struct V3AnthropicRelayLocalContinuationExecution<'state> {
    state: &'state V3AnthropicRelayLocalContinuationState,
    scope: V3AnthropicRelayLocalContinuationScope,
    now_epoch_ms: u64,
}

async fn execute_v3_anthropic_relay_runtime_inner<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
    transport: &T,
    local: Option<V3AnthropicRelayLocalContinuationExecution<'_>>,
    response_hook_profile: V3HubRelayResponseHookProfile,
) -> Result<V3AnthropicRelayRuntimeOutput, V3AnthropicRelayRuntimeError> {
    compile_v3_hub_v1_static_registry()
        .map_err(|error| V3AnthropicRelayRuntimeError::StaticRegistry(error.to_string()))?;
    let mut trace = Vec::with_capacity(17);
    let transport_intent = if input.payload.get("stream").and_then(Value::as_bool) == Some(true) {
        V3HubTransportIntent::Sse
    } else {
        V3HubTransportIntent::Json
    };
    let requested_local_ids = find_anthropic_tool_result_ids(&input.payload)?;
    let req01 = build_v3_hub_req_inbound_01_client_raw(
        input.payload,
        V3HubEntryProtocol::Anthropic,
        V3HubInvocationSource::Client,
        transport_intent,
    );
    trace.push("V3HubReqInbound01ClientRaw");
    let req02 = run_v3_anthropic_relay_runtime_req_inbound(req01)?;
    trace.push("V3HubReqInbound02Normalized");
    let base_hub_scope = V3HubContinuationScope::new(
        V3HubEntryProtocol::Anthropic,
        &input.server_id,
        server_routing_group(manifest, &input.server_id)?,
        &input.request_id,
    );
    let mut restored_context = None;
    let lookup =
        if let (Some(local), Some(context_id)) = (local.as_ref(), requested_local_ids.first()) {
            if local.scope.routing_group != server_routing_group(manifest, &input.server_id)? {
                return Err(V3AnthropicRelayRuntimeError::LocalContinuationScopeMismatch);
            }
            let request = V3LocalContinuationReq04RestoreRequest::local(
                context_id,
                local.scope.local_key(),
                local.now_epoch_ms,
            );
            let store = local.state.lock_store()?;
            let context = store
                .restore_at_req04(&request)?
                .canonical_context()
                .clone();
            for additional_id in requested_local_ids.iter().skip(1) {
                let additional = store
                    .restore_at_req04(&V3LocalContinuationReq04RestoreRequest::local(
                        additional_id,
                        local.scope.local_key(),
                        local.now_epoch_ms,
                    ))?
                    .canonical_context();
                if additional != &context {
                    return Err(V3LocalContinuationError::Codec {
                        message: "tool results reference different local continuation contexts"
                            .to_string(),
                    }
                    .into());
                }
            }
            drop(store);
            restored_context = Some(context.clone());
            V3HubContinuationLookup::new(Some(context_id), local.scope.hub_scope(&input.server_id))
                .with_local_context(context_id, local.scope.hub_scope(&input.server_id), context)
        } else {
            V3HubContinuationLookup::new(None, base_hub_scope)
        };
    let request_outcome = compile_v3_hub_relay_request_hooks().run_from_normalized(
        req02,
        &lookup,
        &V3HubServertoolRequestProfile::disabled(),
    )?;
    trace.push("V3HubReqContinuation03Classified");
    trace.push("V3HubReqChatProcess04Governed");
    let mut req04 = request_outcome.into_governed();
    if let Some(context) = restored_context.as_ref() {
        merge_restored_local_context_at_req04(
            &mut req04.previous.previous.previous.payload.0,
            context,
        )?;
    }
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
    let provider_wire_protocol = provider_wire_protocol_for_provider_type(
        &selected.candidate.provider_id,
        &selected.candidate.provider_type,
    )
    .map_err(V3AnthropicRelayRuntimeError::Target)?;
    let selected_target_provider_id = selected.candidate.provider_id.clone();
    let selected_target_compatibility_profile = selected.candidate.compatibility_profile.clone();
    let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
        req05,
        V3HubTargetResolution::Routed,
        selected.candidate,
    );
    trace.push("V3HubReqTarget06Resolved");
    let req07 =
        build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(req06, provider_wire_protocol);
    trace.push("V3HubReqOutbound07ProviderSemantic");
    let target = provider_target(manifest, req07.selected_target())?;
    let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)?;
    trace.push("ProviderReqCompat06ProviderCompat");
    let req08 = build_v3_provider_req_outbound_08_from_provider_req_compat_06(req_compat);
    let req09 = build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(req08);
    let provider_semantic = req09.into_provider_semantic_payload();
    let wire =
        build_v3_provider_12_responses_wire_payload(&input.request_id, target, provider_semantic)?;
    trace.push("V3ProviderReqOutbound08WirePayload");
    let transport_request = match provider_wire_protocol {
        V3HubProviderWireProtocol::Responses => {
            build_v3_transport_13_responses_http_request_from_v3_provider_12(wire)?
        }
        V3HubProviderWireProtocol::Anthropic => {
            build_v3_anthropic_messages_transport_request_from_v3_provider_08(wire)
                .map_err(V3AnthropicRelayRuntimeError::Target)?
        }
        other => {
            return Err(V3AnthropicRelayRuntimeError::Target(format!(
                "Anthropic Relay does not support provider transport protocol {other:?}"
            )))
        }
    };
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
    let provider_body = provider_raw.into_body();
    if let V3ProviderResponseBody::Sse(stream) = provider_body {
        if provider_wire_protocol == V3HubProviderWireProtocol::Anthropic {
            return Err(V3AnthropicRelayRuntimeError::StructuredSse(
                "Anthropic Relay Anthropic provider SSE is not implemented".to_string(),
            ));
        }
        let projection = project_v3_responses_sse_as_anthropic_events(stream)
            .await
            .map_err(V3AnthropicRelayRuntimeError::StructuredSse)?;
        let (canonical_response, client_events) = projection.into_parts();
        let resp01 = build_v3_provider_resp_inbound_01_raw_with_compat_profile(
            canonical_response,
            V3ProviderRespInbound01RawContext::new(
                V3HubEntryProtocol::Anthropic,
                provider_wire_protocol,
                V3HubContinuationOwnership::New,
                V3HubExecutionMode::Relay,
                V3HubInvocationSource::Client,
                V3HubTransportIntent::Sse,
            )
            .with_compatibility_profile(selected_target_compatibility_profile.as_deref()),
        );
        trace.push("V3ProviderRespInbound01Raw");
        let hooks = compile_v3_hub_relay_response_hooks();
        let resp02 = hooks.normalize(resp01)?;
        trace.push("ProviderRespCompat02ProviderCompat");
        trace.push("V3HubRespInbound02Normalized");
        let resp03 = hooks.govern(resp02, &response_hook_profile)?;
        trace.push("V3HubRespChatProcess03Governed");
        let resp04 = hooks.commit(resp03)?;
        trace.push("V3HubRespContinuation04Committed");
        let servertool_followup_required =
            resp04.previous.servertool_action() == V3HubServertoolResponseAction::FollowupRequired;
        commit_or_release_local_continuation(
            local.as_ref(),
            &requested_local_ids,
            resp04.finalized_payload(),
            resp04.action(),
        )?;
        let client_response = V3AnthropicRelaySseProjection::project_after_resp04(client_events);
        let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04);
        trace.push("V3HubRespOutbound05ClientSemantic");
        let _resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);
        trace.push("V3ServerRespOutbound06ClientFrame");
        return Ok(V3AnthropicRelayRuntimeOutput {
            status: 200,
            client_response,
            node_trace: trace,
            error_chain: None,
            servertool_followup_required,
        });
    }
    let V3ProviderResponseBody::Json(bytes) = provider_body else {
        unreachable!("SSE returned above")
    };
    let provider_value: Value = serde_json::from_slice(&bytes)?;
    let hook_provider_value = if provider_wire_protocol == V3HubProviderWireProtocol::Anthropic {
        project_v3_anthropic_message_as_responses_response(&provider_value)?
    } else {
        provider_value
    };
    let hook_provider_protocol = if provider_wire_protocol == V3HubProviderWireProtocol::Anthropic {
        V3HubProviderWireProtocol::Responses
    } else {
        provider_wire_protocol
    };
    let resp01 = build_v3_provider_resp_inbound_01_raw_with_compat_profile(
        hook_provider_value,
        V3ProviderRespInbound01RawContext::new(
            V3HubEntryProtocol::Anthropic,
            hook_provider_protocol,
            V3HubContinuationOwnership::New,
            V3HubExecutionMode::Relay,
            V3HubInvocationSource::Client,
            transport_intent,
        )
        .with_compatibility_profile(selected_target_compatibility_profile.as_deref()),
    );
    trace.push("V3ProviderRespInbound01Raw");
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks.normalize(resp01)?;
    trace.push("ProviderRespCompat02ProviderCompat");
    trace.push("V3HubRespInbound02Normalized");
    let resp03 = hooks.govern(resp02, &response_hook_profile)?;
    trace.push("V3HubRespChatProcess03Governed");
    let resp04 = hooks.commit(resp03)?;
    trace.push("V3HubRespContinuation04Committed");
    let servertool_followup_required =
        resp04.previous.servertool_action() == V3HubServertoolResponseAction::FollowupRequired;
    commit_or_release_local_continuation(
        local.as_ref(),
        &requested_local_ids,
        resp04.finalized_payload(),
        resp04.action(),
    )?;
    let client_response =
        project_v3_responses_json_as_anthropic_message(resp04.finalized_payload())?;
    let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04);
    trace.push("V3HubRespOutbound05ClientSemantic");
    let _resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);
    trace.push("V3ServerRespOutbound06ClientFrame");
    Ok(V3AnthropicRelayRuntimeOutput {
        status: 200,
        client_response,
        node_trace: trace,
        error_chain: None,
        servertool_followup_required,
    })
}

fn find_anthropic_tool_result_ids(
    payload: &Value,
) -> Result<Vec<String>, V3AnthropicRelayRuntimeError> {
    let mut ids = Vec::new();
    for part in payload
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|message| message.get("content").and_then(Value::as_array))
        .flatten()
    {
        if part.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        let id = part
            .get("tool_use_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| V3LocalContinuationError::Codec {
                message: "Anthropic tool_result requires tool_use_id".to_string(),
            })?;
        if !ids.iter().any(|existing| existing == id) {
            ids.push(id.to_owned());
        }
    }
    Ok(ids)
}

fn merge_restored_local_context_at_req04(
    current: &mut Value,
    restored: &Value,
) -> Result<(), V3AnthropicRelayRuntimeError> {
    let restored_items = restored
        .get("output")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| V3LocalContinuationError::Codec {
            message: "restored local continuation output must be an array".to_string(),
        })?;
    let current_items = current
        .get_mut("input")
        .and_then(Value::as_array_mut)
        .map(std::mem::take)
        .ok_or_else(|| V3LocalContinuationError::Codec {
            message: "Req04 provider semantic input must be an array".to_string(),
        })?;
    let restored_reasoning_items = restored_items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("reasoning"))
        .cloned()
        .collect::<Vec<_>>();
    let current_items =
        maybe_drop_duplicate_restored_reasoning(current_items, &restored_reasoning_items);
    let mut merged = restored_items;
    let restored_keys = merged
        .iter()
        .filter_map(|item| {
            Some((
                item.get("type").and_then(Value::as_str)?.to_owned(),
                item.get("call_id").and_then(Value::as_str)?.to_owned(),
            ))
        })
        .collect::<Vec<_>>();
    merged.extend(current_items.into_iter().filter(|item| {
        let current_call_id = item.get("call_id").and_then(Value::as_str);
        current_call_id.is_none_or(|call_id| {
            !restored_keys.iter().any(|(restored_type, restored_id)| {
                restored_id == call_id
                    && Some(restored_type.as_str()) == item.get("type").and_then(Value::as_str)
            })
        })
    }));
    current["input"] = Value::Array(merged);
    Ok(())
}

fn maybe_drop_duplicate_restored_reasoning(
    mut current_items: Vec<Value>,
    restored_reasoning_items: &[Value],
) -> Vec<Value> {
    let Some(first_current) = current_items.first() else {
        return current_items;
    };
    if first_current.get("type").and_then(Value::as_str) != Some("reasoning") {
        return current_items;
    }
    if restored_reasoning_items
        .iter()
        .any(|item| item.get("summary") == first_current.get("summary"))
    {
        current_items.remove(0);
    }
    current_items
}

fn commit_or_release_local_continuation(
    local: Option<&V3AnthropicRelayLocalContinuationExecution<'_>>,
    restored_context_ids: &[String],
    canonical_response: &Value,
    action: V3HubContinuationCommit,
) -> Result<(), V3AnthropicRelayRuntimeError> {
    let Some(local) = local else {
        return Ok(());
    };
    let mut store = local.state.lock_store()?;
    for context_id in restored_context_ids {
        store.release_in_scope(&local.scope.local_key(), context_id);
    }
    if action != V3HubContinuationCommit::LocalContext {
        return Ok(());
    }
    let context_ids = canonical_response
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| {
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("function_call" | "custom_tool_call" | "tool_call")
            )
        })
        .map(|item| {
            item.get("call_id")
                .or_else(|| item.get("id"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| V3LocalContinuationError::Codec {
                    message: "Resp04 local context has a tool call without id".to_string(),
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if context_ids.is_empty() {
        return Err(V3LocalContinuationError::Codec {
            message: "Resp04 local context has no tool call id".to_string(),
        }
        .into());
    }
    if let Some(duplicate) = context_ids
        .iter()
        .find(|id| store.contains_in_scope(&local.scope.local_key(), id))
    {
        return Err(V3LocalContinuationError::AlreadyCommitted {
            context_id: duplicate.clone(),
        }
        .into());
    }
    let expires_at_epoch_ms = local
        .now_epoch_ms
        .checked_add(V3_ANTHROPIC_LOCAL_CONTINUATION_TTL_MS)
        .ok_or(V3AnthropicRelayRuntimeError::LocalContinuationClockOverflow)?;
    for context_id in context_ids {
        store.commit_at_resp04(V3LocalContinuationResp04SaveInput::new(
            context_id,
            local.scope.local_key(),
            canonical_response.clone(),
            V3LocalContinuationTerminalOutcome::NonTerminal,
            local.now_epoch_ms,
            expires_at_epoch_ms,
        ))?;
    }
    Ok(())
}

pub fn project_v3_anthropic_relay_runtime_failure(
    error: V3AnthropicRelayRuntimeError,
) -> V3AnthropicRelayRuntimeOutput {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::RuntimeFailure,
        "V3HubRuntime",
        "anthropic_relay_runtime_error",
        error.to_string(),
    );
    error_output(
        source,
        500,
        json!({"type":"error","error":{"type":"runtime_error","message":error.to_string()}}),
        "none",
        Vec::new(),
    )
}

fn server_routing_group<'a>(
    manifest: &'a V3Config05ManifestPublished,
    server_id: &str,
) -> Result<&'a str, V3AnthropicRelayRuntimeError> {
    manifest
        .servers
        .get(server_id)
        .map(|server| server.routing_group.as_str())
        .ok_or_else(|| V3AnthropicRelayRuntimeError::Target(format!("server {server_id} missing")))
}

fn resolve_target(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    body: &Value,
) -> Result<routecodex_v3_target::V3Target10ConcreteProviderSelected, V3AnthropicRelayRuntimeError>
{
    let facts = crate::build_v3_router_request_facts_for_entry(body, "anthropic");
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(manifest, server_id, "/v1/messages", facts)
        .map_err(|error| V3AnthropicRelayRuntimeError::Target(format!("{error:?}")))?;
    let plan = router
        .resolve_route_pool_plan(manifest, classified)
        .map_err(|error| V3AnthropicRelayRuntimeError::Target(format!("{error:?}")))?;
    let hit = router
        .hit_opaque_target_plan_once(plan, 0)
        .map_err(|error| V3AnthropicRelayRuntimeError::Target(format!("{error:?}")))?;
    let target = V3TargetInterpreter::default();
    let kind = target.classify_kind(hit);
    let expanded = target
        .expand_candidates(manifest, kind, 0)
        .map_err(|error| V3AnthropicRelayRuntimeError::Target(error.to_string()))?;
    target
        .select_available(
            expanded,
            &routecodex_v3_provider_responses::V3ProviderAvailabilityRegistry::from_manifest(
                manifest,
            ),
            0,
        )
        .map_err(|error| V3AnthropicRelayRuntimeError::Target(format!("{error:?}")))
}

fn provider_target(
    manifest: &V3Config05ManifestPublished,
    selected: &routecodex_v3_target::V3TargetCandidate,
) -> Result<V3ResponsesProviderTarget, V3AnthropicRelayRuntimeError> {
    let provider = manifest
        .providers
        .get(&selected.provider_id)
        .ok_or_else(|| {
            V3AnthropicRelayRuntimeError::Target("selected provider missing".to_string())
        })?;
    let auth = provider
        .auth
        .entries
        .iter()
        .find(|entry| entry.alias == selected.auth_alias)
        .ok_or_else(|| {
            V3AnthropicRelayRuntimeError::Target("selected auth handle missing".to_string())
        })?;
    let secret = match (&auth.env, &auth.token_file) {
        (Some(env), None) => V3ProviderAuthSecretHandle::Environment(env.clone()),
        (None, Some(path)) => V3ProviderAuthSecretHandle::TokenFile(path.clone()),
        _ => {
            return Err(V3AnthropicRelayRuntimeError::Target(
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
) -> V3AnthropicRelayRuntimeOutput {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderReqOutbound09TransportRequest",
        format!("provider_http_{status}"),
        format!("provider returned HTTP {status}"),
    );
    error_output(
        source,
        status,
        project_v3_responses_error_as_anthropic_error(body),
        provider_id,
        trace,
    )
}

fn provider_runtime_error_output(
    error: V3ProviderError,
    provider_id: &str,
    trace: Vec<&'static str>,
) -> V3AnthropicRelayRuntimeOutput {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderReqOutbound09TransportRequest",
        "provider_transport_error",
        error.to_string(),
    );
    error_output(
        source,
        502,
        json!({"type":"error","error":{"type":"provider_error","message":error.to_string()}}),
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
) -> V3AnthropicRelayRuntimeOutput {
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
    V3AnthropicRelayRuntimeOutput {
        status,
        client_response,
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
        servertool_followup_required: false,
    }
}
