use crate::tools::{
    SHELL_REDIRECT_WRITE_BINARIES, SHELL_SEARCH_COMMANDS, SHELL_THINKING_COMMANDS,
    SHELL_TOOLS_COMMANDS, SHELL_WRAPPER_COMMANDS, SHELL_WRITE_COMMANDS,
};

pub(crate) fn classify_shell_command(command: &str) -> String {
    let normalized = strip_shell_wrapper(command).to_lowercase();
    if normalized.trim().is_empty() {
        return "other".to_string();
    }
    if normalized.contains("<<") && shell_heredoc_looks_like_write(&normalized) {
        return "coding".to_string();
    }
    if SHELL_WRITE_COMMANDS
        .iter()
        .any(|cmd| contains_command(&normalized, cmd))
    {
        return "coding".to_string();
    }
    if shell_sed_looks_like_write(&normalized) || shell_awk_looks_like_write(&normalized) {
        return "coding".to_string();
    }
    if contains_command(&normalized, "perl") && normalized.contains("-pi") {
        return "coding".to_string();
    }
    if contains_command(&normalized, "replace") {
        return "coding".to_string();
    }
    if SHELL_REDIRECT_WRITE_BINARIES
        .iter()
        .any(|cmd| contains_command(&normalized, cmd))
        && has_output_redirect(&normalized)
    {
        return "coding".to_string();
    }
    if SHELL_SEARCH_COMMANDS
        .iter()
        .any(|cmd| contains_command(&normalized, cmd))
    {
        return "search".to_string();
    }
    if contains_command(&normalized, "git") {
        if [
            "status",
            "branch",
            "ls-files",
            "rev-parse",
            "log",
            "grep",
            "blame",
            "shortlog",
            "reflog",
            "diff --stat",
        ]
        .iter()
        .any(|subcommand| normalized.contains(subcommand))
        {
            return "search".to_string();
        }
        if normalized.contains("diff") || normalized.contains("show") {
            return "thinking".to_string();
        }
        return "other".to_string();
    }
    if contains_command(&normalized, "bd") {
        if normalized.contains(" search")
            || normalized.contains(" list")
            || normalized.contains(" show")
        {
            return "search".to_string();
        }
        return "coding".to_string();
    }
    if contains_command(&normalized, "sed") || contains_command(&normalized, "awk") {
        return "thinking".to_string();
    }
    if shell_script_looks_like_read(&normalized) {
        return "thinking".to_string();
    }
    if SHELL_THINKING_COMMANDS
        .iter()
        .any(|cmd| contains_command(&normalized, cmd))
    {
        return "thinking".to_string();
    }
    if contains_command(&normalized, "update_plan") {
        return "thinking".to_string();
    }
    if SHELL_TOOLS_COMMANDS
        .iter()
        .any(|cmd| contains_command(&normalized, cmd))
        && [
            "test", "lint", "check", "build", "compile", "install", "run",
        ]
        .iter()
        .any(|operation| normalized.contains(operation))
    {
        return "other".to_string();
    }
    "other".to_string()
}

fn strip_shell_wrapper(command: &str) -> String {
    let trimmed = command.trim();
    for wrapper in ["bash -lc", "sh -c", "zsh -c"] {
        if let Some(rest) = trimmed.strip_prefix(wrapper) {
            return rest.trim().trim_matches('\'').trim_matches('"').to_string();
        }
    }
    let mut cleaned = Vec::new();
    for token in trimmed.split_whitespace() {
        if cleaned.is_empty() {
            if token.contains('=') && !token.starts_with("./") && !token.starts_with('/') {
                continue;
            }
            if SHELL_WRAPPER_COMMANDS.contains(&token) {
                continue;
            }
        }
        cleaned.push(token.to_string());
    }
    cleaned.join(" ")
}

fn contains_command(command: &str, target: &str) -> bool {
    command
        .split(|ch: char| {
            ch.is_whitespace() || ch == '|' || ch == ';' || ch == '&' || ch == '\n' || ch == '\r'
        })
        .filter(|token| !token.is_empty())
        .map(normalize_binary_name)
        .any(|token| token == target)
}

fn normalize_binary_name(binary: &str) -> String {
    let lowered = binary.to_lowercase();
    let token = lowered.rsplit('/').next().unwrap_or(&lowered);
    match token {
        "python3" => "python".to_string(),
        "pip3" => "pip".to_string(),
        "ripgrep" => "rg".to_string(),
        "perl5" => "perl".to_string(),
        other => other.to_string(),
    }
}

fn has_output_redirect(command: &str) -> bool {
    let bytes = command.as_bytes();
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    for index in 0..bytes.len() {
        let ch = bytes[index] as char;
        if in_single {
            if ch == '\'' {
                in_single = false;
            }
            continue;
        }
        if in_double {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                continue;
            }
            if ch == '"' {
                in_double = false;
            }
            continue;
        }
        if ch == '\'' {
            in_single = true;
            continue;
        }
        if ch == '"' {
            in_double = true;
            continue;
        }
        if ch != '>' {
            continue;
        }
        if index > 0 && bytes[index - 1] == b'=' {
            continue;
        }
        if index + 1 < bytes.len() && bytes[index + 1] == b'=' {
            continue;
        }
        if index > 0 && bytes[index - 1] == b'2' {
            continue;
        }
        return true;
    }
    false
}

fn shell_heredoc_looks_like_write(command: &str) -> bool {
    if !command.contains("<<") {
        return false;
    }
    if contains_command(command, "apply_patch") {
        return true;
    }
    if SHELL_REDIRECT_WRITE_BINARIES
        .iter()
        .any(|cmd| contains_command(command, cmd))
        && has_output_redirect(command)
    {
        return true;
    }
    command.contains("write_text(")
        || command.contains(".write_text(")
        || command.contains(".write(")
        || command.contains("fs.writefile")
        || command.contains("appendfile")
        || command.contains("open(") && command.contains("'w'")
        || command.contains("open(") && command.contains("\"w\"")
}

fn shell_sed_looks_like_write(command: &str) -> bool {
    contains_command(command, "sed")
        && (command.contains(" -i")
            || command.starts_with("sed -i")
            || has_output_redirect(command)
            || command.contains(" w "))
}

fn shell_awk_looks_like_write(command: &str) -> bool {
    contains_command(command, "awk")
        && (has_output_redirect(command)
            || command.contains(" -i inplace")
            || command.contains("-vinplace")
            || command.contains("print >")
            || command.contains("printf >"))
}

fn shell_script_looks_like_read(command: &str) -> bool {
    if contains_command(command, "python") {
        return command.contains("print(open(")
            || command.contains(".read_text(")
            || command.contains(".read_bytes(")
            || command.contains(".read()")
            || command.contains("path.read_text(")
            || command.contains("path.read_bytes(");
    }
    if contains_command(command, "node") {
        return command.contains("fs.readfilesync(")
            || command.contains("readfilesync(")
            || command.contains("console.log(")
            || command.contains("process.stdout.write(");
    }
    if contains_command(command, "perl")
        || contains_command(command, "ruby")
        || contains_command(command, "php")
    {
        return command.contains("readfile(")
            || command.contains("fileread(")
            || command.contains("puts file.read")
            || command.contains("print file.read")
            || command.contains("slurp");
    }
    false
}
