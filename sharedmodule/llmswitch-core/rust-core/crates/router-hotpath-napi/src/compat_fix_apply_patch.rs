use napi::bindgen_prelude::Result as NapiResult;
use regex::Regex;
use serde_json::{Map, Value};

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let text = value.and_then(Value::as_str)?.trim();
    if text.is_empty() {
        return None;
    }
    Some(text.to_string())
}

fn decode_escaped_newlines_if_needed(raw: &str) -> String {
    if raw.contains('\n') || !raw.contains("\\n") {
        return raw.to_string();
    }
    raw.replace("\\n", "\n")
}

fn find_first_patch_marker(raw: &str) -> Option<usize> {
    [
        "*** Begin Patch",
        "*** New File:",
        "*** Create File:",
        "*** Add File:",
        "*** Update File:",
        "*** Delete File:",
    ]
    .iter()
    .filter_map(|marker| raw.find(marker))
    .min()
}

fn trim_to_patch_window(raw: &str) -> String {
    let trimmed = raw.trim();
    let Some(start) = find_first_patch_marker(trimmed) else {
        return trimmed.to_string();
    };
    let mut patch = trimmed[start..].trim().to_string();
    if let Some(end_rel) = patch.rfind("*** End Patch") {
        let end = end_rel + "*** End Patch".len();
        patch = patch[..end].trim().to_string();
    }
    patch
}

fn looks_like_patch_body_after_apply_patch_prefix(raw: &str) -> bool {
    let trimmed = raw.trim_start();
    [
        "*** Begin Patch",
        "*** New File:",
        "*** Create File:",
        "*** Add File:",
        "*** Update File:",
        "*** Delete File:",
        "--- ",
        "+++ ",
        "*** a/",
        "*** b/",
        "diff --git ",
    ]
    .iter()
    .any(|marker| trimmed.starts_with(marker) || trimmed.contains(marker))
}

fn strip_apply_patch_command_prefix(raw: &str) -> String {
    let trimmed = raw.trim_start();
    let Some(rest) = trimmed.strip_prefix("apply_patch") else {
        return raw.to_string();
    };
    let stripped = rest.trim_start();
    if stripped.is_empty() || !looks_like_patch_body_after_apply_patch_prefix(stripped) {
        return raw.to_string();
    }
    stripped.to_string()
}

fn has_unified_like_header(text: &str) -> bool {
    text.lines().any(|line| {
        let trimmed = line.trim_start();
        trimmed.starts_with("--- ")
            || trimmed.starts_with("+++ ")
            || trimmed.starts_with("*** a/")
            || trimmed.starts_with("*** b/")
    })
}

fn is_patch_file_header_line(trimmed_line: &str) -> bool {
    trimmed_line.starts_with("*** Add File:")
        || trimmed_line.starts_with("*** Update File:")
        || trimmed_line.starts_with("*** Delete File:")
}

fn drop_empty_update_sections(text: &str) -> String {
    if !text.contains("*** Update File:") {
        return text.to_string();
    }
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    let mut i = 0usize;
    let mut dropped_any = false;

    while i < lines.len() {
        let trimmed = lines[i].trim();
        if !trimmed.starts_with("*** Update File:") {
            out.push(lines[i]);
            i += 1;
            continue;
        }

        let start = i;
        i += 1;
        let mut has_hunk_body = false;
        while i < lines.len() {
            let probe_trimmed = lines[i].trim();
            if is_patch_file_header_line(probe_trimmed) || probe_trimmed.starts_with("*** End Patch") {
                break;
            }
            let probe = lines[i];
            let probe_start = probe.trim_start();
            if probe_start.starts_with("@@")
                || probe.starts_with('+')
                || probe.starts_with('-')
                || probe.starts_with(' ')
            {
                has_hunk_body = true;
            }
            i += 1;
        }

        if has_hunk_body {
            for row in &lines[start..i] {
                out.push(*row);
            }
        } else {
            dropped_any = true;
        }
    }

    if !dropped_any {
        return text.to_string();
    }

    let candidate = out.join("\n").trim().to_string();
    // When all file sections were empty and removed, candidate becomes
    // bare Begin/End markers. Return empty string to signal no valid patch.
    let has_any_file_op = candidate.contains("*** Add File:")
        || candidate.contains("*** Update File:")
        || candidate.contains("*** Delete File:");
    if candidate.is_empty()
        || !candidate.contains("*** Begin Patch")
        || !candidate.contains("*** End Patch")
    {
        return text.to_string();
    }
    if !has_any_file_op {
        return String::new();
    }
    candidate
}

