pub(crate) fn normalize_tool_name(raw_name: &str) -> Option<String> {
    let trimmed = raw_name.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized_raw = if trimmed.to_ascii_lowercase().starts_with("functions.") {
        trimmed[10..].trim().to_string()
    } else {
        trimmed.to_string()
    };
    if normalized_raw.is_empty() {
        return None;
    }
    let alias_normalized = match normalized_raw.to_ascii_lowercase().as_str() {
        "execute_command" | "execute-command" | "shell_command" | "shell" | "bash" | "terminal" => {
            "exec_command".to_string()
        }
        _ => normalized_raw,
    };
    let canonical_name =
        crate::hub_resp_outbound_client_semantics::normalize_responses_function_name(Some(
            alias_normalized.as_str(),
        ))?;

    let canonical_lowered = canonical_name.to_ascii_lowercase();
    let canonical = canonical_lowered.as_str();
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
    );
    if known {
        return Some(canonical.to_string());
    }

    // Keep shape-only harvest generic: do not filter tool names here.
    // The model-declared tool list is the source of truth; this layer should only normalize shape.
    Some(canonical_name)
}
