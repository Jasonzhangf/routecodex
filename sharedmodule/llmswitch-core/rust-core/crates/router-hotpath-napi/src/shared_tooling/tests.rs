use super::{
    chunk_string_by_bytes, collapse_extra_newlines_and_trim, decode_basic_xml_entities,
    extract_rcc_tool_call_fence_segments, extract_structured_apply_patch_payloads_with,
    find_last_user_message_index, is_chunked_exec_transcript_header_line, is_image_path,
    is_structured_apply_patch_payload, normalize_ran_tree_or_chunked_tool_text,
    normalize_standard_chunked_tool_text, normalize_tool_result_text, normalize_tool_result_value,
    repair_find_meta_json, strip_terminal_right_gutter_noise, unwrap_chunked_exec_transcript_shape,
    unwrap_ran_transcript_shape, unwrap_xml_cdata_sections, value_to_string,
};
use serde_json::json;
use std::{fs, path::PathBuf};

#[test]
fn shared_tooling_repair_find_meta_json() {
    let input = json!("find . -type f -exec echo {} ;").to_string();
    let raw = repair_find_meta_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert!(parsed.as_str().unwrap().contains("\\;"));
}

#[test]
fn shared_tooling_repair_find_meta_json_escapes_bare_parens() {
    let input = json!("find . -type f ( -name \"*.ts\" -o -name \"*.tsx\" ) -print").to_string();
    let raw = repair_find_meta_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let repaired = parsed.as_str().unwrap_or("");
    assert!(repaired.contains("find . -type f \\("));
    assert!(repaired.contains("\\) -print"));
}

#[test]
fn shared_tooling_repair_find_meta_json_does_not_touch_non_find_shell() {
    let input = json!("bash -lc 'echo (hello)'").to_string();
    let raw = repair_find_meta_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed.as_str().unwrap_or(""), "bash -lc 'echo (hello)'");
}

#[test]
fn shared_tooling_repair_find_meta_json_repairs_quoted_find_parens_and_exec() {
    let input = json!(
        "bash -lc 'find . -type f ( -name \"*.ts\" -o -name \"*.tsx\" ) -exec sed -n \"1,3p\" {} ; | head -5'"
    )
    .to_string();
    let raw = repair_find_meta_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let repaired = parsed.as_str().unwrap_or("");
    assert!(repaired.contains("find . -type f \\("));
    assert!(repaired.contains("\\) -exec sed -n \"1,3p\" {} \\;"));
}

#[test]
fn shared_tooling_extracts_structured_apply_patch_payloads() {
    let payloads = extract_structured_apply_patch_payloads_with(
        "```json\n{\"changes\":[{\"kind\":\"add\"}]}\n```",
        |raw| serde_json::from_str(raw).ok(),
    );
    assert_eq!(payloads.len(), 1);
    assert!(is_structured_apply_patch_payload(&payloads[0]));
}

#[test]
fn shared_tooling_chunks_string_by_bytes_for_harvest_modules() {
    assert_eq!(
        chunk_string_by_bytes("abcdef", 2),
        vec!["ab".to_string(), "cd".to_string(), "ef".to_string()]
    );
}

#[test]
fn shared_tooling_unwraps_xml_cdata_sections() {
    assert_eq!(
        unwrap_xml_cdata_sections("a<![CDATA[<x>]]>b"),
        "a<x>b".to_string()
    );
}

#[test]
fn shared_tooling_decodes_basic_xml_entities() {
    assert_eq!(
        decode_basic_xml_entities("&lt;a&gt;&amp;&quot;x&quot;&apos;y&apos;"),
        "<a>&\"x\"'y'".to_string()
    );
}

#[test]
fn shared_tooling_extracts_rcc_tool_call_fence_segments() {
    let raw = "before\n<<RCC_TOOL_CALLS_JSON\n[{\"name\":\"x\"}]\nRCC_TOOL_CALLS_JSON\nafter";
    assert_eq!(
        extract_rcc_tool_call_fence_segments(raw),
        vec!["[{\"name\":\"x\"}]".to_string()]
    );
}

#[test]
fn shared_tooling_detects_image_paths() {
    assert!(is_image_path("a/b/demo.PNG"));
    assert!(!is_image_path("a/b/demo.txt"));
}

