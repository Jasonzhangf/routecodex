mod impl_bulk;
mod impl_display;
pub(crate) use impl_bulk::*;
pub(crate) use impl_display::*;

use serde_json::Value;

pub(crate) fn read_injected_workspace_cwd_from_payload(payload: &Value) -> Option<String> {
    for message in payload.get("messages").and_then(Value::as_array)? {
        let Some(role) = message.get("role").and_then(Value::as_str) else {
            continue;
        };
        if !role.eq_ignore_ascii_case("system") {
            continue;
        }
        let content = match message.get("content") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(parts)) => parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => continue,
        };
        if let Some(cwd) = read_injected_workspace_cwd_from_text(&content) {
            return Some(cwd);
        }
    }
    None
}

fn read_injected_workspace_cwd_from_text(text: &str) -> Option<String> {
    for marker in ["Current workspace: ", "Working directory: "] {
        let Some(idx) = text.find(marker) else {
            continue;
        };
        let tail = &text[idx + marker.len()..];
        let trimmed = tail.trim_start();
        let quote_start = trimmed.find('"')? + 1;
        let path = &trimmed[quote_start..];
        let quote_end = path.find('"')?;
        let cwd = path[..quote_end].trim();
        if !cwd.is_empty() {
            return Some(cwd.to_string());
        }
    }
    None
}

pub(crate) fn align_display_width(value: &str, width: usize) -> String {
    let display_width = display_width(value);
    if display_width >= width {
        return value.to_string();
    }
    format!("{value}{}", " ".repeat(width - display_width))
}

pub(crate) fn fit_display_width(value: &str, width: usize) -> String {
    let truncated = truncate_display_width_middle(value, width);
    align_display_width(&truncated, width)
}

pub(crate) fn truncate_display_width_middle(value: &str, width: usize) -> String {
    if display_width(value) <= width {
        return value.to_string();
    }
    assert!(width >= 3, "v3 console truncation width must fit marker");
    let remaining_width = width - 3;
    let prefix_width = (remaining_width + 1) / 2;
    let suffix_width = remaining_width / 2;

    let mut prefix = String::new();
    let mut used_prefix_width = 0;
    for character in value.chars() {
        let character_width = char_display_width(character);
        if used_prefix_width + character_width > prefix_width {
            break;
        }
        prefix.push(character);
        used_prefix_width += character_width;
    }

    let mut suffix = Vec::new();
    let mut used_suffix_width = 0;
    for character in value.chars().rev() {
        let character_width = char_display_width(character);
        if used_suffix_width + character_width > suffix_width {
            break;
        }
        suffix.push(character);
        used_suffix_width += character_width;
    }
    suffix.reverse();
    format!("{prefix}...{}", suffix.into_iter().collect::<String>())
}

pub(crate) fn display_width(value: &str) -> usize {
    value.chars().map(char_display_width).sum()
}

pub(crate) fn char_display_width(character: char) -> usize {
    let codepoint = character as u32;
    if character.is_control()
        || matches!(
            codepoint,
            0x0300..=0x036F
                | 0x1AB0..=0x1AFF
                | 0x1DC0..=0x1DFF
                | 0x20D0..=0x20FF
                | 0xFE00..=0xFE0F
        )
    {
        0
    } else if matches!(
        codepoint,
        0x1100..=0x115F
            | 0x2329..=0x232A
            | 0x2E80..=0xA4CF
            | 0xAC00..=0xD7A3
            | 0xF900..=0xFAFF
            | 0xFE10..=0xFE19
            | 0xFE30..=0xFE6F
            | 0xFF00..=0xFF60
            | 0xFFE0..=0xFFE6
            | 0x2705
            | 0x274C
            | 0x1F000..=0x1FAFF
            | 0x20000..=0x3FFFD
    ) {
        2
    } else {
        1
    }
}
