//! Diagnostic category marker and shell projection formatter.
//!
//! The formatter is deliberately observation-only: it receives already typed
//! lifecycle/request facts and returns terminal text. It never reads or
//! reconstructs business payload/control state.

const ANSI_RESET: &str = "\x1b[0m";
const ANSI_CYAN: &str = "\x1b[36m";
const ANSI_DIM: &str = "\x1b[2;90m";
const ANSI_ERROR: &str = "\x1b[31m";
const ANSI_ORANGE: &str = "\x1b[38;5;208m";
const ANSI_GREEN: &str = "\x1b[32m";

fn colorize(color: &str, text: String) -> String {
    if !color_enabled() {
        text
    } else {
        format!("{color}{text}{ANSI_RESET}")
    }
}

fn color_enabled() -> bool {
    if std::env::var_os("NO_COLOR").is_some()
        || std::env::var("FORCE_COLOR").ok().as_deref() == Some("0")
    {
        return false;
    }
    match std::env::var("ROUTECODEX_FORCE_LOG_COLOR")
        .or_else(|_| std::env::var("RCC_FORCE_LOG_COLOR"))
        .ok()
        .as_deref()
    {
        Some("0") | Some("false") | Some("off") => false,
        _ => true,
    }
}

fn session_color(value: &str) -> String {
    let mut hash = 0x811c9dc5u32;
    for byte in value.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x01000193);
    }
    format!("\x1b[38;5;{}m", 24 + (hash % 192))
}

fn session_key(object: &serde_json::Map<String, serde_json::Value>) -> Option<&str> {
    [
        "session_id",
        "sessionId",
        "conversation_id",
        "conversationId",
    ]
    .iter()
    .find_map(|key| object.get(*key).and_then(serde_json::Value::as_str))
}

pub fn format_startup(
    identity: &str,
    version: &str,
    binary: &str,
    listeners: &[String],
) -> (String, String) {
    let addresses = listeners.join(", ");
    let headline = colorize(
        ANSI_GREEN,
        format!("[RouteCodexV4] Server started on {addresses}"),
    );
    let debug = colorize(
        ANSI_DIM,
        format!("event=started identity={identity} version={version} binary={binary} addresses={addresses}"),
    );
    (headline, debug)
}

pub fn format_request(endpoint: &str, request_id: &str, model: &str, target: &str) -> String {
    colorize(
        ANSI_CYAN,
        format!("▶ [{endpoint}] req={request_id} model={model} target={target}"),
    )
}

pub fn format_response(endpoint: &str, request_id: &str, status: u16, model: &str) -> String {
    colorize(
        ANSI_GREEN,
        format!("✅ [{endpoint}] req={request_id} status={status} model={model}"),
    )
}

/// Render the canonical payload at Chat Process boundaries. The event carries
/// only terminal-safe text; the business payload never enters the diagnostic
/// side channel.
pub fn format_chat_process_payload(
    direction: &str,
    payload: &serde_json::Value,
) -> Result<String, String> {
    format_chat_process_payload_with_stream(direction, payload, None)
}

