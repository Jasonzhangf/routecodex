use napi_derive::napi;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

const TOOL_CALL_JSON_MARKER: &str = "\"tool_calls\"";

#[derive(Debug, Serialize, Deserialize)]
pub struct ToolGovernanceInput {
    pub payload: Value,
    pub client_protocol: String,
    pub entry_endpoint: String,
    pub request_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ToolGovernanceSummary {
    pub applied: bool,
    pub tool_calls_normalized: i64,
    pub apply_patch_repaired: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ToolGovernanceOutput {
    pub governed_payload: Value,
    pub summary: ToolGovernanceSummary,
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if raw.is_empty() {
        return None;
    }
    Some(raw)
}

fn read_string_array_command(value: Option<&Value>) -> Option<String> {
    let parts = value.and_then(|v| v.as_array())?;
    let tokens: Vec<String> = parts
        .iter()
        .map(|item| match item {
            Value::String(v) => v.trim().to_string(),
            Value::Null => String::new(),
            other => other.to_string().trim().to_string(),
        })
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.is_empty() {
        return None;
    }
    Some(tokens.join(" "))
}

fn parse_json_record(value: Option<&Value>) -> Option<Map<String, Value>> {
    fn escape_newlines_inside_json_strings(raw: &str) -> String {
        let mut out = String::with_capacity(raw.len());
        let mut in_string = false;
        let mut escaped = false;
        for ch in raw.chars() {
            if in_string {
                if escaped {
                    escaped = false;
                    out.push(ch);
                    continue;
                }
                if ch == '\\' {
                    escaped = true;
                    out.push(ch);
                    continue;
                }
                if ch == '"' {
                    in_string = false;
                    out.push(ch);
                    continue;
                }
                if ch == '\n' {
                    out.push_str("\\n");
                    continue;
                }
                if ch == '\r' {
                    out.push_str("\\r");
                    continue;
                }
                out.push(ch);
                continue;
            }

            if ch == '"' {
                in_string = true;
            }
            out.push(ch);
        }
        out
    }

    match value {
        Some(Value::Object(row)) => Some(row.clone()),
        Some(Value::String(raw)) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Some(Map::new());
            }
            let parsed: Value = serde_json::from_str(trimmed)
                .or_else(|_| serde_json::from_str(&escape_newlines_inside_json_strings(trimmed)))
                .ok()?;
            parsed.as_object().cloned()
        }
        _ => None,
    }
}

fn read_command_from_args(args: &Map<String, Value>) -> Option<String> {
    let input = args.get("input").and_then(|v| v.as_object());
    let direct = read_trimmed_string(args.get("cmd"))
        .or_else(|| read_trimmed_string(args.get("command")))
        .or_else(|| read_trimmed_string(args.get("script")))
        .or_else(|| read_trimmed_string(args.get("toon")))
        .or_else(|| read_string_array_command(args.get("cmd")))
        .or_else(|| read_string_array_command(args.get("command")));
    if direct.is_some() {
        return direct;
    }
    let input_row = input?;
    read_trimmed_string(input_row.get("cmd"))
        .or_else(|| read_trimmed_string(input_row.get("command")))
        .or_else(|| read_trimmed_string(input_row.get("script")))
        .or_else(|| read_string_array_command(input_row.get("cmd")))
        .or_else(|| read_string_array_command(input_row.get("command")))
}

fn read_workdir_from_args(args: &Map<String, Value>) -> Option<String> {
    let input = args.get("input").and_then(|v| v.as_object());
    read_trimmed_string(args.get("workdir"))
        .or_else(|| read_trimmed_string(args.get("cwd")))
        .or_else(|| read_trimmed_string(args.get("workDir")))
        .or_else(|| input.and_then(|row| read_trimmed_string(row.get("workdir"))))
        .or_else(|| input.and_then(|row| read_trimmed_string(row.get("cwd"))))
}

fn decode_escaped_newlines_if_needed(raw: &str) -> String {
    if raw.contains('\n') || !raw.contains("\\n") {
        return raw.to_string();
    }
    raw.replace("\\n", "\n")
}

fn extract_apply_patch_text(raw_args: Option<&Value>) -> Option<String> {
    match raw_args {
        Some(Value::String(raw)) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
                return extract_apply_patch_text(Some(&parsed));
            }
            Some(
                decode_escaped_newlines_if_needed(trimmed)
                    .trim()
                    .to_string(),
            )
        }
        Some(Value::Object(row)) => read_trimmed_string(row.get("patch"))
            .or_else(|| read_trimmed_string(row.get("input")))
            .or_else(|| read_trimmed_string(row.get("instructions")))
            .or_else(|| read_trimmed_string(row.get("text"))),
        _ => None,
    }
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

fn normalize_apply_patch_text(raw: &str) -> String {
    let mut text = decode_escaped_newlines_if_needed(raw)
        .replace("\r\n", "\n")
        .trim()
        .to_string();
    if text.is_empty() {
        return text;
    }

    text = text.replace("*** Create File:", "*** Add File:");

    // Some models emit single-line markers like:
    // "*** Begin Patch *** Create File: a.ts ... *** End Patch"
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
    if !has_begin && has_file_header {
        text = format!("*** Begin Patch\n{}\n*** End Patch", text.trim());
    } else if has_begin && !text.contains("*** End Patch") {
        text = format!("{}\n*** End Patch", text.trim());
    }

    let mut out: Vec<String> = Vec::new();
    let mut in_add_section = false;
    for line in text.split('\n') {
        let normalized = normalize_apply_patch_header_line(line.trim_end());
        if normalized.starts_with("*** Begin Patch") {
            out.push("*** Begin Patch".to_string());
            in_add_section = false;
            continue;
        }
        if normalized.starts_with("*** End Patch") {
            out.push("*** End Patch".to_string());
            in_add_section = false;
            continue;
        }
        if normalized.starts_with("*** Add File:") {
            out.push(normalized);
            in_add_section = true;
            continue;
        }
        if normalized.starts_with("*** Update File:") || normalized.starts_with("*** Delete File:")
        {
            out.push(normalized);
            in_add_section = false;
            continue;
        }
        if in_add_section {
            if normalized.starts_with('+') {
                out.push(normalized);
            } else {
                out.push(format!("+{}", normalized));
            }
            continue;
        }
        out.push(normalized);
    }

    out.join("\n").trim().to_string()
}

fn normalize_tool_name(raw_name: &str) -> Option<String> {
    let mut lowered = raw_name.trim().to_ascii_lowercase();
    if lowered.is_empty() {
        return None;
    }
    if let Some(stripped) = lowered.strip_prefix("functions.") {
        lowered = stripped.trim().to_string();
    }

    let canonical = lowered.as_str();
    let known = matches!(
        canonical,
        "exec_command"
            | "shell_command"
            | "shell"
            | "bash"
            | "terminal"
            | "write_stdin"
            | "apply_patch"
            | "update_plan"
            | "view_image"
            | "list_mcp_resources"
            | "read_mcp_resource"
            | "list_mcp_resource_templates"
            | "list_directory"
    );
    if !known {
        return None;
    }
    Some(canonical.to_string())
}

