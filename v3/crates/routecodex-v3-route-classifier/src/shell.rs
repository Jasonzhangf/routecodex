use crate::tools::{
    SHELL_SEARCH_COMMANDS, SHELL_THINKING_COMMANDS, SHELL_WRAPPER_COMMANDS, SHELL_WRITE_COMMANDS,
};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum ShellOperation {
    Setup,
    Search,
    Read,
    Write,
}

pub(crate) fn classify_shell_command(command: &str) -> String {
    let command = unwrap_shell_command(command);
    let Some(segments) = shell_command_segments(command) else {
        return "other".to_string();
    };
    match segments
        .into_iter()
        .filter_map(classify_shell_segment)
        .max()
    {
        Some(ShellOperation::Read) => "thinking",
        Some(ShellOperation::Write) => "coding",
        Some(ShellOperation::Search) => "search",
        Some(ShellOperation::Setup) | None => "other",
    }
    .to_string()
}

fn classify_shell_segment(segment: &str) -> Option<ShellOperation> {
    use ShellOperation::{Read, Search, Setup, Write};
    let (binary, args) = command_invocation(segment)?;
    let args = args.as_slice();
    if matches!(binary.as_str(), "[" | "[[" | "test") {
        return None;
    }
    if has_file_redirect(segment)? {
        return Some(Write);
    }
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "--version"))
    {
        return None;
    }
    match binary.as_str() {
        "cd" | ":" => Some(Setup),
        "git" => match args.first()?.as_str() {
            "status" | "log" | "ls-files" | "rev-parse" | "grep" | "blame" | "shortlog"
            | "reflog" => Some(Search),
            "diff" if args.iter().any(|arg| arg == "--stat") => Some(Search),
            "diff" | "show"
                if !args.iter().any(|arg| {
                    matches!(arg.as_str(), "--ext-diff" | "--textconv")
                        || arg.starts_with("--output")
                }) =>
            {
                Some(Read)
            }
            _ => None,
        },
        "bd" => match args.first()?.as_str() {
            "search" | "list" | "show" => Some(Search),
            "create" | "update" | "close" | "reopen" => Some(Write),
            _ => None,
        },
        "sed" => classify_sed(args),
        "diff" | "cmp" | "comm" | "wc" | "cut" | "tr" | "jq" => Some(Read),
        "cat" if args.iter().any(|arg| arg.starts_with("<<")) => Some(Setup),
        "cat" | "head" | "tail" if !has_input_file_operand(args) => Some(Setup),
        "find"
            if args.iter().any(|arg| {
                matches!(
                    arg.as_str(),
                    "-delete"
                        | "-exec"
                        | "-execdir"
                        | "-ok"
                        | "-okdir"
                        | "-fprint"
                        | "-fprint0"
                        | "-fprintf"
                        | "-fls"
                )
            }) =>
        {
            None
        }
        "rg" if args
            .iter()
            .any(|arg| arg == "--pre" || arg.starts_with("--pre=")) =>
        {
            None
        }
        name if SHELL_WRITE_COMMANDS.contains(&name)
            && args.iter().any(|arg| !arg.starts_with('-')) =>
        {
            Some(Write)
        }
        name if SHELL_THINKING_COMMANDS.contains(&name) => Some(Read),
        name if SHELL_SEARCH_COMMANDS.contains(&name) => Some(Search),
        _ => None,
    }
}

fn has_input_file_operand(args: &[String]) -> bool {
    let mut args = args.iter().map(String::as_str);
    let mut options = true;
    while let Some(arg) = args.next() {
        match arg {
            "--" if options => options = false,
            "-n" | "-c" | "--lines" | "--bytes" if options => {
                args.next();
            }
            token
                if token.split_once("<&").is_some_and(|(source, _)| {
                    source.bytes().all(|byte| byte.is_ascii_digit())
                }) =>
            {
                if token.ends_with("<&") {
                    args.next();
                }
            }
            "-" => {}
            option if options && option.starts_with('-') => {}
            _ => return true,
        }
    }
    false
}

