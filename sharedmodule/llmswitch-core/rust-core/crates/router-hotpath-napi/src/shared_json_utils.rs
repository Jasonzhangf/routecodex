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

pub(crate) fn read_object_trimmed_string(object: &Map<String, Value>, key: &str) -> Option<String> {
    read_trimmed_string(object.get(key))
}

pub(crate) fn read_first_object_trimmed_string(
    object: &Map<String, Value>,
    keys: &[&str],
) -> Option<String> {
    keys.iter()
        .find_map(|key| read_object_trimmed_string(object, key))
}

pub(crate) fn pick_first_trimmed_string_value(values: &[Option<&Value>]) -> Option<String> {
    for value in values {
        let Some(raw) = value.and_then(|v| v.as_str()) else {
            continue;
        };
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
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

pub(crate) fn normalize_on_off_auto_mode(value: Option<&Value>) -> Option<String> {
    let normalized = read_trimmed_string(value)?.to_ascii_lowercase();
    match normalized.as_str() {
        "on" | "off" | "auto" => Some(normalized),
        _ => None,
    }
}

pub(crate) fn normalize_on_off_mode(value: Option<&Value>) -> Option<String> {
    let normalized = read_trimmed_string(value)?.to_ascii_lowercase();
    match normalized.as_str() {
        "on" | "off" => Some(normalized),
        _ => None,
    }
}

pub(crate) fn normalize_on_off_auto_string(value: &Option<String>) -> Option<String> {
    let normalized = value.as_ref()?.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "on" | "off" | "auto" => Some(normalized),
        _ => None,
    }
}

pub(crate) fn normalize_on_off_string(value: &Option<String>) -> Option<String> {
    let normalized = value.as_ref()?.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "on" | "off" => Some(normalized),
        _ => None,
    }
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
        parse_js_number_like, parse_json_bool, read_first_object_trimmed_string,
        read_object_trimmed_string, read_string_array_command, read_trimmed_string,
        read_workdir_from_args, split_command_string, value_as_object_or_empty,
    };
    use serde_json::json;

    fn crate_src_path(relative: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join(relative)
    }

    #[test]
    fn virtual_router_metadata_deletion_gate_removed_local_read_metadata_token_wrapper() {
        let path = crate_src_path("virtual_router_engine/routing/metadata.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_metadata_token(metadata: &Value, key: &str) -> String {"),
            "virtual_router_engine/routing/metadata.rs still owns local read_metadata_token wrapper"
        );
        assert!(
            source.contains(r#"read_trimmed_string(metadata.get("stopMessageClientInjectSessionScope")).unwrap_or_default()"#)
                || source.contains(r#"read_trimmed_string(metadata.get("clientTmuxSessionId")).unwrap_or_default()"#),
            "virtual_router_engine/routing/metadata.rs must route metadata token trimming through shared read_trimmed_string truth"
        );
    }

    #[test]
    fn shared_pick_first_trimmed_string_value_deletion_gate_removed_local_clones() {
        let lmstudio_core_path =
            crate_src_path("req_outbound_stage3_compat/lmstudio/request/core_utils.rs");
        let lmstudio_core_source =
            fs::read_to_string(&lmstudio_core_path).unwrap_or_else(|error| {
                panic!("failed to read {}: {}", lmstudio_core_path.display(), error)
            });
        assert!(
            !lmstudio_core_source.contains(
                "fn pick_trimmed_string_values(values: &[Option<&Value>]) -> Option<String> {"
            ),
            "lmstudio request core_utils still owns local pick_trimmed_string_values clone"
        );

        let lmstudio_tool_ids_path =
            crate_src_path("req_outbound_stage3_compat/lmstudio/request/tool_ids.rs");
        let lmstudio_tool_ids_source =
            fs::read_to_string(&lmstudio_tool_ids_path).unwrap_or_else(|error| {
                panic!(
                    "failed to read {}: {}",
                    lmstudio_tool_ids_path.display(),
                    error
                )
            });
        assert!(
            lmstudio_tool_ids_source.contains("pick_first_trimmed_string_value(&["),
            "lmstudio request tool_ids must route trimmed string picker through shared_json_utils truth"
        );

        let lmstudio_function_ids_path =
            crate_src_path("req_outbound_stage3_compat/lmstudio/request/function_call_ids.rs");
        let lmstudio_function_ids_source = fs::read_to_string(&lmstudio_function_ids_path)
            .unwrap_or_else(|error| {
                panic!(
                    "failed to read {}: {}",
                    lmstudio_function_ids_path.display(),
                    error
                )
            });
        assert!(
            lmstudio_function_ids_source.contains("pick_first_trimmed_string_value(&["),
            "lmstudio request function_call_ids must route trimmed string picker through shared_json_utils truth"
        );

        let compat_path = crate_src_path("shared_response_compat.rs");
        let compat_source = fs::read_to_string(&compat_path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", compat_path.display(), error));
        assert!(
            !compat_source
                .contains("fn pick_string(candidates: &[Option<&Value>]) -> Option<String> {"),
            "shared_response_compat.rs still owns local pick_string clone"
        );
        assert!(
            compat_source.contains("pick_first_trimmed_string_value(&["),
            "shared_response_compat.rs must route trimmed string picker through shared_json_utils truth"
        );
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
            "virtual_router_engine/routing/metadata.rs",
            "chat_governance_context.rs",
            "hub_submit_tool_outputs.rs",
            "hub_req_inbound_semantic_lift.rs",
        ] {
            let path = crate_src_path(relative);
            if !path.exists() {
                assert_eq!(
                    relative, "chat_governance_context.rs",
                    "shared helper deletion gate scan root missing unexpectedly: {}",
                    relative
                );
                continue;
            }
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
            !source.contains(
                "fn read_trimmed_non_empty_string(value: Option<&Value>) -> Option<String>"
            ),
            "local read_trimmed_non_empty_string clone still present in {}",
            path.display()
        );
        assert!(
            !source.contains(
                "fn clone_non_empty_object(value: Option<&Value>) -> Option<Map<String, Value>>"
            ),
            "local clone_non_empty_object clone still present in {}",
            path.display()
        );
        assert!(
            !source.contains("fn read_optional_bool(value: Option<&Value>) -> Option<bool>"),
            "local read_optional_bool clone still present in {}",
            path.display()
        );
        assert!(
            !source.contains(
                "fn clone_plain_object(value: Option<&Value>) -> Option<Map<String, Value>>"
            ),
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
            !source.contains(
                "fn read_trimmed_non_empty_string(value: Option<&Value>) -> Option<String>"
            ),
            "local read_trimmed_non_empty_string clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("read_trimmed_string("),
            "compat_harvest_tool_calls_from_text.rs must use shared read_trimmed_string truth"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_virtual_router_stop_message_actions_local_clone(
    ) {
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
    fn shared_stop_message_mode_normalizers_deletion_gate_removed_local_clones() {
        for relative in [
            "virtual_router_stop_message_actions.rs",
        ] {
            let path = crate_src_path(relative);
            let source = fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
            assert!(
                !source
                    .contains("fn normalize_stage_mode(value: Option<&Value>) -> Option<String> {"),
                "local normalize_stage_mode clone still present in {}",
                path.display()
            );
            assert!(
                !source.contains("fn normalize_ai_mode(value: Option<&Value>) -> Option<String> {"),
                "local normalize_ai_mode clone still present in {}",
                path.display()
            );
            assert!(
                source.contains("normalize_on_off_auto_mode("),
                "{} must use shared normalize_on_off_auto_mode truth directly",
                path.display()
            );
            assert!(
                source.contains("normalize_on_off_mode("),
                "{} must use shared normalize_on_off_mode truth directly",
                path.display()
            );
        }
    }

    #[test]
    fn shared_stop_message_string_mode_normalizers_deletion_gate_removed_instruction_state_clones()
    {
        let path = crate_src_path("virtual_router_engine/instructions/state.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn normalize_stage_mode(value: &Option<String>) -> Option<String> {"),
            "local string normalize_stage_mode clone still present in {}",
            path.display()
        );
        assert!(
            !source.contains("fn normalize_ai_mode(value: &Option<String>) -> Option<String> {"),
            "local string normalize_ai_mode clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("normalize_on_off_auto_string("),
            "{} must use shared normalize_on_off_auto_string truth directly",
            path.display()
        );
        assert!(
            source.contains("normalize_on_off_string("),
            "{} must use shared normalize_on_off_string truth directly",
            path.display()
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
    fn shared_read_trimmed_string_deletion_gate_removed_hub_req_inbound_context_capture_local_clone(
    ) {
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
            !source.contains(
                "pub(crate) fn read_trimmed_string(value: Option<&Value>) -> Option<String>"
            ),
            "local read_trimmed_string wrapper still present in {}",
            path.display()
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_qwen_tool_definitions_local_clone() {
        let path = crate_src_path("req_outbound_stage3_compat/qwen/tool_definitions.rs");
        assert!(
            !path.exists(),
            "removed qwen compat module must not be restored: {}",
            path.display()
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
    fn shared_read_object_trimmed_string_deletion_gate_removed_deepseek_prompt_content_local_clone()
    {
        let path =
            crate_src_path("req_outbound_stage3_compat/deepseek_web/request/prompt/content.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains(
                "map.get(key)
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())"
            ),
            "deepseek_web/request/prompt/content.rs still owns local map-key trim clone"
        );
        assert!(
            source.contains("read_object_trimmed_string(obj, \"cmd\")")
                || source.contains("read_object_trimmed_string(obj, \"justification\")"),
            "deepseek_web/request/prompt/content.rs must route map-key trim through shared read_object_trimmed_string truth"
        );
    }

    #[test]
    fn shared_read_object_trimmed_string_deletion_gate_removed_hub_bridge_pipeline_local_wrapper() {
        let path = crate_src_path("hub_bridge_actions/pipeline.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn pick_option_str(options: Option<&Map<String, Value>>, key: &str) -> Option<String> {"),
            "hub_bridge_actions/pipeline.rs still owns local pick_option_str wrapper"
        );
        assert!(
            source.contains("read_object_trimmed_string(row, \"idPrefix\")")
                || source.contains("read_object_trimmed_string(row, key)"),
            "hub_bridge_actions/pipeline.rs must route option string reads through shared read_object_trimmed_string truth"
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
        assert!(
            !path.exists(),
            "removed qwenchat compat module must not be restored: {}",
            path.display()
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_qwenchat_response_local_clone() {
        let path = crate_src_path("req_outbound_stage3_compat/qwenchat/response.rs");
        assert!(
            !path.exists(),
            "removed qwenchat response module must not be restored: {}",
            path.display()
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
    fn shared_read_trimmed_string_deletion_gate_removed_hub_req_inbound_tool_call_normalization_local_clone(
    ) {
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
    fn shared_read_trimmed_string_deletion_gate_removed_virtual_router_config_bootstrap_local_wrapper(
    ) {
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
            !source.contains(
                "fn clone_runtime_metadata(carrier: Option<&Value>) -> Option<Map<String, Value>>"
            ),
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
    fn shared_read_object_trimmed_string_deletion_gate_removed_hub_tool_governance_file() {
        let path = crate_src_path("hub_tool_governance_semantics.rs");
        assert!(
            !path.exists(),
            "retired hub_tool_governance_semantics.rs must stay physically deleted: {}",
            path.display()
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
            !source.contains(
                "fn read_string_field(map: &Map<String, Value>, key: &str) -> Option<String> {"
            ),
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
            !compat_source
                .contains("fn read_tool_call_id(call: &Map<String, Value>) -> Option<String> {")
                && !compat_source.contains(
                    "fn read_tool_message_id(message: &Map<String, Value>) -> Option<String> {"
                )
                && !compat_source.contains(
                    "fn read_tool_output_id(message: &Map<String, Value>) -> Option<String> {"
                ),
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
            !submit_source.contains("build_submit_tool_outputs_payload"),
            "retired submit_tool_outputs payload builder must not return in {}",
            submit_path.display()
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_qwenchat_append_description_clone() {
        let qwen_path = crate_src_path("req_outbound_stage3_compat/qwen/tool_definitions.rs");
        let qwenchat_path =
            crate_src_path("req_outbound_stage3_compat/qwenchat/tool_definitions.rs");
        assert!(
            !qwen_path.exists(),
            "removed qwen tool definitions must not be restored: {}",
            qwen_path.display()
        );
        assert!(
            !qwenchat_path.exists(),
            "removed qwenchat tool definitions must not be restored: {}",
            qwenchat_path.display()
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_thought_signature_validator_local_clone() {
        let validator_path = crate_src_path("thought_signature_validator.rs");
        assert!(
            !validator_path.exists(),
            "retired thought_signature_validator.rs must not be restored: {}",
            validator_path.display()
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_gemini_and_virtual_router_local_clones() {
        let gemini_path = crate_src_path("gemini_openai_codec.rs");
        let gemini_source = fs::read_to_string(&gemini_path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", gemini_path.display(), error));
        assert!(
            !gemini_source
                .contains("fn coerce_thought_signature(value: Option<&Value>) -> Option<String> {"),
            "gemini_openai_codec.rs still owns local coerce_thought_signature clone"
        );
        assert!(
            gemini_source.contains("read_trimmed_string(part_row.get(\"thoughtSignature\"))")
                || gemini_source.contains("read_trimmed_string(\n        row.get(\"thought_signature\")"),
            "gemini_openai_codec.rs must route thought-signature trimming through shared read_trimmed_string truth"
        );

        let provider_bootstrap_path = crate_src_path("virtual_router_engine/provider_bootstrap.rs");
        let provider_bootstrap_source = fs::read_to_string(&provider_bootstrap_path)
            .unwrap_or_else(|error| {
                panic!(
                    "failed to read {}: {}",
                    provider_bootstrap_path.display(),
                    error
                )
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
        let routing_bootstrap_source =
            fs::read_to_string(&routing_bootstrap_path).unwrap_or_else(|error| {
                panic!(
                    "failed to read {}: {}",
                    routing_bootstrap_path.display(),
                    error
                )
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
        let metadata_source = fs::read_to_string(&metadata_path).unwrap_or_else(|error| {
            panic!("failed to read {}: {}", metadata_path.display(), error)
        });
        assert!(
            !metadata_source.contains("fn read_trimmed_string_token(metadata: &Map<String, Value>, keys: &[&str]) -> Option<String> {"),
            "hub_pipeline_blocks/metadata.rs still owns local multi-key trim wrapper"
        );
        assert!(
            metadata_source.contains("read_first_object_trimmed_string(metadata_obj,")
                && metadata_source.contains("stopMessageClientInjectSessionScope")
                && metadata_source.contains("clientTmuxSessionId"),
            "hub_pipeline_blocks/metadata.rs must call shared read_first_object_trimmed_string directly"
        );
    }

    #[test]
    fn shared_json_utils_deletion_gate_removed_shared_responses_conversation_utils_wrappers() {
        let path = crate_src_path("shared_responses_conversation_utils.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_text(value: Option<&Value>) -> Option<String> {"),
            "shared_responses_conversation_utils.rs still owns local read_trimmed_text wrapper"
        );
        assert!(
            !source.contains("fn read_workdir_from_args_map(args: &Map<String, Value>) -> Option<String> {"),
            "shared_responses_conversation_utils.rs still owns local read_workdir_from_args_map wrapper"
        );
        assert!(
            source.contains("read_trimmed_string(")
                && source.contains("read_workdir_from_args(args)"),
            "shared_responses_conversation_utils.rs must call shared json utils truth directly"
        );
    }

    #[test]
    fn shared_read_first_object_trimmed_string_deletion_gate_removed_hub_pipeline_metadata_wrapper()
    {
        let path = crate_src_path("hub_pipeline_blocks/metadata.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_trimmed_string_token(metadata: &Map<String, Value>, keys: &[&str]) -> Option<String> {"),
            "hub_pipeline_blocks/metadata.rs still owns local multi-key trim wrapper"
        );
        assert!(
            source.contains("read_first_object_trimmed_string(metadata_obj,")
                && source.contains("stopMessageClientInjectSessionScope")
                && source.contains("clientTmuxSessionId"),
            "hub_pipeline_blocks/metadata.rs must call shared read_first_object_trimmed_string directly"
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
    fn shared_json_utils_deletion_gate_removed_thought_signature_validator_wrapper() {
        let path = crate_src_path("thought_signature_validator.rs");
        assert!(
            !path.exists(),
            "retired thought_signature_validator.rs must not be restored: {}",
            path.display()
        );
    }

    #[test]
    fn shared_json_utils_deletion_gate_removed_virtual_router_routing_metadata_wrappers() {
        let path = crate_src_path("virtual_router_engine/routing/metadata.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn read_request_id(metadata: &Value) -> Option<String> {"),
            "virtual_router_engine/routing/metadata.rs still owns local read_request_id wrapper"
        );
        assert!(
            !source.contains("fn read_continuation_sticky_scope(metadata: &Value) -> Option<String> {"),
            "virtual_router_engine/routing/metadata.rs still owns local read_continuation_sticky_scope wrapper"
        );
        assert!(
            source.contains(r#"read_trimmed_string(metadata.get("requestId"))"#)
                && source.contains(r#"continuation.get("continuationScope")"#),
            "virtual_router_engine/routing/metadata.rs must call shared read_trimmed_string truth directly"
        );
    }

    #[test]
    fn shared_read_object_trimmed_string_deletion_gate_removed_chat_node_result_local_wrapper() {
        let path = crate_src_path("chat_node_result_semantics.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains(
                "fn read_object_string(row: &Map<String, Value>, key: &str) -> Option<String> {"
            ),
            "local read_object_string wrapper still present in {}",
            path.display()
        );
        assert!(
            !source.contains("stateOrigin") && !source.contains("resume_from"),
            "chat_node_result_semantics.rs must not restore retired continuation metadata readers"
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
            !source.contains(
                "fn read_object_string(row: &Map<String, Value>, key: &str) -> Option<String> {"
            ),
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
    fn shared_value_as_object_or_empty_deletion_gate_removed_responses_resume_local_wrapper() {
        let path = crate_src_path("hub_pipeline_blocks/responses_resume.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn value_as_object_or_empty(value: &Value) -> Map<String, Value> {"),
            "hub_pipeline_blocks/responses_resume.rs still owns local value_as_object_or_empty wrapper"
        );
        assert!(
            source.contains("use crate::shared_json_utils::{read_trimmed_string, value_as_object_or_empty};")
                || source.contains("use crate::shared_json_utils::value_as_object_or_empty;")
                || source.contains("shared_json_utils::value_as_object_or_empty"),
            "hub_pipeline_blocks/responses_resume.rs must use shared value_as_object_or_empty truth directly"
        );
    }

    #[test]
    fn shared_value_as_object_or_empty_deletion_gate_removed_web_search_local_wrapper() {
        let path = crate_src_path("hub_pipeline_blocks/web_search.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn value_as_object_or_empty(value: &Value) -> Map<String, Value> {"),
            "hub_pipeline_blocks/web_search.rs still owns local value_as_object_or_empty wrapper"
        );
        assert!(
            source.contains("use crate::shared_json_utils::{parse_js_number_like, value_as_object_or_empty};")
                || source.contains("use crate::shared_json_utils::value_as_object_or_empty;")
                || source.contains("shared_json_utils::value_as_object_or_empty"),
            "hub_pipeline_blocks/web_search.rs must use shared value_as_object_or_empty truth directly"
        );
    }

    #[test]
    fn shared_json_record_helpers_deletion_gate_removed_chat_governance_finalize_local_wrappers() {
        let path = crate_src_path("chat_governance_finalize.rs");
        if !path.exists() {
            return;
        }
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn as_object(value: &Value) -> Option<&Map<String, Value>> {")
                && !source
                    .contains("fn normalize_metadata(metadata: Value) -> Map<String, Value> {"),
            "chat_governance_finalize.rs still owns local json wrapper helpers"
        );
        assert!(
            source.contains("use crate::shared_json_utils::{as_object, normalize_record};")
                || source.contains("use crate::shared_json_utils::normalize_record;")
                || source.contains("shared_json_utils::normalize_record"),
            "chat_governance_finalize.rs must use shared json helper truth directly"
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_claude_code_local_wrappers() {
        for rel in [
            "req_outbound_stage3_compat/claude_code/user_id.rs",
            "req_outbound_stage3_compat/claude_code/system_prompt.rs",
        ] {
            let path = crate_src_path(rel);
            let source = fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
            assert!(
                !source
                    .contains("fn read_non_empty_str(value: Option<&Value>) -> Option<String> {")
                    && !source
                        .contains("fn read_trimmed_str(value: Option<&Value>) -> Option<String> {"),
                "{} still owns local trimmed-string wrapper",
                path.display()
            );
            assert!(
                source.contains("use crate::shared_json_utils::read_trimmed_string;")
                    || source.contains("use crate::shared_json_utils::{read_object_trimmed_string, read_trimmed_string};")
                    || source.contains("shared_json_utils::read_trimmed_string"),
                "{} must use shared read_trimmed_string truth directly",
                path.display()
            );
        }
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_chat_servertool_orchestration_local_wrapper(
    ) {
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
