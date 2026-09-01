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

use crate::hub_v1::{V3HubEntryProtocol, V3RuntimeObservability, V3RuntimeStreamObservation};
use crate::provider_failure_runtime_policy::{
    project_v3_client_disconnect, provider_runtime_failure_stage,
    run_v3_relay_provider_failure_policy, V3RelayProviderFailurePolicyContext,
    V3RelayProviderFailurePolicyState,
};
use futures_util::StreamExt;
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{
    V3Error05ExecutionAction, V3Error05RecoveryAdmissionWitness, V3Error06ClientProjected,
    V3ErrorActionScope, V3ErrorHandlingCenter, V3ErrorHandlingCenterInput, V3_ERROR_CHAIN_NODE_IDS,
};
use routecodex_v3_provider_responses::{
    V3ProviderAuthHandle, V3ProviderAuthSecretHandle, V3ProviderError, V3ResponsesProviderTarget,
};
use routecodex_v3_sse::{
    build_v3_sse_transport_in_01_raw_chunk, SseIncrementalDecoder, SseTransportLimits,
};
use routecodex_v3_target::V3Target10ConcreteProviderSelected;
use serde_json::{json, Value};
use std::pin::Pin;

/// 统一的 relay provider 失败结构（替代各协议 `V3*RelayProviderFailure` 副本）。
///
/// 错误 body 形状是协议 wire 差异（gemini `error.code`、anthropic `error.type`），
/// 通过 `error_type_fn` / `error_message_fn` 提取函数指针表达；构造函数（协议本地）
/// 负责填协议形状的 body 与对应提取函数。
#[derive(Debug)]
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
    let secret = match (
        &auth.env,
        &auth.token_file,
        &auth.secret_file,
        &auth.secret_key,
        &auth.api_key,
    ) {
        (Some(env), None, None, None, None) => V3ProviderAuthSecretHandle::Environment(env.clone()),
        (None, Some(path), None, None, None) => V3ProviderAuthSecretHandle::TokenFile(path.clone()),
        (None, None, Some(path), Some(key), None) => V3ProviderAuthSecretHandle::SecretFile {
            path: path.clone(),
            key: key.clone(),
        },
        (None, None, None, None, Some(value)) => V3ProviderAuthSecretHandle::ApiKey(value.clone()),
        _ => return Err("selected auth handle is invalid".to_string()),
    };
    Ok(V3ResponsesProviderTarget {
        provider_id: selected.provider_id.clone(),
        provider_type: selected.provider_type.clone(),
        base_url: selected.base_url.clone(),
        canonical_model_id: selected.model_id.clone(),
        wire_model: selected.wire_model.clone(),
        compatibility_profile: provider.compatibility_profile.clone(),
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
        None,
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
    let error_code = match &error {
        // SSE 已经完成 provider response inbound 的协议判定；把这个语义错误码
        // 保留下游，健康策略才能把它和 transport hang 区分开。不能降成通用
        // provider_error，否则 relay 会按 transient 同 provider 重试后直接投影给客户端。
        V3ProviderError::MalformedSse { .. } => "provider_response_sse_event_invalid",
        _ => "provider_error",
    };
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
        client_response: json!({"error":{"code":error_code,"message":error.to_string()}}),
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
            "{}:{}:{}",
            selected.candidate.provider_id,
            selected.candidate.auth_alias,
            selected.candidate.model_id
        )),
        provider_type: Some(selected.candidate.provider_type.clone()),
        model_id: Some(selected.candidate.model_id.clone()),
        wire_model: Some(selected.candidate.wire_model.clone()),
        provider_status: None,
        response_status: None,
        finish_reason: None,
        stopless_activation: false,
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
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;

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
}
