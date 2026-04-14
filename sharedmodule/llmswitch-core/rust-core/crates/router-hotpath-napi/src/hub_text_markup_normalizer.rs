use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ToolCallLite {
    id: Option<String>,
    name: String,
    args: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JsonToolRepairConfig {
    tool_name_aliases: Option<HashMap<String, String>>,
    argument_aliases: Option<HashMap<String, HashMap<String, Vec<String>>>>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TextMarkupNormalizeOptions {
    json_tool_repair: Option<JsonToolRepairConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonToolCallsInput {
    text: String,
    options: Option<TextMarkupNormalizeOptions>,
}

fn known_tools() -> HashSet<&'static str> {
    [
        "shell",
        "exec_command",
        "write_stdin",
        "apply_patch",
        "update_plan",
        "view_image",
        "list_mcp_resources",
        "read_mcp_resource",
        "list_mcp_resource_templates",
        "list_directory",
    ]
    .into_iter()
    .collect()
}

fn allowed_keys_for_tool(name: &str) -> Option<&'static [&'static str]> {
    match name {
        "shell" => Some(&[
            "command",
            "justification",
            "timeout_ms",
            "with_escalated_permissions",
            "workdir",
        ]),
        "exec_command" => Some(&[
            "cmd",
            "workdir",
            "justification",
            "login",
            "tty",
            "shell",
            "yield_time_ms",
            "max_output_tokens",
            "sandbox_permissions",
            "timeout_ms",
        ]),
        "write_stdin" => Some(&[
            "session_id",
            "chars",
            "text",
            "yield_time_ms",
            "max_output_tokens",
        ]),
        "apply_patch" => Some(&["patch", "input", "instructions", "text", "file", "changes"]),
        "update_plan" => Some(&["explanation", "plan"]),
        "view_image" => Some(&["path"]),
        "list_mcp_resources" => Some(&["server", "cursor", "filter", "root"]),
        "read_mcp_resource" => Some(&["server", "uri", "cursor"]),
        "list_mcp_resource_templates" => Some(&["server", "cursor"]),
        "list_directory" => Some(&["path", "recursive"]),
        _ => None,
    }
}

fn gen_tool_call_id() -> String {
    let raw = Uuid::new_v4().simple().to_string();
    let slice = raw.get(0..8).unwrap_or(raw.as_str());
    format!("call_{}", slice)
}

fn normalize_key(raw: &str) -> String {
    let t = raw.trim();
    if t.is_empty() {
        return String::new();
    }
    let re = Regex::new(r"([A-Za-z_][A-Za-z0-9_]*)$").expect("valid normalize key regex");
    if let Some(caps) = re.captures(t) {
        if let Some(m) = caps.get(1) {
            return m.as_str().to_string();
        }
    }
    t.to_string()
}

fn read_default_workdir_from_env() -> Option<String> {
    let keys = ["ROUTECODEX_WORKDIR", "RCC_WORKDIR", "CLAUDE_WORKDIR"];
    for key in keys {
        if let Ok(v) = env::var(key) {
            let trimmed = v.trim().to_string();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    None
}

fn filter_args_for_tool(name: &str, args: &Map<String, Value>) -> Map<String, Value> {
    let lname = name.to_lowercase();
    let mut out = Map::new();
    if let Some(allow) = allowed_keys_for_tool(lname.as_str()) {
        let allow_set: HashSet<&str> = allow.iter().copied().collect();
        for (k, v) in args.iter() {
            let key = normalize_key(k).to_string();
            if allow_set.contains(key.as_str()) {
                out.insert(key, v.clone());
            }
        }
        return out;
    }
    let safe: HashSet<&str> = [
        "cmd",
        "command",
        "workdir",
        "patch",
        "input",
        "instructions",
        "text",
        "plan",
        "explanation",
        "path",
        "server",
        "uri",
        "cursor",
        "filter",
        "root",
    ]
    .into_iter()
    .collect();
    for (k, v) in args.iter() {
        let key = normalize_key(k).to_string();
        if safe.contains(key.as_str()) {
            out.insert(key, v.clone());
        }
    }
    out
}

fn try_parse_json_value(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !(trimmed.starts_with('{') || trimmed.starts_with('[') || trimmed.starts_with('"')) {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

fn try_parse_primitive_value(text: &str) -> Value {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Value::String(String::new());
    }
    if let Some(parsed) = try_parse_json_value(trimmed) {
        return parsed;
    }
    if trimmed == "true" {
        return Value::Bool(true);
    }
    if trimmed == "false" {
        return Value::Bool(false);
    }
    if let Ok(n) = trimmed.parse::<f64>() {
        if n.is_finite() {
            return Value::Number(serde_json::Number::from_f64(n).unwrap());
        }
    }
    Value::String(trimmed.to_string())
}

fn coerce_command_value_to_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.trim().to_string(),
        Value::Array(arr) => arr
            .iter()
            .map(|v| value_to_string(v))
            .collect::<Vec<String>>()
            .join(" ")
            .trim()
            .to_string(),
        Value::Object(map) => {
            if let Some(Value::String(cmd)) = map.get("cmd") {
                if !cmd.trim().is_empty() {
                    return cmd.trim().to_string();
                }
            }
            if let Some(Value::String(cmd)) = map.get("command") {
                if !cmd.trim().is_empty() {
                    return cmd.trim().to_string();
                }
            }
            serde_json::to_string(value).unwrap_or_else(|_| value_to_string(value))
        }
        _ => value_to_string(value),
    }
}

fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => String::new(),
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}

fn escape_control_chars_inside_json_strings(raw: &str) -> Option<String> {
    let mut out = String::new();
    let mut changed = false;
    let mut in_string = false;
    let mut escaped = false;
    for ch in raw.chars() {
        if in_string {
            if !escaped && ch == '"' {
                in_string = false;
                out.push(ch);
                continue;
            }
            if !escaped && ch == '\\' {
                escaped = true;
                out.push(ch);
                continue;
            }
            if !escaped {
                match ch {
                    '\n' => {
                        out.push_str("\\n");
                        changed = true;
                        continue;
                    }
                    '\r' => {
                        out.push_str("\\n");
                        changed = true;
                        continue;
                    }
                    '\t' => {
                        out.push_str("\\t");
                        changed = true;
                        continue;
                    }
                    _ => {
                        let code = ch as u32;
                        if code < 0x20 {
                            out.push_str(&format!("\\u{:04x}", code));
                            changed = true;
                            continue;
                        }
                    }
                }
            }
            out.push(ch);
            escaped = false;
            continue;
        }
        if ch == '"' {
            in_string = true;
            out.push(ch);
            continue;
        }
        out.push(ch);
    }
    if changed {
        Some(out)
    } else {
        None
    }
}

fn try_parse_json_with_model_repairs(raw: &str) -> Option<Value> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(text) {
        return Some(parsed);
    }
    if let Some(repaired) = escape_control_chars_inside_json_strings(text) {
        if let Ok(parsed) = serde_json::from_str::<Value>(repaired.as_str()) {
            return Some(parsed);
        }
    }
    None
}

