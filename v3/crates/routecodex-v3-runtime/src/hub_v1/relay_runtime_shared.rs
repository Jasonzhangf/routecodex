//! relay runtime 共享编排辅助（骨架逻辑无生命周期）。
//!
//! 这些函数只被 relay 主循环（execute_v3_*_relay_runtime_inner）调用，不自己管理
//! retry/error/SSE 状态；生命周期由主循环持有。目标：消除 4 个 relay runtime
//! （responses / anthropic / openai_chat / gemini）各自复制的辅助副本
//! （server_routing_group / provider_target / handle_provider_failure /
//! provider_*_failure / failure_error_type / provider_failure_message / error_output）。
//!
//! 错误统一以 `String` 表达，调用方（协议 runtime）负责 map_err 到自身错误类型；
//! 统一失败结构 [`V3RelayProviderFailure`] 替代各协议 `V3*RelayProviderFailure` 副本。

use crate::hub_v1::{
    V3HubEntryProtocol, V3HubProviderWireProtocol, V3RuntimeObservability,
    V3RuntimeProviderFailedAttemptEvidence, V3RuntimeProviderFailureObservation,
    V3RuntimeStreamObservation,
};
use crate::provider_failure_runtime_policy::{
    project_v3_client_disconnect, provider_runtime_failure_stage,
    run_v3_relay_provider_failure_policy, v3_relay_provider_candidate_key_parts,
    V3RelayErrorOperatorFault, V3RelayProviderFailurePolicyContext,
    V3RelayProviderFailurePolicyEvent, V3RelayProviderFailurePolicyState,
};
use futures_util::StreamExt;
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{
    V3Error05ExecutionAction, V3Error05RecoveryAdmissionWitness, V3Error06ClientProjected,
    V3ErrorActionScope, V3ErrorSourceKind, V3ExternalErrorKind, V3ExternalErrorLink,
    V3ExternalHttpWitness, V3_ERROR_CHAIN_NODE_IDS, V3_TRANSIENT_TRANSPORT_HANG_CODE,
};
use routecodex_v3_provider_responses::{
    v3_provider_auth_handle_from_manifest_entry, V3ProviderAuthHandle, V3ProviderError,
    V3ProviderHttpFailure, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3ResponsesProviderTarget, V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_sse::{
    build_v3_sse_transport_in_01_raw_chunk, SseIncrementalDecoder, SseTransportLimits,
};
use routecodex_v3_target::V3Target10ConcreteProviderSelected;
use serde_json::{json, Value};
use std::fmt;
use std::pin::Pin;
use std::sync::Arc;

/// 骨架内部错误（协议入口负责映射到自身错误类型）。
#[derive(Debug, Clone, PartialEq)]
pub enum V3RelayCoreError {
    StaticRegistry(String),
    EndpointPath(String),
    Target(String),
    ProviderPoolExhausted {
        attempted_candidates: Vec<String>,
    },
    /// 治理层拦截但入口无投影路径（如 openai_chat 入口遇 Mode B web-search 剥离）：
    /// 非 provider 失败，禁止进入失败重试链，骨架 fail-fast 返回。
    WebSearchIntercepted(String),
}

impl fmt::Display for V3RelayCoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            V3RelayCoreError::StaticRegistry(message) => write!(f, "static registry: {message}"),
            V3RelayCoreError::EndpointPath(message) => write!(f, "endpoint path: {message}"),
            V3RelayCoreError::Target(message) => write!(f, "target: {message}"),
            V3RelayCoreError::ProviderPoolExhausted {
                attempted_candidates,
            } => write!(f, "provider pool exhausted after {attempted_candidates:?}"),
            V3RelayCoreError::WebSearchIntercepted(message) => {
                write!(f, "web search intercepted unprojected: {message}")
            }
        }
    }
}

/// Provider attempt timeout, with the published default of five minutes.
pub(crate) fn v3_relay_transport_response_timeout_from_ms(
    request_timeout_ms: Option<u64>,
) -> std::time::Duration {
    std::time::Duration::from_millis(request_timeout_ms.filter(|&ms| ms > 0).unwrap_or(300_000))
}

#[cfg(test)]
mod response_header_timeout_contract_tests {
    use super::*;

    #[test]
    fn relay_transport_header_timeout_reads_provider_request_timeout() {
        assert_eq!(
            v3_relay_transport_response_timeout_from_ms(Some(900_000)),
            std::time::Duration::from_millis(900_000)
        );
    }

    #[test]
    fn relay_transport_header_timeout_defaults_and_zero_use_default_timeout() {
        assert_eq!(
            v3_relay_transport_response_timeout_from_ms(None),
            std::time::Duration::from_millis(300_000)
        );
        assert_eq!(
            v3_relay_transport_response_timeout_from_ms(Some(0)),
            std::time::Duration::from_millis(300_000)
        );
    }
}

pub(crate) fn v3_relay_transport_response_timeout(
    manifest: &V3Config05ManifestPublished,
    provider_id: &str,
) -> std::time::Duration {
    v3_relay_transport_response_timeout_from_ms(
        manifest
            .providers
            .get(provider_id)
            .map(|p| p.request_timeout_ms),
    )
}

/// The published SSE timeout covers both first frame and inter-frame idle time.
pub(crate) fn v3_provider_sse_idle_timeout(
    manifest: &V3Config05ManifestPublished,
    provider_id: &str,
) -> Result<std::time::Duration, String> {
    manifest.providers.get(provider_id).and_then(|provider| provider.sse_first_frame_timeout_ms)
        .filter(|timeout_ms| *timeout_ms > 0).map(std::time::Duration::from_millis)
        .ok_or_else(|| {
            format!(
                "published provider SSE first-frame/inter-frame timeout is missing for provider {provider_id}"
            )
        })
}

/// 统一的 relay provider 失败结构（替代各协议 `V3*RelayProviderFailure` 副本）。
///
/// 错误 body 形状是协议 wire 差异（gemini `error.code`、anthropic `error.type`），
/// 通过 `error_type_fn` / `error_message_fn` 提取函数指针表达；构造函数（协议本地）
/// 负责填协议形状的 body 与对应提取函数。
#[derive(Debug, Clone)]
pub struct V3RelayProviderFailure {
    pub status: u16,
    /// The upstream provider's real HTTP status; `None` when no HTTP response was
    /// received. Never the client-facing projection status.
    pub provider_status: Option<u16>,
    pub client_response: Value,
    pub source_stage: &'static str,
    pub terminal_projection: Option<V3Error06ClientProjected>,
    pub terminal_disposition: Option<routecodex_v3_error::V3ProviderTerminalDisposition>,
    pub error_operator_fault: Option<V3RelayErrorOperatorFault>,
    /// Failure-only attempt-local wire evidence transferred to the policy event.
    /// It is never read by error classification or provider health.
    pub failed_attempt_evidence: Option<Arc<V3RuntimeProviderFailedAttemptEvidence>>,
    /// 从 client_response 提取错误类型（协议形状相关）。
    pub error_type_fn: fn(&Value) -> Option<String>,
    /// 从 client_response 提取错误消息（协议形状相关）。
    pub error_message_fn: fn(&Value) -> String,
}