fn classify_sed(args: &[String]) -> Option<ShellOperation> {
    let (options, scripts) = args.split_at(
        args.iter()
            .position(|arg| !arg.starts_with('-'))
            .unwrap_or(args.len()),
    );
    if options
        .iter()
        .any(|arg| arg.starts_with("-i") || arg == "--in-place" || arg.starts_with("--in-place="))
    {
        return Some(ShellOperation::Write);
    }
    let script = scripts.first()?.strip_suffix('p')?;
    if options.iter().all(|arg| arg == "-n")
        && script
            .chars()
            .all(|ch| ch.is_ascii_digit() || matches!(ch, ',' | '$' | ' '))
    {
        return Some(ShellOperation::Read);
    }
    None
}

fn unwrap_shell_command(command: &str) -> &str {
    let trimmed = command.trim();
    for wrapper in ["bash -lc", "sh -c", "zsh -c"] {
        if let Some(rest) = trimmed.strip_prefix(wrapper) {
            let rest = rest.trim();
            for quote in ['\'', '"'] {
                if let Some(body) = rest
                    .strip_prefix(quote)
                    .and_then(|body| body.strip_suffix(quote))
                {
                    return body;
                }
            }
            return rest;
        }
    }
    trimmed
}

fn command_invocation(command: &str) -> Option<(String, std::vec::IntoIter<String>)> {
    let mut words = shlex::split(command)?.into_iter();
    while let Some(word) = words.next() {
        if word.contains('=') && !word.starts_with("./") && !word.starts_with('/') {
            continue;
        }
        let executable = word.split(['<', '>']).next()?;
        let binary = normalize_binary_name(executable);
        if !SHELL_WRAPPER_COMMANDS.contains(&binary.as_str()) {
            return Some((binary, words));
        }
        while words
            .as_slice()
            .first()
            .is_some_and(|option| option.starts_with('-'))
        {
            let option = words.next()?;
            if option == "--" {
                break;
            }
            if matches!(
                (binary.as_str(), option.as_str()),
                ("env", "-u" | "--unset" | "-C" | "--chdir")
                    | ("sudo", "-u" | "-g" | "-h" | "-C" | "-D" | "-R" | "-T")
                    | ("nice", "-n" | "--adjustment")
                    | (
                        "stdbuf",
                        "-i" | "-o" | "-e" | "--input" | "--output" | "--error"
                    )
            ) {
                words.next()?;
            } else if !matches!(
                (binary.as_str(), option.as_str()),
                ("env", "-i" | "--ignore-environment")
                    | ("sudo", "-n" | "-E" | "-H")
                    | ("time" | "command", "-p")
            ) && !(binary == "stdbuf"
                && ["-i", "-o", "-e"]
                    .iter()
                    .any(|prefix| option.starts_with(prefix)))
            {
                return None;
            }
        }
    }
    None
}

