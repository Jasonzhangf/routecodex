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

fn is_relative_shell_cd_path(path: &str) -> bool {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.starts_with('/')
        || trimmed.starts_with('\\')
        || trimmed.starts_with('~')
        || trimmed.contains('$')
        || trimmed.contains('`')
        || trimmed.contains(';')
        || trimmed.contains('|')
        || trimmed.contains('<')
        || trimmed.contains('>')
        || trimmed.contains('&')
        || trimmed.contains('(')
        || trimmed.contains(')')
        || trimmed.contains('{')
        || trimmed.contains('}')
        || trimmed.contains('[')
        || trimmed.contains(']')
        || trimmed.contains('*')
        || trimmed.contains('?')
        || trimmed.contains('\t')
        || trimmed.contains('\n')
        || trimmed.contains('\r')
        || trimmed.contains(' ')
    {
        return false;
    }
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return false;
    }
    !trimmed
        .split('/')
        .chain(trimmed.split('\\'))
        .any(|segment| segment == "..")
}

fn normalize_relative_patch_path(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with('/')
        || trimmed.starts_with('\\')
        || trimmed.starts_with('~')
        || trimmed.contains('\n')
        || trimmed.contains('\r')
    {
        return None;
    }
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return None;
    }
    let mut out: Vec<&str> = Vec::new();
    for segment in trimmed.split('/') {
        for part in segment.split('\\') {
            let normalized = part.trim();
            if normalized.is_empty() || normalized == "." {
                continue;
            }
            if normalized == ".." {
                return None;
            }
            out.push(normalized);
        }
    }
    if out.is_empty() {
        return None;
    }
    Some(out.join("/"))
}

fn rebase_patch_headers_with_relative_workdir(patch_text: &str, workdir: &str) -> Option<String> {
    let base = normalize_relative_patch_path(workdir)?;
    let mut out: Vec<String> = Vec::new();
    for line in patch_text.split('\n') {
        let trimmed = line.trim();
        if let Some(path) = trimmed.strip_prefix("*** Add File:") {
            let rel = normalize_relative_patch_path(path)?;
            out.push(format!("*** Add File: {}/{}", base, rel));
            continue;
        }
        if let Some(path) = trimmed.strip_prefix("*** Update File:") {
            let rel = normalize_relative_patch_path(path)?;
            out.push(format!("*** Update File: {}/{}", base, rel));
            continue;
        }
        if let Some(path) = trimmed.strip_prefix("*** Delete File:") {
            let rel = normalize_relative_patch_path(path)?;
            out.push(format!("*** Delete File: {}/{}", base, rel));
            continue;
        }
        if let Some(path) = trimmed.strip_prefix("*** Move to:") {
            let rel = normalize_relative_patch_path(path)?;
            out.push(format!("*** Move to: {}/{}", base, rel));
            continue;
        }
        out.push(line.to_string());
    }
    Some(out.join("\n"))
}

fn normalize_absolute_patch_path(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.contains('\n')
        || trimmed.contains('\r')
        || trimmed.starts_with('~')
    {
        return None;
    }

    let normalized = trimmed.replace('\\', "/");
    let bytes = normalized.as_bytes();
    let is_unix_abs = normalized.starts_with('/');
    let is_windows_abs =
        bytes.len() >= 3 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() && bytes[2] == b'/';
    if !is_unix_abs && !is_windows_abs {
        return None;
    }

    let mut prefix = String::new();
    let tail = if is_windows_abs {
        prefix.push((bytes[0] as char).to_ascii_uppercase());
        prefix.push(':');
        &normalized[2..]
    } else {
        prefix.push('/');
        &normalized[1..]
    };

    let mut segments: Vec<&str> = Vec::new();
    for segment in tail.split('/') {
        let normalized_segment = segment.trim();
        if normalized_segment.is_empty() || normalized_segment == "." {
            continue;
        }
        if normalized_segment == ".." {
            return None;
        }
        segments.push(normalized_segment);
    }

    if is_unix_abs {
        if segments.is_empty() {
            return Some("/".to_string());
        }
        return Some(format!("/{}", segments.join("/")));
    }

    if segments.is_empty() {
        return Some(format!("{}/", prefix));
    }
    Some(format!("{}/{}", prefix, segments.join("/")))
}

fn relativize_absolute_patch_path_against_workdir(path: &str, workdir: &str) -> Option<String> {
    let normalized_path = normalize_absolute_patch_path(path)?;
    let normalized_workdir = normalize_absolute_patch_path(workdir)?;
    if normalized_path == normalized_workdir {
        return None;
    }

    let boundary = if normalized_workdir == "/" || normalized_workdir.ends_with('/') {
        normalized_workdir.clone()
    } else {
        format!("{}/", normalized_workdir)
    };
    let rel = normalized_path.strip_prefix(&boundary)?;
    normalize_relative_patch_path(rel)
}

