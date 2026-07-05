use regex::Regex;
use serde_json::{Map, Value};

use crate::shared_json_utils::read_workdir_from_args;

pub(crate) fn build_exec_command_object_with_shape(
    cmd: String,
    args: Option<&Map<String, Value>>,
    source_is_shell_alias: bool,
    force_cmd: Option<bool>,
    force_command: Option<bool>,
    args_contain_direct_or_nested_key: impl Fn(&Map<String, Value>, &str) -> bool,
) -> Option<String> {
    let empty = Map::new();
    let args = args.unwrap_or(&empty);
    let mut out = Map::new();
    let has_cmd = force_cmd.unwrap_or_else(|| args_contain_direct_or_nested_key(args, "cmd"));
    let has_command =
        force_command.unwrap_or_else(|| args_contain_direct_or_nested_key(args, "command"));
    let emit_cmd = has_cmd || (!has_command && !source_is_shell_alias);
    let emit_command = has_command || (source_is_shell_alias && !has_cmd);
    if emit_command {
        out.insert("command".to_string(), Value::String(cmd.clone()));
    }
    if emit_cmd {
        out.insert("cmd".to_string(), Value::String(cmd));
    }
    if let Some(workdir) = read_workdir_from_args(args) {
        out.insert("workdir".to_string(), Value::String(workdir));
    }
    serde_json::to_string(&Value::Object(out)).ok()
}

// ============================================================
// Dangerous command blocking — Rust is the single source of truth
// ============================================================

struct DangerousCommandRule {
    pattern: &'static str,
    reason: &'static str,
    message: &'static str,
}

const DANGEROUS_COMMAND_RULES: &[DangerousCommandRule] = &[
    DangerousCommandRule { pattern: r"(?i)\brm\s+-[a-zA-Z]*r[a-zA-Z]*f", reason: "forbidden_dangerous_rm", message: "Command blocked: `rm -rf` is forbidden. Use targeted file deletion or `git clean` with explicit scope." },
    DangerousCommandRule { pattern: r"(?i)\brm\s+-[a-zA-Z]*f[a-zA-Z]*r", reason: "forbidden_dangerous_rm", message: "Command blocked: `rm -fr` is forbidden. Use targeted file deletion or `git clean` with explicit scope." },
    DangerousCommandRule { pattern: r"(?i)\bkillall\b", reason: "forbidden_process_mgmt", message: "Command blocked: `killall` is not allowed. Use targeted PID-based shutdown." },
    DangerousCommandRule { pattern: r"(?i)\bpkill\b", reason: "forbidden_process_mgmt", message: "Command blocked: `pkill` is not allowed. Use targeted PID-based shutdown." },
    DangerousCommandRule { pattern: r"(?i)\bgit\s+clean\s+-[a-zA-Z]*f", reason: "forbidden_git_clean", message: "Command blocked: `git clean -f` is destructive. Manually remove untracked files instead." },
    DangerousCommandRule { pattern: r"(?i)\bgit\s+reset\s+--hard(?:\s|$)", reason: "forbidden_git_reset_hard", message: "Command blocked: `git reset --hard` is destructive. Use `git reset --mixed <ref>` or file-scoped restore commands instead." },
];

const GIT_CHECKOUT_SCOPE_MESSAGE: &str =
    "Command blocked: git checkout is allowed only as a standalone single-file restore. Use `git checkout -- <file>` or `git checkout <ref> -- <file>`.";
const SHELL_WRITE_MESSAGE: &str =
    "Command blocked: shell write redirection and bulk in-place writers are not allowed through tool governance.";
const INVALID_SHELL_WRAPPER_MESSAGE: &str =
    "Malformed shell wrapper: shell -c/-lc requires a balanced closing single quote. Closing-quote or tail-truncated wrappers are not auto-repaired when ambiguous.";

fn shell_single_quote(raw: &str) -> String {
    format!("'{}'", raw.replace('\'', "'\"'\"'"))
}

fn split_shell_tokens(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = command.chars().peekable();
    while let Some(ch) = chars.next() {
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            continue;
        }
        if ch.is_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            continue;
        }
        if ch == ';' {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            tokens.push(";".to_string());
            continue;
        }
        if ch == '|' || ch == '&' {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            if chars.peek().copied() == Some(ch) {
                chars.next();
                tokens.push(format!("{ch}{ch}"));
            } else {
                tokens.push(ch.to_string());
            }
            continue;
        }
        current.push(ch);
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn extract_wrapped_shell_command(command: &str) -> Option<String> {
    let trimmed = command.trim();
    let mat = Regex::new(r"(?is)^(?:bash|sh|zsh)\s+-(?:l?c|c)\s+([\s\S]+)$")
        .ok()?
        .captures(trimmed)?;
    let raw = mat.get(1)?.as_str().trim();
    if raw.is_empty() {
        return Some(String::new());
    }
    let mut chars = raw.chars();
    let first = chars.next()?;
    let last = raw.chars().last()?;
    if matches!((first, last), ('\'', '\'') | ('"', '"') | ('`', '`')) && raw.len() >= 2 {
        return Some(raw[1..raw.len() - 1].to_string());
    }
    Some(raw.to_string())
}