fn normalize_apply_patch_header_path(raw: &str) -> String {
    let mut out = raw.trim().to_string();
    if out.is_empty() {
        return out;
    }
    let bytes = out.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0] as char;
        let last = bytes[bytes.len() - 1] as char;
        let is_wrapped = (first == '"' && last == '"')
            || (first == '\'' && last == '\'')
            || (first == '`' && last == '`');
        if is_wrapped {
            out = out[1..out.len() - 1].trim().to_string();
        }
    }
    out
}

fn normalize_apply_patch_header_line(line: &str) -> String {
    let new_re = Regex::new(r"^\*\*\* New File:\s*(.+?)(?:\s+\*\*\*)?\s*$").unwrap();
    if let Some(caps) = new_re.captures(line) {
        if let Some(path) = caps.get(1) {
            return format!(
                "*** Add File: {}",
                normalize_apply_patch_header_path(path.as_str())
            );
        }
    }
    let create_re = Regex::new(r"^\*\*\* Create File:\s*(.+?)(?:\s+\*\*\*)?\s*$").unwrap();
    if let Some(caps) = create_re.captures(line) {
        if let Some(path) = caps.get(1) {
            return format!(
                "*** Add File: {}",
                normalize_apply_patch_header_path(path.as_str())
            );
        }
    }
    let add_re = Regex::new(r"^\*\*\* Add File:\s*(.+?)(?:\s+\*\*\*)?\s*$").unwrap();
    if let Some(caps) = add_re.captures(line) {
        if let Some(path) = caps.get(1) {
            return format!(
                "*** Add File: {}",
                normalize_apply_patch_header_path(path.as_str())
            );
        }
    }
    let update_re = Regex::new(r"^\*\*\* Update File:\s*(.+?)(?:\s+\*\*\*)?\s*$").unwrap();
    if let Some(caps) = update_re.captures(line) {
        if let Some(path) = caps.get(1) {
            return format!(
                "*** Update File: {}",
                normalize_apply_patch_header_path(path.as_str())
            );
        }
    }
    let delete_re = Regex::new(r"^\*\*\* Delete File:\s*(.+?)(?:\s+\*\*\*)?\s*$").unwrap();
    if let Some(caps) = delete_re.captures(line) {
        if let Some(path) = caps.get(1) {
            return format!(
                "*** Delete File: {}",
                normalize_apply_patch_header_path(path.as_str())
            );
        }
    }
    line.to_string()
}

fn normalize_unified_header_path(raw: &str) -> String {
    let normalized = normalize_apply_patch_header_path(raw);
    if let Some(stripped) = normalized.strip_prefix("a/") {
        return stripped.to_string();
    }
    if let Some(stripped) = normalized.strip_prefix("b/") {
        return stripped.to_string();
    }
    normalized
}

fn is_legacy_context_diff_hunk_header_line(trimmed: &str) -> bool {
    fn matches_legacy_header(trimmed: &str, prefix: &str, suffix: &str) -> bool {
        if !trimmed.starts_with(prefix) || !trimmed.ends_with(suffix) {
            return false;
        }
        let body = trimmed[prefix.len()..trimmed.len() - suffix.len()].trim();
        !body.is_empty()
            && body
                .chars()
                .all(|ch| ch.is_ascii_digit() || ch == ',' || ch.is_whitespace())
    }
    matches_legacy_header(trimmed, "*** ", " ****")
        || matches_legacy_header(trimmed, "--- ", " ----")
}