fn normalize_tool_args(tool_name: &str, raw_args: Option<&Value>) -> Option<String> {
    let name = normalize_tool_name(tool_name)?;
    let args = parse_json_record(raw_args).unwrap_or_default();

    if name == "exec_command" {
        let cmd = read_command_from_args(&args)?;
        let mut out = Map::new();
        out.insert("cmd".to_string(), Value::String(cmd.clone()));
        out.insert("command".to_string(), Value::String(cmd));
        if let Some(workdir) = read_workdir_from_args(&args) {
            out.insert("workdir".to_string(), Value::String(workdir));
        }
        return serde_json::to_string(&Value::Object(out)).ok();
    }

    if matches!(
        name.as_str(),
        "shell_command" | "shell" | "bash" | "terminal"
    ) {
        let command = read_command_from_args(&args)?;
        let mut out = Map::new();
        out.insert("command".to_string(), Value::String(command));
        if let Some(workdir) = read_workdir_from_args(&args) {
            out.insert("cwd".to_string(), Value::String(workdir));
        }
        return serde_json::to_string(&Value::Object(out)).ok();
    }

    if name == "write_stdin" {
        let mut out = Map::new();
        let session_id = args
            .get("session_id")
            .or_else(|| args.get("sessionId"))
            .and_then(|v| match v {
                Value::Number(_) => Some(v.clone()),
                Value::String(raw) => raw.parse::<i64>().ok().map(|n| Value::Number(n.into())),
                _ => None,
            })?;
        out.insert("session_id".to_string(), session_id);

        let chars = args
            .get("chars")
            .or_else(|| args.get("text"))
            .or_else(|| args.get("input"))
            .or_else(|| args.get("data"))
            .cloned()
            .unwrap_or(Value::String(String::new()));
        out.insert(
            "chars".to_string(),
            Value::String(match chars {
                Value::String(v) => v,
                other => other.to_string(),
            }),
        );

        return serde_json::to_string(&Value::Object(out)).ok();
    }

    if name == "apply_patch" {
        let patch = extract_apply_patch_text(raw_args)?;
        let patch = normalize_apply_patch_text(&patch);
        if patch.is_empty() {
            return None;
        }
        let mut out = Map::new();
        out.insert("patch".to_string(), Value::String(patch.clone()));
        out.insert("input".to_string(), Value::String(patch));
        return serde_json::to_string(&Value::Object(out)).ok();
    }

    serde_json::to_string(&Value::Object(args)).ok()
}

fn extract_balanced_json_object_at(text: &str, start_index: usize) -> Option<String> {
    let bytes = text.as_bytes();
    if start_index >= bytes.len() || bytes[start_index] != b'{' {
        return None;
    }

    let mut depth = 0i64;
    let mut in_string = false;
    let mut escaped = false;

    for idx in start_index..bytes.len() {
        let ch = bytes[idx];
        if in_string {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == b'\\' {
                escaped = true;
                continue;
            }
            if ch == b'"' {
                in_string = false;
            }
            continue;
        }

        if ch == b'"' {
            in_string = true;
            continue;
        }
        if ch == b'{' {
            depth += 1;
            continue;
        }
        if ch == b'}' {
            depth -= 1;
            if depth == 0 {
                return Some(text[start_index..=idx].to_string());
            }
        }
    }

    None
}

fn extract_json_candidates_from_text(text: &str) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut seen = HashSet::new();
    let trimmed = text.trim();

    if !trimmed.is_empty() {
        if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
            out.push(parsed);
            seen.insert(trimmed.to_string());
        }
    }

    let mut cursor = 0usize;
    while let Some(rel_start) = text[cursor..].find("```") {
        let fence_start = cursor + rel_start;
        let lang_end = text[fence_start + 3..]
            .find('\n')
            .map(|v| fence_start + 3 + v)
            .unwrap_or(fence_start + 3);
        let content_start = if lang_end < text.len() {
            lang_end + 1
        } else {
            lang_end
        };
        let rest = &text[content_start..];
        let Some(rel_end) = rest.find("```") else {
            break;
        };
        let fence_end = content_start + rel_end;
        let block = text[content_start..fence_end].trim();
        if !block.is_empty() && !seen.contains(block) {
            if let Ok(parsed) = serde_json::from_str::<Value>(block) {
                out.push(parsed);
                seen.insert(block.to_string());
            }
        }
        cursor = fence_end + 3;
    }

    if text.contains(TOOL_CALL_JSON_MARKER) {
        let mut search_from = 0usize;
        while let Some(rel_idx) = text[search_from..].find(TOOL_CALL_JSON_MARKER) {
            let idx = search_from + rel_idx;
            let prefix = &text[..idx];
            if let Some(open_brace_idx) = prefix.rfind('{') {
                if let Some(segment) = extract_balanced_json_object_at(text, open_brace_idx) {
                    let normalized = segment.trim().to_string();
                    if !normalized.is_empty() && !seen.contains(&normalized) {
                        if let Ok(parsed) = serde_json::from_str::<Value>(&normalized) {
                            out.push(parsed);
                            seen.insert(normalized);
                        }
                    }
                }
            }
            search_from = idx + TOOL_CALL_JSON_MARKER.len();
        }
    }

    out
}

fn normalize_tool_call_entry(entry: &Value, fallback_id: usize) -> Option<Value> {
    let row = entry.as_object()?;
    let fn_row = row.get("function").and_then(|v| v.as_object());

    let raw_name = read_trimmed_string(row.get("name"))
        .or_else(|| fn_row.and_then(|f| read_trimmed_string(f.get("name"))))?;
    let canonical_name = normalize_tool_name(&raw_name)?;

    let args_source = row
        .get("input")
        .or_else(|| row.get("arguments"))
        .or_else(|| fn_row.and_then(|f| f.get("arguments")))
        .or_else(|| fn_row.and_then(|f| f.get("input")));
    let normalized_args = normalize_tool_args(&canonical_name, args_source)?;

    let call_id = read_trimmed_string(row.get("call_id"))
        .or_else(|| read_trimmed_string(row.get("id")))
        .unwrap_or_else(|| format!("call_{}", fallback_id));

    Some(json!({
        "id": call_id,
        "type": "function",
        "function": {
            "name": canonical_name,
            "arguments": normalized_args
        }
    }))
}

fn extract_tool_call_entries_from_unknown(value: &Value) -> Vec<Value> {
    if let Some(rows) = value.as_array() {
        return rows
            .iter()
            .enumerate()
            .filter_map(|(idx, entry)| normalize_tool_call_entry(entry, idx + 1))
            .collect();
    }

    let Some(row) = value.as_object() else {
        return Vec::new();
    };

    if let Some(tool_calls) = row.get("tool_calls") {
        return extract_tool_call_entries_from_unknown(tool_calls);
    }

    normalize_tool_call_entry(value, 1)
        .map(|call| vec![call])
        .unwrap_or_default()
}