#[test]
fn shared_tooling_stringifies_values_like_markup_modules() {
    assert_eq!(value_to_string(&json!(["a", 2, null])), "a 2 ".to_string());
}

#[test]
fn shared_tooling_replaces_tool_result_data_images_with_placeholder() {
    let raw = "before data:image/png;base64,AAAABBBBCCCC after";
    let normalized = normalize_tool_result_text(raw);
    assert!(normalized.contains("before"));
    assert!(normalized.contains("after"));
    assert!(normalized.contains("[Image omitted]"));
    assert!(!normalized.contains("data:image/png;base64"));
    assert!(!normalized.contains("AAAABBBBCCCC"));
}

#[test]
fn shared_tooling_strips_provider_tool_sentinel_residue_from_tool_text() {
    let raw = "Jason，继续。]<]minimax[>[\n\n• minimax:tool_call (minimax:tool_call)\n\n  </minimax:tool_call>\n\nRun command";
    let normalized = normalize_tool_result_text(raw);
    assert_eq!(normalized, "Jason，继续。\n\nRun command");
    assert!(!normalized.contains("]<]minimax[>["));
    assert!(!normalized.contains("minimax:tool_call"));
    assert!(!normalized.contains("</minimax:tool_call>"));
}

#[test]
fn shared_tooling_collapse_extra_newlines_and_trim_matches_directive_modules() {
    let raw = "\n\nalpha\n\n\n\nbeta\n\n\n";
    assert_eq!(
        collapse_extra_newlines_and_trim(raw),
        "alpha\n\nbeta".to_string()
    );
}

#[test]
fn shared_tooling_finds_last_user_message_index() {
    let rows = vec![
        json!({"role": "user", "content": "first"}),
        json!({"role": "assistant", "content": "second"}),
        json!({"role": "USER", "content": "third"}),
    ];
    assert_eq!(find_last_user_message_index(&rows), Some(2));
}

#[test]
fn shared_tooling_returns_none_when_no_user_message_exists() {
    let rows = vec![
        json!({"role": "assistant", "content": "first"}),
        json!({"role": "tool", "content": "second"}),
    ];
    assert_eq!(find_last_user_message_index(&rows), None);
}

#[test]
fn shared_tooling_strips_terminal_right_gutter_noise() {
    assert_eq!(
        strip_terminal_right_gutter_noise("alpha │··········"),
        "alpha".to_string()
    );
}

#[test]
fn shared_tooling_hot_path_regexes_are_not_compiled_per_line() {
    let source_path = crate_src_path("shared_tooling.rs");
    let source = fs::read_to_string(&source_path)
        .unwrap_or_else(|error| panic!("failed to read {}: {}", source_path.display(), error));
    for function_name in [
        "strip_terminal_right_gutter_noise",
        "strip_box_drawing_prefix",
        "is_transcript_collapsed_placeholder",
        "is_chunked_exec_transcript_header_line",
        "unwrap_ran_transcript_shape",
    ] {
        let marker = format!("fn {function_name}");
        let start = source
            .find(marker.as_str())
            .unwrap_or_else(|| panic!("missing hot-path function {function_name}"));
        let body = rust_function_source(&source[start..])
            .unwrap_or_else(|| panic!("failed to parse hot-path function {function_name}"));
        assert!(
            !body.contains("Regex::new"),
            "{function_name} must not compile regexes inside the per-line hot path"
        );
    }
}

fn rust_function_source(source_from_fn: &str) -> Option<&str> {
    let open = source_from_fn.find('{')?;
    let mut depth = 0usize;
    for (offset, ch) in source_from_fn[open..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    let end = open + offset + ch.len_utf8();
                    return Some(&source_from_fn[..end]);
                }
            }
            _ => {}
        }
    }
    None
}

#[test]
fn shared_tooling_detects_chunked_exec_transcript_headers() {
    assert!(is_chunked_exec_transcript_header_line("Chunk ID: 123"));
    assert!(!is_chunked_exec_transcript_header_line("alpha"));
}

#[test]
fn shared_tooling_unwraps_chunked_exec_transcript_shape() {
    let raw = "Chunk ID: 1\nWall time: 0.0 seconds\nProcess exited with code 0\nOriginal token count: 3\nOutput:\nalpha\nbeta\n";
    assert_eq!(
        unwrap_chunked_exec_transcript_shape(raw),
        Some("alpha\nbeta".to_string())
    );
}