fn rewrite_patch_headers_with_absolute_workdir(patch_text: &str, workdir: &str) -> Option<String> {
    let mut out: Vec<String> = Vec::new();
    for line in patch_text.split('\n') {
        let trimmed = line.trim();
        if let Some(path) = trimmed.strip_prefix("*** Add File:") {
            let rel = normalize_relative_patch_path(path)
                .or_else(|| relativize_absolute_patch_path_against_workdir(path, workdir))?;
            out.push(format!("*** Add File: {}", rel));
            continue;
        }
        if let Some(path) = trimmed.strip_prefix("*** Update File:") {
            let rel = normalize_relative_patch_path(path)
                .or_else(|| relativize_absolute_patch_path_against_workdir(path, workdir))?;
            out.push(format!("*** Update File: {}", rel));
            continue;
        }
        if let Some(path) = trimmed.strip_prefix("*** Delete File:") {
            let rel = normalize_relative_patch_path(path)
                .or_else(|| relativize_absolute_patch_path_against_workdir(path, workdir))?;
            out.push(format!("*** Delete File: {}", rel));
            continue;
        }
        if let Some(path) = trimmed.strip_prefix("*** Move to:") {
            let rel = normalize_relative_patch_path(path)
                .or_else(|| relativize_absolute_patch_path_against_workdir(path, workdir))?;
            out.push(format!("*** Move to: {}", rel));
            continue;
        }
        out.push(line.to_string());
    }
    Some(out.join("\n"))
}

fn rewrite_patch_headers_for_workdir(patch_text: &str, workdir: &str) -> Option<String> {
    if normalize_relative_patch_path(workdir).is_some() {
        return rebase_patch_headers_with_relative_workdir(patch_text, workdir);
    }
    if normalize_absolute_patch_path(workdir).is_some() {
        return rewrite_patch_headers_with_absolute_workdir(patch_text, workdir);
    }
    None
}

fn parse_outer_shell_wrapper(raw: &str) -> Option<&str> {
    for prefix in [
        "bash -lc ",
        "bash -c ",
        "zsh -lc ",
        "zsh -c ",
        "sh -lc ",
        "sh -c ",
    ] {
        let Some(rest) = raw.strip_prefix(prefix) else {
            continue;
        };
        let rest = rest.trim();
        if rest.is_empty() {
            return None;
        }
        if let Some(inner) = rest.strip_prefix('"') {
            let mut escaped = false;
            for (idx, ch) in inner.char_indices() {
                if escaped {
                    escaped = false;
                    continue;
                }
                if ch == '\\' {
                    escaped = true;
                    continue;
                }
                if ch == '"' {
                    let tail = inner[idx + ch.len_utf8()..].trim();
                    if tail.is_empty() {
                        return Some(&inner[..idx]);
                    }
                    return None;
                }
            }
            return None;
        }
        if let Some(inner) = rest.strip_prefix('\'') {
            if let Some(end) = inner.find('\'') {
                let tail = inner[end + 1..].trim();
                if tail.is_empty() {
                    return Some(&inner[..end]);
                }
                return None;
            }
            return None;
        }
        return Some(rest);
    }
    None
}

fn extract_exact_apply_patch_from_shell_script(script: &str) -> Option<String> {
    let normalized = script.replace("\r\n", "\n");
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !trimmed.starts_with("apply_patch") && !trimmed.starts_with("cd ") {
        return None;
    }

    let (rest, workdir) = if let Some(after_cd) = trimmed.strip_prefix("cd ") {
        let and_idx = after_cd.find("&&")?;
        let path = after_cd[..and_idx].trim();
        if !is_relative_shell_cd_path(path) {
            return None;
        }
        let rest = after_cd[and_idx + 2..].trim_start();
        if !rest.starts_with("apply_patch") {
            return None;
        }
        (rest, Some(path.to_string()))
    } else {
        (trimmed, None)
    };

    let after_cmd = rest.strip_prefix("apply_patch")?.trim_start();
    let after_redirect = after_cmd.strip_prefix("<<")?.trim_start();
    let (delimiter, body) = if let Some(rest) = after_redirect.strip_prefix('\'') {
        let end = rest.find('\'')?;
        let token = &rest[..end];
        if token.is_empty() {
            return None;
        }
        let remainder = &rest[end + 1..];
        let body = remainder.strip_prefix('\n')?;
        (token.to_string(), body)
    } else if let Some(rest) = after_redirect.strip_prefix('"') {
        let end = rest.find('"')?;
        let token = &rest[..end];
        if token.is_empty() {
            return None;
        }
        let remainder = &rest[end + 1..];
        let body = remainder.strip_prefix('\n')?;
        (token.to_string(), body)
    } else {
        let newline_idx = after_redirect.find('\n')?;
        let token = after_redirect[..newline_idx].trim();
        if token.is_empty()
            || !token
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        {
            return None;
        }
        (token.to_string(), &after_redirect[newline_idx + 1..])
    };

    let lines: Vec<&str> = body.split('\n').collect();
    let end_idx = lines.iter().rposition(|line| line.trim() == delimiter)?;
    if lines[end_idx + 1..].iter().any(|line| !line.trim().is_empty()) {
        return None;
    }
    let patch_body = lines[..end_idx].join("\n").trim().to_string();
    if patch_body.is_empty() {
        return None;
    }
    if !looks_like_patch_body_after_apply_patch_prefix(&patch_body)
        && find_first_patch_marker(&patch_body).is_none()
    {
        return None;
    }
    if let Some(workdir) = workdir {
        return rebase_patch_headers_with_relative_workdir(&patch_body, &workdir);
    }
    Some(patch_body)
}

fn extract_exact_apply_patch_from_shell_wrapper(raw: &str) -> Option<String> {
    let normalized = decode_escaped_newlines_if_needed(raw).replace("\r\n", "\n");
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(script) = parse_outer_shell_wrapper(trimmed) {
        return extract_exact_apply_patch_from_shell_script(script);
    }
    extract_exact_apply_patch_from_shell_script(trimmed)
}

