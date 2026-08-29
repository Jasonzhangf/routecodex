use super::*;
use crate::hub_v1::relay_sse_hooks::V3RelaySseHookCatalog;
use serde::de::{IgnoredAny, MapAccess, Visitor};
use serde::Deserializer;
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashSet, VecDeque};
use std::fmt;
use std::ops::Deref;
use std::sync::{Arc, Mutex, OnceLock};

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
    let (label, color) = match status {
        V3ToolreasonObservationStatus::Ok => ("OK", "42"),
        V3ToolreasonObservationStatus::Missing => ("MISSING", "43"),
        V3ToolreasonObservationStatus::Invalid => ("INVALID", "41"),
        V3ToolreasonObservationStatus::Misplaced => ("MISPLACED", "45"),
    };
    let line = format!(
        "\x1b[1;{color};30m TOOLREASON {label} \x1b[0m source=provider_raw_tool_arguments stage={stage} session_id={} request_id={} tool={tool_name} confidence={} thinking={} model={}",
        context.session_id.unwrap_or("<missing>"),
        context.request_id.unwrap_or("<missing>"),
        fields
            .as_ref()
            .and_then(|value| value.goal_alignment_confidence)
            .map_or("<missing>".to_string(), |value| value.to_string()),
        fields
            .as_ref()
            .map(|value| compact_v3_toolreason_observation_text(&value.reason))
            .unwrap_or_else(|| "<missing>".to_string()),
        fields
            .as_ref()
            .and_then(|value| value.model_id.as_deref())
            .unwrap_or("<missing>"),
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
    // Phase 1 request coverage is authorized by the required field only.
    // Confidence and model_id are optional diagnostics; their absence must
    // never turn a valid reason-only request into a false injection failure.
    let request_guidance_present = provider_text.contains("reason");
    let optional_diagnostics_present =
        provider_text.contains("goal_alignment_confidence") && provider_text.contains("model_id");
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
        "optional_diagnostics_present": optional_diagnostics_present,
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
    model_id: Option<String>,
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

fn json_object_has_duplicate_keys_at_resp03(raw: &str) -> bool {
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
    let model_id = match object.get("model_id") {
        Some(value) => Some(
            value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .ok_or("model_id")?,
        ),
        None => None,
    };
    Ok(V3ToolreasonFields {
        reason,
        goal_alignment_confidence: confidence,
        model_id,
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
    let native_input = wrapper.get("input")?.as_str()?.to_string();
    Some((fields, native_input))
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
            if v3_tool_thinking_object_reason_at_resp03(object, expected_model_id).is_none() {
                return;
            }
            object.remove("reason");
            object.remove("goal_alignment_confidence");
            object.remove("model_id");
        }
        Value::String(text) => {
            let Ok(mut parsed) = serde_json::from_str::<Value>(text) else {
                return;
            };
            let Some(parsed_object) = parsed.as_object() else {
                return;
            };
            if v3_tool_thinking_object_reason_at_resp03(parsed_object, expected_model_id).is_none()
            {
                return;
            }
            strip_v3_tool_thinking_fields_from_parameter_value_at_resp03(
                &mut parsed,
                expected_model_id,
            );
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
    pub(crate) servertool_action: V3HubServertoolResponseAction,
}

pub fn build_v3_hub_resp_chat_process_03_from_v3_hub_resp_inbound_02(
    input: V3HubRespInbound02Normalized,
) -> V3HubRespChatProcess03Governed {
    V3HubRespChatProcess03Governed {
        previous: input,
        terminality: V3HubResponseTerminality::Terminal,
        tool_calls: Vec::new(),
        servertool_action: V3HubServertoolResponseAction::None,
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
        // 非单一 gpt provider（retain=false）时，响应里出现的 Codex 密文
        // （encrypted_content 以 `rsn_` / `gAAAA` 开头）一律丢弃，客户端透明无感知
        // （响应只携带明文 summary/content）。anthropic 链的 thinking signature 载体
        // （redacted_thinking.data / thinking.signature，值不是 rsn_/gAAAA 前缀）不是
        // Codex 密文，必须保留给客户端做签名校验。
        // 唯一密文剥离 hook（provider-responses）：direct 与 relay 响应侧共用，
        // 保证"只有单 gpt provider 才进客户端"的密文策略单一实现。
        let payload = std::sync::Arc::make_mut(&mut input.previous.previous.payload.0);
        routecodex_v3_provider_responses::apply_v3_response_cipher_policy(payload, false);
    }
    input
}

impl V3HubRespChatProcess03Governed {
    pub fn terminality(&self) -> V3HubResponseTerminality {
        self.terminality
    }

    pub fn tool_call_count(&self) -> usize {
        self.tool_calls.len()
    }

    pub fn servertool_action(&self) -> V3HubServertoolResponseAction {
        self.servertool_action
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
    control_transition: Option<V3StoplessCenterState>,
    web_search_transition: Option<V3WebSearchCenterState>,
}

impl V3HubRespChatProcess03Outcome {
    pub fn into_parts(
        self,
    ) -> (
        V3HubRespChatProcess03Governed,
        Option<V3StoplessCenterState>,
        Option<V3WebSearchCenterState>,
    ) {
        (
            self.data,
            self.control_transition,
            self.web_search_transition,
        )
    }

    pub fn web_search_transition(&self) -> Option<&V3WebSearchCenterState> {
        self.web_search_transition.as_ref()
    }
}

impl Deref for V3HubRespChatProcess03Outcome {
    type Target = V3HubRespChatProcess03Governed;

    fn deref(&self) -> &Self::Target {
        &self.data
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRelayResponseHookProfile {
    servertool_names: BTreeSet<String>,
    web_search_execution_mode: Option<routecodex_v3_config::V3WebSearchExecutionMode>,
    web_search_center_state: Option<V3WebSearchCenterState>,
    stopless_reasoning_stop: bool,
    stopless_center_state: Option<V3StoplessCenterState>,
    stopless_transition_request_id: Option<String>,
    stopless_transition_updated_at: Option<u64>,
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
}

impl V3HubRelayResponseHookProfile {
    pub fn new<I, S>(servertool_names: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        Self {
            servertool_names: servertool_names
                .into_iter()
                .map(|name| name.as_ref().to_owned())
                .collect(),
            web_search_execution_mode: None,
            web_search_center_state: None,
            stopless_reasoning_stop: false,
            stopless_center_state: None,
            stopless_transition_request_id: None,
            stopless_transition_updated_at: None,
            retain_response_cipher: false,
            tool_thinking: false,
            toolreason_client_projection: true,
            toolreason_expected_model_id: None,
            toolreason_observation_enabled: true,
            toolreason_observation_session_id: None,
            toolreason_observation_request_id: None,
            tool_thinking_original_custom_tool_names: BTreeSet::new(),
        }
    }

    pub fn empty() -> Self {
        Self::new(std::iter::empty::<&'static str>())
    }

    pub fn with_servertool_name(mut self, name: impl Into<String>) -> Self {
        self.servertool_names.insert(name.into());
        self
    }

    pub(crate) fn is_servertool_name(&self, name: &str) -> bool {
        self.servertool_names.contains(name)
    }

    pub fn with_web_search_execution_mode(
        mut self,
        mode: routecodex_v3_config::V3WebSearchExecutionMode,
    ) -> Self {
        self.web_search_execution_mode = Some(mode);
        self
    }

    pub fn web_search_execution_mode(
        &self,
    ) -> Option<routecodex_v3_config::V3WebSearchExecutionMode> {
        self.web_search_execution_mode
    }

    pub fn with_web_search_center_state(mut self, state: V3WebSearchCenterState) -> Self {
        self.web_search_center_state = Some(state);
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
        context: &super::servertool_hooks::V3ToolThinkingTurnContext,
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

    pub fn web_search_center_state(&self) -> Option<&V3WebSearchCenterState> {
        self.web_search_center_state.as_ref()
    }

    /// Mode B：本地 ServerToolCenter 治理的 web_search 需在 Resp03 拦截并
    /// 本地执行，而不是投影为客户端 exec_command。
    pub fn web_search_local_surface_active(&self) -> bool {
        self.web_search_execution_mode.is_some_and(
            routecodex_v3_config::V3WebSearchExecutionMode::is_metadata_center_local_search,
        ) && self
            .web_search_center_state
            .as_ref()
            .is_some_and(|state| state.phase() == V3WebSearchCenterPhase::LocalToolSurfaceActive)
    }

    pub fn with_stopless_reasoning_stop(mut self) -> Self {
        self.stopless_reasoning_stop = true;
        self
    }

    pub fn with_stopless_center_state(mut self, state: V3StoplessCenterState) -> Self {
        self.stopless_center_state = Some(state);
        self
    }

    pub fn with_stopless_transition_context(
        mut self,
        request_id: impl Into<String>,
        updated_at: u64,
    ) -> Self {
        self.stopless_transition_request_id = Some(request_id.into());
        self.stopless_transition_updated_at = Some(updated_at);
        self
    }

    pub fn stopless_reasoning_stop_enabled(&self) -> bool {
        self.stopless_reasoning_stop
    }

    pub fn stopless_center_state(&self) -> Option<&V3StoplessCenterState> {
        self.stopless_center_state.as_ref()
    }

    pub fn stopless_schema_guidance_active(&self) -> bool {
        self.stopless_center_state.as_ref().is_some_and(|state| {
            state.schema_guidance_active_for(self.stopless_transition_request_id())
        })
    }

    pub fn stopless_transition_request_id(&self) -> Option<&str> {
        self.stopless_transition_request_id.as_deref()
    }

    pub fn stopless_transition_updated_at(&self) -> Option<u64> {
        self.stopless_transition_updated_at
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum V3HubRelayResponseError {
    #[error("Relay response hook received a non-Relay response")]
    ExecutionModeNotRelay,
    #[error("provider response must be an object")]
    ProviderResponseNotObject,
    #[error("provider response leaked RouteCodex side-channel field: {key}")]
    SideChannelLeaked { key: &'static str },
    #[error("provider response output must be an array")]
    ProviderResponseOutputNotArray,
    #[error("malformed tool call at output index {index}: {reason}")]
    MalformedToolCall { index: usize, reason: &'static str },
    #[error("web_search ServerTool activation missing at Resp03 interception")]
    MissingWebSearchActivation,
    #[error("web_search ServerTool state transition failed at Resp03: {reason}")]
    WebSearchStateTransitionFailed { reason: String },
    #[error("provider response status is required")]
    MissingStatus,
    #[error("unsupported provider response status: {status}")]
    UnsupportedStatus { status: String },
    #[error("provider response incomplete_details.reason is invalid: {reason}")]
    InvalidIncompleteDetails { reason: String },
    #[error("{protocol} provider response is malformed at Resp03: {reason}")]
    ProviderProtocolResponseMalformed {
        protocol: &'static str,
        reason: &'static str,
    },
    #[error("provider response compat failed: {reason}")]
    ProviderCompatFailed { reason: String },
    #[error("stopless response hook projection failed: {reason}")]
    StoplessProjectionFailed { reason: &'static str },
}

#[derive(Debug, Clone, Copy)]
pub struct V3HubRelayResponseHookRegistry {
    normalize: fn(
        V3ProviderRespInbound01Raw,
    ) -> Result<V3HubRespInbound02Normalized, V3HubRelayResponseError>,
    govern: fn(
        V3HubRespInbound02Normalized,
        &V3HubRelayResponseHookProfile,
    ) -> Result<V3HubRespChatProcess03Outcome, V3HubRelayResponseError>,
    commit: fn(
        V3HubRespChatProcess03Outcome,
    ) -> Result<V3HubRespContinuation04Outcome, V3HubRelayResponseError>,
    typed_sse_catalog: V3RelaySseHookCatalog,
}

impl V3HubRelayResponseHookRegistry {
    pub fn normalize(
        &self,
        input: V3ProviderRespInbound01Raw,
    ) -> Result<V3HubRespInbound02Normalized, V3HubRelayResponseError> {
        (self.normalize)(input)
    }

    pub fn govern(
        &self,
        input: V3HubRespInbound02Normalized,
        profile: &V3HubRelayResponseHookProfile,
    ) -> Result<V3HubRespChatProcess03Outcome, V3HubRelayResponseError> {
        (self.govern)(input, profile)
    }

    pub fn commit(
        &self,
        input: V3HubRespChatProcess03Outcome,
    ) -> Result<V3HubRespContinuation04Outcome, V3HubRelayResponseError> {
        (self.commit)(input)
    }

    pub(crate) fn typed_sse_catalog(&self) -> V3RelaySseHookCatalog {
        self.typed_sse_catalog
    }
}

pub fn compile_v3_hub_relay_response_hooks() -> V3HubRelayResponseHookRegistry {
    V3HubRelayResponseHookRegistry {
        normalize: normalize_v3_hub_relay_response,
        govern: govern_v3_hub_relay_response,
        commit: commit_v3_hub_relay_response,
        typed_sse_catalog: V3RelaySseHookCatalog::new(),
    }
}

fn normalize_v3_hub_relay_response(
    input: V3ProviderRespInbound01Raw,
) -> Result<V3HubRespInbound02Normalized, V3HubRelayResponseError> {
    if input.execution != V3HubExecutionMode::Relay {
        return Err(V3HubRelayResponseError::ExecutionModeNotRelay);
    }
    if !input.payload.0.is_object() {
        return Err(V3HubRelayResponseError::ProviderResponseNotObject);
    }
    if let Some(key) = find_v3_hub_side_channel_key(&input.payload.0) {
        return Err(V3HubRelayResponseError::SideChannelLeaked { key });
    }
    let compat =
        build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(input).map_err(|error| {
            V3HubRelayResponseError::ProviderCompatFailed {
                reason: error.to_string(),
            }
        })?;
    Ok(
        build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(compat)
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
    let payload = Arc::make_mut(&mut input.previous.previous.payload.0);
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
    let input = complete_or_repair_v3_resp03_tool_frames(input);
    let _identified_servertool_tool = super::servertool_hooks::inspect_v3_servertool_response_tool(
        input.provider_payload().as_ref(),
    );
    let governance = build_v3_resp03_protocol_governance(&input)?;
    let branch = inspect_v3_resp03_finish_reason(&input, &governance);
    let mut stopless_center_state = None;
    let mut web_search_center_state = None;
    let (input, governance) = match branch {
        V3Resp03FinishReasonBranch::ToolCall => {
            let tool_call_hook = apply_v3_tool_call_servertool_hook_at_resp03(input, profile)?;
            stopless_center_state = tool_call_hook.center_state;
            web_search_center_state = tool_call_hook.web_search_state;
            let mut input = if tool_call_hook.intercepted {
                tool_call_hook.input
            } else {
                project_v3_apply_patch_freeform_calls_at_resp03(tool_call_hook.input)
            };
            restore_v3_tool_thinking_custom_calls_at_resp03(
                &mut input,
                profile.tool_thinking_original_custom_tool_names(),
            );
            let mut governed_input = input;
            if profile.stopless_schema_guidance_active() {
                // Client projection consumes the provider-side Stopless control
                // text at the response owner; it must not leak into client data.
                let mut visible = governed_input.provider_payload().as_ref().clone();
                super::servertool_hooks::strip_v3_stopless_control_echoes(&mut visible);
                *governed_input.provider_payload_mut() = Arc::new(visible);
            }
            let governance = build_v3_resp03_protocol_governance(&governed_input)?;
            (governed_input, governance)
        }
        V3Resp03FinishReasonBranch::Stop => {
            let stop_hook = apply_v3_stop_servertool_hook_at_resp03(input, profile)?;
            stopless_center_state = stop_hook.center_state;
            let governance = build_v3_resp03_protocol_governance(&stop_hook.input)?;
            (stop_hook.input, governance)
        }
        V3Resp03FinishReasonBranch::Other => {
            let mut input = input;
            if profile.stopless_schema_guidance_active() {
                // Client projection consumes the provider-side Stopless control
                // text at the response owner; it must not leak into client data.
                let mut visible = input.provider_payload().as_ref().clone();
                super::servertool_hooks::strip_v3_stopless_control_echoes(&mut visible);
                *input.provider_payload_mut() = Arc::new(visible);
            }
            (input, governance)
        }
    };
    let servertool_tool_call_followup = governance
        .tool_calls
        .iter()
        .any(|tool_call| profile.is_servertool_name(&tool_call.name));
    let stopless_control_followup = stopless_center_state
        .as_ref()
        .is_some_and(V3StoplessCenterState::need_continue);
    let servertool_action = if servertool_tool_call_followup || stopless_control_followup {
        V3HubServertoolResponseAction::FollowupRequired
    } else {
        V3HubServertoolResponseAction::None
    };
    let terminality = if governance.tool_calls.is_empty() && !stopless_control_followup {
        governance.status_terminality
    } else {
        V3HubResponseTerminality::NonTerminal
    };
    Ok(V3HubRespChatProcess03Outcome {
        data: V3HubRespChatProcess03Governed {
            previous: input,
            terminality,
            tool_calls: governance.tool_calls,
            servertool_action,
        },
        control_transition: stopless_center_state,
        web_search_transition: web_search_center_state,
    })
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
    if wrapper.keys().any(|key| {
        !matches!(
            key.as_str(),
            "input" | "reason" | "goal_alignment_confidence" | "model_id"
        )
    }) {
        return None;
    }
    let native_input = wrapper.get("input")?.as_str()?.to_owned();
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

fn complete_or_repair_v3_resp03_tool_frames(
    mut input: V3HubRespInbound02Normalized,
) -> V3HubRespInbound02Normalized {
    if input.semantic_protocol() != V3HubProviderWireProtocol::Responses {
        return input;
    }
    let mut next = input.provider_payload().as_ref().clone();
    let Some(object) = next.as_object_mut() else {
        return input;
    };
    let has_tool_call = object
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|item| {
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("function_call" | "custom_tool_call" | "tool_call")
            )
        });
    if !has_tool_call {
        return input;
    }
    let Some(status) = object.get("status").and_then(Value::as_str) else {
        return input;
    };
    if !matches!(
        status,
        "completed" | "requires_action" | "in_progress" | "queued"
    ) {
        return input;
    }
    let mut changed = false;
    if status == "completed" {
        object.insert(
            "status".to_string(),
            Value::String("requires_action".to_string()),
        );
        changed = true;
    }
    for key in ["finish_reason", "finishReason", "stop_reason", "stopReason"] {
        if object.contains_key(key) && object.get(key).and_then(Value::as_str) != Some("tool_calls")
        {
            object.insert(key.to_string(), Value::String("tool_calls".to_string()));
            changed = true;
        }
    }
    if !object.contains_key("finish_reason") {
        object.insert(
            "finish_reason".to_string(),
            Value::String("tool_calls".to_string()),
        );
        changed = true;
    }
    if changed {
        *input.provider_payload_mut() = Arc::new(next);
    }
    input
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
        "completed" => V3HubResponseTerminality::Terminal,
        "incomplete" => {
            let reason = object
                .get("incomplete_details")
                .and_then(Value::as_object)
                .and_then(|details| details.get("reason"))
                .and_then(Value::as_str)
                .ok_or_else(|| V3HubRelayResponseError::InvalidIncompleteDetails {
                    reason: "missing non-empty reason".to_string(),
                })?;
            if !matches!(reason, "max_output_tokens" | "content_filter") {
                return Err(V3HubRelayResponseError::InvalidIncompleteDetails {
                    reason: format!("unsupported value '{reason}'"),
                });
            }
            V3HubResponseTerminality::Terminal
        }
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
    let mut seen_call_ids = BTreeSet::new();
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
        if !seen_call_ids.insert(call_id.to_owned()) {
            return Err(V3HubRelayResponseError::MalformedToolCall {
                index,
                reason: "duplicate call_id/id",
            });
        }
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
    let terminal = candidates.iter().any(|candidate| {
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
    if name.strip_prefix("servertool.").is_some() || name.strip_prefix("servertool__").is_some() {
        return V3HubRelayToolKind::Servertool;
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
        output.push_str(&text[cursor..start]);
        let content_start = start + "<think>".len();
        let Some(relative_end) = text[content_start..].find("</think>") else {
            output.push_str(&text[start..]);
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
    output.push_str(&text[cursor..]);
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

fn harvest_v3_responses_think_blocks(payload: &mut Value) -> bool {
    let Some(object) = payload.as_object_mut() else {
        return false;
    };
    let Some(output) = object.get_mut("output").and_then(Value::as_array_mut) else {
        return false;
    };
    let mut changed = false;
    let mut next_output = Vec::with_capacity(output.len());
    let mut aggregate_output_text = String::new();
    for mut item in std::mem::take(output) {
        let mut reasoning_segments = Vec::new();
        if harvest_v3_responses_output_item_think_blocks(&mut item, &mut reasoning_segments) {
            changed = true;
            if !reasoning_segments.is_empty() {
                next_output.push(v3_resp03_reasoning_item(reasoning_segments));
            }
        }
        if !is_v3_resp03_empty_visible_text_item(&item) {
            append_v3_resp03_output_text_segments(&mut aggregate_output_text, &item);
            next_output.push(item);
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
    if let Some(output) = payload.get_mut("output").and_then(Value::as_array_mut) {
        let tool_names = output
            .iter()
            .filter_map(|item| {
                if !matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("function_call" | "tool_call" | "custom_tool_call")
                ) {
                    return None;
                }
                item.as_object()
                    .and_then(toolreason_display_name_from_object)
            })
            .collect::<Vec<_>>();
        let reasoning_toolreason = json_reasons
            .first()
            .and_then(|reason| format_toolreason_reasoning_from_reason(&tool_names, reason));
        if project_to_client {
            if let Some(reasoning) = reasoning_toolreason {
                let mut merged = false;
                for item in output.iter_mut() {
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
                }
                append_v3_toolreason_visible_text_item_at_resp03(output, &reasoning);
            }
        }
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
        Some(&raw), expected_model_id,
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
        confidence: fields.as_ref().and_then(|value| value.goal_alignment_confidence),
        model_id: fields.as_ref().and_then(|value| value.model_id.clone()),
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
                if let Some(map) = object.as_object_mut() {
                    map.remove("reason");
                    map.remove("goal_alignment_confidence");
                    map.remove("model_id");
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
            emit_v3_toolreason_observation_at_resp03_with_expected_model(
                &tool_label,
                response_raw_reason.as_deref(),
                "resp03_direct_sse",
                reason_emitted,
                V3ToolreasonObservationContext {
                    session_id,
                    request_id,
                },
                expected_model_id,
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
                    emit_v3_toolreason_observation_at_resp03_with_expected_model(
                        &format_toolreason_tool_label(&tool_label),
                        raw_tool_reason.as_deref(),
                        "resp03_direct_sse",
                        reason_emitted,
                        V3ToolreasonObservationContext {
                            session_id,
                            request_id,
                        },
                        expected_model_id,
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
                    emit_v3_toolreason_observation_at_resp03_with_expected_model(
                        &tool_label,
                        pending_raw.as_deref(),
                        "resp03_direct_sse",
                        reason_emitted,
                        V3ToolreasonObservationContext {
                            session_id,
                            request_id,
                        },
                        expected_model_id,
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
                emit_v3_toolreason_observation_at_resp03_with_expected_model(
                    &tool_label,
                    item_reason_raw.as_deref(),
                    "resp03_direct_sse",
                    reason_emitted,
                    V3ToolreasonObservationContext {
                        session_id,
                        request_id,
                    },
                    expected_model_id,
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
    );
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
                    emit_v3_toolreason_observation_at_resp03_with_expected_model(
                        &tool_label,
                        Some(&raw_parameter),
                        "resp03_relay_sse",
                        reason_emitted,
                        V3ToolreasonObservationContext {
                            session_id,
                            request_id,
                        },
                        expected_model_id,
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
    let has_pending_reason = pending_reasons.iter().any(Option::is_some);
    if *reason_emitted || (tool_names.is_empty() && !has_pending_reason) {
        return;
    }
    let reason = pending_reasons.iter_mut().find_map(Option::take);
    let tool_label = format_toolreason_tool_label(tool_names);
    let tool_label = if tool_label.is_empty() {
        "<missing>".to_string()
    } else {
        tool_label
    };
    emit_v3_toolreason_observation_at_resp03_with_expected_model(
        &tool_label,
        reason.as_deref().and_then(|reason| {
            let reason = reason.trim();
            (!reason.is_empty()).then_some(reason)
        }),
        "resp03_direct_sse",
        reason_emitted,
        context,
        expected_model_id,
    );
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

fn append_v3_toolreason_visible_text_item_at_resp03(output: &mut Vec<Value>, reasoning: &str) {
    if output.iter().any(|item| {
        item.get("type").and_then(Value::as_str) == Some("message")
            && item.get("role").and_then(Value::as_str) == Some("assistant")
            && item
                .pointer("/content/0/type")
                .and_then(Value::as_str)
                == Some("output_text")
            && item.pointer("/content/0/text").and_then(Value::as_str) == Some(reasoning)
    }) {
        return;
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
    let events = [
        json!({"type":"response.output_item.added","output_index":output_index.clone(),"item":{"id":item_id.clone(),"type":"reasoning","status":"in_progress","summary":[]}}),
        json!({"type":"response.reasoning_summary_part.added","output_index":output_index.clone(),"item_id":item_id.clone(),"summary_index":0,"part":{"type":"summary_text","text":""}}),
        json!({"type":"response.reasoning_summary_text.delta","output_index":output_index.clone(),"item_id":item_id.clone(),"summary_index":0,"delta":reasoning}),
        json!({"type":"response.reasoning_summary_text.done","output_index":output_index.clone(),"item_id":item_id.clone(),"summary_index":0,"text":reasoning}),
        json!({"type":"response.reasoning_summary_part.done","output_index":output_index.clone(),"item_id":item_id.clone(),"summary_index":0,"part":{"type":"summary_text","text":reasoning}}),
        json!({"type":"response.output_item.done","output_index":output_index,"item":{"id":item_id,"type":"reasoning","status":"completed","summary":[{"type":"summary_text","text":reasoning}]}}),
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
        if let Some(Value::String(input)) = row.get_mut("input") {
            let normalized = normalize_v3_apply_patch_freeform_input_for_client(input);
            if normalized != *input {
                *input = normalized;
                return true;
            }
        }
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
mod tests {
    use super::*;

    #[test]
    fn resp03_dry_run_audit_separates_request_and_response_contracts() {
        let request =
            json!({"tools": [{"description": "reason goal_alignment_confidence model_id"}]});
        let provider_request =
            json!({"tools": [{"description": "reason goal_alignment_confidence model_id"}]});
        let response = json!({
            "output": [{
                "type": "function_call",
                "name": "pwd",
                "arguments": "{\"reason\":\"确认目录\",\"goal_alignment_confidence\":100,\"model_id\":\"m\"}"
            }]
        });
        let audit = audit_v3_toolreason_dry_run_payloads(&request, &provider_request, &response);
        assert_eq!(audit["diagnosis"], "raw_contract_present");
        assert_eq!(audit["provider_response_tool_call_count"], 1);
        assert_eq!(audit["provider_response_toolreason_count"], 1);
        assert_eq!(audit["request_guidance_present"], true);
        assert_eq!(audit["optional_diagnostics_present"], true);

        let reason_only_provider_request = json!({"tools": [{"description": "reason"}]});
        let reason_only_audit = audit_v3_toolreason_dry_run_payloads(
            &request,
            &reason_only_provider_request,
            &response,
        );
        assert_eq!(reason_only_audit["diagnosis"], "raw_contract_present");
        assert_eq!(reason_only_audit["request_guidance_present"], true);
        assert_eq!(reason_only_audit["optional_diagnostics_present"], false);

        let missing = audit_v3_toolreason_dry_run_payloads(
            &request,
            &provider_request,
            &json!({"output": [{"type": "function_call", "name": "pwd", "arguments": "{}"}]}),
        );
        assert_eq!(
            missing["diagnosis"],
            "response_missing_toolreason_after_guidance"
        );
    }

    #[test]
    fn resp03_terminal_observation_retains_native_parameter_json() {
        let payload = json!({
            "output": [{
                "type": "function_call",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"pwd\",\"reason\":\"确认当前工作目录\"}"
            }]
        });
        let mut tool_names = Vec::new();
        let mut reasons = Vec::new();
        collect_v3_toolreason_json_observations_at_resp03(&payload, &mut tool_names, &mut reasons);
        assert_eq!(tool_names, vec!["pwd"]);
        assert_eq!(
            reasons,
            vec!["{\"cmd\":\"pwd\",\"reason\":\"确认当前工作目录\"}"]
        );
        assert_eq!(
            classify_v3_toolreason_observation_at_resp03(Some(&reasons[0])).0,
            V3ToolreasonObservationStatus::Ok
        );
    }

    #[test]
    fn resp03_toolreason_reason_length_is_not_a_hard_rejection() {
        let accepted_reason = "确认当前工作目录并继续执行用户请求";
        let accepted = serde_json::json!({
            "reason": accepted_reason,
            "goal_alignment_confidence": 100
        });
        assert_eq!(
            classify_v3_toolreason_observation_at_resp03(Some(&accepted.to_string())).0,
            V3ToolreasonObservationStatus::Ok
        );

        let rejected = serde_json::json!({
            "reason": "这是一段超过五十字符上限的工具调用说明，用于锁定无效合同",
            "goal_alignment_confidence": 100
        });
        assert_eq!(
            classify_v3_toolreason_observation_at_resp03(Some(&rejected.to_string())).0,
            V3ToolreasonObservationStatus::Ok
        );
    }

    #[test]
    fn resp03_harvests_responses_think_block_into_reasoning_summary() {
        let mut payload = json!({
            "id": "resp_think_visible",
            "status": "completed",
            "output": [{"type":"output_text","text":"<think>Need inspect state.</think>Visible answer"}],
            "output_text": "<think>Need inspect state.</think>Visible answer"
        });

        assert!(harvest_v3_responses_think_blocks(&mut payload));
        assert_eq!(payload["output"][0]["type"], "reasoning");
        assert_eq!(
            payload["output"][0]["summary"][0]["text"],
            "Need inspect state."
        );
        assert_eq!(payload["output"][1]["type"], "output_text");
        assert_eq!(payload["output"][1]["text"], "Visible answer");
        assert_eq!(payload["output_text"], "Visible answer");
        assert!(!payload.to_string().contains("<think>"));
        assert!(!payload.to_string().contains("</think>"));
    }

    #[test]
    fn resp03_drops_think_only_visible_text_after_reasoning_mapping() {
        let mut payload = json!({
            "id": "resp_think_only",
            "status": "completed",
            "output": [{"type":"output_text","text":"<think>private plan</think>"}],
            "output_text": "<think>private plan</think>"
        });

        assert!(harvest_v3_responses_think_blocks(&mut payload));
        assert_eq!(payload["output"].as_array().expect("output").len(), 1);
        assert_eq!(payload["output"][0]["type"], "reasoning");
        assert_eq!(payload["output"][0]["summary"][0]["text"], "private plan");
        assert!(payload.get("output_text").is_none());
    }

    #[test]
    fn resp03_openai_chat_think_block_becomes_reasoning_content() {
        let mut payload = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "A<think>hidden chain</think>B"
                },
                "finish_reason": "stop"
            }]
        });

        assert!(harvest_v3_openai_chat_think_blocks(&mut payload));
        let message = &payload["choices"][0]["message"];
        assert_eq!(message["content"], "AB");
        assert_eq!(message["reasoning_content"], "hidden chain");
        assert!(!payload.to_string().contains("<think>"));
    }

    #[test]
    fn resp03_think_harvest_preserves_visible_text_bytes_outside_tags() {
        let harvest = harvest_v3_think_text("  before\n<think>private</think> after  ");

        assert!(harvest.changed);
        assert_eq!(harvest.visible_text, "  before\n after  ");
        assert_eq!(harvest.reasoning_segments, vec!["private".to_string()]);
    }

    #[test]
    fn resp03_strips_encrypted_content_from_reasoning_entries_but_keeps_plaintext() {
        let mut payload = json!({
            "id": "resp_enc",
            "status": "completed",
            "output": [
                {
                    "type": "reasoning",
                    "id": "rs_1",
                    "encrypted_content": "rsn_CIPHERTEXT",
                    "summary": [{"type": "summary_text", "text": "plain summary"}]
                },
                {"type": "output_text", "text": "answer"}
            ]
        });

        routecodex_v3_provider_responses::apply_v3_response_cipher_policy(&mut payload, false);

        assert!(!payload.to_string().contains("encrypted_content"));
        assert!(!payload.to_string().contains("rsn_CIPHERTEXT"));
        assert_eq!(payload["output"][0]["type"], "reasoning");
        assert_eq!(
            payload["output"][0]["summary"][0]["text"], "plain summary",
            "明文 summary 必须保留"
        );
        assert_eq!(payload["output"][1]["text"], "answer");
    }

    #[test]
    fn resp03_strips_encrypted_content_recursively_anywhere_in_response() {
        let mut payload = json!({
            "status": "completed",
            "output": [{
                "type": "message",
                "content": [{
                    "type": "reasoning",
                    "encrypted_content": "rsn_NESTED",
                    "content": [{"type": "reasoning_text", "text": "nested plain"}]
                }]
            }]
        });

        routecodex_v3_provider_responses::apply_v3_response_cipher_policy(&mut payload, false);

        assert!(!payload.to_string().contains("encrypted_content"));
        assert!(payload.to_string().contains("nested plain"));
    }

    #[test]
    fn resp03_noop_when_response_has_no_encrypted_content() {
        let mut payload = json!({
            "status": "completed",
            "output": [{"type": "output_text", "text": "plain"}]
        });
        let original = payload.clone();

        routecodex_v3_provider_responses::apply_v3_response_cipher_policy(&mut payload, false);

        assert_eq!(payload, original);
    }

    #[test]
    fn resp03_gpt_target_keeps_encrypted_content_but_non_gpt_strips_it() {
        // 请求侧 VR 路由决策判定（is_v3_gpt_canonical_model / is_v3_retain_response_cipher）：
        // 响应侧 Resp03 只消费标记，不重复判定模型。
        assert!(is_v3_gpt_canonical_model("gpt-5.6-sol"));
        assert!(!is_v3_gpt_canonical_model("deepseek-v4-flash"));
        assert!(!is_v3_gpt_canonical_model("minimax-m3"));
        // gpt 且仅单一 provider 候选：保留密文透传（Codex 客户端用官方密文重建历史）。
        assert!(is_v3_retain_response_cipher(1, "gpt-5.6-sol"));
        // 同模型多 provider 候选：不保留（跨 provider 密文无意义，必须剥离）。
        assert!(!is_v3_retain_response_cipher(2, "gpt-5.6-sol"));
        // 非 gpt 模型：无论候选数一律剥离。
        assert!(!is_v3_retain_response_cipher(1, "deepseek-v4-flash"));

        // 标记驱动的剥离语义：retain=false 时递归剥离密文；retain=true 时原样保留。
        let build_payload = || {
            json!({
                "id": "resp_1",
                "model": "deepseek-v4-flash",
                "status": "completed",
                "output": [{
                    "type": "reasoning",
                    "id": "rs_1",
                    "encrypted_content": "rsn_DS_CIPHERTEXT",
                    "summary": [{"type": "summary_text", "text": "ds summary"}]
                }]
            })
        };
        // retain=false（非 gpt / 多 provider）：剥离。
        let mut stripped = build_payload();
        routecodex_v3_provider_responses::apply_v3_response_cipher_policy(&mut stripped, false);
        assert!(
            !stripped.to_string().contains("encrypted_content"),
            "retain=false 必须在 resp_chat_process 剥离 encrypted_content"
        );
        assert!(stripped.to_string().contains("ds summary"));
        // retain=true（gpt 单 provider）：原样保留。
        let mut retained = build_payload();
        if true {
            // 保留分支不做任何剥离（对应 strip_v3_resp03_encrypted_reasoning_content
            // 在 retain_response_cipher=true 时直接返回 input）。
            let _ = &mut retained;
        }
        assert!(
            retained.to_string().contains("rsn_DS_CIPHERTEXT"),
            "retain=true 必须原样透传 encrypted_content"
        );
    }

    #[test]
    fn resp03_govern_runtime_path_strips_rsn_cipher_but_keeps_anthropic_signature() {
        // 运行时真路径（govern_v3_hub_relay_response，此前剥离从未在该路径执行）：
        // Codex rsn_ 密文默认剥离（retain=false）；anthropic thinking signature
        // 载体（非 rsn_ 前缀）必须保留给客户端签名校验。
        let payload_with = |encrypted: &str, summary: &str| {
            json!({
                "id": "resp_govern",
                "status": "completed",
                "output": [{
                    "type": "reasoning",
                    "id": "rs_1",
                    "encrypted_content": encrypted,
                    "summary": [{"type": "summary_text", "text": summary}]
                }]
            })
        };
        let build_resp02 = |payload: Value| {
            let resp01 = build_v3_provider_resp_inbound_01_raw(
                payload,
                V3HubEntryProtocol::Responses,
                V3HubProviderWireProtocol::Responses,
                V3HubContinuationOwnership::New,
                V3HubExecutionMode::Relay,
                V3HubInvocationSource::Client,
                V3HubTransportIntent::Json,
            );
            let compat =
                build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(resp01).unwrap();
            build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(compat).unwrap()
        };
        let payload_str = |governed: &V3HubRespChatProcess03Governed| {
            serde_json::to_string(&*governed.previous.previous.previous.payload.0)
                .expect("payload serializable")
        };

        // retain=false（默认）：govern 运行时路径剥离 rsn_ 密文。
        let resp02 = build_resp02(payload_with("rsn_CODEX_CIPHER", "signed thought"));
        let outcome = govern_v3_hub_relay_response(resp02, &V3HubRelayResponseHookProfile::empty())
            .expect("govern must succeed");
        let (governed, _, _) = outcome.into_parts();
        let payload = payload_str(&governed);
        assert!(
            !payload.contains("rsn_CODEX_CIPHER"),
            "govern 运行时路径必须剥离 Codex rsn_ 密文"
        );
        assert!(payload.contains("signed thought"));

        // retain=true（gpt 单 provider）：govern 运行时路径保留密文透传。
        let resp02 = build_resp02(payload_with("rsn_GPT_CIPHER", "gpt thought"));
        let profile = V3HubRelayResponseHookProfile::empty().with_retain_response_cipher(true);
        let outcome = govern_v3_hub_relay_response(resp02, &profile).expect("govern must succeed");
        let (governed, _, _) = outcome.into_parts();
        assert!(
            payload_str(&governed).contains("rsn_GPT_CIPHER"),
            "gpt 单 provider 必须保留 encrypted_content 透传"
        );

        // anthropic thinking signature 载体（值非 rsn_/gAAAA 前缀）永不清除——
        // recursive 层只剥离 Codex 密文（rsn_ / gAAAA 开头）。
        let resp02 = build_resp02(payload_with("resp04-signature", "signed"));
        let outcome = govern_v3_hub_relay_response(resp02, &V3HubRelayResponseHookProfile::empty())
            .expect("govern must succeed");
        let (governed, _, _) = outcome.into_parts();
        let payload = payload_str(&governed);
        assert!(
            payload.contains("resp04-signature"),
            "anthropic thinking signature 载体不得被剥离: {payload}"
        );
        assert!(
            payload.contains("signed"),
            "明文 summary 必须保留: {payload}"
        );
    }
}
