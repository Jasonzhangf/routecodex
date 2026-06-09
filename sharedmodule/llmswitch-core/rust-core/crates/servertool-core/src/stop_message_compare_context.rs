//! Stop-message compare context normalization and progress-log formatting.
//!
//! TS owns only runtime metadata IO; this module owns the context contract.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageCompareContext {
    pub armed: bool,
    pub mode: String,
    pub allow_mode_only: bool,
    pub text_length: i32,
    pub max_repeats: i32,
    pub used: i32,
    pub remaining: i32,
    pub active: bool,
    pub stop_eligible: bool,
    pub has_captured_request: bool,
    pub compaction_request: bool,
    pub has_seed: bool,
    pub decision: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bd_work_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observation_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observation_stable_count: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_signature_hash: Option<String>,
}

pub fn normalize_stop_message_compare_context(
    value: &serde_json::Value,
) -> Option<StopMessageCompareContext> {
    let record = value.as_object()?;
    let decision_raw = read_string(record, "decision")
        .map(|value| value.to_lowercase())
        .unwrap_or_default();
    if decision_raw != "trigger" && decision_raw != "skip" {
        return None;
    }
    let mode_raw = read_string(record, "mode")
        .map(|value| value.to_lowercase())
        .unwrap_or_default();
    let mode = match mode_raw.as_str() {
        "on" | "auto" | "off" => mode_raw,
        _ => "off".to_string(),
    };
    let reason = read_string(record, "reason").unwrap_or_else(|| "unknown".to_string());
    let text_length = read_non_negative_i32(record, "textLength", "text_length").unwrap_or(0);
    let max_repeats = read_non_negative_i32(record, "maxRepeats", "max_repeats").unwrap_or(0);
    let used = read_non_negative_i32(record, "used", "used").unwrap_or(0);
    let remaining = read_non_negative_i32(record, "remaining", "remaining")
        .unwrap_or_else(|| (max_repeats - used).max(0));

    Some(StopMessageCompareContext {
        armed: read_truthy(record, "armed", "armed"),
        mode,
        allow_mode_only: read_truthy(record, "allowModeOnly", "allow_mode_only"),
        text_length,
        max_repeats,
        used,
        remaining,
        active: read_truthy(record, "active", "active"),
        stop_eligible: read_truthy(record, "stopEligible", "stop_eligible"),
        has_captured_request: read_truthy(record, "hasCapturedRequest", "has_captured_request"),
        compaction_request: read_truthy(record, "compactionRequest", "compaction_request"),
        has_seed: read_truthy(record, "hasSeed", "has_seed"),
        decision: decision_raw,
        reason,
        stage: read_string(record, "stage"),
        bd_work_state: read_string(record, "bdWorkState")
            .or_else(|| read_string(record, "bd_work_state")),
        observation_hash: read_string(record, "observationHash")
            .or_else(|| read_string(record, "observation_hash")),
        observation_stable_count: read_non_negative_i32(
            record,
            "observationStableCount",
            "observation_stable_count",
        ),
        tool_signature_hash: read_string(record, "toolSignatureHash")
            .or_else(|| read_string(record, "tool_signature_hash")),
    })
}

pub fn format_stop_message_compare_context(value: Option<&serde_json::Value>) -> String {
    let Some(context) = value.and_then(normalize_stop_message_compare_context) else {
        return "decision=unknown reason=no_context".to_string();
    };
    let mut parts = vec![
        format!("decision={}", context.decision),
        format!("reason={}", context.reason),
        format!("armed={}", context.armed),
        format!("mode={}", context.mode),
        format!("allowModeOnly={}", context.allow_mode_only),
        format!("max={}", context.max_repeats),
        format!("used={}", context.used),
        format!("left={}", context.remaining),
        format!("active={}", context.active),
        format!("stopEligible={}", context.stop_eligible),
        format!("captured={}", context.has_captured_request),
        format!("compaction={}", context.compaction_request),
        format!("seed={}", context.has_seed),
    ];
    if let Some(stage) = context.stage {
        parts.push(format!("stage={stage}"));
    }
    if let Some(bd_work_state) = context.bd_work_state {
        parts.push(format!("bd={bd_work_state}"));
    }
    parts.push(format!(
        "obs={}",
        context
            .observation_hash
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "none".to_string())
    ));
    parts.push(format!(
        "stable={}",
        context
            .observation_stable_count
            .map(|value| value.to_string())
            .unwrap_or_else(|| "n/a".to_string())
    ));
    parts.push(format!(
        "toolSig={}",
        context
            .tool_signature_hash
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "none".to_string())
    ));
    parts.join(" ")
}