fn repair_zero_ambiguity_shell_wrapper(
    command: &str,
) -> Result<String, (&'static str, &'static str)> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Ok(trimmed.to_string());
    }
    let prefixes = [
        "bash -lc '",
        "bash -c '",
        "sh -lc '",
        "sh -c '",
        "zsh -lc '",
        "zsh -c '",
    ];
    for prefix in prefixes {
        if !trimmed.starts_with(prefix) || trimmed.ends_with('\'') {
            continue;
        }
        let body = &trimmed[prefix.len()..];
        if body.contains('\'') {
            return Err(("invalid_shell_wrapper_shape", INVALID_SHELL_WRAPPER_MESSAGE));
        }
        return Ok(format!("{trimmed}'"));
    }
    Ok(trimmed.to_string())
}

fn detect_git_checkout_scope_violation(cmd: &str) -> bool {
    let Some(mat) = Regex::new(r"(?i)\bgit\s+checkout\b")
        .ok()
        .and_then(|re| re.find(cmd))
    else {
        return false;
    };
    let tokens = split_shell_tokens(&cmd[mat.start()..]);
    if tokens.len() < 3
        || tokens.first().map(|v| v.to_ascii_lowercase()) != Some("git".to_string())
        || tokens.get(1).map(|v| v.to_ascii_lowercase()) != Some("checkout".to_string())
    {
        return true;
    }
    if tokens
        .iter()
        .enumerate()
        .any(|(idx, token)| idx >= 2 && matches!(token.as_str(), ";" | "&&" | "||" | "|" | "&"))
    {
        return true;
    }
    let Some(dash_dash_idx) = tokens.iter().position(|token| token == "--") else {
        return true;
    };
    if dash_dash_idx < 2 {
        return true;
    }
    let before = &tokens[2..dash_dash_idx];
    if before.len() > 1 || before.iter().any(|token| token.starts_with('-')) {
        return true;
    }
    let paths = &tokens[dash_dash_idx + 1..];
    if paths.len() != 1 {
        return true;
    }
    let path = paths[0].trim();
    path.is_empty() || matches!(path, "." | "/" | "*") || path.ends_with('/')
}

fn detect_shell_write_violation(cmd: &str) -> bool {
    let normalized = cmd.to_ascii_lowercase();
    if normalized.trim().is_empty() {
        return false;
    }
    has_persistent_redirect(normalized.as_str())
        || Regex::new(r"\bsed\b[^\n]*-i\b")
            .map(|re| re.is_match(normalized.as_str()))
            .unwrap_or(false)
        || Regex::new(r"\bed\b[^\n]*-s\b")
            .map(|re| re.is_match(normalized.as_str()))
            .unwrap_or(false)
        || Regex::new(r"\btee\b\s+")
            .map(|re| re.is_match(normalized.as_str()))
            .unwrap_or(false)
}

fn has_persistent_redirect(command: &str) -> bool {
    let bytes = command.as_bytes();
    let mut idx = 0usize;
    let mut quote: Option<u8> = None;
    let mut escaped = false;
    while idx < bytes.len() {
        let ch = bytes[idx];
        if escaped {
            escaped = false;
            idx += 1;
            continue;
        }
        if ch == b'\\' {
            escaped = true;
            idx += 1;
            continue;
        }
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            }
            idx += 1;
            continue;
        }
        if ch == b'\'' || ch == b'"' || ch == b'`' {
            quote = Some(ch);
            idx += 1;
            continue;
        }
        if bytes[idx] != b'>' {
            idx += 1;
            continue;
        }
        if idx > 0 && bytes[idx - 1] == b'=' {
            idx += 1;
            continue;
        }
        let mut fd_start = idx;
        while fd_start > 0 && bytes[fd_start - 1].is_ascii_digit() {
            fd_start -= 1;
        }
        let mut target_start = idx + 1;
        if target_start < bytes.len() && bytes[target_start] == b'>' {
            target_start += 1;
        }
        while target_start < bytes.len() && bytes[target_start].is_ascii_whitespace() {
            target_start += 1;
        }
        let mut target_end = target_start;
        while target_end < bytes.len() && !bytes[target_end].is_ascii_whitespace() {
            target_end += 1;
        }
        let target = &command[target_start..target_end];
        let fd_prefix = &command[fd_start..idx];
        if target.starts_with("/dev/null") || (fd_prefix.len() == 1 && target.starts_with('&')) {
            idx = target_end.max(idx + 1);
            continue;
        }
        return true;
    }
    false
}

