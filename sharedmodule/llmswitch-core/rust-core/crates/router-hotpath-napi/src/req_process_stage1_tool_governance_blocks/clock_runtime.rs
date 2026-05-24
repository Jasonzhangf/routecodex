use chrono::DateTime;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::chat_clock_reminder_directives::extract_clock_reminder_directives;
use crate::chat_clock_reminder_orchestration_semantics::should_reserve_clock_due_reminder;
use crate::chat_clock_reminders_semantics::{
    resolve_clock_config, resolve_clock_reminder_flow_plan, resolve_clock_session_scope,
    ClockConfigOutput,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClockRuntimeMarkerDirective {
    pub due_at: String,
    pub due_at_ms: i64,
    pub task: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClockRuntimeSummary {
    pub enabled: bool,
    pub config: ClockConfigOutput,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub should_clear_tasks: bool,
    pub should_schedule_markers: bool,
    pub should_reserve_due_reminders: bool,
    pub inject_per_request_time_tag: bool,
    #[serde(default)]
    pub marker_directives: Vec<ClockRuntimeMarkerDirective>,
}

pub(crate) struct ClockRuntimeApplicationOutput {
    pub request: Map<String, Value>,
    pub runtime_summary: Option<ClockRuntimeSummary>,
}

fn parse_due_at_ms(raw: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(raw.trim())
        .ok()
        .map(|value| value.timestamp_millis())
}

fn read_clock_config_candidate(
    metadata: &Map<String, Value>,
    runtime_metadata: &Map<String, Value>,
) -> (Value, bool) {
    if let Some(value) = runtime_metadata.get("clock") {
        return (value.clone(), false);
    }
    if let Some(value) = metadata.get("clock") {
        return (value.clone(), false);
    }
    (Value::Null, true)
}

pub(crate) fn apply_clock_runtime_semantics(
    request: &Map<String, Value>,
    metadata: &Map<String, Value>,
    runtime_metadata: &Map<String, Value>,
    client_inject_ready: bool,
) -> ClockRuntimeApplicationOutput {
    let mut next_request = request.clone();

    if !client_inject_ready {
        return ClockRuntimeApplicationOutput {
            request: next_request,
            runtime_summary: None,
        };
    }

    let flow_plan = resolve_clock_reminder_flow_plan(Value::Object(runtime_metadata.clone()));
    if flow_plan.skip_for_server_tool_followup() {
        return ClockRuntimeApplicationOutput {
            request: next_request,
            runtime_summary: None,
        };
    }

    let (clock_config_raw, raw_is_undefined) =
        read_clock_config_candidate(metadata, runtime_metadata);
    let Some(clock_config) = resolve_clock_config(&clock_config_raw, raw_is_undefined) else {
        return ClockRuntimeApplicationOutput {
            request: next_request,
            runtime_summary: None,
        };
    };

    let session_id = resolve_clock_session_scope(
        &Value::Object(metadata.clone()),
        &request.get("metadata").cloned().unwrap_or(Value::Null),
    );

    let extraction = extract_clock_reminder_directives(
        request
            .get("messages")
            .cloned()
            .unwrap_or(Value::Array(Vec::new())),
    );

    if let Some(messages) = extraction.base_messages.as_array() {
        next_request.insert("messages".to_string(), Value::Array(messages.clone()));
    }

    let marker_directives = extraction
        .directive_candidates
        .iter()
        .filter_map(|candidate| {
            let due_at = candidate.due_at.trim().to_string();
            let task = candidate.task.trim().to_string();
            let due_at_ms = parse_due_at_ms(due_at.as_str())?;
            if task.is_empty() {
                return None;
            }
            let recurrence = candidate
                .recurrence
                .as_ref()
                .and_then(|value| serde_json::to_value(value).ok())
                .filter(|value| !value.is_null());
            Some(ClockRuntimeMarkerDirective {
                due_at,
                due_at_ms,
                task,
                recurrence,
            })
        })
        .collect::<Vec<ClockRuntimeMarkerDirective>>();

    let should_schedule_markers = !marker_directives.is_empty();
    let should_reserve_due_reminders = should_reserve_clock_due_reminder(
        extraction.had_clear,
        session_id.clone().unwrap_or_default(),
    );

    ClockRuntimeApplicationOutput {
        request: next_request,
        runtime_summary: Some(ClockRuntimeSummary {
            enabled: true,
            config: clock_config,
            session_id,
            should_clear_tasks: extraction.had_clear,
            should_schedule_markers,
            should_reserve_due_reminders,
            inject_per_request_time_tag: flow_plan.inject_per_request_time_tag(),
            marker_directives,
        }),
    }
}
