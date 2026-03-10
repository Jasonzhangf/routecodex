use serde_json::{json, Map, Value};

fn detect_media_kind(part: &Map<String, Value>) -> Option<&'static str> {
    let token = part
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if token.is_empty() {
        return None;
    }
    if token.contains("video") {
        return Some("video");
    }
    if token.contains("image") {
        return Some("image");
    }
    None
}

fn is_inline_base64(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return false;
    }
    if normalized.starts_with("data:") && normalized.contains(";base64,") {
        return true;
    }
    normalized.starts_with("base64,")
}

fn push_candidate(candidates: &mut Vec<String>, value: Option<&Value>) {
    let Some(raw) = value else {
        return;
    };
    if let Some(text) = raw.as_str() {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            candidates.push(trimmed.to_string());
        }
    }
}

fn push_nested_candidates(candidates: &mut Vec<String>, value: Option<&Value>) {
    let Some(row) = value.and_then(|v| v.as_object()) else {
        return;
    };
    push_candidate(candidates, row.get("url"));
    push_candidate(candidates, row.get("data"));
    if let Some(base64) = row.get("base64").and_then(|v| v.as_str()) {
        let trimmed = base64.trim();
        if !trimmed.is_empty() {
            candidates.push(format!("base64,{}", trimmed));
        }
    }
}

fn media_part_carries_inline_base64(part: &Map<String, Value>) -> bool {
    let mut candidates: Vec<String> = Vec::new();

    push_candidate(&mut candidates, part.get("image_url"));
    push_candidate(&mut candidates, part.get("video_url"));
    push_candidate(&mut candidates, part.get("url"));
    push_candidate(&mut candidates, part.get("uri"));
    push_candidate(&mut candidates, part.get("data"));

    if let Some(base64) = part.get("base64").and_then(|v| v.as_str()) {
        let trimmed = base64.trim();
        if !trimmed.is_empty() {
            candidates.push(format!("base64,{}", trimmed));
        }
    }

    push_nested_candidates(&mut candidates, part.get("image_url"));
    push_nested_candidates(&mut candidates, part.get("video_url"));

    candidates.iter().any(|value| is_inline_base64(value))
}

fn build_history_placeholder(kind: &str) -> Value {
    let token = if kind == "video" {
        "[history_video_base64_omitted]"
    } else {
        "[history_image_base64_omitted]"
    };
    json!({
        "type": "text",
        "text": token
    })
}

pub(super) fn apply_kimi_history_media_placeholder(root: &mut Map<String, Value>) {
    let Some(messages) = root.get_mut("messages").and_then(|v| v.as_array_mut()) else {
        return;
    };
    if messages.is_empty() {
        return;
    }

    let mut latest_user_index: Option<usize> = None;
    for idx in (0..messages.len()).rev() {
        let role = messages[idx]
            .as_object()
            .and_then(|row| row.get("role"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if role == "user" {
            latest_user_index = Some(idx);
            break;
        }
    }

    let Some(boundary) = latest_user_index else {
        return;
    };
    if boundary == 0 {
        return;
    }

    for idx in 0..boundary {
        let Some(message_obj) = messages[idx].as_object_mut() else {
            continue;
        };
        let Some(content_parts) = message_obj
            .get_mut("content")
            .and_then(|v| v.as_array_mut())
        else {
            continue;
        };

        for part in content_parts.iter_mut() {
            let replacement = part
                .as_object()
                .and_then(|part_obj| {
                    detect_media_kind(part_obj)
                        .map(|kind| (kind, media_part_carries_inline_base64(part_obj)))
                })
                .and_then(|(kind, carries)| {
                    if carries {
                        Some(build_history_placeholder(kind))
                    } else {
                        None
                    }
                });
            if let Some(next) = replacement {
                *part = next;
            }
        }
    }
}