fn extract_tool_calls_from_qwen_markers(text: &str, fallback_start_id: usize) -> Vec<Value> {
    fn normalize_qwen_marker_tokens(input: &str) -> String {
        let mut normalized = input.to_string();
        let replacements = [
            (
                r"(?is)<\|\s*tool_calls_section_begin\s*\|>",
                "<|tool_calls_section_begin|>",
            ),
            (
                r"(?is)<\|\s*tool_calls_section_end\s*\|>",
                "<|tool_calls_section_end|>",
            ),
            (r"(?is)<\|\s*tool_call_begin\s*\|>", "<|tool_call_begin|>"),
            (
                r"(?is)<\|\s*tool_call_argument_begin\s*\|>",
                "<|tool_call_argument_begin|>",
            ),
            (r"(?is)<\|\s*tool_call_end\s*\|>", "<|tool_call_end|>"),
        ];
        for (pattern, target) in replacements {
            if let Ok(re) = Regex::new(pattern) {
                normalized = re.replace_all(&normalized, target).to_string();
            }
        }
        normalized
    }

    let normalized_text = normalize_qwen_marker_tokens(text);
    let marker_re = match Regex::new(
        r"(?is)<\|tool_call_begin\|>\s*([^\s<]+)\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>",
    ) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let mut recovered: Vec<Value> = Vec::new();
    for (index, captures) in marker_re.captures_iter(&normalized_text).enumerate() {
        let raw_tool = captures
            .get(1)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        if raw_tool.is_empty() {
            continue;
        }
        let tool_name = raw_tool.split(':').next().map(|v| v.trim()).unwrap_or("");
        let Some(canonical_name) = normalize_tool_name(tool_name) else {
            continue;
        };

        let raw_args = match captures.get(2) {
            Some(m) => m.as_str().trim().to_string(),
            None => "{}".to_string(),
        };
        let normalized_args = normalize_tool_args(&canonical_name, Some(&Value::String(raw_args)))
            .unwrap_or_else(|| "{}".to_string());

        recovered.push(json!({
            "id": format!("call_{}", fallback_start_id + index),
            "type": "function",
            "function": {
                "name": canonical_name,
                "arguments": normalized_args
            }
        }));
    }

    recovered
}

fn read_message_text_candidates(message: &Map<String, Value>) -> Vec<String> {
    let mut out = Vec::new();

    if let Some(content) = message.get("content") {
        match content {
            Value::String(text) => {
                if !text.trim().is_empty() {
                    out.push(text.clone());
                }
            }
            Value::Array(parts) => {
                for part in parts {
                    let Some(part_row) = part.as_object() else {
                        continue;
                    };
                    if let Some(text) = read_trimmed_string(part_row.get("text")) {
                        out.push(text);
                        continue;
                    }
                    if let Some(text) = read_trimmed_string(part_row.get("content")) {
                        out.push(text);
                    }
                }
            }
            _ => {}
        }
    }

    if let Some(reasoning) = read_trimmed_string(message.get("reasoning")) {
        out.push(reasoning);
    }
    if let Some(thinking) = read_trimmed_string(message.get("thinking")) {
        out.push(thinking);
    }

    out
}

fn normalize_shell_script_line(raw: &str) -> String {
    let trimmed = raw.trim_start();
    if let Some(rest) = trimmed.strip_prefix('$') {
        return rest.trim_start().to_string();
    }
    trimmed.to_string()
}

