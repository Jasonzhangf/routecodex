use super::super::*;

pub(crate) const ANSI_RESET: &str = "\x1b[0m";
pub(crate) const ANSI_WHITE: &str = "\x1b[97m";
pub(crate) const ANSI_ERROR_RED: &str = "\x1b[31m";
pub(crate) const ANSI_STOPLESS_PURPLE: &str = "\x1b[35m";

pub(crate) fn is_v3_console_color_enabled() -> bool {
    let routecodex_force = std::env::var("ROUTECODEX_FORCE_LOG_COLOR")
        .ok()
        .or_else(|| std::env::var("RCC_FORCE_LOG_COLOR").ok())
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if matches!(routecodex_force.as_str(), "1" | "true" | "yes" | "on") {
        return true;
    }
    if matches!(routecodex_force.as_str(), "0" | "false" | "no" | "off") {
        return false;
    }
    let force_color = std::env::var("FORCE_COLOR").unwrap_or_default();
    if force_color.trim() == "0" {
        return false;
    }
    true
}

pub(crate) fn colorize_v3_request_console_line(line: &str, color_key: Option<&str>) -> String {
    if !is_v3_console_color_enabled() {
        return line.to_string();
    }
    let color = color_key
        .and_then(resolve_v3_session_color)
        .unwrap_or_else(|| "\x1b[36m".to_string());
    let highlighted = highlight_v3_console_data_values(line, &color);
    format!("{}{}{}", color, highlighted, ANSI_RESET)
}

pub(crate) fn colorize_v3_error_console_line(line: &str) -> String {
    if !is_v3_console_color_enabled() {
        return line.to_string();
    }
    format!(
        "{}{}{}",
        ANSI_ERROR_RED,
        highlight_v3_console_data_values(line, ANSI_ERROR_RED),
        ANSI_RESET
    )
}

pub(crate) fn colorize_v3_stopless_console_line(line: &str) -> String {
    if !is_v3_console_color_enabled() {
        return line.to_string();
    }
    format!(
        "{}{}{}",
        ANSI_STOPLESS_PURPLE,
        highlight_v3_console_data_values(line, ANSI_STOPLESS_PURPLE),
        ANSI_RESET
    )
}

pub(crate) fn highlight_v3_console_data_values(line: &str, base_color: &str) -> String {
    let prefix_end = leading_v3_console_scope_prefix_end(line);
    let mut output = String::with_capacity(line.len());
    if prefix_end > 0 {
        output.push_str(&highlight_v3_console_scope_prefix_values(
            &line[..prefix_end],
            base_color,
        ));
        output.push_str(&highlight_v3_console_non_kv_data_values(
            &line[prefix_end..],
            base_color,
        ));
    } else {
        output.push_str(&highlight_v3_console_non_kv_data_values(line, base_color));
    }
    highlight_v3_console_key_values(&output, base_color)
}

pub(crate) fn leading_v3_console_scope_prefix_end(line: &str) -> usize {
    let mut index = 0;
    let bytes = line.as_bytes();
    while index < line.len() && bytes.get(index) == Some(&b'[') {
        let Some(close_relative) = line[index..].find(']') else {
            break;
        };
        let close = index + close_relative;
        index = close + 1;
    }
    index
}

pub(crate) fn highlight_v3_console_scope_prefix_values(prefix: &str, base_color: &str) -> String {
    let mut output = String::with_capacity(prefix.len());
    let mut remaining = prefix;
    while let Some(rest) = remaining.strip_prefix('[') {
        let Some(close) = rest.find(']') else {
            output.push_str(remaining);
            break;
        };
        let scope = &rest[..close];
        output.push('[');
        if let Some((left, session_id)) = scope.split_once(":sessionID:") {
            let mut parts = left.splitn(2, ':');
            let port = parts.next().unwrap_or(left);
            let protocol = parts.next();
            push_v3_console_data_value(&mut output, port, base_color);
            if let Some(protocol) = protocol {
                output.push(':');
                output.push_str(protocol);
            }
            output.push_str(":sessionID:");
            push_v3_console_data_value(&mut output, session_id, base_color);
        } else {
            push_v3_console_data_value(&mut output, scope, base_color);
        }
        output.push(']');
        remaining = &rest[close + 1..];
    }
    output.push_str(remaining);
    output
}

pub(crate) fn highlight_v3_console_non_kv_data_values(line: &str, base_color: &str) -> String {
    let mut output = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\x1b' {
            output.push(character);
            for next in chars.by_ref() {
                output.push(next);
                if next == 'm' {
                    break;
                }
            }
            continue;
        }
        if character == '[' {
            let mut bracket_value = String::new();
            while let Some(next) = chars.peek().copied() {
                chars.next();
                if next == ']' {
                    break;
                }
                bracket_value.push(next);
            }
            if bracket_value.starts_with('/') {
                output.push('[');
                push_v3_console_data_value(&mut output, &bracket_value, base_color);
                output.push(']');
            } else {
                output.push('[');
                output.push_str(&bracket_value);
                output.push(']');
            }
            continue;
        }
        if character.is_ascii_digit() && looks_like_v3_console_time(&chars) {
            output.push_str(ANSI_WHITE);
            output.push(character);
            for _ in 0..7 {
                let Some(next) = chars.next() else {
                    break;
                };
                output.push(next);
            }
            output.push_str(ANSI_RESET);
            output.push_str(base_color);
            continue;
        }
        output.push(character);
    }
    output
}

