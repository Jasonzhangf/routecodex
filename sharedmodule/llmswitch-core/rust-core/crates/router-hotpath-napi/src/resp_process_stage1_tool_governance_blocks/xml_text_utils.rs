use regex::Regex;

use crate::shared_tool_mapping::normalize_routecodex_tool_name;

pub(crate) fn decode_basic_xml_entities(raw: &str) -> String {
    raw.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

pub(crate) fn unwrap_xml_cdata_sections(raw: &str) -> String {
    if !raw.contains("<![CDATA[") {
        return raw.to_string();
    }

    let mut out = String::with_capacity(raw.len());
    let mut remaining = raw;
    loop {
        let Some(start) = remaining.find("<![CDATA[") else {
            out.push_str(remaining);
            break;
        };
        out.push_str(&remaining[..start]);
        let after_start = &remaining[start + "<![CDATA[".len()..];
        let Some(end) = after_start.find("]]>") else {
            out.push_str(after_start);
            break;
        };
        out.push_str(&after_start[..end]);
        remaining = &after_start[end + "]]>".len()..];
    }
    out
}

pub(crate) fn is_supported_xml_named_tool_name(raw_name: &str) -> bool {
    matches!(
        raw_name,
        "exec_command"
            | "execute_command"
            | "shell_command"
            | "shell"
            | "bash"
            | "terminal"
            | "write_stdin"
            | "apply_patch"
            | "update_plan"
            | "request_user_input"
            | "spawn_agent"
            | "send_input"
            | "resume_agent"
            | "wait_agent"
            | "close_agent"
            | "view_image"
            | "list_mcp_resources"
            | "read_mcp_resource"
            | "list_mcp_resource_templates"
            | "list_directory"
    )
}

pub(crate) fn is_generic_xml_wrapper_tag(raw_name: &str) -> bool {
    matches!(
        raw_name,
        "command"
            | "commands"
            | "cmd"
            | "tool"
            | "tools"
            | "call"
            | "calls"
            | "invoke"
            | "invocation"
            | "action"
            | "actions"
            | "operation"
            | "operations"
            | "step"
            | "steps"
            | "execute"
            | "execution"
    )
}

pub(crate) fn looks_like_exec_command_wrapper_name(raw_name: &str) -> bool {
    let normalized = raw_name.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return false;
    }
    is_generic_xml_wrapper_tag(normalized.as_str())
        || normalized == "exec"
        || normalized == "shell"
        || normalized == "bash"
        || normalized == "terminal"
        || normalized == "run"
        || normalized.contains("command")
        || normalized.contains("shell")
        || normalized.contains("bash")
        || normalized.contains("terminal")
        || normalized.contains("exec")
}

pub(crate) fn looks_like_apply_patch_wrapper_name(raw_name: &str) -> bool {
    let normalized = raw_name.trim().to_ascii_lowercase();
    !normalized.is_empty()
        && (normalized == "patch"
            || normalized == "diff"
            || normalized.contains("patch")
            || normalized.contains("diff"))
}

pub(crate) fn is_xml_named_tool_container_tag(raw_name: &str) -> bool {
    matches!(raw_name, "tool_calls")
}

pub(crate) fn should_attempt_xml_wrapper_harvest(raw_name: &str) -> bool {
    is_supported_xml_named_tool_name(raw_name)
        || is_generic_xml_wrapper_tag(raw_name)
        || looks_like_exec_command_wrapper_name(raw_name)
        || looks_like_apply_patch_wrapper_name(raw_name)
}

pub(crate) fn resolve_xml_wrapper_tool_name(raw_name: &str) -> Option<String> {
    let normalized = raw_name.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }
    if is_supported_xml_named_tool_name(normalized.as_str()) {
        return normalize_routecodex_tool_name(Some(raw_name));
    }
    if looks_like_apply_patch_wrapper_name(normalized.as_str()) {
        return Some("apply_patch".to_string());
    }
    if looks_like_exec_command_wrapper_name(normalized.as_str()) {
        return Some("exec_command".to_string());
    }
    None
}

pub(crate) fn normalize_preserved_text_whitespace(raw: &str) -> String {
    let normalized = raw.replace("\r\n", "\n");
    let mut lines: Vec<String> = Vec::new();
    let mut previous_blank = false;
    for line in normalized.lines() {
        let collapsed = line.split_whitespace().collect::<Vec<&str>>().join(" ");
        if collapsed.is_empty() {
            if !previous_blank && !lines.is_empty() {
                lines.push(String::new());
            }
            previous_blank = true;
            continue;
        }
        lines.push(collapsed);
        previous_blank = false;
    }
    lines.join("\n").trim().to_string()
}

