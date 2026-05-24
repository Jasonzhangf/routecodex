use serde_json::{Map, Value};

pub(crate) fn as_object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

pub(crate) fn normalize_record(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(row) => row,
        _ => Map::new(),
    }
}

pub(crate) fn normalize_record_ref(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(row) => row.clone(),
        _ => Map::new(),
    }
}

pub(crate) fn value_as_object_or_empty(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

pub(crate) fn clone_plain_object(value: Option<&Value>) -> Option<Map<String, Value>> {
    value?.as_object().cloned()
}

pub(crate) fn clone_non_empty_object(value: Option<&Value>) -> Option<Map<String, Value>> {
    let record = clone_plain_object(value)?;
    if record.is_empty() {
        return None;
    }
    Some(record)
}

pub(crate) fn parse_json_bool(raw: &str) -> Option<bool> {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Bool(v)) => Some(v),
        _ => None,
    }
}

pub(crate) fn parse_js_number_like(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(num)) => num.as_f64(),
        Some(Value::String(raw)) => raw.trim().parse::<f64>().ok(),
        _ => None,
    }
}

pub(crate) fn read_optional_bool(value: Option<&Value>) -> Option<bool> {
    value.and_then(Value::as_bool)
}

pub(crate) fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if raw.is_empty() {
        return None;
    }
    Some(raw)
}

pub(crate) fn read_object_trimmed_string(
    object: &Map<String, Value>,
    key: &str,
) -> Option<String> {
    read_trimmed_string(object.get(key))
}

pub(crate) fn read_first_object_trimmed_string(
    object: &Map<String, Value>,
    keys: &[&str],
) -> Option<String> {
    keys.iter()
        .find_map(|key| read_object_trimmed_string(object, key))
}

pub(crate) fn read_string_array_command(value: Option<&Value>) -> Option<String> {
    let parts = value.and_then(|v| v.as_array())?;
    let tokens: Vec<String> = parts
        .iter()
        .map(|item| match item {
            Value::String(v) => v.trim().to_string(),
            Value::Null => String::new(),
            other => other.to_string().trim().to_string(),
        })
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.is_empty() {
        return None;
    }
    Some(tokens.join(" "))
}

pub(crate) fn read_workdir_from_args(args: &Map<String, Value>) -> Option<String> {
    let input = args.get("input").and_then(Value::as_object);
    read_trimmed_string(args.get("workdir"))
        .or_else(|| read_trimmed_string(args.get("cwd")))
        .or_else(|| read_trimmed_string(args.get("workDir")))
        .or_else(|| input.and_then(|row| read_trimmed_string(row.get("workdir"))))
        .or_else(|| input.and_then(|row| read_trimmed_string(row.get("cwd"))))
}

pub(crate) fn split_command_string(input: &str) -> Vec<String> {
    let s = input.trim();
    if s.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        let ch = chars[i];
        if in_single {
            if ch == '\'' {
                in_single = false;
            } else {
                cur.push(ch);
            }
            i += 1;
            continue;
        }
        if in_double {
            if ch == '"' {
                in_double = false;
                i += 1;
                continue;
            }
            if ch == '\\' && i + 1 < chars.len() {
                i += 1;
                cur.push(chars[i]);
                i += 1;
                continue;
            }
            cur.push(ch);
            i += 1;
            continue;
        }
        if ch == '\'' {
            in_single = true;
            i += 1;
            continue;
        }
        if ch == '"' {
            in_double = true;
            i += 1;
            continue;
        }
        if ch.is_ascii_whitespace() {
            if !cur.is_empty() {
                out.push(cur.clone());
                cur.clear();
            }
            i += 1;
            continue;
        }
        cur.push(ch);
        i += 1;
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

pub(crate) fn extract_balanced_json_candidate_at(
    text: &str,
    start_byte: usize,
    open: char,
    close: char,
) -> Option<(usize, String)> {
    if start_byte >= text.len() {
        return None;
    }
    let first = text[start_byte..].chars().next()?;
    if first != open {
        return None;
    }
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escaped = false;
    let mut end_byte: Option<usize> = None;
    for (offset, ch) in text[start_byte..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            continue;
        }
        if ch == open {
            depth += 1;
        } else if ch == close {
            depth -= 1;
            if depth == 0 {
                end_byte = Some(start_byte + offset + ch.len_utf8());
                break;
            }
        }
    }
    let end = end_byte?;
    Some((end, text[start_byte..end].to_string()))
}

pub(crate) fn extract_balanced_json_object_at(
    text: &str,
    start_byte: usize,
) -> Option<(usize, String)> {
    extract_balanced_json_candidate_at(text, start_byte, '{', '}')
}