#[test]
fn shared_tooling_unwraps_ran_tree_transcript_shape() {
    let raw = "• Ran bash -lc 'python3 demo.py'\n  └ File \"<stdin>\", line 3\n    SyntaxError: invalid syntax\n";
    assert_eq!(
        unwrap_ran_transcript_shape(raw),
        Some("File \"<stdin>\", line 3\nSyntaxError: invalid syntax".to_string())
    );
}

#[test]
fn shared_tooling_normalizes_standard_chunked_tool_text() {
    let raw = "Chunk ID: 1\nWall time: 0.0 seconds\nProcess exited with code 0\nOriginal token count: 3\nOutput:\nalpha │··········\n";
    assert_eq!(
        normalize_standard_chunked_tool_text(raw),
        "alpha".to_string()
    );
}

#[test]
fn shared_tooling_normalizes_ran_tree_or_chunked_tool_text() {
    let raw = "• Ran bash -lc 'python3 demo.py'                                  │··········\n  └ File \"<stdin>\", line 3                                        │··········\n    SyntaxError: invalid syntax                                     │··········\n";
    assert_eq!(
        normalize_ran_tree_or_chunked_tool_text(raw),
        "File \"<stdin>\", line 3\nSyntaxError: invalid syntax".to_string()
    );
}

#[test]
fn shared_tooling_normalizes_tool_result_value() {
    let value = json!({"stdout":"ok","status":"completed"});
    let normalized = normalize_tool_result_value(&value);
    let parsed: serde_json::Value =
        serde_json::from_str(normalized.as_str()).expect("normalized json");
    assert_eq!(parsed, value);
}

fn crate_src_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join(relative)
}

#[test]
fn shared_tooling_deletion_gate_removed_structured_apply_patch_local_clones() {
    for relative in ["tool_harvester.rs", "hub_text_markup_normalizer.rs"] {
        let path = crate_src_path(relative);
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn is_structured_apply_patch_payload("),
            "local structured apply_patch detector still present in {}",
            path.display()
        );
        assert!(
            !source
                .contains("fn extract_structured_apply_patch_payloads(text: &str) -> Vec<Value> {"),
            "local structured apply_patch wrapper still present in {}",
            path.display()
        );
    }
    let harvester_path = crate_src_path("tool_harvester.rs");
    let harvester_source = fs::read_to_string(&harvester_path)
        .unwrap_or_else(|error| panic!("failed to read {}: {}", harvester_path.display(), error));
    assert!(
        harvester_source.contains("extract_structured_apply_patch_payloads_with("),
        "tool_harvester.rs must use shared structured apply_patch extractor truth"
    );
    let markup_path = crate_src_path("hub_text_markup_normalizer.rs");
    let markup_source = fs::read_to_string(&markup_path)
        .unwrap_or_else(|error| panic!("failed to read {}: {}", markup_path.display(), error));
    assert!(
        markup_source.contains("extract_structured_apply_patch_payloads_with("),
        "hub_text_markup_normalizer.rs must route structured apply_patch extraction through shared truth"
    );
}

#[test]
fn shared_tooling_deletion_gate_removed_harvester_local_chunk_clone() {
    let path = crate_src_path("tool_harvester.rs");
    let source = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
    assert!(
        !source.contains("fn chunk_string(input: &str, size: usize) -> Vec<String>"),
        "local chunk_string clone still present in {}",
        path.display()
    );
    assert!(
        source.contains("chunk_string_by_bytes("),
        "tool_harvester.rs must use shared chunk helper truth"
    );
}

#[test]
fn shared_tooling_deletion_gate_removed_duplicate_value_and_rcc_fence_helpers() {
    for relative in [
        "hub_req_inbound_tool_call_normalization.rs",
        "hub_reasoning_tool_normalizer.rs",
        "resp_process_stage1_tool_governance_blocks/text_harvest_extract.rs",
    ] {
        let path = crate_src_path(relative);
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn value_to_string(value: &Value) -> String {"),
            "local value_to_string clone still present in {}",
            path.display()
        );
        assert!(
            !source.contains("fn extract_rcc_tool_call_fence_segments(raw: &str) -> Vec<String> {")
                && !source.contains("pub(crate) fn extract_rcc_tool_call_fence_segments(raw: &str) -> Vec<String> {"),
            "local extract_rcc_tool_call_fence_segments clone still present in {}",
            path.display()
        );
    }
}