pub(crate) fn strip_xml_tags_preserve_text(raw: &str) -> String {
    let Ok(tag_pattern) = Regex::new(r"(?is)</?[A-Za-z_][A-Za-z0-9_.-]*>") else {
        return raw.trim().to_string();
    };
    let decoded = decode_basic_xml_entities(raw);
    let text = tag_pattern.replace_all(decoded.as_str(), " ").to_string();
    normalize_preserved_text_whitespace(text.as_str())
}

pub(crate) fn canonicalize_xml_named_tool_arg_key(raw_key: &str, tool_name: &str) -> String {
    let normalized = raw_key
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .replace('.', "_");
    match normalized.as_str() {
        "cmd" if tool_name == "exec_command" => "cmd".to_string(),
        "commandline" | "command_line" => "command".to_string(),
        "work_dir" | "workspace" => "workdir".to_string(),
        "sessionid" => "session_id".to_string(),
        "yieldtimems" => "yield_time_ms".to_string(),
        "maxoutputtokens" => "max_output_tokens".to_string(),
        "diff" if tool_name == "apply_patch" => "patch".to_string(),
        _ if tool_name == "exec_command"
            && looks_like_exec_command_wrapper_name(normalized.as_str()) =>
        {
            "command".to_string()
        }
        _ if tool_name == "apply_patch"
            && looks_like_apply_patch_wrapper_name(normalized.as_str()) =>
        {
            "patch".to_string()
        }
        _ => normalized,
    }
}

pub(crate) fn parse_xml_tag_attributes(raw_tag: &str) -> Vec<(String, String)> {
    let Ok(attr_pattern) =
        Regex::new(r#"([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))"#)
    else {
        return Vec::new();
    };
    attr_pattern
        .captures_iter(raw_tag)
        .filter_map(|caps| {
            let key = caps.get(1)?.as_str().trim().to_ascii_lowercase();
            if key.is_empty() {
                return None;
            }
            let value = caps
                .get(2)
                .or_else(|| caps.get(3))
                .or_else(|| caps.get(4))
                .map(|m| decode_basic_xml_entities(m.as_str()).trim().to_string())
                .unwrap_or_default();
            Some((key, value))
        })
        .collect()
}

pub(crate) fn normalize_dsml_tool_markup(raw: &str) -> String {
    // Normalize fullwidth pipe chars (U+FF5C, U+258F, U+2590) to ASCII pipe
    let raw: String = raw
        .chars()
        .map(|c| match c {
            '\u{ff5c}' | '\u{258f}' | '\u{2590}' => '|',
            c => c,
        })
        .collect();
    let mut normalized = raw;
    let replacements = [
        (
            r#"(?is)<\s*\|?\s*dsml\s*\|\s*tool_calls\s*>"#,
            "<tool_calls>",
        ),
        (
            r#"(?is)</\s*\|?\s*dsml\s*\|\s*tool_calls\s*>"#,
            "</tool_calls>",
        ),
        (r#"(?is)<\s*\|?\s*dsml\s*\|\s*invoke\b"#, "<invoke"),
        (r#"(?is)</\s*\|?\s*dsml\s*\|\s*invoke\s*>"#, "</invoke>"),
        (r#"(?is)<\s*\|?\s*dsml\s*\|\s*parameter\b"#, "<parameter"),
        (
            r#"(?is)</\s*\|?\s*dsml\s*\|\s*parameter\s*>"#,
            "</parameter>",
        ),
    ];
    for (pattern, target) in replacements {
        if let Ok(re) = Regex::new(pattern) {
            normalized = re.replace_all(normalized.as_str(), target).to_string();
        }
    }
    normalized
}

pub(crate) fn read_xml_tag_attribute<'a>(attrs: &'a [(String, String)], keys: &[&str]) -> Option<&'a str> {
    for key in keys {
        if let Some((_, value)) = attrs.iter().find(|(name, _)| name == key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    None
}

pub(crate) fn resolve_xml_wrapper_tool_name_from_attrs(
    raw_tool_name: &str,
    attrs: &[(String, String)],
) -> Option<String> {
    let attr_tool_name =
        read_xml_tag_attribute(attrs, &["name", "tool", "tool_name", "call", "action"]);
    if let Some(candidate) = attr_tool_name {
        if let Some(canonical) = normalize_routecodex_tool_name(Some(candidate)) {
            return Some(canonical);
        }
    }
    resolve_xml_wrapper_tool_name(raw_tool_name)
}

pub(crate) fn resolve_xml_named_child_arg_key(
    raw_key: &str,
    attrs: &[(String, String)],
    tool_name: &str,
) -> String {
    let normalized = raw_key.trim().to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "parameter" | "param" | "arg" | "argument" | "field" | "property" | "item" | "value"
    ) {
        if let Some(attr_name) =
            read_xml_tag_attribute(attrs, &["name", "key", "field", "property"])
        {
            return canonicalize_xml_named_tool_arg_key(attr_name, tool_name);
        }
    }
    canonicalize_xml_named_tool_arg_key(raw_key, tool_name)
}