fn normalize_apply_patch_text(raw: &str) -> String {
    let mut text = decode_escaped_newlines_if_needed(raw).replace("\r\n", "\n");
    text = strip_apply_patch_command_prefix(&text);
    text = trim_to_patch_window(&text);
    if text.is_empty() {
        return text;
    }
    text = text.trim().to_string();
    if text.is_empty() {
        return text;
    }

    text = text.replace("*** New File:", "*** Add File:");
    text = text.replace("*** Create File:", "*** Add File:");
    text = text.replace(
        "*** Begin Patch *** New File:",
        "*** Begin Patch\n*** Add File:",
    );
    text = text.replace(
        "*** Begin Patch *** Add File:",
        "*** Begin Patch\n*** Add File:",
    );
    text = text.replace(
        "*** Begin Patch *** Update File:",
        "*** Begin Patch\n*** Update File:",
    );
    text = text.replace(
        "*** Begin Patch *** Delete File:",
        "*** Begin Patch\n*** Delete File:",
    );
    text = text.replace(
        "*** Begin Patch *** Create File:",
        "*** Begin Patch\n*** Add File:",
    );
    text = text.replace("*** Add File:", "\n*** Add File:");
    text = text.replace("*** Update File:", "\n*** Update File:");
    text = text.replace("*** Delete File:", "\n*** Delete File:");
    text = text.replace("\n\n*** Add File:", "\n*** Add File:");
    text = text.replace("\n\n*** Update File:", "\n*** Update File:");
    text = text.replace("\n\n*** Delete File:", "\n*** Delete File:");

    if text.contains("*** Begin Patch") && text.contains("*** End Patch") && !text.contains('\n') {
        text = text.replace("*** Begin Patch", "*** Begin Patch\n");
        text = text.replace("*** End Patch", "\n*** End Patch");
    }

    let has_begin = text.contains("*** Begin Patch");
    let has_file_header = text.contains("*** Add File:")
        || text.contains("*** Update File:")
        || text.contains("*** Delete File:");
    let has_unified_header = has_unified_like_header(&text);
    if !has_begin && (has_file_header || has_unified_header) {
        text = format!("*** Begin Patch\n{}\n*** End Patch", text.trim());
    } else if has_begin && !text.contains("*** End Patch") {
        text = format!("{}\n*** End Patch", text.trim());
    }

    let mut out: Vec<String> = Vec::new();
    let mut in_add_section = false;
    let mut pending_unified_from: Option<String> = None;
    for line in text.split('\n') {
        let raw_line = line.strip_suffix('\r').unwrap_or(line);
        let mut normalized = normalize_apply_patch_header_line(raw_line.trim());
        if raw_line.trim() == "***************"
            || is_legacy_context_diff_hunk_header_line(raw_line.trim())
        {
            continue;
        }
        if normalized.starts_with("*** a/") {
            normalized = format!("--- {}", normalized.trim_start_matches("*** ").trim());
        } else if normalized.starts_with("*** b/") {
            normalized = format!("+++ {}", normalized.trim_start_matches("*** ").trim());
        }

        if normalized.starts_with("--- ") {
            pending_unified_from =
                Some(normalized.trim_start_matches("--- ").trim().to_string());
            continue;
        }
        if normalized.starts_with("+++ ") {
            let plus_path = normalized.trim_start_matches("+++ ").trim().to_string();
            let minus_path = pending_unified_from.take();
            let plus_is_dev_null = plus_path == "/dev/null";
            let minus_is_dev_null = minus_path.as_deref() == Some("/dev/null");
            if minus_is_dev_null && !plus_is_dev_null {
                out.push(format!(
                    "*** Add File: {}",
                    normalize_unified_header_path(&plus_path)
                ));
                in_add_section = true;
                continue;
            }
            if plus_is_dev_null {
                if let Some(from_path) = minus_path {
                    out.push(format!(
                        "*** Delete File: {}",
                        normalize_unified_header_path(&from_path)
                    ));
                    in_add_section = false;
                    continue;
                }
            }
            let update_path = if !plus_path.is_empty() {
                plus_path
            } else {
                minus_path.unwrap_or_default()
            };
            if !update_path.is_empty() {
                out.push(format!(
                    "*** Update File: {}",
                    normalize_unified_header_path(&update_path)
                ));
                in_add_section = false;
                continue;
            }
        }
        if normalized.starts_with("@@") {
            if let Some(from_path) = pending_unified_from.take() {
                if from_path != "/dev/null" && !from_path.is_empty() {
                    out.push(format!(
                        "*** Update File: {}",
                        normalize_unified_header_path(&from_path)
                    ));
                    in_add_section = false;
                }
            }
        }

        if normalized.starts_with("*** Begin Patch") {
            out.push("*** Begin Patch".to_string());
            in_add_section = false;
            pending_unified_from = None;
            continue;
        }
        if normalized.starts_with("*** End Patch") {
            out.push("*** End Patch".to_string());
            in_add_section = false;
            pending_unified_from = None;
            continue;
        }
        if normalized.starts_with("*** Add File:") {
            out.push(normalized);
            in_add_section = true;
            pending_unified_from = None;
            continue;
        }
        if normalized.starts_with("*** Update File:") || normalized.starts_with("*** Delete File:")
        {
            out.push(normalized);
            in_add_section = false;
            pending_unified_from = None;
            continue;
        }
        if in_add_section {
            if raw_line.starts_with('+') {
                out.push(raw_line.to_string());
            } else {
                out.push(format!("+{}", raw_line));
            }
            continue;
        }
        out.push(raw_line.to_string());
    }

    let mut normalized_out: Vec<String> = Vec::with_capacity(out.len());
    let mut saw_begin_patch = false;
    let mut saw_end_patch = false;
    for row in out {
        let trimmed = row.trim();
        if trimmed == "*** Begin Patch" {
            if saw_begin_patch {
                continue;
            }
            saw_begin_patch = true;
            normalized_out.push("*** Begin Patch".to_string());
            continue;
        }
        if trimmed == "*** End Patch" {
            saw_end_patch = true;
            continue;
        }
        normalized_out.push(row);
    }
    if saw_end_patch {
        normalized_out.push("*** End Patch".to_string());
    }

    let compacted = normalized_out.join("\n").trim().to_string();
    drop_empty_update_sections(compacted.as_str())
}

