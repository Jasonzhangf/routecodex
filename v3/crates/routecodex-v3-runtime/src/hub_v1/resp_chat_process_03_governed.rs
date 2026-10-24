pub(crate) use super::common::V3ChatProcessRefillDisposition;
use super::*;
use crate::hub_v1::relay_sse_hooks::V3RelaySseHookCatalog;
use crate::operation_runner::{
    run_v3_single_node_operator, OperationRunnerError, V3OperationGraph,
};
use crate::tool_markup_parser::{
    scan_tool_markup, ParsedToolCall, ToolMarkupDeclarations, ToolMarkupIdentity, ToolMarkupKind,
    ToolMarkupParamKind, ToolMarkupSegment,
};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use serde::de::{IgnoredAny, MapAccess, Visitor};
use serde::Deserializer;
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::fmt;
use std::ops::Deref;
use std::sync::{Arc, Mutex, OnceLock};

#[path = "resp_chat_process_tool_markup.rs"]
mod tool_markup;
pub(crate) use tool_markup::harvest_chat_text;

include!("resp_chat_process_03_governed_provider_identity.rs");

#[derive(Clone, Copy)]
pub(crate) struct V3ToolreasonObservationContext<'a> {
    pub(crate) session_id: Option<&'a str>,
    pub(crate) request_id: Option<&'a str>,
}
fn log_v3_toolreason_observation_at_resp03_with_context(
    tool_name: &str,
    reason: Option<&str>,
    stage: &str,
    context: V3ToolreasonObservationContext<'_>,
) {
    log_v3_toolreason_observation_at_resp03_with_context_and_expected_model(
        tool_name, reason, stage, context, None,
    );
}

fn log_v3_toolreason_observation_at_resp03_with_context_and_expected_model(
    tool_name: &str,
    reason: Option<&str>,
    stage: &str,
    context: V3ToolreasonObservationContext<'_>,
    expected_model_id: Option<&str>,
) {
    let (status, fields) =
        classify_v3_toolreason_observation_at_resp03_with_expected_model(reason, expected_model_id);
    log_classified_v3_toolreason_observation_at_resp03(
        tool_name,
        stage,
        context,
        status,
        fields.as_ref(),
    );
}

fn log_classified_v3_toolreason_observation_at_resp03(
    tool_name: &str,
    stage: &str,
    context: V3ToolreasonObservationContext<'_>,
    status: V3ToolreasonObservationStatus,
    fields: Option<&V3ToolreasonFields>,
) {
    let (label, color) = match status {
        V3ToolreasonObservationStatus::Ok => ("OK", "42"),
        V3ToolreasonObservationStatus::Missing => ("MISSING", "43"),
        V3ToolreasonObservationStatus::Invalid => ("INVALID", "41"),
        V3ToolreasonObservationStatus::Misplaced => ("MISPLACED", "45"),
    };
    let line = format!(
        "\x1b[1;{color};30m TOOLREASON {label} \x1b[0m source=provider_raw_tool_arguments stage={stage} session_id={} request_id={} tool={tool_name} confidence={} thinking={}",
        context.session_id.unwrap_or("<missing>"),
        context.request_id.unwrap_or("<missing>"),
        fields
            .and_then(|value| value.goal_alignment_confidence)
            .map_or("<missing>".to_string(), |value| value.to_string()),
        fields
            .map(|value| compact_v3_toolreason_observation_text(&value.reason))
            .unwrap_or_else(|| "<missing>".to_string()),
    );
    println!("{line}");
    let _ = std::io::Write::flush(&mut std::io::stdout());
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum V3ToolreasonObservationStatus {
    Ok,
    Missing,
    Invalid,
    Misplaced,
}

fn classify_v3_toolreason_observation_at_resp03(
    raw: Option<&str>,
) -> (V3ToolreasonObservationStatus, Option<V3ToolreasonFields>) {
    classify_v3_toolreason_observation_at_resp03_with_expected_model(raw, None)
}

fn classify_v3_toolreason_observation_at_resp03_with_expected_model(
    raw: Option<&str>,
    expected_model_id: Option<&str>,
) -> (V3ToolreasonObservationStatus, Option<V3ToolreasonFields>) {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return (V3ToolreasonObservationStatus::Missing, None);
    };
    if let Some(fields) = parse_v3_toolreason_fields_at_resp03(raw) {
        return (V3ToolreasonObservationStatus::Ok, Some(fields));
    }
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(raw) else {
        return (V3ToolreasonObservationStatus::Invalid, None);
    };
    let has_auxiliary_field = object.keys().any(|key| {
        matches!(
            key.as_str(),
            "reason" | "goal_alignment_confidence" | "model_id"
        )
    });
    if !has_auxiliary_field {
        return (V3ToolreasonObservationStatus::Missing, None);
    }
    let is_native_tool_call = object.contains_key("name")
        || object.contains_key("call_id")
        || object.contains_key("tool_call_id")
        || object.contains_key("function")
        || object.contains_key("type");
    (
        if is_native_tool_call {
            V3ToolreasonObservationStatus::Misplaced
        } else {
            V3ToolreasonObservationStatus::Invalid
        },
        None,
    )
}

fn compact_v3_toolreason_observation_text(reason: &str) -> String {
    const MAX_CHARS: usize = 160;
    let compact = reason
        .chars()
        .map(|character| match character {
            '\n' | '\r' | '\t' => ' ',
            character => character,
        })
        .collect::<String>();
    let compact = compact.trim();
    if compact.chars().count() <= MAX_CHARS {
        return compact.to_string();
    }
    let prefix = compact.chars().take(MAX_CHARS).collect::<String>();
    format!("{prefix}…")
}

/// Dry-run-only contract audit. It never enters the live request/response
/// payload and does not alter either side; it only reports what each stage
/// actually contained so request injection and response plumbing can be
/// separated.
pub(crate) fn audit_v3_toolreason_dry_run_payloads(
    original_request: &Value,
    provider_request: &Value,
    provider_response: &Value,
) -> Value {
    let provider_text = provider_request.to_string();
    // Provider-facing guidance is intentionally stricter than Resp03
    // compatibility: both active diagnostic fields must reach the wire
    // contract even though a reason-only provider response remains acceptable.
    let request_reason_guidance_present = provider_text.contains("reason");
    let request_required_diagnostics_present = provider_text.contains("goal_alignment_confidence");
    let request_guidance_present =
        request_reason_guidance_present && request_required_diagnostics_present;
    let mut tool_call_count = 0usize;
    let mut toolreason_count = 0usize;
    collect_v3_toolreason_dry_run_counts(
        provider_response,
        &mut tool_call_count,
        &mut toolreason_count,
    );
    let diagnosis = if !request_guidance_present {
        "request_injection_missing"
    } else if tool_call_count > 0 && toolreason_count == 0 {
        "response_missing_toolreason_after_guidance"
    } else {
        "raw_contract_present"
    };
    json!({
        "diagnosis": diagnosis,
        "original_request_present": !original_request.is_null(),
        "provider_request_present": !provider_request.is_null(),
        "request_guidance_present": request_guidance_present,
        "request_reason_guidance_present": request_reason_guidance_present,
        "request_required_diagnostics_present": request_required_diagnostics_present,
        "provider_response_present": !provider_response.is_null(),
        "provider_response_tool_call_count": tool_call_count,
        "provider_response_toolreason_count": toolreason_count,
    })
}

fn collect_v3_toolreason_dry_run_counts(
    value: &Value,
    tool_call_count: &mut usize,
    toolreason_count: &mut usize,
) {
    match value {
        Value::Object(object) => {
            if v3_is_tool_call_object_at_resp03(object) {
                *tool_call_count += 1;
                if v3_tool_thinking_fields_from_tool_call_at_resp03(object, None).is_some() {
                    *toolreason_count += 1;
                }
            }
            for child in object.values() {
                collect_v3_toolreason_dry_run_counts(child, tool_call_count, toolreason_count);
            }
        }
        Value::Array(values) => {
            for child in values {
                collect_v3_toolreason_dry_run_counts(child, tool_call_count, toolreason_count);
            }
        }
        Value::String(_) | Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct V3ToolreasonFields {
    reason: String,
    goal_alignment_confidence: Option<u8>,
}

fn parse_v3_toolreason_fields_at_resp03(reason: &str) -> Option<V3ToolreasonFields> {
    // Only native JSON in the native tool-call parameter container is a
    // toolreason source. Only a native tool-call parameter object can
    // authorize the JSON v2 fields; no other response surface is guessed.
    if json_object_has_duplicate_keys_at_resp03(reason.trim()) {
        return None;
    }
    let object = serde_json::from_str::<Value>(reason.trim()).ok()?;
    let object = object.as_object()?;
    parse_v3_tool_thinking_fields_from_object_at_resp03(object).ok()
}

pub(crate) fn json_object_has_duplicate_keys_at_resp03(raw: &str) -> bool {
    struct DuplicateKeyVisitor<'a> {
        duplicate: &'a mut bool,
    }

    impl<'de, 'a> Visitor<'de> for DuplicateKeyVisitor<'a> {
        type Value = ();

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a JSON object")
        }

        fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
        where
            M: MapAccess<'de>,
        {
            let mut keys = BTreeSet::new();
            while let Some(key) = map.next_key::<String>()? {
                if !keys.insert(key) {
                    *self.duplicate = true;
                }
                map.next_value::<IgnoredAny>()?;
            }
            Ok(())
        }
    }

    let mut duplicate = false;
    let mut deserializer = serde_json::Deserializer::from_str(raw);
    if deserializer
        .deserialize_map(DuplicateKeyVisitor {
            duplicate: &mut duplicate,
        })
        .is_err()
    {
        return false;
    }
    duplicate
}

fn parse_v3_tool_thinking_fields_from_object_at_resp03(
    object: &serde_json::Map<String, Value>,
) -> Result<V3ToolreasonFields, &'static str> {
    let reason = object
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
        .ok_or("reason")?;
    let confidence = match object.get("goal_alignment_confidence") {
        Some(Value::Number(value)) => Some(
            value
                .as_u64()
                .filter(|value| *value <= 100)
                .map(|value| value as u8)
                .ok_or("goal_alignment_confidence")?,
        ),
        Some(_) => return Err("goal_alignment_confidence"),
        None => None,
    };
    Ok(V3ToolreasonFields {
        reason,
        goal_alignment_confidence: confidence,
    })
}

fn v3_is_gemini_tool_call_object_at_resp03(object: &serde_json::Map<String, Value>) -> bool {
    object.contains_key("functionCall")
        || object.contains_key("functionResponse")
        || object.get("type").and_then(Value::as_str) == Some("functionCall")
}

fn v3_tool_thinking_object_reason_at_resp03(
    object: &serde_json::Map<String, Value>,
    expected_model_id: Option<&str>,
) -> Option<V3ToolreasonFields> {
    if v3_is_gemini_tool_call_object_at_resp03(object) {
        return None;
    }
    let fields = parse_v3_tool_thinking_fields_from_object_at_resp03(object).ok()?;
    Some(fields)
}

fn v3_tool_thinking_fields_from_parameter_value_at_resp03(
    value: &Value,
    expected_model_id: Option<&str>,
) -> Option<V3ToolreasonFields> {
    match value {
        Value::Object(object) => {
            v3_tool_thinking_object_reason_at_resp03(object, expected_model_id)
        }
        Value::String(text) => {
            if json_object_has_duplicate_keys_at_resp03(text.trim()) {
                return None;
            }
            serde_json::from_str::<Value>(text)
                .ok()
                .as_ref()
                .and_then(|parsed| {
                    v3_tool_thinking_fields_from_parameter_value_at_resp03(
                        parsed,
                        expected_model_id,
                    )
                })
        }
        _ => None,
    }
}

fn v3_tool_thinking_fields_from_tool_call_at_resp03(
    object: &serde_json::Map<String, Value>,
    expected_model_id: Option<&str>,
) -> Option<V3ToolreasonFields> {
    if v3_is_gemini_tool_call_object_at_resp03(object) {
        return None;
    }
    if object.get("type").and_then(Value::as_str) == Some("custom_tool_call") {
        return v3_custom_tool_thinking_wrapper_at_resp03(object)
            .map(|(fields, _native_input)| fields);
    }
    let parameter = if object.get("type").and_then(Value::as_str) == Some("tool_use") {
        object.get("input")
    } else if let Some(function) = object.get("function").and_then(Value::as_object) {
        function.get("arguments")
    } else {
        object.get("arguments")
    }?;
    v3_tool_thinking_fields_from_parameter_value_at_resp03(parameter, expected_model_id)
}

/// Custom/free-form tools carry their native input as a string.  The only
/// governed wrapper accepted at Resp03 is an explicit JSON object inside that
/// string: `{"input":"<native>","reason":"...",...}`.  A malformed or
/// incomplete wrapper is deliberately not recovered.
fn v3_custom_tool_thinking_wrapper_at_resp03(
    object: &serde_json::Map<String, Value>,
) -> Option<(V3ToolreasonFields, String)> {
    if let Ok(fields) = parse_v3_tool_thinking_fields_from_object_at_resp03(object) {
        let native_input = object.get("input")?.as_str()?.to_string();
        return Some((fields, native_input));
    }
    let raw_input = object.get("input")?.as_str()?.trim();
    if json_object_has_duplicate_keys_at_resp03(raw_input) {
        return None;
    }
    let wrapper = serde_json::from_str::<Value>(raw_input).ok()?;
    let wrapper = match wrapper {
        Value::String(encoded_wrapper) => {
            if json_object_has_duplicate_keys_at_resp03(&encoded_wrapper) {
                return None;
            }
            serde_json::from_str::<Value>(&encoded_wrapper).ok()?
        }
        wrapper => wrapper,
    };
    let wrapper = wrapper.as_object()?;
    let fields = parse_v3_tool_thinking_fields_from_object_at_resp03(wrapper).ok()?;
    let native_input = recognized_v3_custom_tool_wrapper_input_at_resp03(wrapper)?.to_string();
    Some((fields, native_input))
}

/// The complete registered custom wrapper boundary. Unknown business fields
/// make the whole value opaque; they never authorize an inner-input inverse.
/// Auxiliary-field semantics remain owned by the Tool-Thinking parser.
pub(super) fn recognized_v3_custom_tool_wrapper_input_at_resp03(
    wrapper: &Map<String, Value>,
) -> Option<&str> {
    if wrapper.keys().any(|key| {
        !matches!(
            key.as_str(),
            "input" | "reason" | "goal_alignment_confidence" | "model_id"
        )
    }) {
        return None;
    }
    wrapper.get("input")?.as_str()
}