/// Keep a planning operator fault typed until the Relay failure output consumes
/// it. Reselection retains any preceding provider witness in the terminalizer.
pub(crate) fn provider_operator_fault_failure(
    fault: V3RelayErrorOperatorFault,
) -> V3RelayProviderFailure {
    V3RelayProviderFailure {
        status: 599,
        provider_status: None,
        client_response: Value::Null,
        source_stage: fault.policy_failure.source_stage,
        terminal_projection: None,
        terminal_disposition: None,
        error_operator_fault: Some(fault),
        failed_attempt_evidence: None,
        error_type_fn: extract_error_code_style,
        error_message_fn: extract_message_code_style,
    }
}

/// code/status 风格错误提取（gemini / openai / responses 形状：`error.code` 或 `error.status`）。
pub fn extract_error_code_style(value: &Value) -> Option<String> {
    value
        .pointer("/error/status")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/error/code").and_then(Value::as_str))
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

/// type 风格错误提取（anthropic 形状：`error.type`）。
pub fn extract_error_type_style(value: &Value) -> Option<String> {
    value
        .pointer("/error/type")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

/// code/status 风格错误消息（gemini / openai / responses 形状）。
pub fn extract_message_code_style(value: &Value) -> String {
    match value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/error/status").and_then(Value::as_str))
        .or_else(|| value.pointer("/error/code").and_then(Value::as_str))
        .filter(|value| !value.trim().is_empty())
    {
        Some(value) => value.to_string(),
        None => "provider returned HTTP error".to_string(),
    }
}

/// type 风格错误消息（anthropic 形状）。
pub fn extract_message_type_style(value: &Value) -> String {
    match value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/error/type").and_then(Value::as_str))
        .filter(|value| !value.trim().is_empty())
    {
        Some(value) => value.to_string(),
        None => "provider returned HTTP error".to_string(),
    }
}

/// server -> routing group 解析（共享版；错误以 String 表达）。
pub fn server_routing_group<'a>(
    manifest: &'a V3Config05ManifestPublished,
    server_id: &str,
) -> Result<&'a str, String> {
    manifest
        .servers
        .get(server_id)
        .map(|server| server.routing_group.as_str())
        .ok_or_else(|| format!("server {server_id} missing"))
}

/// Build the only public-facing source for an exhausted provider pool.
///
/// Candidate details stay in the typed Error01/Error02 side-channel. Error06
/// stages no client candidate for a provider terminal: the client boundary is
/// the `client_transport_break` disposition owned by Error05 and Server/SSE.
pub(crate) fn provider_pool_exhausted_source(
    source_stage: &'static str,
    attempted_candidates: &[String],
) -> crate::shared::V3DirectSourceError {
    crate::shared::direct_plain_error(
        V3ErrorSourceKind::TargetPoolExhausted,
        source_stage,
        "selected_target_exhausted",
        format!("selected target exhausted after {attempted_candidates:?}"),
    )
}

/// selected candidate -> provider target 解析（共享版）。
///
/// `expected_provider_type`：gemini runtime 传 `Some("gemini")` 以保留其 provider_type
/// 校验；其他协议传 `None`（与原实现一致）。
pub fn provider_target(
    manifest: &V3Config05ManifestPublished,
    selected: &routecodex_v3_target::V3TargetCandidate,
    expected_provider_type: Option<&str>,
) -> Result<V3ResponsesProviderTarget, String> {
    if let Some(expected) = expected_provider_type {
        if selected.provider_type != expected.to_ascii_lowercase() {
            return Err(format!(
                "no compatible {expected} provider target: selected provider {} has protocol {}",
                selected.provider_id, selected.provider_type
            ));
        }
    }
    let provider = manifest
        .providers
        .get(&selected.provider_id)
        .ok_or_else(|| "selected provider missing".to_string())?;
    let auth = provider
        .auth
        .entries
        .iter()
        .find(|entry| entry.alias == selected.auth_alias)
        .ok_or_else(|| "selected auth handle missing".to_string())?;
    let secret =
        v3_provider_auth_handle_from_manifest_entry(selected.auth_alias.clone(), auth)?.secret;
    Ok(V3ResponsesProviderTarget {
        provider_id: selected.provider_id.clone(),
        interface_id: selected.interface_id.clone(),
        provider_type: selected.provider_type.clone(),
        base_url: selected.base_url.clone(),
        canonical_model_id: selected.model_id.clone(),
        wire_model: selected.wire_model.clone(),
        compatibility_profile: selected.compatibility_profile.clone(),
        headers: provider.headers.clone(),
        auth: V3ProviderAuthHandle {
            alias: selected.auth_alias.clone(),
            secret,
        },
        responses_transport: selected.responses_transport,
        websocket_v2_url: selected.websocket_v2_url.clone(),
        provider_request_cleanup: selected.provider_request_cleanup.clone(),
        request_timeout_ms: provider.request_timeout_ms,
        sse_first_frame_timeout_ms: provider.sse_first_frame_timeout_ms,
        initial_concurrency_budget: selected.initial_concurrency_budget,
        concurrency_acquire_timeout_ms: selected.concurrency_acquire_timeout_ms,
    })
}

/// 从已选 provider 的编译 auth 类型选择业务 wire 认证载体。仅 typed Gemini
/// 协议存在非 Bearer 载体；其余显式枚举的协议保持请求不变。
pub(crate) fn bind_v3_selected_business_auth_kind(
    manifest: &V3Config05ManifestPublished,
    selected: &routecodex_v3_target::V3TargetCandidate,
    provider_protocol: V3HubProviderWireProtocol,
    request: V3Transport13ResponsesHttpRequest,
) -> Result<V3Transport13ResponsesHttpRequest, String> {
    match provider_protocol {
        V3HubProviderWireProtocol::Gemini => {
            let provider = manifest
                .providers
                .get(&selected.provider_id)
                .ok_or_else(|| "selected provider missing".to_string())?;
            Ok(request.with_gemini_auth_kind(&provider.auth.auth_type))
        }
        V3HubProviderWireProtocol::Responses
        | V3HubProviderWireProtocol::Anthropic
        | V3HubProviderWireProtocol::OpenAiChat => Ok(request),
    }
}