#[test]
fn shared_tooling_deletion_gate_removed_shared_tool_result_text_normalizer_module() {
    let path = crate_src_path("shared_tool_result_text_normalizer.rs");
    assert!(
        !path.exists(),
        "shared_tool_result_text_normalizer.rs should be physically removed after migrating tool result normalization into shared_tooling.rs"
    );
}

#[test]
fn shared_tooling_deletion_gate_removed_hub_heartbeat_directives_local_wrapper() {
    let path = crate_src_path("hub_heartbeat_directives.rs");
    assert!(
        !path.exists(),
        "hub_heartbeat_directives.rs must be physically removed with heartbeat feature"
    );
}

#[test]
fn shared_tooling_deletion_gate_removed_chat_clock_reminder_directives_local_wrapper() {
    let path = crate_src_path("chat_clock_reminder_directives.rs");
    assert!(
        !path.exists(),
        "chat_clock_reminder_directives.rs must be physically removed with clock feature"
    );
}

#[test]
fn shared_tooling_deletion_gate_removed_chat_clock_reminder_semantics_local_wrapper() {
    let path = crate_src_path("chat_clock_reminder_semantics.rs");
    assert!(
        !path.exists(),
        "chat_clock_reminder_semantics.rs must be physically removed with clock feature"
    );
}

#[test]
fn shared_tooling_deletion_gate_removed_tool_content_text_wrappers() {
    let retired_path = crate_src_path("hub_semantic_mapper_chat.rs");
    assert!(
        !retired_path.exists(),
        "retired hub_semantic_mapper_chat.rs must stay physically deleted: {}",
        retired_path.display()
    );
    for relative in ["req_outbound_stage3_compat/universal_shape_filter.rs"] {
        let path = crate_src_path(relative);
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn normalize_tool_content_text(raw: &str) -> String {"),
            "local normalize_tool_content_text wrapper still present in {}",
            path.display()
        );
        assert!(
            source.contains("normalize_standard_chunked_tool_text("),
            "{} must use shared normalize_standard_chunked_tool_text truth directly",
            path.display()
        );
    }
}

#[test]
fn shared_tooling_deletion_gate_removed_history_tool_result_payload_wrapper() {
    let path = crate_src_path("hub_bridge_actions/history.rs");
    let source = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
    assert!(
        !source.contains("fn serialize_tool_result_payload(value: &Value) -> String {"),
        "local serialize_tool_result_payload wrapper still present in {}",
        path.display()
    );
    assert!(
        source.contains(".map(normalize_tool_result_value)"),
        "hub_bridge_actions/history.rs must use shared normalize_tool_result_value truth directly"
    );
}

#[test]
fn shared_tooling_deletion_gate_removed_duplicate_xml_scalar_normalizers() {
    let reasoning_path = crate_src_path("hub_reasoning_tool_normalizer.rs");
    let reasoning_source = fs::read_to_string(&reasoning_path)
        .unwrap_or_else(|error| panic!("failed to read {}: {}", reasoning_path.display(), error));
    assert!(
        !reasoning_source.contains("fn normalize_markup_scalar_text(raw: &str) -> String {"),
        "local normalize_markup_scalar_text wrapper still present in {}",
        reasoning_path.display()
    );
    assert!(
        reasoning_source.contains("normalize_xml_scalar_text(trimmed.as_str())"),
        "hub_reasoning_tool_normalizer.rs must use shared normalize_xml_scalar_text truth directly"
    );

    let markup_path = crate_src_path("hub_text_markup_normalizer.rs");
    let markup_source = fs::read_to_string(&markup_path)
        .unwrap_or_else(|error| panic!("failed to read {}: {}", markup_path.display(), error));
    assert!(
        markup_source.contains("normalize_xml_scalar_text(raw_val_input)"),
        "hub_text_markup_normalizer.rs must use shared normalize_xml_scalar_text truth directly"
    );
    assert!(
        !markup_source
            .contains("decode_basic_xml_entities(unwrap_xml_cdata_sections(raw_val_input).trim())"),
        "hub_text_markup_normalizer.rs still owns duplicate xml scalar normalization logic"
    );
}

