use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::resp_process_stage1_tool_governance_blocks::apply_patch_guard::{
    apply_patch_error_message, detect_apply_patch_authoring_invalid_reason,
};
use crate::resp_process_stage1_tool_governance_blocks::apply_patch_schema_args::{
    detect_apply_patch_invalid_reason, detect_hashline_apply_patch_guard_reason,
    detect_structured_apply_patch_invalid_reason, looks_like_unparseable_apply_patch_json_args,
    normalize_apply_patch_schema_args,
};
use crate::resp_process_stage1_tool_governance_blocks::apply_patch_text::extract_apply_patch_text;
use crate::resp_process_stage1_tool_governance_blocks::json_args::parse_json_record;

pub(crate) fn collect_tool_names_from_candidate(candidate: &Value) -> Vec<String> {
    let arr = match candidate {
        Value::Array(a) => a,
        _ => return Vec::new(),
    };

    arr.iter().filter_map(read_tool_name).collect()
}

pub(crate) fn resolve_requested_tool_names(input: &Value) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    if let Some(Value::Object(sem)) = input.get("requestSemantics") {
        if let Some(tools) = sem.get("tools") {
            collect_unique_tool_names(tools, &mut names, &mut seen);
        }
        if let Some(Value::Object(t)) = sem.get("tools") {
            if let Some(v) = t.get("clientToolsRaw") {
                collect_unique_tool_names(v, &mut names, &mut seen);
            }
            if let Some(v) = t.get("baselineTools") {
                collect_unique_tool_names(v, &mut names, &mut seen);
            }
        }
    }
    if let Some(Value::Object(ac)) = input.get("adapterContext") {
        if let Some(Value::Object(cr)) = ac.get("capturedChatRequest") {
            if let Some(tools) = cr.get("tools") {
                collect_unique_tool_names(tools, &mut names, &mut seen);
            }
        }
    }

    names
}

pub(crate) fn normalize_apply_patch_arguments(input: &Value) -> Value {
    let raw_args = input.get("arguments");
    let normalized = normalize_apply_patch_schema_args(raw_args);
    let mut out = Map::new();
    out.insert(
        "normalizedArguments".to_string(),
        Value::String(normalized.0.clone()),
    );
    out.insert("repaired".to_string(), Value::Bool(normalized.1));
    Value::Object(out)
}

pub(crate) fn validate_apply_patch_arguments(input: &Value) -> Value {
    let raw_args = input.get("arguments");
    let raw_args_invalid_json = looks_like_unparseable_apply_patch_json_args(raw_args);
    let parsed_args = parse_json_record(raw_args).unwrap_or_default();
    let raw_source = parsed_args
        .get("patch")
        .or_else(|| parsed_args.get("input"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .or_else(|| {
            extract_apply_patch_text(raw_args)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_default();
    let normalized = normalize_apply_patch_schema_args(raw_args);
    let normalized_args_value: Value =
        serde_json::from_str(&normalized.0).unwrap_or_else(|_| Value::Object(Map::new()));
    let patch = normalized_args_value
        .as_object()
        .and_then(|row| row.get("patch"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let invalid_reason =
        if let Some(hashline_reason) = detect_hashline_apply_patch_guard_reason(raw_args) {
            Some(hashline_reason)
        } else if raw_args_invalid_json {
            Some("invalid_json")
        } else if matches!(raw_args, Some(Value::Object(obj)) if obj.is_empty()) {
            Some("invalid_json")
        } else if matches!(raw_args, Some(Value::Object(_))) {
            detect_structured_apply_patch_invalid_reason(&parsed_args)
        } else if normalized.1 {
            detect_apply_patch_invalid_reason(patch.as_str())
        } else {
            detect_apply_patch_authoring_invalid_reason(raw_source.as_str())
                .or_else(|| detect_apply_patch_invalid_reason(patch.as_str()))
        };

    let mut out = Map::new();
    out.insert("ok".to_string(), Value::Bool(invalid_reason.is_none()));
    out.insert(
        "normalizedArguments".to_string(),
        Value::String(normalized.0.clone()),
    );
    out.insert("repaired".to_string(), Value::Bool(normalized.1));
    if let Some(reason) = invalid_reason {
        out.insert("reason".to_string(), Value::String(reason.to_string()));
        out.insert(
            "message".to_string(),
            Value::String(apply_patch_error_message(reason).to_string()),
        );
    }
    Value::Object(out)
}

fn collect_unique_tool_names(
    candidate: &Value,
    names: &mut Vec<String>,
    seen: &mut HashSet<String>,
) {
    for name in collect_tool_names_from_candidate(candidate) {
        if seen.insert(name.clone()) {
            names.push(name);
        }
    }
}

fn read_tool_name(item: &Value) -> Option<String> {
    match item {
        Value::String(s) => read_non_empty_trimmed(s),
        Value::Object(m) => {
            if let Some(Value::Object(func)) = m.get("function") {
                func.get("name")
                    .and_then(Value::as_str)
                    .and_then(read_non_empty_trimmed)
            } else {
                m.get("name")
                    .and_then(Value::as_str)
                    .and_then(read_non_empty_trimmed)
            }
        }
        _ => None,
    }
}

fn read_non_empty_trimmed(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}
