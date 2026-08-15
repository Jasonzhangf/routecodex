pub fn project_v3_anthropic_relay_runtime_failure(
    error: V3AnthropicRelayRuntimeError,
) -> V3AnthropicRelayRuntimeOutput {
    let source = match error {
        V3AnthropicRelayRuntimeError::ModelNotFound(message) => build_v3_error_01_source_raised(
            V3ErrorSourceKind::ModelNotFound,
            "V3Target10ConcreteProviderSelected",
            "direct_model_not_found",
            message,
        ),
        error => build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3HubRuntime",
            "anthropic_relay_runtime_error",
            error.to_string(),
        ),
    };
    error_output(source, 500, "none", Vec::new())
}

fn provider_http_failure(status: u16, body: &[u8], _provider_id: &str) -> V3RelayProviderFailure {
    V3RelayProviderFailure {
        status,
        client_response: project_v3_responses_error_as_anthropic_error(body),
        source_stage: "V3ProviderReqOutbound09TransportRequest",
        terminal_projection: None,
        error_type_fn: extract_error_type_style,
        error_message_fn: extract_message_type_style,
    }
}

fn provider_request_failure(
    source_stage: &'static str,
    error_type: &'static str,
    error: impl std::fmt::Display,
) -> V3RelayProviderFailure {
    V3RelayProviderFailure {
        status: 502,
        client_response: json!({"type":"error","error":{"type":error_type,"message":error.to_string()}}),
        source_stage,
        terminal_projection: None,
        error_type_fn: extract_error_type_style,
        error_message_fn: extract_message_type_style,
    }
}

fn provider_runtime_failure(error: V3ProviderError, provider_id: &str) -> V3RelayProviderFailure {
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
        client_response: json!({"type":"error","error":{"type":"provider_error","message":error.to_string()}}),
        source_stage: provider_runtime_failure_stage(&error),
        terminal_projection,
        error_type_fn: extract_error_type_style,
        error_message_fn: extract_message_type_style,
    }
}

fn provider_failure_output(
    failure: V3RelayProviderFailure,
    mut trace: Vec<&'static str>,
) -> V3AnthropicRelayRuntimeOutput {
    let projected = failure
        .terminal_projection
        .expect("terminal Anthropic provider failure must carry typed Error06 projection");
    trace.push("V3Error06ClientProjected");
    V3AnthropicRelayRuntimeOutput {
        status: projected.status,
        client_response: projected.body,
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
        servertool_followup_required: false,
        observability: None,
        stream_observation: None,
    }
}

fn error_output(
    source: routecodex_v3_error::V3Error01SourceRaised,
    status: u16,
    provider_id: &str,
    mut trace: Vec<&'static str>,
) -> V3AnthropicRelayRuntimeOutput {
    let (projected, trace) = crate::hub_v1::error_output(source, status, provider_id, trace);
    V3AnthropicRelayRuntimeOutput {
        status: projected.status,
        client_response: projected.body,
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
        servertool_followup_required: false,
        observability: None,
        stream_observation: None,
    }
}

/// Anthropic client 响应 usage 归一化提取：JSON 路径 client_response 是 message
/// 形状（顶层 `usage`）；SSE 路径 client_response 是 events 数组，usage 在
/// `message_start.data.message.usage` / `message_delta.data.usage`（SSE 事件
/// 采用 `{"event","data"}` 信封，data 内才是协议语义对象）。只读业务响应投影，
/// 写入 typed observability。
fn extract_v3_anthropic_relay_usage_summary(
    client_response: &Value,
) -> Option<V3RuntimeUsageSummary> {
    if let Some(summary) = extract_v3_runtime_usage_summary(client_response) {
        return Some(summary);
    }
    let events = client_response.get("events")?.as_array()?;
    for event in events {
        let semantic = v3_anthropic_relay_sse_event_semantic(event);
        if let Some(summary) = event
            .get("message")
            .and_then(extract_v3_runtime_usage_summary)
        {
            return Some(summary);
        }
        if let Some(summary) = semantic
            .get("message")
            .and_then(extract_v3_runtime_usage_summary)
            .or_else(|| extract_v3_runtime_usage_summary(semantic))
        {
            return Some(summary);
        }
    }
    None
}

/// Anthropic client 响应 finish_reason 归一化提取：JSON 路径 client_response 是
/// message 形状（顶层 `stop_reason`）；SSE 路径是 events 数组，终态在
/// `message_delta.data.delta.stop_reason`（SSE 事件采用 `{"event","data"}`
/// 信封，data 内才是协议语义对象）。只读业务响应投影，写入 typed observability。
fn extract_v3_anthropic_relay_finish_reason(client_response: &Value) -> Option<String> {
    let events = client_response.get("events")?.as_array()?;
    for event in events {
        let semantic = v3_anthropic_relay_sse_event_semantic(event);
        let candidate = event
            .get("delta")
            .or_else(|| semantic.get("delta"))
            .and_then(|delta| delta.get("stop_reason"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty());
        if let Some(finish_reason) = candidate {
            return Some(finish_reason.to_string());
        }
    }
    None
}

/// SSE 事件信封 `{"event": "...", "data": {...}}` 解包：data 存在且为对象时
/// 返回 data，否则原样返回（兼容无信封的裸事件对象 / JSON 路径 message 形状）。
fn v3_anthropic_relay_sse_event_semantic(event: &Value) -> &Value {
    event
        .get("data")
        .filter(|data| data.is_object())
        .unwrap_or(event)
}