fn salvage_tool_args_from_raw_text(tool_name: &str, raw_args: &str) -> Option<Map<String, Value>> {
    let lname = tool_name.to_lowercase();
    let text = raw_args.to_string();
    let pick_string = |re: &Regex| -> Option<String> {
        re.captures(&text)
            .and_then(|caps| caps.get(1))
            .map(|m| m.as_str().to_string())
    };
    let pick_number = |re: &Regex| -> Option<i64> {
        re.captures(&text)
            .and_then(|caps| caps.get(1))
            .and_then(|m| m.as_str().parse::<i64>().ok())
    };
    let mut out = Map::new();
    if lname == "exec_command" {
        let cmd_re = Regex::new(r#"\"cmd\"\s*:\s*\"([\s\S]*?)\"\s*(?:,|})"#).unwrap();
        let workdir_re =
            Regex::new(r#"\"(?:workdir|cwd)\"\s*:\s*\"([\s\S]*?)\"\s*(?:,|})"#).unwrap();
        let timeout_re = Regex::new(r#"\"(?:timeout_ms|timeout)\"\s*:\s*(\d+)\s*(?:,|})"#).unwrap();
        if let Some(cmd) = pick_string(&cmd_re) {
            out.insert("cmd".to_string(), Value::String(cmd));
        }
        if let Some(wd) = pick_string(&workdir_re) {
            out.insert("workdir".to_string(), Value::String(wd));
        }
        if let Some(timeout) = pick_number(&timeout_re) {
            out.insert("timeout_ms".to_string(), Value::Number(timeout.into()));
        }
        return if out.is_empty() { None } else { Some(out) };
    }
    if lname == "write_stdin" {
        let session_re =
            Regex::new(r#"\"(?:session_id|sessionId)\"\s*:\s*(\d+)\s*(?:,|})"#).unwrap();
        let chars_re =
            Regex::new(r#"\"(?:chars|text|input|data)\"\s*:\s*\"([\s\S]*?)\"\s*(?:,|})"#).unwrap();
        if let Some(session) = pick_number(&session_re) {
            out.insert("session_id".to_string(), Value::Number(session.into()));
        }
        if let Some(chars) = pick_string(&chars_re) {
            out.insert("chars".to_string(), Value::String(chars));
        }
        return if out.is_empty() { None } else { Some(out) };
    }
    if lname == "apply_patch" {
        let patch_re =
            Regex::new(r#"\"(?:patch|text|input|instructions)\"\s*:\s*\"([\s\S]*?)\"\s*(?:,|})"#)
                .unwrap();
        if let Some(patch) = pick_string(&patch_re) {
            out.insert("patch".to_string(), Value::String(patch));
        }
        return if out.is_empty() { None } else { Some(out) };
    }
    None
}

fn resolve_json_tool_name_aliases(
    options: &Option<TextMarkupNormalizeOptions>,
) -> HashMap<String, String> {
    let mut merged: HashMap<String, String> = HashMap::new();
    if let Some(opts) = options {
        if let Some(repair) = &opts.json_tool_repair {
            if let Some(alias_map) = &repair.tool_name_aliases {
                for (k, v) in alias_map.iter() {
                    let src = k.trim().to_lowercase();
                    let dst = v.trim().to_lowercase();
                    if !src.is_empty() && !dst.is_empty() {
                        merged.insert(src, dst);
                    }
                }
            }
        }
    }
    merged
}

fn resolve_json_tool_arg_aliases(
    tool_name: &str,
    options: &Option<TextMarkupNormalizeOptions>,
) -> HashMap<String, Vec<String>> {
    let lname = tool_name.to_lowercase();
    let mut merged: HashMap<String, Vec<String>> = HashMap::new();
    let base: HashMap<&str, Vec<&str>> = if lname == "exec_command" {
        HashMap::from([("workdir", vec!["workdir", "cwd", "input.workdir", "input.cwd"])])
    } else if lname == "write_stdin" {
        HashMap::from([
            (
                "chars",
                vec![
                    "chars",
                    "text",
                    "input",
                    "data",
                    "input.chars",
                    "input.text",
                    "input.input",
                    "input.data",
                ],
            ),
            (
                "session_id",
                vec![
                    "session_id",
                    "sessionId",
                    "input.session_id",
                    "input.sessionId",
                ],
            ),
        ])
    } else if lname == "apply_patch" {
        HashMap::from([(
            "patch",
            vec![
                "patch",
                "text",
                "input",
                "instructions",
                "input.patch",
                "input.text",
                "input.input",
                "input.instructions",
            ],
        )])
    } else {
        HashMap::new()
    };
    for (k, v) in base.iter() {
        merged.insert((*k).to_string(), v.iter().map(|s| s.to_string()).collect());
    }
    if let Some(opts) = options {
        if let Some(repair) = &opts.json_tool_repair {
            if let Some(map) = &repair.argument_aliases {
                if let Some(custom) = map.get(lname.as_str()) {
                    for (target, paths) in custom.iter() {
                        merged.insert(
                            target.to_string(),
                            paths
                                .iter()
                                .map(|p| p.trim().to_string())
                                .filter(|p| !p.is_empty())
                                .collect(),
                        );
                    }
                }
            }
        }
    }
    merged
}

fn has_non_empty_alias_value(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(s) => !s.trim().is_empty(),
        _ => true,
    }
}

fn read_alias_path_value(source: &Map<String, Value>, path: &str) -> Option<Value> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !trimmed.contains('.') {
        return source.get(trimmed).cloned();
    }
    let parts: Vec<&str> = trimmed
        .split('.')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        return None;
    }
    let mut cursor: Option<&Value> = None;
    for (idx, part) in parts.iter().enumerate() {
        if idx == 0 {
            cursor = source.get(*part);
        } else if let Some(Value::Object(map)) = cursor {
            cursor = map.get(*part);
        } else {
            return None;
        }
    }
    cursor.cloned()
}

fn apply_json_tool_argument_aliases(
    tool_name: &str,
    args_obj: &mut Map<String, Value>,
    options: &Option<TextMarkupNormalizeOptions>,
) {
    let mapping = resolve_json_tool_arg_aliases(tool_name, options);
    for (target, candidates) in mapping.iter() {
        if candidates.is_empty() {
            continue;
        }
        if let Some(current) = args_obj.get(target) {
            if has_non_empty_alias_value(current) {
                continue;
            }
        }
        for candidate in candidates.iter() {
            if let Some(picked) = read_alias_path_value(args_obj, candidate) {
                if !has_non_empty_alias_value(&picked) {
                    continue;
                }
                args_obj.insert(target.to_string(), picked);
                break;
            }
        }
    }
}

fn canonicalize_json_tool_name(
    value: &Value,
    options: &Option<TextMarkupNormalizeOptions>,
) -> Option<String> {
    let raw = value.as_str()?;
    let mut name = raw.trim().to_string();
    if name.is_empty() {
        return None;
    }
    if name.starts_with("functions.") {
        name = name.replace("functions.", "");
    }
    let lowered = name.to_lowercase();
    let alias_map = resolve_json_tool_name_aliases(options);
    let canonical = alias_map.get(lowered.as_str()).cloned().unwrap_or(lowered);
    let known = known_tools();
    if known.contains(canonical.as_str()) {
        Some(canonical)
    } else {
        None
    }
}

fn coerce_tool_call_args_object(raw: &Value) -> Map<String, Value> {
    if let Value::Object(map) = raw {
        return map.clone();
    }
    if let Value::String(s) = raw {
        if let Some(parsed) = try_parse_json_with_model_repairs(s) {
            if let Value::Object(map) = parsed {
                return map;
            }
        }
        return Map::new();
    }
    if let Value::Array(arr) = raw {
        let command = arr
            .iter()
            .map(|v| value_to_string(v))
            .collect::<Vec<String>>()
            .join(" ")
            .trim()
            .to_string();
        if !command.is_empty() {
            let mut out = Map::new();
            out.insert("command".to_string(), Value::String(command));
            return out;
        }
    }
    Map::new()
}

fn normalize_json_tool_args(
    tool_name: &str,
    raw_args: &Value,
    options: &Option<TextMarkupNormalizeOptions>,
) -> Option<Map<String, Value>> {
    let lname = tool_name.to_lowercase();
    let mut args_obj = coerce_tool_call_args_object(raw_args);
    apply_json_tool_argument_aliases(lname.as_str(), &mut args_obj, options);

    if lname == "exec_command" {
        let cmd = args_obj.get("cmd").unwrap_or(&Value::Null).clone();
        let cmd_value = coerce_command_value_to_string(&cmd);
        if cmd_value.is_empty() {
            return None;
        }
        args_obj.insert("cmd".to_string(), Value::String(cmd_value));
        if let Some(Value::String(wd)) = args_obj.get("workdir") {
            args_obj.insert("workdir".to_string(), Value::String(wd.trim().to_string()));
        }
    }

    if lname == "write_stdin" {
        if let Some(v) = args_obj.get("chars").cloned() {
            args_obj.insert("chars".to_string(), Value::String(value_to_string(&v)));
        }
        if let Some(v) = args_obj.get("session_id").cloned() {
            if let Some(n) = value_to_string(&v).trim().parse::<i64>().ok() {
                args_obj.insert("session_id".to_string(), Value::Number(n.into()));
            }
        }
    }

    if lname == "apply_patch" {
        if let Some(Value::String(p)) = args_obj.get("patch") {
            args_obj.insert("patch".to_string(), Value::String(p.to_string()));
        }
    }

    let filtered = filter_args_for_tool(lname.as_str(), &args_obj);
    if lname == "exec_command" {
        let cmd = filtered
            .get("cmd")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if cmd.is_empty() {
            return None;
        }
    }
    if lname == "write_stdin" {
        let sid = filtered.get("session_id");
        if sid.is_none() || value_to_string(sid.unwrap()).trim().is_empty() {
            return None;
        }
    }
    if lname == "apply_patch" {
        let patch = filtered
            .get("patch")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if patch.is_empty() {
            return None;
        }
    }
    Some(filtered)
}

fn normalize_json_tool_call_entry(
    entry: &Value,
    options: &Option<TextMarkupNormalizeOptions>,
) -> Option<ToolCallLite> {
    if let Value::Object(rec) = entry {
        let fn_obj = rec.get("function").and_then(|v| v.as_object());
        let name_val = rec
            .get("name")
            .or_else(|| fn_obj.and_then(|f| f.get("name")));
        let name = canonicalize_json_tool_name(name_val?, options)?;
        let args_source = if rec.get("input").is_some() {
            rec.get("input").unwrap()
        } else if rec.get("arguments").is_some() {
            rec.get("arguments").unwrap()
        } else if let Some(f) = fn_obj {
            f.get("arguments")
                .or_else(|| f.get("input"))
                .unwrap_or(&Value::Null)
        } else {
            &Value::Null
        };
        let args_obj = normalize_json_tool_args(name.as_str(), args_source, options)?;
        let args = serde_json::to_string(&args_obj).unwrap_or_else(|_| "{}".to_string());
        let id = rec
            .get("call_id")
            .and_then(|v| v.as_str())
            .filter(|v| !v.trim().is_empty())
            .map(|v| v.trim().to_string())
            .or_else(|| {
                rec.get("id")
                    .and_then(|v| v.as_str())
                    .filter(|v| !v.trim().is_empty())
                    .map(|v| v.trim().to_string())
            })
            .unwrap_or_else(gen_tool_call_id);
        return Some(ToolCallLite {
            id: Some(id),
            name,
            args,
        });
    }
    None
}

fn extract_balanced_json_object_at(text: &str, start_index: usize) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    if start_index >= chars.len() || chars[start_index] != '{' {
        return None;
    }
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    for (i, ch) in chars.iter().enumerate().skip(start_index) {
        if in_string {
            if escaped {
                escaped = false;
                continue;
            }
            if *ch == '\\' {
                escaped = true;
                continue;
            }
            if *ch == '"' {
                in_string = false;
            }
            continue;
        }
        if *ch == '"' {
            in_string = true;
            continue;
        }
        if *ch == '{' {
            depth += 1;
            continue;
        }
        if *ch == '}' {
            depth -= 1;
            if depth == 0 {
                return Some(chars[start_index..=i].iter().collect());
            }
        }
    }
    None
}

fn collect_embedded_tool_call_objects(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut quote_ranges: Vec<(usize, usize)> = Vec::new();
    let lower = text.to_lowercase();
    let mut cursor = 0;
    while cursor < lower.len() {
        if let Some(open) = lower[cursor..].find("<quote>") {
            let start = cursor + open;
            if let Some(close) = lower[start + "<quote>".len()..].find("</quote>") {
                let end = start + "<quote>".len() + close + "</quote>".len();
                quote_ranges.push((start, end));
                cursor = end;
                continue;
            }
        }
        break;
    }
    let inside_quote =
        |idx: usize| -> bool { quote_ranges.iter().any(|(s, e)| idx >= *s && idx < *e) };
    let chars: Vec<char> = text.chars().collect();
    for i in 0..chars.len() {
        if chars[i] != '{' {
            continue;
        }
        if inside_quote(i) {
            continue;
        }
        if let Some(obj) = extract_balanced_json_object_at(text, i) {
            let trimmed = obj.trim().to_string();
            if !trimmed.is_empty()
                && Regex::new(r#"["']tool_calls["']\s*:"#)
                    .unwrap()
                    .is_match(trimmed.as_str())
            {
                if !seen.contains(trimmed.as_str()) {
                    seen.insert(trimmed.clone());
                    out.push(trimmed);
                }
            }
        }
    }
    out
}

fn decode_json_escapes(raw: &str) -> String {
    raw.replace("\\r\\n", "\n")
        .replace("\\n", "\n")
        .replace("\\r", "\n")
        .replace("\\t", "\t")
        .replace("\\\"", "\"")
}

fn extract_possibly_broken_quoted_value(text: &str, keys: &[&str]) -> Option<String> {
    for key in keys {
        let re = Regex::new(format!(r#"\"{}\"\s*:\s*\""#, regex::escape(key)).as_str()).unwrap();
        let search_index = 0;
        while let Some(mat) = re.find(&text[search_index..]) {
            let start = search_index + mat.end();
            let bytes: Vec<char> = text.chars().collect();
            let mut escaped = false;
            for (i, ch) in bytes.iter().enumerate().skip(start) {
                if escaped {
                    escaped = false;
                    continue;
                }
                if *ch == '\\' {
                    escaped = true;
                    continue;
                }
                if *ch == '"' {
                    let sliced: String = bytes[start..i].iter().collect();
                    return Some(decode_json_escapes(sliced.as_str()));
                }
            }
            let sliced: String = bytes[start..].iter().collect();
            return Some(decode_json_escapes(sliced.as_str()));
        }
    }
    None
}

fn salvage_tool_call_from_broken_json_text(
    candidate: &str,
    options: &Option<TextMarkupNormalizeOptions>,
) -> Option<ToolCallLite> {
    let name_re = Regex::new(r#"\"name\"\s*:\s*\"([^\"]+)\""#).unwrap();
    let raw_name = name_re
        .captures(candidate)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string());
    let name_val = raw_name.map(Value::String).unwrap_or(Value::Null);
    let canonical = canonicalize_json_tool_name(&name_val, options)?;
    let mut args: Option<Map<String, Value>> = None;
    if canonical == "exec_command" {
        if let Some(cmd) = extract_possibly_broken_quoted_value(candidate, &["cmd"]) {
            if !cmd.trim().is_empty() {
                let mut map = Map::new();
                map.insert("cmd".to_string(), Value::String(cmd));
                args = Some(map);
            }
        }
    }
    if args.is_none() {
        args = salvage_tool_args_from_raw_text(canonical.as_str(), candidate);
    }
    let normalized = normalize_json_tool_args(canonical.as_str(), &Value::Object(args?), options)?;
    Some(ToolCallLite {
        id: Some(gen_tool_call_id()),
        name: canonical,
        args: serde_json::to_string(&normalized).unwrap_or_else(|_| "{}".to_string()),
    })
}

fn extract_tool_call_entries_from_unknown(value: &Value) -> Vec<Value> {
    if let Value::Array(arr) = value {
        return arr.clone();
    }
    if let Value::Object(rec) = value {
        if let Some(Value::Array(arr)) = rec.get("tool_calls") {
            return arr.clone();
        }
        if let Some(Value::String(s)) = rec.get("tool_calls") {
            if let Some(parsed) = try_parse_json_with_model_repairs(s) {
                return extract_tool_call_entries_from_unknown(&parsed);
            }
        }
    }
    Vec::new()
}

fn extract_json_tool_calls_from_text_impl(
    text: &str,
    options: &Option<TextMarkupNormalizeOptions>,
) -> Option<Vec<ToolCallLite>> {
    if text.trim().is_empty() {
        return None;
    }
    let mut candidates: Vec<String> = Vec::new();
    let mut seen_candidates: HashSet<String> = HashSet::new();
    let mut add_candidate = |raw: &str| {
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() || seen_candidates.contains(&trimmed) {
            return;
        }
        seen_candidates.insert(trimmed.clone());
        candidates.push(trimmed.clone());
        let decoded = decode_json_escapes(trimmed.as_str()).trim().to_string();
        if !decoded.is_empty() && decoded != trimmed && !seen_candidates.contains(&decoded) {
            seen_candidates.insert(decoded.clone());
            candidates.push(decoded);
        }
    };

    add_candidate(text);
    let fence_re =
        Regex::new(r"```(?:json|tool_call|tool_calls|function_call)?\s*([\s\S]*?)\s*```").unwrap();
    for caps in fence_re.captures_iter(text) {
        if let Some(m) = caps.get(1) {
            let body = m.as_str().trim();
            if !body.is_empty() {
                add_candidate(body);
            }
        }
    }
    for embedded in collect_embedded_tool_call_objects(text) {
        add_candidate(embedded.as_str());
    }
    let decoded_text = decode_json_escapes(text);
    if decoded_text != text {
        for embedded in collect_embedded_tool_call_objects(decoded_text.as_str()) {
            add_candidate(embedded.as_str());
        }
    }

    let mut out: Vec<ToolCallLite> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let push_entry =
        |out: &mut Vec<ToolCallLite>, seen: &mut HashSet<String>, raw_entry: &Value| {
            if let Some(normalized) = normalize_json_tool_call_entry(raw_entry, options) {
                let key = format!("{}:{}", normalized.name, normalized.args);
                if seen.insert(key) {
                    out.push(normalized);
                }
            }
        };

    for candidate in candidates.iter() {
        if let Some(parsed) = try_parse_json_with_model_repairs(candidate) {
            for entry in extract_tool_call_entries_from_unknown(&parsed) {
                push_entry(&mut out, &mut seen, &entry);
            }
        }
        if !out.is_empty() {
            continue;
        }
        let wrapper_re =
            Regex::new(r#"^\s*\{\s*["']tool_calls["']\s*:\s*(\[[\s\S]*\])\s*\}\s*$"#).unwrap();
        if let Some(caps) = wrapper_re.captures(candidate) {
            if let Some(body) = caps.get(1) {
                let wrapped = format!("{{\"tool_calls\":{}}}", body.as_str());
                if let Some(parsed) = try_parse_json_with_model_repairs(wrapped.as_str()) {
                    for entry in extract_tool_call_entries_from_unknown(&parsed) {
                        push_entry(&mut out, &mut seen, &entry);
                    }
                }
            }
        }
    }

    if out.is_empty() {
        for candidate in candidates.iter() {
            let lower = candidate.to_lowercase();
            if lower.contains("<quote>") && lower.contains("</quote>") {
                continue;
            }
            if let Some(salvaged) = salvage_tool_call_from_broken_json_text(candidate, options) {
                let mut entry = Map::new();
                entry.insert(
                    "id".to_string(),
                    Value::String(salvaged.id.clone().unwrap_or_default()),
                );
                entry.insert("name".to_string(), Value::String(salvaged.name.clone()));
                let mut fn_obj = Map::new();
                fn_obj.insert("name".to_string(), Value::String(salvaged.name.clone()));
                fn_obj.insert(
                    "arguments".to_string(),
                    Value::String(salvaged.args.clone()),
                );
                entry.insert("function".to_string(), Value::Object(fn_obj));
                push_entry(&mut out, &mut seen, &Value::Object(entry));
            }
        }
    }

    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn is_structured_apply_patch_payload(value: &Value) -> bool {
    if let Value::Object(map) = value {
        if let Some(Value::Array(_)) = map.get("changes") {
            return true;
        }
    }
    false
}

fn extract_structured_apply_patch_payloads(text: &str) -> Vec<Value> {
    let mut payloads = Vec::new();
    let fence_re = Regex::new(r"```(?:json|apply_patch|toon)?\s*([\s\S]*?)\s*```").unwrap();
    for caps in fence_re.captures_iter(text) {
        if let Some(body) = caps.get(1) {
            if let Ok(parsed) = serde_json::from_str::<Value>(body.as_str()) {
                if is_structured_apply_patch_payload(&parsed) {
                    payloads.push(parsed);
                }
            }
        }
    }
    if payloads.is_empty() && text.contains("\"changes\"") {
        if let Ok(parsed) = serde_json::from_str::<Value>(text) {
            if is_structured_apply_patch_payload(&parsed) {
                payloads.push(parsed);
            }
        }
    }
    payloads
}

fn normalize_raw_apply_patch_block(raw: &str) -> String {
    let mut lines: Vec<String> = raw.split("\n").map(|line| line.replace('\r', "")).collect();
    while !lines.is_empty() && lines.first().map(|l| l.trim().is_empty()).unwrap_or(false) {
        lines.remove(0);
    }
    while !lines.is_empty() && lines.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        lines.pop();
    }
    if lines.is_empty() {
        return String::new();
    }
    let mut indents: Vec<usize> = Vec::new();
    for line in lines.iter() {
        if line.trim().is_empty() {
            continue;
        }
        let m = Regex::new(r"^[ \t]*")
            .unwrap()
            .find(line)
            .map(|m| m.as_str().len())
            .unwrap_or(0);
        indents.push(m);
    }
    let min_indent = indents.into_iter().min().unwrap_or(0);
    if min_indent == 0 {
        return lines.join("\n").trim().to_string();
    }
    let re = Regex::new(format!(r"^[ \t]{{0,{}}}", min_indent).as_str()).unwrap();
    lines
        .into_iter()
        .map(|line| re.replace(line.as_str(), "").to_string())
        .collect::<Vec<String>>()
        .join("\n")
        .trim()
        .to_string()
}

fn extract_raw_apply_patch_blocks(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    if text.is_empty() {
        return out;
    }
    let block_re = Regex::new(r"(?m)^[ \t]*\*\*\*\s*Begin Patch(?:\s*\*\*\*)?[\s\S]*?^[ \t]*\*\*\*\s*End Patch(?:\s*\*\*\*)?").unwrap();
    let mut seen = HashSet::new();
    for m in block_re.find_iter(text) {
        let normalized = normalize_raw_apply_patch_block(m.as_str());
        if normalized.is_empty() {
            continue;
        }
        let header_re = Regex::new(r"(?m)^[ \t]*\*\*\*\s*(?:Add|Update|Delete)\s+File:").unwrap();
        if !header_re.is_match(normalized.as_str()) {
            continue;
        }
        if seen.insert(normalized.clone()) {
            out.push(normalized);
        }
    }
    out
}

fn extract_apply_patch_calls_from_text_impl(text: &str) -> Option<Vec<ToolCallLite>> {
    if text.is_empty() {
        return None;
    }
    let payloads = extract_structured_apply_patch_payloads(text);
    let patch_blocks = extract_raw_apply_patch_blocks(text);
    if payloads.is_empty() && patch_blocks.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    for payload in payloads {
        let args =
            serde_json::to_string(&payload).unwrap_or_else(|_| "{\"changes\":[]}".to_string());
        out.push(ToolCallLite {
            id: Some(gen_tool_call_id()),
            name: "apply_patch".to_string(),
            args,
        });
    }
    for patch in patch_blocks {
        let args = serde_json::to_string(&serde_json::json!({"patch": patch, "input": patch}))
            .unwrap_or_else(|_| "{\"patch\":\"\"}".to_string());
        out.push(ToolCallLite {
            id: Some(gen_tool_call_id()),
            name: "apply_patch".to_string(),
            args,
        });
    }
    Some(out)
}

fn apply_tool_inner_field(
    lname: &str,
    args_obj: &mut Map<String, Value>,
    raw_key: &str,
    raw_val_input: &str,
) {
    let key = normalize_key(raw_key).to_lowercase();
    if key.is_empty() || key == "requires_approval" {
        return;
    }
    let raw_val = raw_val_input.to_string();
    let value = try_parse_primitive_value(raw_val.as_str());

    if lname == "exec_command" && key == "cmd" {
        let cmd = coerce_command_value_to_string(&value);
        if !cmd.trim().is_empty() {
            args_obj.insert("cmd".to_string(), Value::String(cmd));
        }
        return;
    }
    if lname == "exec_command" && (key == "cwd" || key == "workdir") {
        let wd = match value {
            Value::String(s) => s.trim().to_string(),
            _ => raw_val.trim().to_string(),
        };
        if !wd.is_empty() {
            args_obj.insert("workdir".to_string(), Value::String(wd));
        }
        return;
    }
    if lname == "write_stdin" {
        if ["input", "data", "chars", "text"].contains(&key.as_str()) {
            args_obj.insert("chars".to_string(), Value::String(raw_val));
            return;
        }
        if key == "session_id" {
            if let Ok(n) = value_to_string(&value).parse::<i64>() {
                args_obj.insert("session_id".to_string(), Value::Number(n.into()));
            } else {
                args_obj.insert("session_id".to_string(), value);
            }
            return;
        }
    }
    if lname == "apply_patch" && ["patch", "input", "text", "instructions"].contains(&key.as_str())
    {
        let patch_text = match value {
            Value::String(s) => s,
            _ => raw_val,
        };
        if !patch_text.trim().is_empty() {
            args_obj.insert("patch".to_string(), Value::String(patch_text));
        }
        return;
    }
    args_obj.insert(key, value);
}

fn is_image_path(input: &str) -> bool {
    let lowered = input.trim().to_ascii_lowercase();
    if lowered.is_empty() {
        return false;
    }
    let re = Regex::new(r"\.(png|jpg|jpeg|gif|webp|bmp|svg|tiff?|ico|heic|jxl)$").unwrap();
    re.is_match(lowered.as_str())
}

fn extract_tool_namespace_xml_blocks_from_text_impl(text: &str) -> Option<Vec<ToolCallLite>> {
    if text.is_empty() {
        return None;
    }
    let has_open = text.contains("<tool:");
    let has_close = Regex::new(r"</\s*tool:\s*[A-Za-z0-9_]+\s*>")
        .unwrap()
        .is_match(text);
    let has_prefix = Regex::new(r"(?:^|\n)\s*(?:[•*+-]\s*)?tool:[A-Za-z0-9_]+")
        .unwrap()
        .is_match(text);
    if !has_open && !(has_close && has_prefix) {
        return None;
    }
    let known = known_tools();
    let mut out = Vec::new();
    let block_re =
        Regex::new(r"<\s*tool:([A-Za-z0-9_]+)\s*>([\s\S]*?)</\s*tool:\s*([A-Za-z0-9_]+)\s*>")
            .unwrap();
    for caps in block_re.captures_iter(text) {
        let raw_name = caps
            .get(1)
            .map(|m| m.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let close_name = caps
            .get(3)
            .map(|m| m.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if !raw_name.eq_ignore_ascii_case(close_name.as_str()) {
            continue;
        }
        let lname = raw_name.to_lowercase();
        if lname.is_empty() || !known.contains(lname.as_str()) {
            continue;
        }
        let inner = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let mut args_obj = Map::new();
        let kv_re = Regex::new(
            r"<\s*([A-Za-z_][A-Za-z0-9_]*)\s*>([\s\S]*?)</\s*([A-Za-z_][A-Za-z0-9_]*)\s*>",
        )
        .unwrap();
        for km in kv_re.captures_iter(inner) {
            let raw_key = km.get(1).map(|m| m.as_str()).unwrap_or("");
            let close_key = km.get(3).map(|m| m.as_str()).unwrap_or("");
            if !raw_key.eq_ignore_ascii_case(close_key) {
                continue;
            }
            let raw_val = km.get(2).map(|m| m.as_str()).unwrap_or("");
            apply_tool_inner_field(lname.as_str(), &mut args_obj, raw_key, raw_val);
        }
        let param_re = Regex::new(
            r#"<\s*parameter\s+name\s*=\s*"([^">]+)"\s*>([\s\S]*?)</\s*([A-Za-z0-9_]+)\s*>"#,
        )
        .unwrap();
        for pm in param_re.captures_iter(inner) {
            let raw_key = pm.get(1).map(|m| m.as_str()).unwrap_or("");
            let close_key = pm.get(3).map(|m| m.as_str()).unwrap_or("");
            let close_lower = close_key.to_ascii_lowercase();
            if close_lower != "parameter" && !raw_key.eq_ignore_ascii_case(close_key) {
                continue;
            }
            let raw_val = pm.get(2).map(|m| m.as_str()).unwrap_or("");
            apply_tool_inner_field(lname.as_str(), &mut args_obj, raw_key, raw_val);
        }
        let filtered = filter_args_for_tool(lname.as_str(), &args_obj);
        if lname == "exec_command" {
            let cmd = filtered
                .get("cmd")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if cmd.is_empty() {
                continue;
            }
        }
        if lname == "write_stdin" {
            let sid = filtered.get("session_id");
            if sid.is_none() || value_to_string(sid.unwrap()).trim().is_empty() {
                continue;
            }
        }
        if lname == "apply_patch" {
            let patch = filtered
                .get("patch")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if patch.is_empty() {
                continue;
            }
        }
        let args = serde_json::to_string(&filtered).unwrap_or_else(|_| "{}".to_string());
        out.push(ToolCallLite {
            id: Some(gen_tool_call_id()),
            name: lname.clone(),
            args,
        });
    }

    let prefix_block_re = Regex::new(
    r"(?:^|\n)\s*(?:[•*+-]\s*)?tool:([A-Za-z0-9_]+)[^\n]*\n([\s\S]*?)</\s*tool:\s*([A-Za-z0-9_]+)\s*>"
  ).unwrap();
    for caps in prefix_block_re.captures_iter(text) {
        let raw_name = caps
            .get(1)
            .map(|m| m.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let close_name = caps
            .get(3)
            .map(|m| m.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if !raw_name.eq_ignore_ascii_case(close_name.as_str()) {
            continue;
        }
        let lname = raw_name.to_lowercase();
        if lname.is_empty() || !known.contains(lname.as_str()) {
            continue;
        }
        let inner = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let mut args_obj = Map::new();
        let kv_re = Regex::new(
            r"<\s*([A-Za-z_][A-Za-z0-9_]*)\s*>([\s\S]*?)</\s*([A-Za-z_][A-Za-z0-9_]*)\s*>",
        )
        .unwrap();
        for km in kv_re.captures_iter(inner) {
            let raw_key = km.get(1).map(|m| m.as_str()).unwrap_or("");
            let close_key = km.get(3).map(|m| m.as_str()).unwrap_or("");
            if !raw_key.eq_ignore_ascii_case(close_key) {
                continue;
            }
            let raw_val = km.get(2).map(|m| m.as_str()).unwrap_or("");
            apply_tool_inner_field(lname.as_str(), &mut args_obj, raw_key, raw_val);
        }
        let param_re = Regex::new(
            r#"<\s*parameter\s+name\s*=\s*"([^">]+)"\s*>([\s\S]*?)</\s*([A-Za-z0-9_]+)\s*>"#,
        )
        .unwrap();
        for pm in param_re.captures_iter(inner) {
            let raw_key = pm.get(1).map(|m| m.as_str()).unwrap_or("");
            let close_key = pm.get(3).map(|m| m.as_str()).unwrap_or("");
            let close_lower = close_key.to_ascii_lowercase();
            if close_lower != "parameter" && !raw_key.eq_ignore_ascii_case(close_key) {
                continue;
            }
            let raw_val = pm.get(2).map(|m| m.as_str()).unwrap_or("");
            apply_tool_inner_field(lname.as_str(), &mut args_obj, raw_key, raw_val);
        }
        let filtered = filter_args_for_tool(lname.as_str(), &args_obj);
        if lname == "exec_command" {
            let cmd = filtered
                .get("cmd")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if cmd.is_empty() {
                continue;
            }
        }
        if lname == "write_stdin" {
            let sid = filtered.get("session_id");
            if sid.is_none() || value_to_string(sid.unwrap()).trim().is_empty() {
                continue;
            }
        }
        if lname == "apply_patch" {
            let patch = filtered
                .get("patch")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if patch.is_empty() {
                continue;
            }
        }
        let args = serde_json::to_string(&filtered).unwrap_or_else(|_| "{}".to_string());
        out.push(ToolCallLite {
            id: Some(gen_tool_call_id()),
            name: lname,
            args,
        });
    }

    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn extract_parameter_xml_tools_from_text_impl(text: &str) -> Option<Vec<ToolCallLite>> {
    if text.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    let tool_re = Regex::new(r"<\s*(exec_command)\s*>([\s\S]*?)</\s*([A-Za-z0-9_]+)\s*>").unwrap();
    for caps in tool_re.captures_iter(text) {
        let raw_name = caps
            .get(1)
            .map(|m| m.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let close_name = caps
            .get(3)
            .map(|m| m.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let close_lower = close_name.to_ascii_lowercase();
        if close_lower != "exec_command" && close_lower != "func_call" && close_lower != "tool_call"
        {
            continue;
        }
        let inner = caps
            .get(2)
            .map(|m| m.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if raw_name.is_empty() || inner.is_empty() {
            continue;
        }
        let lname = raw_name.to_lowercase();
        let mut args_obj = Map::new();
        let param_re =
            Regex::new(r#"<\s*parameter\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)</\s*parameter\s*>"#)
                .unwrap();
        for pm in param_re.captures_iter(inner.as_str()) {
            let raw_key = pm.get(1).map(|m| m.as_str()).unwrap_or("");
            let raw_val = pm.get(2).map(|m| m.as_str()).unwrap_or("");
            apply_tool_inner_field(lname.as_str(), &mut args_obj, raw_key, raw_val);
        }
        if args_obj.is_empty() {
            continue;
        }
        if lname == "exec_command" {
            let env_workdir = read_default_workdir_from_env();
            let cmd = args_obj
                .get("cmd")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if cmd.is_empty() {
                continue;
            }
            if let Some(wd) = env_workdir {
                args_obj
                    .entry("workdir".to_string())
                    .or_insert(Value::String(wd));
            }
        }
        let filtered = filter_args_for_tool(lname.as_str(), &args_obj);
        let args = serde_json::to_string(&filtered).unwrap_or_else(|_| "{}".to_string());
        out.push(ToolCallLite {
            id: Some(gen_tool_call_id()),
            name: lname,
            args,
        });
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn extract_invoke_tools_from_text_impl(text: &str) -> Option<Vec<ToolCallLite>> {
    if text.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    let invoke_re =
        Regex::new(r#"<\s*invoke\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)</\s*invoke\s*>"#).unwrap();
    for caps in invoke_re.captures_iter(text) {
        let raw_name = caps
            .get(1)
            .map(|m| m.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let inner = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        if raw_name.is_empty() {
            continue;
        }
        let lname = raw_name.to_lowercase();
        let mut args_obj = Map::new();
        let param_re =
            Regex::new(r#"<\s*parameter\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)</\s*parameter\s*>"#)
                .unwrap();
        for pm in param_re.captures_iter(inner) {
            let raw_key = pm.get(1).map(|m| m.as_str()).unwrap_or("");
            let raw_val = pm.get(2).map(|m| m.as_str()).unwrap_or("");
            apply_tool_inner_field(lname.as_str(), &mut args_obj, raw_key, raw_val);
        }
        if args_obj.is_empty() {
            continue;
        }
        let filtered = filter_args_for_tool(lname.as_str(), &args_obj);
        let args = serde_json::to_string(&filtered).unwrap_or_else(|_| "{}".to_string());
        out.push(ToolCallLite {
            id: Some(gen_tool_call_id()),
            name: lname,
            args,
        });
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn extract_xml_tool_calls_from_text_impl(text: &str) -> Option<Vec<ToolCallLite>> {
    if text.is_empty() {
        return None;
    }
    let mut out: Vec<ToolCallLite> = Vec::new();
    if let Some(mut calls) = extract_tool_namespace_xml_blocks_from_text_impl(text) {
        out.append(&mut calls);
    }
    if let Some(mut calls) = extract_parameter_xml_tools_from_text_impl(text) {
        out.append(&mut calls);
    }
    if let Some(mut calls) = extract_invoke_tools_from_text_impl(text) {
        out.append(&mut calls);
    }
    if let Some(mut calls) = extract_simple_xml_tools_from_text_impl(text) {
        out.append(&mut calls);
    }
    if let Some(mut calls) = extract_qwen_tool_call_tokens_from_text_impl(text) {
        out.append(&mut calls);
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn extract_simple_xml_tools_from_text_impl(text: &str) -> Option<Vec<ToolCallLite>> {
    if text.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    let tool_re = Regex::new(
    r"<\s*(exec_command|write_stdin|apply_patch|view_image|list_directory)\s*>([\s\S]*?)</\s*([A-Za-z0-9_]+)\s*>"
  ).unwrap();
    for caps in tool_re.captures_iter(text) {
        let raw_name = caps
            .get(1)
            .map(|m| m.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let close_name = caps
            .get(3)
            .map(|m| m.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if !raw_name.eq_ignore_ascii_case(close_name.as_str()) {
            continue;
        }
        let inner = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        if raw_name.is_empty() {
            continue;
        }
        let lname = raw_name.to_lowercase();
        let mut args_obj = Map::new();
        let kv_re = Regex::new(
            r"<\s*([A-Za-z_][A-Za-z0-9_]*)\s*>([\s\S]*?)</\s*([A-Za-z_][A-Za-z0-9_]*)\s*>",
        )
        .unwrap();
        for km in kv_re.captures_iter(inner) {
            let raw_key = km.get(1).map(|m| m.as_str()).unwrap_or("");
            let close_key = km.get(3).map(|m| m.as_str()).unwrap_or("");
            if !raw_key.eq_ignore_ascii_case(close_key) {
                continue;
            }
            let raw_val = km.get(2).map(|m| m.as_str()).unwrap_or("");
            apply_tool_inner_field(lname.as_str(), &mut args_obj, raw_key, raw_val);
        }
        if lname == "exec_command"
            && args_obj
                .get("cmd")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .is_empty()
        {
            continue;
        }
        if lname == "write_stdin" && args_obj.get("session_id").is_none() {
            continue;
        }
        if lname == "apply_patch"
            && args_obj
                .get("patch")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .is_empty()
        {
            continue;
        }
        if lname == "view_image" {
            let path = args_obj
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if path.is_empty() || !is_image_path(path.as_str()) {
                continue;
            }
        }
        if lname == "list_directory" {
            let path = args_obj
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if path.is_empty() {
                continue;
            }
        }
        let filtered = filter_args_for_tool(lname.as_str(), &args_obj);
        let args = serde_json::to_string(&filtered).unwrap_or_else(|_| "{}".to_string());
        out.push(ToolCallLite {
            id: Some(gen_tool_call_id()),
            name: lname,
            args,
        });
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn try_parse_json_array_on_line(line: &str) -> Option<Vec<String>> {
    let trimmed = line.trim();
    if !(trimmed.starts_with('[') && trimmed.ends_with(']')) {
        return None;
    }
    let parsed = serde_json::from_str::<Value>(trimmed).ok()?;
    let arr = parsed.as_array()?;
    let mut out = Vec::new();
    for entry in arr.iter() {
        if entry.is_null() {
            continue;
        }
        out.push(value_to_string(entry));
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn strip_trailing_xml_garbage(line: &str) -> String {
    if let Some(idx) = line.find('<') {
        return line[..idx].trim().to_string();
    }
    line.trim().to_string()
}

fn normalize_possible_command_line(raw: &str) -> String {
    let mut line = raw.to_string();
    let re_bullet = Regex::new(r"^\s*(?:[•*+-]\s*)?").unwrap();
    line = re_bullet.replace(line.as_str(), "").to_string();
    let re_dollar = Regex::new(r"^\s*\$\s*").unwrap();
    line = re_dollar.replace(line.as_str(), "").to_string();
    strip_trailing_xml_garbage(line.as_str())
}

fn looks_like_shell_command(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return false;
    }
    if t.starts_with("```") || t.starts_with('>') {
        return false;
    }
    if t.starts_with("zsh:") || t.starts_with("bash:") {
        return false;
    }
    let re = Regex::new(
        r"^(?:rg|ls|cat|node|npm|pnpm|yarn|git|find|sed|head|tail|wc|mkdir|rm|cp|mv|pwd)\b",
    )
    .unwrap();
    re.is_match(t)
}

fn looks_like_broken_tool_markup(text: &str) -> bool {
    let t = text.to_string();
    if t.is_empty() {
        return false;
    }
    let ran_re = Regex::new(r"^\s*(?:[•*+-]\s*)?Ran\s+(.+)$").unwrap();
    let has_ran_shell = ran_re.captures_iter(t.as_str()).any(|caps| {
        let payload = caps
            .get(1)
            .map(|m| m.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if payload.is_empty() {
            return false;
        }
        if let Some(arr) = try_parse_json_array_on_line(payload.as_str()) {
            return looks_like_shell_command(arr.join(" ").as_str());
        }
        looks_like_shell_command(payload.as_str())
    });
    t.contains("<exec_command")
        || t.contains("<invoke")
        || t.contains("<function_calls")
        || t.contains("<parameter")
        || t.contains("<tool_call")
        || t.contains("</tool_call")
        || t.contains("<arg_value")
        || t.contains("</arg_value")
        || t.contains("</func_call")
        || Regex::new(r"\bRan\b\s+\[").unwrap().is_match(t.as_str())
        || has_ran_shell
}

fn extract_bare_exec_command_from_text_impl(text: &str) -> Option<Vec<ToolCallLite>> {
    if text.is_empty() {
        return None;
    }
    if !looks_like_broken_tool_markup(text) {
        return None;
    }
    let mut candidates: Vec<(String, Option<String>)> = Vec::new();
    for raw in text.lines() {
        let line = normalize_possible_command_line(raw);
        if line.is_empty() {
            continue;
        }
        if let Some(caps) = Regex::new(r"^Ran\s+(.+)$").unwrap().captures(line.as_str()) {
            let payload = caps
                .get(1)
                .map(|m| m.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if payload.is_empty() {
                continue;
            }
            if let Some(arr) = try_parse_json_array_on_line(payload.as_str()) {
                let cmd = arr.join(" ").trim().to_string();
                if looks_like_shell_command(cmd.as_str()) {
                    candidates.push((cmd, None));
                    continue;
                }
            }
            if looks_like_shell_command(payload.as_str()) {
                candidates.push((payload, None));
                continue;
            }
        }
        if looks_like_shell_command(line.as_str()) {
            candidates.push((line.trim().to_string(), None));
        }
    }
    if candidates.is_empty() {
        return None;
    }
    let picked = candidates.last().unwrap().0.clone();
    let mut args_obj = Map::new();
    args_obj.insert("cmd".to_string(), Value::String(picked));
    if let Some(wd) = read_default_workdir_from_env() {
        args_obj.insert("workdir".to_string(), Value::String(wd));
    }
    let filtered = filter_args_for_tool("exec_command", &args_obj);
    let args = serde_json::to_string(&filtered).unwrap_or_else(|_| "{}".to_string());
    Some(vec![ToolCallLite {
        id: Some(gen_tool_call_id()),
        name: "exec_command".to_string(),
        args,
    }])
}

fn extract_execute_blocks_from_text_impl(text: &str) -> Option<Vec<ToolCallLite>> {
    if text.is_empty() {
        return None;
    }
    let re =
        Regex::new(r"<function=execute>\s*<parameter=command>([\s\S]*?)</parameter>\s*</function>")
            .unwrap();
    let mut out = Vec::new();
    for caps in re.captures_iter(text) {
        let command_raw = caps
            .get(1)
            .map(|m| m.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if command_raw.is_empty() {
            continue;
        }
        let args = serde_json::to_string(&serde_json::json!({"command": command_raw}))
            .unwrap_or_else(|_| "{\"command\":\"\"}".to_string());
        out.push(ToolCallLite {
            id: Some(gen_tool_call_id()),
            name: "shell".to_string(),
            args,
        });
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn normalize_explored_list_path(raw: &str) -> String {
    let mut path = raw.trim().to_string();
    let re_prefix = Regex::new(r"^[\s│]+|^[└├─]+\s*").unwrap();
    path = re_prefix.replace(path.as_str(), "").to_string();
    if path.len() >= 2 {
        let bytes = path.as_bytes();
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'`' || first == b'"' || first == b'\'') && first == last {
            path = path[1..path.len() - 1].to_string();
        }
    }
    if path.is_empty() {
        return String::new();
    }
    let first = path.lines().next().unwrap_or("").trim().to_string();
    if first.is_empty() {
        return String::new();
    }
    if Regex::new(r"^(?:and|with|for|to)\b")
        .unwrap()
        .is_match(first.as_str())
    {
        return String::new();
    }
    if Regex::new(r"[<>|;&]").unwrap().is_match(first.as_str()) {
        return String::new();
    }
    first
}

fn extract_explored_list_directory_calls_from_text_impl(text: &str) -> Option<Vec<ToolCallLite>> {
    if text.is_empty() {
        return None;
    }
    let has_explored = Regex::new(r"(?:^|\n)\s*(?:[•*+-]\s*)?Explored\b")
        .unwrap()
        .is_match(text);
    let has_tree = Regex::new(r"(?:^|\n)\s*[│\s]*[└├]\s*List\s+")
        .unwrap()
        .is_match(text);
    if !has_explored && !has_tree {
        return None;
    }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for raw_line in text.lines() {
        let mut line = raw_line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        line = Regex::new(r"^[•*+-]\s*")
            .unwrap()
            .replace(line.as_str(), "")
            .to_string();
        line = Regex::new(r"^[\s│]+|^[└├─]+\s*")
            .unwrap()
            .replace(line.as_str(), "")
            .to_string();
        let list_re = Regex::new(r"^List\s+([\s\S]+)$").unwrap();
        if let Some(caps) = list_re.captures(line.as_str()) {
            let raw_path = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let path = normalize_explored_list_path(raw_path);
            if path.is_empty() || seen.contains(&path) {
                continue;
            }
            seen.insert(path.clone());
            let args =
                serde_json::to_string(&serde_json::json!({"path": path, "recursive": false}))
                    .unwrap_or_else(|_| "{}".to_string());
            out.push(ToolCallLite {
                id: Some(gen_tool_call_id()),
                name: "list_directory".to_string(),
                args,
            });
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn extract_qwen_tool_call_tokens_from_text_impl(text: &str) -> Option<Vec<ToolCallLite>> {
    if text.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    let re = Regex::new(
    r"(?is)<tool_call>[\s\S]*?<arg_key>[^<]+</arg_key>\s*<arg_value>[\s\S]*?</arg_value>[\s\S]*?</tool_call>"
  ).unwrap();
    if !re.is_match(text) {
        return None;
    }
    let tool_re = Regex::new(r"(?is)<tool_call>([\s\S]*?)</tool_call>").unwrap();
    for caps in tool_re.captures_iter(text) {
        let payload = caps
            .get(1)
            .map(|m| m.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if payload.is_empty() {
            continue;
        }
        if let Some(parsed) = parse_qwen_tool_call_payload(payload.as_str()) {
            out.push(parsed);
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn parse_qwen_tool_call_payload(raw: &str) -> Option<ToolCallLite> {
    let name_re = Regex::new(r"<\s*tool\s*>\s*([^<]+)\s*</\s*tool\s*>").unwrap();
    let mut name = name_re
        .captures(raw)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().trim().to_string())
        .filter(|v| !v.is_empty());
    if name.is_none() {
        let line_re = Regex::new(r"^\s*([^<\s][^<]*)$".trim()).unwrap();
        for line in raw.lines() {
            if let Some(caps) = line_re.captures(line.trim()) {
                let candidate = caps
                    .get(1)
                    .map(|m| m.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !candidate.is_empty() {
                    name = Some(candidate);
                    break;
                }
            }
        }
    }
    let name_val = name?;
    let mut args_obj = Map::new();
    let arg_re = Regex::new(r"(?is)<\s*arg_key\s*>\s*([^<]+?)\s*</\s*arg_key\s*>\s*<\s*arg_value\s*>([\s\S]*?)</\s*arg_value\s*>").unwrap();
    for caps in arg_re.captures_iter(raw) {
        let raw_key = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let raw_val = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let key = normalize_key(raw_key);
        if key.is_empty() {
            continue;
        }
        args_obj.insert(key, Value::String(raw_val.trim().to_string()));
    }
    if args_obj.is_empty() {
        return None;
    }
    let args = serde_json::to_string(&args_obj).unwrap_or_else(|_| "{}".to_string());
    Some(ToolCallLite {
        id: Some(gen_tool_call_id()),
        name: name_val,
        args,
    })
}

#[napi]
pub fn extract_json_tool_calls_from_text_json(input_json: String) -> NapiResult<String> {
    let input: JsonToolCallsInput = serde_json::from_str(&input_json).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse text markup input: {}", e))
    })?;
    let calls = extract_json_tool_calls_from_text_impl(input.text.as_str(), &input.options);
    serde_json::to_string(&calls)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize tool calls: {}", e)))
}

#[napi]
pub fn extract_xml_tool_calls_from_text_json(input_json: String) -> NapiResult<String> {
    let value: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse XML input: {}", e)))?;
    let text = value.get("text").and_then(Value::as_str).unwrap_or("");
    let calls = extract_xml_tool_calls_from_text_impl(text);
    serde_json::to_string(&calls)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize tool calls: {}", e)))
}

#[napi]
pub fn extract_simple_xml_tools_from_text_json(input_json: String) -> NapiResult<String> {
    let value: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse XML input: {}", e)))?;
    let text = value.get("text").and_then(Value::as_str).unwrap_or("");
    let calls = extract_simple_xml_tools_from_text_impl(text);
    serde_json::to_string(&calls)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize tool calls: {}", e)))
}

#[napi]
pub fn extract_parameter_xml_tools_from_text_json(input_json: String) -> NapiResult<String> {
    let value: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse XML input: {}", e)))?;
    let text = value.get("text").and_then(Value::as_str).unwrap_or("");
    let calls = extract_parameter_xml_tools_from_text_impl(text);
    serde_json::to_string(&calls)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize tool calls: {}", e)))
}

#[napi]
pub fn extract_invoke_tools_from_text_json(input_json: String) -> NapiResult<String> {
    let value: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse XML input: {}", e)))?;
    let text = value.get("text").and_then(Value::as_str).unwrap_or("");
    let calls = extract_invoke_tools_from_text_impl(text);
    serde_json::to_string(&calls)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize tool calls: {}", e)))
}

#[napi]
pub fn extract_tool_namespace_xml_blocks_from_text_json(input_json: String) -> NapiResult<String> {
    let value: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse XML input: {}", e)))?;
    let text = value.get("text").and_then(Value::as_str).unwrap_or("");
    let calls = extract_tool_namespace_xml_blocks_from_text_impl(text);
    serde_json::to_string(&calls)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize tool calls: {}", e)))
}

#[napi]
pub fn extract_apply_patch_calls_from_text_json(input_json: String) -> NapiResult<String> {
    let value: Value = serde_json::from_str(&input_json).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse apply_patch input: {}", e))
    })?;
    let text = value.get("text").and_then(Value::as_str).unwrap_or("");
    let calls = extract_apply_patch_calls_from_text_impl(text);
    serde_json::to_string(&calls)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize tool calls: {}", e)))
}

#[napi]
pub fn extract_bare_exec_command_from_text_json(input_json: String) -> NapiResult<String> {
    let value: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse exec input: {}", e)))?;
    let text = value.get("text").and_then(Value::as_str).unwrap_or("");
    let calls = extract_bare_exec_command_from_text_impl(text);
    serde_json::to_string(&calls)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize tool calls: {}", e)))
}

#[napi]
pub fn extract_execute_blocks_from_text_json(input_json: String) -> NapiResult<String> {
    let value: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse execute input: {}", e)))?;
    let text = value.get("text").and_then(Value::as_str).unwrap_or("");
    let calls = extract_execute_blocks_from_text_impl(text);
    serde_json::to_string(&calls)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize tool calls: {}", e)))
}

#[napi]
pub fn extract_explored_list_directory_calls_from_text_json(
    input_json: String,
) -> NapiResult<String> {
    let value: Value = serde_json::from_str(&input_json).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse list_directory input: {}", e))
    })?;
    let text = value.get("text").and_then(Value::as_str).unwrap_or("");
    let calls = extract_explored_list_directory_calls_from_text_impl(text);
    serde_json::to_string(&calls)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize tool calls: {}", e)))
}

#[napi]
pub fn extract_qwen_tool_call_tokens_from_text_json(input_json: String) -> NapiResult<String> {
    let value: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse qwen input: {}", e)))?;
    let text = value.get("text").and_then(Value::as_str).unwrap_or("");
    let calls = extract_qwen_tool_call_tokens_from_text_impl(text);
    serde_json::to_string(&calls)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize tool calls: {}", e)))
}