fn looks_like_noncanonical_shell_apply_patch_attempt(raw: &str) -> bool {
    let normalized = decode_escaped_newlines_if_needed(raw).replace("\r\n", "\n");
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        return false;
    }
    let apply_patch_idx = trimmed.find("apply_patch <<");
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("bash -lc ")
        || lower.starts_with("bash -c ")
        || lower.starts_with("zsh -lc ")
        || lower.starts_with("zsh -c ")
        || lower.starts_with("sh -lc ")
        || lower.starts_with("sh -c ")
    {
        return trimmed.contains("apply_patch <<");
    }
    if let Some(idx) = apply_patch_idx {
        let prefix = trimmed[..idx].trim();
        if !prefix.is_empty() && !prefix.eq("cd") {
            return true;
        }
    }
    (trimmed.starts_with("apply_patch") || trimmed.starts_with("cd "))
        && trimmed.contains("apply_patch <<")
}

fn decode_json_quoted_field_escapes(raw: &str) -> String {
    raw.replace("\\r\\n", "\n")
        .replace("\\n", "\n")
        .replace("\\r", "\n")
        .replace("\\t", "\t")
        .replace("\\\"", "\"")
        .replace("\\\\", "\\")
}

fn extract_broken_json_quoted_value(raw: &str, keys: &[&str]) -> Option<String> {
    for key in keys {
        let pattern = format!("\"{}\"", key);
        let Some(start) = raw.find(&pattern) else {
            continue;
        };
        let mut cursor = start + pattern.len();
        while let Some(ch) = raw[cursor..].chars().next() {
            if ch.is_whitespace() {
                cursor += ch.len_utf8();
                continue;
            }
            if ch != ':' {
                break;
            }
            cursor += ch.len_utf8();
            while let Some(space) = raw[cursor..].chars().next() {
                if space.is_whitespace() {
                    cursor += space.len_utf8();
                    continue;
                }
                if space != '"' {
                    break;
                }
                cursor += 1;
                let mut escaped = false;
                let mut out = String::new();
                for ch in raw[cursor..].chars() {
                    if escaped {
                        out.push('\\');
                        out.push(ch);
                        escaped = false;
                        cursor += ch.len_utf8();
                        continue;
                    }
                    if ch == '\\' {
                        escaped = true;
                        cursor += 1;
                        continue;
                    }
                    if ch == '"' {
                        return Some(decode_json_quoted_field_escapes(&out));
                    }
                    out.push(ch);
                    cursor += ch.len_utf8();
                }
                return Some(decode_json_quoted_field_escapes(&out));
            }
            break;
        }
    }
    None
}

