#[derive(Debug)]
pub enum V3AnthropicRelayClientBody {
    Json,
    Sse(crate::nodes::V3CommittedClientSseStream),
}

impl V3AnthropicRelayClientBody {
    pub fn is_sse(&self) -> bool {
        matches!(self, Self::Sse(_))
    }
}

#[derive(Debug)]
pub struct V3AnthropicRelayRuntimeOutput {
    pub status: u16,
    pub client_response: Value,
    pub client_body: V3AnthropicRelayClientBody,
    pub node_trace: Vec<&'static str>,
    pub error_chain: Option<Vec<&'static str>>,
    pub servertool_followup_required: bool,
    pub observability: Option<V3RuntimeObservability>,
    pub stream_observation: Option<V3RuntimeStreamObservation>,
    pub provider_snapshots: Option<V3RelayProviderSnapshots>,
}

impl V3AnthropicRelayRuntimeOutput {
    pub fn into_v3_resp_15_client_payload(self) -> crate::nodes::V3Resp15ClientPayload {
        let content_type = if self.client_body.is_sse() {
            "text/event-stream"
        } else {
            "application/json"
        };
        let body = match self.client_body {
            V3AnthropicRelayClientBody::Json => {
                crate::nodes::V3ClientBody::Json(self.client_response)
            }
            V3AnthropicRelayClientBody::Sse(stream) => {
                crate::nodes::V3ClientBody::CommittedSse(stream)
            }
        };
        crate::nodes::V3Resp15ClientPayload {
            status: self.status,
            headers: BTreeMap::from([("content-type".to_string(), content_type.to_string())]),
            body,
        }
    }
}

pub fn project_v3_anthropic_client_sse_stream(
    client_response: Value,
) -> Result<crate::nodes::V3CommittedClientSseStream, String> {
    project_v3_anthropic_client_sse_stream_with_budget(
        client_response,
        crate::nodes::V3AttemptBudget::process_default(),
    )
}

pub(crate) fn project_v3_anthropic_client_sse_stream_with_budget(
    client_response: Value,
    budget: crate::nodes::V3AttemptBudget,
) -> Result<crate::nodes::V3CommittedClientSseStream, String> {
    let events = client_response
        .get("events")
        .and_then(Value::as_array)
        .cloned();
    let events = events
        .ok_or_else(|| "typed V3 Anthropic Relay SSE projection is missing events".to_string())?;
    let terminal_is_valid = events.last().is_some_and(|event| {
        event.get("event").and_then(Value::as_str) == Some("message_stop")
            && v3_anthropic_relay_sse_event_semantic(event)
                .get("type")
                .and_then(Value::as_str)
                == Some("message_stop")
    });
    if !terminal_is_valid {
        return Err(
            "typed V3 Anthropic Relay SSE projection is missing the final message_stop terminal"
                .to_string(),
        );
    }
    let mut committed = crate::nodes::V3CommittedClientSseBuilder::with_budget(budget)
        .map_err(|error| error.to_string())?;
    for event in &events {
        committed
            .push(build_v3_anthropic_client_sse_event_chunk(event)?)
            .map_err(|error| error.to_string())?;
        if event.get("event").and_then(Value::as_str) == Some("message_stop") {
            committed
                .mark_last_frame_as_terminal()
                .map_err(|error| error.to_string())?;
        }
    }
    committed
        .seal_after_validated_terminal()
        .map_err(|error| error.to_string())
}

fn build_v3_anthropic_client_sse_event_chunk(event: &Value) -> Result<Vec<u8>, String> {
    let (Some(name), Some(data)) = (
        event.get("event").and_then(Value::as_str),
        event.get("data"),
    ) else {
        return Err("typed V3 Anthropic Relay SSE event is missing event or data".to_string());
    };
    let decoded = build_v3_sse_transport_in_02_from_fields(vec![
        SseField::Named {
            name: "event".to_string(),
            value: name.to_string(),
        },
        SseField::Named {
            name: "data".to_string(),
            value: data.to_string(),
        },
    ])
    .map_err(|error| error.to_string())?;
    let validated = build_v3_sse_transport_in_03_from_v3_sse_transport_in_02(decoded)
        .map_err(|error| error.to_string())?;
    Ok(build_v3_sse_transport_out_04_from_v3_sse_transport_in_03(&validated).into_bytes())
}