fn looks_like_apply_patch(normalized_patch: &str) -> bool {
    normalized_patch.contains("*** Begin Patch")
        && normalized_patch.contains("*** End Patch")
        && (normalized_patch.contains("*** Add File:")
            || normalized_patch.contains("*** Update File:")
            || normalized_patch.contains("*** Delete File:"))
}

fn has_unsupported_git_metadata(normalized_patch: &str) -> bool {
    normalized_patch.contains("diff --git ")
        || normalized_patch.contains("\nindex ")
        || normalized_patch.contains("\nsimilarity index ")
        || normalized_patch.contains("\nrename from ")
        || normalized_patch.contains("\nrename to ")
}

fn extract_patch_text_from_argument(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
        return extract_patch_text_from_value(&parsed);
    }
    Some(trimmed.to_string())
}

fn extract_patch_text_from_value(value: &Value) -> Option<String> {
    fn extract_patch_text_from_object(obj: &Map<String, Value>) -> Option<String> {
        read_trimmed_string(obj.get("patch"))
            .or_else(|| read_trimmed_string(obj.get("input")))
            .or_else(|| read_trimmed_string(obj.get("instructions")))
            .or_else(|| read_trimmed_string(obj.get("text")))
            .or_else(|| read_trimmed_string(obj.get("command")))
            .or_else(|| read_trimmed_string(obj.get("cmd")))
            .or_else(|| read_trimmed_string(obj.get("script")))
            .or_else(|| obj.get("result").and_then(extract_patch_text_from_value))
            .or_else(|| obj.get("payload").and_then(extract_patch_text_from_value))
            .or_else(|| obj.get("data").and_then(extract_patch_text_from_value))
            .or_else(|| obj.get("tool_input").and_then(extract_patch_text_from_value))
            .or_else(|| obj.get("toolInput").and_then(extract_patch_text_from_value))
            .or_else(|| obj.get("arguments").and_then(extract_patch_text_from_value))
    }

    match value {
        Value::String(raw) => extract_patch_text_from_argument(raw),
        Value::Object(obj) => extract_patch_text_from_object(obj),
        Value::Array(items) => items.iter().find_map(extract_patch_text_from_value),
        _ => None,
    }
}

