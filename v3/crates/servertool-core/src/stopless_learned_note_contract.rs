use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessLearnedNotePlanInput {
    pub request_id: String,
    #[serde(default)]
    pub working_directory: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub parsed: Option<Value>,
    #[serde(default)]
    pub timestamp_ms: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessLearnedNoteWritePlan {
    pub should_write: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub timestamp_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub learned: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>,
}

pub fn plan_stopless_learned_note_write(
    input: StoplessLearnedNotePlanInput,
) -> StoplessLearnedNoteWritePlan {
    let parsed = input.parsed.as_ref().unwrap_or(&Value::Null);
    let learned = read_non_empty_string(parsed.get("learned"));
    let timestamp_ms = input
        .timestamp_ms
        .as_ref()
        .and_then(read_non_negative_floor_u64)
        .unwrap_or(0);
    StoplessLearnedNoteWritePlan {
        should_write: learned.is_some(),
        working_directory: normalize_optional_string(input.working_directory),
        request_id: input.request_id,
        session_id: normalize_optional_string(input.session_id),
        timestamp_ms,
        learned,
        reason: read_non_empty_string(parsed.get("reason")),
        evidence: read_non_empty_string(parsed.get("evidence")),
    }
}

fn read_non_empty_string(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?.trim();
    if raw.is_empty() {
        None
    } else {
        Some(raw.to_string())
    }
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    let raw = value?.trim().to_string();
    if raw.is_empty() {
        None
    } else {
        Some(raw)
    }
}

fn read_non_negative_floor_u64(value: &Value) -> Option<u64> {
    match value {
        Value::Number(number) => number.as_u64().or_else(|| {
            number
                .as_f64()
                .filter(|value| value.is_finite() && *value >= 0.0)
                .map(|value| value.floor() as u64)
        }),
        Value::String(text) => text
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map(|value| value.floor() as u64),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plans_stopless_learned_note_write_from_schema_report() {
        let plan = plan_stopless_learned_note_write(StoplessLearnedNotePlanInput {
            request_id: "req_1".to_string(),
            working_directory: Some("/repo".to_string()),
            session_id: Some(" session-1 ".to_string()),
            parsed: Some(json!({
                "learned": "  learned fact  ",
                "reason": "  stop reason  ",
                "evidence": "  log evidence  "
            })),
            timestamp_ms: Some(json!(1234.9)),
        });

        assert!(plan.should_write);
        assert_eq!(plan.working_directory.as_deref(), Some("/repo"));
        assert_eq!(plan.request_id, "req_1");
        assert_eq!(plan.session_id.as_deref(), Some("session-1"));
        assert_eq!(plan.timestamp_ms, 1234);
        assert_eq!(plan.learned.as_deref(), Some("learned fact"));
        assert_eq!(plan.reason.as_deref(), Some("stop reason"));
        assert_eq!(plan.evidence.as_deref(), Some("log evidence"));
    }

    #[test]
    fn skips_write_when_learned_is_empty_but_preserves_control_fields() {
        let plan = plan_stopless_learned_note_write(StoplessLearnedNotePlanInput {
            request_id: "req_2".to_string(),
            working_directory: Some("/rt-repo".to_string()),
            session_id: Some("session-2".to_string()),
            parsed: Some(json!({
                "learned": "   ",
                "reason": "ignored"
            })),
            timestamp_ms: Some(json!("42")),
        });

        assert!(!plan.should_write);
        assert_eq!(plan.working_directory.as_deref(), Some("/rt-repo"));
        assert_eq!(plan.session_id.as_deref(), Some("session-2"));
        assert_eq!(plan.timestamp_ms, 42);
        assert_eq!(plan.learned, None);
    }

    #[test]
    fn skips_write_when_schema_report_is_missing() {
        let plan = plan_stopless_learned_note_write(StoplessLearnedNotePlanInput {
            request_id: "req_3".to_string(),
            working_directory: Some("/repo".to_string()),
            session_id: Some("session-3".to_string()),
            parsed: None,
            timestamp_ms: Some(json!(9000)),
        });

        assert!(!plan.should_write);
        assert_eq!(plan.working_directory.as_deref(), Some("/repo"));
        assert_eq!(plan.session_id.as_deref(), Some("session-3"));
        assert_eq!(plan.timestamp_ms, 9000);
        assert_eq!(plan.learned, None);
        assert_eq!(plan.reason, None);
        assert_eq!(plan.evidence, None);
    }

    #[test]
    fn skips_write_when_learned_is_not_a_string() {
        for learned in [
            json!(true),
            json!(123),
            json!(["not", "string"]),
            json!({"text": "not string"}),
        ] {
            let plan = plan_stopless_learned_note_write(StoplessLearnedNotePlanInput {
                request_id: "req_non_string".to_string(),
                working_directory: None,
                session_id: None,
                parsed: Some(json!({
                    "learned": learned,
                    "reason": "ignored when learned missing",
                    "evidence": "ignored when learned missing"
                })),
                timestamp_ms: Some(json!(1)),
            });

            assert!(!plan.should_write);
            assert_eq!(plan.learned, None);
        }
    }

    #[test]
    fn rejects_negative_or_non_finite_timestamp_values_to_zero() {
        for timestamp_ms in [
            json!(-1),
            json!("-1"),
            json!("NaN"),
            json!("Infinity"),
            json!({ "bad": 1 }),
        ] {
            let plan = plan_stopless_learned_note_write(StoplessLearnedNotePlanInput {
                request_id: "req_time".to_string(),
                working_directory: None,
                session_id: None,
                parsed: Some(json!({ "learned": "fact" })),
                timestamp_ms: Some(timestamp_ms),
            });

            assert!(plan.should_write);
            assert_eq!(plan.timestamp_ms, 0);
        }
    }

    #[test]
    #[test]
    fn trims_explicit_working_directory_and_session_id() {
        let plan = plan_stopless_learned_note_write(StoplessLearnedNotePlanInput {
            request_id: "req_trim".to_string(),
            working_directory: Some("  /repo  ".to_string()),
            session_id: Some("  session-trim  ".to_string()),
            parsed: Some(json!({ "learned": "fact" })),
            timestamp_ms: None,
        });

        assert_eq!(plan.working_directory.as_deref(), Some("/repo"));
        assert_eq!(plan.session_id.as_deref(), Some("session-trim"));
    }
}
