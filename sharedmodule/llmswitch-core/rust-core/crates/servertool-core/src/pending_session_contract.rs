use serde::{Deserialize, Serialize};
use serde_json::Value;

// feature_id: hub.servertool_pending_session
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInjectionPersistInput {
    pub pending_injection: Value,
    pub request_id: String,
    pub flow_id: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingInjectionPersistRecord {
    pub session_id: String,
    pub pending: PendingServerToolInjectionDraft,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingServerToolInjectionDraft {
    pub created_at_ms: i64,
    pub after_tool_call_ids: Vec<String>,
    pub messages: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_request_id: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "action")]
pub enum PendingInjectionPersistPlan {
    #[serde(rename = "skip")]
    Skip,
    #[serde(rename = "persist")]
    Persist {
        #[serde(rename = "sessionIds")]
        session_ids: Vec<String>,
        records: Vec<PendingInjectionPersistRecord>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInjectionPersistErrorInput {
    pub request_id: String,
    pub flow_id: String,
    #[serde(default)]
    pub session_ids: Vec<Value>,
    pub reason: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingInjectionPersistErrorPlan {
    pub message: String,
    pub code: String,
    pub category: String,
    pub status: i64,
    pub details: Value,
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
        return parse_js_int_prefix(text)
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

pub fn plan_pending_injection_persist(
    input: PendingInjectionPersistInput,
) -> Result<PendingInjectionPersistPlan, String> {
    let record = input
        .pending_injection
        .as_object()
        .ok_or_else(|| "pending injection input must be an object".to_string())?;
    let session_ids = collect_unique_pending_session_ids(record);
    if session_ids.is_empty() {
        return Ok(PendingInjectionPersistPlan::Skip);
    }
    let created_at_ms = if input.created_at_ms > 0 {
        input.created_at_ms
    } else {
        return Err("pending injection createdAtMs must be positive".to_string());
    };
    let after_tool_call_ids = read_trimmed_string_array(record.get("afterToolCallIds"));
    if after_tool_call_ids.is_empty() {
        return Err("pending injection afterToolCallIds must contain at least one id".to_string());
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
        return Err("pending injection messages must contain at least one object".to_string());
    }
    let source_request_id = trim_to_non_empty(input.request_id);
    let draft = PendingServerToolInjectionDraft {
        created_at_ms,
        after_tool_call_ids,
        messages,
        source_request_id,
    };
    let records = session_ids
        .iter()
        .map(|session_id| PendingInjectionPersistRecord {
            session_id: session_id.clone(),
            pending: draft.clone(),
        })
        .collect::<Vec<_>>();
    let _ = input.flow_id;
    Ok(PendingInjectionPersistPlan::Persist {
        session_ids,
        records,
    })
}

pub fn plan_pending_injection_persist_error(
    input: PendingInjectionPersistErrorInput,
) -> PendingInjectionPersistErrorPlan {
    let session_ids = input
        .session_ids
        .iter()
        .filter_map(|item| read_trimmed_string(Some(item)))
        .fold(Vec::<String>::new(), |mut acc, item| {
            if !acc.iter().any(|existing| existing == &item) {
                acc.push(item);
            }
            acc
        });
    PendingInjectionPersistErrorPlan {
        message: "[servertool] pending injection persistence failed".to_string(),
        code: "SERVERTOOL_PENDING_INJECTION_FAILED".to_string(),
        category: "INTERNAL_ERROR".to_string(),
        status: 502,
        details: serde_json::json!({
            "requestId": input.request_id.trim(),
            "flowId": input.flow_id.trim(),
            "sessionIds": session_ids,
            "reason": input.reason.trim(),
        }),
    }
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

fn collect_unique_pending_session_ids(record: &serde_json::Map<String, Value>) -> Vec<String> {
    let mut output = Vec::new();
    push_unique_trimmed(&mut output, record.get("sessionId"));
    if let Some(alias_session_ids) = record.get("aliasSessionIds").and_then(Value::as_array) {
        for item in alias_session_ids {
            push_unique_trimmed(&mut output, Some(item));
        }
    }
    output
}

fn push_unique_trimmed(output: &mut Vec<String>, value: Option<&Value>) {
    let Some(next) = read_trimmed_string(value) else {
        return;
    };
    if !output.iter().any(|existing| existing == &next) {
        output.push(next);
    }
}

fn read_trimmed_string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| read_trimmed_string(Some(item)))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn trim_to_non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
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

fn parse_js_int_prefix(value: &str) -> Option<i64> {
    let trimmed = value.trim_start();
    if trimmed.is_empty() {
        return None;
    }
    let mut chars = trimmed.char_indices();
    let mut end = 0usize;
    if let Some((index, ch)) = chars.next() {
        if ch == '+' || ch == '-' {
            end = index + ch.len_utf8();
        } else if ch.is_ascii_digit() {
            end = index + ch.len_utf8();
        } else {
            return None;
        }
    }
    for (index, ch) in chars {
        if !ch.is_ascii_digit() {
            break;
        }
        end = index + ch.len_utf8();
    }
    let candidate = &trimmed[..end];
    if candidate == "+" || candidate == "-" {
        return None;
    }
    candidate.parse::<i64>().ok()
}

#[cfg(test)]
mod tests {
    use super::{
        plan_pending_injection_persist, plan_pending_injection_persist_error,
        plan_pending_session_load, plan_pending_session_save, resolve_pending_file_name,
        resolve_pending_max_age_ms, PendingInjectionPersistErrorInput,
        PendingInjectionPersistInput, PendingInjectionPersistPlan, PendingSessionFileInput,
        PendingSessionLoadInput, PendingSessionMaxAgeInput, PendingSessionSaveInput,
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
                raw: Some(json!("45000ms"))
            }),
            45_000
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

    #[test]
    fn plans_pending_injection_persist_records_and_dedupes_sessions() {
        let plan = plan_pending_injection_persist(PendingInjectionPersistInput {
            pending_injection: json!({
                "sessionId": " sess-1 ",
                "aliasSessionIds": ["sess-2", " sess-1 ", "", 7],
                "afterToolCallIds": [" call-1 ", ""],
                "messages": [{ "role": "assistant" }, null],
            }),
            request_id: " req-1 ".to_string(),
            flow_id: " flow-1 ".to_string(),
            created_at_ms: 2000,
        })
        .expect("persist plan");

        let PendingInjectionPersistPlan::Persist {
            session_ids,
            records,
        } = plan
        else {
            panic!("expected persist plan");
        };
        assert_eq!(session_ids, vec!["sess-1", "sess-2"]);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].session_id, "sess-1");
        assert_eq!(records[0].pending.created_at_ms, 2000);
        assert_eq!(records[0].pending.after_tool_call_ids, vec!["call-1"]);
        assert_eq!(
            records[0].pending.source_request_id.as_deref(),
            Some("req-1")
        );
    }

    #[test]
    fn plans_pending_injection_skip_and_error_envelope() {
        let skip = plan_pending_injection_persist(PendingInjectionPersistInput {
            pending_injection: json!({
                "sessionId": " ",
                "aliasSessionIds": [" "],
                "afterToolCallIds": ["call-1"],
                "messages": [{ "role": "assistant" }],
            }),
            request_id: "req-1".to_string(),
            flow_id: "flow-1".to_string(),
            created_at_ms: 2000,
        })
        .expect("skip plan");
        assert!(matches!(skip, PendingInjectionPersistPlan::Skip));

        let error = plan_pending_injection_persist_error(PendingInjectionPersistErrorInput {
            request_id: " req-1 ".to_string(),
            flow_id: " flow-1 ".to_string(),
            session_ids: vec![json!(" sess-1 "), json!("sess-1"), json!("sess-2")],
            reason: " disk full ".to_string(),
        });
        assert_eq!(error.status, 502);
        assert_eq!(error.code, "SERVERTOOL_PENDING_INJECTION_FAILED");
        assert_eq!(error.details["requestId"], json!("req-1"));
        assert_eq!(error.details["sessionIds"], json!(["sess-1", "sess-2"]));
        assert_eq!(error.details["reason"], json!("disk full"));
    }
}
