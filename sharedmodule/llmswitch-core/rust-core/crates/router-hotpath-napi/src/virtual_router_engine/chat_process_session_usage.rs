// feature_id: hub.chat_process_session_usage
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::virtual_router_engine::routing_state_store::{
    load_global_request_counter, load_routing_instruction_state_strict,
    persist_global_request_counter, persist_routing_instruction_state_strict,
};
use crate::virtual_router_engine::time_utils::now_ms;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatProcessSessionUsageInput {
    pub session_scope: Option<String>,
    pub context: Option<Value>,
    pub usage: Option<Value>,
    pub captured_chat_request: Option<Value>,
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatProcessSessionUsageOutput {
    /// The generated requestId in format `req_{total}_{daily}`.
    pub request_id: String,
    /// Total lifetime request count after this tick.
    pub total_requests: i64,
    /// Today's local-date request count after this tick.
    pub daily_requests: i64,
    /// Whether the session_scope RoutingInstructionState was updated.
    pub session_state_updated: bool,
}

fn read_rounded_token(value: &Value) -> Option<i64> {
    let num = value.as_f64()?;
    if !num.is_finite() {
        return None;
    }
    let rounded = num.round() as i64;
    if rounded <= 0 {
        return None;
    }
    Some(rounded)
}

fn normalize_usage(usage: &Value) -> Option<(i64, i64, i64)> {
    let usage_obj = usage.as_object()?;
    let input_tokens = usage_obj
        .get("input_tokens")
        .or_else(|| usage_obj.get("prompt_tokens"))
        .or_else(|| usage_obj.get("inputTokens"))
        .or_else(|| usage_obj.get("promptTokens"))
        .or_else(|| usage_obj.get("request_tokens"))
        .or_else(|| usage_obj.get("requestTokens"))
        .and_then(read_rounded_token);
    let output_tokens = usage_obj
        .get("output_tokens")
        .or_else(|| usage_obj.get("completion_tokens"))
        .or_else(|| usage_obj.get("outputTokens"))
        .or_else(|| usage_obj.get("completionTokens"))
        .or_else(|| usage_obj.get("response_tokens"))
        .or_else(|| usage_obj.get("responseTokens"))
        .and_then(read_rounded_token);
    let total_tokens = usage_obj
        .get("total_tokens")
        .or_else(|| usage_obj.get("totalTokens"))
        .and_then(read_rounded_token)
        .or_else(|| {
            let (Some(inp), Some(out)) = (input_tokens, output_tokens) else {
                return None;
            };
            if inp > 0 || out > 0 {
                Some(inp.saturating_add(out))
            } else {
                None
            }
        });
    total_tokens.map(|total| (input_tokens.unwrap_or(0), output_tokens.unwrap_or(0), total))
}

fn read_message_count(captured: &Value) -> Option<i64> {
    let messages = captured.as_object()?.get("messages")?.as_array()?;
    let count = messages.len() as i64;
    Some(count)
}

fn read_trimmed_string(record: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    record
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn resolve_session_usage_scope(input: &ChatProcessSessionUsageInput) -> Option<String> {
    let explicit = input
        .session_scope
        .as_deref()
        .map(str::trim)
        .filter(|value| value.starts_with("tmux:"))
        .map(ToOwned::to_owned);
    if explicit.is_some() {
        return explicit;
    }
    let context = input.context.as_ref()?.as_object()?;
    if let Some(scope) = read_trimmed_string(context, "stopMessageClientInjectSessionScope") {
        if scope.starts_with("tmux:") {
            return Some(scope);
        }
    }
    let tmux_session_id = read_trimmed_string(context, "clientTmuxSessionId")
        .or_else(|| read_trimmed_string(context, "tmuxSessionId"))?;
    Some(format!("tmux:{}", tmux_session_id))
}

pub fn plan_chat_process_session_usage_json(
    input_json: String,
) -> Result<ChatProcessSessionUsageOutput, String> {
    let input: ChatProcessSessionUsageInput = serde_json::from_str(&input_json)
        .map_err(|e| format!("plan_chat_process_session_usage_json parse failed: {}", e))?;
    plan_chat_process_session_usage(input)
}

/// Plans chat process session usage: increments global counter, generates requestId,
/// and (if session_scope is provided) updates that scope's RoutingInstructionState.
pub fn plan_chat_process_session_usage(
    input: ChatProcessSessionUsageInput,
) -> Result<ChatProcessSessionUsageOutput, String> {
    let now = now_ms();

    // 1. Tick global counter
    let mut counter = load_global_request_counter()?;
    let (total, daily) = counter.tick(now);
    persist_global_request_counter(&counter)?;

    // 2. Build requestId
    let request_id = format!("req_{}_{}", total, daily);

    // 3. Update session scope state if provided
    let mut session_state_updated = false;
    if let Some(scope) = resolve_session_usage_scope(&input) {
        if is_persistent_scope(&scope) {
            let mut state = load_routing_instruction_state_strict(&scope)?.unwrap_or_default();
            if let Some(usage) = input.usage.as_ref() {
                if let Some((_, _, total_tokens)) = normalize_usage(usage) {
                    state.chat_process_last_total_tokens = Some(total_tokens);
                }
            }
            if let Some(usage) = input.usage.as_ref() {
                if let Some((input_tokens, _, _)) = normalize_usage(usage) {
                    state.chat_process_last_input_tokens = Some(input_tokens);
                }
            }
            if let Some(captured) = input.captured_chat_request.as_ref() {
                if let Some(count) = read_message_count(captured) {
                    state.chat_process_last_message_count = Some(count.max(0));
                }
            }
            state.chat_process_last_updated_at = Some(now);
            persist_routing_instruction_state_strict(&scope, Some(&state))?;
            session_state_updated = true;
        }
    }

    Ok(ChatProcessSessionUsageOutput {
        request_id,
        total_requests: total,
        daily_requests: daily,
        session_state_updated,
    })
}

fn is_persistent_scope(key: &str) -> bool {
    key.starts_with("session:") || key.starts_with("conversation:") || key.starts_with("tmux:")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::virtual_router_engine::routing_state_store::GlobalRequestCounter;
    use chrono::{Datelike, Local, Timelike};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn local_day_str() -> String {
        let now = Local::now();
        format!("{:04}-{:02}-{:02}", now.year(), now.month(), now.day())
    }

    fn with_isolated_counter<T>(callback: impl FnOnce(&std::path::Path) -> T) -> T {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "rcc-chat-process-session-usage-{}-{}",
            std::process::id(),
            unique
        ));
        fs::create_dir_all(&dir).unwrap();
        let result = crate::virtual_router_engine::routing_state_store::with_session_dir_override(
            dir.to_str(),
            || callback(&dir),
        );
        let _ = fs::remove_dir_all(&dir);
        result
    }

    #[test]
    fn generates_req_format_request_id() {
        with_isolated_counter(|_| {
            let input = ChatProcessSessionUsageInput {
                session_scope: None,
                context: None,
                usage: None,
                captured_chat_request: None,
                request_id: None,
            };
            let output = plan_chat_process_session_usage(input).unwrap();
            assert!(output.request_id.starts_with("req_"));
            assert!(output.request_id.matches('_').count() == 2);
            let parts: Vec<&str> = output
                .request_id
                .strip_prefix("req_")
                .unwrap()
                .split('_')
                .collect();
            assert_eq!(parts.len(), 2);
            assert!(parts[0].parse::<i64>().is_ok());
            assert!(parts[1].parse::<i64>().is_ok());
        });
    }

    #[test]
    fn counter_increments_on_each_call() {
        with_isolated_counter(|_| {
            let input1 = ChatProcessSessionUsageInput {
                session_scope: None,
                context: None,
                usage: None,
                captured_chat_request: None,
                request_id: None,
            };
            let out1 = plan_chat_process_session_usage(input1).unwrap();

            let input2 = ChatProcessSessionUsageInput {
                session_scope: None,
                context: None,
                usage: None,
                captured_chat_request: None,
                request_id: None,
            };
            let out2 = plan_chat_process_session_usage(input2).unwrap();

            assert_eq!(
                out2.total_requests - out1.total_requests,
                1,
                "total must increment by exactly 1"
            );
            assert_eq!(
                out2.daily_requests - out1.daily_requests,
                1,
                "daily must increment by exactly 1"
            );
        });
    }

    #[test]
    fn usage_normalizes_tokens() {
        with_isolated_counter(|_| {
            let input = ChatProcessSessionUsageInput {
                session_scope: None,
                context: None,
                usage: Some(serde_json::json!({
                    "input_tokens": 100.0,
                    "completion_tokens": 50.0,
                    "total_tokens": 150.0
                })),
                captured_chat_request: None,
                request_id: None,
            };
            let output = plan_chat_process_session_usage(input.clone()).unwrap();
            assert!(output.request_id.starts_with("req_"));
        });
    }

    #[test]
    fn message_count_extracted() {
        with_isolated_counter(|_| {
            let input = ChatProcessSessionUsageInput {
                session_scope: None,
                context: None,
                usage: Some(serde_json::json!({"total_tokens": 100})),
                captured_chat_request: Some(serde_json::json!({
                    "messages": [
                        {"role": "user", "content": "hi"},
                        {"role": "assistant", "content": "hello"}
                    ]
                })),
                request_id: None,
            };
            let output = plan_chat_process_session_usage(input).unwrap();
            assert!(output.request_id.starts_with("req_"));
        });
    }

    #[test]
    fn counter_daily_resets_on_new_local_day() {
        let mut counter = GlobalRequestCounter::new();
        let yesterday = (Local::now() - chrono::Duration::days(1)).date_naive();
        let yesterday_str = format!(
            "{:04}-{:02}-{:02}",
            yesterday.year(),
            yesterday.month(),
            yesterday.day()
        );
        counter.last_request_day = Some(yesterday_str);
        counter.total_requests = 99;
        counter.daily_requests = 88;
        counter.last_request_at_ms = 0;

        let now = Local::now();
        let today_str = local_day_str();

        let (total, daily) = counter.tick(now.timestamp_millis());

        assert_eq!(total, 100);
        assert_eq!(daily, 1, "daily must reset to 1 on new local day");
        assert_eq!(counter.last_request_day.as_deref(), Some(&*today_str));
    }

    #[test]
    fn counter_same_day_keeps_daily() {
        let mut counter = GlobalRequestCounter::new();
        let now = Local::now();
        let today_str = local_day_str();
        counter.last_request_day = Some(today_str.clone());
        counter.total_requests = 50;
        counter.daily_requests = 10;
        counter.last_request_at_ms = 0;

        let (total, daily) = counter.tick(now.timestamp_millis());

        assert_eq!(total, 51);
        assert_eq!(daily, 11, "daily must increment when same local day");
        assert_eq!(counter.last_request_day.as_deref(), Some(&*today_str));
    }

    #[test]
    fn counter_never_zero() {
        let mut counter = GlobalRequestCounter::new();
        let now = Local::now();
        let (total, daily) = counter.tick(now.timestamp_millis());
        assert!(total >= 1);
        assert!(daily >= 1);
    }

    #[test]
    fn current_local_day_format() {
        let (day_str, day_start_ms) = GlobalRequestCounter::current_local_day();
        let parts: Vec<&str> = day_str.split('-').collect();
        assert_eq!(parts.len(), 3);
        assert!(parts[0].len() == 4);
        assert!(parts[1].len() == 2);
        assert!(parts[2].len() == 2);
        assert!(day_start_ms > 0);
        assert!(day_start_ms <= Local::now().timestamp_millis());
    }

    #[test]
    fn parse_day_start_ms_midnight_local() {
        let day = "2026-06-29";
        let ms = GlobalRequestCounter::parse_day_start_ms(day);
        assert!(ms.is_some());
        let ms = ms.unwrap();
        let dt = chrono::DateTime::from_timestamp_millis(ms).unwrap();
        let local = dt.with_timezone(&Local);
        assert_eq!(local.year(), 2026);
        assert_eq!(local.month(), 6);
        assert_eq!(local.day(), 29);
        assert_eq!(local.hour(), 0);
        assert_eq!(local.minute(), 0);
        assert_eq!(local.second(), 0);
    }

    #[test]
    fn parse_day_start_ms_invalid() {
        assert!(GlobalRequestCounter::parse_day_start_ms("2026-6-29").is_none());
        assert!(GlobalRequestCounter::parse_day_start_ms("2026-13-01").is_none());
        assert!(GlobalRequestCounter::parse_day_start_ms("not-a-date").is_none());
        assert!(GlobalRequestCounter::parse_day_start_ms("").is_none());
    }

    #[test]
    fn tmux_session_usage_writeback_updates_routing_state() {
        with_isolated_counter(|_| {
            let input = ChatProcessSessionUsageInput {
                session_scope: None,
                context: Some(serde_json::json!({
                    "clientTmuxSessionId": "session-usage-test"
                })),
                usage: Some(serde_json::json!({
                    "input_tokens": 11,
                    "output_tokens": 7,
                    "total_tokens": 18
                })),
                captured_chat_request: Some(serde_json::json!({
                    "messages": [
                        {"role": "user", "content": "hi"},
                        {"role": "assistant", "content": "hello"},
                        {"role": "user", "content": "again"}
                    ]
                })),
                request_id: None,
            };

            let output = plan_chat_process_session_usage(input).unwrap();
            assert!(output.session_state_updated);
            let state =
                crate::virtual_router_engine::routing_state_store::load_routing_instruction_state(
                    "tmux:session-usage-test",
                )
                .expect("tmux routing state should be written");

            assert_eq!(state.chat_process_last_input_tokens, Some(11));
            assert_eq!(state.chat_process_last_total_tokens, Some(18));
            assert_eq!(state.chat_process_last_message_count, Some(3));
            assert!(state.chat_process_last_updated_at.unwrap_or_default() > 0);
        });
    }

    #[test]
    fn corrupt_global_counter_fails_fast() {
        with_isolated_counter(|dir| {
            fs::write(dir.join("global-request-counter.json"), "{bad-json").unwrap();
            let input = ChatProcessSessionUsageInput {
                session_scope: None,
                context: None,
                usage: None,
                captured_chat_request: None,
                request_id: None,
            };

            let error = plan_chat_process_session_usage(input).unwrap_err();
            assert!(error.contains("failed to parse global request counter"));
        });
    }
}
