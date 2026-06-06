use serde_json::{Map, Value};

pub(crate) fn build_apply_patch_guard_patch(reason: &str, message: &str) -> String {
    let reason_slug: String = reason
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let safe_reason = if reason_slug.trim().is_empty() {
        "unknown".to_string()
    } else {
        reason_slug
    };
    let safe_message = message
        .replace('\\', "\\\\")
        .replace('\r', " ")
        .replace('\n', " ")
        .trim()
        .chars()
        .take(240)
        .collect::<String>();
    format!(
        "*** Begin Patch\n*** Update File: __APPLY_PATCH_ERROR__/{}.txt\n@@\n-guard\n+APPLY_PATCH_ERROR: {}\n*** End Patch",
        safe_reason,
        if safe_message.is_empty() {
            "invalid apply_patch schema or patch grammar"
        } else {
            safe_message.as_str()
        }
    )
}

pub(crate) fn apply_patch_error_message(reason: &str) -> &'static str {
    match reason {
        "missing_patch" => "apply_patch requires schema arguments with patch as a string.",
        "empty_patch" => "apply_patch patch must be non-empty.",
        "conflict_markers" => "Conflict markers are not allowed in apply_patch patches; remove <<<<<<<, =======, and >>>>>>> blocks.",
        "mixed_gnu_diff" => "GNU diff headers are not valid apply_patch input; use the *** Begin Patch grammar with file markers.",
        "unsupported_patch_format" => "apply_patch shape was not directly executable. Keep the same edit intent and resend one raw patch string in canonical *** Begin Patch / *** End Patch grammar. Put workspace-relative paths inside patch headers such as *** Update File: src/main.ts or *** Add File: tmp/example.txt. Do not use absolute paths.",
        "empty_add_file_block" => "Add File requires + content lines. Use + for every created file line.",
        "empty_update_hunk" => "Update File requires a non-empty @@ hunk with context and/or +/- lines.",
        _ => "Invalid apply_patch schema or patch grammar.",
    }
}

pub(crate) fn detect_apply_patch_authoring_invalid_reason(raw: &str) -> Option<&'static str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some("empty_patch");
    }
    if trimmed.contains("<<<<<<<") || trimmed.contains("=======") || trimmed.contains(">>>>>>>") {
        return Some("conflict_markers");
    }
    if trimmed.lines().any(|line| {
        let line = line.trim_start();
        line.starts_with("diff --git ") || line.starts_with("--- ") || line.starts_with("+++ ")
    }) {
        return Some("mixed_gnu_diff");
    }
    if !(trimmed.starts_with("*** Begin Patch") && trimmed.contains("*** End Patch")) {
        return Some("unsupported_patch_format");
    }

    let lines: Vec<&str> = trimmed.lines().collect();
    let mut idx: usize = 0;
    while idx < lines.len() {
        let line = lines[idx].trim_end();
        if line.starts_with("*** Add File:") {
            let mut saw_plus = false;
            idx += 1;
            while idx < lines.len() {
                let body = lines[idx];
                if body.starts_with("*** ") {
                    break;
                }
                if body.starts_with('+') && !body.starts_with("+++") {
                    saw_plus = true;
                } else if !body.trim().is_empty() {
                    return Some("empty_add_file_block");
                }
                idx += 1;
            }
            if !saw_plus {
                return Some("empty_add_file_block");
            }
            continue;
        }
        if line.starts_with("*** Update File:") {
            let mut saw_hunk = false;
            let mut current_hunk_has_body = false;
            idx += 1;
            while idx < lines.len() {
                let body = lines[idx];
                if body.starts_with("*** ") {
                    break;
                }
                if body.starts_with("@@") {
                    if saw_hunk && !current_hunk_has_body {
                        return Some("empty_update_hunk");
                    }
                    saw_hunk = true;
                    current_hunk_has_body = false;
                } else if saw_hunk {
                    if body.starts_with(' ') || body.starts_with('+') || body.starts_with('-') {
                        current_hunk_has_body = true;
                    } else if !body.trim().is_empty() {
                        return Some("empty_update_hunk");
                    }
                }
                idx += 1;
            }
            if !saw_hunk || !current_hunk_has_body {
                return Some("empty_update_hunk");
            }
            continue;
        }
        idx += 1;
    }

    None
}

pub(crate) fn make_apply_patch_guard_args(reason: &str) -> String {
    let patch = build_apply_patch_guard_patch(reason, apply_patch_error_message(reason));
    let mut out = Map::new();
    out.insert("patch".to_string(), Value::String(patch));
    serde_json::to_string(&Value::Object(out)).unwrap_or_else(|_| {
        "{\"patch\":\"*** Begin Patch\\n*** Update File: __APPLY_PATCH_ERROR__/unknown.txt\\n@@\\n-guard\\n+APPLY_PATCH_ERROR: invalid apply_patch schema or patch grammar\\n*** End Patch\"}".to_string()
    })
}