fn normalize_apply_patch_tool_arguments_from_patch_text(patch_text: &str) -> Option<String> {
    let normalized_patch = normalize_apply_patch_text(&patch_text);
    if !looks_like_apply_patch(&normalized_patch) {
        // When patch normalized to empty (all sections dropped), still emit valid JSON
        // with an empty patch string so downstream always receives valid JSON shape.
        if normalized_patch.is_empty() {
            return serde_json::to_string(&serde_json::json!({
                "patch": "",
                "input": ""
            })).ok();
        }
        return None;
    }
    if has_unsupported_git_metadata(&normalized_patch) {
        return None;
    }
    serde_json::to_string(&serde_json::json!({
        "patch": normalized_patch,
        "input": normalized_patch
    }))
    .ok()
}

fn normalize_apply_patch_tool_arguments_from_value(raw_arguments: &Value) -> Option<String> {
    let patch_text = extract_patch_text_from_value(raw_arguments)?;
    normalize_apply_patch_tool_arguments_from_patch_text(&patch_text)
}

fn is_apply_patch_name(value: Option<&Value>) -> bool {
    read_trimmed_string(value)
        .map(|name| name == "apply_patch")
        .unwrap_or(false)
}

fn maybe_fix_apply_patch_arguments_on_object(call_obj: &mut Map<String, Value>) -> bool {
    let mut changed = false;

    if is_apply_patch_name(call_obj.get("name")) {
        if let Some(raw_arguments) = call_obj.get("arguments") {
            if let Some(normalized_arguments) =
                normalize_apply_patch_tool_arguments_from_value(raw_arguments)
            {
                let unchanged = raw_arguments
                    .as_str()
                    .map(|raw| raw == normalized_arguments)
                    .unwrap_or(false);
                if !unchanged {
                    call_obj.insert("arguments".to_string(), Value::String(normalized_arguments));
                    changed = true;
                }
            }
        }
    }

    if let Some(function_obj) = call_obj.get_mut("function").and_then(Value::as_object_mut) {
        if is_apply_patch_name(function_obj.get("name")) {
            if let Some(raw_arguments) = function_obj.get("arguments") {
                if let Some(normalized_arguments) =
                    normalize_apply_patch_tool_arguments_from_value(raw_arguments)
                {
                    let unchanged = raw_arguments
                        .as_str()
                        .map(|raw| raw == normalized_arguments)
                        .unwrap_or(false);
                    if !unchanged {
                        function_obj
                            .insert("arguments".to_string(), Value::String(normalized_arguments));
                        changed = true;
                    }
                }
            }
        }
    }

    if changed {
        call_obj.insert("_fixed_apply_patch".to_string(), Value::Bool(true));
    }
    changed
}