fn v3_tool_thinking_raw_parameter_from_tool_call_at_resp03(
    object: &serde_json::Map<String, Value>,
) -> Option<String> {
    if object.get("type").and_then(Value::as_str) == Some("custom_tool_call") {
        if v3_custom_tool_thinking_wrapper_at_resp03(object).is_some() {
            return object
                .get("input")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        return serde_json::to_string(object).ok();
    }
    let parameter = if object.get("type").and_then(Value::as_str) == Some("tool_use") {
        object.get("input")
    } else if let Some(function) = object.get("function").and_then(Value::as_object) {
        function.get("arguments")
    } else {
        object.get("arguments")
    }?;
    match parameter {
        Value::String(raw) => Some(raw.clone()),
        _ => serde_json::to_string(parameter).ok(),
    }
}

fn strip_v3_tool_thinking_fields_from_object_at_resp03(
    object: &mut serde_json::Map<String, Value>,
    expected_model_id: Option<&str>,
) {
    if v3_is_gemini_tool_call_object_at_resp03(object) {
        return;
    }
    if v3_is_tool_call_object_at_resp03(object) {
        if object.get("type").and_then(Value::as_str) == Some("custom_tool_call") {
            if let Some((_fields, native_input)) = v3_custom_tool_thinking_wrapper_at_resp03(object)
            {
                object.insert("input".to_string(), Value::String(native_input));
                object.remove("reason");
                object.remove("goal_alignment_confidence");
                object.remove("model_id");
            }
            return;
        }
        // A legacy response may place model_id on the call envelope instead
        // of its parameter object. It is still owned and removed here.
        object.remove("model_id");
        if object.get("type").and_then(Value::as_str) == Some("tool_use") {
            if let Some(value) = object.get_mut("input") {
                strip_v3_tool_thinking_fields_from_parameter_value_at_resp03(
                    value,
                    expected_model_id,
                );
            }
        } else if let Some(function) = object.get_mut("function").and_then(Value::as_object_mut) {
            if let Some(value) = function.get_mut("arguments") {
                strip_v3_tool_thinking_fields_from_parameter_value_at_resp03(
                    value,
                    expected_model_id,
                );
            }
        } else if let Some(value) = object.get_mut("arguments") {
            strip_v3_tool_thinking_fields_from_parameter_value_at_resp03(value, expected_model_id);
        }
    }
}

fn strip_v3_tool_thinking_fields_from_parameter_value_at_resp03(
    value: &mut Value,
    expected_model_id: Option<&str>,
) {
    match value {
        Value::Object(object) => {
            if v3_tool_thinking_object_reason_at_resp03(object, expected_model_id).is_some() {
                object.remove("reason");
                object.remove("goal_alignment_confidence");
            }
            // `model_id` is a legacy Toolreason field. Req04 never injects it;
            // Resp03 owns its compatibility removal even when the rest of the
            // Toolreason object is missing or invalid.
            object.remove("model_id");
        }
        Value::String(text) => {
            if json_object_has_duplicate_keys_at_resp03(text.trim()) {
                return;
            }
            let Ok(mut parsed) = serde_json::from_str::<Value>(text) else {
                return;
            };
            let Some(parsed_object) = parsed.as_object() else {
                return;
            };
            let has_valid_toolreason =
                v3_tool_thinking_object_reason_at_resp03(parsed_object, expected_model_id)
                    .is_some();
            if !has_valid_toolreason && !parsed_object.contains_key("model_id") {
                return;
            }
            if let Some(parsed_object) = parsed.as_object_mut() {
                if has_valid_toolreason {
                    parsed_object.remove("reason");
                    parsed_object.remove("goal_alignment_confidence");
                }
                parsed_object.remove("model_id");
            }
            if let Ok(serialized) = serde_json::to_string(&parsed) {
                *text = serialized;
            }
        }
        _ => {}
    }
}

fn strip_v3_tool_thinking_fields_from_json_at_resp03(
    value: &mut Value,
    expected_model_id: Option<&str>,
) {
    match value {
        Value::Object(object) => {
            let is_gemini = v3_is_gemini_tool_call_object_at_resp03(object);
            strip_v3_tool_thinking_fields_from_object_at_resp03(object, expected_model_id);
            if is_gemini {
                return;
            }
            if let Some(function) = object.get_mut("function") {
                strip_v3_tool_thinking_fields_from_json_at_resp03(function, expected_model_id);
            }
            for (key, child) in object.iter_mut() {
                if matches!(
                    key.as_str(),
                    "arguments" | "input" | "parameters" | "args" | "function"
                ) {
                    continue;
                }
                strip_v3_tool_thinking_fields_from_json_at_resp03(child, expected_model_id);
            }
        }
        Value::Array(values) => {
            for child in values {
                strip_v3_tool_thinking_fields_from_json_at_resp03(child, expected_model_id);
            }
        }
        Value::String(_) | Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn emit_v3_toolreason_observation_at_resp03_with_context(
    tool_name: &str,
    reason: Option<&str>,
    stage: &str,
    emitted: &mut bool,
    context: V3ToolreasonObservationContext<'_>,
) {
    emit_v3_toolreason_observation_at_resp03_with_expected_model(
        tool_name, reason, stage, emitted, context, None,
    );
}

fn emit_v3_toolreason_observation_at_resp03_with_expected_model(
    tool_name: &str,
    reason: Option<&str>,
    stage: &str,
    emitted: &mut bool,
    context: V3ToolreasonObservationContext<'_>,
    expected_model_id: Option<&str>,
) {
    if *emitted {
        return;
    }
    if let Some(request_id) = context.request_id {
        if !claim_v3_toolreason_turn_observation(request_id) {
            *emitted = true;
            return;
        }
    }
    log_v3_toolreason_observation_at_resp03_with_context_and_expected_model(
        tool_name,
        reason,
        stage,
        context,
        expected_model_id,
    );
    *emitted = true;
}

fn emit_v3_toolreason_observation_at_resp03_with_expected_model_and_stream_observation(
    tool_name: &str,
    reason: Option<&str>,
    stage: &str,
    emitted: &mut bool,
    context: V3ToolreasonObservationContext<'_>,
    expected_model_id: Option<&str>,
    stream_observation: &crate::hub_v1::V3RuntimeStreamObservation,
) -> Result<(), String> {
    if *emitted {
        return Ok(());
    }
    if let Some(request_id) = context.request_id {
        if !claim_v3_toolreason_turn_observation(request_id) {
            *emitted = true;
            return Ok(());
        }
    }
    let (status, fields) =
        classify_v3_toolreason_observation_at_resp03_with_expected_model(reason, expected_model_id);
    let status_label = match status {
        V3ToolreasonObservationStatus::Ok => "OK",
        V3ToolreasonObservationStatus::Missing => "MISSING",
        V3ToolreasonObservationStatus::Invalid => "INVALID",
        V3ToolreasonObservationStatus::Misplaced => "MISPLACED",
    };
    stream_observation.record_toolreason(crate::hub_v1::V3RuntimeToolreasonObservation {
        status: status_label.to_string(),
        source: "provider_raw_tool_arguments".to_string(),
        stage: stage.to_string(),
        session_id: context.session_id.map(str::to_string),
        request_id: context.request_id.map(str::to_string),
        tool: tool_name.to_string(),
        reason: fields.as_ref().map(|value| value.reason.clone()),
        confidence: fields
            .as_ref()
            .and_then(|value| value.goal_alignment_confidence),
    })?;
    log_classified_v3_toolreason_observation_at_resp03(
        tool_name,
        stage,
        context,
        status,
        fields.as_ref(),
    );
    *emitted = true;
    Ok(())
}

fn emit_v3_toolreason_observation_at_resp03_with_optional_stream_observation(
    tool_name: &str,
    reason: Option<&str>,
    stage: &str,
    emitted: &mut bool,
    context: V3ToolreasonObservationContext<'_>,
    expected_model_id: Option<&str>,
    stream_observation: Option<&crate::hub_v1::V3RuntimeStreamObservation>,
    observation_error: &mut Option<String>,
) {
    if observation_error.is_some() {
        return;
    }
    if let Some(stream_observation) = stream_observation {
        if let Err(error) =
            emit_v3_toolreason_observation_at_resp03_with_expected_model_and_stream_observation(
                tool_name,
                reason,
                stage,
                emitted,
                context,
                expected_model_id,
                stream_observation,
            )
        {
            *observation_error = Some(error);
        }
    } else {
        emit_v3_toolreason_observation_at_resp03_with_expected_model(
            tool_name,
            reason,
            stage,
            emitted,
            context,
            expected_model_id,
        );
    }
}

/// Resp03 may be re-entered while one provider attempt is normalized through
/// more than one registered response hook.  The observation is a control-side
/// turn fact, not payload data, so claim it once by the canonical request id.
/// Keep the process-local ledger bounded; request ids are unique per turn and
/// are never used to reconstruct or alter a request/response payload.
fn claim_v3_toolreason_turn_observation(request_id: &str) -> bool {
    const MAX_TRACKED_REQUESTS: usize = 4096;
    static CLAIMED: OnceLock<Mutex<(HashSet<String>, VecDeque<String>)>> = OnceLock::new();
    let ledger = CLAIMED.get_or_init(|| Mutex::new((HashSet::new(), VecDeque::new())));
    let Ok(mut ledger) = ledger.lock() else {
        return false;
    };
    if ledger.0.contains(request_id) {
        return false;
    }
    if ledger.1.len() >= MAX_TRACKED_REQUESTS {
        if let Some(oldest) = ledger.1.pop_front() {
            ledger.0.remove(&oldest);
        }
    }
    let request_id = request_id.to_owned();
    ledger.0.insert(request_id.clone());
    ledger.1.push_back(request_id);
    true
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespChatProcess03Governed {
    pub(crate) previous: V3HubRespInbound02Normalized,
    pub(crate) terminality: V3HubResponseTerminality,
    pub(crate) tool_calls: Vec<V3HubResponseToolCall>,
}

pub fn build_v3_hub_resp_chat_process_03_from_v3_hub_resp_inbound_02(
    input: V3HubRespInbound02Normalized,
) -> V3HubRespChatProcess03Governed {
    V3HubRespChatProcess03Governed {
        previous: input,
        terminality: V3HubResponseTerminality::Terminal,
        tool_calls: Vec::new(),
    }
}

/// 递归剥离 responses canonical 响应中的 `encrypted_content` 字段。
/// `retain_response_cipher` 由请求侧 VR 路由决策算好并写入 profile：仅当目标是 gpt
/// 模型**且该模型只有单一 provider 候选**时才为 true（Codex 客户端需要自己的密文
/// 重建 reasoning 历史）；其余情况一律剥离——非 gpt provider（deepseek 网关等）响应
/// 的 reasoning 条目只允许携带明文（summary/content/text），任何位置的密文字段都在
/// 进入下游投影前删除。响应侧只消费该标记，不重复判定。
fn strip_v3_resp03_encrypted_reasoning_content(
    mut input: V3HubRespInbound02Normalized,
    retain_response_cipher: bool,
) -> V3HubRespInbound02Normalized {
    if !retain_response_cipher {
        // Anthropic signature 是否保留只由 raw provider source witness 决定；
        // 不根据密文文本形状猜测协议来源。
        // 唯一密文剥离 hook（provider-responses）：direct 与 relay 响应侧共用，
        // 保证"只有单 gpt provider 才进客户端"的密文策略单一实现。
        let source_provider_protocol = input.provider_raw().source_provider_protocol;
        let payload = std::sync::Arc::make_mut(&mut input.previous.previous.payload.0);
        match source_provider_protocol {
            // Anthropic signature 由 typed raw source witness 保留。
            V3HubProviderWireProtocol::Anthropic => {
                routecodex_v3_provider_responses::apply_v3_response_cipher_policy(
                    payload, false, true,
                );
            }
            // Responses wire 全剥非工具密文（fe1ec4b 契约），function_call_output 保留。
            V3HubProviderWireProtocol::Responses => {
                routecodex_v3_provider_responses::apply_v3_response_cipher_policy(
                    payload, false, false,
                );
            }
            // Chat wire 的 reasoning 业务形状必须存活（b878f6c 契约）。
            V3HubProviderWireProtocol::OpenAiChat | V3HubProviderWireProtocol::Gemini => {
                routecodex_v3_provider_responses::apply_v3_chat_reasoning_cipher_policy(
                    payload, false,
                );
            }
        }
    }
    input
}

impl V3HubRespChatProcess03Governed {
    pub(crate) fn provider_payload(&self) -> &Value {
        self.previous.provider_payload().as_ref()
    }

    pub fn finalized_payload(&self) -> &Value {
        self.provider_payload()
    }

    pub(crate) fn provider_raw(&self) -> &V3ProviderRespInbound01Raw {
        self.previous.provider_raw()
    }

    pub fn terminality(&self) -> V3HubResponseTerminality {
        self.terminality
    }

    pub fn tool_call_count(&self) -> usize {
        self.tool_calls.len()
    }

    pub fn tool_call_kinds(&self) -> Vec<V3HubRelayToolKind> {
        self.tool_calls
            .iter()
            .map(|tool_call| tool_call.kind)
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespChatProcess03Outcome {
    data: V3HubRespChatProcess03Governed,
}

impl V3HubRespChatProcess03Outcome {
    pub fn into_governed(self) -> V3HubRespChatProcess03Governed {
        self.data
    }
}

impl Deref for V3HubRespChatProcess03Outcome {
    type Target = V3HubRespChatProcess03Governed;

    fn deref(&self) -> &Self::Target {
        &self.data
    }
}

/// Source-explicit non-empty summary fact for refill gating.
///
/// Provenance contract: only a provider-mapped explicit summary field counts.
/// The fact is recognized in the two provider-native shapes that the runtime
/// reads before governance:
/// - Responses canonical: `output[]` items of type `reasoning` whose `summary[]`
///   entries carry a non-empty `text`.
/// - OpenAI Chat native: `choices[].message.reasoning.summary[]` entries with a
///   non-empty `text`.
/// RCC-synthesized reasoning/toolreason content, ordinary assistant body text
/// (`output_text`, `content[].text`, `reasoning_content`, provider `thinking`),
/// native full-reasoning `reasoning.content`, and request-side summary policy
/// never count.
pub(crate) fn has_v3_source_explicit_nonempty_summary(payload: &Value) -> bool {
    has_responses_source_explicit_summary(payload)
        || has_openai_chat_source_explicit_summary(payload)
}

fn has_nonempty_summary_text(summaries: Option<&Value>) -> bool {
    summaries
        .and_then(Value::as_array)
        .map(|summaries| {
            summaries.iter().any(|summary| {
                summary
                    .get("text")
                    .and_then(Value::as_str)
                    .map(|text| !text.trim().is_empty())
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn has_responses_source_explicit_summary(payload: &Value) -> bool {
    payload
        .get("output")
        .and_then(Value::as_array)
        .map(|items| {
            items.iter().any(|item| {
                item.get("type").and_then(Value::as_str) == Some("reasoning")
                    && has_nonempty_summary_text(item.get("summary"))
            })
        })
        .unwrap_or(false)
}

fn has_openai_chat_source_explicit_summary(payload: &Value) -> bool {
    payload
        .get("choices")
        .and_then(Value::as_array)
        .map(|choices| {
            choices.iter().any(|choice| {
                let reasoning = choice
                    .get("message")
                    .and_then(|message| message.get("reasoning"));
                // Only the explicit `summary` field counts. Native full
                // reasoning (`reasoning.content`), `reasoning_content` and
                // `reasoning_text` are not summaries.
                has_nonempty_summary_text(reasoning.and_then(|reasoning| reasoning.get("summary")))
            })
        })
        .unwrap_or(false)
}

/// The single shared refill policy for Direct-registered hooks and Relay.
/// Contract: no governed tool call AND no source-explicit non-empty summary AND
/// a remaining consecutive-refill budget ask for one more execution. A real
/// error never reaches this decision (it is handled by the Error chain first).
/// 0 disables refill; N allows at most N new executions beyond the original.
pub(crate) fn decide_v3_chat_process_refill(
    tool_calls: &[V3HubResponseToolCall],
    has_source_summary: bool,
    response_completed: bool,
    refill_used: u32,
    max_consecutive_refills: u32,
) -> V3ChatProcessRefillDisposition {
    if !response_completed
        || !tool_calls.is_empty()
        || has_source_summary
        || refill_used >= max_consecutive_refills
    {
        V3ChatProcessRefillDisposition::Deliver
    } else {
        V3ChatProcessRefillDisposition::RequestRefill
    }
}

/// Map a Responses canonical output item type to its governed tool-call kind.
///
/// This is the single structural classifier used by the Direct refill fact
/// extractor. It accepts the complete call item types produced by the
/// Responses wire contract and the `*_call` suffix for opaque hosted call
/// shapes. Output items (`*_output`) are explicitly rejected even when they
/// carry a `call_id`, because an output is not a new tool call.
fn v3_governed_tool_call_kind(item_type: &str) -> Option<V3HubRelayToolKind> {
    match item_type {
        "function_call" | "function" => Some(V3HubRelayToolKind::Function),
        "custom_tool_call" | "custom" => Some(V3HubRelayToolKind::Custom),
        "tool_search_call" | "tool_search" | "web_search_call" | "web_search" => {
            Some(V3HubRelayToolKind::Native)
        }
        "mcp_call" | "mcp" => Some(V3HubRelayToolKind::Mcp),
        "computer_call"
        | "computer"
        | "code_interpreter_call"
        | "code_interpreter"
        | "local_shell_call"
        | "local_shell"
        | "image_generation_call"
        | "image_generation" => Some(V3HubRelayToolKind::Native),
        other if other.ends_with("_call") => Some(V3HubRelayToolKind::Native),
        _ => None,
    }
}

/// Structural tool-call facts for Direct response payloads.
///
/// Direct does not run the Relay `Resp03` governance stage, so the refill
/// decision still needs one source for "has a real tool call". Only emptiness
/// is consumed by the policy; call identity fields are populated for the
/// shared `V3HubResponseToolCall` shape and must not be projected into any
/// business payload.
pub(crate) fn collect_v3_governed_response_tool_calls(
    payload: &Value,
) -> Vec<V3HubResponseToolCall> {
    payload
        .get("output")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let item_type = item.get("type").and_then(Value::as_str)?;
                    if item_type.ends_with("_output") {
                        return None;
                    }
                    let kind = v3_governed_tool_call_kind(item_type)?;
                    let call_id = item
                        .get("call_id")
                        .or_else(|| item.get("id"))
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or_default()
                        .to_string();
                    let name = item
                        .get("name")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or(item_type)
                        .to_string();
                    Some(V3HubResponseToolCall {
                        call_id,
                        name,
                        kind,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The explicit continuation instruction appended as the last user turn of a
/// bounded refill request. It asks the model to keep going and to call a tool
/// when the task still needs one, so a silent stop can recover without the
/// proxy inventing any business content.
pub(crate) const V3_CHAT_PROCESS_REFILL_INSTRUCTION: &str =
    "继续执行尚未完成的任务；需要工具时直接调用工具；如果任务已完成，请给出完成总结。";

/// Compiled request-local refill budget. This is the single runtime accessor so
/// the selection decision and the launch decision cannot drift. The compiled
/// `internal.toml` value is the only production source; the config crate's
/// effective accessor exists so public-entry tests can inject the same typed
/// policy input.
pub(crate) fn v3_chat_process_refill_max_consecutive() -> u32 {
    routecodex_v3_config::internal::v3_effective_chat_process_refill_max()
}

/// Facts the Chat Process owner hands back to the Relay response-hook caller so
/// Runtime can apply the shared refill policy without re-reading the governed
/// payload or duplicating a decision.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct V3ChatProcessGovernedFacts {
    pub(crate) tool_calls: Vec<V3HubResponseToolCall>,
    /// Source-explicit non-empty summary captured BEFORE governance could
    /// synthesize RCC reasoning/toolreason summary content.
    pub(crate) has_source_summary: bool,
}

/// Build the standard continuation request for one refill execution.
///
/// The original payload is cloned and every unrelated field is kept verbatim
/// (model, instructions, tools, tool_choice, reasoning, parallel tool calls and
/// unknown business extensions). The entry protocol decides which field carries
/// the conversation history: `messages` for Chat and Anthropic, `input` for
/// Responses, `contents` for Gemini. That is the same field the next execution's
/// inbound canonicalization reads, so the appended history actually becomes the
/// next provider request. Each collected business item of the just-finished
/// execution is appended as an assistant turn; a provider-origin reasoning item
/// with real identity and opaque continuation material is appended verbatim
/// because the target protocol can express it, while RCC-synthesized reasoning
/// is not replayable source material and is omitted. The refill instruction is
/// appended as a new user turn. No counter, state or control field ever enters
/// the payload.
pub(crate) fn build_v3_chat_process_refill_continuation_request(
    entry_protocol: V3HubEntryProtocol,
    original_request_payload: &Value,
    current_execution_finalized_response: &Value,
) -> Result<Value, String> {
    let mut payload = original_request_payload.clone();
    let Some(payload_object) = payload.as_object_mut() else {
        return Err("refill continuation requires an object request payload".to_string());
    };
    // Inbound canonicalization owns the representation decision, including the
    // Responses entry that carries the Chat shape. Ask it instead of sniffing
    // field names: extending a field the next execution will not read leaves
    // the provider request unchanged, and writing a second history form makes
    // canonicalization fail on conflicting histories.
    let history_field = super::req_inbound_02_normalized::v3_hub_inbound_history_field(
        entry_protocol,
        original_request_payload,
    );
    // `ResponsesDual` means the request carried both `input` and a `messages`
    // twin. Which side owns the history is not decidable from field presence:
    // inbound merges the decoded `input` with the twin, and the merge is a
    // single complete history that carries business extensions contributed by
    // either side (for example a provider-origin reasoning id and encrypted
    // content on the input side, or a `routecodex_chat_extension` carried only
    // by the messages twin). Use that accepted merged history when inbound
    // accepts it. When the twins are not equivalent (the Responses Direct
    // entry decodes `input` only and never merges), keep `input` as the single
    // owner and drop the derived twin; extending one raw field while the
    // other still exists would make the next inbound reject the request.
    let mut use_messages_history =
        history_field == super::req_inbound_02_normalized::V3HubInboundHistoryField::Messages;
    if history_field == super::req_inbound_02_normalized::V3HubInboundHistoryField::ResponsesDual {
        match super::req_inbound_02_normalized::v3_hub_responses_accepted_chat_history(
            original_request_payload,
        ) {
            Ok(accepted) => {
                payload_object.remove("input");
                payload_object.insert("messages".to_string(), Value::Array(accepted));
                use_messages_history = true;
            }
            Err(_) => {
                payload_object.remove("messages");
            }
        }
    }
    if use_messages_history {
        let messages = payload_object
            .get_mut("messages")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| "refill continuation messages must be an array".to_string())?;
        // Fold same-turn provider reasoning and assistant content exactly like
        // the inbound Responses->Chat canonicalizer. A standalone reasoning
        // carrier row would otherwise project an extra empty assistant message
        // and split one assistant turn into several messages.
        let mut pending_tool_message_index: Option<usize> = None;
        let mut pending_tool_adjacent_deferred_messages: Vec<Value> = Vec::new();
        let mut turn_assistant_tail_index: Option<usize> = None;
        for item in
            collect_v3_chat_process_business_output_items(current_execution_finalized_response)
        {
            match item.get("type").and_then(Value::as_str) {
                Some("message") => {
                    let message = crate::hub_v1::
                        build_v3_chat_assistant_message_from_responses_output_item(&item)
                        .map_err(|error| {
                            format!(
                                "refill continuation cannot convert a business Responses message to a Chat assistant message: {error}"
                            )
                        })?;
                    crate::hub_v1::responses_openai_codec::
                        append_v3_openai_chat_message_preserving_tool_adjacency(
                            messages,
                            &mut pending_tool_message_index,
                            &mut pending_tool_adjacent_deferred_messages,
                            message,
                            turn_assistant_tail_index,
                        )?;
                    turn_assistant_tail_index = Some(messages.len() - 1);
                }
                // A provider-origin reasoning item carries the real `id` and
                // opaque fields such as `encrypted_content`. RCC-synthesized
                // reasoning (`rcc_reason_*`) has no provider identity and must
                // not be replayed as if it were source material.
                Some("reasoning")
                    if item
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| {
                            !id.trim().is_empty() && !id.starts_with("rcc_reason_")
                        }) =>
                {
                    if let Some(message) = crate::hub_v1::
                        build_v3_chat_assistant_reasoning_message_from_responses_output_item(
                            &item,
                        )
                    {
                        crate::hub_v1::responses_openai_codec::
                            append_v3_openai_chat_message_preserving_tool_adjacency(
                                messages,
                                &mut pending_tool_message_index,
                                &mut pending_tool_adjacent_deferred_messages,
                                message,
                                turn_assistant_tail_index,
                            )?;
                        turn_assistant_tail_index = Some(messages.len() - 1);
                    }
                }
                _ => {}
            }
        }
        messages.extend(std::mem::take(&mut pending_tool_adjacent_deferred_messages));
        messages.push(json!({
            "role": "user",
            "content": V3_CHAT_PROCESS_REFILL_INSTRUCTION,
        }));
        return Ok(payload);
    }
    // A Gemini client request carries its history under `contents`, and the
    // Gemini inbound canonicalization rebuilds `messages` from `contents`
    // only. The continuation must therefore extend that same representation;
    // writing `input` here would leave the next provider request identical to
    // the first one, without the answer and without the instruction.
    if history_field == super::req_inbound_02_normalized::V3HubInboundHistoryField::Contents {
        let contents = payload_object
            .get_mut("contents")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| "refill continuation contents must be an array".to_string())?;
        let mut model_parts: Vec<Value> = Vec::new();
        for item in
            collect_v3_chat_process_business_output_items(current_execution_finalized_response)
        {
            // Refill only runs when the round produced no real tool call, so
            // the replayable business content is the assistant message parts.
            if item.get("type").and_then(Value::as_str) != Some("message") {
                continue;
            }
            model_parts.extend(v3_chat_process_refill_gemini_parts(&item));
        }
        if !model_parts.is_empty() {
            contents.push(json!({"role": "model", "parts": model_parts}));
        }
        contents.push(json!({
            "role": "user",
            "parts": [{"text": V3_CHAT_PROCESS_REFILL_INSTRUCTION}],
        }));
        return Ok(payload);
    }
    let mut input = match payload_object.get("input") {
        Some(Value::Array(_)) => payload_object
            .get("input")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
        Some(Value::String(text)) => json!([{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": text}],
        }]),
        None => Value::Array(Vec::new()),
        Some(_) => {
            return Err("refill continuation input must be a string or an input array".to_string())
        }
    };
    let input_array = input
        .as_array_mut()
        .ok_or_else(|| "refill continuation input must normalize to an array".to_string())?;
    for item in collect_v3_chat_process_business_output_items(current_execution_finalized_response)
    {
        let Some(item_type) = item.get("type").and_then(Value::as_str) else {
            continue;
        };
        if item_type != "message" {
            // A provider-origin reasoning item carries the real `id` and
            // opaque fields such as `encrypted_content`, so it is valid
            // continuation input for the target protocol. RCC-synthesized
            // reasoning (`rcc_reason_*`) has no provider identity and must not
            // be replayed as if it were source material. Tool calls stay out:
            // their result belongs to the client's next turn, not to this
            // message-only continuation.
            let provider_origin_id = item
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty() && !id.starts_with("rcc_reason_"));
            if item_type == "reasoning" && provider_origin_id.is_some() {
                input_array.push(item.clone());
            }
            continue;
        }
        let Some(content) = item
            .get("content")
            .filter(|value| value.is_array())
            .cloned()
        else {
            continue;
        };
        input_array.push(json!({
            "type": "message",
            "role": "assistant",
            "content": content,
        }));
    }
    input_array.push(json!({
        "type": "message",
        "role": "user",
        "content": [{"type": "input_text", "text": V3_CHAT_PROCESS_REFILL_INSTRUCTION}],
    }));
    payload_object.insert("input".to_string(), input);
    Ok(payload)
}

/// Native Gemini business parts the governed projection keeps verbatim.
const V3_GEMINI_NATIVE_PART_KEYS: [&str; 4] = [
    "inlineData",
    "fileData",
    "executableCode",
    "codeExecutionResult",
];

/// Project one governed business message into representable Gemini `Parts`.
///
/// Governance keeps the provider's parts and only adds canonical framing: a
/// text part arrives as `output_text` while still carrying its native siblings
/// (for example `thoughtSignature`), and a native part such as `inlineData`
/// arrives verbatim. Only the canonical framing field is removed. Dropping the
/// native parts would silently shrink the continuation history of a round that
/// delivered multimodal business content, and an empty text part is not a valid
/// Gemini Part.
fn v3_chat_process_refill_gemini_parts(business_message: &Value) -> Vec<Value> {
    let mut parts = Vec::new();
    for part in business_message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(row) = part.as_object() else {
            continue;
        };
        if matches!(
            row.get("type").and_then(Value::as_str),
            Some("output_text" | "text")
        ) {
            let text = row.get("text").and_then(Value::as_str).unwrap_or("");
            if text.is_empty() {
                // A sibling native part in the same message still carries the
                // real business content, so skip only this empty Part.
                continue;
            }
            let mut part = row.clone();
            part.remove("type");
            parts.push(Value::Object(part));
            continue;
        }
        if V3_GEMINI_NATIVE_PART_KEYS
            .iter()
            .any(|key| row.contains_key(*key))
        {
            parts.push(part.clone());
        }
    }
    parts
}

/// Collect the business output items of one execution response, in order.
///
/// Every item shape is kept verbatim, including reasoning items: an earlier
/// round's reasoning is real business content that the final standard result
/// must still carry. Only the continuation *request* replays messages (see
/// `build_v3_chat_process_refill_continuation_request`), because a provider
/// regenerates its own reasoning for the next round and cannot accept an
/// invented reasoning item without source identity.
pub(crate) fn collect_v3_chat_process_business_output_items(
    finalized_response: &Value,
) -> Vec<Value> {
    finalized_response
        .get("output")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// Fold prior-round business items and the summed usage into this execution's
/// governed payload, before it is projected to the client protocol.
///
/// Only a refill round calls this: the continuation decision already proved
/// this execution produced no real tool call, so prior rounds carry message
/// business content only. The last execution stays authoritative for its own
/// item order, status and terminal fields; prior items only extend the front of
/// `output`.
pub(crate) fn apply_v3_chat_process_refill_accumulation(
    finalized_response: &mut Value,
    accumulated_items: &[Value],
    accumulated_usage: Option<&V3RuntimeUsageSummary>,
) {
    if accumulated_items.is_empty() {
        return;
    }
    // The delivered total must cover every round, so the final execution's own
    // usage is folded in here before write-back.
    let mut total = accumulated_usage.cloned();
    accumulate_v3_chat_process_refill_usage(
        &mut total,
        super::responses_relay_runtime::extract_v3_runtime_usage_summary(finalized_response),
    );
    merge_v3_chat_process_refill_output_items(finalized_response, accumulated_items);
    if let Some(total) = total.as_ref() {
        write_v3_chat_process_refill_usage(finalized_response, total);
    }
}

/// Merge prior-round business items in front of the last execution's output.
///
/// The last execution stays authoritative for its own item order, ids, status
/// and terminal fields; accumulated items only extend the front of `output`.
/// A missing or non-array `output` is left untouched.
pub(crate) fn merge_v3_chat_process_refill_output_items(
    finalized_response: &mut Value,
    accumulated: &[Value],
) {
    let Some(output) = finalized_response
        .get_mut("output")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    if accumulated.is_empty() {
        return;
    }
    let existing = std::mem::take(output);
    output.extend(accumulated.iter().cloned());
    output.extend(existing);
    rebase_v3_chat_process_refill_candidate_output_indices(finalized_response, accumulated.len());
}

/// Keep the native Gemini candidate association valid after the merge.
///
/// A Gemini provider response records which `output` positions each candidate
/// produced (`gemini_candidate_outcomes[].output_indices`), and the native
/// Gemini client projection emits business content by following those
/// positions. Prepending prior rounds therefore has two consequences: every
/// index of this round moves past the prepended prefix, and the prefix itself
/// must stay reachable or the earlier rounds would never reach the client.
/// The prefix joins the first candidate, which is the candidate a Gemini
/// client reads as the answer.
fn rebase_v3_chat_process_refill_candidate_output_indices(
    finalized_response: &mut Value,
    prepended: usize,
) {
    if prepended == 0 {
        return;
    }
    let Some(outcomes) = finalized_response
        .get_mut("gemini_candidate_outcomes")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for (position, outcome) in outcomes.iter_mut().enumerate() {
        let Some(indices) = outcome
            .get_mut("output_indices")
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        let mut rebased: Vec<Value> = if position == 0 {
            (0..prepended).map(|index| json!(index)).collect()
        } else {
            Vec::new()
        };
        rebased.extend(indices.iter().filter_map(|index| {
            index
                .as_u64()
                .map(|value| json!(value as usize + prepended))
        }));
        *indices = rebased;
    }
}

/// Accumulate one completed refill round's usage into the running summary.
///
/// Missing stays missing: a field absent in any merged round becomes `None`
/// and is never fabricated as 0.
///
/// `None` therefore never means "the chain has no usage": it only means no
/// completed round has been merged yet. A round that completed with no usage
/// evidence at all still marks the chain as observed, so a later round's
/// numbers cannot be read as the whole chain's totals.
pub(crate) fn accumulate_v3_chat_process_refill_usage(
    accumulated: &mut Option<V3RuntimeUsageSummary>,
    round: Option<V3RuntimeUsageSummary>,
) {
    let Some(round) = round else {
        // One completed round was observed and carried no usage evidence: every
        // field is unknown for the chain. Keeping `Some(default)` records that
        // fact instead of leaving the state indistinguishable from "not
        // started", which would let the next round be adopted as round one.
        *accumulated = Some(V3RuntimeUsageSummary::default());
        return;
    };
    let Some(accumulated) = accumulated.as_mut() else {
        *accumulated = Some(round);
        return;
    };
    for (current, value) in [
        (&mut accumulated.input_tokens, round.input_tokens),
        (&mut accumulated.output_tokens, round.output_tokens),
        (&mut accumulated.total_tokens, round.total_tokens),
        (&mut accumulated.cached_tokens, round.cached_tokens),
        (
            &mut accumulated.cache_read_input_tokens,
            round.cache_read_input_tokens,
        ),
        (
            &mut accumulated.cache_creation_input_tokens,
            round.cache_creation_input_tokens,
        ),
    ] {
        *current = match (*current, value) {
            (Some(current), Some(value)) => Some(current.saturating_add(value)),
            _ => None,
        };
    }
}

/// Write an accumulated usage summary into a finalized response.
///
/// Only fields that are actually `Some` are written. The object is rebuilt from
/// the accumulated evidence so a field missing in any round never reappears
/// from the last round's usage.
pub(crate) fn write_v3_chat_process_refill_usage(
    finalized_response: &mut Value,
    usage: &V3RuntimeUsageSummary,
) {
    let Some(response_object) = finalized_response.as_object_mut() else {
        return;
    };
    let mut usage_object = Map::new();
    if let Some(value) = usage.input_tokens {
        usage_object.insert("input_tokens".to_string(), Value::from(value));
    }
    if let Some(value) = usage.output_tokens {
        usage_object.insert("output_tokens".to_string(), Value::from(value));
    }
    if let Some(value) = usage.total_tokens {
        usage_object.insert("total_tokens".to_string(), Value::from(value));
    }
    if let Some(value) = usage.cached_tokens {
        usage_object.insert(
            "input_tokens_details".to_string(),
            json!({"cached_tokens": value}),
        );
    }
    if let Some(value) = usage.cache_read_input_tokens {
        usage_object.insert("cache_read_input_tokens".to_string(), Value::from(value));
    }
    if let Some(value) = usage.cache_creation_input_tokens {
        usage_object.insert(
            "cache_creation_input_tokens".to_string(),
            Value::from(value),
        );
    }
    if usage_object.is_empty() {
        // No observed field: keep usage absent rather than fabricating 0s.
        response_object.remove("usage");
    } else {
        response_object.insert("usage".to_string(), Value::Object(usage_object));
    }
}

/// Exact-attempt tool declaration view consumed by the Relay serialized-tool
/// harvest. It is built only from the request-local namespace registry and its
/// bound wire inverse; it never reads response text, metadata or logs.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct V3RelaySerializedToolIdentity {
    namespace: Option<String>,
    leaf: String,
    kind: ToolMarkupKind,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct V3HubRelaySerializedToolContext {
    declarations: ToolMarkupDeclarations,
    identities: HashMap<String, V3RelaySerializedToolIdentity>,
}

fn relay_declared_parameter_kinds(source: &Value) -> HashMap<String, ToolMarkupParamKind> {
    source
        .get("parameters")
        .or_else(|| source.pointer("/function/parameters"))
        .and_then(|parameters| parameters.get("properties"))
        .and_then(Value::as_object)
        .map(|properties| {
            properties
                .iter()
                .filter_map(|(name, schema)| {
                    schema
                        .get("type")
                        .and_then(Value::as_str)
                        .map(|kind| (name.clone(), ToolMarkupParamKind::declared(kind)))
                })
                .collect()
        })
        .unwrap_or_default()
}

impl V3HubRelaySerializedToolContext {
    /// Build the parser declaration view and exact wire-name identity from the
    /// request-local registry. Duplicate keys are dropped rather than guessed.
    pub(crate) fn from_registry(
        registry: &provider_compat_core::namespace_tools::NamespaceToolIdentityRegistry,
    ) -> Self {
        let inverse = registry.restore_identities();
        let mut context = Self::default();
        let mut ambiguous: HashSet<String> = HashSet::new();
        for identity in registry.identities() {
            let namespace = identity
                .is_namespaced()
                .then(|| identity.client_namespace());
            let resolved = V3RelaySerializedToolIdentity {
                namespace: namespace.clone(),
                leaf: identity.leaf_name.clone(),
                kind: match identity.kind {
                    provider_compat_core::namespace_tools::ToolKind::Function => {
                        ToolMarkupKind::Function
                    }
                    provider_compat_core::namespace_tools::ToolKind::Custom => {
                        ToolMarkupKind::Custom
                    }
                },
            };
            let declaration = ToolMarkupIdentity {
                kind: resolved.kind,
                parameter_kinds: relay_declared_parameter_kinds(&identity.source),
            };
            let keys = std::iter::once(identity.actual_wire_name.clone())
                .chain(std::iter::once(identity.leaf_name.clone()))
                .chain(
                    inverse
                        .iter()
                        .filter(|(_, (ns, leaf))| {
                            leaf == &identity.leaf_name
                                && Some(ns.as_str()) == namespace.as_deref().or(Some(""))
                        })
                        .map(|(wire, _)| wire.clone()),
                );
            for key in keys {
                if context
                    .identities
                    .get(&key)
                    .is_some_and(|old| old != &resolved)
                {
                    ambiguous.insert(key.clone());
                }
                context.identities.insert(key.clone(), resolved.clone());
                context.declarations.insert(key, declaration.clone());
            }
        }
        for name in ambiguous {
            context.identities.remove(&name);
            context.declarations.remove(&name);
        }
        context
    }

    fn identity(&self, wire_name: &str) -> Option<&V3RelaySerializedToolIdentity> {
        self.identities.get(wire_name)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRelayResponseHookProfile {
    /// 请求侧 VR 路由决策时算好的"该请求是否保留响应密文"标记：仅当目标是 gpt 模型
    /// **且该模型只有单一 provider 候选**时，响应里的 `encrypted_content` 才原样透传给
    /// Codex 客户端（客户端用自己的密文重建 reasoning 历史）；其余情况 Resp03 一律剥离。
    /// 默认 false（剥离），响应侧只消费该结果，不重复判定。
    retain_response_cipher: bool,
    tool_thinking: bool,
    toolreason_client_projection: bool,
    toolreason_expected_model_id: Option<String>,
    toolreason_observation_enabled: bool,
    toolreason_observation_session_id: Option<String>,
    toolreason_observation_request_id: Option<String>,
    tool_thinking_original_custom_tool_names: BTreeSet<String>,
    serialized_tool_context: V3HubRelaySerializedToolContext,
    complete_provider_attempt: bool,
}

impl V3HubRelayResponseHookProfile {
    pub fn empty() -> Self {
        Self {
            retain_response_cipher: false,
            tool_thinking: false,
            toolreason_client_projection: true,
            toolreason_expected_model_id: None,
            toolreason_observation_enabled: true,
            toolreason_observation_session_id: None,
            toolreason_observation_request_id: None,
            tool_thinking_original_custom_tool_names: BTreeSet::new(),
            serialized_tool_context: V3HubRelaySerializedToolContext::default(),
            complete_provider_attempt: false,
        }
    }

    pub(crate) fn with_serialized_tool_context(
        mut self,
        context: V3HubRelaySerializedToolContext,
    ) -> Self {
        self.serialized_tool_context = context;
        self
    }

    fn serialized_tool_context(&self) -> &V3HubRelaySerializedToolContext {
        &self.serialized_tool_context
    }

    pub(crate) fn with_complete_provider_attempt(mut self, complete: bool) -> Self {
        self.complete_provider_attempt = complete;
        self
    }

    /// 请求侧 VR 路由决策写入的"保留响应密文"标记；响应侧只消费，不重复判定。
    pub fn with_retain_response_cipher(mut self, retain: bool) -> Self {
        self.retain_response_cipher = retain;
        self
    }

    pub fn retain_response_cipher(&self) -> bool {
        self.retain_response_cipher
    }

    pub fn with_tool_thinking_enabled(mut self, enabled: bool) -> Self {
        self.tool_thinking = enabled;
        self
    }

    pub fn tool_thinking_enabled(&self) -> bool {
        self.tool_thinking
    }

    pub(crate) fn with_tool_thinking_turn_context(
        mut self,
        context: &super::tool_thinking_hooks::V3ToolThinkingTurnContext,
    ) -> Self {
        self.tool_thinking_original_custom_tool_names = context
            .original_custom_tool_names()
            .cloned()
            .unwrap_or_default();
        self
    }

    pub(crate) fn tool_thinking_original_custom_tool_names(&self) -> &BTreeSet<String> {
        &self.tool_thinking_original_custom_tool_names
    }

    pub fn with_toolreason_client_projection(mut self, enabled: bool) -> Self {
        self.toolreason_client_projection = enabled;
        self
    }

    pub fn toolreason_client_projection_enabled(&self) -> bool {
        self.toolreason_client_projection
    }

    pub fn with_toolreason_expected_model_id(mut self, model_id: impl Into<String>) -> Self {
        self.toolreason_expected_model_id = Some(model_id.into());
        self
    }

    pub fn toolreason_expected_model_id(&self) -> Option<&str> {
        self.toolreason_expected_model_id.as_deref()
    }

    pub fn with_toolreason_observation_enabled(mut self, enabled: bool) -> Self {
        self.toolreason_observation_enabled = enabled;
        self
    }

    pub fn toolreason_observation_enabled(&self) -> bool {
        self.toolreason_observation_enabled
    }

    pub fn with_toolreason_observation_request_id(mut self, request_id: impl Into<String>) -> Self {
        self.toolreason_observation_request_id = Some(request_id.into());
        self
    }

    pub fn with_toolreason_observation_session_id(mut self, session_id: impl Into<String>) -> Self {
        self.toolreason_observation_session_id = Some(session_id.into());
        self
    }

    pub fn toolreason_observation_session_id(&self) -> Option<&str> {
        self.toolreason_observation_session_id.as_deref()
    }

    pub fn toolreason_observation_request_id(&self) -> Option<&str> {
        self.toolreason_observation_request_id.as_deref()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum V3HubRelayResponseError {
    #[error("Relay response hook received a non-Relay response")]
    ExecutionModeNotRelay,
    #[error("provider response must be an object")]
    ProviderResponseNotObject,
    #[error("provider response output must be an array")]
    ProviderResponseOutputNotArray,
    #[error("malformed tool call at output index {index}: {reason}")]
    MalformedToolCall { index: usize, reason: &'static str },
    #[error("provider response status is required")]
    MissingStatus,
    #[error("unsupported provider response status: {status}")]
    UnsupportedStatus { status: String },
    #[error("{protocol} provider response is malformed at Resp03: {reason}")]
    ProviderProtocolResponseMalformed {
        protocol: &'static str,
        reason: &'static str,
    },
    #[error("provider response compat failed: {reason}")]
    ProviderCompatFailed { reason: String },
    #[error("provider response contained no deliverable business content after Relay governance")]
    GovernedAttemptEmpty,
    #[error("provider response contains a recognized incomplete tool invocation")]
    UnharvestableToolMarkup,
}

#[derive(Debug, Clone, Copy)]
pub struct V3HubRelayResponseHookRegistry {
    normalize: fn(
        V3ProviderRespInbound01Raw,
        Option<&Value>,
        Option<&str>,
    ) -> Result<V3HubRespInbound02Normalized, V3HubRelayResponseError>,
    govern: fn(
        V3HubRespInbound02Normalized,
        &V3HubRelayResponseHookProfile,
    ) -> Result<V3HubRespChatProcess03Outcome, V3HubRelayResponseError>,
    typed_sse_catalog: V3RelaySseHookCatalog,
    complete_chat_sse:
        fn(
            &[Vec<u8>],
            Option<usize>,
            &V3HubRelaySerializedToolContext,
        ) -> Result<Option<(Vec<Vec<u8>>, usize)>, super::V3RelayCompleteResponseError>,
}

impl V3HubRelayResponseHookRegistry {
    pub fn normalize(
        &self,
        input: V3ProviderRespInbound01Raw,
    ) -> Result<V3HubRespInbound02Normalized, V3HubRelayResponseError> {
        self.normalize_with_context(input, None, None)
    }

    pub(crate) fn normalize_with_context(
        &self,
        input: V3ProviderRespInbound01Raw,
        chat_request: Option<&Value>,
        request_id: Option<&str>,
    ) -> Result<V3HubRespInbound02Normalized, V3HubRelayResponseError> {
        (self.normalize)(input, chat_request, request_id)
    }

    pub fn govern(
        &self,
        input: V3HubRespInbound02Normalized,
        profile: &V3HubRelayResponseHookProfile,
    ) -> Result<V3HubRespChatProcess03Outcome, V3HubRelayResponseError> {
        govern_v3_hub_relay_response_via_operator(input, profile, self.govern)
    }

    pub(crate) fn typed_sse_catalog(&self) -> V3RelaySseHookCatalog {
        self.typed_sse_catalog
    }

    pub(crate) fn govern_complete_chat_sse(
        &self,
        builder: &mut crate::execution_control::V3CommittedClientSseBuilder,
        namespace_registry: &provider_compat_core::namespace_tools::NamespaceToolIdentityRegistry,
    ) -> Result<(), super::V3RelayCompleteResponseError> {
        let source_terminal = builder.last_marked_terminal_frame_index();
        let context = V3HubRelaySerializedToolContext::from_registry(namespace_registry);
        builder.rewrite_complete_attempt(|frames| {
            (self.complete_chat_sse)(frames, source_terminal, &context)
        })
    }
}

pub fn compile_v3_hub_relay_response_hooks() -> V3HubRelayResponseHookRegistry {
    V3HubRelayResponseHookRegistry {
        normalize: normalize_v3_hub_relay_response,
        govern: govern_v3_hub_relay_response,
        typed_sse_catalog: V3RelaySseHookCatalog::new(),
        complete_chat_sse:
            super::resp_chat_process_complete_chat_sse::govern_complete_chat_sse_with_context,
    }
}

fn normalize_v3_hub_relay_response(
    input: V3ProviderRespInbound01Raw,
    chat_request: Option<&Value>,
    request_id: Option<&str>,
) -> Result<V3HubRespInbound02Normalized, V3HubRelayResponseError> {
    if input.execution != V3HubExecutionMode::Relay {
        return Err(V3HubRelayResponseError::ExecutionModeNotRelay);
    }
    if !input.payload.0.is_object() {
        return Err(V3HubRelayResponseError::ProviderResponseNotObject);
    }
    let compat =
        build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(input).map_err(|error| {
            V3HubRelayResponseError::ProviderCompatFailed {
                reason: error.to_string(),
            }
        })?;
    Ok(
        build_v3_hub_resp_inbound_02_from_provider_resp_compat_02_with_chat_request_and_request_id(
            compat,
            chat_request,
            request_id,
        )
        .map_err(|error| V3HubRelayResponseError::ProviderCompatFailed { reason: error })?,
    )
}

fn govern_v3_hub_relay_response(
    input: V3HubRespInbound02Normalized,
    profile: &V3HubRelayResponseHookProfile,
) -> Result<V3HubRespChatProcess03Outcome, V3HubRelayResponseError> {
    // 响应侧密文清理（运行时真路径）：消费请求侧 VR 路由决策写入的
    // retain_response_cipher 标记——仅 gpt 单 provider 保留，其余一律剥离。
    let input =
        strip_v3_resp03_encrypted_reasoning_content(input, profile.retain_response_cipher());
    let mut input = harvest_v3_think_blocks_at_resp03(input);
    let is_responses_protocol = input.semantic_protocol() == V3HubProviderWireProtocol::Responses;
    let payload = Arc::make_mut(&mut input.previous.previous.payload.0);
    if is_responses_protocol {
        scrub_v3_provider_model_identity_instructions(payload);
    }
    if profile.toolreason_observation_enabled() {
        let context = V3ToolreasonObservationContext {
            session_id: profile.toolreason_observation_session_id(),
            request_id: profile.toolreason_observation_request_id(),
        };
        if let Some(expected_model_id) = profile.toolreason_expected_model_id() {
            map_v3_toolreason_to_reasoning_content_at_resp03_with_expected_model_and_context(
                payload,
                profile.tool_thinking_enabled(),
                profile.toolreason_client_projection_enabled(),
                Some(expected_model_id),
                context,
            );
        } else {
            map_v3_toolreason_to_reasoning_content_at_resp03_with_projection_and_context(
                payload,
                profile.tool_thinking_enabled(),
                profile.toolreason_client_projection_enabled(),
                context,
            );
        }
    } else {
        map_v3_toolreason_to_reasoning_content_at_resp03_without_observation(
            payload,
            profile.tool_thinking_enabled(),
            profile.toolreason_client_projection_enabled(),
        );
    }
    if profile.serialized_tool_context().identities.is_empty()
        && (profile.complete_provider_attempt
            || input.normalized_kind() == super::V3HubResponseNormalizedKind::Json)
    {
        govern_v3_relay_control_markers_at_resp03(&mut input)?;
    } else if !profile.serialized_tool_context().identities.is_empty() {
        tool_markup::govern(&mut input, profile.serialized_tool_context())?;
    }
    if profile.complete_provider_attempt {
        tool_markup::govern_thinking(&mut input);
    }
    let governance = build_v3_resp03_protocol_governance(&input)?;
    let branch = inspect_v3_resp03_finish_reason(&input, &governance);
    let (input, governance) = match branch {
        V3Resp03FinishReasonBranch::ToolCall => {
            let mut input = project_v3_apply_patch_freeform_calls_at_resp03(input);
            restore_v3_tool_thinking_custom_calls_at_resp03(
                &mut input,
                profile.tool_thinking_original_custom_tool_names(),
            );
            let governance = build_v3_resp03_protocol_governance(&input)?;
            (input, governance)
        }
        V3Resp03FinishReasonBranch::Stop => {
            let governance = build_v3_resp03_protocol_governance(&input)?;
            (input, governance)
        }
        V3Resp03FinishReasonBranch::Other => (input, governance),
    };
    // Only the complete post-governance result authorizes client delivery.
    if profile.complete_provider_attempt
        && !super::v3_provider_attempt_has_deliverable_business_content(
            input.semantic_protocol(),
            input.provider_payload().as_ref(),
        )
    {
        return Err(V3HubRelayResponseError::GovernedAttemptEmpty);
    }
    let terminality = if governance.tool_calls.is_empty() {
        governance.status_terminality
    } else {
        V3HubResponseTerminality::NonTerminal
    };
    Ok(V3HubRespChatProcess03Outcome {
        data: V3HubRespChatProcess03Governed {
            previous: input,
            terminality,
            tool_calls: governance.tool_calls,
        },
    })
}

type V3HubRelayResponseGovernFn =
    fn(
        V3HubRespInbound02Normalized,
        &V3HubRelayResponseHookProfile,
    ) -> Result<V3HubRespChatProcess03Outcome, V3HubRelayResponseError>;

struct GovernChatResponseOperator {
    input: V3HubRespInbound02Normalized,
    profile: V3HubRelayResponseHookProfile,
    govern: V3HubRelayResponseGovernFn,
    side_output: Arc<Mutex<Option<GovernedResponseSideOutput>>>,
}

#[derive(Debug)]
enum GovernedResponseSideOutput {
    Complete(Box<V3HubRespChatProcess03Outcome>),
    Error(V3HubRelayResponseError),
}

impl GovernChatResponseOperator {
    fn new(
        input: V3HubRespInbound02Normalized,
        profile: &V3HubRelayResponseHookProfile,
        govern: V3HubRelayResponseGovernFn,
        side_output: Arc<Mutex<Option<GovernedResponseSideOutput>>>,
    ) -> Self {
        Self {
            input,
            profile: profile.clone(),
            govern,
            side_output,
        }
    }
}

impl Operator for GovernChatResponseOperator {
    fn name(&self) -> &'static str {
        "routecodex.v3.operation.govern_chat_response"
    }

    fn version(&self) -> &'static str {
        "1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Object
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _: &OperatorContext) -> Result<Value, String> {
        let mut captured = self.input.clone();
        *captured.provider_payload_mut() = Arc::new(input);
        match (self.govern)(captured, &self.profile) {
            Ok(governed) => {
                *self.side_output.lock().map_err(|_| {
                    "response governance side-output holder is poisoned".to_string()
                })? = Some(GovernedResponseSideOutput::Complete(Box::new(
                    governed.clone(),
                )));
                Ok(governed.finalized_payload().clone())
            }
            Err(error) => {
                let error_message = error.to_string();
                *self.side_output.lock().map_err(|_| {
                    "response governance side-output holder is poisoned".to_string()
                })? = Some(GovernedResponseSideOutput::Error(error));
                Err(error_message)
            }
        }
    }
}

fn govern_v3_hub_relay_response_via_operator(
    input: V3HubRespInbound02Normalized,
    profile: &V3HubRelayResponseHookProfile,
    govern: V3HubRelayResponseGovernFn,
) -> Result<V3HubRespChatProcess03Outcome, V3HubRelayResponseError> {
    let side_output = Arc::new(Mutex::new(None));
    let operator =
        GovernChatResponseOperator::new(input.clone(), profile, govern, side_output.clone());
    let executed = run_v3_single_node_operator(
        V3OperationGraph::Response,
        "govern_chat_response",
        input.provider_payload().as_ref().clone(),
        operator,
    );
    let captured = side_output
        .lock()
        .map_err(|_| V3HubRelayResponseError::ProviderCompatFailed {
            reason: "response governance side-output holder is poisoned".to_string(),
        })?
        .take();
    resolve_governed_response_execution(executed, captured)
}

fn resolve_governed_response_execution(
    executed: Result<Value, OperationRunnerError>,
    captured: Option<GovernedResponseSideOutput>,
) -> Result<V3HubRespChatProcess03Outcome, V3HubRelayResponseError> {
    match (executed, captured) {
        (Err(_), Some(GovernedResponseSideOutput::Error(error))) => Err(error),
        (Err(runner_error), _) => Err(operation_runner_response_error(runner_error)),
        (Ok(executed), Some(GovernedResponseSideOutput::Complete(mut outcome))) => {
            *outcome.data.previous.provider_payload_mut() = Arc::new(executed);
            Ok(*outcome)
        }
        (Ok(_), Some(GovernedResponseSideOutput::Error(error))) => Err(error),
        (Ok(_), None) => Err(V3HubRelayResponseError::ProviderCompatFailed {
            reason: "response governance operator omitted typed side output".to_string(),
        }),
    }
}

fn operation_runner_response_error(error: OperationRunnerError) -> V3HubRelayResponseError {
    V3HubRelayResponseError::ProviderCompatFailed {
        reason: format!("canonical response governance failed: {error}"),
    }
}

fn restore_v3_tool_thinking_custom_calls_at_resp03(
    input: &mut V3HubRespInbound02Normalized,
    original_custom_tool_names: &BTreeSet<String>,
) {
    let payload = Arc::make_mut(input.provider_payload_mut());
    restore_v3_tool_thinking_custom_calls_in_payload_at_resp03(payload, original_custom_tool_names);
}

pub(crate) fn restore_v3_tool_thinking_custom_calls_in_payload_at_resp03(
    payload: &mut Value,
    original_custom_tool_names: &BTreeSet<String>,
) {
    if original_custom_tool_names.is_empty() {
        return;
    }
    if let Some(output) = payload.get_mut("output").and_then(Value::as_array_mut) {
        for item in output {
            let Some(row) = item.as_object_mut() else {
                continue;
            };
            if row.get("type").and_then(Value::as_str) != Some("function_call") {
                continue;
            }
            let Some(name) = row.get("name").and_then(Value::as_str) else {
                continue;
            };
            if !original_custom_tool_names.contains(name) {
                continue;
            }
            let Some(arguments) = row.get("arguments").and_then(Value::as_str) else {
                continue;
            };
            let Some((native_input, fields)) = parse_v3_custom_tool_wrapper_for_resp03(arguments)
            else {
                continue;
            };
            row.insert(
                "type".to_string(),
                Value::String("custom_tool_call".to_string()),
            );
            row.insert("input".to_string(), Value::String(native_input));
            row.remove("arguments");
            for (key, value) in fields {
                row.insert(key, value);
            }
        }
    }
    if let Some(choices) = payload.get_mut("choices").and_then(Value::as_array_mut) {
        for choice in choices {
            let Some(tool_calls) = choice
                .pointer_mut("/message/tool_calls")
                .and_then(Value::as_array_mut)
            else {
                continue;
            };
            for call in tool_calls {
                let Some(row) = call.as_object_mut() else {
                    continue;
                };
                let Some(function) = row.get_mut("function").and_then(Value::as_object_mut) else {
                    continue;
                };
                let Some(name) = function.get("name").and_then(Value::as_str) else {
                    continue;
                };
                if !original_custom_tool_names.contains(name) {
                    continue;
                }
                let Some(arguments) = function.get("arguments").and_then(Value::as_str) else {
                    continue;
                };
                let Some((native_input, _fields)) =
                    parse_v3_custom_tool_wrapper_for_resp03(arguments)
                else {
                    continue;
                };
                function.insert(
                    "arguments".to_string(),
                    Value::String(serde_json::json!({"input": native_input}).to_string()),
                );
            }
        }
    }
}

fn parse_v3_custom_tool_wrapper_for_resp03(
    arguments: &str,
) -> Option<(String, Vec<(String, Value)>)> {
    if json_object_has_duplicate_keys_at_resp03(arguments) {
        return None;
    }
    let Value::Object(wrapper) = serde_json::from_str::<Value>(arguments).ok()? else {
        return None;
    };
    let native_input = recognized_v3_custom_tool_wrapper_input_at_resp03(&wrapper)?.to_owned();
    wrapper.get("reason")?.as_str()?;
    let fields = ["reason", "goal_alignment_confidence", "model_id"]
        .into_iter()
        .filter_map(|key| {
            wrapper
                .get(key)
                .cloned()
                .map(|value| (key.to_string(), value))
        })
        .collect();
    Some((native_input, fields))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum V3Resp03FinishReasonBranch {
    ToolCall,
    Stop,
    Other,
}

struct V3Resp03ProtocolGovernance {
    status_terminality: V3HubResponseTerminality,
    tool_calls: Vec<V3HubResponseToolCall>,
}

fn inspect_v3_resp03_finish_reason(
    input: &V3HubRespInbound02Normalized,
    governance: &V3Resp03ProtocolGovernance,
) -> V3Resp03FinishReasonBranch {
    if !governance.tool_calls.is_empty() || response_has_v3_resp03_tool_call_finish_reason(input) {
        return V3Resp03FinishReasonBranch::ToolCall;
    }
    if governance.status_terminality == V3HubResponseTerminality::Terminal
        && response_has_v3_resp03_stop_finish_reason(input)
    {
        return V3Resp03FinishReasonBranch::Stop;
    }
    V3Resp03FinishReasonBranch::Other
}

fn response_has_v3_resp03_tool_call_finish_reason(input: &V3HubRespInbound02Normalized) -> bool {
    response_v3_resp03_finish_reasons(input.provider_payload().as_ref())
        .iter()
        .any(|value| matches!(value.as_str(), "tool_calls" | "tool_call"))
}

fn response_has_v3_resp03_stop_finish_reason(input: &V3HubRespInbound02Normalized) -> bool {
    let finish_reasons = response_v3_resp03_finish_reasons(input.provider_payload().as_ref());
    if finish_reasons.is_empty() {
        return input
            .provider_payload()
            .get("status")
            .and_then(Value::as_str)
            == Some("completed");
    }
    finish_reasons.iter().any(|value| {
        matches!(
            value.as_str(),
            "stop" | "end_turn" | "complete" | "completed" | "STOP"
        )
    })
}

fn response_v3_resp03_finish_reasons(payload: &Value) -> Vec<String> {
    let mut values = Vec::new();
    for path in [
        &["finish_reason"][..],
        &["finishReason"][..],
        &["stop_reason"][..],
        &["stopReason"][..],
        &["response", "finish_reason"][..],
        &["response", "finishReason"][..],
        &["response", "stop_reason"][..],
        &["response", "stopReason"][..],
        &["choices", "0", "finish_reason"][..],
        &["candidates", "0", "finishReason"][..],
    ] {
        if let Some(value) = v3_resp03_string_path(payload, path) {
            values.push(value);
        }
    }
    values
}

fn v3_resp03_string_path(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for segment in path {
        if let Ok(index) = segment.parse::<usize>() {
            current = current.as_array()?.get(index)?;
        } else {
            current = current.as_object()?.get(*segment)?;
        }
    }
    current.as_str().map(str::to_owned)
}

fn build_v3_resp03_protocol_governance(
    input: &V3HubRespInbound02Normalized,
) -> Result<V3Resp03ProtocolGovernance, V3HubRelayResponseError> {
    match input.semantic_protocol() {
        V3HubProviderWireProtocol::Responses => {
            build_v3_responses_resp03_protocol_governance(input.provider_payload().as_ref())
        }
        V3HubProviderWireProtocol::OpenAiChat => {
            build_v3_openai_chat_resp03_protocol_governance(input.provider_payload().as_ref())
        }
        V3HubProviderWireProtocol::Gemini => build_v3_gemini_resp03_protocol_governance(
            input.provider_payload().as_ref(),
            input.provider_raw().transport_intent,
        ),
        V3HubProviderWireProtocol::Anthropic => {
            Err(V3HubRelayResponseError::ProviderProtocolResponseMalformed {
                protocol: "anthropic",
                reason: "Anthropic provider wire is not a Relay Chat Process response protocol",
            })
        }
    }
}

fn build_v3_responses_resp03_protocol_governance(
    payload: &Value,
) -> Result<V3Resp03ProtocolGovernance, V3HubRelayResponseError> {
    let object = payload
        .as_object()
        .ok_or(V3HubRelayResponseError::ProviderResponseNotObject)?;
    let output = match object.get("output") {
        Some(Value::Array(output)) => output.as_slice(),
        Some(_) => return Err(V3HubRelayResponseError::ProviderResponseOutputNotArray),
        None => &[],
    };
    let tool_calls = collect_v3_resp03_responses_tool_calls(output)?;
    let status = object
        .get("status")
        .and_then(Value::as_str)
        .ok_or(V3HubRelayResponseError::MissingStatus)?;
    let status_terminality = match status {
        "completed" | "incomplete" => V3HubResponseTerminality::Terminal,
        "requires_action" | "in_progress" | "queued" => V3HubResponseTerminality::NonTerminal,
        _ => {
            return Err(V3HubRelayResponseError::UnsupportedStatus {
                status: status.to_owned(),
            });
        }
    };
    Ok(V3Resp03ProtocolGovernance {
        status_terminality,
        tool_calls,
    })
}

fn collect_v3_resp03_responses_tool_calls(
    output: &[Value],
) -> Result<Vec<V3HubResponseToolCall>, V3HubRelayResponseError> {
    let mut tool_calls = Vec::new();
    for (index, item) in output.iter().enumerate() {
        let Some(item) = item.as_object() else {
            continue;
        };
        let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
        if !matches!(kind, "function_call" | "custom_tool_call" | "tool_call") {
            continue;
        }
        let call_id = item
            .get("call_id")
            .or_else(|| item.get("id"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or(V3HubRelayResponseError::MalformedToolCall {
                index,
                reason: "missing call_id/id",
            })?;
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| {
                item.get("function")
                    .and_then(Value::as_object)
                    .and_then(|function| function.get("name"))
                    .and_then(Value::as_str)
            })
            .filter(|value| !value.is_empty())
            .ok_or(V3HubRelayResponseError::MalformedToolCall {
                index,
                reason: "missing name/function.name",
            })?;
        tool_calls.push(V3HubResponseToolCall {
            call_id: call_id.to_owned(),
            name: name.to_owned(),
            kind: classify_v3_hub_relay_tool_kind(kind, name),
        });
    }
    Ok(tool_calls)
}

fn build_v3_openai_chat_resp03_protocol_governance(
    payload: &Value,
) -> Result<V3Resp03ProtocolGovernance, V3HubRelayResponseError> {
    let choices = payload.get("choices").and_then(Value::as_array).ok_or(
        V3HubRelayResponseError::ProviderProtocolResponseMalformed {
            protocol: "openai_chat",
            reason: "choices must be an array",
        },
    )?;
    let mut output = Vec::new();
    for choice in choices {
        for call in choice
            .pointer("/message/tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            output.push(json!({
                "type": "function_call",
                "call_id": call.get("id").cloned().unwrap_or(Value::Null),
                "name": call.pointer("/function/name").cloned().unwrap_or(Value::Null)
            }));
        }
    }
    Ok(V3Resp03ProtocolGovernance {
        status_terminality: V3HubResponseTerminality::Terminal,
        tool_calls: collect_v3_resp03_responses_tool_calls(&output)?,
    })
}

fn build_v3_gemini_resp03_protocol_governance(
    payload: &Value,
    transport_intent: V3HubTransportIntent,
) -> Result<V3Resp03ProtocolGovernance, V3HubRelayResponseError> {
    // Gemini may report a prompt-level block without creating any candidates.
    // Read that real business terminal without inventing an output container.
    if payload.get("candidates").is_none() && super::v3_gemini_prompt_feedback_is_terminal(payload)
    {
        return Ok(V3Resp03ProtocolGovernance {
            status_terminality: V3HubResponseTerminality::Terminal,
            tool_calls: Vec::new(),
        });
    }
    let candidates = payload.get("candidates").and_then(Value::as_array).ok_or(
        V3HubRelayResponseError::ProviderProtocolResponseMalformed {
            protocol: "gemini",
            reason: "candidates must be an array",
        },
    )?;
    let mut output = Vec::new();
    for candidate in candidates {
        for part in candidate
            .get("content")
            .and_then(|content| content.get("parts"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(function_call) = part.get("functionCall") else {
                continue;
            };
            let name = function_call
                .get("name")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or(V3HubRelayResponseError::ProviderProtocolResponseMalformed {
                    protocol: "gemini",
                    reason: "functionCall.name is required",
                })?;
            output.push(json!({"type":"function_call","call_id":name,"name":name}));
        }
    }
    let terminal = super::v3_gemini_prompt_feedback_is_terminal(payload)
        || candidates.iter().any(|candidate| {
            candidate
                .get("finishReason")
                .is_some_and(|value| !value.is_null())
        });
    let status_terminality = if transport_intent == V3HubTransportIntent::Sse && !terminal {
        V3HubResponseTerminality::NonTerminal
    } else {
        V3HubResponseTerminality::Terminal
    };
    Ok(V3Resp03ProtocolGovernance {
        status_terminality,
        tool_calls: collect_v3_resp03_responses_tool_calls(&output)?,
    })
}

pub(crate) fn classify_v3_hub_relay_tool_kind(raw_kind: &str, name: &str) -> V3HubRelayToolKind {
    if name == "apply_patch" {
        return V3HubRelayToolKind::ApplyPatch;
    }
    if raw_kind == "custom_tool_call" {
        return V3HubRelayToolKind::Custom;
    }
    if name.strip_prefix("mcp.").is_some() || name.strip_prefix("mcp__").is_some() {
        return V3HubRelayToolKind::Mcp;
    }
    if name.strip_prefix("native.").is_some() || name.strip_prefix("native__").is_some() {
        return V3HubRelayToolKind::Native;
    }
    V3HubRelayToolKind::Function
}

fn harvest_v3_think_blocks_at_resp03(
    mut input: V3HubRespInbound02Normalized,
) -> V3HubRespInbound02Normalized {
    let mut next = input.provider_payload().as_ref().clone();
    let changed = match input.semantic_protocol() {
        V3HubProviderWireProtocol::Responses => harvest_v3_responses_think_blocks(&mut next),
        V3HubProviderWireProtocol::OpenAiChat => harvest_v3_openai_chat_think_blocks(&mut next),
        V3HubProviderWireProtocol::Gemini => harvest_v3_gemini_think_blocks(&mut next),
        V3HubProviderWireProtocol::Anthropic => false,
    };
    if changed {
        *input.provider_payload_mut() = Arc::new(next);
    }
    input
}

/// Remove only declared standalone control labels from the semantic response
/// carriers. This increment does not harvest serialized invocations: a parsed
/// call segment is restored from its original envelope text so its payload
/// bytes, order and association remain unchanged.
fn govern_v3_relay_control_markers_at_resp03(
    input: &mut V3HubRespInbound02Normalized,
) -> Result<(), V3HubRelayResponseError> {
    let declarations = ToolMarkupDeclarations::default();
    let mut next = input.provider_payload().as_ref().clone();
    let changed = match input.semantic_protocol() {
        V3HubProviderWireProtocol::Responses => {
            strip_v3_responses_control_markers(&mut next, &declarations)?
        }
        V3HubProviderWireProtocol::OpenAiChat => {
            strip_v3_openai_chat_control_markers(&mut next, &declarations)?
        }
        V3HubProviderWireProtocol::Gemini | V3HubProviderWireProtocol::Anthropic => false,
    };
    if changed {
        *input.provider_payload_mut() = Arc::new(next);
    }
    Ok(())
}

fn strip_v3_relay_control_marker_text(
    text: &str,
    declarations: &ToolMarkupDeclarations,
) -> Result<Option<String>, V3HubRelayResponseError> {
    let scan = scan_tool_markup(text, declarations);
    if scan.incomplete_tool_invocation {
        return Err(V3HubRelayResponseError::UnharvestableToolMarkup);
    }
    if !scan.removed_label {
        return Ok(None);
    }
    let mut visible = String::with_capacity(text.len());
    for segment in scan.segments {
        match segment {
            ToolMarkupSegment::Text(text) => visible.push_str(text),
            // This increment keeps every serialized invocation opaque. Calls
            // in one envelope share the envelope span; restore it once.
            ToolMarkupSegment::Calls(calls) => {
                if let Some(call) = calls.first() {
                    visible.push_str(call.envelope);
                }
            }
        }
    }
    Ok(Some(visible))
}

fn strip_v3_relay_control_marker_string(
    value: &mut Value,
    declarations: &ToolMarkupDeclarations,
) -> Result<bool, V3HubRelayResponseError> {
    let Some(text) = value.as_str() else {
        return Ok(false);
    };
    let Some(stripped) = strip_v3_relay_control_marker_text(text, declarations)? else {
        return Ok(false);
    };
    *value = Value::String(stripped);
    Ok(true)
}

fn strip_v3_relay_control_marker_content(
    value: &mut Value,
    declarations: &ToolMarkupDeclarations,
) -> Result<bool, V3HubRelayResponseError> {
    match value {
        Value::String(_) => strip_v3_relay_control_marker_string(value, declarations),
        Value::Array(parts) => {
            let mut changed = false;
            for part in parts {
                match part {
                    Value::String(_) => {
                        changed |= strip_v3_relay_control_marker_string(part, declarations)?;
                    }
                    Value::Object(object) => {
                        let text_part =
                            object
                                .get("type")
                                .and_then(Value::as_str)
                                .is_none_or(|kind| {
                                    matches!(
                                        kind,
                                        "text" | "output_text" | "input_text" | "refusal"
                                    )
                                });
                        if !text_part {
                            continue;
                        }
                        if let Some(text) = object.get_mut("text") {
                            changed |= strip_v3_relay_control_marker_string(text, declarations)?;
                        }
                        if let Some(refusal) = object.get_mut("refusal") {
                            changed |= strip_v3_relay_control_marker_string(refusal, declarations)?;
                        }
                    }
                    Value::Null | Value::Bool(_) | Value::Number(_) | Value::Array(_) => {}
                }
            }
            Ok(changed)
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::Object(_) => Ok(false),
    }
}

fn strip_v3_openai_chat_control_markers(
    payload: &mut Value,
    declarations: &ToolMarkupDeclarations,
) -> Result<bool, V3HubRelayResponseError> {
    let mut changed = false;
    let Some(choices) = payload.get_mut("choices").and_then(Value::as_array_mut) else {
        return Ok(false);
    };
    for choice in choices {
        // The same declared label grammar governs both materialized Chat
        // messages and projected Chat SSE delta carriers. Tool arguments,
        // reasoning and opaque fields are not text carriers here.
        for carrier in ["message", "delta"] {
            let Some(object) = choice.get_mut(carrier).and_then(Value::as_object_mut) else {
                continue;
            };
            if let Some(content) = object.get_mut("content") {
                changed |= strip_v3_relay_control_marker_content(content, declarations)?;
            }
        }
    }
    Ok(changed)
}

fn strip_v3_responses_control_markers(
    payload: &mut Value,
    declarations: &ToolMarkupDeclarations,
) -> Result<bool, V3HubRelayResponseError> {
    let mut changed = false;
    if let Some(output_text) = payload.get_mut("output_text") {
        changed |= strip_v3_relay_control_marker_string(output_text, declarations)?;
    }
    let Some(output) = payload.get_mut("output").and_then(Value::as_array_mut) else {
        return Ok(changed);
    };
    for item in output {
        match item {
            Value::String(_) => {
                changed |= strip_v3_relay_control_marker_string(item, declarations)?;
            }
            Value::Object(object) => match object.get("type").and_then(Value::as_str) {
                Some("message") => {
                    if let Some(text) = object.get_mut("text") {
                        changed |= strip_v3_relay_control_marker_string(text, declarations)?;
                    }
                    if let Some(content) = object.get_mut("content") {
                        changed |= strip_v3_relay_control_marker_content(content, declarations)?;
                    }
                }
                Some("output_text" | "refusal") => {
                    if let Some(text) = object.get_mut("text") {
                        changed |= strip_v3_relay_control_marker_string(text, declarations)?;
                    }
                    if let Some(refusal) = object.get_mut("refusal") {
                        changed |= strip_v3_relay_control_marker_string(refusal, declarations)?;
                    }
                }
                _ => {}
            },
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::Array(_) => {}
        }
    }
    Ok(changed)
}

#[derive(Default)]
struct V3ThinkHarvest {
    visible_text: String,
    reasoning_segments: Vec<String>,
    changed: bool,
}

fn harvest_v3_think_text(text: &str) -> V3ThinkHarvest {
    let mut output = String::new();
    let mut reasoning_segments = Vec::new();
    let mut cursor = 0usize;
    let mut changed = false;
    while let Some(relative_start) = text[cursor..].find("<think>") {
        let start = cursor + relative_start;
        output.push_str(&text[cursor..start].replace("</think>", ""));
        let content_start = start + "<think>".len();
        let Some(relative_end) = text[content_start..].find("</think>") else {
            output.push_str(&text[content_start..]);
            changed = true;
            return V3ThinkHarvest {
                visible_text: output,
                reasoning_segments,
                changed,
            };
        };
        let end = content_start + relative_end;
        if let Some(reasoning) = read_v3_resp03_trimmed_owned(&text[content_start..end]) {
            reasoning_segments.push(reasoning);
        }
        cursor = end + "</think>".len();
        changed = true;
    }
    let trailing = &text[cursor..];
    if trailing.contains("</think>") {
        output.push_str(&trailing.replace("</think>", ""));
        changed = true;
    } else {
        output.push_str(trailing);
    }
    V3ThinkHarvest {
        visible_text: output,
        reasoning_segments,
        changed,
    }
}

fn read_v3_resp03_trimmed_owned(text: &str) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn v3_resp03_reasoning_item(reasoning_segments: Vec<String>) -> Value {
    let mut summary = Vec::new();
    for text in reasoning_segments {
        let Some(text) = read_v3_resp03_trimmed_owned(&text) else {
            continue;
        };
        summary.push(json!({"type":"summary_text","text":text}));
    }
    json!({
        "type": "reasoning",
        "summary": summary
    })
}

/// Each final output lists the pre-transformation positions it derives from.
/// Update the sole candidate business extension at the transformation owner;
/// no identity markers or copied responses travel through the payload.
pub(crate) fn remap_v3_response_candidate_output_indices(
    payload: &mut Value,
    output_sources: &[Vec<usize>],
) {
    let Some(outcomes) = payload
        .get_mut("gemini_candidate_outcomes")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for outcome in outcomes {
        let Some(indices) = outcome
            .get_mut("output_indices")
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        let final_indices = output_sources
            .iter()
            .enumerate()
            .filter(|(_, sources)| {
                sources.iter().any(|source| {
                    indices
                        .iter()
                        .any(|index| index.as_u64() == Some(*source as u64))
                })
            })
            .map(|(index, _)| json!(index))
            .collect();
        *indices = final_indices;
    }
}

fn harvest_v3_responses_think_blocks(payload: &mut Value) -> bool {
    let Some(object) = payload.as_object_mut() else {
        return false;
    };
    let Some(output) = object.get_mut("output").and_then(Value::as_array_mut) else {
        return false;
    };
    let mut changed = false;
    let mut next_output = Vec::with_capacity(output.len());
    let mut output_sources = Vec::with_capacity(output.len());
    let mut aggregate_output_text = String::new();
    for (source, mut item) in std::mem::take(output).into_iter().enumerate() {
        let mut reasoning_segments = Vec::new();
        if harvest_v3_responses_output_item_think_blocks(&mut item, &mut reasoning_segments) {
            changed = true;
            if !reasoning_segments.is_empty() {
                next_output.push(v3_resp03_reasoning_item(reasoning_segments));
                output_sources.push(vec![source]);
            }
        }
        if !is_v3_resp03_empty_visible_text_item(&item) {
            append_v3_resp03_output_text_segments(&mut aggregate_output_text, &item);
            next_output.push(item);
            output_sources.push(vec![source]);
        } else {
            changed = true;
        }
    }
    *output = next_output;
    if changed {
        if aggregate_output_text.trim().is_empty() {
            object.remove("output_text");
        } else {
            object.insert(
                "output_text".to_string(),
                Value::String(aggregate_output_text),
            );
        }
        remap_v3_response_candidate_output_indices(payload, &output_sources);
    }
    changed
}

fn harvest_v3_responses_output_item_think_blocks(
    item: &mut Value,
    reasoning_segments: &mut Vec<String>,
) -> bool {
    let Some(row) = item.as_object_mut() else {
        return false;
    };
    let item_type = row.get("type").and_then(Value::as_str).unwrap_or_default();
    let mut changed = false;
    match item_type {
        "output_text" => {
            if let Some(text) = row.get("text").and_then(Value::as_str) {
                let harvest = harvest_v3_think_text(text);
                if harvest.changed {
                    changed = true;
                    reasoning_segments.extend(harvest.reasoning_segments);
                    row.insert("text".to_string(), Value::String(harvest.visible_text));
                }
            }
        }
        "message" => {
            if let Some(content) = row.get_mut("content").and_then(Value::as_array_mut) {
                for part in content {
                    let Some(part_row) = part.as_object_mut() else {
                        continue;
                    };
                    if !matches!(
                        part_row.get("type").and_then(Value::as_str),
                        Some("output_text" | "text")
                    ) {
                        continue;
                    }
                    let Some(text) = part_row.get("text").and_then(Value::as_str) else {
                        continue;
                    };
                    let harvest = harvest_v3_think_text(text);
                    if harvest.changed {
                        changed = true;
                        reasoning_segments.extend(harvest.reasoning_segments);
                        part_row.insert("text".to_string(), Value::String(harvest.visible_text));
                    }
                }
            }
        }
        _ => {}
    }
    changed
}

fn is_v3_resp03_empty_visible_text_item(item: &Value) -> bool {
    let Some(row) = item.as_object() else {
        return false;
    };
    match row.get("type").and_then(Value::as_str) {
        Some("output_text") => row
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|text| text.trim().is_empty()),
        Some("message") => row
            .get("content")
            .and_then(Value::as_array)
            .is_some_and(|parts| {
                parts.iter().all(|part| {
                    let Some(part_row) = part.as_object() else {
                        return false;
                    };
                    if !matches!(
                        part_row.get("type").and_then(Value::as_str),
                        Some("output_text" | "text")
                    ) {
                        return false;
                    }
                    part_row
                        .get("text")
                        .and_then(Value::as_str)
                        .is_some_and(|text| text.trim().is_empty())
                })
            }),
        _ => false,
    }
}

fn append_v3_resp03_output_text_segments(output_text: &mut String, item: &Value) {
    let Some(row) = item.as_object() else {
        return;
    };
    match row.get("type").and_then(Value::as_str) {
        Some("output_text") => {
            if let Some(text) = row.get("text").and_then(Value::as_str) {
                output_text.push_str(text);
            }
        }
        Some("message") => {
            if let Some(parts) = row.get("content").and_then(Value::as_array) {
                for part in parts {
                    if let Some(text) = part
                        .as_object()
                        .filter(|part_row| {
                            matches!(
                                part_row.get("type").and_then(Value::as_str),
                                Some("output_text" | "text")
                            )
                        })
                        .and_then(|part_row| part_row.get("text"))
                        .and_then(Value::as_str)
                    {
                        output_text.push_str(text);
                    }
                }
            }
        }
        _ => {}
    }
}

fn harvest_v3_openai_chat_think_blocks(payload: &mut Value) -> bool {
    let Some(choices) = payload.get_mut("choices").and_then(Value::as_array_mut) else {
        return false;
    };
    let mut changed = false;
    for choice in choices {
        let Some(message) = choice.get_mut("message").and_then(Value::as_object_mut) else {
            continue;
        };
        let Some(content) = message.get("content").and_then(Value::as_str) else {
            continue;
        };
        let harvest = harvest_v3_think_text(content);
        if !harvest.changed {
            continue;
        }
        changed = true;
        message.insert("content".to_string(), Value::String(harvest.visible_text));
        append_v3_resp03_openai_chat_reasoning_content(message, harvest.reasoning_segments);
    }
    changed
}

fn append_v3_resp03_openai_chat_reasoning_content(
    message: &mut Map<String, Value>,
    reasoning_segments: Vec<String>,
) {
    let mut joined = message
        .get("reasoning_content")
        .and_then(Value::as_str)
        .map(|name| name.trim())
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .unwrap_or_default();
    for segment in reasoning_segments {
        let Some(segment) = read_v3_resp03_trimmed_owned(&segment) else {
            continue;
        };
        if !joined.is_empty() {
            joined.push('\n');
        }
        joined.push_str(&segment);
    }
    if !joined.is_empty() {
        message.insert("reasoning_content".to_string(), Value::String(joined));
    }
}

pub(crate) fn map_v3_toolreason_to_reasoning_content_at_resp03(payload: &mut Value, enabled: bool) {
    map_v3_toolreason_to_reasoning_content_at_resp03_with_projection(payload, enabled, true);
}

pub(crate) fn map_v3_toolreason_to_reasoning_content_at_resp03_with_projection(
    payload: &mut Value,
    enabled: bool,
    project_to_client: bool,
) {
    map_v3_toolreason_to_reasoning_content_at_resp03_impl(
        payload,
        enabled,
        project_to_client,
        true,
        None,
        None,
        None,
    );
}

pub(crate) fn map_v3_toolreason_to_reasoning_content_at_resp03_with_projection_and_request_id(
    payload: &mut Value,
    enabled: bool,
    project_to_client: bool,
    request_id: Option<&str>,
) {
    map_v3_toolreason_to_reasoning_content_at_resp03_impl(
        payload,
        enabled,
        project_to_client,
        true,
        None,
        request_id,
        None,
    );
}

pub(crate) fn map_v3_toolreason_to_reasoning_content_at_resp03_with_projection_and_context(
    payload: &mut Value,
    enabled: bool,
    project_to_client: bool,
    context: V3ToolreasonObservationContext<'_>,
) {
    map_v3_toolreason_to_reasoning_content_at_resp03_impl(
        payload,
        enabled,
        project_to_client,
        true,
        context.session_id,
        context.request_id,
        None,
    );
}

pub(crate) fn map_v3_toolreason_to_reasoning_content_at_resp03_with_expected_model_and_context(
    payload: &mut Value,
    enabled: bool,
    project_to_client: bool,
    expected_model_id: Option<&str>,
    context: V3ToolreasonObservationContext<'_>,
) {
    map_v3_toolreason_to_reasoning_content_at_resp03_impl(
        payload,
        enabled,
        project_to_client,
        true,
        context.session_id,
        context.request_id,
        expected_model_id,
    );
}

fn map_v3_toolreason_to_reasoning_content_at_resp03_without_observation(
    payload: &mut Value,
    enabled: bool,
    project_to_client: bool,
) {
    map_v3_toolreason_to_reasoning_content_at_resp03_impl(
        payload,
        enabled,
        project_to_client,
        false,
        None,
        None,
        None,
    );
}

fn map_v3_toolreason_to_reasoning_content_at_resp03_with_expected_model_without_observation(
    payload: &mut Value,
    enabled: bool,
    project_to_client: bool,
    expected_model_id: Option<&str>,
) {
    map_v3_toolreason_to_reasoning_content_at_resp03_impl(
        payload,
        enabled,
        project_to_client,
        false,
        None,
        None,
        expected_model_id,
    );
}

fn map_v3_toolreason_to_reasoning_content_at_resp03_impl(
    payload: &mut Value,
    enabled: bool,
    project_to_client: bool,
    observe: bool,
    session_id: Option<&str>,
    request_id: Option<&str>,
    expected_model_id: Option<&str>,
) {
    scrub_v3_provider_model_identity_instructions(payload);
    if !enabled {
        return;
    }
    strip_v3_tool_thinking_request_artifacts_at_resp03(payload);
    if observe {
        observe_v3_toolreason_json_at_resp03_with_context(
            payload,
            V3ToolreasonObservationContext {
                session_id,
                request_id,
            },
            expected_model_id,
        );
    }
    let mut json_tool_names = Vec::new();
    let mut json_reasons = Vec::new();
    collect_v3_tool_thinking_json_fields_at_resp03(
        payload,
        &mut json_tool_names,
        &mut json_reasons,
        expected_model_id,
    );
    // Converted relay SSE reaches Resp03 as Chat delta frames rather than a
    // completed assistant message.  Govern that shape here as well: the
    // native tool arguments are still the only source, and only the three
    // registered tool-thinking fields are removed.
    map_v3_openai_chat_toolreason_delta_at_resp03_with_expected_model(
        payload,
        project_to_client,
        expected_model_id,
    );
    // Strip only the three auxiliary fields after harvesting them. This is the
    // sole response-side removal point; native tool arguments are skipped.
    strip_v3_tool_thinking_fields_from_json_at_resp03(payload, expected_model_id);
    if let Some(choices) = payload.get_mut("choices").and_then(Value::as_array_mut) {
        for choice in choices {
            let Some(message) = choice.get_mut("message").and_then(Value::as_object_mut) else {
                continue;
            };
            let tool_names = message
                .get("tool_calls")
                .and_then(Value::as_array)
                .map(|calls| {
                    calls
                        .iter()
                        .filter_map(|call| {
                            call.as_object()
                                .and_then(toolreason_display_name_from_object)
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if project_to_client && !json_reasons.is_empty() && !tool_names.is_empty() {
                if let Some(reasoning) =
                    format_toolreason_reasoning_from_reason(&tool_names, &json_reasons[0])
                {
                    let already_projected = message
                        .get("reasoning_content")
                        .and_then(Value::as_str)
                        .is_some_and(|value| {
                            value.lines().any(|line| line.trim() == reasoning.as_str())
                        });
                    if !already_projected {
                        append_v3_resp03_openai_chat_reasoning_content(message, vec![reasoning]);
                    }
                }
            }
        }
    }
    let mut transformed_output_sources = None;
    if let Some(output) = payload.get_mut("output").and_then(Value::as_array_mut) {
        let (contributors, tool_names): (Vec<_>, Vec<_>) = output
            .iter()
            .enumerate()
            .filter_map(|(index, item)| {
                if !matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("function_call" | "tool_call" | "custom_tool_call")
                ) {
                    return None;
                }
                item.as_object()
                    .and_then(toolreason_display_name_from_object)
                    .map(|name| (index, name))
            })
            .unzip();
        let reasoning_toolreason = json_reasons
            .first()
            .and_then(|reason| format_toolreason_reasoning_from_reason(&tool_names, reason));
        if project_to_client {
            if let Some(reasoning) = reasoning_toolreason {
                let mut output_sources = (0..output.len())
                    .map(|index| vec![index])
                    .collect::<Vec<_>>();
                // The existing aggregate summary names these calls. Both its
                // reasoning and visible mirror derive from all those calls.
                let mut merged = false;
                for (index, item) in output.iter_mut().enumerate() {
                    if item.get("type").and_then(Value::as_str) != Some("reasoning") {
                        continue;
                    }
                    let Some(summary) = item
                        .as_object_mut()
                        .and_then(|object| object.get_mut("summary"))
                        .and_then(Value::as_array_mut)
                    else {
                        continue;
                    };
                    if !summary.iter().any(|part| {
                        part.get("text").and_then(Value::as_str) == Some(reasoning.as_str())
                    }) {
                        summary.push(json!({
                            "type": "summary_text",
                            "text": reasoning
                        }));
                    }
                    output_sources[index].extend_from_slice(&contributors);
                    merged = true;
                    break;
                }
                if !merged {
                    let insert_at = output
                        .iter()
                        .position(|item| {
                            matches!(
                                item.get("type").and_then(Value::as_str),
                                Some("function_call" | "tool_call" | "custom_tool_call")
                            )
                        })
                        .unwrap_or(output.len());
                    output.insert(
                        insert_at,
                        json!({
                            "id": "rcc_reason_anthropic_tool_call",
                            "type": "reasoning",
                            "status": "completed",
                            "summary": [{"type": "summary_text", "text": reasoning}]
                        }),
                    );
                    output_sources.insert(insert_at, contributors.clone());
                }
                let (index, inserted) =
                    append_v3_toolreason_visible_text_item_at_resp03(output, &reasoning);
                if inserted {
                    output_sources.insert(index, contributors);
                } else {
                    output_sources[index].extend(contributors);
                }
                transformed_output_sources = Some(output_sources);
            }
        }
    }
    if let Some(sources) = transformed_output_sources {
        remap_v3_response_candidate_output_indices(payload, &sources);
    }
    if let Some(content) = payload.get_mut("content").and_then(Value::as_array_mut) {
        let tool_names = content
            .iter()
            .filter(|part| {
                matches!(
                    part.get("type").and_then(Value::as_str),
                    Some("tool_use" | "tool_call" | "function_call")
                )
            })
            .filter_map(|part| part.get("name").and_then(Value::as_str).map(str::to_owned))
            .collect::<Vec<_>>();
        if project_to_client && !json_reasons.is_empty() && !tool_names.is_empty() {
            if let Some(mapped) =
                format_toolreason_reasoning_from_reason(&tool_names, &json_reasons[0])
            {
                payload["reasoning_content"] = Value::String(mapped);
            }
        }
    }
    if project_to_client
        && payload.get("reasoning_content").is_none()
        && payload.get("choices").is_none()
        && payload.get("output").is_none()
        && !json_reasons.is_empty()
        && !json_tool_names.is_empty()
    {
        if let Some(mapped) =
            format_toolreason_reasoning_from_reason(&json_tool_names, &json_reasons[0])
        {
            if let Some(object) = payload.as_object_mut() {
                object.insert("reasoning_content".to_string(), Value::String(mapped));
            }
        }
    }
}

/// Resp03 removes the request-local tool-list projection when a provider
/// echoes the final provider-bound `tools` list in its response.  This is
/// deliberately limited to the exact guidance text and the three injected
/// schema properties; it never traverses native tool-call argument objects.
pub(crate) fn strip_v3_tool_thinking_request_artifacts_at_resp03(payload: &mut Value) {
    fn visit(value: &mut Value) {
        match value {
            Value::Object(object) => {
                if let Some(tools) = object.get_mut("tools").and_then(Value::as_array_mut) {
                    for tool in tools {
                        strip_tool(tool);
                    }
                }
                for child in object.values_mut() {
                    visit(child);
                }
            }
            Value::Array(values) => {
                for value in values {
                    visit(value);
                }
            }
            Value::String(_) | Value::Null | Value::Bool(_) | Value::Number(_) => {}
        }
    }

    fn strip_tool(tool: &mut Value) {
        let Some(object) = tool.as_object_mut() else {
            return;
        };
        strip_guidance(object.get_mut("description"));
        if let Some(function) = object.get_mut("function").and_then(Value::as_object_mut) {
            strip_guidance(function.get_mut("description"));
            strip_schema(function.get_mut("parameters"));
        }
        strip_schema(object.get_mut("parameters"));
        strip_schema(object.get_mut("input_schema"));
    }

    fn strip_guidance(value: Option<&mut Value>) {
        let Some(Value::String(text)) = value else {
            return;
        };
        let marker = "工具调用协议（只适用于本轮工具调用";
        let Some(start) = text.find(marker) else {
            return;
        };
        text.truncate(start);
        while text.ends_with([' ', '\n', '\r']) {
            text.pop();
        }
    }

    fn strip_schema(value: Option<&mut Value>) {
        let Some(schema) = value.and_then(Value::as_object_mut) else {
            return;
        };
        let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) else {
            return;
        };
        // Provider response echoes may preserve the request-local auxiliary
        // field names while dropping their descriptions.  Req04 rejects
        // native collisions before injection, so field names are the stable
        // request-local identity at Resp03; description matching is not.
        let injected = ["reason", "goal_alignment_confidence", "model_id"];
        let mut removed = Vec::new();
        for name in injected {
            if properties.contains_key(name) {
                properties.remove(name);
                removed.push(name);
            }
        }
        if let Some(required) = schema.get_mut("required").and_then(Value::as_array_mut) {
            required.retain(|field| {
                !removed
                    .iter()
                    .any(|removed| field.as_str() == Some(*removed))
            });
        }
    }

    visit(payload);
}

fn map_v3_openai_chat_toolreason_delta_at_resp03(payload: &mut Value, project_to_client: bool) {
    map_v3_openai_chat_toolreason_delta_at_resp03_with_expected_model(
        payload,
        project_to_client,
        None,
    );
}

fn map_v3_openai_chat_toolreason_delta_at_resp03_with_expected_model(
    payload: &mut Value,
    project_to_client: bool,
    expected_model_id: Option<&str>,
) {
    let Some(choices) = payload.get_mut("choices").and_then(Value::as_array_mut) else {
        return;
    };
    for choice in choices {
        let Some(delta) = choice.get_mut("delta").and_then(Value::as_object_mut) else {
            continue;
        };
        let Some(tool_calls) = delta.get_mut("tool_calls").and_then(Value::as_array_mut) else {
            continue;
        };
        let mut projected_reasoning = None;
        for tool_call in tool_calls.iter_mut() {
            let Some(function) = tool_call.get_mut("function").and_then(Value::as_object_mut)
            else {
                continue;
            };
            let Some(arguments) = function.get("arguments").and_then(Value::as_str) else {
                continue;
            };
            if json_object_has_duplicate_keys_at_resp03(arguments) {
                continue;
            }
            let Ok(mut parameter) = serde_json::from_str::<Value>(arguments) else {
                continue;
            };
            let Some(fields) = v3_tool_thinking_fields_from_parameter_value_at_resp03(
                &parameter,
                expected_model_id,
            ) else {
                continue;
            };
            strip_v3_tool_thinking_fields_from_parameter_value_at_resp03(
                &mut parameter,
                expected_model_id,
            );
            let Ok(redacted_arguments) = serde_json::to_string(&parameter) else {
                continue;
            };
            function.insert("arguments".to_string(), Value::String(redacted_arguments));
            if projected_reasoning.is_none() {
                projected_reasoning = Some(fields.reason);
            }
        }
        if project_to_client {
            if let Some(reason) = projected_reasoning {
                let tool_name = tool_calls.iter().find_map(|tool_call| {
                    tool_call
                        .get("function")
                        .and_then(Value::as_object)
                        .and_then(|function| function.get("name"))
                        .and_then(Value::as_str)
                });
                if let Some(tool_name) = tool_name {
                    if let Some(reasoning) =
                        format_toolreason_reasoning_from_reason(&[tool_name.to_owned()], &reason)
                    {
                        delta.insert("reasoning_content".to_string(), Value::String(reasoning));
                    }
                }
            }
        }
    }
}

pub(crate) fn map_v3_openai_chat_toolreason_delta_for_relay_projection(
    payload: &mut Value,
) -> Option<String> {
    map_v3_openai_chat_toolreason_delta_at_resp03(payload, true);
    payload
        .pointer("/choices/0/delta/reasoning_content")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn observe_v3_toolreason_json_at_resp03_with_context(
    payload: &Value,
    context: V3ToolreasonObservationContext<'_>,
    expected_model_id: Option<&str>,
) {
    if let Some((tool_label, raw_object)) = first_v3_tool_thinking_object_at_resp03(payload) {
        let mut emitted = false;
        emit_v3_toolreason_observation_at_resp03_with_expected_model(
            &tool_label,
            Some(&raw_object),
            "resp03_json",
            &mut emitted,
            context,
            expected_model_id,
        );
    }
}

pub(crate) fn record_v3_toolreason_observation_at_resp03(
    payload: &Value,
    observation: &crate::hub_v1::V3RuntimeStreamObservation,
    session_id: Option<&str>,
    request_id: Option<&str>,
    expected_model_id: Option<&str>,
) -> Result<(), String> {
    let Some((tool, raw)) = first_v3_tool_thinking_object_at_resp03(payload) else {
        return Ok(());
    };
    let (status, fields) = classify_v3_toolreason_observation_at_resp03_with_expected_model(
        Some(&raw),
        expected_model_id,
    );
    let status = match status {
        V3ToolreasonObservationStatus::Ok => "OK",
        V3ToolreasonObservationStatus::Missing => "MISSING",
        V3ToolreasonObservationStatus::Invalid => "INVALID",
        V3ToolreasonObservationStatus::Misplaced => "MISPLACED",
    };
    observation.record_toolreason(crate::hub_v1::V3RuntimeToolreasonObservation {
        status: status.to_string(),
        source: "provider_raw_tool_arguments".to_string(),
        stage: "resp03_json".to_string(),
        session_id: session_id.map(str::to_string),
        request_id: request_id.map(str::to_string),
        tool: tool.clone(),
        reason: fields.as_ref().map(|value| value.reason.clone()),
        confidence: fields
            .as_ref()
            .and_then(|value| value.goal_alignment_confidence),
    })?;
    let mut emitted = false;
    emit_v3_toolreason_observation_at_resp03_with_expected_model(
        &tool,
        Some(&raw),
        "resp03_json",
        &mut emitted,
        V3ToolreasonObservationContext {
            session_id,
            request_id,
        },
        expected_model_id,
    );
    Ok(())
}

fn first_v3_tool_thinking_object_at_resp03(value: &Value) -> Option<(String, String)> {
    let mut objects = Vec::new();
    collect_v3_tool_thinking_objects_at_resp03(value, &mut objects);
    let first = objects.first()?.clone();
    let names = objects
        .iter()
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    Some((format_toolreason_tool_label(&names), first.1))
}

fn collect_v3_tool_thinking_objects_at_resp03(value: &Value, objects: &mut Vec<(String, String)>) {
    match value {
        Value::Object(object) => {
            if v3_is_gemini_tool_call_object_at_resp03(object) {
                return;
            }
            if v3_is_tool_call_object_at_resp03(object) {
                let Some(name) = toolreason_display_name_from_object(object) else {
                    return;
                };
                if object.keys().any(|key| {
                    matches!(
                        key.as_str(),
                        "reason" | "goal_alignment_confidence" | "model_id"
                    )
                }) {
                    if let Ok(raw) = serde_json::to_string(object) {
                        objects.push((name, raw));
                    }
                    return;
                }
                let mut parameters = Vec::new();
                for key in ["arguments", "input", "args"] {
                    if let Some(parameter) = object.get(key) {
                        parameters.push(parameter);
                    }
                }
                if let Some(function) = object.get("function").and_then(Value::as_object) {
                    for key in ["arguments", "input", "args"] {
                        if let Some(parameter) = function.get(key) {
                            parameters.push(parameter);
                        }
                    }
                }
                for parameter in parameters {
                    let parsed = match parameter {
                        Value::Object(_) => Some(parameter.clone()),
                        Value::String(text) => serde_json::from_str::<Value>(text).ok(),
                        _ => None,
                    };
                    let Some(parsed) = parsed else {
                        continue;
                    };
                    if parsed.as_object().is_some_and(|parameter| {
                        parameter.keys().any(|key| {
                            matches!(
                                key.as_str(),
                                "reason" | "goal_alignment_confidence" | "model_id"
                            )
                        })
                    }) {
                        if let Ok(raw) = serde_json::to_string(&parsed) {
                            objects.push((name.clone(), raw));
                        }
                        return;
                    }
                }
                if let Ok(raw) = serde_json::to_string(object) {
                    objects.push((name, raw));
                }
                return;
            }
            for (key, child) in object {
                if v3_is_tool_call_payload_key_at_resp03(key) {
                    continue;
                }
                collect_v3_tool_thinking_objects_at_resp03(child, objects);
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_v3_tool_thinking_objects_at_resp03(value, objects);
            }
        }
        Value::String(_) | Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn collect_v3_toolreason_json_observations_at_resp03(
    value: &Value,
    tool_names: &mut Vec<String>,
    reasons: &mut Vec<String>,
) {
    match value {
        // Ordinary text is never a Tool-Thinking source. Only the native
        // tool-call parameter object below may contribute a JSON v2 reason.
        Value::String(_) => {}
        Value::Array(values) => {
            for value in values {
                collect_v3_toolreason_json_observations_at_resp03(value, tool_names, reasons);
            }
        }
        Value::Object(object) => {
            let is_tool_call = v3_is_tool_call_object_at_resp03(object);
            if is_tool_call && !v3_is_gemini_tool_call_object_at_resp03(object) {
                if let Some(name) = toolreason_display_name_from_object(object) {
                    tool_names.push(name);
                }
                if v3_tool_thinking_fields_from_tool_call_at_resp03(object, None).is_some() {
                    if let Some(raw_parameter) =
                        v3_tool_thinking_raw_parameter_from_tool_call_at_resp03(object)
                    {
                        reasons.push(raw_parameter);
                    }
                }
            }
            if v3_is_gemini_tool_call_object_at_resp03(object) {
                return;
            }
            for (key, value) in object {
                if is_tool_call && v3_is_tool_call_payload_key_at_resp03(key) {
                    continue;
                }
                collect_v3_toolreason_json_observations_at_resp03(value, tool_names, reasons);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// Returns the Resp03 authorization bit for a native tool-reason projection.
/// The caller may carry this bit as typed hook state; it must not infer
/// authorization from a visible reasoning item id or other client payload.
pub(crate) fn v3_toolreason_projection_authorized_at_resp03(
    value: &Value,
    expected_model_id: Option<&str>,
) -> bool {
    let mut tool_names = Vec::new();
    let mut reasons = Vec::new();
    collect_v3_tool_thinking_json_fields_at_resp03(
        value,
        &mut tool_names,
        &mut reasons,
        expected_model_id,
    );
    !tool_names.is_empty() && !reasons.is_empty()
}

fn collect_v3_tool_thinking_json_fields_at_resp03(
    value: &Value,
    tool_names: &mut Vec<String>,
    reasons: &mut Vec<String>,
    expected_model_id: Option<&str>,
) {
    match value {
        Value::Object(object) => {
            if v3_is_gemini_tool_call_object_at_resp03(object) {
                return;
            }
            let is_tool_call = v3_is_tool_call_object_at_resp03(object);
            if is_tool_call {
                if let Some(name) = toolreason_display_name_from_object(object) {
                    tool_names.push(name);
                }
                if let Some(fields) =
                    v3_tool_thinking_fields_from_tool_call_at_resp03(object, expected_model_id)
                {
                    reasons.push(fields.reason);
                }
            }
            if let Some(function) = object.get("function") {
                collect_v3_tool_thinking_json_fields_at_resp03(
                    function,
                    tool_names,
                    reasons,
                    expected_model_id,
                );
            }
            for (key, child) in object {
                if is_tool_call
                    && matches!(
                        key.as_str(),
                        "arguments" | "input" | "parameters" | "args" | "function"
                    )
                {
                    continue;
                }
                collect_v3_tool_thinking_json_fields_at_resp03(
                    child,
                    tool_names,
                    reasons,
                    expected_model_id,
                );
            }
        }
        Value::Array(values) => {
            for child in values {
                collect_v3_tool_thinking_json_fields_at_resp03(
                    child,
                    tool_names,
                    reasons,
                    expected_model_id,
                );
            }
        }
        Value::String(_) | Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// Observe and redact tool-thinking fields on a native Anthropic SSE stream.
/// Anthropic emits tool use as `content_block_*`, so it cannot be routed
/// through the Responses `response.*` event classifier. The same Resp03
/// buffers are used so direct and relay closeout still emit one observation.
pub(crate) fn map_v3_anthropic_toolreason_stream_event_at_resp03(
    payload: &mut Value,
    tool_names: &mut Vec<String>,
    pending_reasons: &mut Vec<Option<String>>,
    _reason_emitted: &mut bool,
    _project_to_client: bool,
    expected_model_id: Option<&str>,
) {
    let event_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some(index) = payload
        .get("index")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
    else {
        return;
    };
    match event_type {
        "content_block_start" => {
            let Some(block) = payload
                .get_mut("content_block")
                .and_then(Value::as_object_mut)
            else {
                return;
            };
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                return;
            }
            let Some(name) = block.get("name").and_then(Value::as_str) else {
                return;
            };
            if tool_names.len() <= index {
                tool_names.resize(index + 1, String::new());
            }
            tool_names[index] = name.to_string();
            if let Some(input) = block.get_mut("input") {
                if !input.is_object() {
                    return;
                }
                remember_v3_anthropic_toolreason_json(input, index, pending_reasons);
                if v3_tool_thinking_fields_from_parameter_value_at_resp03(input, expected_model_id)
                    .is_some()
                {
                    strip_v3_tool_thinking_fields_from_parameter_value_at_resp03(
                        input,
                        expected_model_id,
                    );
                }
            }
        }
        "content_block_delta" => {
            let Some(delta) = payload.get_mut("delta").and_then(Value::as_object_mut) else {
                return;
            };
            if delta.get("type").and_then(Value::as_str) != Some("input_json_delta") {
                return;
            }
            let Some(partial_json) = delta
                .get("partial_json")
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                return;
            };
            if pending_reasons.len() <= index {
                pending_reasons.resize(index + 1, None);
            }
            let buffer = pending_reasons[index].get_or_insert_with(String::new);
            buffer.push_str(&partial_json);
            // Do not forward an incomplete fragment: the auxiliary fields may
            // be present before the native JSON object closes. Once complete,
            // emit the redacted native parameter object as one equivalent
            // fragment, preserving every non-toolreason argument.
            delta.insert("partial_json".to_string(), Value::String(String::new()));
            if let Ok(mut object) = serde_json::from_str::<Value>(buffer) {
                if object.as_object().is_some() {
                    strip_v3_tool_thinking_fields_from_parameter_value_at_resp03(
                        &mut object,
                        expected_model_id,
                    );
                    if let Ok(redacted) = serde_json::to_string(&object) {
                        delta.insert("partial_json".to_string(), Value::String(redacted));
                    }
                }
            }
        }
        _ => {}
    }
}

fn remember_v3_anthropic_toolreason_json(
    value: &Value,
    index: usize,
    pending_reasons: &mut Vec<Option<String>>,
) {
    let Ok(serialized) = serde_json::to_string(value) else {
        return;
    };
    if pending_reasons.len() <= index {
        pending_reasons.resize(index + 1, None);
    }
    pending_reasons[index] = Some(serialized);
}

/// Map a complete Responses SSE semantic event after the stream collector has
/// already observed the corresponding function-call name.  Responses emits
/// the assistant text and the function-call item as separate events, so the
/// normal whole-payload mapper cannot associate them one frame at a time.
pub(crate) fn map_v3_toolreason_stream_event_at_resp03(
    payload: &mut Value,
    enabled: bool,
    tool_names: &[String],
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    project_to_client: bool,
) {
    map_v3_toolreason_stream_event_at_resp03_with_request_id(
        payload,
        enabled,
        tool_names,
        pending_reasons,
        reason_emitted,
        project_to_client,
        None,
    );
}

pub(crate) fn map_v3_toolreason_stream_event_at_resp03_with_request_id(
    payload: &mut Value,
    enabled: bool,
    tool_names: &[String],
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    project_to_client: bool,
    request_id: Option<&str>,
) {
    map_v3_toolreason_stream_event_at_resp03_with_context(
        payload,
        enabled,
        tool_names,
        pending_reasons,
        reason_emitted,
        project_to_client,
        None,
        request_id,
    );
}

pub(crate) fn map_v3_toolreason_stream_event_at_resp03_with_context(
    payload: &mut Value,
    enabled: bool,
    tool_names: &[String],
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    project_to_client: bool,
    session_id: Option<&str>,
    request_id: Option<&str>,
) {
    map_v3_toolreason_stream_event_at_resp03_with_context_and_buffers(
        payload,
        enabled,
        tool_names,
        pending_reasons,
        reason_emitted,
        project_to_client,
        session_id,
        request_id,
        None,
    );
}

pub(crate) fn map_v3_toolreason_stream_event_at_resp03_with_context_and_buffers(
    payload: &mut Value,
    enabled: bool,
    tool_names: &[String],
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    project_to_client: bool,
    session_id: Option<&str>,
    request_id: Option<&str>,
    argument_buffers: Option<&mut Vec<String>>,
) {
    map_v3_toolreason_stream_event_at_resp03_with_context_and_buffers_and_expected_model(
        payload,
        enabled,
        tool_names,
        pending_reasons,
        reason_emitted,
        project_to_client,
        session_id,
        request_id,
        argument_buffers,
        None,
    );
}

pub(crate) fn map_v3_toolreason_stream_event_at_resp03_with_context_and_buffers_and_expected_model(
    payload: &mut Value,
    enabled: bool,
    tool_names: &[String],
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    project_to_client: bool,
    session_id: Option<&str>,
    request_id: Option<&str>,
    argument_buffers: Option<&mut Vec<String>>,
    expected_model_id: Option<&str>,
) {
    let mut observation_error = None;
    map_v3_toolreason_stream_event_at_resp03_with_context_and_buffers_expected_model_and_stream_observation(
        payload,
        enabled,
        tool_names,
        pending_reasons,
        reason_emitted,
        project_to_client,
        session_id,
        request_id,
        argument_buffers,
        expected_model_id,
        None,
        &mut observation_error,
    );
    debug_assert!(observation_error.is_none());
}

pub(crate) fn map_v3_toolreason_stream_event_at_resp03_with_context_and_buffers_expected_model_and_stream_observation(
    payload: &mut Value,
    enabled: bool,
    tool_names: &[String],
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    project_to_client: bool,
    session_id: Option<&str>,
    request_id: Option<&str>,
    argument_buffers: Option<&mut Vec<String>>,
    expected_model_id: Option<&str>,
    stream_observation: Option<&crate::hub_v1::V3RuntimeStreamObservation>,
    observation_error: &mut Option<String>,
) {
    if !enabled {
        return;
    }
    if payload.get("object").and_then(Value::as_str) == Some("chat.completion.chunk") {
        map_v3_openai_chat_toolreason_chunk_at_resp03_with_expected_model(
            payload,
            tool_names,
            pending_reasons,
            reason_emitted,
            project_to_client,
            session_id,
            request_id,
            argument_buffers,
            expected_model_id,
            stream_observation,
            observation_error,
        );
        return;
    }
    let event_output_index = payload
        .get("output_index")
        .and_then(Value::as_u64)
        .and_then(|index| usize::try_from(index).ok());
    let tool_name = event_output_index
        .and_then(|index| tool_names.get(index))
        .or_else(|| tool_names.iter().find(|name| !name.trim().is_empty()))
        .and_then(|name| toolreason_stream_display_name(name));
    let event_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if event_type == "response.function_call_arguments.delta" {
        let Some(delta) = payload.get("delta").and_then(Value::as_str) else {
            return;
        };
        let output_index = payload
            .get("output_index")
            .and_then(Value::as_u64)
            .and_then(|index| usize::try_from(index).ok())
            .unwrap_or(0);
        if let Some(buffers) = argument_buffers {
            if buffers.len() <= output_index {
                buffers.resize(output_index + 1, String::new());
            }
            buffers[output_index].push_str(delta);
            // Do not expose provider argument fragments. The complete
            // native argument object is emitted only after Resp03 validates
            // and strips the auxiliary fields at the corresponding `done`
            // event.
            payload["delta"] = Value::String(String::new());
        }
        return;
    }
    if event_type == "response.function_call_arguments.done" {
        let output_index = payload
            .get("output_index")
            .and_then(Value::as_u64)
            .and_then(|index| usize::try_from(index).ok())
            .unwrap_or(0);
        let buffered_arguments = argument_buffers.as_deref().and_then(|buffers| {
            buffers
                .get(output_index)
                .filter(|arguments| !arguments.is_empty())
                .map(String::as_str)
        });
        let Some(arguments) =
            buffered_arguments.or_else(|| payload.get("arguments").and_then(Value::as_str))
        else {
            return;
        };
        let arguments_were_buffered = buffered_arguments.is_some();
        if json_object_has_duplicate_keys_at_resp03(arguments) {
            if arguments_were_buffered {
                payload["arguments"] = Value::String(arguments.to_string());
            }
            return;
        }
        let Ok(mut parameter) = serde_json::from_str::<Value>(arguments) else {
            if arguments_were_buffered {
                payload["arguments"] = Value::String(arguments.to_string());
            }
            return;
        };
        let Some(_fields) =
            v3_tool_thinking_fields_from_parameter_value_at_resp03(&parameter, expected_model_id)
        else {
            if arguments_were_buffered {
                payload["arguments"] = Value::String(arguments.to_string());
            }
            return;
        };
        let Ok(raw_parameter) = serde_json::to_string(&parameter) else {
            return;
        };
        strip_v3_tool_thinking_fields_from_parameter_value_at_resp03(
            &mut parameter,
            expected_model_id,
        );
        let Ok(redacted_arguments) = serde_json::to_string(&parameter) else {
            return;
        };
        payload["arguments"] = Value::String(redacted_arguments);
        if pending_reasons.len() <= output_index {
            pending_reasons.resize(output_index + 1, None);
        }
        pending_reasons[output_index] = Some(raw_parameter);
        return;
    }
    if event_type == "response.completed" {
        let Some(response) = payload.get_mut("response") else {
            return;
        };
        let terminal_pending_reason = pending_reasons.iter_mut().find_map(Option::take);
        let mut response_tools = Vec::new();
        let mut _response_reasons = Vec::new();
        collect_v3_toolreason_json_observations_at_resp03(
            response,
            &mut response_tools,
            &mut _response_reasons,
        );
        if response_tools.is_empty() {
            if let Some(output) = response.get("output").and_then(Value::as_array) {
                for item in output {
                    if let Some(object) = item.as_object() {
                        if let Some(name) = toolreason_display_name_from_object(object) {
                            response_tools.push(name);
                        }
                    }
                }
            }
        }
        if response_tools.is_empty() && terminal_pending_reason.is_some() {
            response_tools.extend(
                tool_names
                    .iter()
                    .filter_map(|name| toolreason_stream_display_name(name)),
            );
        }
        let response_raw_reason = terminal_pending_reason.clone().or_else(|| {
            let mut objects = Vec::new();
            collect_v3_tool_thinking_objects_at_resp03(response, &mut objects);
            objects.first().map(|(_, raw)| raw.clone())
        });
        map_v3_toolreason_to_reasoning_content_at_resp03_with_expected_model_without_observation(
            response,
            true,
            project_to_client,
            expected_model_id,
        );
        if project_to_client {
            if let Some(raw_reason) = response_raw_reason.as_deref() {
                append_v3_toolreason_reasoning_item_at_resp03(
                    response,
                    &response_tools,
                    raw_reason,
                );
            }
        }
        if !*reason_emitted && (response_raw_reason.is_some() || !response_tools.is_empty()) {
            let tool_label = format_toolreason_tool_label(&response_tools);
            let tool_label = if tool_label.is_empty() {
                "<missing>".to_string()
            } else {
                tool_label
            };
            emit_v3_toolreason_observation_at_resp03_with_optional_stream_observation(
                &tool_label,
                response_raw_reason.as_deref(),
                "resp03_direct_sse",
                reason_emitted,
                V3ToolreasonObservationContext {
                    session_id,
                    request_id,
                },
                expected_model_id,
                stream_observation,
                observation_error,
            );
        }
        return;
    }
    match event_type {
        "response.output_item.done" => {
            let is_message =
                payload.pointer("/item/type").and_then(Value::as_str) == Some("message");
            if !is_message {
                let json_tool_reason = payload
                    .get("item")
                    .and_then(Value::as_object)
                    .filter(|item| !v3_is_gemini_tool_call_object_at_resp03(item))
                    .and_then(|object| {
                        v3_tool_thinking_fields_from_tool_call_at_resp03(object, expected_model_id)
                    });
                let raw_tool_reason = payload
                    .get("item")
                    .and_then(Value::as_object)
                    .and_then(v3_tool_thinking_raw_parameter_from_tool_call_at_resp03);
                if let Some(item) = payload.get_mut("item").and_then(Value::as_object_mut) {
                    strip_v3_tool_thinking_fields_from_object_at_resp03(item, expected_model_id);
                }
                if let Some(fields) = json_tool_reason {
                    let tool_label = payload
                        .get("item")
                        .and_then(Value::as_object)
                        .and_then(toolreason_display_name_from_object)
                        .map(|name| vec![name])
                        .unwrap_or_else(|| tool_names.to_vec());
                    let reasoning =
                        format_toolreason_reasoning_from_reason(&tool_label, &fields.reason);
                    emit_v3_toolreason_observation_at_resp03_with_optional_stream_observation(
                        &format_toolreason_tool_label(&tool_label),
                        raw_tool_reason.as_deref(),
                        "resp03_direct_sse",
                        reason_emitted,
                        V3ToolreasonObservationContext {
                            session_id,
                            request_id,
                        },
                        expected_model_id,
                        stream_observation,
                        observation_error,
                    );
                    if project_to_client {
                        if let Some(reasoning) = reasoning {
                            if let Some(item) =
                                payload.get_mut("item").and_then(Value::as_object_mut)
                            {
                                item.insert(
                                    "reasoning_content".to_string(),
                                    Value::String(reasoning),
                                );
                            }
                        }
                    }
                    return;
                }
                if matches!(
                    payload.pointer("/item/type").and_then(Value::as_str),
                    Some("function" | "function_call" | "tool_call" | "custom_tool_call")
                ) {
                    let pending_raw = if *reason_emitted {
                        None
                    } else {
                        pending_reasons.iter_mut().find_map(Option::take)
                    };
                    let reasoning = pending_raw
                        .as_deref()
                        .and_then(|reason| format_toolreason_reasoning(tool_names, reason));
                    let tool_label = format_toolreason_tool_label(tool_names);
                    emit_v3_toolreason_observation_at_resp03_with_optional_stream_observation(
                        &tool_label,
                        pending_raw.as_deref(),
                        "resp03_direct_sse",
                        reason_emitted,
                        V3ToolreasonObservationContext {
                            session_id,
                            request_id,
                        },
                        expected_model_id,
                        stream_observation,
                        observation_error,
                    );
                    if project_to_client {
                        if let Some(reasoning) = reasoning {
                            if let Some(item) =
                                payload.get_mut("item").and_then(Value::as_object_mut)
                            {
                                item.insert(
                                    "reasoning_content".to_string(),
                                    Value::String(reasoning),
                                );
                            }
                        }
                    }
                }
                return;
            }
            let mut item_reasoning = None;
            let mut item_reason_raw = None;
            if item_reasoning.is_none() && tool_name.is_some() {
                if let Some(index) = event_output_index {
                    item_reasoning = pending_reasons
                        .get_mut(index)
                        .and_then(Option::take)
                        .and_then(|reason| {
                            item_reason_raw = Some(reason.clone());
                            format_toolreason_reasoning(tool_names, &reason)
                        });
                }
            }
            // The model may emit the reason text item before the later tool-call
            // item. Keep the reason pending until a concrete tool name is known;
            // otherwise this early message would consume the one-per-turn
            // observation as MISSING and block the real client projection.
            if tool_name.is_some() {
                let tool_label = format_toolreason_tool_label(tool_names);
                emit_v3_toolreason_observation_at_resp03_with_optional_stream_observation(
                    &tool_label,
                    item_reason_raw.as_deref(),
                    "resp03_direct_sse",
                    reason_emitted,
                    V3ToolreasonObservationContext {
                        session_id,
                        request_id,
                    },
                    expected_model_id,
                    stream_observation,
                    observation_error,
                );
                if project_to_client {
                    if let Some(reasoning) = item_reasoning {
                        if let Some(item) = payload.get_mut("item").and_then(Value::as_object_mut) {
                            item.insert("reasoning_content".to_string(), Value::String(reasoning));
                            let visible_reasoning = item
                                .get("reasoning_content")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            item.insert("type".to_string(), Value::String("reasoning".to_string()));
                            item.insert(
                                "summary".to_string(),
                                json!([{"type": "summary_text", "text": visible_reasoning}]),
                            );
                            item.remove("content");
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

fn map_v3_openai_chat_toolreason_chunk_at_resp03(
    payload: &mut Value,
    tool_names: &[String],
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    project_to_client: bool,
    session_id: Option<&str>,
    request_id: Option<&str>,
    argument_buffers: Option<&mut Vec<String>>,
) {
    let mut observation_error = None;
    map_v3_openai_chat_toolreason_chunk_at_resp03_with_expected_model(
        payload,
        tool_names,
        pending_reasons,
        reason_emitted,
        project_to_client,
        session_id,
        request_id,
        argument_buffers,
        None,
        None,
        &mut observation_error,
    );
    debug_assert!(observation_error.is_none());
}

fn map_v3_openai_chat_toolreason_chunk_at_resp03_with_expected_model(
    payload: &mut Value,
    tool_names: &[String],
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    project_to_client: bool,
    session_id: Option<&str>,
    request_id: Option<&str>,
    mut argument_buffers: Option<&mut Vec<String>>,
    expected_model_id: Option<&str>,
    stream_observation: Option<&crate::hub_v1::V3RuntimeStreamObservation>,
    observation_error: &mut Option<String>,
) {
    let Some(choices) = payload.get_mut("choices").and_then(Value::as_array_mut) else {
        return;
    };
    for choice in choices {
        let Some(delta) = choice.get_mut("delta").and_then(Value::as_object_mut) else {
            continue;
        };
        let mut projected_reasoning = None;
        if let Some(tool_calls) = delta.get_mut("tool_calls").and_then(Value::as_array_mut) {
            for tool_call in tool_calls {
                let buffer_index = tool_call
                    .get("index")
                    .and_then(Value::as_u64)
                    .and_then(|index| usize::try_from(index).ok())
                    .unwrap_or(0);
                let Some(function) = tool_call.get_mut("function").and_then(Value::as_object_mut)
                else {
                    continue;
                };
                let Some(arguments) = function
                    .get("arguments")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                else {
                    continue;
                };
                let buffered_arguments = if let Some(buffers) = argument_buffers.as_deref_mut() {
                    if buffers.len() <= buffer_index {
                        buffers.resize(buffer_index + 1, String::new());
                    }
                    let buffer = &mut buffers[buffer_index];
                    buffer.push_str(&arguments);
                    Some(buffer.clone())
                } else {
                    None
                };
                let parse_input = buffered_arguments.as_deref().unwrap_or(&arguments);
                if json_object_has_duplicate_keys_at_resp03(parse_input) {
                    continue;
                }
                let Ok(mut parameter) = serde_json::from_str::<Value>(parse_input) else {
                    if buffered_arguments.is_some() {
                        // The fragment is intentionally withheld until the complete
                        // parameter object is available; otherwise the three internal
                        // fields would leak one delta at a time to the client.
                        function.insert("arguments".to_string(), Value::String(String::new()));
                    }
                    continue;
                };
                let Ok(raw_parameter) = serde_json::to_string(&parameter) else {
                    continue;
                };
                let status = classify_v3_toolreason_observation_at_resp03_with_expected_model(
                    Some(&raw_parameter),
                    expected_model_id,
                )
                .0;
                let fields = v3_tool_thinking_fields_from_parameter_value_at_resp03(
                    &parameter,
                    expected_model_id,
                );
                strip_v3_tool_thinking_fields_from_parameter_value_at_resp03(
                    &mut parameter,
                    expected_model_id,
                );
                let Ok(redacted_arguments) = serde_json::to_string(&parameter) else {
                    continue;
                };
                function.insert("arguments".to_string(), Value::String(redacted_arguments));
                if fields.is_some() {
                    if pending_reasons.len() <= buffer_index {
                        pending_reasons.resize(buffer_index + 1, None);
                    }
                    pending_reasons[buffer_index] = Some(raw_parameter.clone());
                }
                if fields.is_some() && status == V3ToolreasonObservationStatus::Ok {
                    let tool_label = format_toolreason_tool_label(tool_names);
                    emit_v3_toolreason_observation_at_resp03_with_optional_stream_observation(
                        &tool_label,
                        Some(&raw_parameter),
                        "resp03_relay_sse",
                        reason_emitted,
                        V3ToolreasonObservationContext {
                            session_id,
                            request_id,
                        },
                        expected_model_id,
                        stream_observation,
                        observation_error,
                    );
                }
                if project_to_client
                    && fields.is_some()
                    && status == V3ToolreasonObservationStatus::Ok
                {
                    if let Some(fields) = fields {
                        projected_reasoning =
                            format_toolreason_reasoning_from_reason(tool_names, &fields.reason);
                    }
                }
            }
        }
        if projected_reasoning.is_none() && project_to_client && delta.contains_key("tool_calls") {
            if let Some(raw_pending) = pending_reasons
                .iter()
                .filter_map(|reason| reason.as_deref())
                .find_map(|raw| serde_json::from_str::<Value>(raw).ok())
            {
                if let Some(fields) = v3_tool_thinking_fields_from_parameter_value_at_resp03(
                    &raw_pending,
                    expected_model_id,
                ) {
                    projected_reasoning =
                        format_toolreason_reasoning_from_reason(tool_names, &fields.reason);
                }
            }
        }
        if let Some(reasoning) = projected_reasoning {
            delta
                .entry("reasoning_content")
                .or_insert(Value::String(reasoning));
        }
    }
}

/// Resp03 owns the complete toolreason stream projection. The shared stream
/// path only carries bytes and typed projection state into this function; it
/// does not parse, associate, or redact toolreason semantics.
pub(crate) fn project_v3_toolreason_sse_chunk_at_resp03(
    buffer: &mut Vec<u8>,
    tool_names: &mut Vec<String>,
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    chunk: &[u8],
) -> Vec<u8> {
    project_v3_toolreason_sse_chunk_at_resp03_with_projection_and_request_id(
        buffer,
        tool_names,
        pending_reasons,
        reason_emitted,
        true,
        chunk,
        None,
    )
}

pub(crate) fn project_v3_toolreason_sse_chunk_at_resp03_with_projection(
    buffer: &mut Vec<u8>,
    tool_names: &mut Vec<String>,
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    project_to_client: bool,
    chunk: &[u8],
) -> Vec<u8> {
    project_v3_toolreason_sse_chunk_at_resp03_with_projection_and_request_id(
        buffer,
        tool_names,
        pending_reasons,
        reason_emitted,
        project_to_client,
        chunk,
        None,
    )
}

pub(crate) fn project_v3_toolreason_sse_chunk_at_resp03_with_projection_and_request_id(
    buffer: &mut Vec<u8>,
    tool_names: &mut Vec<String>,
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    project_to_client: bool,
    chunk: &[u8],
    request_id: Option<&str>,
) -> Vec<u8> {
    project_v3_toolreason_sse_chunk_at_resp03_with_projection_and_context(
        buffer,
        tool_names,
        pending_reasons,
        reason_emitted,
        project_to_client,
        chunk,
        None,
        request_id,
    )
}

pub(crate) fn project_v3_toolreason_sse_chunk_at_resp03_with_projection_and_context(
    buffer: &mut Vec<u8>,
    tool_names: &mut Vec<String>,
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    project_to_client: bool,
    chunk: &[u8],
    session_id: Option<&str>,
    request_id: Option<&str>,
) -> Vec<u8> {
    buffer.extend_from_slice(chunk);
    let mut output = Vec::new();
    while let Some((end, delimiter_len)) = find_v3_sse_frame_end_at_resp03(buffer) {
        let frame_end = end + delimiter_len;
        let frame: Vec<u8> = buffer.drain(..frame_end).collect();
        output.extend(project_v3_toolreason_sse_frame_at_resp03(
            &frame,
            tool_names,
            pending_reasons,
            reason_emitted,
            project_to_client,
            session_id,
            request_id,
        ));
    }
    output
}

pub(crate) fn project_v3_toolreason_sse_final_buffer_at_resp03(
    buffer: &[u8],
    tool_names: &mut Vec<String>,
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
) -> Vec<u8> {
    project_v3_toolreason_sse_final_buffer_at_resp03_with_projection(
        buffer,
        tool_names,
        pending_reasons,
        reason_emitted,
        true,
    )
}

pub(crate) fn project_v3_toolreason_sse_final_buffer_at_resp03_with_projection(
    buffer: &[u8],
    tool_names: &mut Vec<String>,
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    project_to_client: bool,
) -> Vec<u8> {
    project_v3_toolreason_sse_final_buffer_at_resp03_with_projection_and_request_id(
        buffer,
        tool_names,
        pending_reasons,
        reason_emitted,
        project_to_client,
        None,
    )
}

pub(crate) fn project_v3_toolreason_sse_final_buffer_at_resp03_with_projection_and_request_id(
    buffer: &[u8],
    tool_names: &mut Vec<String>,
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    project_to_client: bool,
    request_id: Option<&str>,
) -> Vec<u8> {
    project_v3_toolreason_sse_final_buffer_at_resp03_with_projection_and_context(
        buffer,
        tool_names,
        pending_reasons,
        reason_emitted,
        project_to_client,
        None,
        request_id,
    )
}

pub(crate) fn project_v3_toolreason_sse_final_buffer_at_resp03_with_projection_and_context(
    buffer: &[u8],
    tool_names: &mut Vec<String>,
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    project_to_client: bool,
    session_id: Option<&str>,
    request_id: Option<&str>,
) -> Vec<u8> {
    project_v3_toolreason_sse_frame_at_resp03(
        buffer,
        tool_names,
        pending_reasons,
        reason_emitted,
        project_to_client,
        session_id,
        request_id,
    )
}

/// Resp03's Direct SSE turn closeout. A missing JSON v2 field is observed only
/// when the stream reaches its actual terminal boundary.
pub(crate) fn finalize_v3_toolreason_observation_at_resp03_with_context(
    tool_names: &[String],
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    context: V3ToolreasonObservationContext<'_>,
) {
    finalize_v3_toolreason_observation_at_resp03_with_expected_model(
        tool_names,
        pending_reasons,
        reason_emitted,
        context,
        None,
    );
}

pub(crate) fn finalize_v3_toolreason_observation_at_resp03_with_expected_model(
    tool_names: &[String],
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    context: V3ToolreasonObservationContext<'_>,
    expected_model_id: Option<&str>,
) {
    finalize_v3_toolreason_observation_at_resp03_with_expected_model_and_stream_observation(
        tool_names,
        pending_reasons,
        reason_emitted,
        context,
        expected_model_id,
        None,
    )
    .expect("Toolreason finalization without a stream observation cannot fail");
}

pub(crate) fn finalize_v3_toolreason_observation_at_resp03_with_expected_model_and_stream_observation(
    tool_names: &[String],
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    context: V3ToolreasonObservationContext<'_>,
    expected_model_id: Option<&str>,
    stream_observation: Option<&crate::hub_v1::V3RuntimeStreamObservation>,
) -> Result<(), String> {
    let has_pending_reason = pending_reasons.iter().any(Option::is_some);
    if *reason_emitted || (tool_names.is_empty() && !has_pending_reason) {
        return Ok(());
    }
    let reason = pending_reasons.iter_mut().find_map(Option::take);
    let tool_label = format_toolreason_tool_label(tool_names);
    let tool_label = if tool_label.is_empty() {
        "<missing>".to_string()
    } else {
        tool_label
    };
    let reason = reason.as_deref().and_then(|reason| {
        let reason = reason.trim();
        (!reason.is_empty()).then_some(reason)
    });
    if let Some(stream_observation) = stream_observation {
        emit_v3_toolreason_observation_at_resp03_with_expected_model_and_stream_observation(
            &tool_label,
            reason,
            "resp03_direct_sse",
            reason_emitted,
            context,
            expected_model_id,
            stream_observation,
        )?;
    } else {
        emit_v3_toolreason_observation_at_resp03_with_expected_model(
            &tool_label,
            reason,
            "resp03_direct_sse",
            reason_emitted,
            context,
            expected_model_id,
        );
    }
    Ok(())
}

fn find_v3_sse_frame_end_at_resp03(buffer: &[u8]) -> Option<(usize, usize)> {
    let lf = buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|index| (index, 2));
    let crlf = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| (index, 4));
    match (lf, crlf) {
        (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
        (Some(found), None) | (None, Some(found)) => Some(found),
        (None, None) => None,
    }
}

fn project_v3_toolreason_sse_frame_at_resp03(
    chunk: &[u8],
    tool_names: &mut Vec<String>,
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    project_to_client: bool,
    session_id: Option<&str>,
    request_id: Option<&str>,
) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(chunk) else {
        return chunk.to_vec();
    };
    let mut output = String::with_capacity(text.len());
    let mut projected_visible_reasoning = false;
    for line in text.split_inclusive('\n') {
        let Some(data) = line.strip_prefix("data:") else {
            output.push_str(line);
            continue;
        };
        let data = data.strip_prefix(' ').unwrap_or(data);
        let data = data.trim_end_matches(['\r', '\n']);
        let Ok(mut payload) = serde_json::from_str::<Value>(data) else {
            output.push_str(line);
            continue;
        };
        collect_v3_responses_sse_tool_name_at_resp03(&payload, tool_names);
        let event_type = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let is_completed_with_tool_call =
            event_type == "response.completed" && v3_json_contains_tool_call_at_resp03(&payload);
        let has_pending_message_reason = event_type == "response.output_item.done"
            && payload.pointer("/item/type").and_then(Value::as_str) == Some("message")
            && payload
                .get("output_index")
                .and_then(Value::as_u64)
                .and_then(|index| usize::try_from(index).ok())
                .and_then(|index| pending_reasons.get(index))
                .is_some_and(Option::is_some);
        let is_tool_call_done = event_type == "response.output_item.done"
            && matches!(
                payload.pointer("/item/type").and_then(Value::as_str),
                Some("function" | "function_call" | "tool_call" | "custom_tool_call")
            );
        let is_message_done = event_type == "response.output_item.done"
            && payload.pointer("/item/type").and_then(Value::as_str) == Some("message");
        let is_toolreason_reasoning_done = event_type == "response.output_item.done"
            && payload.pointer("/item/type").and_then(Value::as_str) == Some("reasoning")
            && payload
                .pointer("/item/id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with("rcc_reason_"));
        if !has_pending_message_reason
            && !is_tool_call_done
            && !is_completed_with_tool_call
            && !is_toolreason_reasoning_done
        {
            output.push_str(line);
            continue;
        }
        if is_completed_with_tool_call {
            // Some Responses providers collapse the whole assistant turn into
            // response.completed and omit output_item.done. Resp03 must still
            // validate every tool call and remove the private marker here.
            let terminal_pending_reason = pending_reasons.iter_mut().find_map(Option::take);
            if let Some(response) = payload.get_mut("response") {
                // Harvest the native fields before the mapping pass removes
                // them.  The terminal direct-SSE path is also the observation
                // closeout; reading the post-map payload turns a valid native
                // response into a false MISSING.
                let mut response_tools = Vec::new();
                let mut response_reasons = Vec::new();
                collect_v3_toolreason_json_observations_at_resp03(
                    response,
                    &mut response_tools,
                    &mut response_reasons,
                );
                map_v3_toolreason_to_reasoning_content_at_resp03_without_observation(
                    response,
                    true,
                    project_to_client,
                );
                if project_to_client {
                    if let Some(reason) = terminal_pending_reason.as_deref() {
                        append_v3_toolreason_reasoning_item_at_resp03(response, tool_names, reason);
                    }
                }
                if project_to_client && !*reason_emitted {
                    append_v3_toolreason_completed_visible_text_at_resp03(response, &mut output);
                }
                if !*reason_emitted {
                    let tool_label = format_toolreason_tool_label(&response_tools);
                    emit_v3_toolreason_observation_at_resp03_with_context(
                        &tool_label,
                        response_reasons
                            .first()
                            .map(String::as_str)
                            .or(terminal_pending_reason.as_deref()),
                        "resp03_direct_sse",
                        reason_emitted,
                        V3ToolreasonObservationContext {
                            session_id,
                            request_id,
                        },
                    );
                }
            } else {
                // Same ordering rule for a terminal payload without a nested
                // response object: observe the native call before stripping.
                let mut response_tools = Vec::new();
                let mut response_reasons = Vec::new();
                collect_v3_toolreason_json_observations_at_resp03(
                    &payload,
                    &mut response_tools,
                    &mut response_reasons,
                );
                map_v3_toolreason_to_reasoning_content_at_resp03_without_observation(
                    &mut payload,
                    true,
                    project_to_client,
                );
                if project_to_client {
                    if let Some(reason) = terminal_pending_reason.as_deref() {
                        append_v3_toolreason_reasoning_item_at_resp03(
                            &mut payload,
                            tool_names,
                            reason,
                        );
                    }
                }
                if project_to_client && !*reason_emitted {
                    append_v3_toolreason_completed_visible_text_at_resp03(
                        &mut payload,
                        &mut output,
                    );
                }
                if !*reason_emitted {
                    let tool_label = format_toolreason_tool_label(&response_tools);
                    emit_v3_toolreason_observation_at_resp03_with_context(
                        &tool_label,
                        response_reasons
                            .first()
                            .map(String::as_str)
                            .or(terminal_pending_reason.as_deref()),
                        "resp03_direct_sse",
                        reason_emitted,
                        V3ToolreasonObservationContext {
                            session_id,
                            request_id,
                        },
                    );
                }
            }
        } else {
            map_v3_toolreason_stream_event_at_resp03_with_context(
                &mut payload,
                true,
                tool_names,
                pending_reasons,
                reason_emitted,
                project_to_client,
                session_id,
                request_id,
            );
        }
        if project_to_client
            && payload.get("object").and_then(Value::as_str) == Some("chat.completion.chunk")
        {
            if let Some(reasoning) = payload
                .pointer("/choices/0/delta/reasoning_content")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
            {
                output.push_str(&build_v3_openai_chat_reasoning_projection_frame_at_resp03(
                    &payload, reasoning,
                ));
            }
        }
        if project_to_client && !projected_visible_reasoning && *reason_emitted {
            if let Some(reasoning) =
                build_v3_toolreason_reasoning_done_projection_at_resp03(&payload)
            {
                output.push_str(&reasoning);
                projected_visible_reasoning = true;
            }
        }
        if project_to_client && is_tool_call_done {
            if let Some(reasoning) = payload
                .pointer("/item/reasoning_content")
                .and_then(Value::as_str)
                .map(str::to_owned)
            {
                output.push_str(&build_v3_toolreason_visible_text_sse_events_at_resp03(
                    &payload, &reasoning,
                ));
                if let Some(item) = payload.get_mut("item").and_then(Value::as_object_mut) {
                    item.remove("reasoning_content");
                }
            }
        }
        if project_to_client && is_message_done {
            if let Some(reasoning) = payload
                .pointer("/item/reasoning_content")
                .and_then(Value::as_str)
                .map(str::to_owned)
            {
                output.push_str(&build_v3_toolreason_visible_text_sse_events_at_resp03(
                    &payload, &reasoning,
                ));
                if let Some(item) = payload.get_mut("item").and_then(Value::as_object_mut) {
                    item.remove("reasoning_content");
                }
            }
        }
        let Ok(encoded) = serde_json::to_string(&payload) else {
            output.push_str(line);
            continue;
        };
        output.push_str("data:");
        if line.strip_prefix("data: ").is_some() {
            output.push(' ');
        }
        output.push_str(&encoded);
        if line.ends_with('\n') {
            output.push('\n');
        }
    }
    output.into_bytes()
}

pub(crate) fn build_v3_openai_chat_reasoning_projection_frame_at_resp03(
    payload: &Value,
    reasoning: &str,
) -> String {
    let mut projected = payload.clone();
    let choices = projected.get_mut("choices").and_then(Value::as_array_mut);
    if let Some(choice) = choices.and_then(|choices| choices.first_mut()) {
        let index = choice.get("index").cloned().unwrap_or_else(|| json!(0));
        let delta = json!({"role":"assistant","reasoning_content":reasoning});
        *choice = json!({"index":index,"delta":delta,"finish_reason":null});
    }
    let Ok(encoded) = serde_json::to_string(&projected) else {
        return String::new();
    };
    format!("data: {encoded}\n\n")
}

fn append_v3_toolreason_completed_visible_text_at_resp03(
    response: &mut Value,
    output: &mut String,
) {
    let Some(items) = response.get_mut("output").and_then(Value::as_array_mut) else {
        return;
    };
    for (index, item) in items.iter_mut().enumerate() {
        // Only replay reasoning items created by this Resp03 toolreason
        // projection. Native model reasoning must pass through untouched and
        // must never be re-emitted as a toolreason summary.
        let is_toolreason_item = item
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| id.starts_with("rcc_reason_"));
        if !is_toolreason_item || item.get("type").and_then(Value::as_str) != Some("reasoning") {
            continue;
        }
        let reasoning = item
            .get("summary")
            .and_then(Value::as_array)
            .and_then(|summary| summary.first())
            .and_then(|part| part.get("text"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let Some(reasoning) = reasoning else { continue };
        output.push_str(&build_v3_toolreason_visible_text_sse_events_at_resp03(
            &json!({"output_index": index}),
            &reasoning,
        ));
        if let Some(object) = item.as_object_mut() {
            object.remove("reasoning_content");
        }
        break;
    }
}

fn append_v3_toolreason_reasoning_item_at_resp03(
    payload: &mut Value,
    tool_names: &[String],
    reason: &str,
) {
    let Some(reasoning) = format_toolreason_reasoning(tool_names, reason) else {
        return;
    };
    let Some(output) = payload.get_mut("output").and_then(Value::as_array_mut) else {
        return;
    };
    if output
        .iter()
        .any(|item| item.get("type").and_then(Value::as_str) == Some("reasoning"))
    {
        return;
    }
    output.insert(
        0,
        json!({
            "id": "rcc_reason_tool_call",
            "type": "reasoning",
            "status": "completed",
            "summary": [{"type": "summary_text", "text": reasoning}]
        }),
    );
}

fn append_v3_toolreason_visible_text_item_at_resp03(
    output: &mut Vec<Value>,
    reasoning: &str,
) -> (usize, bool) {
    if let Some(index) = output.iter().position(|item| {
        item.get("type").and_then(Value::as_str) == Some("message")
            && item.get("role").and_then(Value::as_str) == Some("assistant")
            && item.pointer("/content/0/type").and_then(Value::as_str) == Some("output_text")
            && item.pointer("/content/0/text").and_then(Value::as_str) == Some(reasoning)
    }) {
        return (index, false);
    }
    let insert_at = output
        .iter()
        .position(|item| {
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("function_call" | "tool_call" | "custom_tool_call")
            )
        })
        .unwrap_or(output.len());
    output.insert(
        insert_at,
        json!({
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": reasoning}]
        }),
    );
    (insert_at, true)
}

pub(crate) fn build_v3_toolreason_reasoning_done_projection_at_resp03(
    payload: &Value,
) -> Option<String> {
    if payload.get("type").and_then(Value::as_str) != Some("response.output_item.done")
        || payload.pointer("/item/type").and_then(Value::as_str) != Some("reasoning")
        || !payload
            .pointer("/item/id")
            .and_then(Value::as_str)
            .is_some_and(|id| id.starts_with("rcc_reason_"))
    {
        return None;
    }
    let reasoning = payload
        .pointer("/item/summary")
        .and_then(Value::as_array)
        .and_then(|summary| {
            summary
                .iter()
                .find_map(|part| part.get("text").and_then(Value::as_str))
        })?;
    Some(build_v3_toolreason_visible_text_sse_events_at_resp03(
        payload, reasoning,
    ))
}

pub(crate) fn build_v3_toolreason_visible_text_sse_events_at_resp03(
    payload: &Value,
    reasoning: &str,
) -> String {
    let output_index = payload
        .get("output_index")
        .cloned()
        .unwrap_or_else(|| json!(0));
    let item_id = payload
        .pointer("/item/call_id")
        .or_else(|| payload.pointer("/item/id"))
        .and_then(Value::as_str)
        .map(|id| format!("rcc_reason_{id}"))
        .unwrap_or_else(|| "rcc_reason_tool_call".to_string());
    let visible_item_id = format!("{item_id}_text");
    let visible_output_index = output_index
        .as_u64()
        .map(|index| json!(index.saturating_add(1)))
        .unwrap_or_else(|| output_index.clone());
    let visible_message = json!({
        "id": visible_item_id.clone(),
        "type": "message",
        "status": "completed",
        "role": "assistant",
        "content": [{"type": "output_text", "text": reasoning}]
    });
    let events = [
        json!({"type":"response.output_item.added","output_index":output_index.clone(),"item":{"id":item_id.clone(),"type":"reasoning","status":"in_progress","summary":[]}}),
        json!({"type":"response.reasoning_summary_part.added","output_index":output_index.clone(),"item_id":item_id.clone(),"summary_index":0,"part":{"type":"summary_text","text":""}}),
        json!({"type":"response.reasoning_summary_text.delta","output_index":output_index.clone(),"item_id":item_id.clone(),"summary_index":0,"delta":reasoning}),
        json!({"type":"response.reasoning_summary_text.done","output_index":output_index.clone(),"item_id":item_id.clone(),"summary_index":0,"text":reasoning}),
        json!({"type":"response.reasoning_summary_part.done","output_index":output_index.clone(),"item_id":item_id.clone(),"summary_index":0,"part":{"type":"summary_text","text":reasoning}}),
        json!({"type":"response.output_item.done","output_index":output_index.clone(),"item":{"id":item_id,"type":"reasoning","status":"completed","summary":[{"type":"summary_text","text":reasoning}]}}),
        json!({"type":"response.output_item.added","output_index":visible_output_index.clone(),"item":{"id":visible_item_id.clone(),"type":"message","status":"in_progress","role":"assistant","content":[]}}),
        json!({"type":"response.content_part.added","output_index":visible_output_index.clone(),"item_id":visible_item_id.clone(),"content_index":0,"part":{"type":"output_text","text":""}}),
        json!({"type":"response.output_text.delta","output_index":visible_output_index.clone(),"item_id":visible_item_id.clone(),"content_index":0,"delta":reasoning}),
        json!({"type":"response.output_text.done","output_index":visible_output_index.clone(),"item_id":visible_item_id.clone(),"content_index":0,"text":reasoning}),
        json!({"type":"response.content_part.done","output_index":visible_output_index.clone(),"item_id":visible_item_id,"content_index":0,"part":{"type":"output_text","text":reasoning}}),
        json!({"type":"response.output_item.done","output_index":visible_output_index,"item":visible_message}),
    ];
    let mut output = String::new();
    for event in events {
        output.push_str("event: ");
        output.push_str(event["type"].as_str().unwrap_or_default());
        output.push_str("\ndata: ");
        if let Ok(encoded) = serde_json::to_vec(&event) {
            output.push_str(&String::from_utf8_lossy(&encoded));
        }
        output.push_str("\n\n");
    }
    output
}

pub(crate) fn collect_v3_responses_sse_tool_name_at_resp03(
    payload: &Value,
    tool_names: &mut Vec<String>,
) {
    // Some Responses providers return an OpenAI Chat SSE chunk inside the
    // Responses transport envelope.  It is still a provider tool-call shape,
    // so Resp03 must harvest its real function name before parsing the
    // auxiliary fields.  Without this branch the later Chat mapper receives
    // an empty tool-name list and cannot emit a terminal observation or a
    // client reasoning projection.
    if payload.get("object").and_then(Value::as_str) == Some("chat.completion.chunk") {
        collect_v3_tool_call_names_at_resp03(payload, tool_names);
        return;
    }
    let output_index = payload
        .get("output_index")
        .and_then(Value::as_u64)
        .and_then(|index| usize::try_from(index).ok());
    let stream_index = output_index.or_else(|| {
        payload
            .get("index")
            .and_then(Value::as_u64)
            .and_then(|index| usize::try_from(index).ok())
    });
    if let Some(index) = stream_index {
        let call_object = payload
            .get("content_block")
            .or_else(|| payload.get("item"))
            .or_else(|| payload.pointer("/response/output/0"))
            .and_then(Value::as_object);
        if let Some(call_object) = call_object.filter(|object| {
            v3_is_tool_call_object_at_resp03(object)
                || object.get("name").and_then(Value::as_str).is_some()
        }) {
            if tool_names.len() <= index {
                tool_names.resize(index + 1, String::new());
            }
            if let Some(display_name) = toolreason_display_name_from_object(call_object) {
                tool_names[index] = display_name;
            }
        }
        if let Some(fragment) = payload
            .pointer("/delta/partial_json")
            .and_then(Value::as_str)
            .or_else(|| payload.pointer("/delta/input_json").and_then(Value::as_str))
        {
            if tool_names.len() > index && tool_names[index].starts_with("exec_command|") {
                tool_names[index].push_str(fragment);
            }
        }
        return;
    }
    if v3_json_contains_tool_call_at_resp03(payload) {
        collect_v3_tool_call_names_at_resp03(payload, tool_names);
        if tool_names
            .iter()
            .any(|name| name.starts_with("exec_command|"))
        {
            tool_names.retain(|name| name != "exec_command");
        }
        return;
    }
    let candidates = [
        payload.pointer("/item/name").and_then(Value::as_str),
        payload
            .pointer("/response/output/0/name")
            .and_then(Value::as_str),
    ];
    for name in candidates.into_iter().flatten() {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        if let Some(index) = output_index {
            if tool_names.len() <= index {
                tool_names.resize(index + 1, String::new());
            }
            if tool_names[index].is_empty() {
                tool_names[index] = if name == "exec_command" {
                    "exec_command|".to_string()
                } else {
                    name.to_string()
                };
            }
        } else if !tool_names.iter().any(|existing| existing == name) {
            tool_names.push(name.to_string());
        }
    }
}

fn collect_v3_tool_call_names_at_resp03(value: &Value, tool_names: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            if v3_is_tool_call_object_at_resp03(object) {
                if let Some(name) = toolreason_display_name_from_object(object) {
                    if !tool_names.iter().any(|existing| existing == &name) {
                        tool_names.push(name);
                    }
                }
            }
            for child in object.values() {
                collect_v3_tool_call_names_at_resp03(child, tool_names);
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_v3_tool_call_names_at_resp03(value, tool_names);
            }
        }
        Value::String(_) | Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn v3_json_contains_tool_call_at_resp03(value: &Value) -> bool {
    match value {
        Value::Object(object) => {
            v3_is_tool_call_object_at_resp03(object)
                || object.values().any(v3_json_contains_tool_call_at_resp03)
        }
        Value::Array(values) => values.iter().any(v3_json_contains_tool_call_at_resp03),
        Value::String(_) | Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

fn v3_is_tool_call_object_at_resp03(object: &serde_json::Map<String, Value>) -> bool {
    let object_type = object.get("type").and_then(Value::as_str);
    if matches!(
        object_type,
        Some("tool_use" | "tool_call" | "function_call" | "custom_tool_call")
    ) {
        return true;
    }
    if object_type == Some("function") {
        return object.contains_key("arguments")
            || object.contains_key("call_id")
            || object.contains_key("id")
            || object
                .get("function")
                .and_then(Value::as_object)
                .is_some_and(|function| {
                    function.contains_key("arguments")
                        || function.contains_key("input")
                        || function.contains_key("args")
                });
    }
    if object
        .get("functionCall")
        .and_then(Value::as_object)
        .and_then(|function_call| function_call.get("name"))
        .and_then(Value::as_str)
        .is_some()
    {
        return true;
    }
    if object.get("name").and_then(Value::as_str).is_some()
        && (object.contains_key("args")
            || object.contains_key("arguments")
            || object.contains_key("input"))
    {
        return true;
    }
    object
        .get("function")
        .and_then(Value::as_object)
        .and_then(|function| function.get("name"))
        .and_then(Value::as_str)
        .is_some()
        && (object.contains_key("arguments")
            || object.contains_key("call_id")
            || object.contains_key("id")
            || object
                .get("function")
                .and_then(Value::as_object)
                .is_some_and(|function| {
                    function.contains_key("arguments")
                        || function.contains_key("input")
                        || function.contains_key("args")
                }))
}

/// Toolreason is represented only by explicit JSON auxiliary fields inside a
/// native tool-call argument object. Never inspect or rewrite native tool
/// arguments while looking for fields outside that registered object surface.
fn v3_is_tool_call_payload_key_at_resp03(key: &str) -> bool {
    matches!(
        key,
        "arguments" | "input" | "parameters" | "function" | "functionCall" | "args"
    )
}

fn format_toolreason_reasoning(tool_names: &[String], reason: &str) -> Option<String> {
    let names = format_toolreason_tool_label(tool_names);
    let reason = parse_v3_toolreason_fields_at_resp03(reason)?.reason;
    if names.is_empty() || reason.is_empty() {
        return None;
    }
    Some(format!("调用工具 {names}：{reason}"))
}

fn format_toolreason_reasoning_from_reason(tool_names: &[String], reason: &str) -> Option<String> {
    let names = format_toolreason_tool_label(tool_names);
    let reason = reason.trim().to_string();
    if names.is_empty() || reason.is_empty() || is_v3_toolreason_placeholder(&reason) {
        return None;
    }
    Some(format!("调用工具 {names}：{reason}"))
}

fn format_toolreason_tool_label(tool_names: &[String]) -> String {
    let mut names = tool_names
        .iter()
        .filter_map(|name| toolreason_stream_display_name(name))
        .filter(|name| !name.is_empty())
        .fold(Vec::<String>::new(), |mut names, name| {
            if !names.iter().any(|existing| existing == &name) {
                names.push(name);
            }
            names
        });
    if names.iter().any(|name| name != "exec_command") {
        names.retain(|name| name != "exec_command");
    }
    names.join("、")
}

fn toolreason_stream_display_name(name: &str) -> Option<String> {
    let name = name.trim();
    if !name.starts_with("exec_command|") {
        return (!name.is_empty()).then(|| name.to_string());
    }
    let fragment = name.strip_prefix("exec_command|")?;
    let value = serde_json::from_str::<Value>(fragment).ok();
    value
        .and_then(|value| value.get("cmd").and_then(Value::as_str).map(str::to_owned))
        .and_then(|command| command.split_whitespace().next().map(str::to_owned))
}

fn toolreason_display_name_from_object(object: &serde_json::Map<String, Value>) -> Option<String> {
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| {
            object
                .get("functionCall")
                .and_then(Value::as_object)
                .and_then(|function_call| function_call.get("name"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            object
                .get("function")
                .and_then(Value::as_object)
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|name| !name.is_empty())?;
    if name != "exec_command" {
        return Some(name.to_string());
    }
    let arguments = object
        .get("arguments")
        .or_else(|| object.get("input"))
        .or_else(|| object.get("args"))
        .or_else(|| {
            object
                .get("functionCall")
                .and_then(Value::as_object)
                .and_then(|function_call| function_call.get("args"))
        })
        .or_else(|| {
            object
                .get("function")
                .and_then(Value::as_object)
                .and_then(|function| function.get("arguments"))
        });
    let command = match arguments {
        Some(Value::String(raw)) => serde_json::from_str::<Value>(raw).ok(),
        Some(value @ Value::Object(_)) => Some(value.clone()),
        _ => None,
    }
    .and_then(|value| value.get("cmd").and_then(Value::as_str).map(str::to_owned));
    command.and_then(|command| {
        command
            .split_whitespace()
            .find(|token| !token.is_empty())
            .map(str::to_owned)
    })
}

fn is_v3_toolreason_placeholder(reason: &str) -> bool {
    let normalized = reason.trim().to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "..."
            | "…"
            | "具体原因"
            | "直接动机"
            | "真实当前动机"
            | "理由文本"
            | "reason"
            | "reason text"
            | "your reason"
    ) {
        return true;
    }
    normalized.starts_with("◦ 调用工具")
        || normalized.starts_with("调用工具")
        || normalized.starts_with("#tool 调用工具")
        || normalized.starts_with("· 调用工具")
        || normalized.starts_with("🟢 调用工具")
        || normalized.contains("开始标签")
        || normalized.contains("结束标签")
        || normalized.contains("具体动机")
        || normalized.contains("真实当前动机")
        || normalized.contains("工具调用要求")
        || normalized.contains("不适用于普通回答")
        || normalized.contains("一句真实")
}

fn harvest_v3_gemini_think_blocks(payload: &mut Value) -> bool {
    let Some(candidates) = payload.get_mut("candidates").and_then(Value::as_array_mut) else {
        return false;
    };
    let mut changed = false;
    for candidate in candidates {
        let Some(parts) = candidate
            .get_mut("content")
            .and_then(|content| content.get_mut("parts"))
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        for part in parts {
            let Some(row) = part.as_object_mut() else {
                continue;
            };
            let Some(text) = row.get("text").and_then(Value::as_str) else {
                continue;
            };
            let harvest = harvest_v3_think_text(text);
            if !harvest.changed {
                continue;
            }
            changed = true;
            row.insert("text".to_string(), Value::String(harvest.visible_text));
            let mut thought = String::new();
            for segment in harvest.reasoning_segments {
                let Some(segment) = read_v3_resp03_trimmed_owned(&segment) else {
                    continue;
                };
                if !thought.is_empty() {
                    thought.push('\n');
                }
                thought.push_str(&segment);
            }
            if !thought.is_empty() {
                row.insert("thought".to_string(), Value::String(thought));
            }
        }
    }
    changed
}

fn project_v3_apply_patch_freeform_calls_at_resp03(
    mut input: V3HubRespInbound02Normalized,
) -> V3HubRespInbound02Normalized {
    let mut next = input.provider_payload().as_ref().clone();
    let mut changed = false;
    if let Some(output) = next
        .as_object_mut()
        .and_then(|object| object.get_mut("output"))
        .and_then(Value::as_array_mut)
    {
        for item in output {
            let Some(row) = item.as_object_mut() else {
                continue;
            };
            changed |= project_v3_apply_patch_freeform_output_item_at_resp03(row);
        }
    }
    if changed {
        *input.provider_payload_mut() = Arc::new(next);
    }
    input
}

fn project_v3_apply_patch_freeform_output_item_at_resp03(row: &mut Map<String, Value>) -> bool {
    let item_type = row
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if !matches!(
        item_type.as_str(),
        "function_call" | "custom_tool_call" | "tool_call"
    ) {
        return false;
    }
    if read_v3_apply_patch_tool_name(row).as_deref() != Some("apply_patch") {
        return false;
    }
    if item_type == "custom_tool_call" {
        // The input of a native custom tool call is already freeform client
        // input. A JSON-looking patch is still native input, not a wrapper.
        // Tool-thinking extraction owns explicit wrappers; this projection
        // owns only legacy function calls.
        return false;
    }

    let input = row
        .get("arguments")
        .or_else(|| row.get("input"))
        .or_else(|| row.get("args"))
        .map(normalize_v3_apply_patch_freeform_value_for_client)
        .unwrap_or_default();
    if let Some(call_id) = row
        .get("call_id")
        .or_else(|| row.get("id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
    {
        row.insert("call_id".to_string(), Value::String(call_id));
    }
    row.insert(
        "type".to_string(),
        Value::String("custom_tool_call".to_string()),
    );
    row.insert("name".to_string(), Value::String("apply_patch".to_string()));
    row.insert("input".to_string(), Value::String(input));
    row.remove("arguments");
    row.remove("args");
    row.remove("function");
    true
}

fn read_v3_apply_patch_tool_name(row: &Map<String, Value>) -> Option<String> {
    row.get("name")
        .and_then(Value::as_str)
        .or_else(|| {
            row.get("function")
                .and_then(Value::as_object)
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
}

fn normalize_v3_apply_patch_freeform_value_for_client(value: &Value) -> String {
    match value {
        Value::String(raw) => normalize_v3_apply_patch_freeform_input_for_client(raw),
        Value::Object(record) => record
            .get("patch")
            .or_else(|| record.get("input"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| value.to_string()),
        _ => value.to_string(),
    }
}

fn normalize_v3_apply_patch_freeform_input_for_client(arguments_text: &str) -> String {
    let parsed = arguments_text.parse::<Value>().ok();
    let Some(Value::Object(record)) = parsed else {
        return arguments_text.to_string();
    };
    record
        .get("patch")
        .or_else(|| record.get("input"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| arguments_text.to_string())
}

#[cfg(test)]
#[path = "resp_chat_process_03_governed_tests.rs"]
mod resp_chat_process_03_governed_tests;

#[cfg(test)]
#[path = "resp_chat_process_03_governed_inline_tests.rs"]
mod tests;

#[cfg(test)]
mod canonical_govern_registry_tests {
    use super::*;

    fn resp02(payload: Value) -> V3HubRespInbound02Normalized {
        let resp01 = build_v3_provider_resp_inbound_01_raw(
            payload,
            V3HubEntryProtocol::Responses,
            V3HubProviderWireProtocol::Responses,
            V3HubExecutionMode::Relay,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        let compat = build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(resp01)
            .expect("Resp01 must normalize");
        build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(compat)
            .expect("Resp02 must build")
    }

    fn success_payload() -> Value {
        json!({
            "id": "resp_registry_sidecar",
            "model": "client-visible-model",
            "status": "completed",
            "output": [
                {
                    "type": "message",
                    "content": [{
                        "type": "output_text",
                        "text": "<think>typed sidecar</think>visible"
                    }]
                },
                {
                    "type": "function_call",
                    "call_id": "call_registry_web_search",
                    "name": "web_search",
                    "arguments": "{\"query\":\"registry\"}"
                },
                {
                    "type": "function_call",
                    "call_id": "call_registry_followup",
                    "name": "registry_followup",
                    "arguments": "{\"item\":\"preserved\"}"
                }
            ]
        })
    }

    fn success_profile() -> V3HubRelayResponseHookProfile {
        V3HubRelayResponseHookProfile::empty()
    }

    #[test]
    fn canonical_registry_govern_returns_transformation_and_typed_side_outputs() {
        let profile = success_profile();
        let expected = govern_v3_hub_relay_response(resp02(success_payload()), &profile)
            .expect("direct governance must succeed")
            .finalized_payload()
            .clone();
        assert_eq!(
            expected["output"][0]["summary"][0]["text"],
            json!("typed sidecar")
        );
        assert!(!expected.to_string().contains("<think>"));
        assert!(expected.to_string().contains("call_registry_web_search"));
        assert!(expected.to_string().contains("call_registry_followup"));
        assert!(expected.to_string().contains("preserved"));

        let outcome = compile_v3_hub_relay_response_hooks()
            .govern(resp02(success_payload()), &profile)
            .expect("public registry governance must succeed");

        assert_eq!(outcome.finalized_payload(), &expected);
        assert_eq!(outcome.terminality(), V3HubResponseTerminality::NonTerminal);
    }

    #[test]
    fn canonical_registry_govern_preserves_the_original_typed_error() {
        let expected = V3HubRelayResponseError::UnsupportedStatus {
            status: "typed-registry-error".to_string(),
        };
        let error = compile_v3_hub_relay_response_hooks()
            .govern(
                resp02(json!({
                    "id": "resp_registry_error",
                    "status": "typed-registry-error",
                    "output": []
                })),
                &V3HubRelayResponseHookProfile::empty(),
            )
            .expect_err("typed governance failure must remain an error");

        assert_eq!(error, expected);
    }

    fn assert_sdk_payload(
        input: V3HubRespInbound02Normalized,
        _: &V3HubRelayResponseHookProfile,
    ) -> Result<V3HubRespChatProcess03Outcome, V3HubRelayResponseError> {
        assert_eq!(input.provider_payload().as_ref()["id"], "sdk-input-truth");
        Err(V3HubRelayResponseError::UnsupportedStatus {
            status: "sdk-input-observed".to_string(),
        })
    }

    #[test]
    fn canonical_govern_operator_consumes_sdk_input_not_captured_payload() {
        let side_output = Arc::new(Mutex::new(None));
        let operator = GovernChatResponseOperator::new(
            resp02(json!({
                "id": "captured-payload-must-not-run",
                "status": "completed",
                "output": []
            })),
            &V3HubRelayResponseHookProfile::empty(),
            assert_sdk_payload,
            side_output.clone(),
        );
        let context = OperatorContext {
            identity: pipeline_runtime::Identity {
                project_id: "routecodex-v3".to_string(),
                graph_id: "registry-test".to_string(),
                graph_version: "1".to_string(),
                execution_id: "sdk-input-test".to_string(),
                attempt_id: "client-entry".to_string(),
            },
            node_id: "govern_chat_response".to_string(),
        };

        let error = operator
            .execute(
                json!({
                    "id": "sdk-input-truth",
                    "status": "completed",
                    "output": []
                }),
                &context,
            )
            .expect_err("typed governance failure must not return empty business success");

        assert_eq!(
            error,
            "unsupported provider response status: sdk-input-observed"
        );
        let captured = side_output.lock().expect("side-output must lock");
        match captured.as_ref() {
            Some(GovernedResponseSideOutput::Error(
                V3HubRelayResponseError::UnsupportedStatus { status },
            )) => assert_eq!(status, "sdk-input-observed"),
            other => panic!("expected typed governance error sidecar, found {other:?}"),
        }
    }

    fn typed_success_from_sdk_input(
        mut input: V3HubRespInbound02Normalized,
        _: &V3HubRelayResponseHookProfile,
    ) -> Result<V3HubRespChatProcess03Outcome, V3HubRelayResponseError> {
        assert_eq!(input.provider_payload().as_ref()["id"], "sdk-input-truth");
        let mut payload = input.provider_payload().as_ref().clone();
        payload["transformed_by"] = json!("sdk-output");
        *input.provider_payload_mut() = Arc::new(payload);
        Ok(V3HubRespChatProcess03Outcome {
            data: V3HubRespChatProcess03Governed {
                previous: input,
                terminality: V3HubResponseTerminality::Terminal,
                tool_calls: Vec::new(),
            },
        })
    }

    #[test]
    fn canonical_govern_operator_uses_sdk_output_as_business_payload() {
        let side_output = Arc::new(Mutex::new(None));
        let operator = GovernChatResponseOperator::new(
            resp02(json!({
                "id": "captured-payload-must-not-run",
                "status": "completed",
                "output": []
            })),
            &V3HubRelayResponseHookProfile::empty(),
            typed_success_from_sdk_input,
            side_output.clone(),
        );
        let context = OperatorContext {
            identity: pipeline_runtime::Identity {
                project_id: "routecodex-v3".to_string(),
                graph_id: "registry-test".to_string(),
                graph_version: "1".to_string(),
                execution_id: "sdk-output-test".to_string(),
                attempt_id: "client-entry".to_string(),
            },
            node_id: "govern_chat_response".to_string(),
        };

        let output = operator
            .execute(
                json!({
                    "id": "sdk-input-truth",
                    "status": "completed",
                    "output": []
                }),
                &context,
            )
            .expect("successful typed governance must complete the SDK node");

        assert_eq!(output["id"], "sdk-input-truth");
        assert_eq!(output["transformed_by"], "sdk-output");
        assert!(!output
            .as_object()
            .expect("output must be an object")
            .is_empty());
        let captured = side_output.lock().expect("side-output must lock");
        assert!(matches!(
            captured.as_ref(),
            Some(GovernedResponseSideOutput::Complete(outcome))
                if outcome.finalized_payload()["transformed_by"] == "sdk-output"
        ));
    }

    #[test]
    fn govern_execution_preserves_runner_error_when_no_typed_error_was_captured() {
        let runner_error = OperationRunnerError {
            message: "runner failed before operator execution".to_string(),
        };
        let error = resolve_governed_response_execution(Err(runner_error), None)
            .expect_err("runner failure must remain an error");

        assert_eq!(
            error,
            V3HubRelayResponseError::ProviderCompatFailed {
                reason:
                    "canonical response governance failed: runner failed before operator execution"
                        .to_string(),
            }
        );
    }
}