fn read_default_workdir_from_env() -> Option<String> {
    let candidates = ["ROUTECODEX_WORKDIR", "RCC_WORKDIR", "CLAUDE_WORKDIR"];
    for key in candidates {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim().to_string();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    None
}

fn build_bash_lc_command(script: &str) -> Option<String> {
    let lines = script
        .lines()
        .map(normalize_shell_script_line)
        .collect::<Vec<String>>();
    let normalized = lines.join("\n").trim().to_string();
    if normalized.is_empty() {
        return None;
    }
    let lowered = normalized.to_ascii_lowercase();
    if lowered.starts_with("bash -lc ")
        || lowered.starts_with("bash -c ")
        || lowered.starts_with("zsh -lc ")
        || lowered.starts_with("sh -lc ")
    {
        return Some(normalized);
    }
    // Single-quoted shell string escape: ' -> '"'"'
    let escaped = normalized.replace('\'', "'\"'\"'");
    Some(format!("bash -lc '{}'", escaped))
}

fn extract_exec_command_from_bash_fence(text: &str, fallback_id: usize) -> Option<Value> {
    let fence_re =
        Regex::new(r"(?is)```(?:bash|sh|zsh|shell|shellscript)\s*([\s\S]*?)\s*```").ok()?;
    let mut picked_command: Option<String> = None;
    for captures in fence_re.captures_iter(text) {
        let script = captures.get(1).map(|m| m.as_str().trim()).unwrap_or("");
        if script.is_empty() {
            continue;
        }
        let command = match build_bash_lc_command(script) {
            Some(value) => value,
            None => continue,
        };
        picked_command = Some(command);
    }

    let command = picked_command?;
    let mut args = Map::new();
    args.insert("cmd".to_string(), Value::String(command.clone()));
    args.insert("command".to_string(), Value::String(command));
    if let Some(workdir) = read_default_workdir_from_env() {
        args.insert("workdir".to_string(), Value::String(workdir));
    }
    let args_str = serde_json::to_string(&Value::Object(args)).ok()?;
    Some(json!({
        "id": format!("call_{}", fallback_id),
        "type": "function",
        "function": {
            "name": "exec_command",
            "arguments": args_str
        }
    }))
}

fn strip_orphan_function_calls_tag(payload: &mut Value) {
    if let Some(choices) = payload.get_mut("choices").and_then(|v| v.as_array_mut()) {
        for choice in choices {
            if let Some(message) = choice.get_mut("message").and_then(|v| v.as_object_mut()) {
                if let Some(content_val) = message.get_mut("content") {
                    if let Some(content) = content_val.as_str() {
                        let new_content = content
                            .replace("<function_calls>", "")
                            .replace("</function_calls>", "");
                        *content_val = Value::String(new_content);
                    }
                }
            }
        }
    }
}

#[napi]
pub fn strip_orphan_function_calls_tag_json(payload_json: String) -> napi::Result<String> {
    if payload_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Payload JSON is empty"));
    }
    let mut payload: Value = serde_json::from_str(&payload_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse payload JSON: {}", e)))?;
    strip_orphan_function_calls_tag(&mut payload);
    serde_json::to_string(&payload)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize payload: {}", e)))
}

fn maybe_harvest_empty_tool_calls_from_json_content(payload: &mut Value) -> i64 {
    let mut harvested = 0i64;
    let Some(choices) = payload.get_mut("choices").and_then(|v| v.as_array_mut()) else {
        return harvested;
    };

    for choice in choices.iter_mut() {
        let Some(choice_row) = choice.as_object_mut() else {
            continue;
        };
        let Some(message) = choice_row
            .get_mut("message")
            .and_then(|v| v.as_object_mut())
        else {
            continue;
        };

        let existing_tool_calls = message.get("tool_calls").and_then(|v| v.as_array());
        if let Some(rows) = existing_tool_calls {
            if !rows.is_empty() {
                continue;
            }
        }

        let mut recovered: Vec<Value> = Vec::new();
        for text in read_message_text_candidates(message) {
            let normalized_text = text
                .replace("<function_calls>", "")
                .replace("</function_calls>", "")
                .trim()
                .to_string();
            if normalized_text.is_empty() {
                continue;
            }
            let lowered = normalized_text.to_ascii_lowercase();
            if lowered.contains("<quote>") && lowered.contains("</quote>") {
                continue;
            }
            if let Some(bash_call) =
                extract_exec_command_from_bash_fence(&normalized_text, (harvested as usize) + 1)
            {
                recovered = vec![bash_call];
                break;
            }
            let qwen_markers =
                extract_tool_calls_from_qwen_markers(&normalized_text, (harvested as usize) + 1);
            if !qwen_markers.is_empty() {
                recovered = qwen_markers;
                break;
            }
            let has_tool_marker = normalized_text.contains(TOOL_CALL_JSON_MARKER)
                || normalized_text.contains("\"name\"")
                || normalized_text.contains("<invoke")
                || normalized_text.contains("<tool_call")
                || normalized_text.contains("<|tool_call_begin|>");
            if !has_tool_marker {
                continue;
            }

            for parsed in extract_json_candidates_from_text(&normalized_text) {
                recovered = extract_tool_call_entries_from_unknown(&parsed);
                if !recovered.is_empty() {
                    break;
                }
            }
            if !recovered.is_empty() {
                break;
            }
        }

        if recovered.is_empty() {
            continue;
        }

        harvested += recovered.len() as i64;
        message.insert("tool_calls".to_string(), Value::Array(recovered));
        message.insert("content".to_string(), Value::String(String::new()));

        let finish_reason = read_trimmed_string(choice_row.get("finish_reason"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if finish_reason.is_empty() || finish_reason == "stop" {
            choice_row.insert(
                "finish_reason".to_string(),
                Value::String("tool_calls".to_string()),
            );
        }
    }

    harvested
}

fn normalize_apply_patch_tool_calls(payload: &mut Value) -> i64 {
    let mut repaired = 0i64;
    let Some(choices) = payload.get_mut("choices").and_then(|v| v.as_array_mut()) else {
        return repaired;
    };

    for choice in choices {
        let Some(message) = choice.get_mut("message").and_then(|v| v.as_object_mut()) else {
            continue;
        };
        let Some(tool_calls) = message.get_mut("tool_calls").and_then(|v| v.as_array_mut()) else {
            continue;
        };

        for tool_call in tool_calls.iter_mut() {
            let Some(function) = tool_call
                .get_mut("function")
                .and_then(|v| v.as_object_mut())
            else {
                continue;
            };
            let Some(name) = read_trimmed_string(function.get("name")) else {
                continue;
            };
            if name.to_ascii_lowercase() != "apply_patch" {
                continue;
            }

            if let Some(args) = function.get_mut("arguments") {
                if let Some(normalized) = normalize_tool_args("apply_patch", Some(args)) {
                    let next = Value::String(normalized);
                    if *args != next {
                        *args = next;
                        repaired += 1;
                    }
                }
            }
        }
    }

    repaired
}

fn count_normalized_tool_calls(payload: &Value) -> i64 {
    payload
        .get("choices")
        .and_then(|v| v.as_array())
        .map(|choices| {
            choices
                .iter()
                .map(|choice| {
                    choice
                        .get("message")
                        .and_then(|v| v.as_object())
                        .and_then(|message| message.get("tool_calls"))
                        .and_then(|v| v.as_array())
                        .map(|rows| rows.len() as i64)
                        .unwrap_or(0)
                })
                .sum::<i64>()
        })
        .unwrap_or(0)
}

pub fn govern_response(input: ToolGovernanceInput) -> Result<ToolGovernanceOutput, String> {
    let mut payload = input.payload.clone();

    strip_orphan_function_calls_tag(&mut payload);
    let harvested = maybe_harvest_empty_tool_calls_from_json_content(&mut payload);
    let apply_patch_repaired = normalize_apply_patch_tool_calls(&mut payload);
    let tool_calls_normalized = count_normalized_tool_calls(&payload);

    let applied = harvested > 0 || tool_calls_normalized > 0 || apply_patch_repaired > 0;

    Ok(ToolGovernanceOutput {
        governed_payload: payload,
        summary: ToolGovernanceSummary {
            applied,
            tool_calls_normalized,
            apply_patch_repaired,
        },
    })
}

#[napi]
pub fn govern_response_json(input_json: String) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: ToolGovernanceInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = govern_response(input).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_govern_response_empty_payload() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({"choices": []}),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            request_id: "req_123".to_string(),
        };
        let result = govern_response(input).unwrap();
        assert!(!result.summary.applied);
        assert_eq!(result.summary.tool_calls_normalized, 0);
        assert_eq!(result.summary.apply_patch_repaired, 0);
    }

    #[test]
    fn test_govern_response_with_tool_calls() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({"choices": [{"message": {"tool_calls": [{"function": {"name": "exec_command", "arguments": "{}"}}]}}]}),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            request_id: "req_123".to_string(),
        };
        let result = govern_response(input).unwrap();
        assert!(result.summary.applied);
        assert_eq!(result.summary.tool_calls_normalized, 1);
    }

    #[test]
    fn test_govern_response_apply_patch_repair() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({"choices": [{"message": {"tool_calls": [{"function": {"name": "apply_patch", "arguments": "{\"patch\": \"test\"}"}}]}}]}),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            request_id: "req_123".to_string(),
        };
        let result = govern_response(input).unwrap();
        assert!(result.summary.applied);
        assert_eq!(result.summary.apply_patch_repaired, 1);
        let args = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
            ["arguments"]
            .as_str()
            .unwrap_or("");
        let parsed: Value = serde_json::from_str(args).unwrap();
        assert_eq!(parsed["patch"].as_str().unwrap_or(""), "test");
        assert_eq!(parsed["input"].as_str().unwrap_or(""), "test");
    }

    #[test]
    fn test_govern_response_apply_patch_inline_create_file_shape() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [{
                            "function": {
                                "name": "apply_patch",
                                "arguments": "*** Begin Patch *** Create File: src/a.ts\nconsole.log('ok')\n*** End Patch"
                            }
                        }]
                    }
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            request_id: "req_123".to_string(),
        };
        let result = govern_response(input).unwrap();
        let args = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
            ["arguments"]
            .as_str()
            .unwrap_or("");
        let parsed: Value = serde_json::from_str(args).unwrap();
        let patch = parsed["patch"].as_str().unwrap_or("");
        assert!(patch.contains("*** Begin Patch"));
        assert!(patch.contains("*** Add File: src/a.ts"));
        assert!(patch.contains("+console.log('ok')"));
        assert!(patch.contains("*** End Patch"));
    }

    #[test]
    fn test_govern_response_apply_patch_strips_quoted_paths() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [{
                            "function": {
                                "name": "apply_patch",
                                "arguments": "*** Begin Patch\n*** Add File: \"src/quoted.ts\"\n+console.log('ok')\n*** End Patch"
                            }
                        }]
                    }
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            request_id: "req_quoted_path".to_string(),
        };
        let result = govern_response(input).unwrap();
        let args = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
            ["arguments"]
            .as_str()
            .unwrap_or("");
        let parsed: Value = serde_json::from_str(args).unwrap();
        let patch = parsed["patch"].as_str().unwrap_or("");
        assert!(patch.contains("*** Add File: src/quoted.ts"));
        assert!(!patch.contains("*** Add File: \"src/quoted.ts\""));
    }

    #[test]
    fn test_strip_orphan_function_calls_tag() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({"choices": [{"message": {"content": "<function_calls>{\"name\": \"test\"}</function_calls>"}}]}),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            request_id: "req_123".to_string(),
        };
        let result = govern_response(input).unwrap();
        let content = result.governed_payload["choices"][0]["message"]["content"]
            .as_str()
            .unwrap();
        assert!(!content.contains("<function_calls>"));
        assert!(!content.contains("</function_calls>"));
    }

    #[test]
    fn test_normalize_tool_name_shell_command_preserve() {
        assert_eq!(
            normalize_tool_name("functions.shell_command"),
            Some("shell_command".to_string())
        );
        assert!(normalize_tool_name("totally_unknown_tool").is_none());
    }

    #[test]
    fn test_normalize_tool_name_edge_cases() {
        assert!(normalize_tool_name("").is_none());
        assert!(normalize_tool_name("   ").is_none());
        assert!(normalize_tool_name("functions.").is_none());
        assert_eq!(
            normalize_tool_name("  FuNcTiOnS.SHELL_COMMAND "),
            Some("shell_command".to_string())
        );
    }

    #[test]
    fn test_parse_json_record_edge_cases() {
        let empty = Value::String("   ".to_string());
        let parsed = parse_json_record(Some(&empty)).unwrap();
        assert!(parsed.is_empty());

        let none = parse_json_record(Some(&Value::Null));
        assert!(none.is_none());

        let raw = Value::String("{\"note\":\"a\rb\"}".to_string());
        let parsed = parse_json_record(Some(&raw)).unwrap();
        assert_eq!(parsed.get("note").and_then(Value::as_str), Some("a\rb"));

        let arr = Value::Array(vec![Value::Null, Value::String("".to_string())]);
        assert!(read_string_array_command(Some(&arr)).is_none());
    }

    #[test]
    fn test_workdir_and_tool_args_missing_paths() {
        let mut args = Map::new();
        args.insert("input".to_string(), json!({"cwd": "/tmp/cwd"}));
        assert_eq!(read_workdir_from_args(&args), Some("/tmp/cwd".to_string()));

        let raw_args = json!({});
        assert!(normalize_tool_args("shell", Some(&raw_args)).is_none());

        let raw_args = json!({"session_id": "abc"});
        assert!(normalize_tool_args("write_stdin", Some(&raw_args)).is_none());
    }

    #[test]
    fn test_extract_balanced_json_object_edges() {
        assert!(extract_balanced_json_object_at("xx", 0).is_none());
        assert!(extract_balanced_json_object_at("{", 0).is_none());
    }

    #[test]
    fn test_extract_json_candidates_edge_cases() {
        let text = "```json\n{\"a\":1}\n";
        assert!(extract_json_candidates_from_text(text).is_empty());

        let text = "\"tool_calls\"";
        assert!(!extract_json_candidates_from_text(text).is_empty());
    }

    #[test]
    fn test_qwen_marker_unknown_tool_skips() {
        let text = "<|tool_call_begin|>unknown<|tool_call_argument_begin|>{\"command\":\"pwd\"}<|tool_call_end|>";
        assert!(extract_tool_calls_from_qwen_markers(text, 1).is_empty());
    }

    #[test]
    fn test_message_candidates_misc_and_env() {
        let msg = json!({"content": [1, {"text": "x"}, {"content": "y"}]});
        let parts = read_message_text_candidates(msg.as_object().unwrap());
        assert_eq!(parts.len(), 2);

        std::env::set_var("ROUTECODEX_WORKDIR", "   ");
        std::env::set_var("RCC_WORKDIR", " /tmp/rc ");
        assert_eq!(read_default_workdir_from_env(), Some("/tmp/rc".to_string()));
        std::env::remove_var("ROUTECODEX_WORKDIR");
        std::env::remove_var("RCC_WORKDIR");
    }

    #[test]
    fn test_build_bash_lc_command_edges() {
        assert!(build_bash_lc_command("").is_none());
        assert_eq!(
            build_bash_lc_command("bash -lc pwd").unwrap(),
            "bash -lc pwd"
        );
        let wrapped = build_bash_lc_command("echo 'hi'").unwrap();
        assert!(wrapped.starts_with("bash -lc '"));
        assert!(wrapped.contains("echo"));
    }

    #[test]
    fn test_extract_exec_command_from_bash_fence_edges() {
        let empty = "```bash\n\n```";
        assert!(extract_exec_command_from_bash_fence(empty, 1).is_none());

        let multi = "```bash\na\n```\n```bash\nb\n```";
        let call = extract_exec_command_from_bash_fence(multi, 2).unwrap();
        let args_str = call["function"]["arguments"].as_str().unwrap();
        let args_json: Value = serde_json::from_str(args_str).unwrap();
        let cmd = args_json["cmd"].as_str().unwrap_or("");
        assert!(cmd.contains("b"));
    }

    #[test]
    fn test_strip_orphan_function_calls_tag_json_empty() {
        let result = strip_orphan_function_calls_tag_json("".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn test_normalize_apply_patch_tool_calls_noop_and_count() {
        let normalized = normalize_tool_args(
            "apply_patch",
            Some(&Value::String(
                r#"{"patch":"*** Begin Patch\n*** End Patch"}"#.to_string(),
            )),
        )
        .unwrap();
        let mut payload = json!({
            "choices": [{
                "message": {
                    "tool_calls": [{"function": {"name": "apply_patch", "arguments": normalized.clone()}}]
                }
            }]
        });
        let repaired = normalize_apply_patch_tool_calls(&mut payload);
        assert_eq!(repaired, 0);

        let payload = json!({
            "choices": [{
                "message": {"tool_calls": [{"function": {"name": "exec_command", "arguments": "{}"}}, {"function": {"name": "exec_command", "arguments": "{}"}}]}
            }]
        });
        assert_eq!(count_normalized_tool_calls(&payload), 2);
    }

    #[test]
    fn test_harvest_tool_calls_from_function_calls_json() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": "<function_calls>{\"tool_calls\":[{\"id\":\"call_abc\",\"type\":\"function\",\"function\":{\"name\":\"shell_command\",\"arguments\":{\"command\":\"pwd\",\"cwd\":\"/tmp\"}}}]}</function_calls>"
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "anthropic-messages".to_string(),
            entry_endpoint: "/v1/messages".to_string(),
            request_id: "req_tool_harvest_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        let message = &result.governed_payload["choices"][0]["message"];
        assert_eq!(result.summary.tool_calls_normalized, 1);
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "tool_calls"
        );
        assert_eq!(
            message["tool_calls"][0]["function"]["name"],
            "shell_command"
        );

        let args_str = message["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap();
        let args_json: Value = serde_json::from_str(args_str).unwrap();
        assert_eq!(args_json["command"], "pwd");
        assert_eq!(args_json["cwd"], "/tmp");
        assert_eq!(message["content"], "");
    }

    #[test]
    fn test_strip_orphan_function_calls_tag_json_api() {
        let payload = serde_json::json!({
            "choices": [{
                "message": { "content": "<function_calls>{\"name\":\"exec_command\"}</function_calls>" }
            }]
        });
        let output = strip_orphan_function_calls_tag_json(payload.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();
        let content = parsed["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("");
        assert!(!content.contains("<function_calls>"));
        assert!(!content.contains("</function_calls>"));
    }

    #[test]
    fn test_harvest_tool_calls_when_tool_calls_field_missing() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "content": "{\"tool_calls\":[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"ls\",\"workdir\":\"/Users\"}}]}"
                    }
                }]
            }),
            client_protocol: "anthropic-messages".to_string(),
            entry_endpoint: "/v1/messages".to_string(),
            request_id: "req_tool_harvest_2".to_string(),
        };

        let result = govern_response(input).unwrap();
        assert_eq!(result.summary.tool_calls_normalized, 1);
        assert_eq!(
            result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "exec_command"
        );
    }

    #[test]
    fn test_harvest_exec_command_from_bash_fence_text() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": "先检查实现。\n```bash\npwd\n```\n然后继续\n```bash\ncat src/runtime/event-bus.ts | head -100\n```"
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_bash_fence_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        let message = &result.governed_payload["choices"][0]["message"];
        assert_eq!(result.summary.tool_calls_normalized, 1);
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "tool_calls"
        );
        assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");
        let args_str = message["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}");
        let args_json: Value = serde_json::from_str(args_str).unwrap_or(Value::Null);
        let cmd = args_json.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
        assert!(cmd.starts_with("bash -lc '"));
        assert!(cmd.contains("cat src/runtime/event-bus.ts | head -100"));
        assert!(!cmd.contains("bash -lc 'pwd'"));
        assert_eq!(message["content"], "");
    }

    #[test]
    fn test_harvest_tool_calls_from_qwen_markers() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": "继续\n<|tool_calls_section_begin|>\n<|tool_call_begin|> functions.exec_command:66 <|tool_call_argument_begin|> {\"cmd\":\"pwd\",\"workdir\":\"/tmp\"} <|tool_call_end|>\n<|tool_calls_section_end|>\n"
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_qwen_marker_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        let message = &result.governed_payload["choices"][0]["message"];
        assert_eq!(result.summary.tool_calls_normalized, 1);
        assert_eq!(
            result.governed_payload["choices"][0]["finish_reason"],
            "tool_calls"
        );
        assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");
        let args_str = message["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}");
        let args_json: Value = serde_json::from_str(args_str).unwrap_or(Value::Null);
        assert_eq!(args_json["cmd"], "pwd");
        assert_eq!(args_json["workdir"], "/tmp");
    }

    #[test]
    fn test_harvest_qwen_markers_repairs_newline_inside_json_string() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": "继续\n<|tool_calls_section_begin|>\n<|tool_call_begin|> functions.exec_command:45 <|tool_call_argument_begin|> {\"command\":\"head -70 /tmp/a.py\nmore.py\"} <|tool_call_end|>\n<|tool_calls_section_end|>\n"
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_qwen_marker_2".to_string(),
        };

        let result = govern_response(input).unwrap();
        let args_str = result.governed_payload["choices"][0]["message"]["tool_calls"][0]
            ["function"]["arguments"]
            .as_str()
            .unwrap_or("{}");
        let args_json: Value = serde_json::from_str(args_str).unwrap_or(Value::Null);
        let cmd = args_json["cmd"].as_str().unwrap_or("");
        assert!(cmd.contains("head -70 /tmp/a.py"));
        assert!(cmd.contains("more.py"));
    }

    #[test]
    fn test_harvest_qwen_markers_with_split_marker_tokens() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": "The push command is running.\n<|tool_calls_section_begin|> <|\n  tool_call_begin|> functions.write_stdin:69 <|tool_call_argument_begin|> {} <|\n  tool_call_end|> <|tool_calls_section_end|>"
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_qwen_marker_split_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        assert_eq!(result.summary.tool_calls_normalized, 1);
        assert_eq!(
            result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "write_stdin"
        );
    }

    #[test]
    fn test_quote_wrapped_tool_calls_are_not_harvested() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({
                "choices": [{
                    "message": {
                        "tool_calls": [],
                        "content": "原文是：<quote>{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"git status\"}}]}</quote>"
                    },
                    "finish_reason": "stop"
                }]
            }),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_quote_skip_1".to_string(),
        };

        let result = govern_response(input).unwrap();
        let message = &result.governed_payload["choices"][0]["message"];
        assert!(message
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .map(|v| v.is_empty())
            .unwrap_or(true));
    }

    #[test]
    fn test_error_empty_json_input() {
        let result = govern_response_json("".to_string());
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Input JSON is empty"));
    }

    #[test]
    fn test_error_invalid_json_input() {
        let result = govern_response_json("invalid".to_string());
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Failed to parse input JSON"));
    }

    #[test]
    fn test_govern_response_no_tool_calls() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({"choices": [{"message": {"content": "Hello, world!"}}]}),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            request_id: "req_123".to_string(),
        };
        let result = govern_response(input).unwrap();
        assert!(!result.summary.applied);
        assert_eq!(result.summary.tool_calls_normalized, 0);
    }
    #[test]
    fn test_apply_patch_helpers() {
        assert_eq!(
            normalize_apply_patch_header_line(r#"*** Add File: "src/a.ts" ***"#),
            "*** Add File: src/a.ts"
        );
        assert_eq!(
            normalize_apply_patch_header_line(r#"*** Update File: `src/b.ts`"#),
            "*** Update File: src/b.ts"
        );
        assert_eq!(
            normalize_apply_patch_header_line(r#"*** Delete File: 'src/c.ts'"#),
            "*** Delete File: src/c.ts"
        );

        let input = r#"*** Add File: a.ts
console.log('ok')"#;
        let normalized = normalize_apply_patch_text(input);
        assert!(normalized.contains("*** Begin Patch"));
        assert!(normalized.contains("*** Add File: a.ts"));
        assert!(normalized.contains("+console.log('ok')"));
        assert!(normalized.contains("*** End Patch"));

        let input = r#"*** Begin Patch *** Create File: a.ts
+ok
*** End Patch"#;
        let normalized = normalize_apply_patch_text(input);
        assert!(normalized.contains("*** Begin Patch"));
        assert!(normalized.contains("*** Add File: a.ts"));
        assert!(normalized.contains("*** End Patch"));
    }

    #[test]
    fn test_parse_helpers_and_normalizers() {
        let raw = Value::String("{\"note\":\"line1\nline2\"}".to_string());
        let parsed = parse_json_record(Some(&raw)).unwrap();
        assert_eq!(
            parsed.get("note").and_then(Value::as_str),
            Some("line1\nline2")
        );

        let arr = Value::Array(vec![
            Value::String(" ls ".to_string()),
            Value::Number(1.into()),
            Value::Null,
            Value::String("".to_string()),
        ]);
        assert_eq!(
            read_string_array_command(Some(&arr)),
            Some("ls 1".to_string())
        );

        let mut args = Map::new();
        args.insert("command".to_string(), Value::String("pwd".to_string()));
        assert_eq!(read_command_from_args(&args), Some("pwd".to_string()));

        let mut args = Map::new();
        args.insert("input".to_string(), json!({"command": "ls"}));
        assert_eq!(read_command_from_args(&args), Some("ls".to_string()));

        let mut args = Map::new();
        args.insert("workDir".to_string(), Value::String("/tmp".to_string()));
        assert_eq!(read_workdir_from_args(&args), Some("/tmp".to_string()));

        assert_eq!(decode_escaped_newlines_if_needed("a\\n b"), "a\n b");
        assert_eq!(decode_escaped_newlines_if_needed("a\n b"), "a\n b");

        let raw = Value::String(r#"{"patch":"*** Begin Patch\n*** End Patch"}"#.to_string());
        assert!(extract_apply_patch_text(Some(&raw))
            .unwrap()
            .contains("*** Begin Patch"));

        let raw = json!({"instructions": "*** Begin Patch\n*** End Patch"});
        assert_eq!(
            extract_apply_patch_text(Some(&raw)).unwrap(),
            "*** Begin Patch\n*** End Patch"
        );

        assert_eq!(
            normalize_apply_patch_header_path("\"src/a.ts\""),
            "src/a.ts"
        );
    }

    #[test]
    fn test_normalize_tool_args_variants() {
        let raw_args = json!({"command": "pwd", "cwd": "/tmp"});
        let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["cmd"], "pwd");
        assert_eq!(parsed["command"], "pwd");
        assert_eq!(parsed["workdir"], "/tmp");

        let raw_args = json!({"sessionId": "123", "text": 42});
        let out = normalize_tool_args("write_stdin", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["session_id"], 123);
        assert_eq!(parsed["chars"], "42");

        let raw_args = Value::String("  ".to_string());
        assert!(normalize_tool_args("apply_patch", Some(&raw_args)).is_none());

        let raw_args = json!({"command": "pwd"});
        assert!(normalize_tool_args("bash", Some(&raw_args)).is_some());
    }

    #[test]
    fn test_json_extraction_helpers() {
        let text = "xx {\"a\":1} yy";
        let idx = text.find('{').unwrap();
        assert_eq!(
            extract_balanced_json_object_at(text, idx).unwrap(),
            "{\"a\":1}"
        );
        assert!(extract_balanced_json_object_at("nope", 0).is_none());

        let fenced = "```json\n{\"tool_calls\": []}\n```";
        let out = extract_json_candidates_from_text(fenced);
        assert!(!out.is_empty());

        let marker = "prefix {\"tool_calls\": []} suffix";
        let out = extract_json_candidates_from_text(marker);
        assert!(!out.is_empty());
    }

    #[test]
    fn test_tool_call_entry_and_qwen_marker_parsing() {
        let entry = json!({"function": {"name": "exec_command", "arguments": {"command": "pwd"}}});
        let out = normalize_tool_call_entry(&entry, 1).unwrap();
        assert_eq!(out["function"]["name"], "exec_command");

        let entry = json!({"function": {"name": "unknown_tool"}});
        assert!(normalize_tool_call_entry(&entry, 1).is_none());

        let obj = json!({"tool_calls": [{"function": {"name": "exec_command", "arguments": {"command": "pwd"}}}]});
        let out = extract_tool_call_entries_from_unknown(&obj);
        assert_eq!(out.len(), 1);

        let text = "<|tool_call_begin|>shell<|tool_call_argument_begin|>{\"command\":\"pwd\"}<|tool_call_end|>";
        let out = extract_tool_calls_from_qwen_markers(text, 1);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["function"]["name"], "exec_command");
    }

    #[test]
    fn test_message_candidates_and_bash_fence_harvest() {
        let msg = json!({
            "content": [{"text": "a"}, {"content": "b"}],
            "reasoning": "r",
            "thinking": "t"
        });
        let row = msg.as_object().unwrap();
        let parts = read_message_text_candidates(row);
        assert_eq!(parts.len(), 4);

        assert_eq!(normalize_shell_script_line("$ ls"), "ls");
        assert_eq!(normalize_shell_script_line("ls"), "ls");

        std::env::set_var("ROUTECODEX_WORKDIR", "/tmp/test");
        let fenced = "```bash\npwd\n```";
        let call = extract_exec_command_from_bash_fence(fenced, 1).unwrap();
        assert_eq!(call["function"]["name"], "exec_command");
        std::env::remove_var("ROUTECODEX_WORKDIR");
    }

    #[test]
    fn test_maybe_harvest_empty_tool_calls_paths() {
        // Existing tool_calls -> skip
        let mut payload = json!({
            "choices": [{
                "message": {"tool_calls": [{"function": {"name": "exec_command", "arguments": "{}"}}], "content": "x"},
                "finish_reason": "stop"
            }]
        });
        assert_eq!(
            maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
            0
        );

        // Quote marker -> skip
        let mut payload = json!({
            "choices": [{
                "message": {"tool_calls": [], "content": "<quote>skip</quote>"},
                "finish_reason": "stop"
            }]
        });
        assert_eq!(
            maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
            0
        );

        // Bash fence -> harvest
        let mut payload = json!({
            "choices": [{
                "message": {"tool_calls": [], "content": "```bash\npwd\n```"},
                "finish_reason": "stop"
            }]
        });
        assert_eq!(
            maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
            1
        );
        assert_eq!(payload["choices"][0]["finish_reason"], "tool_calls");

        // Qwen markers -> harvest
        let mut payload = json!({
            "choices": [{
                "message": {"tool_calls": [], "content": "<|tool_call_begin|>shell<|tool_call_argument_begin|>{\"command\":\"pwd\"}<|tool_call_end|>"},
                "finish_reason": "length"
            }]
        });
        assert_eq!(
            maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
            1
        );
        assert_eq!(payload["choices"][0]["finish_reason"], "length");

        // Marker but invalid JSON -> no harvest
        let mut payload = json!({
            "choices": [{
                "message": {"tool_calls": [], "content": "{\"tool_calls\":["},
                "finish_reason": "stop"
            }]
        });
        assert_eq!(
            maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
            0
        );
    }

    #[test]
    fn test_read_string_array_command_empty_tokens() {
        let arr = Value::Array(vec![
            Value::String("   ".to_string()),
            Value::Null,
            Value::String("\t".to_string()),
        ]);
        assert!(read_string_array_command(Some(&arr)).is_none());
    }

    #[test]
    fn test_parse_json_record_escape_branches_and_non_object() {
        let raw = Value::String("{\"note\":\"line1\\\"line2\nline3\rline4\"}".to_string());
        let parsed = parse_json_record(Some(&raw)).unwrap();
        let note = parsed.get("note").and_then(Value::as_str).unwrap_or("");
        assert!(note.contains("line3"));
        assert!(note.contains('\n'));

        let none = parse_json_record(Some(&Value::Bool(true)));
        assert!(none.is_none());
    }

    #[test]
    fn test_read_command_from_args_input_variants() {
        let mut args = Map::new();
        args.insert("input".to_string(), json!({"script": "echo hi"}));
        assert_eq!(read_command_from_args(&args), Some("echo hi".to_string()));

        let mut args = Map::new();
        args.insert("input".to_string(), json!({"command": ["ls", "-la"]}));
        assert_eq!(read_command_from_args(&args), Some("ls -la".to_string()));
    }

    #[test]
    fn test_read_workdir_from_args_input_variants() {
        let mut args = Map::new();
        args.insert("input".to_string(), json!({"workdir": "/tmp/inner"}));
        assert_eq!(
            read_workdir_from_args(&args),
            Some("/tmp/inner".to_string())
        );

        let mut args = Map::new();
        args.insert("input".to_string(), json!({"cwd": "/tmp/cwd"}));
        assert_eq!(read_workdir_from_args(&args), Some("/tmp/cwd".to_string()));
    }

    #[test]
    fn test_extract_apply_patch_text_variants() {
        let stars = "*".repeat(3);
        let raw_text = format!("{} {} {}", stars, "Begin", "Patch");
        let raw_text = format!("{}\n{} {}", raw_text, stars, "End Patch");
        let raw = json!({"text": raw_text});
        assert!(extract_apply_patch_text(Some(&raw))
            .unwrap()
            .contains("Patch"));

        let raw = Value::Bool(true);
        assert!(extract_apply_patch_text(Some(&raw)).is_none());
    }

    #[test]
    fn test_normalize_apply_patch_text_single_line_and_missing_end() {
        let stars = "*".repeat(3);
        let begin_marker = format!("{} {} {}", stars, "Begin", "Patch");
        let end_marker = format!("{} {} {}", stars, "End", "Patch");
        let update_marker = format!("{} {} {}", stars, "Update", "File:");
        let delete_marker = format!("{} {} {}", stars, "Delete", "File:");

        let input = format!(
            "{} {} {} {}",
            begin_marker, update_marker, "src/a.ts", end_marker
        );
        let normalized = normalize_apply_patch_text(&input);
        assert!(normalized.contains("Begin"));
        assert!(normalized.contains("Update"));
        assert!(normalized.contains("End"));

        let input = format!("{} {} {}", begin_marker, update_marker, "src/a.ts");
        let normalized = normalize_apply_patch_text(&input);
        assert!(normalized.contains("End"));

        let input = format!("{} {}", delete_marker, "src/a.ts");
        let normalized = normalize_apply_patch_text(&input);
        assert!(normalized.contains("Begin"));
        assert!(normalized.contains("Delete"));
        assert!(normalized.contains("End"));
    }

    #[test]
    fn test_normalize_apply_patch_header_path_empty() {
        assert_eq!(normalize_apply_patch_header_path("   "), "");
    }

    #[test]
    fn test_normalize_tool_args_write_stdin_number_and_input() {
        let raw_args = json!({"session_id": 7, "input": "abc"});
        let out = normalize_tool_args("write_stdin", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["session_id"], 7);
        assert_eq!(parsed["chars"], "abc");

        let raw_args = json!({"session_id": true});
        assert!(normalize_tool_args("write_stdin", Some(&raw_args)).is_none());
    }

    #[test]
    fn test_normalize_tool_args_shell_input_command() {
        let raw_args = json!({"input": {"command": "pwd"}});
        let out = normalize_tool_args("shell", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["command"], "pwd");
        assert_eq!(parsed["cmd"], "pwd");
    }

    #[test]
    fn test_normalize_tool_args_write_stdin_data_field() {
        let raw_args = json!({"sessionId": "42", "data": {"x": 1}});
        let out = normalize_tool_args("write_stdin", Some(&raw_args)).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["session_id"], 42);
        assert_eq!(parsed["chars"], "{\"x\":1}");
    }

    #[test]
    fn test_normalize_tool_call_entry_input_and_missing_args() {
        let entry = json!({"function": {"name": "exec_command", "input": {"command": "pwd"}}});
        let out = normalize_tool_call_entry(&entry, 1).unwrap();
        assert_eq!(out["function"]["name"], "exec_command");

        let entry = json!({"function": {"name": "exec_command", "arguments": {}}});
        assert!(normalize_tool_call_entry(&entry, 1).is_none());

        let entry = Value::String("not an object".to_string());
        assert!(normalize_tool_call_entry(&entry, 1).is_none());
    }

    #[test]
    fn test_extract_tool_call_entries_from_unknown_non_object() {
        let value = Value::String("oops".to_string());
        assert!(extract_tool_call_entries_from_unknown(&value).is_empty());
    }

    #[test]
    fn test_extract_tool_call_entries_from_unknown_object() {
        let value = json!({"name": "exec_command", "arguments": {"command": "pwd"}});
        let out = extract_tool_call_entries_from_unknown(&value);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["function"]["name"], "exec_command");
    }

    #[test]
    fn test_extract_json_candidates_unclosed_fence() {
        let text = "```json\n{\"a\":1}\n";
        let out = extract_json_candidates_from_text(text);
        assert!(out.is_empty());
    }

    #[test]
    fn test_read_message_text_candidates_edge_paths() {
        let msg = json!({"content": "   "});
        let parts = read_message_text_candidates(msg.as_object().unwrap());
        assert!(parts.is_empty());

        let msg = json!({"content": [1, {"text": "ok"}, {"content": "more"}]});
        let parts = read_message_text_candidates(msg.as_object().unwrap());
        assert_eq!(parts.len(), 2);

        let msg = json!({"content": 123});
        let parts = read_message_text_candidates(msg.as_object().unwrap());
        assert!(parts.is_empty());
    }

    #[test]
    fn test_build_bash_lc_command_whitespace_only() {
        assert!(build_bash_lc_command("  \n  ").is_none());
    }

    #[test]
    fn test_extract_exec_command_from_bash_fence_empty_script() {
        let text = "```bash\n   \n```";
        assert!(extract_exec_command_from_bash_fence(text, 1).is_none());
    }

    #[test]
    fn test_govern_response_json_success() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({"choices": []}),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            request_id: "req_json_ok".to_string(),
        };
        let output = govern_response_json(serde_json::to_string(&input).unwrap()).unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();
        assert!(parsed.get("summary").is_some());
    }

    #[test]
    fn test_govern_response_json_js_function_coverage() {
        let input = ToolGovernanceInput {
            payload: serde_json::json!({"choices": []}),
            client_protocol: "openai-chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            request_id: "req_json_js".to_string(),
        };
        let output = govern_response_json(serde_json::to_string(&input).unwrap()).unwrap();
        assert!(output.contains("\"summary\""));
    }

    #[test]
    fn test_strip_orphan_function_calls_tag_json_js_function_coverage() {
        let payload = serde_json::json!({
            "choices": [{
                "message": { "content": "<function_calls>{\\\"name\\\":\\\"exec_command\\\"}</function_calls>" }
            }]
        });
        let output = strip_orphan_function_calls_tag_json(payload.to_string()).unwrap();
        assert!(!output.contains("<function_calls>"));
    }
}