/// provider 失败策略执行（共享版；替代各协议 `handle_provider_failure` 副本）。
///
/// 返回 `Ok(Some(failure))` 表示 terminal（需投影输出）；`Ok(None)` 表示已重排
/// （retry_selected / pending_recovery 已更新，主循环 continue）。
pub async fn handle_provider_failure(
    context: &V3RelayProviderFailurePolicyContext<'_>,
    selected: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    mut failure: V3RelayProviderFailure,
    state: &mut V3RelayProviderFailurePolicyState<'_>,
    retry_selected: &mut Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
    pending_recovery: &mut Option<V3Error05RecoveryAdmissionWitness>,
    provider_failure_events: &mut Vec<V3RuntimeProviderFailureObservation>,
) -> Result<Option<V3RelayProviderFailure>, String> {
    if failure.terminal_projection.is_some() || failure.error_operator_fault.is_some() {
        return Ok(Some(failure));
    }
    let mut result = match run_v3_relay_provider_failure_policy(
        context,
        selected,
        failure.source_stage,
        failure.status,
        failure_error_type(&failure),
        provider_failure_message(&failure),
        None,
        state,
    )
    .await
    {
        Ok(result) => result,
        Err(Ok(error)) => return Err(error),
        Err(Err(fault)) => {
            failure.error_operator_fault = Some(fault);
            return Ok(Some(failure));
        }
    };
    result.event.provider_status = failure.provider_status;
    result.event.failed_attempt_evidence = failure.failed_attempt_evidence.clone();
    provider_failure_events
        .push(build_v3_runtime_provider_failure_observation_from_policy_event(&result.event));
    match result.decision.action {
        V3Error05ExecutionAction::WaitThenReselect { recovery } => {
            *retry_selected = result.retry_selected.map(|selected| *selected);
            if result.event.wait_ms.is_some() {
                *pending_recovery = Some(recovery);
            } else {
                *pending_recovery = None;
            }
            Ok(None)
        }
        V3Error05ExecutionAction::WaitThenRetrySame { recovery } => {
            *retry_selected = result.retry_selected.map(|selected| *selected);
            // 瞬态重试（request-local recovery witness，wait_ms=None）不经过
            // provider action gate：无 health 记录/lane 可等，立即重发。
            if result.event.wait_ms.is_some() {
                *pending_recovery = Some(recovery);
            } else {
                *pending_recovery = None;
            }
            Ok(None)
        }
        V3Error05ExecutionAction::ProjectTerminal => {
            failure.terminal_projection = result.terminal_projection;
            failure.terminal_disposition = result.terminal_disposition;
            Ok(Some(failure))
        }
        V3Error05ExecutionAction::ClientDisconnected
        | V3Error05ExecutionAction::RejectNonProviderError => {
            Err("provider failure entered a non-provider Error05 lane".to_string())
        }
    }
}

pub(crate) fn build_v3_runtime_provider_failure_observation_from_policy_event(
    event: &V3RelayProviderFailurePolicyEvent,
) -> V3RuntimeProviderFailureObservation {
    V3RuntimeProviderFailureObservation {
        provider_key: v3_relay_provider_candidate_key_parts(
            &event.candidate.provider_id,
            Some(&event.candidate.interface_id),
            Some(&event.candidate.auth_alias),
            Some(&event.candidate.model_id),
        ),
        provider_id: event.candidate.provider_id.clone(),
        auth_alias: Some(event.candidate.auth_alias.clone()),
        model_id: event.candidate.model_id.clone(),
        status: event.status,
        error_type: event.error_type.clone(),
        external_error_kind: None,
        external_error_code: event.error_type.clone(),
        // The real upstream HTTP status; `None` for a response-less failure.
        external_error_status: event.provider_status,
        internal_code: None,
        // V3RelayProviderFailurePolicyEvent does not carry the upstream request
        // id: record an honest unknown rather than a synthesised value.
        upstream_request_id: None,
        message: event.message.clone(),
        failure_count: event.health_record.failure_count,
        health_state: event.health_record.state.clone(),
        cooldown_until_ms: event.health_record.cooldown_until_ms,
        action: event.action.clone(),
        next_provider_key: event.next_provider_key.clone(),
        wait_ms: event.wait_ms,
        diagnostic_source: Some(event.diagnostic_source.clone()),
        failed_attempt_evidence: event.failed_attempt_evidence.clone(),
    }
}

/// HTTP status 失败构造（共享版；gemini/openai/responses 形状：`error.code`）。
pub fn provider_http_failure(
    status: u16,
    body: &[u8],
    _provider_id: &str,
) -> V3RelayProviderFailure {
    let body = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(_) if body.is_empty() => json!({
            "error": {
                "code": "provider_http_status",
                "message": format!("provider returned HTTP {status}")
            }
        }),
        Err(error) => json!({
            "error": {
                "code": "provider_error_body_malformed",
                "message": format!("provider returned HTTP {status} with malformed JSON error body: {error}")
            }
        }),
    };
    V3RelayProviderFailure {
        status,
        provider_status: Some(status),
        client_response: body,
        source_stage: "V3ProviderReqOutbound09TransportRequest",
        terminal_projection: None,
        terminal_disposition: None,
        error_operator_fault: None,
        failed_attempt_evidence: None,
        error_type_fn: extract_error_code_style,
        error_message_fn: extract_message_code_style,
    }
}

/// The canonical provider-terminal witness builder: the upstream HTTP response
/// is recorded losslessly whenever one was received, whatever its status.
///
/// Client-projection eligibility (bug `705d624` keeps HTTP 502 out of any
/// client response) is deliberately not part of this. Evidence capture is
/// decoupled from the rule that decides whether a client may see the response,
/// and a failed body read is recorded as such instead of erasing the status
/// and headers that were really received.
pub fn external_http_witness(response: &V3ProviderHttpFailure) -> V3ExternalHttpWitness {
    let witness = V3ExternalHttpWitness::new(
        response.status,
        response
            .headers
            .iter()
            .map(|header| (header.name.clone(), header.value.clone()))
            .collect(),
        response.body.clone(),
    );
    match response.body_read_failure.as_deref() {
        Some(reason) => witness.with_body_read_failure(reason),
        None => witness,
    }
}

/// The witness for a head that really arrived, whatever the status.
///
/// An SSE body is not materialized here, so the empty body is the truthful
/// statement that no readable bytes were captured at this instant.
fn external_http_witness_from_head(
    status: u16,
    headers: &[V3ProviderResponseHeader],
    body: Vec<u8>,
) -> V3ExternalHttpWitness {
    V3ExternalHttpWitness::new(
        status,
        headers
            .iter()
            .map(|header| (header.name.clone(), header.value.clone()))
            .collect(),
        body,
    )
}

/// The witness for a raw provider response the moment its head arrives,
/// whatever its status or body kind.
///
/// `external_http_witness` only ever sees responses that came back through the
/// transport-error path (`V3ProviderError::HttpStatus`). A stream does not: it
/// is returned as `Ok`, held for buffering, and only fails once its body has
/// been consumed. For a stream whose payload never decodes, the arrival of the
/// head is the only moment the runtime observes that upstream really answered,
/// so recording it here keeps the evidence honest: a received head is never
/// reported as `no_response`. An already-buffered JSON body is kept losslessly;
/// an SSE body is not materialized, so the empty body is the truthful statement
/// that no readable bytes were captured. A branch that can read a body replaces
/// this with the fuller witness.
///
/// Evidence capture only. It does not change client projection, provider
/// rotation, or health.
pub fn external_http_witness_head(response: &V3ProviderResp14Raw) -> V3ExternalHttpWitness {
    external_http_witness_from_head(
        response.status(),
        response.headers(),
        response.json_body().map(<[u8]>::to_vec).unwrap_or_default(),
    )
}

