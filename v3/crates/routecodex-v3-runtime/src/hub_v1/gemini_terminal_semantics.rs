//! Gemini business-terminal interpretation shared by JSON and buffered SSE.
//! Unknown nonempty enum strings remain opaque business terminals; they are
//! never guessed to be filters, argument failures, or provider-health failures.
use serde_json::Value;

pub(super) fn candidate_finish_reason(candidate: &Value) -> Option<&str> {
    candidate
        .get("finishReason")
        .and_then(Value::as_str)
        .filter(|reason| !reason.is_empty() && *reason != "FINISH_REASON_UNSPECIFIED")
}

pub(super) fn prompt_block_reason(payload: &Value) -> Option<&str> {
    payload
        .pointer("/promptFeedback/blockReason")
        .and_then(Value::as_str)
        .filter(|reason| !reason.is_empty() && *reason != "BLOCK_REASON_UNSPECIFIED")
}

fn terminal_rank(reason: &str) -> u8 {
    match reason {
        "SAFETY"
        | "RECITATION"
        | "BLOCKLIST"
        | "PROHIBITED_CONTENT"
        | "SPII"
        | "IMAGE_SAFETY"
        | "IMAGE_PROHIBITED_CONTENT"
        | "IMAGE_RECITATION"
        | "MODEL_ARMOR" => 0,
        "MAX_TOKENS" => 1,
        _ => 2,
    }
}

pub(super) fn candidate_finish_reason_is_filter(reason: Option<&str>) -> bool {
    reason.is_some_and(|reason| terminal_rank(reason) == 0)
}

pub(super) fn candidate_finish_reason_has_business_outcome(reason: Option<&str>) -> bool {
    candidate_finish_reason_is_filter(reason)
        || matches!(
            reason,
            Some(
                "MAX_TOKENS"
                    | "MALFORMED_FUNCTION_CALL"
                    | "UNEXPECTED_TOOL_CALL"
                    | "TOO_MANY_TOOL_CALLS"
                    | "OTHER"
            )
        )
}

pub(super) struct GeminiTerminal<'a> {
    pub candidates: &'a [Value],
    pub finish_reason: &'a str,
    pub incomplete_reason: Option<&'static str>,
}

/// A prompt block completes only a no-candidate response. Otherwise each
/// accumulated candidate must actually terminate. The single Responses status
/// gives filtering precedence over token limits, then ordinary completion.
/// A lexical tie-break selects an original representative reason without
/// depending on candidate order; the projection preserves every outcome.
pub(super) fn interpret_gemini_terminal(payload: &Value) -> Result<GeminiTerminal<'_>, String> {
    let block = prompt_block_reason(payload);
    let candidates = match payload.get("candidates") {
        Some(Value::Array(candidates)) => candidates.as_slice(),
        None if block.is_some() => &[],
        _ => return Err("Gemini response requires candidates or a genuine prompt block".into()),
    };
    if candidates.is_empty() {
        return block
            .map(|finish_reason| GeminiTerminal {
                candidates,
                finish_reason,
                incomplete_reason: Some("content_filter"),
            })
            .ok_or_else(|| {
                "Gemini response ended without terminal candidates or prompt block".into()
            });
    }
    let reasons = candidates
        .iter()
        .map(candidate_finish_reason)
        .collect::<Option<Vec<_>>>()
        .ok_or("Gemini response has candidate without terminal finishReason")?;
    let finish_reason = reasons
        .into_iter()
        .min_by_key(|reason| (terminal_rank(reason), *reason))
        .unwrap();
    let incomplete_reason = match terminal_rank(finish_reason) {
        0 => Some("content_filter"),
        1 => Some("max_output_tokens"),
        _ => None,
    };
    Ok(GeminiTerminal {
        candidates,
        finish_reason,
        incomplete_reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn gemini_terminal_forward_compatible_reason_is_not_a_guessed_filter() {
        let payload =
            json!({"candidates":[{"finishReason":"FUTURE_TERMINAL","opaque":{"original":[1,2]}}]});
        let terminal = interpret_gemini_terminal(&payload).unwrap();
        assert_eq!(terminal.finish_reason, "FUTURE_TERMINAL");
        assert_eq!(terminal.incomplete_reason, None);
        assert_eq!(
            terminal.candidates[0]["opaque"],
            payload["candidates"][0]["opaque"]
        );
    }

    #[test]
    fn gemini_terminal_filter_and_limit_precedence_is_deterministic() {
        for reasons in [
            ["STOP", "MAX_TOKENS", "SAFETY"],
            ["SAFETY", "STOP", "MAX_TOKENS"],
        ] {
            let payload =
                json!({"candidates":reasons.map(|reason| json!({"finishReason":reason}))});
            let terminal = interpret_gemini_terminal(&payload).unwrap();
            assert_eq!(terminal.finish_reason, "SAFETY");
            assert_eq!(terminal.incomplete_reason, Some("content_filter"));
        }
    }

    #[test]
    fn gemini_terminal_documented_filters_and_model_tool_errors_stay_business() {
        for reason in [
            "SAFETY",
            "RECITATION",
            "BLOCKLIST",
            "PROHIBITED_CONTENT",
            "SPII",
            "IMAGE_SAFETY",
            "IMAGE_PROHIBITED_CONTENT",
            "IMAGE_RECITATION",
        ] {
            let payload = json!({"candidates":[{"finishReason":"STOP"},{"finishReason":reason}]});
            let terminal = interpret_gemini_terminal(&payload).unwrap();
            assert_eq!(terminal.finish_reason, reason);
            assert_eq!(terminal.incomplete_reason, Some("content_filter"));
        }
        for reason in [
            "MALFORMED_FUNCTION_CALL",
            "UNEXPECTED_TOOL_CALL",
            "TOO_MANY_TOOL_CALLS",
            "OTHER",
        ] {
            let payload = json!({"candidates":[{"finishReason":reason}]});
            let terminal = interpret_gemini_terminal(&payload).unwrap();
            assert_eq!(terminal.finish_reason, reason);
            assert_eq!(terminal.incomplete_reason, None);
        }
    }
}