fn detect_dangerous_command_candidate(cmd: &str) -> Option<(&'static str, &'static str)> {
    for rule in DANGEROUS_COMMAND_RULES {
        if let Ok(re) = Regex::new(rule.pattern) {
            if re.is_match(cmd) {
                return Some((rule.reason, rule.message));
            }
        }
    }
    if detect_git_checkout_scope_violation(cmd) {
        return Some(("forbidden_git_checkout_scope", GIT_CHECKOUT_SCOPE_MESSAGE));
    }
    if detect_shell_write_violation(cmd) {
        return Some(("forbidden_shell_write", SHELL_WRITE_MESSAGE));
    }
    None
}

fn build_policy_regex(pattern: &str, flags: &str) -> Option<Regex> {
    let mut opts = String::new();
    let flags = if flags.trim().is_empty() {
        "i"
    } else {
        flags.trim()
    };
    for ch in flags.chars() {
        match ch {
            'i' if !opts.contains('i') => opts.push('i'),
            'm' if !opts.contains('m') => opts.push('m'),
            's' if !opts.contains('s') => opts.push('s'),
            'g' | 'u' | 'v' | 'y' | 'd' => {}
            _ => return None,
        }
    }
    let source = if opts.is_empty() {
        pattern.to_string()
    } else {
        format!("(?{opts}){pattern}")
    };
    Regex::new(source.as_str()).ok()
}

fn detect_policy_rule_violation<'a>(
    cmd: &str,
    policy_json: Option<&'a str>,
) -> Option<(String, String)> {
    let raw = policy_json?.trim();
    if raw.is_empty() {
        return None;
    }
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let rules = parsed
        .as_object()
        .and_then(|obj| obj.get("rules"))
        .and_then(Value::as_array)?;
    for (idx, item) in rules.iter().enumerate() {
        let Some(row) = item.as_object() else {
            continue;
        };
        let type_name = row
            .get("type")
            .and_then(Value::as_str)
            .map(|value| value.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if type_name != "regex" {
            continue;
        }
        let Some(pattern) = row.get("pattern").and_then(Value::as_str) else {
            continue;
        };
        if pattern.trim().is_empty() {
            continue;
        }
        let flags = row.get("flags").and_then(Value::as_str).unwrap_or("");
        let Some(regex) = build_policy_regex(pattern, flags) else {
            continue;
        };
        if !regex.is_match(cmd) {
            continue;
        }
        let id = row
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("rule_{}", idx + 1));
        let reason = row
            .get("reason")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("policy rule \"{id}\" blocked this command"));
        return Some(("forbidden_exec_command_policy".to_string(), reason));
    }
    None
}

/// Check if a command matches any dangerous pattern.
/// Returns (reason, message) if blocked, None if safe.
pub(crate) fn detect_dangerous_command(cmd: &str) -> Option<(&'static str, &'static str)> {
    if let Some(result) = detect_dangerous_command_candidate(cmd) {
        return Some(result);
    }
    if let Some(wrapped) = extract_wrapped_shell_command(cmd) {
        if let Some(result) = detect_dangerous_command_candidate(wrapped.as_str()) {
            return Some(result);
        }
    }
    None
}

