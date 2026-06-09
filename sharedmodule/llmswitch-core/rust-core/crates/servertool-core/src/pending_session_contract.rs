use serde::{Deserialize, Serialize};
use serde_json::Value;

const DEFAULT_PENDING_MAX_AGE_MS: i64 = 30 * 60 * 1000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSessionFileInput {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSessionMaxAgeInput {
    #[serde(default)]
    pub raw: Option<Value>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingServerToolInjectionPlan {
    pub version: i64,
    pub session_id: String,
    pub created_at_ms: i64,
    pub after_tool_call_ids: Vec<String>,
    pub messages: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSessionSaveInput {
    pub session_id: String,
    pub pending: Value,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingSessionSavePlan {
    pub file_name: String,
    pub payload: PendingServerToolInjectionPlan,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSessionLoadInput {
    pub raw: Value,
    pub now_ms: i64,
    pub max_age_ms: i64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "action")]
pub enum PendingSessionLoadPlan {
    #[serde(rename = "use")]
    Use {
        pending: PendingServerToolInjectionPlan,
    },
    #[serde(rename = "drop")]
    Drop { reason: String, message: String },
}

pub fn resolve_pending_file_name(input: &PendingSessionFileInput) -> Option<String> {
    sanitize_segment(&input.session_id).map(|segment| format!("{segment}.json"))
}

pub fn resolve_pending_max_age_ms(input: &PendingSessionMaxAgeInput) -> i64 {
    let Some(raw) = input.raw.as_ref() else {
        return DEFAULT_PENDING_MAX_AGE_MS;
    };
    if let Some(number) = raw.as_i64() {
        return positive_or_default(number);
    }
    if let Some(number) = raw.as_u64() {
        return i64::try_from(number)
            .ok()
            .map(positive_or_default)
            .unwrap_or(DEFAULT_PENDING_MAX_AGE_MS);
    }
    if let Some(number) = raw.as_f64() {
        if number.is_finite() {
            return positive_or_default(number.floor() as i64);
        }
    }
    if let Some(text) = raw.as_str() {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return DEFAULT_PENDING_MAX_AGE_MS;
        }
        return trimmed
            .parse::<i64>()
            .ok()
            .map(positive_or_default)
            .unwrap_or(DEFAULT_PENDING_MAX_AGE_MS);
    }
    DEFAULT_PENDING_MAX_AGE_MS
}

pub fn plan_pending_session_save(input: PendingSessionSaveInput) -> Option<PendingSessionSavePlan> {
    let file_name = resolve_pending_file_name(&PendingSessionFileInput {
        session_id: input.session_id.clone(),
    })?;
    let mut record = input.pending;
    if let Value::Object(ref mut object) = record {
        object.insert("version".to_string(), Value::from(1));
        object.insert("sessionId".to_string(), Value::String(input.session_id));
    }
    let payload = coerce_pending_injection(&record)?;
    Some(PendingSessionSavePlan { file_name, payload })
}

pub fn plan_pending_session_load(input: PendingSessionLoadInput) -> PendingSessionLoadPlan {
    let Some(pending) = coerce_pending_injection(&input.raw) else {
        return PendingSessionLoadPlan::Drop {
            reason: "malformed".to_string(),
            message: "[servertool-pending] invalid pending injection dropped: malformed payload"
                .to_string(),
        };
    };
    let age_ms = input.now_ms.saturating_sub(pending.created_at_ms);
    if age_ms > input.max_age_ms {
        return PendingSessionLoadPlan::Drop {
            reason: "stale".to_string(),
            message: format!(
                "[servertool-pending] stale pending injection dropped session={} ageMs={} maxAgeMs={}",
                pending.session_id, age_ms, input.max_age_ms
            ),
        };
    }
    PendingSessionLoadPlan::Use { pending }
}

fn positive_or_default(value: i64) -> i64 {
    if value > 0 {
        value
    } else {
        DEFAULT_PENDING_MAX_AGE_MS
    }
}

fn sanitize_segment(value: &str) -> Option<String> {
    let mut output = String::new();
    let mut previous_underscore = false;
    for ch in value.trim().chars() {
        let next = if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '-' {
            ch
        } else {
            '_'
        };
        if next == '_' {
            if previous_underscore {
                continue;
            }
            previous_underscore = true;
        } else {
            previous_underscore = false;
        }
        output.push(next);
    }
    let trimmed = output.trim_matches('_').to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn coerce_pending_injection(value: &Value) -> Option<PendingServerToolInjectionPlan> {
    let record = value.as_object()?;
    let session_id = read_trimmed_string(record.get("sessionId"))?;
    let created_at_ms = read_floor_i64(record.get("createdAtMs")).filter(|value| *value > 0)?;
    let after_tool_call_ids = record
        .get("afterToolCallIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| read_trimmed_string(Some(item)))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if after_tool_call_ids.is_empty() {
        return None;
    }
    let messages = record
        .get("messages")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| item.as_object().is_some())
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if messages.is_empty() {
        return None;
    }
    let source_request_id = read_trimmed_string(record.get("sourceRequestId"));
    Some(PendingServerToolInjectionPlan {
        version: 1,
        session_id,
        created_at_ms,
        after_tool_call_ids,
        messages,
        source_request_id,
    })
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn read_floor_i64(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    if let Some(number) = value.as_u64() {
        return i64::try_from(number).ok();
    }
    if let Some(number) = value.as_f64() {
        if number.is_finite() {
            return Some(number.floor() as i64);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{
        plan_pending_session_load, plan_pending_session_save, resolve_pending_file_name,
        resolve_pending_max_age_ms, PendingSessionFileInput, PendingSessionLoadInput,
        PendingSessionMaxAgeInput, PendingSessionSaveInput,
    };
    use serde_json::json;

    #[test]
    fn resolves_pending_file_name_with_rust_segment_sanitizer() {
        assert_eq!(
            resolve_pending_file_name(&PendingSessionFileInput {
                session_id: " ../bad session//id__ ".to_string()
            }),
            Some(".._bad_session_id.json".to_string())
        );
        assert_eq!(
            resolve_pending_file_name(&PendingSessionFileInput {
                session_id: " /// ".to_string()
            }),
            None
        );
    }

    #[test]
    fn resolves_pending_max_age_with_rust_integer_policy() {
        assert_eq!(
            resolve_pending_max_age_ms(&PendingSessionMaxAgeInput {
                raw: Some(json!("2500"))
            }),
            2500
        );
        assert_eq!(
            resolve_pending_max_age_ms(&PendingSessionMaxAgeInput {
                raw: Some(json!(-1))
            }),
            1_800_000
        );
        assert_eq!(
            resolve_pending_max_age_ms(&PendingSessionMaxAgeInput {
                raw: Some(json!("not-number"))
            }),
            1_800_000
        );
    }

    #[test]
    fn plans_save_payload_and_load_stale_decision() {
        let pending = json!({
            "createdAtMs": 1000.9,
            "afterToolCallIds": [" call-1 ", ""],
            "messages": [{ "role": "assistant" }, null],
            "sourceRequestId": " req-1 "
        });
        let save = plan_pending_session_save(PendingSessionSaveInput {
            session_id: "sess/1".to_string(),
            pending,
        })
        .expect("save plan");
        assert_eq!(save.file_name, "sess_1.json");
        assert_eq!(save.payload.session_id, "sess/1");
        assert_eq!(save.payload.created_at_ms, 1000);
        assert_eq!(save.payload.after_tool_call_ids, vec!["call-1"]);
        assert_eq!(save.payload.source_request_id.as_deref(), Some("req-1"));

        let fresh = plan_pending_session_load(PendingSessionLoadInput {
            raw: serde_json::to_value(&save.payload).expect("payload json"),
            now_ms: 1500,
            max_age_ms: 1000,
        });
        assert!(matches!(fresh, super::PendingSessionLoadPlan::Use { .. }));

        let stale = plan_pending_session_load(PendingSessionLoadInput {
            raw: serde_json::to_value(&save.payload).expect("payload json"),
            now_ms: 3000,
            max_age_ms: 1000,
        });
        assert!(matches!(
            stale,
            super::PendingSessionLoadPlan::Drop { reason, .. } if reason == "stale"
        ));
    }
}
