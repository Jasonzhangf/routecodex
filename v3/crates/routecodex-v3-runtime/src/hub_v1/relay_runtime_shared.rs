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

use crate::provider_failure_runtime_policy::{
    project_v3_client_disconnect, provider_runtime_failure_stage,
    run_v3_relay_provider_failure_policy, V3RelayProviderFailurePolicyContext,
    V3RelayProviderFailurePolicyState,
};
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{
    V3Error05ExecutionAction, V3Error05RecoveryAdmissionWitness, V3Error06ClientProjected,
    V3ErrorActionScope, V3ErrorHandlingCenter, V3ErrorHandlingCenterInput, V3_ERROR_CHAIN_NODE_IDS,
};
use routecodex_v3_provider_responses::{
    V3ProviderAuthHandle, V3ProviderAuthSecretHandle, V3ProviderError, V3ResponsesProviderTarget,
};
use serde_json::{json, Value};

/// 统一的 relay provider 失败结构（替代各协议 `V3*RelayProviderFailure` 副本）。
///
/// 错误 body 形状是协议 wire 差异（gemini `error.code`、anthropic `error.type`），
/// 通过 `error_type_fn` / `error_message_fn` 提取函数指针表达；构造函数（协议本地）
/// 负责填协议形状的 body 与对应提取函数。
#[derive(Debug, Clone)]
pub struct V3RelayProviderFailure {
    pub status: u16,
    pub client_response: Value,
    pub source_stage: &'static str,
    pub terminal_projection: Option<V3Error06ClientProjected>,
    /// 从 client_response 提取错误类型（协议形状相关）。
    pub error_type_fn: fn(&Value) -> Option<String>,
    /// 从 client_response 提取错误消息（协议形状相关）。
    pub error_message_fn: fn(&Value) -> String,
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
    let secret = match (&auth.env, &auth.token_file, &auth.api_key) {
        (Some(env), None, None) => V3ProviderAuthSecretHandle::Environment(env.clone()),
        (None, Some(path), None) => V3ProviderAuthSecretHandle::TokenFile(path.clone()),
        (None, None, Some(value)) => V3ProviderAuthSecretHandle::ApiKey(value.clone()),
        _ => return Err("selected auth handle is invalid".to_string()),
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
        provider_request_cleanup: selected.provider_request_cleanup.clone(),
        request_timeout_ms: provider.request_timeout_ms,
        initial_concurrency_budget: selected.initial_concurrency_budget,
    })
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
) -> Result<Option<V3RelayProviderFailure>, String> {
    if failure.terminal_projection.is_some() {
        return Ok(Some(failure));
    }
    let result = run_v3_relay_provider_failure_policy(
        context,
        selected,
        failure.source_stage,
        failure.status,
        failure_error_type(&failure),
        provider_failure_message(&failure),
        state,
    )
    .await
    .map_err(|error| error.to_string())?;
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
            *pending_recovery = Some(recovery);
            Ok(None)
        }
        V3Error05ExecutionAction::ProjectTerminal => {
            failure.terminal_projection = result.terminal_projection;
            Ok(Some(failure))
        }
        V3Error05ExecutionAction::ClientDisconnected
        | V3Error05ExecutionAction::RejectNonProviderError => {
            Err("provider failure entered a non-provider Error05 lane".to_string())
        }
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
        Err(error) => json!({
            "error": {
                "code": "provider_error_body_malformed",
                "message": format!("provider returned HTTP {status} with malformed JSON error body: {error}")
            }
        }),
    };
    V3RelayProviderFailure {
        status,
        client_response: body,
        source_stage: "V3ProviderReqOutbound09TransportRequest",
        terminal_projection: None,
        error_type_fn: extract_error_code_style,
        error_message_fn: extract_message_code_style,
    }
}

/// 请求构造失败（共享版；gemini/openai/responses 形状）。
pub fn provider_request_failure(
    source_stage: &'static str,
    error_type: &'static str,
    error: impl std::fmt::Display,
) -> V3RelayProviderFailure {
    V3RelayProviderFailure {
        status: 502,
        client_response: json!({"error":{"code":error_type,"message":error.to_string()}}),
        source_stage,
        terminal_projection: None,
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
    let terminal_projection =
        matches!(&error, V3ProviderError::ClientDisconnect { .. }).then(|| {
            project_v3_client_disconnect(
                provider_id,
                provider_runtime_failure_stage(&error),
                error.to_string(),
            )
        });
    V3RelayProviderFailure {
        status: if terminal_projection.is_some() {
            499
        } else {
            502
        },
        client_response: json!({"error":{"code":"provider_error","message":error.to_string()}}),
        source_stage: provider_runtime_failure_stage(&error),
        terminal_projection,
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

/// SSE 响应链 trace 节点（共享版；替代各 runtime 的本地副本）。
pub fn push_sse_response_chain_trace(trace: &mut Vec<&'static str>) {
    trace.extend([
        "V3ProviderRespInbound01Raw",
        "ProviderRespCompat02ProviderCompat",
        "V3HubRespInbound02Normalized",
        "V3HubRespChatProcess03Governed",
        "V3HubRespContinuation04Committed",
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
) -> (V3Error06ClientProjected, Vec<&'static str>) {
    let projected = V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
        source,
        action_scope: V3ErrorActionScope::ProviderInstance {
            provider_id: provider_id.to_string(),
        },
        candidates_remaining: 0,
        source_status: Some(status),
    });
    trace.extend(V3_ERROR_CHAIN_NODE_IDS);
    (projected, trace)
}
