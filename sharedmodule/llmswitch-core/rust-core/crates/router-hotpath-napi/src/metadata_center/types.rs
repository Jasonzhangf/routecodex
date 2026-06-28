//! MetadataCenter strongly-typed fields.
//!
//! These types mirror the camelCase `metadataCenterSnapshot` shape constructed
//! by `executeRequestStagePipeline(...)` in TypeScript. All fields are optional
//! because the snapshot is sparse — only fields that were populated in the JS
//! center are present.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Top-level request truth — identity and scope fields.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RequestTruth {
    pub request_id: Option<String>,
    pub pipeline_id: Option<String>,
    pub entry_endpoint: Option<String>,
    pub session_id: Option<String>,
    pub conversation_id: Option<String>,
    pub client_request_id: Option<String>,
    pub port_scope: Option<String>,
}

/// Continuation context — responses/resume scope fields.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationContext {
    pub responses_request_context: Option<Value>,
    pub responses_resume: Option<Value>,
    pub previous_response_id: Option<String>,
    pub response_id: Option<String>,
    pub tool_outputs: Option<Vec<Value>>,
    pub continuation_owner: Option<String>,
    pub resume_from: Option<Value>,
    pub chain_id: Option<String>,
    pub sticky_scope: Option<String>,
}

/// Stop-message direct-decision control.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageControl {
    pub enabled: Option<bool>,
    pub exclude_direct: Option<bool>,
}

/// Stopless loop control.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessControl {
    pub active: Option<bool>,
    pub trigger_hint: Option<String>,
    pub repeat_count: Option<u32>,
    pub max_repeats: Option<u32>,
    pub continuation_prompt: Option<String>,
    pub schema_feedback: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageState {
    pub stop_message_text: Option<String>,
    pub stop_message_provider_key: Option<String>,
    pub stop_message_max_repeats: Option<u32>,
    pub stop_message_used: Option<u32>,
    pub stop_message_stage_mode: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerToolLoopState {
    pub flow_id: Option<String>,
    pub repeat_count: Option<u32>,
    pub max_repeats: Option<u32>,
    pub trigger_hint: Option<String>,
    pub schema_feedback: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageCompareContext {
    pub armed: Option<bool>,
    pub mode: Option<String>,
    pub used: Option<u32>,
    pub remaining: Option<u32>,
    pub active: Option<bool>,
    pub decision: Option<String>,
    pub reason: Option<String>,
}

/// Runtime control — route/retry/stopless/stop-message fields.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeControl {
    pub route_hint: Option<String>,
    pub route_name: Option<String>,
    pub route_id: Option<String>,
    pub provider_protocol: Option<String>,
    pub retry_provider_key: Option<String>,
    pub preselected_route: Option<Value>,
    pub server_tool_followup: Option<bool>,
    pub server_tool_followup_source: Option<String>,
    pub stop_message_enabled: Option<bool>,
    pub stop_message_exclude_direct: Option<bool>,
    #[serde(default)]
    pub stop_message: StopMessageControl,
    #[serde(default)]
    pub stopless: StoplessControl,
    #[serde(default)]
    pub stop_message_state: StopMessageState,
    #[serde(default)]
    pub server_tool_loop_state: ServerToolLoopState,
    #[serde(default)]
    pub stop_message_compare_context: StopMessageCompareContext,
    pub client_abort: Option<bool>,
    pub stream_intent: Option<String>,
    #[serde(default)]
    pub traffic_governor: TrafficGovernorControl,
}

/// Traffic governor control — 独立基础设施的配置接口
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrafficGovernorControl {
    /// 是否启用流量治理
    pub enabled: Option<bool>,
    /// 最大并发数 (maxInFlight)
    pub max_in_flight: Option<u32>,
    /// RPM 限制
    pub requests_per_minute: Option<u32>,
    /// 自适应并发是否启用
    pub adaptive_enabled: Option<bool>,
    /// 自适应硬上限
    pub adaptive_hard_max: Option<u32>,
    /// 获取 lease 超时 (ms)
    pub acquire_timeout_ms: Option<u64>,
    /// stale lease 超时 (ms)
    pub stale_lease_ms: Option<u64>,
}

/// The full request-scoped MetadataCenter.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataCenter {
    #[serde(default)]
    pub request_truth: RequestTruth,
    #[serde(default)]
    pub continuation_context: ContinuationContext,
    #[serde(default)]
    pub runtime_control: RuntimeControl,
}