/// Render a request payload with a typed admission stream fact when the
/// protocol body omitted its default. The override is diagnostic-only: it
/// never mutates or re-serializes the business payload.
pub fn format_chat_process_payload_with_stream(
    direction: &str,
    payload: &serde_json::Value,
    stream_override: Option<bool>,
) -> Result<String, String> {
    let object = payload
        .as_object()
        .ok_or_else(|| "Chat Process payload must be an object".to_string())?;
    let model = object
        .get("model")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("-");
    let stream = object
        .get("stream")
        .and_then(serde_json::Value::as_bool)
        .or(stream_override);
    let messages = object
        .get("messages")
        .and_then(serde_json::Value::as_array)
        .map_or(0, Vec::len);
    let tools = object
        .get("tools")
        .and_then(serde_json::Value::as_array)
        .map_or(0, Vec::len);
    let output = object
        .get("output")
        .and_then(serde_json::Value::as_array)
        .map_or(0, Vec::len);
    let usage = object.get("usage").and_then(serde_json::Value::as_object);
    let usage_text = usage.map_or_else(String::new, |value| {
        let input = value
            .get("input_tokens")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let output = value
            .get("output_tokens")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        format!(" usage={input}+{output}={}", input + output)
    });
    let suffix = stream.map_or_else(String::new, |value| format!(" stream={value}"));
    let (icon, label, headline_color) = match direction {
        "request" => ("▶", "req", ANSI_CYAN),
        "response" => ("✅", "resp", ANSI_GREEN),
        "error" => ("✗", "err", ANSI_ERROR),
        "stopless" => ("⏸", "stopless", ANSI_ORANGE),
        other => ("•", other, ANSI_DIM),
    };
    let body = match direction {
        "request" => format!("model={model}{suffix} messages={messages} tools={tools}"),
        "response" => format!("model={model} output_items={output}{usage_text}"),
        "error" => format!("model={model} error=true"),
        "stopless" => format!("model={model} continuation=true"),
        _ => format!("model={model}"),
    };
    let session = session_key(object).map_or_else(String::new, |value| {
        if color_enabled() {
            format!(" {}session={value}{ANSI_RESET}", session_color(value))
        } else {
            format!(" session={value}")
        }
    });
    let line = format!("{icon} [{label}] {body}{session}");
    Ok(colorize(headline_color, line))
}

pub fn format_error_event(payload: &serde_json::Value, class: &str) -> String {
    let model = payload
        .get("model")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("-");
    format_chat_event("error", &format!("model={model} class={class}"), payload)
}

pub fn format_stopless_event(payload: &serde_json::Value, reason: &str) -> String {
    let model = payload
        .get("model")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("-");
    format_chat_event(
        "stopless",
        &format!("model={model} reason={reason}"),
        payload,
    )
}

fn format_chat_event(kind: &str, body: &str, payload: &serde_json::Value) -> String {
    let object = payload
        .as_object()
        .expect("Chat Process payload must be an object");
    let (icon, color) = match kind {
        "error" => ("✗", ANSI_ERROR),
        "stopless" => ("⏸", ANSI_ORANGE),
        _ => ("•", ANSI_DIM),
    };
    let session = session_key(object).map_or_else(String::new, |value| {
        if color_enabled() {
            format!(" {}session={value}{ANSI_RESET}", session_color(value))
        } else {
            format!(" session={value}")
        }
    });
    colorize(color, format!("{icon} [{kind}] {body}{session}"))
}

#[cfg(test)]
mod tests {
    use super::format_chat_process_payload;
    use serde_json::json;

    #[test]
    fn request_render_filters_to_compact_summary() {
        let rendered = format_chat_process_payload(
            "request",
            &json!({"model":"gpt-test","stream":true,"messages":[{},{}],"tools":[{}],"secret":"hidden"}),
        )
        .expect("request payload renders");
        assert!(rendered.contains("model=gpt-test"));
        assert!(rendered.contains("messages=2"));
        assert!(!rendered.contains("hidden"));
    }

    #[test]
    fn response_render_keeps_usage_without_content() {
        let rendered = format_chat_process_payload(
            "response",
            &json!({"model":"gpt-test","output":[{}],"usage":{"input_tokens":3,"output_tokens":5},"content":"private"}),
        )
        .expect("response payload renders");
        assert!(rendered.contains("output_items=1"));
        assert!(rendered.contains("usage=3+5=8"));
        assert!(!rendered.contains("private"));
    }

    #[test]
    fn error_and_stopless_use_distinct_layers_and_stable_session_color() {
        let payload = json!({"model":"m","session_id":"same-session"});
        let error = super::format_error_event(&payload, "provider_timeout");
        let stopless = super::format_stopless_event(&payload, "servertool_continue");
        assert!(error.contains("class=provider_timeout"));
        assert!(stopless.contains("reason=servertool_continue"));
        assert!(error.contains("session=same-session"));
        assert_eq!(
            super::session_color("same-session"),
            super::session_color("same-session")
        );
    }
}