/// Build the witness from a provider error that carries a real response head.
///
/// Only errors raised *after* the head was read qualify: `HttpStatus`, and the
/// two failures the transport raises once it has already parsed the head
/// (`UnexpectedContentType`, `ResponseBodyUnreadable`). A genuine pre-head
/// transport failure carries no evidence and stays `None`.
pub(crate) fn external_http_witness_from_provider_error(
    error: &V3ProviderError,
) -> Option<V3ExternalHttpWitness> {
    match error {
        V3ProviderError::HttpStatus { response } => Some(external_http_witness(response)),
        V3ProviderError::UnexpectedContentType {
            status, headers, ..
        }
        | V3ProviderError::ResponseBodyUnreadable {
            status, headers, ..
        } => Some(external_http_witness_from_head(
            *status,
            headers,
            Vec::new(),
        )),
        _ => None,
    }
}

fn v3_failed_attempt_response_header_is_credential(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "authorization" | "proxy-authorization" | "x-api-key" | "api-key" | "cookie" | "set-cookie"
    )
}

fn v3_failed_attempt_json_key_is_credential(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "authorization"
            | "proxy-authorization"
            | "x-api-key"
            | "api-key"
            | "api_key"
            | "apikey"
            | "cookie"
            | "set-cookie"
            | "token"
            | "access_token"
            | "refresh_token"
            | "client_secret"
            | "password"
            | "secret"
    )
}

fn redact_v3_failed_attempt_json(value: &mut Value) -> bool {
    match value {
        Value::Object(fields) => {
            let mut changed = false;
            for (name, field) in fields.iter_mut() {
                if v3_failed_attempt_json_key_is_credential(name) {
                    changed |= field.as_str() != Some("[REDACTED]");
                    *field = Value::String("[REDACTED]".to_string());
                } else {
                    changed |= redact_v3_failed_attempt_json(field);
                }
            }
            changed
        }
        Value::Array(values) => values.iter_mut().fold(false, |changed, value| {
            changed | redact_v3_failed_attempt_json(value)
        }),
        _ => false,
    }
}

fn project_v3_failed_attempt_response(
    status: u16,
    headers: &[V3ProviderResponseHeader],
    body: &[u8],
    body_read_failure: Option<&str>,
) -> Value {
    let headers = headers
        .iter()
        .map(|header| {
            let name = header.name.clone();
            let value = if v3_failed_attempt_response_header_is_credential(&name) {
                "[REDACTED]".to_string()
            } else {
                String::from_utf8_lossy(&header.value).to_string()
            };
            json!({"name": name, "value": value})
        })
        .collect::<Vec<Value>>();
    let (body_bytes, redacted) = match serde_json::from_slice::<Value>(body) {
        Ok(mut value) => {
            if redact_v3_failed_attempt_json(&mut value) {
                let bytes = serde_json::to_vec(&value).unwrap_or_else(|_| {
                    b"[REDACTED: failed-attempt body serialization failed]".to_vec()
                });
                (bytes, true)
            } else {
                (body.to_vec(), false)
            }
        }
        Err(_) => (body.to_vec(), false),
    };
    json!({
        "kind": "external_http",
        "status": status,
        "headers": headers,
        "body": {
            "bytes": body_bytes,
            "redacted": redacted,
        },
        "body_read_failure": body_read_failure,
    })
}

pub(crate) fn build_v3_runtime_provider_failed_attempt_evidence_from_response(
    attempt: usize,
    provider_request: Option<Value>,
    status: u16,
    headers: &[V3ProviderResponseHeader],
    body: &[u8],
    body_read_failure: Option<&str>,
) -> Arc<V3RuntimeProviderFailedAttemptEvidence> {
    Arc::new(V3RuntimeProviderFailedAttemptEvidence {
        attempt,
        provider_request,
        provider_response: project_v3_failed_attempt_response(
            status,
            headers,
            body,
            body_read_failure,
        ),
    })
}

pub(crate) fn build_v3_runtime_provider_failed_attempt_evidence_no_response(
    attempt: usize,
    provider_request: Option<Value>,
) -> Arc<V3RuntimeProviderFailedAttemptEvidence> {
    Arc::new(V3RuntimeProviderFailedAttemptEvidence {
        attempt,
        provider_request,
        provider_response: json!({"kind": "no_response"}),
    })
}

pub(crate) fn build_v3_runtime_provider_failed_attempt_evidence_from_error(
    attempt: usize,
    provider_request: Option<Value>,
    error: &V3ProviderError,
) -> Option<Arc<V3RuntimeProviderFailedAttemptEvidence>> {
    match error {
        V3ProviderError::HttpStatus { response } => Some(
            build_v3_runtime_provider_failed_attempt_evidence_from_response(
                attempt,
                provider_request,
                response.status,
                &response.headers,
                &response.body,
                response.body_read_failure.as_deref(),
            ),
        ),
        V3ProviderError::UnexpectedContentType {
            status, headers, ..
        } => Some(
            build_v3_runtime_provider_failed_attempt_evidence_from_response(
                attempt,
                provider_request,
                *status,
                headers,
                &[],
                None,
            ),
        ),
        V3ProviderError::ResponseBodyUnreadable {
            status,
            headers,
            reason,
            ..
        } => Some(
            build_v3_runtime_provider_failed_attempt_evidence_from_response(
                attempt,
                provider_request,
                *status,
                headers,
                &[],
                Some(reason),
            ),
        ),
        V3ProviderError::Transport { .. }
        | V3ProviderError::InternalTransport { .. }
        | V3ProviderError::WebSocketTransport { .. }
        | V3ProviderError::WebSocketProtocol { .. } => Some(
            build_v3_runtime_provider_failed_attempt_evidence_no_response(
                attempt,
                provider_request,
            ),
        ),
        _ => None,
    }
}

/// Preserve the received upstream status while recording that its body read
/// failed. This remains a provider failure, never a complete HTTP witness.
pub fn provider_http_body_read_failure(
    response: &V3ProviderHttpFailure,
    provider_id: &str,
) -> V3RelayProviderFailure {
    let reason = response
        .body_read_failure
        .as_deref()
        .expect("body read failure helper requires a failed read");
    let mut failure = provider_runtime_failure(
        V3ProviderError::ResponseBody {
            request_id: response.request_id.clone(),
            provider_id: provider_id.to_string(),
            reason: format!(
                "provider HTTP {} error body read failed: {reason}",
                response.status
            ),
        },
        provider_id,
    );
    failure.status = response.status;
    // The upstream did return an HTTP status; only its error body could not be
    // read, so the real status still belongs in `provider_status`.
    failure.provider_status = Some(response.status);
    failure
}