fn extract_simple_broken_json_string_field(raw: &str, keys: &[&str]) -> Option<String> {
    for key in keys {
        let pattern = format!(r#""{}"\s*:\s*"([^"]*)""#, regex::escape(key));
        let re = Regex::new(&pattern).ok()?;
        let Some(captures) = re.captures(raw) else {
            continue;
        };
        let value = captures.get(1)?.as_str();
        let decoded = decode_json_quoted_field_escapes(value);
        if !decoded.trim().is_empty() {
            return Some(decoded);
        }
    }
    None
}

fn extract_broken_json_workdir(raw: &str) -> Option<String> {
    extract_broken_json_quoted_value(raw, &["workdir", "cwd", "workDir"])
        .or_else(|| extract_simple_broken_json_string_field(raw, &["workdir", "cwd", "workDir"]))
}

fn extract_patch_text_from_broken_json_wrapper(raw: &str) -> Option<String> {
    let command = extract_broken_json_quoted_value(raw, &["cmd", "command"])?;
    if looks_like_noncanonical_shell_apply_patch_attempt(&command)
        && extract_exact_apply_patch_from_shell_wrapper(&command).is_none()
    {
        return None;
    }
    let patch_text = extract_exact_apply_patch_from_shell_wrapper(&command).or_else(|| {
        let trimmed = command.trim();
        let rest = if trimmed.starts_with("apply_patch") {
            trimmed
        } else {
            return None;
        };
        Some(rest.to_string())
    })?;
    let workdir = extract_broken_json_workdir(raw);
    if let Some(workdir) = workdir {
        if let Some(rewritten) = rewrite_patch_headers_for_workdir(&patch_text, &workdir) {
            return Some(rewritten);
        }
        let normalized_patch = normalize_apply_patch_text(&patch_text);
        if normalized_patch != patch_text {
            if let Some(rewritten) = rewrite_patch_headers_for_workdir(&normalized_patch, &workdir)
            {
                return Some(rewritten);
            }
        }
        return Some(patch_text);
    }
    Some(patch_text)
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
            if is_patch_file_header_line(probe_trimmed)
                || probe_trimmed.starts_with("*** End Patch")
            {
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

fn normalize_apply_patch_header_path_with_new_file_hint(raw: &str) -> (String, bool) {
    let mut out = raw.trim().to_string();
    if out.is_empty() {
        return (out, false);
    }

    let mut new_file_hint = false;
    loop {
        let mut changed = false;
        let bytes = out.as_bytes();
        if bytes.len() >= 2 {
            let first = bytes[0] as char;
            let last = bytes[bytes.len() - 1] as char;
            let is_wrapped = (first == '"' && last == '"')
                || (first == '\'' && last == '\'')
                || (first == '`' && last == '`');
            if is_wrapped {
                out = out[1..out.len() - 1].trim().to_string();
                changed = true;
            }
        }

        let lower = out.to_ascii_lowercase();
        if lower.starts_with("file:") {
            out = out[5..].trim().to_string();
            changed = true;
        }
        if lower.ends_with(" is new") && out.len() >= " is new".len() {
            let keep = out.len() - " is new".len();
            out = out[..keep].trim().to_string();
            new_file_hint = true;
            changed = true;
        }

        if !changed {
            break;
        }
    }
    (out, new_file_hint)
}

fn normalize_apply_patch_header_path(raw: &str) -> String {
    normalize_apply_patch_header_path_with_new_file_hint(raw).0
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
            let (normalized_path, new_file_hint) =
                normalize_apply_patch_header_path_with_new_file_hint(path.as_str());
            if new_file_hint {
                return format!("*** Add File: {}", normalized_path);
            }
            return format!("*** Update File: {}", normalized_path);
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

fn decode_legacy_old_line(raw: &str) -> (char, String) {
    let lead = raw.chars().next().unwrap_or(' ');
    match lead {
        '!' | '-' => {
            let rest = raw[1..].strip_prefix(' ').unwrap_or(&raw[1..]);
            ('-', rest.to_string())
        }
        ' ' => (' ', raw[1..].to_string()),
        _ => (' ', raw.to_string()),
    }
}

fn decode_legacy_new_line(raw: &str) -> (char, String) {
    let lead = raw.chars().next().unwrap_or('+');
    match lead {
        '!' | '+' => {
            let rest = raw[1..].strip_prefix(' ').unwrap_or(&raw[1..]);
            ('+', rest.to_string())
        }
        ' ' => (' ', raw[1..].to_string()),
        _ => ('+', raw.to_string()),
    }
}

fn repair_legacy_context_diff_hunks_inside_apply_patch_envelope(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut i = 0usize;
    let mut changed = false;

    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();
        if !trimmed.starts_with("*** Update File:") {
            out.push(line.to_string());
            i += 1;
            continue;
        }

        out.push(trimmed.to_string());
        i += 1;

        let mut section_body: Vec<&str> = Vec::new();
        while i < lines.len() {
            let next_trimmed = lines[i].trim();
            if next_trimmed.starts_with("*** Update File:")
                || next_trimmed.starts_with("*** Add File:")
                || next_trimmed.starts_with("*** Delete File:")
                || next_trimmed.starts_with("*** End Patch")
            {
                break;
            }
            section_body.push(lines[i]);
            i += 1;
        }

        let has_modern_hunk = section_body
            .iter()
            .any(|entry| entry.trim_start().starts_with("@@"));
        let has_legacy_old = section_body.iter().any(|entry| {
            let trimmed_entry = entry.trim();
            trimmed_entry.starts_with("*** ") && trimmed_entry.ends_with(" ****")
        });
        let has_legacy_new = section_body.iter().any(|entry| {
            let trimmed_entry = entry.trim();
            trimmed_entry.starts_with("--- ") && trimmed_entry.ends_with(" ----")
        });

        if has_modern_hunk || !has_legacy_old || !has_legacy_new {
            out.extend(section_body.into_iter().map(str::to_string));
            continue;
        }

        let mut converted_section: Vec<String> = Vec::new();
        let mut j = 0usize;
        let mut converted_any = false;

        while j < section_body.len() {
            let current = section_body[j];
            let current_trimmed = current.trim();
            let is_old_header =
                current_trimmed.starts_with("*** ") && current_trimmed.ends_with(" ****");

            if !is_old_header {
                converted_section.push(current.to_string());
                j += 1;
                continue;
            }

            j += 1;
            let mut old_lines: Vec<&str> = Vec::new();
            while j < section_body.len() {
                let probe_trimmed = section_body[j].trim();
                let probe_is_old =
                    probe_trimmed.starts_with("*** ") && probe_trimmed.ends_with(" ****");
                let probe_is_new =
                    probe_trimmed.starts_with("--- ") && probe_trimmed.ends_with(" ----");
                if probe_is_old || probe_is_new {
                    break;
                }
                old_lines.push(section_body[j]);
                j += 1;
            }

            if j >= section_body.len() {
                converted_section.push(current.to_string());
                converted_section.extend(old_lines.into_iter().map(str::to_string));
                break;
            }

            let new_header_trimmed = section_body[j].trim();
            if !(new_header_trimmed.starts_with("--- ") && new_header_trimmed.ends_with(" ----")) {
                converted_section.push(current.to_string());
                converted_section.extend(old_lines.into_iter().map(str::to_string));
                continue;
            }

            j += 1;
            let mut new_lines: Vec<&str> = Vec::new();
            while j < section_body.len() {
                let probe_trimmed = section_body[j].trim();
                let probe_is_old =
                    probe_trimmed.starts_with("*** ") && probe_trimmed.ends_with(" ****");
                if probe_is_old {
                    break;
                }
                new_lines.push(section_body[j]);
                j += 1;
            }

            converted_section.push("@@".to_string());

            let mut oi = 0usize;
            let mut ni = 0usize;
            while oi < old_lines.len() || ni < new_lines.len() {
                let old_entry = old_lines.get(oi).copied();
                let new_entry = new_lines.get(ni).copied();

                match (old_entry, new_entry) {
                    (Some(old_raw), Some(new_raw)) => {
                        let (old_kind, old_text) = decode_legacy_old_line(old_raw);
                        let (new_kind, new_text) = decode_legacy_new_line(new_raw);
                        if old_kind == ' ' && new_kind == ' ' && old_text == new_text {
                            converted_section.push(format!(" {}", old_text));
                            oi += 1;
                            ni += 1;
                            continue;
                        }
                        if old_kind == '-' {
                            converted_section.push(format!("-{}", old_text));
                            oi += 1;
                            if new_kind == '+' {
                                converted_section.push(format!("+{}", new_text));
                                ni += 1;
                            }
                            continue;
                        }
                        if new_kind == '+' {
                            converted_section.push(format!("+{}", new_text));
                            ni += 1;
                            continue;
                        }
                        if old_kind == ' ' {
                            converted_section.push(format!(" {}", old_text));
                            oi += 1;
                            continue;
                        }
                        if new_kind == ' ' {
                            converted_section.push(format!(" {}", new_text));
                            ni += 1;
                            continue;
                        }
                        oi += 1;
                        ni += 1;
                    }
                    (Some(old_raw), None) => {
                        let (old_kind, old_text) = decode_legacy_old_line(old_raw);
                        if old_kind == '-' {
                            converted_section.push(format!("-{}", old_text));
                        } else {
                            converted_section.push(format!(" {}", old_text));
                        }
                        oi += 1;
                    }
                    (None, Some(new_raw)) => {
                        let (new_kind, new_text) = decode_legacy_new_line(new_raw);
                        if new_kind == '+' {
                            converted_section.push(format!("+{}", new_text));
                        } else {
                            converted_section.push(format!(" {}", new_text));
                        }
                        ni += 1;
                    }
                    (None, None) => break,
                }
            }

            converted_any = true;
        }

        if converted_any {
            changed = true;
            out.extend(converted_section);
        } else {
            out.extend(section_body.into_iter().map(str::to_string));
        }
    }

    if changed {
        out.join("\n")
    } else {
        text.to_string()
    }
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

    text = repair_legacy_context_diff_hunks_inside_apply_patch_envelope(&text);
    let has_modern_hunk = text.lines().any(|line| line.trim_start().starts_with("@@"));

    let mut out: Vec<String> = Vec::new();
    let mut in_add_section = false;
    let mut pending_unified_from: Option<String> = None;
    for line in text.split('\n') {
        let raw_line = line.strip_suffix('\r').unwrap_or(line);
        let mut normalized = normalize_apply_patch_header_line(raw_line.trim());
        if has_modern_hunk
            && (raw_line.trim() == "***************"
                || is_legacy_context_diff_hunk_header_line(raw_line.trim()))
        {
            continue;
        }
        if normalized.starts_with("*** a/") {
            normalized = format!("--- {}", normalized.trim_start_matches("*** ").trim());
        } else if normalized.starts_with("*** b/") {
            normalized = format!("+++ {}", normalized.trim_start_matches("*** ").trim());
        }

        if normalized.starts_with("--- ") {
            pending_unified_from = Some(normalized.trim_start_matches("--- ").trim().to_string());
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
            if raw_line.trim_start().starts_with("@@") {
                continue;
            }
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
    if let Some(shell_patch) = extract_exact_apply_patch_from_shell_wrapper(trimmed) {
        return Some(shell_patch);
    }
    if looks_like_noncanonical_shell_apply_patch_attempt(trimmed) {
        return None;
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
        return extract_patch_text_from_value(&parsed);
    }
    if trimmed.starts_with('{') {
        if let Some(broken_wrapper_patch) = extract_patch_text_from_broken_json_wrapper(trimmed) {
            return Some(broken_wrapper_patch);
        }
    }
    Some(trimmed.to_string())
}

fn extract_patch_text_from_value(value: &Value) -> Option<String> {
    fn extract_patch_text_from_command_value(value: &Value) -> Option<String> {
        match value {
            Value::String(raw) => extract_exact_apply_patch_from_shell_wrapper(raw)
                .or_else(|| {
                    let trimmed = raw.trim();
                    if trimmed.starts_with("apply_patch") {
                        Some(trimmed.to_string())
                    } else {
                        None
                    }
                }),
            Value::Array(items) => {
                let tokens: Vec<String> = items
                    .iter()
                    .map(|entry| entry.as_str().map(|v| v.to_string()))
                    .collect::<Option<Vec<String>>>()?;
                if tokens.len() >= 2 {
                    let command_token = tokens[0].trim().to_ascii_lowercase();
                    if command_token == "apply_patch" || command_token == "applypatch" {
                        let patch_text = tokens[1..].join("\n").trim().to_string();
                        if !patch_text.is_empty() {
                            return Some(patch_text);
                        }
                    }
                }
                if tokens.len() == 3 {
                    let shell = tokens[0].trim().to_ascii_lowercase();
                    let flag = tokens[1].trim().to_ascii_lowercase();
                    if matches!(shell.as_str(), "bash" | "zsh" | "sh")
                        && matches!(flag.as_str(), "-lc" | "-c")
                    {
                        return extract_exact_apply_patch_from_shell_script(&tokens[2]);
                    }
                }
                None
            }
            _ => None,
        }
    }

    fn extract_patch_text_from_command_value_with_workdir(
        value: &Value,
        workdir: Option<&str>,
    ) -> Option<String> {
        let patch = extract_patch_text_from_command_value(value)?;
        if let Some(workdir) = workdir {
            return rewrite_patch_headers_for_workdir(&patch, workdir);
        }
        Some(patch)
    }

    fn extract_patch_text_from_object(obj: &Map<String, Value>) -> Option<String> {
        let workdir = read_trimmed_string(obj.get("workdir"));
        obj.get("patch")
            .and_then(extract_patch_text_from_value)
            .or_else(|| obj.get("input").and_then(extract_patch_text_from_value))
            .or_else(|| {
                obj.get("instructions")
                    .and_then(extract_patch_text_from_value)
            })
            .or_else(|| obj.get("arguments").and_then(extract_patch_text_from_value))
            .or_else(|| {
                obj.get("command").and_then(|value| {
                    extract_patch_text_from_command_value_with_workdir(
                        value,
                        workdir.as_deref(),
                    )
                })
            })
            .or_else(|| {
                obj.get("cmd").and_then(|value| {
                    extract_patch_text_from_command_value_with_workdir(
                        value,
                        workdir.as_deref(),
                    )
                })
            })
            .or_else(|| obj.get("result").and_then(extract_patch_text_from_value))
            .or_else(|| obj.get("payload").and_then(extract_patch_text_from_value))
            .or_else(|| obj.get("data").and_then(extract_patch_text_from_value))
    }

    match value {
        Value::String(raw) => extract_patch_text_from_argument(raw),
        Value::Object(obj) => extract_patch_text_from_object(obj),
        Value::Array(items) => extract_patch_text_from_command_value(value)
            .or_else(|| items.iter().find_map(extract_patch_text_from_value)),
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
            }))
            .ok();
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
            let Some(tool_calls) = message_obj
                .get_mut("tool_calls")
                .and_then(Value::as_array_mut)
            else {
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
    use super::{
        extract_broken_json_workdir, extract_patch_text_from_broken_json_wrapper,
        fix_apply_patch_tool_calls_json, normalize_apply_patch_tool_arguments_from_value,
        rewrite_patch_headers_for_workdir,
    };
    use serde_json::{json, Value};

    #[test]
    fn extracts_workdir_from_broken_json_wrapper_string() {
        let raw = "{\"cmd\":\"apply_patch << 'PATCH'\n*** Begin Patch\n*** Update File: /Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.ts\n@@\n-old\n+new\n*** End Patch\nPATCH\",\"workdir\":\"/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core\",\"shell\":\"/bin/zsh\"}";
        assert_eq!(
            extract_broken_json_workdir(raw).as_deref(),
            Some("/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core")
        );
    }

    #[test]
    fn rewrites_absolute_patch_headers_against_absolute_workdir() {
        let patch = "*** Begin Patch\n*** Update File: /Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.ts\n@@\n-old\n+new\n*** End Patch";
        let rewritten = rewrite_patch_headers_for_workdir(
            patch,
            "/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core",
        )
        .expect("rewritten patch");
        assert!(
            rewritten.contains("*** Update File: src/router/virtual-router/bootstrap.ts"),
            "rewritten={}",
            rewritten.replace('\n', "\\n")
        );
        assert!(!rewritten.contains(
            "/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.ts"
        ));
    }

    #[test]
    fn salvages_broken_json_wrapper_patch_text_directly() {
        let raw = "{\"cmd\":\"apply_patch << 'PATCH'\n*** Begin Patch\n*** Update File: /Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.ts\n@@\n-old\n+new\n*** End Patch\nPATCH\",\"workdir\":\"/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core\",\"shell\":\"/bin/zsh\"}";
        let patch = extract_patch_text_from_broken_json_wrapper(raw).expect("salvaged patch");
        assert!(
            patch.contains("*** Update File: src/router/virtual-router/bootstrap.ts"),
            "patch={}",
            patch.replace('\n', "\\n")
        );
        assert!(!patch.contains(
            "/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.ts"
        ));
    }

    #[test]
    fn normalizes_broken_json_wrapper_string_value_to_relative_patch() {
        let raw = Value::String("{\"cmd\":\"apply_patch << 'PATCH'\n*** Begin Patch\n*** Update File: /Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.ts\n@@\n-old\n+new\n*** End Patch\nPATCH\",\"workdir\":\"/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core\",\"shell\":\"/bin/zsh\"}".to_string());
        let normalized =
            normalize_apply_patch_tool_arguments_from_value(&raw).expect("normalized args");
        let parsed: Value = serde_json::from_str(&normalized).expect("parse normalized");
        let patch = parsed["patch"].as_str().expect("patch");
        assert!(
            patch.contains("*** Update File: src/router/virtual-router/bootstrap.ts"),
            "patch={}",
            patch.replace('\n', "\\n")
        );
        assert!(!patch.contains(
            "/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.ts"
        ));
    }

    #[test]
    fn rewrite_round_trip_on_json_parsed_object_cmd_and_workdir() {
        let value = serde_json::json!({
            "cmd": "apply_patch << 'PATCH'\n*** Begin Patch\n*** Update File: /Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.ts\n@@\n-old\n+new\n*** End Patch\nPATCH",
            "workdir": "/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core",
            "shell": "/bin/zsh"
        });
        let normalized =
            normalize_apply_patch_tool_arguments_from_value(&value).expect("normalized args");
        let parsed: Value = serde_json::from_str(&normalized).expect("parse normalized");
        let patch = parsed["patch"].as_str().expect("patch");
        assert!(
            patch.contains("*** Update File: src/router/virtual-router/bootstrap.ts"),
            "patch={}",
            patch.replace('\n', "\\n")
        );
    }

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
    fn repairs_nested_command_wrapper_payload_when_patch_shape_is_complete() {
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
    fn repairs_command_field_only_input_items_when_patch_shape_is_complete() {
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
        let args = output["input"][0]["arguments"].as_str().expect("arguments");
        let parsed: Value = serde_json::from_str(args).expect("parse normalized arguments");
        let patch = parsed["patch"].as_str().expect("patch");
        assert!(
            patch.contains("*** Add File: src/input-only.ts"),
            "patch={}",
            patch.replace('\n', "\\n")
        );
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
            "arguments": "apply_patch --- a/HEARTBEAT.md\n+++ b/HEARTBEAT.md\n@@ -1 +1 @@\n-old\n+new"
          }]
        });
        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        let args = output["input"][0]["arguments"]
            .as_str()
            .expect("arguments string");
        let parsed: Value = serde_json::from_str(args).expect("parse normalized arguments");
        let patch = parsed["patch"].as_str().expect("patch");
        assert!(patch.starts_with("*** Begin Patch"));
        assert!(patch.contains("*** Update File: HEARTBEAT.md"));
        assert!(!patch.contains("--- a/HEARTBEAT.md"));
        assert!(patch.contains("@@ -1 +1 @@"));
        assert!(patch.ends_with("*** End Patch"));
    }

    #[test]
    fn normalizes_exact_bash_lc_heredoc_wrapper_to_apply_patch() {
        let payload = json!({
          "messages": [{
            "role": "assistant",
            "tool_calls": [{
              "type": "function",
              "function": {
                "name": "apply_patch",
                "arguments": r#"bash -lc "apply_patch <<'PATCH'
*** Begin Patch
*** Add File: src/shell-wrapper.ts
+console.log('wrapped');
*** End Patch
PATCH""#
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
        assert!(patch.contains("*** Add File: src/shell-wrapper.ts"));
        assert!(patch.contains("+console.log('wrapped');"));
        assert_eq!(
            output["messages"][0]["tool_calls"][0]["_fixed_apply_patch"],
            Value::Bool(true)
        );
    }

    #[test]
    fn normalizes_shell_wrapper_when_heredoc_operator_has_spacing_before_token() {
        let payload = json!({
          "messages": [{
            "role": "assistant",
            "tool_calls": [{
              "type": "function",
              "function": {
                "name": "apply_patch",
                "arguments": r#"apply_patch << 'PATCH'
*** Begin Patch
*** Add File: src/spaced-token.ts
+console.log('spaced');
*** End Patch
PATCH"#
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
        assert!(patch.contains("*** Add File: src/spaced-token.ts"));
        assert!(patch.contains("+console.log('spaced');"));
        assert_eq!(
            output["messages"][0]["tool_calls"][0]["_fixed_apply_patch"],
            Value::Bool(true)
        );
    }

    #[test]
    fn rebases_patch_headers_for_exact_cd_and_apply_patch_shell_wrapper() {
        let payload = json!({
          "input": [{
            "type": "function_call",
            "name": "apply_patch",
            "arguments": {
              "command": ["bash", "-lc", "cd packages/core && apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: src/lib.rs\n@@\n-old\n+new\n*** End Patch\nPATCH"]
            }
          }]
        });
        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        let args = output["input"][0]["arguments"].as_str().expect("arguments");
        let parsed: Value = serde_json::from_str(args).expect("parse normalized arguments");
        let patch = parsed["patch"].as_str().expect("patch");
        assert!(patch.contains("*** Update File: packages/core/src/lib.rs"));
        assert!(!patch.contains("*** Update File: src/lib.rs"));
        assert_eq!(output["input"][0]["_fixed_apply_patch"], Value::Bool(true));
    }

    #[test]
    fn relativizes_absolute_patch_headers_using_explicit_workdir_on_command_wrapper() {
        let payload = json!({
          "input": [{
            "type": "function_call",
            "name": "apply_patch",
            "arguments": {
              "cmd": "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: /Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.ts\n@@\n-old\n+new\n*** End Patch\nPATCH",
              "workdir": "/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core"
            }
          }]
        });
        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        let args = output["input"][0]["arguments"].as_str().expect("arguments");
        let parsed: Value = serde_json::from_str(args).expect("parse normalized arguments");
        let patch = parsed["patch"].as_str().expect("patch");
        eprintln!("BROKEN_WRAPPER_PATCH={}", patch.replace('\n', "\\n"));
        assert!(
            patch.contains("*** Update File: src/router/virtual-router/bootstrap.ts"),
            "patch={}",
            patch.replace('\n', "\\n")
        );
        assert!(!patch.contains("/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.ts"));
        assert_eq!(output["input"][0]["_fixed_apply_patch"], Value::Bool(true));
    }

    #[test]
    fn salvages_broken_json_wrapper_with_cmd_and_workdir_fields() {
        let payload = json!({
          "input": [{
            "type": "function_call",
            "name": "apply_patch",
            "arguments": "{\"cmd\":\"apply_patch << 'PATCH'\n*** Begin Patch\n*** Update File: /Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.ts\n@@\n-old\n+new\n*** End Patch\nPATCH\",\"workdir\":\"/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core\",\"shell\":\"/bin/zsh\"}"
          }]
        });
        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        let args = output["input"][0]["arguments"].as_str().expect("arguments");
        let parsed: Value = serde_json::from_str(args).expect("parse normalized arguments");
        let patch = parsed["patch"].as_str().expect("patch");
        eprintln!("BROKEN_JSON_WRAPPER_PATCH={}", patch.replace('\n', "\\n"));
        assert!(
            patch.contains("*** Update File: src/router/virtual-router/bootstrap.ts"),
            "patch={}",
            patch.replace('\n', "\\n")
        );
        assert!(!patch.contains("/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.ts"));
        assert_eq!(output["input"][0]["_fixed_apply_patch"], Value::Bool(true));
    }

    #[test]
    fn does_not_guess_from_shell_wrapper_with_extra_commands() {
        let payload = json!({
          "messages": [{
            "role": "assistant",
            "tool_calls": [{
              "type": "function",
              "function": {
                "name": "apply_patch",
                "arguments": r#"bash -lc "echo hi && apply_patch <<'PATCH'
*** Begin Patch
*** Add File: src/nope.ts
+console.log('nope');
*** End Patch
PATCH""#
              }
            }]
          }]
        });
        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        assert_eq!(
            output["messages"][0]["tool_calls"][0]["function"]["arguments"],
            Value::String(String::from(r#"bash -lc "echo hi && apply_patch <<'PATCH'
*** Begin Patch
*** Add File: src/nope.ts
+console.log('nope');
*** End Patch
PATCH""#))
        );
        assert!(output["messages"][0]["tool_calls"][0]["_fixed_apply_patch"].is_null());
    }

    #[test]
    fn does_not_guess_from_direct_shell_style_apply_patch_with_extra_commands() {
        let payload = json!({
          "messages": [{
            "role": "assistant",
            "tool_calls": [{
              "type": "function",
              "function": {
                "name": "apply_patch",
                "arguments": r#"echo hi && apply_patch <<'PATCH'
*** Begin Patch
*** Add File: src/nope-direct.ts
+console.log('nope');
*** End Patch
PATCH"#
              }
            }]
          }]
        });
        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        assert_eq!(
            output["messages"][0]["tool_calls"][0]["function"]["arguments"],
            Value::String(String::from(r#"echo hi && apply_patch <<'PATCH'
*** Begin Patch
*** Add File: src/nope-direct.ts
+console.log('nope');
*** End Patch
PATCH"#))
        );
        assert!(output["messages"][0]["tool_calls"][0]["_fixed_apply_patch"].is_null());
    }

    #[test]
    fn normalizes_unified_add_diff_without_prefixing_hunk_header_inside_add_file() {
        let payload = json!({
          "input": [{
            "type": "function_call",
            "name": "apply_patch",
            "arguments": "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n"
          }]
        });
        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        let args = output["input"][0]["arguments"]
            .as_str()
            .expect("arguments string");
        let parsed: Value = serde_json::from_str(args).expect("parse normalized arguments");
        let patch = parsed["patch"].as_str().expect("patch");
        assert!(patch.contains("*** Add File: new.txt"));
        assert!(patch.contains("+hello"));
        assert!(patch.contains("+world"));
        assert!(!patch.contains("+@@ -0,0 +1,2 @@"));
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
    fn does_not_guess_add_file_patch_from_path_content_shape() {
        let payload = json!({
          "messages": [{
            "role": "assistant",
            "tool_calls": [{
              "type": "function",
              "function": {
                "name": "apply_patch",
                "arguments": {
                  "path": "hello.txt",
                  "content": "hello"
                }
              }
            }]
          }]
        });
        let raw = fix_apply_patch_tool_calls_json(payload.to_string()).expect("fix payload");
        let output: Value = serde_json::from_str(&raw).expect("parse output");
        assert_eq!(
            output["messages"][0]["tool_calls"][0]["function"]["arguments"],
            json!({
              "path": "hello.txt",
              "content": "hello"
            })
        );
        assert!(output["messages"][0]["tool_calls"][0]["_fixed_apply_patch"].is_null());
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
    fn converts_legacy_context_diff_hunks_inside_update_file_envelope() {
        let payload = json!({
          "messages": [{
            "role": "assistant",
            "tool_calls": [{
              "type": "function",
              "function": {
                "name": "apply_patch",
                "arguments": "*** Begin Patch\n*** Update File: src/runtime/context-ledger-memory.ts\n*** 880,283 ****\n   const DIGEST_VERBOSE_OUTPUT_TOOLS = new Set([\n     'update_plan',\n     'reasoning.stop',\n     'report-task-completion',\n   ]);\n--- 886,330 ----\n+ \n+ // Digest 只保留重要工具调用\n+ const DIGEST_IMPORTANT_TOOLS = new Set([\n+   'apply_patch',\n+ ]);\n*** End Patch"
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
        assert!(patch.contains("*** Update File: src/runtime/context-ledger-memory.ts"));
        assert!(patch.contains("@@"));
        assert!(patch.contains("+// Digest 只保留重要工具调用"));
        assert!(!patch.contains("*** 880,283 ****"));
        assert!(!patch.contains("--- 886,330 ----"));
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

    #[test]
    fn strips_file_prefix_from_update_header_paths() {
        let payload = json!({
          "messages": [{
            "role": "assistant",
            "tool_calls": [{
              "type": "function",
              "function": {
                "name": "apply_patch",
                "arguments": "*** Begin Patch\n*** Update File: File: src/orchestration/session-types.ts\n@@\n-x\n+y\n*** End Patch"
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
        assert!(patch.contains("*** Update File: src/orchestration/session-types.ts"));
        assert!(!patch.contains("*** Update File: File: src/orchestration/session-types.ts"));
    }

    #[test]
    fn converts_update_file_is_new_suffix_into_add_file() {
        let payload = json!({
          "messages": [{
            "role": "assistant",
            "tool_calls": [{
              "type": "function",
              "function": {
                "name": "apply_patch",
                "arguments": "*** Begin Patch\n*** Update File: File: tests/unit/runtime/track-metadata.test.ts is new\n+import { describe } from 'vitest';\n*** End Patch"
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
        assert!(patch.contains("*** Add File: tests/unit/runtime/track-metadata.test.ts"));
        assert!(!patch
            .contains("*** Update File: File: tests/unit/runtime/track-metadata.test.ts is new"));
    }
}