pub(crate) fn looks_like_v3_console_time(chars: &std::iter::Peekable<std::str::Chars<'_>>) -> bool {
    let lookahead = chars.clone().take(7).collect::<String>();
    let bytes = lookahead.as_bytes();
    bytes.len() == 7
        && bytes[0].is_ascii_digit()
        && bytes[1] == b':'
        && bytes[2].is_ascii_digit()
        && bytes[3].is_ascii_digit()
        && bytes[4] == b':'
        && bytes[5].is_ascii_digit()
        && bytes[6].is_ascii_digit()
}

pub(crate) fn highlight_v3_console_key_values(line: &str, base_color: &str) -> String {
    let mut output = String::with_capacity(line.len());
    let mut remaining = line;
    while let Some(index) = remaining.find('=') {
        let (before_equal, after_equal) = remaining.split_at(index);
        let key_start = before_equal
            .rfind(|character: char| {
                !(character.is_ascii_alphanumeric() || character == '_' || character == '.')
            })
            .map(|position| position + 1)
            .unwrap_or(0);
        let key = &before_equal[key_start..];
        if key.is_empty() || !is_v3_console_highlight_key(key) {
            output.push_str(&remaining[..index + 1]);
            remaining = &after_equal[1..];
            continue;
        }
        let value = &after_equal[1..];
        let value_end = if key == "message" {
            value.len()
        } else {
            value.find([' ', ',']).unwrap_or(value.len())
        };
        output.push_str(&before_equal[..key_start]);
        output.push_str(key);
        output.push('=');
        push_v3_console_data_value(&mut output, &value[..value_end], base_color);
        remaining = &value[value_end..];
    }
    output.push_str(remaining);
    output
}

pub(crate) fn push_v3_console_data_value(output: &mut String, value: &str, base_color: &str) {
    output.push_str(ANSI_WHITE);
    output.push_str(value);
    output.push_str(ANSI_RESET);
    output.push_str(base_color);
}

pub(crate) fn is_v3_console_highlight_key(key: &str) -> bool {
    matches!(
        key,
        "stream"
            | "event"
            | "acceptsSse"
            | "timeoutMs"
            | "rawInputItems"
            | "preparedInputItems"
            | "plannedEntryMode"
            | "resumeFullInputItems"
            | "resumeDeltaInputItems"
            | "status"
            | "code"
            | "error"
            | "subcode"
            | "node"
            | "errorNode"
            | "errorChain"
            | "model"
            | "wire"
            | "type"
            | "provider"
            | "providerKey"
            | "providerStatus"
            | "responseStatus"
            | "finishReason"
            | "finish_reason"
            | "route"
            | "routeName"
            | "pool"
            | "path"
            | "attempts"
            | "unavailable"
            | "transport"
            | "failures"
            | "health"
            | "cooldownUntilMs"
            | "waitMs"
            | "next"
            | "message"
            | "selected"
            | "from"
            | "to"
            | "elapsedMs"
            | "nodes"
            | "endpoint"
            | "project"
            | "cwd"
            | "req"
            | "sid"
            | "reason"
            | "usage"
            | "usage_in"
            | "usage_out"
            | "usage_cache"
            | "usage_total"
            | "time"
            | "time_i"
            | "time_e"
            | "time_t"
            | "pipeline"
            | "target"
            | "upstreamStatus"
            | "upstreamCode"
            | "hook"
            | "callId"
            | "action"
    )
}