fn read_string(record: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<String> {
    record
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn read_non_negative_i32(
    record: &serde_json::Map<String, serde_json::Value>,
    camel_key: &str,
    snake_key: &str,
) -> Option<i32> {
    let value = record.get(camel_key).or_else(|| record.get(snake_key))?;
    match value {
        serde_json::Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                Some(i32::try_from(integer.max(0)).unwrap_or(i32::MAX))
            } else if let Some(unsigned) = number.as_u64() {
                Some(i32::try_from(unsigned).unwrap_or(i32::MAX))
            } else {
                number
                    .as_f64()
                    .map(|float| i32::try_from((float.floor() as i64).max(0)).unwrap_or(i32::MAX))
            }
        }
        _ => None,
    }
}

fn read_truthy(
    record: &serde_json::Map<String, serde_json::Value>,
    camel_key: &str,
    snake_key: &str,
) -> bool {
    let Some(value) = record.get(camel_key).or_else(|| record.get(snake_key)) else {
        return false;
    };
    match value {
        serde_json::Value::Bool(value) => *value,
        serde_json::Value::Null => false,
        serde_json::Value::Number(number) => {
            number.as_f64().map(|value| value != 0.0).unwrap_or(false)
        }
        serde_json::Value::String(value) => !value.is_empty(),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_compare_context_with_flooring_and_defaults() {
        let context = normalize_stop_message_compare_context(&json!({
            "armed": true,
            "mode": " AUTO ",
            "allowModeOnly": false,
            "textLength": 12.9,
            "maxRepeats": 3.2,
            "used": 1.8,
            "active": true,
            "stopEligible": true,
            "hasCapturedRequest": true,
            "compactionRequest": false,
            "hasSeed": true,
            "decision": " TRIGGER ",
            "reason": " native_decision ",
            "stage": " entry ",
            "bdWorkState": " clean ",
            "observationStableCount": 2.7
        }))
        .expect("context");
        assert!(context.armed);
        assert_eq!(context.mode, "auto");
        assert_eq!(context.text_length, 12);
        assert_eq!(context.max_repeats, 3);
        assert_eq!(context.used, 1);
        assert_eq!(context.remaining, 2);
        assert_eq!(context.decision, "trigger");
        assert_eq!(context.reason, "native_decision");
        assert_eq!(context.stage.as_deref(), Some("entry"));
        assert_eq!(context.bd_work_state.as_deref(), Some("clean"));
        assert_eq!(context.observation_stable_count, Some(2));
    }

    #[test]
    fn rejects_invalid_decision() {
        assert!(normalize_stop_message_compare_context(&json!({
            "decision": "maybe",
            "reason": "x"
        }))
        .is_none());
    }

    #[test]
    fn formats_compare_context_summary() {
        let summary = format_stop_message_compare_context(Some(&json!({
            "armed": false,
            "mode": "bad",
            "allowModeOnly": true,
            "textLength": 0,
            "maxRepeats": 3,
            "used": 4,
            "active": false,
            "stopEligible": false,
            "hasCapturedRequest": false,
            "compactionRequest": true,
            "hasSeed": false,
            "decision": "skip",
            "reason": "skip_reached_max_repeats",
            "observationHash": "abc",
            "toolSignatureHash": "sig"
        })));
        assert_eq!(
            summary,
            "decision=skip reason=skip_reached_max_repeats armed=false mode=off allowModeOnly=true max=3 used=4 left=0 active=false stopEligible=false captured=false compaction=true seed=false obs=abc stable=n/a toolSig=sig"
        );
    }
}