pub(crate) fn validate_exec_command_guard_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json).map_err(|e| e.to_string())?;
    let raw_cmd = input
        .as_object()
        .and_then(|obj| obj.get("cmd").or_else(|| obj.get("command")))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let policy_json = input
        .as_object()
        .and_then(|obj| obj.get("policyJson"))
        .and_then(Value::as_str);
    let mut out = Map::new();
    let cmd = match repair_zero_ambiguity_shell_wrapper(raw_cmd) {
        Ok(value) => value,
        Err((reason, message)) => {
            out.insert("ok".to_string(), Value::Bool(false));
            out.insert("reason".to_string(), Value::String(reason.to_string()));
            out.insert("message".to_string(), Value::String(message.to_string()));
            return serde_json::to_string(&Value::Object(out)).map_err(|e| e.to_string());
        }
    };
    if let Some((reason, message)) = detect_policy_rule_violation(cmd.as_str(), policy_json)
        .or_else(|| {
            extract_wrapped_shell_command(cmd.as_str())
                .and_then(|wrapped| detect_policy_rule_violation(wrapped.as_str(), policy_json))
        })
    {
        out.insert("ok".to_string(), Value::Bool(false));
        out.insert("reason".to_string(), Value::String(reason));
        out.insert("message".to_string(), Value::String(message));
    } else if let Some((reason, message)) = detect_dangerous_command(cmd.as_str()) {
        out.insert("ok".to_string(), Value::Bool(false));
        out.insert("reason".to_string(), Value::String(reason.to_string()));
        out.insert("message".to_string(), Value::String(message.to_string()));
    } else {
        out.insert("ok".to_string(), Value::Bool(true));
        if cmd != raw_cmd {
            out.insert("normalizedCmd".to_string(), Value::String(cmd));
        }
    }
    serde_json::to_string(&Value::Object(out)).map_err(|e| e.to_string())
}