pub(crate) fn resolve_v3_log_session_color_key(
    headers: &HeaderMap,
    payload: &Value,
    request_id: &str,
) -> Option<String> {
    let turn_metadata = parse_codex_turn_metadata(headers).ok().flatten();
    let explicit_session = first_header_text(
        headers,
        &[
            "session-id",
            "session_id",
            "x-session-id",
            "x-routecodex-session-id",
            "x-rcc-session-id",
        ],
    )
    .ok()
    .flatten()
    .or_else(|| read_first_scope_value(turn_metadata.as_ref(), TURN_METADATA_SESSION_PATHS))
    .or_else(|| read_first_scope_value(Some(payload), BODY_SESSION_PATHS));
    if explicit_session.is_some() {
        return explicit_session;
    }
    let explicit_conversation = first_header_text(
        headers,
        &[
            "thread-id",
            "thread_id",
            "conversation-id",
            "conversation_id",
            "x-conversation-id",
            "x-routecodex-conversation-id",
        ],
    )
    .ok()
    .flatten()
    .or_else(|| read_first_scope_value(turn_metadata.as_ref(), TURN_METADATA_CONVERSATION_PATHS))
    .or_else(|| read_first_scope_value(Some(payload), BODY_CONVERSATION_PATHS));
    if explicit_conversation.is_some() {
        return explicit_conversation;
    }
    let client_type = infer_v3_log_client_type(headers);
    let tmux_scope = first_header_text(
        headers,
        &[
            "x-routecodex-client-tmux-session-id",
            "x-rcc-client-tmux-session-id",
            "x-routecodex-tmux-session-id",
            "x-rcc-tmux-session-id",
            "x-tmux-session-id",
        ],
    )
    .ok()
    .flatten()
    .or_else(|| read_first_scope_value(turn_metadata.as_ref(), TURN_METADATA_TMUX_PATHS));
    let workdir = first_header_text(
        headers,
        &["x-routecodex-workdir", "x-rcc-workdir", "x-workdir"],
    )
    .ok()
    .flatten()
    .or_else(|| read_first_scope_value(turn_metadata.as_ref(), TURN_METADATA_WORKDIR_PATHS))
    .or_else(|| read_first_scope_value(Some(payload), BODY_WORKDIR_PATHS));
    let mut parts = Vec::new();
    for value in [client_type, tmux_scope, workdir] {
        if let Some(part) = value.and_then(|candidate| normalize_v3_log_session_part(&candidate)) {
            parts.push(part);
        }
    }
    if parts.is_empty() {
        normalize_v3_log_session_part(request_id).map(|part| format!("rcc-session:request:{part}"))
    } else {
        Some(format!("rcc-session:{}", parts.join(":")))
    }
}

pub(crate) fn infer_v3_log_client_type(headers: &HeaderMap) -> Option<String> {
    let user_agent = header_text(headers, "user-agent")
        .ok()
        .flatten()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let originator = header_text(headers, "originator")
        .ok()
        .flatten()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if user_agent.contains("codex") || originator.contains("codex") {
        Some("codex".to_string())
    } else if user_agent.contains("claude") || originator.contains("claude") {
        Some("claude".to_string())
    } else {
        None
    }
}

pub(crate) fn normalize_v3_log_session_part(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

pub(crate) fn resolve_v3_session_color(session_id: &str) -> Option<String> {
    if session_id.trim().is_empty() {
        return None;
    }
    let hash = hash_v3_session_log_color_token(session_id.trim());
    let mut hue = (hash % 3600) as f64 / 10.0;
    if !(18.0..342.0).contains(&hue) {
        hue = (hue + 47.0) % 360.0;
    }
    let saturation = 0.62 + (((hash >> 12) & 0xff) as f64 / 255.0) * 0.24;
    let lightness = 0.50 + (((hash >> 20) & 0xff) as f64 / 255.0) * 0.16;
    let (red, green, blue) = hsl_to_rgb(hue, saturation, lightness);
    Some(format!("\x1b[38;2;{};{};{}m", red, green, blue))
}

pub(crate) fn hash_v3_session_log_color_token(value: &str) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for byte in value.bytes() {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    hash ^= hash >> 16;
    hash = hash.wrapping_mul(0x7feb352d);
    hash ^= hash >> 15;
    hash = hash.wrapping_mul(0x846ca68b);
    hash ^= hash >> 16;
    hash
}

pub(crate) fn hsl_to_rgb(hue: f64, saturation: f64, lightness: f64) -> (u8, u8, u8) {
    let chroma = (1.0 - (2.0 * lightness - 1.0).abs()) * saturation;
    let hue_prime = hue / 60.0;
    let x = chroma * (1.0 - ((hue_prime % 2.0) - 1.0).abs());
    let (r1, g1, b1) = if hue_prime < 1.0 {
        (chroma, x, 0.0)
    } else if hue_prime < 2.0 {
        (x, chroma, 0.0)
    } else if hue_prime < 3.0 {
        (0.0, chroma, x)
    } else if hue_prime < 4.0 {
        (0.0, x, chroma)
    } else if hue_prime < 5.0 {
        (x, 0.0, chroma)
    } else {
        (chroma, 0.0, x)
    };
    let m = lightness - chroma / 2.0;
    let to_channel = |value: f64| -> u8 { ((value + m).clamp(0.0, 1.0) * 255.0).round() as u8 };
    (to_channel(r1), to_channel(g1), to_channel(b1))
}

pub(crate) fn console_timestamp_hhmmss() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as libc::time_t)
        .unwrap_or(0);
    console_timestamp_hhmmss_for_epoch_seconds(seconds).unwrap_or_else(|_| {
        let seconds = u64::try_from(seconds).unwrap_or(0) % 86_400;
        let hour = seconds / 3_600;
        let minute = (seconds % 3_600) / 60;
        let second = seconds % 60;
        format!("{hour:02}:{minute:02}:{second:02}")
    })
}

pub(crate) fn console_timestamp_hhmmss_for_epoch_seconds(
    seconds: libc::time_t,
) -> Result<String, String> {
    let local = format_v3_tm(seconds, true)?;
    Ok(format!(
        "{:02}:{:02}:{:02}",
        local.hour, local.minute, local.second
    ))
}