#[test]
fn shared_tooling_deletion_gate_removed_reasoning_owned_repair_arguments_helper() {
    let reasoning_path = crate_src_path("hub_reasoning_tool_normalizer.rs");
    let reasoning_source = fs::read_to_string(&reasoning_path)
        .unwrap_or_else(|error| panic!("failed to read {}: {}", reasoning_path.display(), error));
    assert!(
        !reasoning_source.contains("pub(crate) fn repair_arguments_to_string(value: &Value) -> String {"),
        "hub_reasoning_tool_normalizer.rs still owns repair_arguments_to_string instead of shared_tooling.rs"
    );
    assert!(
        reasoning_source.contains("use crate::shared_tooling::")
            || reasoning_source.contains("repair_arguments_to_string("),
        "hub_reasoning_tool_normalizer.rs must consume shared repair_arguments_to_string truth"
    );

    for relative in [
        "tool_harvester.rs",
        "streaming_tool_extractor.rs",
        "hub_bridge_actions/bridge_input.rs",
    ] {
        let path = crate_src_path(relative);
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source
                .contains("use crate::hub_reasoning_tool_normalizer::repair_arguments_to_string;")
                && !source.contains(
                    "normalize_assistant_text_to_tool_calls_json, repair_arguments_to_string"
                ),
            "{} still imports repair_arguments_to_string from reasoning module",
            path.display()
        );
        assert!(
            source.contains("repair_arguments_to_string("),
            "{} must still call shared repair_arguments_to_string truth",
            path.display()
        );
    }
}

#[test]
fn shared_tooling_deletion_gate_removed_argument_string_wrappers() {
    let harvester_path = crate_src_path("tool_harvester.rs");
    let harvester_source = fs::read_to_string(&harvester_path)
        .unwrap_or_else(|error| panic!("failed to read {}: {}", harvester_path.display(), error));
    assert!(
        !harvester_source.contains("fn to_json_string(value: &Value) -> String {"),
        "tool_harvester.rs still owns to_json_string wrapper instead of calling shared repair_arguments_to_string truth directly"
    );
    assert!(
        harvester_source.contains("repair_arguments_to_string(&args_value)")
            || harvester_source.contains("repair_arguments_to_string(&payload)")
            || harvester_source.contains("repair_arguments_to_string(&Value::Object(args_obj))"),
        "tool_harvester.rs must call shared repair_arguments_to_string truth directly"
    );

    let bridge_utils_path = crate_src_path("hub_bridge_actions/utils.rs");
    let bridge_utils_source = fs::read_to_string(&bridge_utils_path).unwrap_or_else(|error| {
        panic!("failed to read {}: {}", bridge_utils_path.display(), error)
    });
    assert!(
        !bridge_utils_source
            .contains("pub(crate) fn serialize_tool_arguments(value: Option<&Value>) -> String {"),
        "hub_bridge_actions/utils.rs still owns serialize_tool_arguments wrapper"
    );

    for relative in [
        "hub_bridge_actions/bindings.rs",
        "hub_bridge_actions/history.rs",
        "hub_bridge_actions/bridge_input.rs",
    ] {
        let path = crate_src_path(relative);
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("serialize_tool_arguments("),
            "{} still routes tool argument serialization through local wrapper",
            path.display()
        );
        assert!(
            source.contains("repair_arguments_to_string("),
            "{} must call shared repair_arguments_to_string truth directly",
            path.display()
        );
    }
}

#[test]
fn shared_tooling_deletion_gate_removed_tool_result_value_wrappers() {
    let retired_path = crate_src_path("hub_semantic_mapper_chat.rs");
    assert!(
        !retired_path.exists(),
        "retired hub_semantic_mapper_chat.rs must stay physically deleted: {}",
        retired_path.display()
    );
    for relative in ["req_outbound_stage3_compat/universal_shape_filter.rs"] {
        let path = crate_src_path(relative);
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn normalize_tool_content(content: &Value) -> String {")
                && !source.contains("fn normalize_tool_content(value: Option<&Value>) -> String {"),
            "local normalize_tool_content wrapper still present in {}",
            path.display()
        );
        assert!(
            source.contains("normalize_tool_result_value"),
            "{} must use shared normalize_tool_result_value truth directly",
            path.display()
        );
    }
}
