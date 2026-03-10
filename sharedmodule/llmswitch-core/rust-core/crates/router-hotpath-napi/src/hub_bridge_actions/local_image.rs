use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use regex::Regex;
use serde_json::Value;

use crate::hub_reasoning_tool_normalizer::is_image_path_json;

use super::types::{
    AppendLocalImageBlockOnLatestUserInputInput, AppendLocalImageBlockOnLatestUserInputOutput,
};

fn decode_escaped_path_like_text(input: &str) -> String {
    if !input.contains('\\') {
        return input.to_string();
    }

    let mut chars = input.chars().peekable();
    let mut out = String::new();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.peek().copied() {
            Some('/') => {
                chars.next();
                out.push('/');
            }
            Some('\\') => {
                chars.next();
                out.push('\\');
            }
            Some('u') => {
                chars.next();
                let hex: String = chars.by_ref().take(4).collect();
                if hex.len() == 4 {
                    if let Ok(codepoint) = u32::from_str_radix(&hex, 16) {
                        if let Some(decoded) = char::from_u32(codepoint) {
                            out.push(decoded);
                            continue;
                        }
                    }
                }
                out.push_str("\\u");
                out.push_str(&hex);
            }
            Some('x') => {
                chars.next();
                let hex: String = chars.by_ref().take(2).collect();
                if hex.len() == 2 {
                    if let Ok(codepoint) = u32::from_str_radix(&hex, 16) {
                        if let Some(decoded) = char::from_u32(codepoint) {
                            out.push(decoded);
                            continue;
                        }
                    }
                }
                out.push_str("\\x");
                out.push_str(&hex);
            }
            Some(other) => {
                out.push('\\');
                out.push(other);
                chars.next();
            }
            None => out.push('\\'),
        }
    }
    out
}

fn is_image_path_value(candidate: &str) -> bool {
    match is_image_path_json(
        serde_json::to_string(candidate).unwrap_or_else(|_| "\"\"".to_string()),
    ) {
        Ok(raw) => serde_json::from_str::<bool>(&raw).unwrap_or(false),
        Err(_) => false,
    }
}

fn decode_percent_escapes(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut index = 0usize;
    let mut out = Vec::<u8>::with_capacity(bytes.len());
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
            let decoded = u8::from_str_radix(hex, 16).ok()?;
            out.push(decoded);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).ok()
}

fn normalize_local_image_path(candidate: &str) -> Option<String> {
    let mut value = decode_escaped_path_like_text(candidate.trim());
    if value.is_empty() {
        return None;
    }
    if value.to_ascii_lowercase().starts_with("http://")
        || value.to_ascii_lowercase().starts_with("https://")
    {
        return None;
    }

    if value.to_ascii_lowercase().starts_with("file://") {
        value = decode_percent_escapes(&value[7..]).unwrap_or_else(|| value[7..].to_string());
    }

    let normalized_path = if let Some(stripped) = value.strip_prefix('~') {
        match std::env::var("HOME") {
            Ok(home) => PathBuf::from(home).join(stripped),
            Err(_) => PathBuf::from(value),
        }
    } else {
        let path = PathBuf::from(&value);
        if path.is_absolute() {
            path
        } else {
            match std::env::current_dir() {
                Ok(cwd) => cwd.join(path),
                Err(_) => PathBuf::from(value),
            }
        }
    };

    let normalized = normalized_path.to_string_lossy().to_string();
    if is_image_path_value(&normalized) {
        Some(normalized)
    } else {
        None
    }
}