/// Build a blocked exec_command JSON object that replaces the dangerous command
/// with a shell script that prints the error and exits.
pub(crate) fn build_dangerous_command_blocked_object(
    reason: &str,
    message: &str,
    args: Option<&Map<String, Value>>,
    source_is_shell_alias: bool,
    args_contain_direct_or_nested_key: impl Fn(&Map<String, Value>, &str) -> bool,
) -> Option<String> {
    let safe_reason: String = reason
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let safe_message: String = message.replace('\\', "\\\\").chars().take(240).collect();
    let detail = format!(
        "blocked by exec_command guard ({}): {}",
        safe_reason, safe_message
    );
    let inner = format!("printf '%s\\n' {} >&2; exit 2", shell_single_quote(&detail));
    let script = format!("bash -lc {}", shell_single_quote(&inner));
    build_exec_command_object_with_shape(
        script,
        args,
        source_is_shell_alias,
        None,
        None,
        args_contain_direct_or_nested_key,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rm_rf_is_blocked() {
        assert!(detect_dangerous_command("rm -rf /tmp/test").is_some());
    }

    #[test]
    fn rm_fr_is_blocked() {
        assert!(detect_dangerous_command("rm -fr /tmp/test").is_some());
    }

    #[test]
    fn killall_is_blocked() {
        assert!(detect_dangerous_command("killall node").is_some());
    }

    #[test]
    fn pkill_is_blocked() {
        assert!(detect_dangerous_command("pkill -f myapp").is_some());
    }

    #[test]
    fn git_clean_f_is_blocked() {
        assert!(detect_dangerous_command("git clean -fd").is_some());
    }

    #[test]
    fn git_clean_fdx_is_blocked() {
        assert!(detect_dangerous_command("git clean -fdx").is_some());
    }

    #[test]
    fn git_reset_hard_is_blocked() {
        let result = detect_dangerous_command("git reset --hard HEAD").unwrap();
        assert_eq!(result.0, "forbidden_git_reset_hard");
    }

    #[test]
    fn git_reset_mixed_is_allowed() {
        assert!(detect_dangerous_command("git reset --mixed HEAD~1").is_none());
    }

    #[test]
    fn git_checkout_single_file_is_allowed() {
        assert!(detect_dangerous_command("git checkout -- src/index.ts").is_none());
        assert!(detect_dangerous_command("git checkout HEAD -- src/index.ts").is_none());
    }

    #[test]
    fn git_checkout_directory_or_multi_file_is_blocked() {
        assert!(detect_dangerous_command("git checkout -- src/").is_some());
        assert!(detect_dangerous_command("git checkout -- src/a.ts src/b.ts").is_some());
        assert!(detect_dangerous_command("git checkout feature/new-flow").is_some());
        assert!(detect_dangerous_command("git checkout -- src/a.ts && git status").is_some());
    }

    #[test]
    fn ls_is_not_blocked() {
        assert!(detect_dangerous_command("ls -la").is_none());
    }

    #[test]
    fn cat_is_not_blocked() {
        assert!(detect_dangerous_command("cat README.md").is_none());
    }

    #[test]
    fn rg_is_not_blocked() {
        assert!(detect_dangerous_command("rg TODO src/").is_none());
    }

    #[test]
    fn shell_writes_are_blocked() {
        assert_eq!(
            detect_dangerous_command("printf hello > src/out.txt")
                .unwrap()
                .0,
            "forbidden_shell_write"
        );
        assert_eq!(
            detect_dangerous_command("sed -i '' 's/a/b/' src/a.ts")
                .unwrap()
                .0,
            "forbidden_shell_write"
        );
        assert_eq!(
            detect_dangerous_command("cat <<EOF > file\nx\nEOF")
                .unwrap()
                .0,
            "forbidden_shell_write"
        );
        assert_eq!(
            detect_dangerous_command("echo ok | tee file").unwrap().0,
            "forbidden_shell_write"
        );
    }

    #[test]
    fn non_persistent_redirects_and_quoted_operators_are_allowed() {
        assert!(detect_dangerous_command("tail -50 app.log 2>/dev/null || echo none").is_none());
        assert!(detect_dangerous_command("cargo test >/dev/null").is_none());
        assert!(detect_dangerous_command("node script.js 2>&1").is_none());
        assert!(
            detect_dangerous_command("python3 << 'PYEOF'\nprint('read only')\nPYEOF").is_none()
        );
        assert!(
            detect_dangerous_command("node -e \"const x = value => value + (1 << 4);\"").is_none()
        );
    }

    #[test]
    fn wrapped_shell_command_is_checked() {
        assert_eq!(
            detect_dangerous_command("bash -lc 'git reset --hard HEAD'")
                .unwrap()
                .0,
            "forbidden_git_reset_hard"
        );
        assert!(detect_dangerous_command("bash -lc 'git reset --mixed HEAD'").is_none());
    }

    #[test]
    fn shell_wrapper_shape_is_repaired_or_blocked() {
        let repaired = validate_exec_command_guard_json(
            r#"{"cmd":"bash -lc 'tail -50 app.log 2>/dev/null || echo none"}"#,
        )
        .unwrap();
        let repaired_value: Value = serde_json::from_str(repaired.as_str()).unwrap();
        assert_eq!(repaired_value["ok"], true);
        assert_eq!(
            repaired_value["normalizedCmd"],
            "bash -lc 'tail -50 app.log 2>/dev/null || echo none'"
        );

        let blocked =
            validate_exec_command_guard_json(r#"{"cmd":"bash -lc 'echo 'ambiguous"}"#).unwrap();
        let blocked_value: Value = serde_json::from_str(blocked.as_str()).unwrap();
        assert_eq!(blocked_value["ok"], false);
        assert_eq!(blocked_value["reason"], "invalid_shell_wrapper_shape");
    }

    #[test]
    fn policy_json_regex_rules_are_native_owned() {
        let input = serde_json::json!({
            "cmd": "lsof -ti :7701 | xargs kill -9",
            "policyJson": serde_json::json!({
                "version": 1,
                "rules": [{
                    "id": "deny-mass-kill",
                    "type": "regex",
                    "pattern": "\\bxargs\\b[^\\n]*\\bkill\\b",
                    "flags": "i",
                    "reason": "mass kill command is not allowed"
                }]
            }).to_string()
        });
        let result = validate_exec_command_guard_json(input.to_string().as_str()).unwrap();
        let value: Value = serde_json::from_str(result.as_str()).unwrap();
        assert_eq!(value["ok"], false);
        assert_eq!(value["reason"], "forbidden_exec_command_policy");
        assert_eq!(value["message"], "mass kill command is not allowed");
    }

    #[test]
    fn admin_and_remote_tools_are_allowed() {
        assert!(detect_dangerous_command("sudo launchctl list").is_none());
        assert!(detect_dangerous_command("ssh host.example.com uptime").is_none());
        assert!(detect_dangerous_command("scp a host:/tmp/a").is_none());
        assert!(detect_dangerous_command("rsync -av src/ dst/").is_none());
    }

    #[test]
    fn cargo_test_is_not_blocked() {
        assert!(detect_dangerous_command("cargo test").is_none());
    }

    #[test]
    fn blocked_object_contains_reason() {
        let obj = build_dangerous_command_blocked_object(
            "forbidden_dangerous_rm",
            "rm -rf is forbidden",
            None,
            false,
            |_, _| false,
        )
        .unwrap();
        assert!(obj.contains("blocked by exec_command guard"));
        assert!(obj.contains("forbidden_dangerous_rm"));
    }

    #[test]
    fn blocked_object_quotes_backticks_as_data() {
        let obj = build_dangerous_command_blocked_object(
            "forbidden_git_checkout_scope",
            "Use `git checkout -- <file>` only",
            None,
            false,
            |_, _| false,
        )
        .unwrap();
        assert!(obj.contains("bash -lc 'printf"));
        assert!(!obj.contains("bash -lc \"printf"));
        assert!(obj.contains("`git checkout -- <file>`"));
    }
}