fn shell_command_segments(command: &str) -> Option<Vec<&str>> {
    let mut segments = Vec::new();
    let mut start = 0;
    let mut skip_until = 0;
    let mut quote = None;
    let mut escaped = false;
    let mut heredocs = Vec::new();
    for (index, ch) in command.char_indices() {
        if index < skip_until {
            continue;
        }
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escaped = true;
        } else if let Some(delimiter) = quote {
            if delimiter == '"' && (ch == '`' || command[index..].starts_with("$(")) {
                return None;
            }
            if delimiter == ch {
                quote = None;
            }
        } else if matches!(ch, '(' | ')' | '`') {
            return None;
        } else if matches!(ch, '\'' | '"') {
            quote = Some(ch);
        } else if ch == '#'
            && (index == start || command.as_bytes()[index - 1].is_ascii_whitespace())
        {
            let segment = command[start..index].trim();
            if !segment.is_empty() {
                segments.push(segment);
            }
            skip_until = command[index..]
                .find('\n')
                .map_or(command.len(), |offset| index + offset);
            start = skip_until;
        } else if ch == '<'
            && (index == 0 || command.as_bytes()[index - 1] != b'<')
            && command[index..].starts_with("<<")
            && !command[index..].starts_with("<<<")
        {
            heredocs.push(heredoc_delimiter(&command[index + 2..])?);
        } else if matches!(ch, ';' | '|' | '&' | '\n' | '\r') {
            let previous = index.checked_sub(1).map(|index| command.as_bytes()[index]);
            if ch == '&'
                && (matches!(previous, Some(b'<' | b'>'))
                    || command.as_bytes().get(index + 1) == Some(&b'>'))
                || ch == '|' && previous == Some(b'>')
            {
                continue;
            }
            let segment = command[start..index].trim();
            if !segment.is_empty() {
                segments.push(segment);
            }
            start = index + ch.len_utf8();
            if ch == '\n' {
                // Skip the data of each heredoc, then resume with the next command line.
                for (delimiter, strip_tabs, quoted) in heredocs.drain(..) {
                    let mut closed = false;
                    for line in command[start..].split_inclusive('\n') {
                        start += line.len();
                        let line = line.trim_end_matches('\n');
                        let line = if strip_tabs {
                            line.trim_start_matches('\t')
                        } else {
                            line
                        };
                        if line == delimiter {
                            closed = true;
                            break;
                        }
                        if !quoted && line.contains(['$', '`', '\\']) {
                            return None;
                        }
                    }
                    if !closed {
                        return None;
                    }
                }
                skip_until = start;
            }
        }
    }
    let segment = command[start..].trim();
    if !segment.is_empty() {
        segments.push(segment);
    }
    if quote.is_some() || escaped || !heredocs.is_empty() {
        return None;
    }
    Some(segments)
}

fn heredoc_delimiter(input: &str) -> Option<(&str, bool, bool)> {
    let strip_tabs = input.starts_with('-');
    let input = input.strip_prefix('-').unwrap_or(input).trim_start();
    let is_boundary = |ch: char| ch.is_whitespace() || "<>|;&".contains(ch);
    if let Some(quote @ ('\'' | '"')) = input.chars().next() {
        let (delimiter, suffix) = input[1..].split_once(quote)?;
        return (!delimiter.is_empty()
            && !delimiter.contains(['\n', '\\'])
            && suffix.chars().next().is_none_or(is_boundary))
        .then_some((delimiter, strip_tabs, true));
    }
    let word = input.split(is_boundary).next()?;
    let delimiter = word.strip_prefix('\\').unwrap_or(word);
    (!delimiter.is_empty()
        && delimiter
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte)))
    .then_some((delimiter, strip_tabs, word != delimiter))
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

fn has_file_redirect(command: &str) -> Option<bool> {
    let bytes = command.as_bytes();
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    for index in 0..bytes.len() {
        let ch = bytes[index] as char;
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' && !in_single {
            escaped = true;
            continue;
        }
        if in_single {
            if ch == '\'' {
                in_single = false;
            }
            continue;
        }
        if in_double {
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
        if bytes.get(index + 1) == Some(&b'&') {
            let descriptor = command[index + 2..]
                .trim_start()
                .split_ascii_whitespace()
                .next()?;
            if descriptor == "-" || descriptor.bytes().all(|digit| digit.is_ascii_digit()) {
                continue;
            }
            return None;
        }
        let target = command[index + 1..]
            .trim_start_matches(['>', '|'])
            .trim_start();
        let target = shlex::split(target)?.into_iter().next()?;
        if target.starts_with('$') {
            return None;
        }
        if matches!(target.as_str(), "/dev/null" | "/dev/stdout" | "/dev/stderr")
            || target.starts_with("/dev/fd/")
        {
            continue;
        }
        return Some(true);
    }
    Some(false)
}