#[napi_derive::napi]
pub fn fix_apply_patch_tool_calls_json(payload_json: String) -> NapiResult<String> {
    let mut payload: Value = serde_json::from_str(&payload_json)
        .map_err(|e| napi::Error::from_reason(format!("invalid payload json: {}", e)))?;

    let Some(root_obj) = payload.as_object_mut() else {
        return Err(napi::Error::from_reason(
            "payload must be an object".to_string(),
        ));
    };

    if let Some(messages) = root_obj.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages.iter_mut() {
            let Some(message_obj) = message.as_object_mut() else {
                continue;
            };
            if read_trimmed_string(message_obj.get("role"))
                .map(|role| role != "assistant")
                .unwrap_or(true)
            {
                continue;
            }
            let Some(tool_calls) = message_obj.get_mut("tool_calls").and_then(Value::as_array_mut) else {
                continue;
            };

            for call in tool_calls.iter_mut() {
                let Some(call_obj) = call.as_object_mut() else {
                    continue;
                };
                let call_type = read_trimmed_string(call_obj.get("type")).unwrap_or_default();
                if call_type != "function" {
                    continue;
                }
                let _ = maybe_fix_apply_patch_arguments_on_object(call_obj);
            }
        }
    }

    if let Some(input_items) = root_obj.get_mut("input").and_then(Value::as_array_mut) {
        for item in input_items.iter_mut() {
            let Some(item_obj) = item.as_object_mut() else {
                continue;
            };
            let item_type = read_trimmed_string(item_obj.get("type")).unwrap_or_default();
            if item_type != "function_call" && item_type != "tool_call" {
                continue;
            }
            let _ = maybe_fix_apply_patch_arguments_on_object(item_obj);
        }
    }

    serde_json::to_string(&payload).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::fix_apply_patch_tool_calls_json;
    use serde_json::{json, Value};

    #[test]
    fn fixes_apply_patch_tool_arguments_and_marks_tool_call() {
        let payload = json!({
          "messages": [{
            "role": "assistant",
            "tool_calls": [{
              "type": "function",
              "function": {
                "name": "apply_patch",
                "arguments": "*** Begin Patch *** Add File: foo.ts\nconsole.log('ok');\n*** End Patch"
              }
            }]
          }]
        });
        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        let args = output["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments");
        assert!(args.contains("\"patch\":\"*** Begin Patch\\n*** Add File: foo.ts\\n+console.log('ok');\\n*** End Patch\""));
        assert_eq!(
            output["messages"][0]["tool_calls"][0]["_fixed_apply_patch"],
            Value::Bool(true)
        );
    }

    #[test]
    fn keeps_tool_call_unchanged_when_patch_has_git_metadata() {
        let raw_patch = "*** Begin Patch\n*** Update File: src/a.ts\ndiff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n*** End Patch";
        let payload = json!({
          "messages": [{
            "role": "assistant",
            "tool_calls": [{
              "type": "function",
              "function": {
                "name": "apply_patch",
                "arguments": raw_patch
              }
            }]
          }]
        });
        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        let args = output["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments");
        assert_eq!(args, raw_patch);
        assert!(output["messages"][0]["tool_calls"][0]["_fixed_apply_patch"].is_null());
    }

    #[test]
    fn strips_apply_patch_command_prefix_from_arguments() {
        let payload = json!({
          "messages": [{
            "role": "assistant",
            "tool_calls": [{
              "type": "function",
              "function": {
                "name": "apply_patch",
                "arguments": "apply_patch *** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n-a\\n+b\\n*** End Patch"
              }
            }]
          }]
        });

        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        let args = output["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments");
        let parsed: Value = serde_json::from_str(args).expect("parse normalized arguments");
        let patch = parsed["patch"].as_str().expect("patch");
        assert!(patch.starts_with("*** Begin Patch"));
        assert!(!patch.starts_with("apply_patch "));
        assert_eq!(
            output["messages"][0]["tool_calls"][0]["_fixed_apply_patch"],
            Value::Bool(true)
        );
    }

    #[test]
    fn extracts_patch_from_nested_command_wrapper_payload() {
        let payload = json!({
          "messages": [{
            "role": "assistant",
            "tool_calls": [{
              "type": "function",
              "function": {
                "name": "apply_patch",
                "arguments": "{\"ok\":true,\"result\":{\"command\":\"apply_patch *** Begin Patch\\n*** Add File: src/new.ts\\nconsole.log('x');\\n*** End Patch\"}}"
              }
            }]
          }]
        });

        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        let args = output["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments");
        let parsed: Value = serde_json::from_str(args).expect("parse normalized arguments");
        let patch = parsed["patch"].as_str().expect("patch");
        assert!(patch.starts_with("*** Begin Patch"));
        assert!(patch.contains("*** Add File: src/new.ts"));
        assert!(patch.contains("+console.log('x');"));
        assert_eq!(
            output["messages"][0]["tool_calls"][0]["_fixed_apply_patch"],
            Value::Bool(true)
        );
    }

    #[test]
    fn fixes_apply_patch_arguments_inside_responses_input_function_call_items() {
        let payload = json!({
          "input": [{
            "type": "function_call",
            "name": "apply_patch",
            "arguments": "apply_patch *** Begin Patch\\n*** Add File: src/zen.ts\\nconsole.log('zen');\\n*** End Patch"
          }]
        });
        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        let args = output["input"][0]["arguments"].as_str().expect("arguments");
        assert!(args.contains("\"patch\":\"*** Begin Patch\\n*** Add File: src/zen.ts\\n+console.log('zen');\\n*** End Patch\""));
        assert_eq!(output["input"][0]["_fixed_apply_patch"], Value::Bool(true));
    }

    #[test]
    fn fixes_apply_patch_arguments_when_only_input_items_exist() {
        let payload = json!({
          "input": [{
            "type": "function_call",
            "name": "apply_patch",
            "arguments": {
              "command": "apply_patch *** Begin Patch\n*** Add File: src/input-only.ts\nconsole.log('ok');\n*** End Patch"
            }
          }]
        });
        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        let args = output["input"][0]["arguments"].as_str().expect("arguments string");
        let parsed: Value = serde_json::from_str(args).expect("parse normalized arguments");
        let patch = parsed["patch"].as_str().expect("patch");
        assert!(patch.contains("*** Add File: src/input-only.ts"));
        assert!(patch.contains("+console.log('ok');"));
        assert_eq!(output["input"][0]["_fixed_apply_patch"], Value::Bool(true));
    }

    #[test]
    fn preserves_blank_lines_in_add_file_payloads() {
        let payload = json!({
          "messages": [{
            "role": "assistant",
            "tool_calls": [{
              "type": "function",
              "function": {
                "name": "apply_patch",
                "arguments": "apply_patch *** Begin Patch\n*** Add File: src/blank-lines.ts\nconst first = true;\n\nconst third = true;\n*** End Patch"
              }
            }]
          }]
        });
        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        let args = output["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments");
        let parsed: Value = serde_json::from_str(args).expect("parse normalized arguments");
        let patch = parsed["patch"].as_str().expect("patch");
        assert!(patch.contains("+const first = true;\n+\n+const third = true;"));
    }

    #[test]
    fn normalizes_begin_patch_with_legacy_unified_header_missing_plus_line() {
        let payload = json!({
          "messages": [{
            "role": "assistant",
            "tool_calls": [{
              "type": "function",
              "function": {
                "name": "apply_patch",
                "arguments": "*** Begin Patch\n--- a/apps/mobile-app/src/services/mobileWebdavSync.ts\n@@ -1 +1 @@\n-old\n+new\n*** End Patch"
              }
            }]
          }]
        });
        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        let args = output["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments");
        let parsed: Value = serde_json::from_str(args).expect("parse normalized arguments");
        let patch = parsed["patch"].as_str().expect("patch");
        assert!(patch.contains("*** Update File: apps/mobile-app/src/services/mobileWebdavSync.ts"));
        assert!(!patch.contains("--- a/apps/mobile-app/src/services/mobileWebdavSync.ts"));
        assert!(patch.contains("@@ -1 +1 @@"));
        assert_eq!(
            output["messages"][0]["tool_calls"][0]["_fixed_apply_patch"],
            Value::Bool(true)
        );
    }

    #[test]
    fn normalizes_legacy_new_file_header_to_add_file() {
        let payload = json!({
          "messages": [{
            "role": "assistant",
            "tool_calls": [{
              "type": "function",
              "function": {
                "name": "apply_patch",
                "arguments": "*** Begin Patch\n*** New File: src/cli/init.mjs\nconsole.log('ok');\n*** End Patch"
              }
            }]
          }]
        });
        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        let args = output["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments");
        let parsed: Value = serde_json::from_str(args).expect("parse normalized arguments");
        let patch = parsed["patch"].as_str().expect("patch");
        assert!(patch.contains("*** Add File: src/cli/init.mjs"));
        assert!(!patch.contains("*** New File:"));
        assert!(patch.contains("+console.log('ok');"));
        assert_eq!(
            output["messages"][0]["tool_calls"][0]["_fixed_apply_patch"],
            Value::Bool(true)
        );
    }

    #[test]
    fn normalizes_apply_patch_prefix_with_unified_diff_without_begin_patch() {
        let payload = json!({
          "input": [{
            "type": "function_call",
            "name": "apply_patch",
            "arguments": {
              "command": "apply_patch --- a/HEARTBEAT.md\n+++ b/HEARTBEAT.md\n@@ -1 +1 @@\n-old\n+new"
            }
          }]
        });
        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        let args = output["input"][0]["arguments"].as_str().expect("arguments string");
        let parsed: Value = serde_json::from_str(args).expect("parse normalized arguments");
        let patch = parsed["patch"].as_str().expect("patch");
        assert!(patch.starts_with("*** Begin Patch"));
        assert!(patch.contains("*** Update File: HEARTBEAT.md"));
        assert!(!patch.contains("--- a/HEARTBEAT.md"));
        assert!(patch.contains("@@ -1 +1 @@"));
        assert!(patch.ends_with("*** End Patch"));
    }

    #[test]
    fn normalizes_star_header_unified_diff_wrapped_by_begin_patch() {
        let payload = json!({
          "messages": [{
            "role": "assistant",
            "tool_calls": [{
              "type": "function",
              "function": {
                "name": "apply_patch",
                "arguments": "*** Begin Patch\n*** a/apps/webauto/entry/lib/session-init.mjs\n+++ b/apps/webauto/entry/lib/session-init.mjs\n@@ -1 +1 @@\n-old\n+new\n*** End Patch"
              }
            }]
          }]
        });
        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        let args = output["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments");
        let parsed: Value = serde_json::from_str(args).expect("parse normalized arguments");
        let patch = parsed["patch"].as_str().expect("patch");
        assert!(patch.contains("*** Update File: apps/webauto/entry/lib/session-init.mjs"));
        assert!(!patch.contains("*** a/apps/webauto/entry/lib/session-init.mjs"));
        assert!(!patch.contains("+++ b/apps/webauto/entry/lib/session-init.mjs"));
    }

    #[test]
    fn strips_context_diff_separator_lines_inside_begin_patch_update_file() {
        let payload = json!({
          "messages": [{
            "role": "assistant",
            "tool_calls": [{
              "type": "function",
              "function": {
                "name": "apply_patch",
                "arguments": "*** Begin Patch\n*** Update File: src/a.ts\n***************\n@@ -1 +1 @@\n-old\n+new\n*** End Patch"
              }
            }]
          }]
        });
        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        let args = output["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments");
        let parsed: Value = serde_json::from_str(args).expect("parse normalized arguments");
        let patch = parsed["patch"].as_str().expect("patch");
        assert!(patch.contains("*** Update File: src/a.ts"));
        assert!(patch.contains("@@ -1 +1 @@"));
        assert!(!patch.contains("***************"));
    }

    #[test]
    fn drops_empty_update_file_section_when_no_hunk_body_present() {
        let payload = json!({
          "messages": [{
            "role": "assistant",
            "tool_calls": [{
              "type": "function",
              "function": {
                "name": "apply_patch",
                "arguments": "*** Begin Patch\n*** Update File: src/empty.ts\n*** End Patch"
              }
            }]
          }]
        });
        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        let args = output["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments");
        let parsed: Value = serde_json::from_str(args).expect("parse normalized arguments");
        let patch = parsed["patch"].as_str().expect("patch");
        assert!(!patch.contains("*** Update File: src/empty.ts"));
    }

    #[test]
    fn strips_legacy_context_diff_hunk_headers_when_unified_hunk_exists() {
        let payload = json!({
          "messages": [{
            "role": "assistant",
            "tool_calls": [{
              "type": "function",
              "function": {
                "name": "apply_patch",
                "arguments": "*** Begin Patch\n*** Update File: src/a.ts\n*** 369,387 ****\n--- 369,387 ----\n@@ -1 +1 @@\n-old\n+new\n*** End Patch"
              }
            }]
          }]
        });
        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        let args = output["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments");
        let parsed: Value = serde_json::from_str(args).expect("parse normalized arguments");
        let patch = parsed["patch"].as_str().expect("patch");
        assert!(patch.contains("*** Update File: src/a.ts"));
        assert!(patch.contains("@@ -1 +1 @@"));
        assert!(!patch.contains("*** 369,387 ****"));
        assert!(!patch.contains("--- 369,387 ----"));
    }

    #[test]
    fn keeps_single_trailing_end_patch_when_input_contains_duplicates() {
        let payload = json!({
          "messages": [{
            "role": "assistant",
            "tool_calls": [{
              "type": "function",
              "function": {
                "name": "apply_patch",
                "arguments": "*** Begin Patch\n*** Update File: src/a.ts\n@@ -1 +1 @@\n-old\n+new\n*** End Patch\n*** End Patch"
              }
            }]
          }]
        });
        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        let args = output["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments");
        let parsed: Value = serde_json::from_str(args).expect("parse normalized arguments");
        let patch = parsed["patch"].as_str().expect("patch");
        assert_eq!(patch.matches("*** End Patch").count(), 1);
        assert!(patch.ends_with("*** End Patch"));
    }

}