pub fn project_v3_anthropic_relay_runtime_failure(
    error: V3AnthropicRelayRuntimeError,
) -> V3AnthropicRelayRuntimeOutput {
    let request_payload_invalid = matches!(
        &error,
        V3AnthropicRelayRuntimeError::ProviderCompat(error)
            if error.classification() == V3ProviderCompatErrorClassification::RequestPayloadInvalid
    );
    let internal_status = match &error {
        V3AnthropicRelayRuntimeError::ExecutionControlRequest(_) => Some(598),
        V3AnthropicRelayRuntimeError::ExecutionControlResponse(_) => Some(599),
        _ => None,
    };
    let source = match error {
        V3AnthropicRelayRuntimeError::ModelNotFound(message) => build_v3_error_01_source_raised(
            V3ErrorSourceKind::ModelNotFound,
            "V3Target10ConcreteProviderSelected",
            "direct_model_not_found",
            message,
        ),
        V3AnthropicRelayRuntimeError::ProviderCompat(error) => match error.classification() {
            V3ProviderCompatErrorClassification::PayloadBoundaryViolation => {
                super::provider_compat_boundary_source("ProviderRespCompat02ProviderCompat", &error)
            }
            V3ProviderCompatErrorClassification::RequestPayloadInvalid => {
                super::provider_request_payload_source("ProviderReqCompat06ProviderCompat", &error)
            }
            V3ProviderCompatErrorClassification::Other => build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3HubRuntime",
                "anthropic_relay_runtime_error",
                error.to_string(),
            ),
        },
        V3AnthropicRelayRuntimeError::ExecutionControlRequest(message) => {
            build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ProviderReqOutbound09TransportRequest",
                "anthropic_relay_request_execution_control_error",
                message,
            )
        }
        V3AnthropicRelayRuntimeError::ExecutionControlResponse(message) => {
            build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ServerRespOutbound06ClientFrame",
                "anthropic_relay_response_execution_control_error",
                message,
            )
        }
        error => build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3HubRuntime",
            "anthropic_relay_runtime_error",
            error.to_string(),
        ),
    };
    error_output(
        source,
        internal_status.unwrap_or(if request_payload_invalid { 400 } else { 500 }),
        "none",
        Vec::new(),
    )
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
        client_body: V3AnthropicRelayClientBody::Json,
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
        servertool_followup_required: false,
        observability: None,
        stream_observation: None,
        provider_snapshots: None,
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
        client_body: V3AnthropicRelayClientBody::Json,
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
        servertool_followup_required: false,
        observability: None,
        stream_observation: None,
        provider_snapshots: None,
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

#[cfg(test)]
mod anthropic_client_sse_projection_tests {
    use super::*;

    #[test]
    fn invalid_client_sse_event_is_rejected_before_stream_creation() {
        let error = match project_v3_anthropic_client_sse_stream(json!({
            "events": [
                {"event": "message_delta"},
                {
                    "event": "message_stop",
                    "data": {"type": "message_stop"}
                }
            ]
        })) {
            Ok(_) => panic!("invalid Anthropic event must fail before client stream creation"),
            Err(error) => error,
        };
        assert!(error.contains("missing event or data"), "{error}");
    }

    #[test]
    fn valid_client_sse_events_create_only_success_frames() {
        let stream = project_v3_anthropic_client_sse_stream(json!({
            "events": [{
                "event": "message_stop",
                "data": {"type": "message_stop"}
            }]
        }))
        .expect("valid Anthropic event must build");
        let _ = stream;
    }
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