pub(crate) fn extract_balanced_json_array_at(
    text: &str,
    start_byte: usize,
) -> Option<(usize, String)> {
    extract_balanced_json_candidate_at(text, start_byte, '[', ']')
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::{
        as_object, extract_balanced_json_array_at, extract_balanced_json_candidate_at,
        extract_balanced_json_object_at, normalize_record, normalize_record_ref,
        parse_js_number_like, parse_json_bool, read_first_object_trimmed_string, read_object_trimmed_string,
        read_string_array_command, read_trimmed_string, read_workdir_from_args,
        split_command_string, value_as_object_or_empty,
    };
    use serde_json::json;

    fn crate_src_path(relative: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join(relative)
    }

    #[test]
    fn read_trimmed_string_returns_trimmed_non_empty_string() {
        let value = json!("  hello  ");
        assert_eq!(read_trimmed_string(Some(&value)), Some("hello".to_string()));
    }

    #[test]
    fn read_trimmed_string_rejects_empty_or_non_string_values() {
        let empty = json!("   ");
        let number = json!(123);
        assert_eq!(read_trimmed_string(Some(&empty)), None);
        assert_eq!(read_trimmed_string(Some(&number)), None);
        assert_eq!(read_trimmed_string(None), None);
    }

    #[test]
    fn read_object_trimmed_string_reads_non_empty_string_field() {
        let object = json!({"field": "  value  "});
        let row = object.as_object().unwrap();
        assert_eq!(
            read_object_trimmed_string(row, "field"),
            Some("value".to_string())
        );
    }

    #[test]
    fn read_object_trimmed_string_rejects_missing_or_empty_field() {
        let object = json!({"field": "   "});
        let row = object.as_object().unwrap();
        assert_eq!(read_object_trimmed_string(row, "field"), None);
        assert_eq!(read_object_trimmed_string(row, "missing"), None);
    }

    #[test]
    fn read_first_object_trimmed_string_respects_priority_order() {
        let object = json!({"tool_call_id": " ", "call_id": " call-2 ", "id": " id-3 "});
        let row = object.as_object().unwrap();
        assert_eq!(
            read_first_object_trimmed_string(row, &["tool_call_id", "call_id", "id"]),
            Some("call-2".to_string())
        );
        assert_eq!(
            read_first_object_trimmed_string(row, &["missing", "id"]),
            Some("id-3".to_string())
        );
        assert_eq!(read_first_object_trimmed_string(row, &["missing"]), None);
    }

    #[test]
    fn object_helpers_keep_only_json_objects() {
        let object = json!({"a": 1});
        let array = json!([1]);
        assert!(as_object(&object).is_some());
        assert!(as_object(&array).is_none());
        assert_eq!(normalize_record(object.clone()).get("a"), Some(&json!(1)));
        assert_eq!(normalize_record(array.clone()).len(), 0);
        assert_eq!(normalize_record_ref(&object).get("a"), Some(&json!(1)));
        assert_eq!(normalize_record_ref(&array).len(), 0);
        assert_eq!(value_as_object_or_empty(&object).get("a"), Some(&json!(1)));
        assert_eq!(value_as_object_or_empty(&array).len(), 0);
    }

    #[test]
    fn parse_json_bool_accepts_only_json_boolean_literals() {
        assert_eq!(parse_json_bool("true"), Some(true));
        assert_eq!(parse_json_bool("false"), Some(false));
        assert_eq!(parse_json_bool("\"true\""), None);
        assert_eq!(parse_json_bool("not-json"), None);
    }

    #[test]
    fn parse_js_number_like_accepts_numbers_and_numeric_strings() {
        let number = json!(12.5);
        let string = json!(" 7 ");
        let invalid = json!("x");
        assert_eq!(parse_js_number_like(Some(&number)), Some(12.5));
        assert_eq!(parse_js_number_like(Some(&string)), Some(7.0));
        assert_eq!(parse_js_number_like(Some(&invalid)), None);
        assert_eq!(parse_js_number_like(None), None);
    }

    #[test]
    fn read_string_array_command_joins_non_empty_tokens() {
        let value = json!(["  echo ", null, " hi  ", 123]);
        assert_eq!(
            read_string_array_command(Some(&value)),
            Some("echo hi 123".to_string())
        );
    }

    #[test]
    fn read_string_array_command_rejects_empty_arrays() {
        let value = json!([" ", null, ""]);
        assert_eq!(read_string_array_command(Some(&value)), None);
        assert_eq!(read_string_array_command(None), None);
    }

    #[test]
    fn read_workdir_from_args_prefers_direct_then_nested_fields() {
        let direct = json!({
            "workdir": " /tmp/direct ",
            "input": { "workdir": "/tmp/nested" }
        });
        assert_eq!(
            read_workdir_from_args(direct.as_object().unwrap()),
            Some("/tmp/direct".to_string())
        );

        let nested = json!({
            "input": { "cwd": " /tmp/nested " }
        });
        assert_eq!(
            read_workdir_from_args(nested.as_object().unwrap()),
            Some("/tmp/nested".to_string())
        );
    }

    #[test]
    fn read_workdir_from_args_rejects_empty_values() {
        let value = json!({
            "workdir": " ",
            "input": { "cwd": "   " }
        });
        assert_eq!(read_workdir_from_args(value.as_object().unwrap()), None);
    }

    #[test]
    fn balanced_json_object_scanner_handles_nested_quotes() {
        let text = r#"xx {"a":{"b":"}\""}} yy"#;
        let (end, value) = extract_balanced_json_object_at(text, 3).expect("object");
        assert_eq!(value, r#"{"a":{"b":"}\""}}"#);
        assert_eq!(&text[3..end], value);
    }

    #[test]
    fn balanced_json_array_scanner_handles_nested_objects() {
        let text = r#"zz [{"a":[1,{"b":"x"}]}] tt"#;
        let (end, value) = extract_balanced_json_array_at(text, 3).expect("array");
        assert_eq!(value, r#"[{"a":[1,{"b":"x"}]}]"#);
        assert_eq!(&text[3..end], value);
    }

    #[test]
    fn balanced_json_candidate_rejects_wrong_opener() {
        let text = r#"{"a":1}"#;
        assert!(extract_balanced_json_candidate_at(text, 0, '[', ']').is_none());
    }

    #[test]
    fn split_command_string_preserves_quoted_segments() {
        assert_eq!(
            split_command_string(r#"bash -lc "echo \"a b\"""#),
            vec!["bash", "-lc", r#"echo "a b""#]
        );
        assert_eq!(
            split_command_string("node -e 'console.log(1)'"),
            vec!["node", "-e", "console.log(1)"]
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_local_clones_from_selected_modules() {
        for relative in [
            "shared_responses_response_utils.rs",
            "hub_req_outbound_context_merge.rs",
            "hub_req_inbound_tool_output_snapshot.rs",
            "virtual_router_stop_message_state_codec.rs",
            "virtual_router_engine/routing/metadata.rs",
            "hub_pipeline_target_utils.rs",
            "chat_governance_context.rs",
            "hub_submit_tool_outputs.rs",
            "hub_req_inbound_semantic_lift.rs",
        ] {
            let path = crate_src_path(relative);
            let source = fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
            assert!(
                !source.contains("fn read_trimmed_string("),
                "local read_trimmed_string clone still present in {}",
                path.display()
            );
        }
    }

    #[test]
    fn shared_read_object_trimmed_string_deletion_gate_removed_local_map_key_clone() {
        let path = crate_src_path("req_process_stage2_route_select.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_string(map: &Map<String, Value>, key: &str)"),
            "local map-key read_trimmed_string clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("read_object_trimmed_string("),
            "req_process_stage2_route_select.rs must use shared read_object_trimmed_string"
        );
    }

    #[test]
    fn shared_read_object_trimmed_string_deletion_gate_removed_zero_logic_wrapper() {
        let path = crate_src_path("hub_req_inbound_semantic_lift.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_object_string("),
            "zero-logic trimmed object string wrapper still present in {}",
            path.display()
        );
    }

    #[test]
    fn shared_balanced_json_scanners_deletion_gate_removed_tool_call_entry_wrappers() {
        let path = crate_src_path("resp_process_stage1_tool_governance_blocks/tool_call_entry.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("pub(crate) fn extract_balanced_json_object_at("),
            "zero-logic object scanner wrapper still present in {}",
            path.display()
        );
        assert!(
            !source.contains("pub(crate) fn extract_balanced_json_array_at("),
            "zero-logic array scanner wrapper still present in {}",
            path.display()
        );
    }

    #[test]
    fn shared_split_command_deletion_gate_removed_tool_harvester_local_clone() {
        let path = crate_src_path("tool_harvester.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn split_command(input: &str) -> Vec<String>"),
            "local split_command clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("split_command_string("),
            "tool_harvester.rs must use shared split_command_string truth"
        );
    }

    #[test]
    fn shared_object_helpers_deletion_gate_removed_history_local_clones() {
        let path = crate_src_path("hub_bridge_actions/history.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_non_empty_string(value: Option<&Value>) -> Option<String>"),
            "local read_trimmed_non_empty_string clone still present in {}",
            path.display()
        );
        assert!(
            !source.contains("fn clone_non_empty_object(value: Option<&Value>) -> Option<Map<String, Value>>"),
            "local clone_non_empty_object clone still present in {}",
            path.display()
        );
        assert!(
            !source.contains("fn read_optional_bool(value: Option<&Value>) -> Option<bool>"),
            "local read_optional_bool clone still present in {}",
            path.display()
        );
        assert!(
            !source.contains("fn clone_plain_object(value: Option<&Value>) -> Option<Map<String, Value>>"),
            "local clone_plain_object clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("read_trimmed_string(")
                && source.contains("clone_non_empty_object(")
                && source.contains("read_optional_bool(")
                && source.contains("clone_plain_object("),
            "hub_bridge_actions/history.rs must use shared JSON object helper truth"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_compat_harvest_local_clone() {
        let path = crate_src_path("compat_harvest_tool_calls_from_text.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_non_empty_string(value: Option<&Value>) -> Option<String>"),
            "local read_trimmed_non_empty_string clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("read_trimmed_string("),
            "compat_harvest_tool_calls_from_text.rs must use shared read_trimmed_string truth"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_virtual_router_stop_message_actions_local_clone() {
        let path = crate_src_path("virtual_router_stop_message_actions.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_string(value: Option<&Value>) -> Option<String>"),
            "local read_trimmed_string clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("read_trimmed_string("),
            "virtual_router_stop_message_actions.rs must use shared read_trimmed_string truth"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_anthropic_codec_local_clone() {
        let path = crate_src_path("anthropic_openai_codec.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_string(value: Option<&Value>) -> Option<String>"),
            "local read_trimmed_string clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("shared_json_utils::read_trimmed_string")
                || source.contains("use crate::shared_json_utils::read_trimmed_string"),
            "anthropic_openai_codec.rs must use shared read_trimmed_string truth"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_hub_req_inbound_context_capture_local_clone() {
        let path = crate_src_path("hub_req_inbound_context_capture.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_string(value: Option<&Value>) -> Option<String>"),
            "local read_trimmed_string clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("shared_json_utils::read_trimmed_string")
                || source.contains("use crate::shared_json_utils::read_trimmed_string"),
            "hub_req_inbound_context_capture.rs must use shared read_trimmed_string truth"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_gemini_codec_local_clone() {
        let path = crate_src_path("gemini_openai_codec.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_string(value: Option<&Value>) -> Option<String>"),
            "local read_trimmed_string clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("shared_json_utils::read_trimmed_string")
                || source.contains("use crate::shared_json_utils::read_trimmed_string"),
            "gemini_openai_codec.rs must use shared read_trimmed_string truth"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_resp_process_stage2_finalize_local_clone() {
        let path = crate_src_path("resp_process_stage2_finalize.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_string(value: Option<&Value>) -> Option<String>"),
            "local read_trimmed_string clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("shared_json_utils::read_trimmed_string")
                || source.contains("use crate::shared_json_utils::read_trimmed_string"),
            "resp_process_stage2_finalize.rs must use shared read_trimmed_string truth"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_hub_tool_session_compat_local_clone() {
        let path = crate_src_path("hub_tool_session_compat.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_string(value: Option<&Value>) -> Option<String>"),
            "local read_trimmed_string clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("shared_json_utils::read_trimmed_string")
                || source.contains("use crate::shared_json_utils::read_trimmed_string"),
            "hub_tool_session_compat.rs must use shared read_trimmed_string truth"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_hub_bridge_actions_utils_local_wrapper() {
        let path = crate_src_path("hub_bridge_actions/utils.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("pub(crate) fn read_trimmed_string(value: Option<&Value>) -> Option<String>"),
            "local read_trimmed_string wrapper still present in {}",
            path.display()
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_qwen_tool_definitions_local_clone() {
        let path = crate_src_path("req_outbound_stage3_compat/qwen/tool_definitions.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_string(value: Option<&Value>) -> Option<String>"),
            "local read_trimmed_string clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("shared_json_utils::read_trimmed_string")
                || source.contains("use crate::shared_json_utils::read_trimmed_string"),
            "qwen/tool_definitions.rs must use shared read_trimmed_string truth"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_tool_text_request_guidance_local_clone() {
        let path = crate_src_path("req_outbound_stage3_compat/tool_text_request_guidance.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_string(value: Option<&Value>) -> Option<String>"),
            "local read_trimmed_string clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("shared_json_utils::read_trimmed_string")
                || source.contains("use crate::shared_json_utils::read_trimmed_string"),
            "tool_text_request_guidance.rs must use shared read_trimmed_string truth"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_glm_request_local_clone() {
        let path = crate_src_path("req_outbound_stage3_compat/glm/request.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_string(value: Option<&Value>) -> Option<String>"),
            "local read_trimmed_string clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("shared_json_utils::read_trimmed_string")
                || source.contains("use crate::shared_json_utils::read_trimmed_string"),
            "glm/request.rs must use shared read_trimmed_string truth"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_thinking_history_local_clone() {
        let path = crate_src_path("req_outbound_stage3_compat/thinking_history.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_string(value: Option<&Value>) -> Option<String>"),
            "local read_trimmed_string clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("shared_json_utils::read_trimmed_string")
                || source.contains("use crate::shared_json_utils::read_trimmed_string"),
            "thinking_history.rs must use shared read_trimmed_string truth"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_deepseek_web_local_clone() {
        let path = crate_src_path("req_outbound_stage3_compat/deepseek_web.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_string(value: Option<&Value>) -> Option<String>"),
            "local read_trimmed_string clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("shared_json_utils::read_trimmed_string")
                || source.contains("use crate::shared_json_utils::read_trimmed_string"),
            "deepseek_web.rs must use shared read_trimmed_string truth"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_gemini_request_local_clone() {
        let path = crate_src_path("req_outbound_stage3_compat/gemini/request.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_string(value: Option<&Value>) -> Option<String>"),
            "local read_trimmed_string clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("shared_json_utils::read_trimmed_string")
                || source.contains("use crate::shared_json_utils::read_trimmed_string"),
            "gemini/request.rs must use shared read_trimmed_string truth"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_qwenchat_tool_definitions_local_clone() {
        let path = crate_src_path("req_outbound_stage3_compat/qwenchat/tool_definitions.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_string(value: Option<&Value>) -> Option<String>"),
            "local read_trimmed_string clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("shared_json_utils::read_trimmed_string")
                || source.contains("use crate::shared_json_utils::read_trimmed_string"),
            "qwenchat/tool_definitions.rs must use shared read_trimmed_string truth"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_qwenchat_response_local_clone() {
        let path = crate_src_path("req_outbound_stage3_compat/qwenchat/response.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_string(value: Option<&Value>) -> Option<String>"),
            "local read_trimmed_string clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("shared_json_utils::read_trimmed_string")
                || source.contains("use crate::shared_json_utils::read_trimmed_string"),
            "qwenchat/response.rs must use shared read_trimmed_string truth"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_responses_openai_codec_local_clone() {
        let path = crate_src_path("responses_openai_codec.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_string(value: Option<&Value>) -> Option<String>"),
            "local read_trimmed_string clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("shared_json_utils::read_trimmed_string")
                || source.contains("use crate::shared_json_utils::read_trimmed_string"),
            "responses_openai_codec.rs must use shared read_trimmed_string truth"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_hub_req_inbound_tool_call_normalization_local_clone() {
        let path = crate_src_path("hub_req_inbound_tool_call_normalization.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_string(value: Option<&Value>) -> Option<String>"),
            "local read_trimmed_string clone still present in {}",
            path.display()
        );
        assert!(
            (source.contains("use crate::shared_json_utils::{")
                && source.contains("read_trimmed_string,"))
                || source.contains("shared_json_utils::read_trimmed_string")
                || source.contains("use crate::shared_json_utils::read_trimmed_string"),
            "hub_req_inbound_tool_call_normalization.rs must use shared read_trimmed_string truth"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_virtual_router_config_bootstrap_local_wrapper() {
        let path = crate_src_path("virtual_router_engine/config_bootstrap.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_string(value: &Value) -> Option<String>"),
            "local read_trimmed_string wrapper still present in {}",
            path.display()
        );
        assert!(
            source.contains("shared_json_utils::read_trimmed_string")
                || source.contains("use crate::shared_json_utils::read_trimmed_string"),
            "virtual_router_engine/config_bootstrap.rs must use shared read_trimmed_string truth"
        );
    }

    #[test]
    fn shared_clone_plain_object_deletion_gate_removed_hub_standardized_bridge_local_clone() {
        let path = crate_src_path("hub_standardized_bridge.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn clone_runtime_metadata(carrier: Option<&Value>) -> Option<Map<String, Value>>"),
            "local clone_runtime_metadata clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("shared_metadata_semantics::read_runtime_metadata")
                || source.contains("use crate::shared_metadata_semantics::read_runtime_metadata"),
            "hub_standardized_bridge.rs must use shared read_runtime_metadata truth"
        );
    }

    #[test]
    fn shared_read_runtime_metadata_deletion_gate_removed_shared_metadata_local_wrapper() {
        let path = crate_src_path("shared_metadata_semantics.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn clone_runtime_metadata(carrier: &Value) -> Value"),
            "local clone_runtime_metadata wrapper still present in {}",
            path.display()
        );
        assert!(
            source.contains("let output = read_runtime_metadata(&carrier);"),
            "shared_metadata_semantics.rs clone_runtime_metadata_json must call shared read_runtime_metadata truth directly"
        );
    }

    #[test]
    fn shared_read_object_trimmed_string_deletion_gate_removed_hub_tool_governance_local_wrapper() {
        let path = crate_src_path("hub_tool_governance_semantics.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_string_field(obj: &Map<String, Value>, key: &str) -> Option<String> {"),
            "local read_string_field wrapper still present in {}",
            path.display()
        );
        assert!(
            source.contains("read_object_trimmed_string(obj, \"allowedCharacters\")")
                || source.contains("read_object_trimmed_string(obj, \"allowed_characters\")"),
            "hub_tool_governance_semantics.rs must use shared read_object_trimmed_string truth directly"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_hub_snapshot_hooks_local_wrapper() {
        let path = crate_src_path("hub_snapshot_hooks.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_string_field(value: &Value, key: &str) -> Option<String> {"),
            "local read_string_field wrapper still present in {}",
            path.display()
        );
        assert!(
            source.contains("read_trimmed_string(obj.get(\"providerKey\"))")
                || source.contains("read_trimmed_string(target.get(\"providerKey\"))")
                || source.contains("read_trimmed_string(meta.get(\"providerKey\"))")
                || source.contains("read_trimmed_string(ctx.get(\"providerKey\"))"),
            "hub_snapshot_hooks.rs must use shared trimmed-string truth directly"
        );
    }

    #[test]
    fn shared_read_object_trimmed_string_deletion_gate_removed_claude_code_user_id_local_wrapper() {
        let path = crate_src_path("req_outbound_stage3_compat/claude_code/user_id.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_string_field(map: &Map<String, Value>, key: &str) -> Option<String> {"),
            "local read_string_field wrapper still present in {}",
            path.display()
        );
        assert!(
            source.contains("read_object_trimmed_string(metadata, \"user_id\")")
                || source.contains("read_trimmed_string(metadata.get(\"user_id\"))"),
            "claude_code/user_id.rs must use shared trimmed-string truth directly"
        );
    }

    #[test]
    fn shared_read_object_trimmed_string_deletion_gate_removed_bridge_metadata_local_wrapper() {
        let path = crate_src_path("hub_bridge_actions/metadata.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_instruction_value(source: &Map<String, Value>, field: &str) -> Option<String> {"),
            "local read_instruction_value wrapper still present in {}",
            path.display()
        );
        assert!(
            source.contains("read_object_trimmed_string(raw_obj, field.as_str())"),
            "hub_bridge_actions/metadata.rs must use shared read_object_trimmed_string truth directly"
        );
    }


    #[test]
    fn shared_read_object_trimmed_string_deletion_gate_removed_local_tool_id_priority_helpers() {
        let compat_path = crate_src_path("hub_tool_session_compat.rs");
        let compat_source = fs::read_to_string(&compat_path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", compat_path.display(), error));
        assert!(
            !compat_source.contains("fn read_tool_call_id(call: &Map<String, Value>) -> Option<String> {")
                && !compat_source.contains("fn read_tool_message_id(message: &Map<String, Value>) -> Option<String> {")
                && !compat_source.contains("fn read_tool_output_id(message: &Map<String, Value>) -> Option<String> {"),
            "hub_tool_session_compat.rs still owns local prioritized tool id readers"
        );
        assert!(
            compat_source.contains("read_first_object_trimmed_string(call")
                || compat_source.contains("read_first_object_trimmed_string(message"),
            "hub_tool_session_compat.rs must route prioritized tool id reads through shared_json_utils truth"
        );

        let submit_path = crate_src_path("hub_submit_tool_outputs.rs");
        let submit_source = fs::read_to_string(&submit_path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", submit_path.display(), error));
        assert!(
            submit_source.contains("read_first_object_trimmed_string(row")
                || submit_source.contains("read_first_object_trimmed_string(&row"),
            "hub_submit_tool_outputs.rs must route prioritized tool id reads through shared_json_utils truth"
        );
    }


    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_qwenchat_append_description_clone() {
        let qwen_path = crate_src_path("req_outbound_stage3_compat/qwen/tool_definitions.rs");
        let qwen_source = fs::read_to_string(&qwen_path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", qwen_path.display(), error));
        let qwenchat_path = crate_src_path("req_outbound_stage3_compat/qwenchat/tool_definitions.rs");
        let qwenchat_source = fs::read_to_string(&qwenchat_path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", qwenchat_path.display(), error));
        assert!(
            !qwenchat_source.contains("fn append_description(existing: Option<&Value>, extra: &str) -> Value {"),
            "qwenchat/tool_definitions.rs still owns local append_description clone"
        );
        assert!(
            qwen_source.contains("pub(crate) fn append_description(")
                || qwenchat_source.contains("append_description("),
            "qwen/qwenchat tool definitions must share a single append_description truth"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_thought_signature_validator_local_clone() {
        let validator_path = crate_src_path("thought_signature_validator.rs");
        let validator_source = fs::read_to_string(&validator_path).unwrap_or_else(|error| {
            panic!("failed to read {}: {}", validator_path.display(), error)
        });
        assert!(
            !validator_source.contains("fn coerce_thought_signature(value: Option<&Value>) -> Option<String> {\n    match value {"),
            "thought_signature_validator.rs still owns local coerce_thought_signature clone"
        );
        assert!(
            validator_source.contains("read_trimmed_string(value)"),
            "thought_signature_validator.rs must route thought-signature trimming through shared read_trimmed_string truth"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_gemini_and_virtual_router_local_clones() {
        let gemini_path = crate_src_path("gemini_openai_codec.rs");
        let gemini_source = fs::read_to_string(&gemini_path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", gemini_path.display(), error));
        assert!(
            !gemini_source.contains("fn coerce_thought_signature(value: Option<&Value>) -> Option<String> {"),
            "gemini_openai_codec.rs still owns local coerce_thought_signature clone"
        );
        assert!(
            gemini_source.contains("read_trimmed_string(part_row.get(\"thoughtSignature\"))")
                || gemini_source.contains("read_trimmed_string(\n        row.get(\"thought_signature\")"),
            "gemini_openai_codec.rs must route thought-signature trimming through shared read_trimmed_string truth"
        );

        let provider_bootstrap_path = crate_src_path("virtual_router_engine/provider_bootstrap.rs");
        let provider_bootstrap_source = fs::read_to_string(&provider_bootstrap_path).unwrap_or_else(|error| {
            panic!("failed to read {}: {}", provider_bootstrap_path.display(), error)
        });
        assert!(
            !provider_bootstrap_source.contains("fn read_optional_string(value: Option<&Value>) -> Option<String> {"),
            "virtual_router_engine/provider_bootstrap.rs still owns local read_optional_string clone"
        );
        assert!(
            provider_bootstrap_source
                .contains("use crate::shared_json_utils::read_trimmed_string as read_optional_string;")
                || provider_bootstrap_source.contains("read_trimmed_string(provider.get(\"type\"))")
                || provider_bootstrap_source.contains("read_trimmed_string(auth.get(\"value\"))"),
            "virtual_router_engine/provider_bootstrap.rs must route optional-string trimming through shared read_trimmed_string truth or direct alias"
        );

        let routing_bootstrap_path = crate_src_path("virtual_router_engine/routing/bootstrap.rs");
        let routing_bootstrap_source = fs::read_to_string(&routing_bootstrap_path).unwrap_or_else(|error| {
            panic!("failed to read {}: {}", routing_bootstrap_path.display(), error)
        });
        assert!(
            !routing_bootstrap_source.contains("fn read_optional_string(value: Option<&Value>) -> Option<String> {"),
            "virtual_router_engine/routing/bootstrap.rs still owns local read_optional_string clone"
        );
        assert!(
            routing_bootstrap_source
                .contains("use crate::shared_json_utils::read_trimmed_string as read_optional_string;")
                || routing_bootstrap_source.contains("read_trimmed_string(record.get(\"id\"))")
                || routing_bootstrap_source.contains("read_trimmed_string(record.get(\"poolId\"))"),
            "virtual_router_engine/routing/bootstrap.rs must route optional-string trimming through shared read_trimmed_string truth or direct alias"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_hub_pipeline_block_local_clones() {
        let resume_path = crate_src_path("hub_pipeline_blocks/responses_resume.rs");
        let resume_source = fs::read_to_string(&resume_path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", resume_path.display(), error));
        assert!(
            !resume_source.contains("fn read_trimmed_optional_string(value: Option<&Value>) -> Option<String> {"),
            "hub_pipeline_blocks/responses_resume.rs still owns local read_trimmed_optional_string clone"
        );
        assert!(
            resume_source.contains("read_trimmed_string(resume_obj.get(\"previousRequestId\"))")
                || resume_source.contains("read_trimmed_string(next_metadata.get(\"routeHint\"))"),
            "hub_pipeline_blocks/responses_resume.rs must route optional string trimming through shared read_trimmed_string truth"
        );

        let metadata_path = crate_src_path("hub_pipeline_blocks/metadata.rs");
        let metadata_source = fs::read_to_string(&metadata_path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", metadata_path.display(), error));
        assert!(
            !metadata_source.contains("fn read_trimmed_string_token(metadata: &Map<String, Value>, keys: &[&str]) -> Option<String> {\n    for key in keys {"),
            "hub_pipeline_blocks/metadata.rs still owns local multi-key trim scan clone"
        );
        assert!(
            metadata_source.contains("read_first_object_trimmed_string(metadata, keys)"),
            "hub_pipeline_blocks/metadata.rs must route multi-key trim scan through shared read_first_object_trimmed_string truth"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_tool_call_id_manager_local_clone() {
        let path = crate_src_path("shared_tool_call_id_manager.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_string(value: Option<&Value>) -> Option<String> {"),
            "local read_string clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("read_trimmed_string(obj.get(\"tool_call_id\"))")
                || source.contains("read_trimmed_string(obj.get(\"call_id\"))"),
            "shared_tool_call_id_manager.rs must use shared read_trimmed_string truth directly"
        );
    }

    #[test]
    fn shared_read_object_trimmed_string_deletion_gate_removed_chat_node_result_local_wrapper() {
        let path = crate_src_path("chat_node_result_semantics.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_object_string(row: &Map<String, Value>, key: &str) -> Option<String> {"),
            "local read_object_string wrapper still present in {}",
            path.display()
        );
        assert!(
            source.contains("read_object_trimmed_string(&continuation, \"stateOrigin\")")
                || source.contains("read_object_trimmed_string(resume_from, \"protocol\")"),
            "chat_node_result_semantics.rs must use shared read_object_trimmed_string truth directly"
        );
    }

    #[test]
    fn shared_read_object_trimmed_string_deletion_gate_removed_web_search_schema_local_wrapper() {
        let path = crate_src_path("chat_web_search_tool_schema.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_engine_id(entry: &Value) -> Option<String> {"),
            "local read_engine_id wrapper still present in {}",
            path.display()
        );
        assert!(
            source.contains("read_object_trimmed_string(obj, \"id\")")
                || source.contains("read_object_trimmed_string(entry, \"id\")"),
            "chat_web_search_tool_schema.rs must use shared read_object_trimmed_string truth directly"
        );
    }

    #[test]
    fn shared_read_object_trimmed_string_deletion_gate_removed_finalize_strip_local_wrapper() {
        let path = crate_src_path("servertool_skeleton/finalize_strip.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_string(record: &Map<String, Value>, key: &str) -> String {"),
            "local read_string wrapper still present in {}",
            path.display()
        );
        assert!(
            source.contains("read_object_trimmed_string(row, \"name\").unwrap_or_default()")
                || source.contains("read_object_trimmed_string(row, \"tool_call_id\").unwrap_or_default()")
                || source.contains("read_object_trimmed_string(row, \"id\").unwrap_or_default()"),
            "servertool_skeleton/finalize_strip.rs must use shared read_object_trimmed_string truth directly"
        );
    }

    #[test]
    fn shared_read_object_trimmed_string_deletion_gate_removed_responses_payload_local_wrapper() {
        let path = crate_src_path("hub_resp_outbound_client_semantics_blocks/responses_payload.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_object_string(row: &Map<String, Value>, key: &str) -> Option<String> {"),
            "local read_object_string wrapper still present in {}",
            path.display()
        );
        assert!(
            source.contains("read_object_trimmed_string(response, \"id\")")
                || source.contains("read_object_trimmed_string(row, \"type\")"),
            "responses_payload.rs must use shared read_object_trimmed_string truth directly"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_universal_shape_filter_local_clone() {
        let path = crate_src_path("req_outbound_stage3_compat/universal_shape_filter.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_string(value: Option<&Value>) -> Option<String> {"),
            "local read_string clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("read_trimmed_string(obj.get(\"tool_use_id\"))")
                || source.contains("read_trimmed_string(row.get(\"type\"))")
                || source.contains("read_trimmed_string(function.get(\"name\"))"),
            "universal_shape_filter.rs must use shared read_trimmed_string truth directly"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_chat_servertool_orchestration_local_wrapper() {
        let path = crate_src_path("chat_servertool_orchestration.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_string(value: Option<&Value>) -> String {"),
            "local read_trimmed_string wrapper still present in {}",
            path.display()
        );
        assert!(
            source.contains("use crate::shared_json_utils::read_trimmed_string")
                || source.contains("shared_json_utils::read_trimmed_string"),
            "chat_servertool_orchestration.rs must use shared read_trimmed_string truth directly"
        );
    }

}