/// 请求构造失败（共享版；gemini/openai/responses 形状）。
pub fn provider_request_failure(
    source_stage: &'static str,
    error_type: &'static str,
    error: impl std::fmt::Display,
) -> V3RelayProviderFailure {
    V3RelayProviderFailure {
        status: 502,
        // Request-construction failure: no upstream HTTP response exists.
        provider_status: None,
        client_response: json!({"error":{"code":error_type,"message":error.to_string()}}),
        source_stage,
        terminal_projection: None,
        terminal_disposition: None,
        error_operator_fault: None,
        failed_attempt_evidence: None,
        error_type_fn: extract_error_code_style,
        error_message_fn: extract_message_code_style,
    }
}

/// provider 运行时失败（共享版；gemini/openai/responses 形状；client_disconnect
/// 仍 health-neutral 投影 499）。
pub fn provider_runtime_failure(
    error: V3ProviderError,
    provider_id: &str,
) -> V3RelayProviderFailure {
    if let V3ProviderError::InternalTransport { lane, .. } = &error {
        let source_stage = match lane {
            routecodex_v3_provider_responses::V3ProviderInternalTransportLane::Request => {
                "V3ProviderReqOutbound09TransportRequest"
            }
            routecodex_v3_provider_responses::V3ProviderInternalTransportLane::Response => {
                "V3ProviderRespInbound01Raw"
            }
        };
        let fallback_message = error.to_string();
        let source = crate::hooks::build_v3_provider_error_source(source_stage, error);
        return match source.and_then(|source| {
            crate::provider_failure_runtime_policy::project_v3_relay_error_source(
                source,
                V3ErrorActionScope::None,
                0,
                None,
            )
        }) {
            Ok(projected) => V3RelayProviderFailure {
                status: projected.status,
                // Internal transport handoff failure: no upstream HTTP response exists.
                provider_status: None,
                client_response: json!({
                    "error": {
                        "code": "provider_internal_transport_error",
                        "message": projected.error_detail
                    }
                }),
                source_stage,
                terminal_projection: Some(projected),
                terminal_disposition: None,
                error_operator_fault: None,
                failed_attempt_evidence: None,
                error_type_fn: extract_error_code_style,
                error_message_fn: extract_message_code_style,
            },
            Err(fault) => V3RelayProviderFailure {
                status: 599,
                provider_status: None,
                client_response: json!({
                    "error": {
                        "code": "provider_internal_transport_error",
                        "message": fallback_message
                    }
                }),
                source_stage,
                terminal_projection: None,
                terminal_disposition: Some(
                    routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse,
                ),
                error_operator_fault: Some(fault),
                failed_attempt_evidence: None,
                error_type_fn: extract_error_code_style,
                error_message_fn: extract_message_code_style,
            },
        };
    }
    let error_code = match &error {
        V3ProviderError::Transport { reason, .. }
            if routecodex_v3_error::is_v3_provider_response_header_timeout_reason(reason) =>
        {
            V3_TRANSIENT_TRANSPORT_HANG_CODE
        }
        // SSE 已经完成 provider response inbound 的协议判定；把这个语义错误码
        // 保留下游，健康策略才能把它和 transport hang 区分开。不能降成通用
        // provider_error，否则 relay 会按 transient 同 provider 重试后直接投影给客户端。
        V3ProviderError::MalformedSse { .. } => "provider_response_sse_event_invalid",
        _ => "provider_error",
    };
    let (terminal_projection, error_operator_fault) =
        if matches!(&error, V3ProviderError::ClientDisconnect { .. }) {
            match project_v3_client_disconnect(
                provider_id,
                provider_runtime_failure_stage(&error),
                error.to_string(),
            ) {
                Ok(projected) => (Some(projected), None),
                Err(fault) => (None, Some(fault)),
            }
        } else {
            (None, None)
        };
    V3RelayProviderFailure {
        status: if terminal_projection.is_some() {
            499
        } else {
            502
        },
        // Only a real upstream HTTP status may be recorded here; a transport or
        // other response-less failure stays `None` instead of the projected 502.
        provider_status: match &error {
            V3ProviderError::HttpStatus { response } => Some(response.status),
            _ => None,
        },
        client_response: json!({"error":{"code":error_code,"message":error.to_string()}}),
        source_stage: provider_runtime_failure_stage(&error),
        terminal_projection,
        terminal_disposition: None,
        error_operator_fault,
        failed_attempt_evidence: None,
        error_type_fn: extract_error_code_style,
        error_message_fn: extract_message_code_style,
    }
}

/// 从 failure 提取 error type（共享版；走协议提取函数字段）。
pub fn failure_error_type(failure: &V3RelayProviderFailure) -> Option<String> {
    (failure.error_type_fn)(&failure.client_response)
}

/// 从 failure 提取错误消息（共享版；走协议提取函数字段）。
pub fn provider_failure_message(failure: &V3RelayProviderFailure) -> String {
    (failure.error_message_fn)(&failure.client_response)
}

/// Provider failure that consumed the request residence budget must still be
/// projected through the typed Error01-06 chain before the relay loop exits.
pub fn terminalize_provider_failure_with_source(
    mut failure: V3RelayProviderFailure,
    source: Option<routecodex_v3_error::V3Error01SourceRaised>,
    last_external_http: Option<routecodex_v3_error::V3ExternalHttpWitness>,
) -> V3RelayProviderFailure {
    let Some(source) = source else {
        return terminalize_provider_failure(failure, last_external_http);
    };
    if failure.terminal_projection.is_some() {
        return failure;
    }
    if failure.terminal_disposition.is_none() {
        failure.terminal_disposition = Some(match last_external_http {
            Some(witness) => {
                routecodex_v3_error::V3ProviderTerminalDisposition::ExternalHttp(witness)
            }
            None => routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse,
        });
    }
    if failure.error_operator_fault.is_some() {
        return failure;
    }
    failure.client_response = json!({
        "error": {
            "code": source.code.clone(),
            "message": source.message.clone(),
        }
    });
    match crate::provider_failure_runtime_policy::project_v3_relay_error_source(
        source,
        V3ErrorActionScope::None,
        0,
        None,
    ) {
        Ok(projected) => failure.terminal_projection = Some(projected),
        Err(fault) => failure.error_operator_fault = Some(fault),
    }
    failure
}

