use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClockDirectiveRecurrenceOutput {
    pub kind: String,
    pub max_runs: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub every_minutes: Option<i64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClockDirectiveCandidateOutput {
    pub due_at: String,
    pub task: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence: Option<ClockDirectiveRecurrenceOutput>,
}

#[derive(Debug, Clone, Copy)]
enum RecurrenceKind {
    Daily,
    Weekly,
    Interval,
}

impl RecurrenceKind {
    fn as_str(&self) -> &'static str {
        match self {
            RecurrenceKind::Daily => "daily",
            RecurrenceKind::Weekly => "weekly",
            RecurrenceKind::Interval => "interval",
        }
    }
}

fn unquote_marker_token(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if (trimmed.starts_with('"') && trimmed.ends_with('"'))
        || (trimmed.starts_with('\'') && trimmed.ends_with('\''))
    {
        return trimmed
            .get(1..trimmed.len().saturating_sub(1))
            .unwrap_or("")
            .trim()
            .to_string();
    }
    trimmed.to_string()
}

fn parse_positive_int(raw: Option<&Value>) -> Option<i64> {
    let value = raw?;
    if let Some(v) = value.as_i64() {
        if v > 0 {
            return Some(v);
        }
        return None;
    }
    if let Some(v) = value.as_u64() {
        return i64::try_from(v).ok().filter(|n| *n > 0);
    }
    if let Some(v) = value.as_f64() {
        if !v.is_finite() {
            return None;
        }
        let floored = v.floor();
        if floored > 0.0 {
            return Some(floored as i64);
        }
    }
    None
}

fn parse_recurrence_kind(raw: Option<&Value>) -> Option<RecurrenceKind> {
    let value = raw
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if value.is_empty() {
        return None;
    }
    if value == "daily" || value == "day" {
        return Some(RecurrenceKind::Daily);
    }
    if value == "weekly" || value == "week" {
        return Some(RecurrenceKind::Weekly);
    }
    if value == "interval"
        || value == "every_minutes"
        || value == "every-minutes"
        || value == "everyminutes"
    {
        return Some(RecurrenceKind::Interval);
    }
    None
}

fn parse_marker_recurrence(record: &Map<String, Value>) -> Option<ClockDirectiveRecurrenceOutput> {
    let recurrence_raw = record
        .get("recurrence")
        .or_else(|| record.get("repeat"))
        .or_else(|| record.get("cycle"));

    match recurrence_raw {
        None => return None,
        Some(Value::Null) => return None,
        Some(Value::Bool(false)) => return None,
        _ => {}
    }

    let mut kind: Option<RecurrenceKind> = None;
    let mut every_minutes_raw: Option<&Value> = None;
    let mut max_runs_raw: Option<&Value> = None;

    if let Some(Value::String(raw)) = recurrence_raw {
        kind = parse_recurrence_kind(Some(&Value::String(raw.clone())));
        every_minutes_raw = record.get("everyMinutes");
        max_runs_raw = record.get("maxRuns");
    } else if let Some(Value::Object(recurrence_record)) = recurrence_raw {
        kind = parse_recurrence_kind(
            recurrence_record
                .get("kind")
                .or_else(|| recurrence_record.get("type"))
                .or_else(|| recurrence_record.get("mode"))
                .or_else(|| recurrence_record.get("every")),
        );
        every_minutes_raw = recurrence_record
            .get("everyMinutes")
            .or_else(|| recurrence_record.get("minutes"))
            .or_else(|| record.get("everyMinutes"));
        max_runs_raw = recurrence_record
            .get("maxRuns")
            .or_else(|| record.get("maxRuns"));
    }

    let resolved_kind = kind?;
    let max_runs = parse_positive_int(max_runs_raw)?;
    if resolved_kind.as_str() == "interval" {
        let every_minutes = parse_positive_int(every_minutes_raw)?;
        return Some(ClockDirectiveRecurrenceOutput {
            kind: resolved_kind.as_str().to_string(),
            max_runs,
            every_minutes: Some(every_minutes),
        });
    }

    Some(ClockDirectiveRecurrenceOutput {
        kind: resolved_kind.as_str().to_string(),
        max_runs,
        every_minutes: None,
    })
}

fn parse_from_record(record: &Map<String, Value>) -> Option<ClockDirectiveCandidateOutput> {
    let due_at = record
        .get("time")
        .and_then(|v| v.as_str())
        .or_else(|| record.get("dueAt").and_then(|v| v.as_str()))
        .or_else(|| record.get("due_at").and_then(|v| v.as_str()))
        .unwrap_or("")
        .trim()
        .to_string();
    let task = record
        .get("message")
        .and_then(|v| v.as_str())
        .or_else(|| record.get("task").and_then(|v| v.as_str()))
        .unwrap_or("")
        .trim()
        .to_string();

    if due_at.is_empty() || task.is_empty() {
        return None;
    }

    let has_recurrence_raw = record.contains_key("recurrence")
        || record.contains_key("repeat")
        || record.contains_key("cycle");
    let recurrence = parse_marker_recurrence(record);
    if has_recurrence_raw && recurrence.is_none() {
        return None;
    }

    Some(ClockDirectiveCandidateOutput {
        due_at,
        task,
        recurrence,
    })
}

fn parse_loose_payload(raw: &str) -> Option<ClockDirectiveCandidateOutput> {
    let trimmed = raw.trim();
    if !(trimmed.starts_with('{') && trimmed.ends_with('}')) {
        return None;
    }
    let inner = trimmed
        .get(1..trimmed.len().saturating_sub(1))
        .unwrap_or("")
        .trim();
    if inner.is_empty() {
        return None;
    }

    let comma_index = inner.find(',')?;
    let first = inner.get(..comma_index)?.trim();
    let second = inner.get(comma_index + 1..)?.trim();

    let parse_pair = |segment: &str| -> Option<(String, String)> {
        let colon = segment.find(':')?;
        let key = segment.get(..colon)?.trim().to_ascii_lowercase();
        let value_raw = segment.get(colon + 1..)?.trim();
        Some((key, unquote_marker_token(value_raw)))
    };

    let (k1, v1) = parse_pair(first)?;
    let (k2, v2) = parse_pair(second)?;
    if k1 != "time" || k2 != "message" {
        return None;
    }
    if v1.is_empty() || v2.is_empty() {
        return None;
    }

    Some(ClockDirectiveCandidateOutput {
        due_at: v1,
        task: v2,
        recurrence: None,
    })
}

pub fn parse_clock_schedule_directive_candidate(
    payload: String,
) -> Option<ClockDirectiveCandidateOutput> {
    let raw = payload.trim();
    if raw.is_empty() || raw.eq_ignore_ascii_case("clear") {
        return None;
    }

    if let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(raw) {
        if let Some(candidate) = parse_from_record(&parsed) {
            return Some(candidate);
        }
    }

    parse_loose_payload(raw)
}
