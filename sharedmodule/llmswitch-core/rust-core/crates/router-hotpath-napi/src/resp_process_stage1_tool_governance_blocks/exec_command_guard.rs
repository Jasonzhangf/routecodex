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
];

const GIT_CHECKOUT_SCOPE_MESSAGE: &str =
    "Command blocked: git checkout is allowed only as a standalone single-file restore. Use `git checkout -- <file>` or `git checkout <ref> -- <file>`.";

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

/// Check if a command matches any dangerous pattern.
/// Returns (reason, message) if blocked, None if safe.
pub(crate) fn detect_dangerous_command(cmd: &str) -> Option<(&'static str, &'static str)> {
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
    None
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