pub fn terminalize_provider_failure(
    mut failure: V3RelayProviderFailure,
    last_external_http: Option<routecodex_v3_error::V3ExternalHttpWitness>,
) -> V3RelayProviderFailure {
    if failure.terminal_projection.is_some() {
        return failure;
    }
    if failure.terminal_disposition.is_none() {
        failure.terminal_disposition = Some(match last_external_http {
            Some(witness) => {
                routecodex_v3_error::V3ProviderTerminalDisposition::ExternalHttp(witness)
            }
            None => routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse,
        });
    }
    if failure.error_operator_fault.is_some() {
        return failure;
    }
    let source = crate::shared::direct_source_error(
        V3ErrorSourceKind::ProviderFailure,
        failure.source_stage,
        failure_error_type(&failure)
            .as_deref()
            .unwrap_or("provider_error"),
        provider_failure_message(&failure),
        match failure.provider_status {
            Some(status) => {
                crate::operation_runner::V3Err01SourceInput::External(V3ExternalErrorLink {
                    kind: V3ExternalErrorKind::Provider,
                    status: Some(status),
                    code: failure_error_type(&failure),
                    provider_id: None,
                    upstream_request_id: None,
                    message: Some(provider_failure_message(&failure)),
                })
            }
            None => crate::operation_runner::V3Err01SourceInput::Plain,
        },
    );
    let source = match source {
        Ok(source) => source,
        Err(fault) => {
            failure.error_operator_fault = Some(fault);
            return failure;
        }
    };
    match crate::provider_failure_runtime_policy::project_v3_relay_error_source(
        source,
        V3ErrorActionScope::None,
        0,
        None,
    ) {
        Ok(projected) => failure.terminal_projection = Some(projected),
        Err(fault) => failure.error_operator_fault = Some(fault),
    }
    failure
}

/// SSE 响应链 trace 节点（共享版；替代各 runtime 的本地副本）。
pub fn push_sse_response_chain_trace(trace: &mut Vec<&'static str>) {
    trace.extend([
        "V3ProviderRespInbound01Raw",
        "ProviderRespCompat02ProviderCompat",
        "V3HubRespInbound02Normalized",
        "V3HubRespChatProcess03Governed",
        "V3HubRespOutbound05ClientSemantic",
        "V3ServerRespOutbound06ClientFrame",
    ]);
}

/// Error06 投影输出（共享版；返回 (projected, trace)，runtime 组装自身 Output）。
pub fn error_output(
    source: routecodex_v3_error::V3Error01SourceRaised,
    status: u16,
    provider_id: &str,
    mut trace: Vec<&'static str>,
) -> (
    Result<
        V3Error06ClientProjected,
        crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault,
    >,
    Vec<&'static str>,
) {
    let projected = crate::provider_failure_runtime_policy::project_v3_relay_error_source(
        source,
        V3ErrorActionScope::ProviderInstance {
            provider_id: provider_id.to_string(),
        },
        0,
        Some(status),
    );
    if projected.is_ok() {
        trace.extend(V3_ERROR_CHAIN_NODE_IDS);
    }
    (projected, trace)
}

/// 唯一共享 relay observability 构建器：Responses / OpenAI Chat / Anthropic /
/// Gemini 四个 relay runtime 统一从这里构造 `V3RuntimeObservability`，禁止各
/// runtime 各自复制字段映射。只写入 typed observability 侧信道，绝不进入业务
/// payload；Server 负责人类可读 console 投影。
pub(crate) fn build_v3_relay_observability(
    entry_protocol: &str,
    selected: &V3Target10ConcreteProviderSelected,
    transport: &str,
) -> V3RuntimeObservability {
    V3RuntimeObservability {
        entry_protocol: entry_protocol.to_string(),
        execution_mode: "relay".to_string(),
        transport: transport.to_string(),
        routing_group_id: Some(selected.route.routing_group_id.clone()),
        route_classification_reason: Some(selected.route.route_classification_reason.clone()),
        pool_id: Some(selected.route.pool_id.clone()),
        provider_id: Some(selected.candidate.provider_id.clone()),
        auth_alias: Some(selected.candidate.auth_alias.clone()),
        provider_key: Some(format!(
            "{}:{}:{}:{}",
            selected.candidate.provider_id,
            selected.candidate.interface_id,
            selected.candidate.auth_alias,
            selected.candidate.model_id
        )),
        provider_type: Some(selected.candidate.provider_type.clone()),
        model_id: Some(selected.candidate.model_id.clone()),
        wire_model: Some(selected.candidate.wire_model.clone()),
        provider_status: None,
        response_status: None,
        finish_reason: None,
        attempts: Some(selected.attempts),
        unavailable_candidates: selected.unavailable_candidates.clone(),
        provider_failure_events: Vec::new(),
        target_path: selected.candidate.path.clone(),
        usage: None,
        timing: None,
    }
}

/// Chat / Gemini relay 客户端 SSE 流类型。
pub(crate) type V3RelayClientSseStream =
    Pin<Box<dyn futures_util::Stream<Item = Result<Vec<u8>, String>> + Send>>;
pub(crate) type V3RelayProjectedSseStream = V3RelayClientSseStream;
/// A provider attempt may cross the Broker -> Front boundary only after its
/// complete projected stream has been validated.  The committed stream is
/// therefore infallible: provider failures remain in Error01 -> Error05 and
/// cannot be observed as a client SSE item or EOF.
pub(crate) type V3RelayCommittedSseStream = crate::nodes::V3CommittedClientSseStream;

/// 客户端 SSE usage 观测包装：逐帧解码客户端协议 wire（openai_chat chunk /
/// gemini chunk），把 usage / finish_reason 写入 typed stream observation；
/// chat/gemini wire 无 `status` 字段，语义 finish_reason 出现即推导
/// `completed` 终态。只观测，不改写任何业务字节。输入允许任意满足同一
/// 字节流契约的流类型（codec 投影后的关联类型），内部统一装箱为共享
/// `V3RelayClientSseStream`。
pub(crate) fn wrap_v3_relay_client_sse_usage_observation<S>(
    stream: S,
    protocol: V3HubEntryProtocol,
    observation: V3RuntimeStreamObservation,
) -> V3RelayClientSseStream
where
    S: futures_util::Stream<Item = Result<Vec<u8>, String>> + Send + 'static,
{
    struct StreamState {
        stream: V3RelayClientSseStream,
        decoder: SseIncrementalDecoder,
        observation: V3RuntimeStreamObservation,
        done: bool,
    }

    Box::pin(futures_util::stream::unfold(
        StreamState {
            stream: Box::pin(stream),
            decoder: SseIncrementalDecoder::new(SseTransportLimits::default()),
            observation,
            done: false,
        },
        move |mut state| async move {
            if state.done {
                return None;
            }
            match state.stream.next().await {
                Some(Ok(chunk)) => {
                    let result = observe_relay_client_sse_usage_chunk(
                        &chunk,
                        protocol,
                        &mut state.decoder,
                        &state.observation,
                    );
                    match result {
                        Ok(()) => Some((Ok(chunk), state)),
                        Err(error) => {
                            state.done = true;
                            Some((Err(error), state))
                        }
                    }
                }
                Some(Err(error)) => {
                    state.done = true;
                    Some((Err(error), state))
                }
                None => {
                    state.done = true;
                    let decoder = std::mem::replace(
                        &mut state.decoder,
                        SseIncrementalDecoder::new(SseTransportLimits::default()),
                    );
                    match decoder.finish() {
                        Ok(()) => None,
                        Err(error) => Some((Err(error.to_string()), state)),
                    }
                }
            }
        },
    ))
}