fn collect_local_image_path_candidates(text: &str) -> Vec<String> {
    if text.trim().is_empty() {
        return Vec::new();
    }
    let double_quoted_path_regex =
        Regex::new(r#""([^"]+)""#).expect("valid double quoted path regex");
    let single_quoted_path_regex =
        Regex::new(r#"'([^']+)'"#).expect("valid single quoted path regex");
    let backtick_quoted_path_regex =
        Regex::new(r#"`([^`]+)`"#).expect("valid backtick quoted path regex");
    let bare_path_regex = Regex::new(
        r#"(?:^|[\s(])((?:~|/|\.\.?/)[^\s"'`<>]+?\.(?:png|jpg|jpeg|gif|webp|bmp|svg|tiff?|ico|heic|jxl)[^\s"'`<>]*)"#,
    )
    .expect("valid bare path regex");

    let mut variants = vec![text.to_string()];
    let decoded = decode_escaped_path_like_text(text);
    if decoded != text {
        variants.push(decoded);
    }

    let mut candidates = Vec::<String>::new();
    for variant in variants {
        for regex in [
            &double_quoted_path_regex,
            &single_quoted_path_regex,
            &backtick_quoted_path_regex,
        ] {
            for capture in regex.captures_iter(&variant) {
                if let Some(candidate) = capture
                    .get(1)
                    .and_then(|m| normalize_local_image_path(m.as_str()))
                {
                    if !candidates.contains(&candidate) {
                        candidates.push(candidate);
                    }
                }
            }
        }
        for capture in bare_path_regex.captures_iter(&variant) {
            let trimmed = capture.get(1).map(|m| {
                m.as_str()
                    .trim_end_matches(|ch: char| "),.;!?".contains(ch))
            });
            if let Some(candidate) = trimmed.and_then(normalize_local_image_path) {
                if !candidates.contains(&candidate) {
                    candidates.push(candidate);
                }
            }
        }
    }
    candidates
}

fn detect_image_mime(file_path: &str) -> &'static str {
    match Path::new(file_path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "tif" | "tiff" => "image/tiff",
        "ico" => "image/x-icon",
        "heic" => "image/heic",
        "jxl" => "image/jxl",
        _ => "application/octet-stream",
    }
}

fn encode_local_image_as_data_url(file_path: &str) -> Result<String, String> {
    let image_buffer = fs::read(file_path).map_err(|error| {
        let code = error
            .raw_os_error()
            .map(|value| value.to_string())
            .unwrap_or_else(|| "READ_FAILED".to_string());
        format!("{}: {}", code, error)
    })?;
    let mime_type = detect_image_mime(file_path);
    let base64 = base64::engine::general_purpose::STANDARD.encode(image_buffer);
    Ok(format!("data:{};base64,{}", mime_type, base64))
}

fn message_has_image_content(content: &Value) -> bool {
    let Some(parts) = content.as_array() else {
        return false;
    };
    parts.iter().any(|part| {
        let Some(record) = part.as_object() else {
            return false;
        };
        let type_value = record
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if !matches!(type_value.as_str(), "image_url" | "input_image" | "image") {
            return false;
        }
        match record.get("image_url") {
            Some(Value::String(value)) => !value.trim().is_empty(),
            Some(Value::Object(row)) => row
                .get("url")
                .and_then(Value::as_str)
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false),
            _ => false,
        }
    })
}

fn collect_text_candidates(content: &Value) -> Vec<String> {
    match content {
        Value::String(text) if !text.trim().is_empty() => vec![text.clone()],
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| {
                let record = part.as_object()?;
                let type_value = record
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_ascii_lowercase();
                if !matches!(
                    type_value.as_str(),
                    "text" | "input_text" | "output_text" | "commentary"
                ) {
                    return None;
                }
                record
                    .get("text")
                    .and_then(Value::as_str)
                    .map(|text| text.to_string())
                    .filter(|text| !text.trim().is_empty())
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn normalize_content_parts(content: &Value) -> Vec<Value> {
    match content {
        Value::String(text) => vec![serde_json::json!({ "type": "text", "text": text })],
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| {
                if let Some(record) = part.as_object() {
                    return Some(Value::Object(record.clone()));
                }
                if let Some(text) = part.as_str() {
                    return Some(serde_json::json!({ "type": "text", "text": text }));
                }
                None
            })
            .collect(),
        _ => Vec::new(),
    }
}

pub(crate) fn append_local_image_block_on_latest_user_input(
    input: AppendLocalImageBlockOnLatestUserInputInput,
) -> AppendLocalImageBlockOnLatestUserInputOutput {
    let mut messages = input.messages;

    let latest_user_index = messages.iter().rposition(|message| {
        message
            .as_object()
            .and_then(|row| row.get("role"))
            .and_then(Value::as_str)
            .map(|role| role.trim().eq_ignore_ascii_case("user"))
            .unwrap_or(false)
    });

    let Some(index) = latest_user_index else {
        return AppendLocalImageBlockOnLatestUserInputOutput { messages };
    };

    let Some(latest_user_message) = messages[index].as_object_mut() else {
        return AppendLocalImageBlockOnLatestUserInputOutput { messages };
    };
    let original_content = latest_user_message
        .get("content")
        .cloned()
        .unwrap_or(Value::Null);
    if message_has_image_content(&original_content) {
        return AppendLocalImageBlockOnLatestUserInputOutput { messages };
    }

    let text_candidates = collect_text_candidates(&original_content);
    if text_candidates.is_empty() {
        return AppendLocalImageBlockOnLatestUserInputOutput { messages };
    }

    let mut image_paths = Vec::<String>::new();
    for text in text_candidates {
        for candidate in collect_local_image_path_candidates(&text) {
            if !image_paths.contains(&candidate) {
                image_paths.push(candidate);
            }
        }
    }
    if image_paths.is_empty() {
        return AppendLocalImageBlockOnLatestUserInputOutput { messages };
    }

    let mut normalized_content = normalize_content_parts(&original_content);
    let mut unreadable_image_notices = Vec::<String>::new();
    for image_path in image_paths {
        match encode_local_image_as_data_url(&image_path) {
            Ok(data_url) => {
                normalized_content.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": { "url": data_url }
                }));
            }
            Err(reason) => unreadable_image_notices.push(format!(
                "[local_image_unreadable] 文件不可读，已跳过该图片路径: {} ({})",
                image_path, reason
            )),
        }
    }

    if !unreadable_image_notices.is_empty() {
        normalized_content.push(serde_json::json!({
            "type": "text",
            "text": unreadable_image_notices.join("\n")
        }));
    }

    if !message_has_image_content(&Value::Array(normalized_content.clone()))
        && unreadable_image_notices.is_empty()
    {
        return AppendLocalImageBlockOnLatestUserInputOutput { messages };
    }

    latest_user_message.insert("content".to_string(), Value::Array(normalized_content));
    AppendLocalImageBlockOnLatestUserInputOutput { messages }
}
