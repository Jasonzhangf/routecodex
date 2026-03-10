use serde::Serialize;

use crate::chat_clock_schedule_directive_candidate::{
    parse_clock_schedule_directive_candidate, ClockDirectiveCandidateOutput,
};

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClockDirectiveTextPartOutput {
    Text {
        text: String,
    },
    Directive {
        full: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        candidate: Option<ClockDirectiveCandidateOutput>,
    },
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClockDirectiveTextPartsOutput {
    pub parts: Vec<ClockDirectiveTextPartOutput>,
}

fn parse_clock_payload(inner: &str) -> Option<String> {
    let trimmed = inner.trim_start();
    if trimmed.len() < 5 {
        return None;
    }
    if !trimmed
        .get(..5)
        .map(|head| head.eq_ignore_ascii_case("clock"))
        .unwrap_or(false)
    {
        return None;
    }
    let tail = trimmed.get(5..).unwrap_or("").trim_start();
    if !tail.starts_with(':') {
        return None;
    }
    Some(tail.get(1..).unwrap_or("").trim().to_string())
}

pub fn extract_clock_schedule_directive_text_parts(text: String) -> ClockDirectiveTextPartsOutput {
    let raw = text;
    let mut parts: Vec<ClockDirectiveTextPartOutput> = Vec::new();
    let mut cursor = 0usize;

    while cursor < raw.len() {
        let rel_start = match raw.get(cursor..).and_then(|segment| segment.find("<**")) {
            Some(index) => index,
            None => break,
        };
        let start = cursor + rel_start;
        if start > cursor {
            if let Some(chunk) = raw.get(cursor..start) {
                if !chunk.is_empty() {
                    parts.push(ClockDirectiveTextPartOutput::Text {
                        text: chunk.to_string(),
                    });
                }
            }
        }

        let body_start = start + 3;
        let rel_end = match raw
            .get(body_start..)
            .and_then(|segment| segment.find("**>"))
        {
            Some(index) => index,
            None => {
                if let Some(rest) = raw.get(start..) {
                    if !rest.is_empty() {
                        parts.push(ClockDirectiveTextPartOutput::Text {
                            text: rest.to_string(),
                        });
                    }
                }
                cursor = raw.len();
                break;
            }
        };
        let body_end = body_start + rel_end;
        let full_end = body_end + 3;
        let full = raw.get(start..full_end).unwrap_or("").to_string();
        let inner = raw.get(body_start..body_end).unwrap_or("");

        if let Some(payload) = parse_clock_payload(inner) {
            let candidate = parse_clock_schedule_directive_candidate(payload);
            parts.push(ClockDirectiveTextPartOutput::Directive { full, candidate });
        } else if !full.is_empty() {
            parts.push(ClockDirectiveTextPartOutput::Text { text: full });
        }

        cursor = full_end;
    }

    if cursor < raw.len() {
        if let Some(trailing) = raw.get(cursor..) {
            if !trailing.is_empty() {
                parts.push(ClockDirectiveTextPartOutput::Text {
                    text: trailing.to_string(),
                });
            }
        }
    }

    if parts.is_empty() {
        parts.push(ClockDirectiveTextPartOutput::Text { text: raw });
    }

    ClockDirectiveTextPartsOutput { parts }
}
