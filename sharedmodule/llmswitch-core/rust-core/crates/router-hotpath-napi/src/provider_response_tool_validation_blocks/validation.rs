//! Tool Call Validation Blocks — Rust migration batch #5.
//!
//! Shape-only validators for supported tool types.
//! Migrated from TS `provider-response-tool-validation-blocks.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Constants: shell wrapper prefixes for has_invalid_shell_wrapper_shape
// ---------------------------------------------------------------------------

const SHELL_WRAPPER_PREFIXES: &[&str] = &[
    "bash -lc '",
    "bash -c '",
    "sh -lc '",
    "sh -c '",
    "zsh -lc '",
    "zsh -c '",
];

/// Broad-kill command names (AGENTS.md #7).
const BROAD_KILL_COMMANDS: &[&str] = &["pkill", "killall", "taskkill"];

// ---------------------------------------------------------------------------
// Simple predicates
// ---------------------------------------------------------------------------

/// Mirrors TS `isImagePathLike`.
pub fn is_image_path_like(value: &str) -> bool {
    !value.is_empty()
}

/// Mirrors TS `hasInvalidShellWrapperShape`.
pub fn has_invalid_shell_wrapper_shape(cmd: &str) -> bool {
    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return false;
    }
    SHELL_WRAPPER_PREFIXES
        .iter()
        .any(|prefix| trimmed.starts_with(prefix) && !trimmed.ends_with("'"))
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/// Mirrors TS `parseToolArgsRecord`.
pub fn parse_tool_args_record(args_string: &str) -> Option<serde_json::Map<String, Value>> {
    let trimmed = args_string.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !trimmed.starts_with('{') && !trimmed.starts_with('[') {
        return None;
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// Mirrors TS `buildMissingFields`.
pub fn build_missing_fields(fields: &[Option<String>]) -> Option<Vec<String>> {
    let normalized: Vec<String> = fields
        .iter()
        .filter_map(|f| {
            let s = f.as_deref()?.trim();
            if s.is_empty() { None } else { Some(s.to_string()) }
        })
        .collect();
    if normalized.is_empty() { None } else { Some(normalized) }
}

// ---------------------------------------------------------------------------
// Broad kill command detection (shell scanning)
// ---------------------------------------------------------------------------

/// A span of a shell token, storing the word and its position.
#[derive(Debug, Clone)]
struct ShellTokenSpan {
    value: String,
    // not used in pure logic but kept for traceability
    _start: usize,
    _end: usize,
}

/// Unwrap a shell wrapper command (bash -c '...') to get the inner command.
fn unwrap_shell_wrapper_command(input: &str) -> String {
    let trimmed = input.trim();
    // Match pattern: (bash|sh|zsh) -l?c '...'
    if let Some(inner) = trimmed
        .strip_prefix("bash -lc '")
        .or_else(|| trimmed.strip_prefix("bash -c '"))
        .or_else(|| trimmed.strip_prefix("sh -lc '"))
        .or_else(|| trimmed.strip_prefix("sh -c '"))
        .or_else(|| trimmed.strip_prefix("zsh -lc '"))
        .or_else(|| trimmed.strip_prefix("zsh -c '"))
    {
        // Find matching closing single quote
        if let Some(end) = inner.rfind('\'') {
            return inner[..end].to_string();
        }
    }
    trimmed.to_string()
}

/// Tokenize a shell command into words, respecting quotes and operators.
fn tokenize_shell_words(input: &str) -> Vec<ShellTokenSpan> {
    let mut tokens: Vec<ShellTokenSpan> = Vec::new();
    let chars: Vec<char> = input.chars().collect();
    let mut token_start: Option<usize> = None;
    let mut token_value = String::new();
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut escaping = false;

    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        let next = chars.get(i + 1).copied().unwrap_or('\0');

        if escaping {
            token_value.push(ch);
            if token_start.is_none() {
                token_start = Some(i);
            }
            escaping = false;
            i += 1;
            continue;
        }

        if !in_single_quote && ch == '\\' {
            token_value.push(ch);
            if token_start.is_none() {
                token_start = Some(i);
            }
            escaping = true;
            i += 1;
            continue;
        }

        if !in_double_quote && ch == '\'' {
            token_value.push(ch);
            if token_start.is_none() {
                token_start = Some(i);
            }
            in_single_quote = !in_single_quote;
            i += 1;
            continue;
        }

        if !in_single_quote && ch == '"' {
            token_value.push(ch);
            if token_start.is_none() {
                token_start = Some(i);
            }
            in_double_quote = !in_double_quote;
            i += 1;
            continue;
        }

        if !in_single_quote && !in_double_quote {
            if ch.is_whitespace() {
                if let Some(start) = token_start.take() {
                    tokens.push(ShellTokenSpan {
                        value: std::mem::take(&mut token_value),
                        _start: start,
                        _end: i,
                    });
                }
                i += 1;
                continue;
            }
            if (ch == '&' && next == '&') || (ch == '|' && next == '|') {
                if let Some(start) = token_start.take() {
                    tokens.push(ShellTokenSpan {
                        value: std::mem::take(&mut token_value),
                        _start: start,
                        _end: i,
                    });
                }
                tokens.push(ShellTokenSpan {
                    value: format!("{}{}", ch, next),
                    _start: i,
                    _end: i + 2,
                });
                i += 2;
                continue;
            }
            if ch == '|' || ch == ';' {
                if let Some(start) = token_start.take() {
                    tokens.push(ShellTokenSpan {
                        value: std::mem::take(&mut token_value),
                        _start: start,
                        _end: i,
                    });
                }
                tokens.push(ShellTokenSpan {
                    value: ch.to_string(),
                    _start: i,
                    _end: i + 1,
                });
                i += 1;
                continue;
            }
        }

        if token_start.is_none() {
            token_start = Some(i);
        }
        token_value.push(ch);
        i += 1;
    }

    if let Some(start) = token_start.take() {
        tokens.push(ShellTokenSpan {
            value: token_value,
            _start: start,
            _end: i,
        });
    }

    tokens
}

fn is_command_position(tokens: &[ShellTokenSpan], index: usize) -> bool {
    if index == 0 {
        return true;
    }
    let prev = &tokens[index - 1];
    prev.value == "|" || prev.value == "||" || prev.value == "&&" || prev.value == ";"
}

fn normalize_command_name(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // Strip surrounding quotes
    let unquoted = trimmed
        .strip_prefix('\'')
        .and_then(|s| s.strip_suffix('\''))
        .or_else(|| trimmed.strip_prefix('"').and_then(|s| s.strip_suffix('"')))
        .unwrap_or(trimmed);
    // Take last path segment
    let segments: Vec<&str> = unquoted.split('/').filter(|s| !s.is_empty()).collect();
    segments.last().unwrap_or(&unquoted).to_lowercase()
}

fn is_shell_operator(value: &str) -> bool {
    matches!(value, "|" | "||" | "&&" | ";")
}

fn is_option_token(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.starts_with('-') && trimmed != "-"
}

fn find_xargs_invoked_command(tokens: &[ShellTokenSpan], start_index: usize) -> String {
    for idx in start_index..tokens.len() {
        let value = &tokens[idx].value;
        if value.is_empty() || is_shell_operator(value) {
            return String::new();
        }
        if is_option_token(value) {
            continue;
        }
        return normalize_command_name(value);
    }
    String::new()
}

/// Check whether a command string contains a broad-kill command (pkill/killall/taskkill/kill $()).
/// Mirrors TS `containsBroadKillCommand`.
pub fn contains_broad_kill_command(cmd: &str) -> bool {
    let text = cmd.trim();
    if text.is_empty() {
        return false;
    }
    let unwrapped = unwrap_shell_wrapper_command(text);
    let tokens = tokenize_shell_words(&unwrapped);

    for idx in 0..tokens.len() {
        if !is_command_position(&tokens, idx) {
            continue;
        }
        let command_name = normalize_command_name(&tokens[idx].value);
        if command_name.is_empty() {
            continue;
        }
        if BROAD_KILL_COMMANDS.contains(&command_name.as_str()) {
            return true;
        }
        if command_name == "kill" {
            let tail = &unwrapped[tokens[idx]._end..].trim_start();
            if tail.starts_with("$(") {
                return true;
            }
            continue;
        }
        if command_name == "xargs" {
            let xargs_cmd = find_xargs_invoked_command(&tokens, idx + 1);
            if !xargs_cmd.is_empty() && BROAD_KILL_COMMANDS.contains(&xargs_cmd.as_str()) {
                return true;
            }
            if xargs_cmd == "kill" {
                return true;
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Tool validation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing_fields: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normalized_args: Option<String>,
}

fn build_validation_failure(reason: &str, message: &str, missing_fields: Option<Vec<String>>) -> ValidationResult {
    ValidationResult {
        ok: false,
        reason: Some(reason.to_string()),
        message: Some(message.to_string()),
        missing_fields,
        normalized_args: None,
    }
}

/// Validate a canonical client tool call.
/// Mirrors TS `validateCanonicalClientToolCall`.
pub fn validate_canonical_client_tool_call(name: &str, args_string: &str) -> ValidationResult {
    let parsed = parse_tool_args_record(args_string);
    let normalized_name = name.trim().to_lowercase();

    match normalized_name.as_str() {
        "exec_command" => {
            let has_cmd = parsed
                .as_ref()
                .and_then(|m| m.get("cmd"))
                .and_then(|v| v.as_str())
                .is_some();
            if !has_cmd {
                return build_validation_failure(
                    "missing_cmd",
                    "exec_command requires input.cmd as a string.",
                    Some(vec!["cmd".to_string()]),
                );
            }
            let cmd = parsed
                .as_ref()
                .unwrap()
                .get("cmd")
                .unwrap()
                .as_str()
                .unwrap()
                .to_string();
            let mut normalized = parsed.unwrap();
            normalized.insert("cmd".to_string(), Value::String(cmd));
            ValidationResult {
                ok: true,
                reason: None,
                message: None,
                missing_fields: None,
                normalized_args: Some(serde_json::to_string(&normalized).unwrap_or_default()),
            }
        }
        "view_image" => {
            let has_path = parsed
                .as_ref()
                .and_then(|m| m.get("path"))
                .and_then(|v| v.as_str())
                .is_some();
            if !has_path {
                return build_validation_failure(
                    "missing_path",
                    "view_image requires input.path as a string.",
                    Some(vec!["path".to_string()]),
                );
            }
            let path = parsed.as_ref().unwrap().get("path").unwrap().as_str().unwrap();
            let mut normalized = serde_json::Map::new();
            normalized.insert("path".to_string(), Value::String(path.to_string()));
            ValidationResult {
                ok: true,
                reason: None,
                message: None,
                missing_fields: None,
                normalized_args: Some(serde_json::to_string(&normalized).unwrap_or_default()),
            }
        }
        "apply_patch" => {
            let map = match parsed {
                Some(m) => m,
                None => {
                    return build_validation_failure(
                        "missing_patch",
                        "apply_patch requires patch as a string.",
                        Some(vec!["patch".to_string()]),
                    );
                }
            };
            let patch = map
                .get("patch")
                .and_then(|v| v.as_str())
                .or_else(|| map.get("input").and_then(|v| v.as_str()));
            match patch {
                Some(p) => {
                    let mut normalized = map.clone();
                    normalized.insert("patch".to_string(), Value::String(p.to_string()));
                    normalized.remove("input");
                    ValidationResult {
                        ok: true,
                        reason: None,
                        message: None,
                        missing_fields: None,
                        normalized_args: Some(serde_json::to_string(&normalized).unwrap_or_default()),
                    }
                }
                None => build_validation_failure(
                    "missing_patch",
                    "apply_patch requires patch as a string.",
                    Some(vec!["patch".to_string()]),
                ),
            }
        }
        "update_plan" => {
            let is_array = parsed
                .as_ref()
                .and_then(|m| m.get("plan"))
                .map(|v| v.is_array())
                .unwrap_or(false);
            if !is_array {
                return build_validation_failure(
                    "missing_plan",
                    "update_plan requires input.plan as an array.",
                    Some(vec!["plan".to_string()]),
                );
            }
            let map = parsed.unwrap();
            let explanation = map.get("explanation").cloned();
            let plan = map.get("plan").cloned().unwrap_or(Value::Array(vec![]));
            let mut normalized = serde_json::Map::new();
            if let Some(exp) = explanation {
                normalized.insert("explanation".to_string(), exp);
            }
            normalized.insert("plan".to_string(), plan);
            ValidationResult {
                ok: true,
                reason: None,
                message: None,
                missing_fields: None,
                normalized_args: Some(serde_json::to_string(&normalized).unwrap_or_default()),
            }
        }
        "shell_command" | "bash" => {
            let has_command = parsed
                .as_ref()
                .and_then(|m| m.get("command"))
                .and_then(|v| v.as_str())
                .is_some();
            if !has_command {
                return build_validation_failure(
                    "missing_command",
                    &format!("{} requires input.command as a string.", normalized_name),
                    Some(vec!["command".to_string()]),
                );
            }
            ValidationResult {
                ok: true,
                reason: None,
                message: None,
                missing_fields: None,
                normalized_args: parsed
                    .map(|m| serde_json::to_string(&m).unwrap_or_default()),
            }
        }
        "shell" => {
            let is_valid = parsed
                .as_ref()
                .and_then(|m| m.get("command"))
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().all(|e| e.is_string()))
                .unwrap_or(false);
            if !is_valid {
                return build_validation_failure(
                    "invalid_command",
                    "shell requires input.command as a string array.",
                    None,
                );
            }
            ValidationResult {
                ok: true,
                reason: None,
                message: None,
                missing_fields: None,
                normalized_args: parsed
                    .map(|m| serde_json::to_string(&m).unwrap_or_default()),
            }
        }
        "read_mcp_resource" => {
            let has_server = parsed
                .as_ref()
                .and_then(|m| m.get("server"))
                .and_then(|v| v.as_str())
                .is_some();
            let has_uri = parsed
                .as_ref()
                .and_then(|m| m.get("uri"))
                .and_then(|v| v.as_str())
                .is_some();
            if !has_server || !has_uri {
                return build_validation_failure(
                    "missing_server_or_uri",
                    "read_mcp_resource requires input.server and input.uri as strings.",
                    build_missing_fields(&[
                        if !has_server { Some("server".to_string()) } else { None },
                        if !has_uri { Some("uri".to_string()) } else { None },
                    ]),
                );
            }
            let server = parsed.as_ref().unwrap().get("server").unwrap().as_str().unwrap();
            let uri = parsed.as_ref().unwrap().get("uri").unwrap().as_str().unwrap();
            let mut normalized = serde_json::Map::new();
            normalized.insert("server".to_string(), Value::String(server.to_string()));
            normalized.insert("uri".to_string(), Value::String(uri.to_string()));
            ValidationResult {
                ok: true,
                reason: None,
                message: None,
                missing_fields: None,
                normalized_args: Some(serde_json::to_string(&normalized).unwrap_or_default()),
            }
        }
        _ => {
            if parsed.is_none() {
                return build_validation_failure(
                    "invalid_tool_arguments",
                    &format!("Tool \"{}\" requires JSON object arguments.", name.trim()),
                    None,
                );
            }
            ValidationResult {
                ok: true,
                reason: None,
                message: None,
                missing_fields: None,
                normalized_args: parsed
                    .map(|m| serde_json::to_string(&m).unwrap_or_default()),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// NAPI JSON-boundary entry points
// ---------------------------------------------------------------------------

pub fn validate_canonical_client_tool_call_json(input_json: String) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        name: String,
        args_string: String,
    }
    let input: Input = serde_json::from_str(&input_json)
        .map_err(|e| format!("parse input: {}", e))?;
    let result = validate_canonical_client_tool_call(&input.name, &input.args_string);
    serde_json::to_string(&result)
        .map_err(|e| format!("serialize: {}", e))
}

pub fn contains_broad_kill_command_json(input_json: String) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    struct Input {
        cmd: String,
    }
    let input: Input = serde_json::from_str(&input_json)
        .map_err(|e| format!("parse input: {}", e))?;
    let result = contains_broad_kill_command(&input.cmd);
    serde_json::to_string(&serde_json::json!({ "result": result }))
        .map_err(|e| format!("serialize: {}", e))
}

pub fn has_invalid_shell_wrapper_shape_json(input_json: String) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    struct Input {
        cmd: String,
    }
    let input: Input = serde_json::from_str(&input_json)
        .map_err(|e| format!("parse input: {}", e))?;
    let result = has_invalid_shell_wrapper_shape(&input.cmd);
    serde_json::to_string(&serde_json::json!({ "result": result }))
        .map_err(|e| format!("serialize: {}", e))
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- is_image_path_like --

    #[test]
    fn image_path_like_true_for_non_empty() {
        assert!(is_image_path_like("some/path"));
    }

    // -- has_invalid_shell_wrapper_shape --

    #[test]
    fn invalid_shell_wrapper_unclosed_quote() {
        assert!(has_invalid_shell_wrapper_shape("bash -lc 'echo hello"));
    }

    #[test]
    fn valid_shell_wrapper_closed() {
        assert!(!has_invalid_shell_wrapper_shape("bash -lc 'echo hello'"));
    }

    // -- parse_tool_args_record --

    #[test]
    fn parse_args_valid() {
        let result = parse_tool_args_record(r#"{"cmd":"ls"}"#);
        assert!(result.is_some());
    }

    #[test]
    fn parse_args_not_json() {
        assert!(parse_tool_args_record("not json").is_none());
    }

    #[test]
    fn parse_args_empty() {
        assert!(parse_tool_args_record("").is_none());
    }

    // -- build_missing_fields --

    #[test]
    fn missing_fields_some() {
        let result = build_missing_fields(&[Some("cmd".to_string()), None, Some("path".to_string())]);
        assert_eq!(result, Some(vec!["cmd".to_string(), "path".to_string()]));
    }

    #[test]
    fn missing_fields_none() {
        let result = build_missing_fields(&[None, None]);
        assert_eq!(result, None);
    }

    // -- containsBroadKillCommand --

    #[test]
    fn broad_kill_pkill_detected() {
        assert!(contains_broad_kill_command("pkill firefox"));
    }

    #[test]
    fn broad_kill_killall_detected() {
        assert!(contains_broad_kill_command("killall node"));
    }

    #[test]
    fn broad_kill_taskkill_detected() {
        assert!(contains_broad_kill_command("taskkill /f /im node.exe"));
    }

    #[test]
    fn broad_kill_kill_with_substitution() {
        assert!(contains_broad_kill_command("kill $(pidof foo)"));
    }

    #[test]
    fn broad_kill_xargs_with_kill() {
        assert!(contains_broad_kill_command("ps aux | xargs kill"));
    }

    #[test]
    fn broad_kill_xargs_with_pkill() {
        assert!(contains_broad_kill_command("something | xargs pkill"));
    }

    #[test]
    fn broad_kill_simple_echo_not_kill() {
        assert!(!contains_broad_kill_command("echo hello"));
    }

    #[test]
    fn broad_kill_kill_without_substitution_not_kill() {
        // `kill -9` without $() is allowed
        assert!(!contains_broad_kill_command("kill -9 1234"));
    }

    #[test]
    fn broad_kill_inside_shell_wrapper() {
        assert!(contains_broad_kill_command("bash -lc 'pkill firefox'"));
    }

    // -- validateCanonicalClientToolCall --

    #[test]
    fn validate_exec_command_ok() {
        let r = validate_canonical_client_tool_call("exec_command", r#"{"cmd":"ls"}"#);
        assert!(r.ok);
        assert!(r.normalized_args.unwrap().contains("ls"));
    }

    #[test]
    fn validate_exec_command_missing_cmd() {
        let r = validate_canonical_client_tool_call("exec_command", r#"{"other":1}"#);
        assert!(!r.ok);
        assert_eq!(r.reason.unwrap(), "missing_cmd");
    }

    #[test]
    fn validate_view_image_ok() {
        let r = validate_canonical_client_tool_call("view_image", r#"{"path":"/tmp/img.png"}"#);
        assert!(r.ok);
    }

    #[test]
    fn validate_view_image_missing_path() {
        let r = validate_canonical_client_tool_call("view_image", r#"{}"#);
        assert!(!r.ok);
        assert_eq!(r.reason.unwrap(), "missing_path");
    }

    #[test]
    fn validate_apply_patch_ok() {
        let r = validate_canonical_client_tool_call("apply_patch", r#"{"patch":"diff"}"#);
        assert!(r.ok);
    }

    #[test]
    fn validate_apply_patch_from_input_field() {
        let r = validate_canonical_client_tool_call("apply_patch", r#"{"input":"diff"}"#);
        assert!(r.ok);
        let na = r.normalized_args.unwrap();
        assert!(na.contains("\"patch\""));
        assert!(!na.contains("\"input\""));
    }

    #[test]
    fn validate_apply_patch_missing() {
        let r = validate_canonical_client_tool_call("apply_patch", r#"{}"#);
        assert!(!r.ok);
    }

    #[test]
    fn validate_update_plan_ok() {
        let r = validate_canonical_client_tool_call("update_plan", r#"{"plan":["step1"]}"#);
        assert!(r.ok);
    }

    #[test]
    fn validate_update_plan_missing() {
        let r = validate_canonical_client_tool_call("update_plan", r#"{}"#);
        assert!(!r.ok);
    }

    #[test]
    fn validate_shell_command_ok() {
        let r = validate_canonical_client_tool_call("shell_command", r#"{"command":"ls"}"#);
        assert!(r.ok);
    }

    #[test]
    fn validate_bash_ok() {
        let r = validate_canonical_client_tool_call("bash", r#"{"command":"ls"}"#);
        assert!(r.ok);
    }

    #[test]
    fn validate_shell_ok() {
        let r = validate_canonical_client_tool_call("shell", r#"{"command":["ls","-la"]}"#);
        assert!(r.ok);
    }

    #[test]
    fn validate_shell_invalid() {
        let r = validate_canonical_client_tool_call("shell", r#"{"command":"ls"}"#);
        assert!(!r.ok);
    }

    #[test]
    fn validate_read_mcp_resource_ok() {
        let r = validate_canonical_client_tool_call("read_mcp_resource", r#"{"server":"gh","uri":"github://issues"}"#);
        assert!(r.ok);
    }

    #[test]
    fn validate_read_mcp_resource_missing() {
        let r = validate_canonical_client_tool_call("read_mcp_resource", r#"{"server":"gh"}"#);
        assert!(!r.ok);
    }

    #[test]
    fn validate_unknown_tool_invalid_args() {
        let r = validate_canonical_client_tool_call("unknown_tool", r#""not an object""#);
        assert!(!r.ok);
    }

    #[test]
    fn validate_unknown_tool_valid_object() {
        let r = validate_canonical_client_tool_call("any_tool", r#"{"arg":"val"}"#);
        assert!(r.ok);
    }
}