fn observe_relay_client_sse_usage_chunk(
    chunk: &[u8],
    protocol: V3HubEntryProtocol,
    decoder: &mut SseIncrementalDecoder,
    observation: &V3RuntimeStreamObservation,
) -> Result<(), String> {
    let frames = decoder
        .push(build_v3_sse_transport_in_01_raw_chunk(chunk))
        .map_err(|error| error.to_string())?;
    for frame in frames {
        let object = crate::sse_object_pipeline::SseObjectFrame::from_frame(&frame);
        if object.is_done() || !object.has_data() {
            continue;
        }
        if !object.is_json_valid() {
            return Err("relay client SSE data is not valid JSON".to_owned());
        }
        let Some(event) = object.data_value() else {
            continue;
        };
        if !event.is_object() {
            continue;
        }
        match protocol {
            V3HubEntryProtocol::Responses => {
                let mut normalized = event.clone();
                crate::hub_v1::normalize_v3_responses_function_call_arguments(&mut normalized)?;
                let semantic = crate::hub_v1::classify_v3_responses_sse_event(&normalized)
                    .map_err(|error| error.to_string())?;
                observation.record_typed_object_type("responses", &semantic.protocol.event_type)?;
                observation.record_provider_event_json(&semantic.to_normalized_value())?;
            }
            V3HubEntryProtocol::OpenAiChat => {
                let semantic = crate::hub_v1::classify_v3_openai_chat_sse_chunk(event)
                    .map_err(|error| error.to_string())?;
                observation.record_typed_object_type("openai_chat", &semantic.protocol.object)?;
                observation.record_provider_event_json(&semantic.to_normalized_value())?;
            }
            V3HubEntryProtocol::Anthropic | V3HubEntryProtocol::Gemini => {
                // These client projections remain outside the current Responses/Chat
                // migration scope. They still use the independent transport object;
                // their protocol semantic migration is a later owner transition.
                observation.record_provider_event_json(event)?;
                if matches!(protocol, V3HubEntryProtocol::Gemini)
                    && super::v3_gemini_prompt_feedback_is_terminal(event)
                {
                    observation
                        .record_semantic_terminal(super::V3RuntimeSemanticTerminal::Success)?;
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn relay_handoff_entry_state(
    handoff: Option<&crate::V3ResponsesProtocolRelayHandoff>,
) -> (
    crate::runtime_timing::V3RuntimeTimingState,
    std::collections::BTreeSet<String>,
    std::collections::BTreeSet<String>,
    Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
) {
    match handoff {
        Some(handoff) => (
            handoff.observability_accumulator.timing(),
            handoff.request_local_excluded_candidates.clone(),
            handoff.request_local_busy_candidates.clone(),
            Some(handoff.target.clone()),
        ),
        None => (
            crate::runtime_timing::V3RuntimeTimingState::start(),
            std::collections::BTreeSet::new(),
            std::collections::BTreeSet::new(),
            None,
        ),
    }
}

pub(crate) fn relay_request_execution_control(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    handoff: Option<&crate::V3ResponsesProtocolRelayHandoff>,
) -> Result<crate::nodes::V3RequestExecutionControl, V3RelayCoreError> {
    match handoff {
        Some(handoff) => Ok(handoff.request_execution_control.clone()),
        None => crate::nodes::V3RequestExecutionControl::from_manifest(manifest, server_id)
            .map_err(|error| {
                V3RelayCoreError::Target(format!(
                    "V3ExecutionAttemptBudget rejected relay request: {error}"
                ))
            }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;

    #[test]
    fn incomplete_provider_http_error_body_is_not_an_external_http_witness() {
        let response = routecodex_v3_provider_responses::V3ProviderHttpFailure {
            request_id: "req-body-read".into(),
            provider_id: "provider-a".into(),
            status: 429,
            headers: vec![],
            body: vec![],
            body_read_failure: Some("connection closed while reading body".into()),
        };
        let witness = external_http_witness(&response);
        // The response head was received, so the status is real evidence even
        // though the body read failed.
        assert_eq!(witness.status(), 429);
        assert_eq!(
            witness.body_read_failure(),
            Some("connection closed while reading body")
        );
        let failure = provider_http_body_read_failure(&response, "provider-a");
        assert_eq!(failure.status, 429);
        // The upstream did return HTTP 429; only its error body read failed.
        assert_eq!(failure.provider_status, Some(429));
        assert!(provider_failure_message(&failure).contains("connection closed while reading body"));
        assert!(failure.terminal_disposition.is_none());
    }

    #[test]
    fn incomplete_http_body_records_the_new_response_head() {
        let prior = V3ExternalHttpWitness::new(429, vec![], b"rate limited".to_vec());
        let incomplete = V3ProviderHttpFailure {
            request_id: "req-next".into(),
            provider_id: "provider-b".into(),
            status: 400,
            headers: vec![],
            body: vec![],
            body_read_failure: Some("truncated body".into()),
        };
        let last = Some(external_http_witness(&incomplete));
        let latest = last.expect("the new response head is real evidence");
        assert_eq!(latest.status(), 400);
        assert_eq!(latest.body_read_failure(), Some("truncated body"));
        assert_ne!(latest, prior);
    }

    #[test]
    fn internal_transport_terminalization_keeps_typed_error_without_no_response() {
        let failure = provider_runtime_failure(
            V3ProviderError::InternalTransport {
                request_id: "req-internal".into(),
                provider_id: "provider-a".into(),
                lane: routecodex_v3_provider_responses::V3ProviderInternalTransportLane::Request,
                reason: "admission lease mismatch".into(),
            },
            "provider-a",
        );
        let terminal = terminalize_provider_failure(failure, None);
        assert_eq!(
            terminal.terminal_projection.as_ref().map(|p| p.status),
            Some(598)
        );
        assert!(terminal.terminal_disposition.is_none());
    }

    #[test]
    fn internal_transport_runtime_failure_executes_sdk_error_02_to_06() {
        for (lane, source_stage, sdk_source_stage, expected_status) in [
            (
                routecodex_v3_provider_responses::V3ProviderInternalTransportLane::Request,
                "V3ProviderReqOutbound09TransportRequest",
                "V3Transport13ResponsesHttpRequest",
                598,
            ),
            (
                routecodex_v3_provider_responses::V3ProviderInternalTransportLane::Response,
                "V3ProviderRespInbound01Raw",
                "V3ProviderResp14Raw",
                599,
            ),
        ] {
            let failure = provider_runtime_failure(
                V3ProviderError::InternalTransport {
                    request_id: format!("req-internal-{expected_status}"),
                    provider_id: "provider-a".to_string(),
                    lane,
                    reason: format!("internal transport lane {expected_status}"),
                },
                "provider-a",
            );
            assert_eq!(failure.status, expected_status);
            assert_eq!(failure.source_stage, source_stage);
            assert_eq!(failure.provider_status, None);
            assert!(failure.terminal_disposition.is_none());
            assert!(failure.error_operator_fault.is_none());
            let projection = failure
                .terminal_projection
                .expect("InternalTransport must retain the SDK Error06 projection");
            assert_eq!(projection.status, expected_status);
            assert_eq!(projection.chain, V3_ERROR_CHAIN_NODE_IDS);
            assert_eq!(
                projection.diagnostic_source.source_kind,
                V3ErrorSourceKind::RuntimeFailure
            );
            assert_eq!(projection.diagnostic_source.source_stage, sdk_source_stage);
            assert_eq!(
                projection.diagnostic_source.code,
                "provider_internal_transport_error"
            );
            assert_eq!(projection.error_class, "runtime_failure");
            assert_eq!(
                failure.client_response["error"]["message"],
                projection.error_detail
            );
        }
    }

    fn observe_one(
        protocol: V3HubEntryProtocol,
        data: &str,
        observation: &V3RuntimeStreamObservation,
    ) -> Result<(), String> {
        let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
        let chunk = format!("data: {data}\n\n");
        observe_relay_client_sse_usage_chunk(chunk.as_bytes(), protocol, &mut decoder, observation)
    }

    #[test]
    fn relay_client_observation_uses_responses_typed_tree() {
        let observation = V3RuntimeStreamObservation::default();
        observe_one(
            V3HubEntryProtocol::Responses,
            r#"{"type":"response.output_text.delta","response_id":"resp_1","item_id":"msg_1","output_index":0,"content_index":0,"delta":"hello"}"#,
            &observation,
        )
        .unwrap();
        assert_eq!(
            observation.snapshot().unwrap().typed_object_types,
            vec!["responses:response.output_text.delta"]
        );
    }

    #[test]
    fn relay_client_observation_uses_chat_typed_tree() {
        let observation = V3RuntimeStreamObservation::default();
        observe_one(
            V3HubEntryProtocol::OpenAiChat,
            r#"{"object":"chat.completion.chunk","id":"chat_1","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}"#,
            &observation,
        )
        .unwrap();
        assert_eq!(
            observation.snapshot().unwrap().typed_object_types,
            vec!["openai_chat:chat.completion.chunk"]
        );
    }

    #[test]
    fn relay_stream_observation_retains_provider_raw_sse_side_channel() {
        let observation = V3RuntimeStreamObservation::default();
        observation
            .record_provider_raw_sse_chunk(b"event: response.output_text.delta\n\n")
            .unwrap();
        let snapshot = observation.snapshot().unwrap();
        assert_eq!(
            snapshot.provider_raw_sse,
            "event: response.output_text.delta\n\n"
        );
    }

    #[test]
    fn relay_client_observation_rejects_malformed_typed_payload() {
        let observation = V3RuntimeStreamObservation::default();
        let error =
            observe_one(V3HubEntryProtocol::Responses, "not-json", &observation).unwrap_err();
        assert!(error.contains("not valid JSON"));
    }

    #[tokio::test]
    async fn relay_client_observation_exports_unterminated_frame_at_eof() {
        let observation = V3RuntimeStreamObservation::default();
        let source = futures_util::stream::iter(vec![Ok(b"data: {".to_vec())]);
        let mut wrapped = wrap_v3_relay_client_sse_usage_observation(
            source,
            V3HubEntryProtocol::Responses,
            observation,
        );
        assert!(wrapped.next().await.unwrap().is_ok());
        let error = wrapped.next().await.unwrap().unwrap_err();
        assert!(error.contains("final frame delimiter"));
        assert!(wrapped.next().await.is_none());
    }

    #[test]
    fn terminalizer_retains_full_http_witness_with_and_without_sdk_fault() {
        for status in [200, 429] {
            let witness = routecodex_v3_error::V3ExternalHttpWitness::new(
                status,
                vec![("x-provider-trace".to_string(), b"trace-a".to_vec())],
                b"provider-private-body".to_vec(),
            )
            .with_body_read_failure("truncated provider body");
            for sdk_fault in [false, true] {
                let mut failure = provider_runtime_failure(
                    V3ProviderError::Transport {
                        request_id: "req-terminal-witness".to_string(),
                        provider_id: "provider-a".to_string(),
                        reason: "residence budget exhausted".to_string(),
                    },
                    "provider-a",
                );
                if sdk_fault {
                    let source = routecodex_v3_error::build_v3_error_01_source_raised(
                        V3ErrorSourceKind::ProviderFailure,
                        failure.source_stage,
                        "provider_error",
                        "residence budget exhausted",
                    );
                    failure = provider_operator_fault_failure(
                        crate::provider_failure_runtime_policy::finish_v3_relay_error_projection(
                            source,
                            Ok(None),
                        )
                        .expect_err("missing Error06 is a typed SDK fault"),
                    );
                }
                let terminal = terminalize_provider_failure(failure, Some(witness.clone()));
                assert_eq!(
                    terminal.terminal_disposition,
                    Some(
                        routecodex_v3_error::V3ProviderTerminalDisposition::ExternalHttp(
                            witness.clone()
                        )
                    )
                );
                if sdk_fault {
                    assert!(terminal.terminal_projection.is_none());
                    assert!(terminal.error_operator_fault.is_some());
                } else {
                    assert_eq!(terminal.terminal_projection.unwrap().status, 502);
                    assert!(terminal.error_operator_fault.is_none());
                }
            }
        }
    }

    #[test]
    fn terminalizer_preserves_upstream_http_link_in_error01_source() {
        let failure = provider_http_failure(
            429,
            br#"{"error":{"code":"rate_limit_error","message":"slow down"}}"#,
            "provider-a",
        );
        let terminal = terminalize_provider_failure(failure, None);
        let projection = terminal
            .terminal_projection
            .expect("terminalized provider failure must carry Error06 projection");
        let external = projection
            .diagnostic_source
            .external_error
            .expect("a real provider HTTP status must stay linked in Error01");
        assert_eq!(
            external.kind,
            routecodex_v3_error::V3ExternalErrorKind::Provider
        );
        assert_eq!(external.status, Some(429));
        assert_eq!(external.code.as_deref(), Some("rate_limit_error"));
        assert_eq!(external.message.as_deref(), Some("slow down"));
    }

    #[test]
    fn terminalized_provider_failure_has_no_fabricated_provider_scope() {
        let failure = provider_runtime_failure(
            V3ProviderError::Transport {
                request_id: "req-terminalized-scope".to_string(),
                provider_id: "provider-a".to_string(),
                reason: "provider SSE attempt exceeded the request residence deadline".to_string(),
            },
            "provider-a",
        );
        let projection = terminalize_provider_failure(failure, None)
            .terminal_projection
            .expect("terminalized provider failure must carry Error06 projection");
        assert!(projection.health_action.is_none());
        assert!(!serde_json::to_string(&projection)
            .unwrap()
            .contains("\"provider_id\":\"none\""));
    }
}
