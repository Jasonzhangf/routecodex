use routecodex_v3_agent_memory::{
    capture_responses_chat, capture_responses_json, publish_l3_entry, render_l3_markdown,
    stable_host_id, strip_memory_envelope_from_responses_payload, strip_memory_envelope_from_text,
    MemoryTerminalKind, ResponsesSseAccumulator, MAX_BYTES_PER_ENTRY, MAX_BYTES_PER_RESPONSE,
    MAX_ENTRIES_PER_RESPONSE, ROUTE_CODEX_MEMORY_RAW_ENTRY_V1,
};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

fn unique_root(tag: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "memory-raw-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

fn host_id() -> String {
    format!("rcc-memory-host-{}", std::process::id())
}

fn valid_entry() -> Value {
    json!({
        "schema": ROUTE_CODEX_MEMORY_RAW_ENTRY_V1,
        "category": "knowledge",
        "title": "Raw capture contract is strict",
        "content": "Memory envelopes must sit at the end of the assistant output_text.",
        "tags": ["raw-capture", "responses"]
    })
}

#[test]
fn plain_text_response_passes_through_without_capture() {
    let body = json!({
        "id": "resp_plain", "status": "completed",
        "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Just a normal assistant answer without memory."}]}]
    });
    let report = capture_responses_json(&body, &host_id(), "sample/plain").unwrap();
    assert!(report.captured.is_empty());
    assert!(report.diagnostics.is_empty());
    let mut cloned = body.clone();
    strip_memory_envelope_from_responses_payload(&mut cloned, &report);
    assert_eq!(
        cloned["output"][0]["content"][0]["text"],
        "Just a normal assistant answer without memory."
    );
}

#[test]
fn end_turn_response_with_memory_captures_and_strips_atomically() {
    let envelope = json!({"memory": {"entries": [valid_entry()]}});
    let envelope_str = serde_json::to_string(&envelope).unwrap();
    let body = json!({
        "id": "resp_with_memory", "status": "completed",
        "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": format!("Here is the answer. {envelope_str}")}]}]
    });
    let report = capture_responses_json(&body, &host_id(), "sample/end-turn").unwrap();
    assert_eq!(report.captured.len(), 1);
    assert_eq!(
        report.captured[0].entry.title,
        "Raw capture contract is strict"
    );
    assert_eq!(report.captured[0].source_ref, "sample/end-turn");
    let mut stripped = body.clone();
    strip_memory_envelope_from_responses_payload(&mut stripped, &report);
    let text = stripped["output"][0]["content"][0]["text"]
        .as_str()
        .unwrap();
    assert_eq!(text, "Here is the answer.");
}

#[test]
fn malformed_envelope_diagnoses_and_strips_without_blocking_parent() {
    let body = json!({
        "status": "completed",
        "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Preceeding prose {\"memory\":{\"entries\":[{\"schema\":\"not-the-schema\",\"category\":\"knowledge\",\"title\":\"Bad\",\"content\":\"x\"}]}}"}]}]
    });
    let report = capture_responses_json(&body, &host_id(), "sample/bad-schema").unwrap();
    assert!(report.captured.is_empty());
    assert!(report
        .diagnostics
        .iter()
        .any(|d| d.code == "memory_entry_schema_invalid"));
    let mut stripped = body.clone();
    strip_memory_envelope_from_responses_payload(&mut stripped, &report);
    assert_eq!(
        stripped["output"][0]["content"][0]["text"],
        "Preceeding prose"
    );
}

#[test]
fn sse_delta_stream_strips_memory_across_chunks_with_zero_residue() {
    let envelope = json!({"memory": {"entries": [json!({
        "schema": ROUTE_CODEX_MEMORY_RAW_ENTRY_V1,
        "category": "path",
        "title": "Captured across chunks",
        "content": "Delta chunks must yield one combined envelope.",
        "tags": ["sse"]
    })]}});
    let envelope_str = serde_json::to_string(&envelope).unwrap();
    let mut chars = envelope_str.chars();
    let head: String = chars.by_ref().take(envelope_str.len() / 3).collect();
    let mid: String = chars.by_ref().take(envelope_str.len() / 3).collect();
    let tail: String = chars.by_ref().collect();
    let mut accumulator = ResponsesSseAccumulator::new();
    accumulator
        .feed_event(&json!({"type": "response.output_text.delta", "delta": "Preceeding text. "}))
        .unwrap();
    accumulator
        .feed_event(&json!({"type": "response.output_text.delta", "delta": head}))
        .unwrap();
    accumulator
        .feed_event(&json!({"type": "response.output_text.delta", "delta": mid}))
        .unwrap();
    accumulator
        .feed_event(&json!({"type": "response.output_text.delta", "delta": tail}))
        .unwrap();
    accumulator
        .feed_event(&json!({"type": "response.output_text.done", "text": ""}))
        .unwrap();
    accumulator.feed_event(&json!({"type": "response.completed", "response": {"id": "resp_sse", "status": "completed", "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": format!("Preceeding text. {envelope_str}")}]}]}})).unwrap();
    assert_eq!(
        accumulator.terminal_kind(),
        Some(MemoryTerminalKind::ResponsesCompletedEvent)
    );
    let report = accumulator.finalize(&host_id(), "sample/sse-cross-chunk");
    assert_eq!(report.captured.len(), 1);
    assert!(report.diagnostics.is_empty());
    let full_text = format!("Preceeding text. {envelope_str}");
    let stripped = strip_memory_envelope_from_text(&full_text, &report);
    assert_eq!(stripped, "Preceeding text.");
}

#[test]
fn sse_accumulator_keeps_output_and_content_units_isolated() {
    let envelope = serde_json::to_string(&json!({"memory": {"entries": [valid_entry()]}})).unwrap();
    let mut accumulator = ResponsesSseAccumulator::new();
    accumulator
        .feed_event(&json!({
            "type": "response.output_text.delta",
            "output_index": 0,
            "content_index": 0,
            "delta": format!("First answer. {envelope}")
        }))
        .unwrap();
    accumulator
        .feed_event(&json!({
            "type": "response.output_text.delta",
            "output_index": 1,
            "content_index": 0,
            "delta": "Second answer."
        }))
        .unwrap();
    accumulator
        .feed_event(&json!({
            "type": "response.output_text.done",
            "output_index": 0,
            "content_index": 0,
            "text": format!("First answer. {envelope}")
        }))
        .unwrap();
    accumulator
        .feed_event(&json!({
            "type": "response.output_text.done",
            "output_index": 1,
            "content_index": 0,
            "text": "Second answer."
        }))
        .unwrap();
    accumulator
        .feed_event(&json!({
            "type": "response.completed",
            "response": {
                "status": "completed",
                "output": [
                    {"type": "message", "content": [{"type": "output_text", "text": format!("First answer. {envelope}")}]},
                    {"type": "message", "content": [{"type": "output_text", "text": "Second answer."}]}
                ]
            }
        }))
        .unwrap();

    let texts = accumulator.canonical_output_texts();
    assert_eq!(texts.len(), 2);
    assert_eq!(texts[0].0, 0);
    assert_eq!(texts[0].1, 0);
    assert!(texts[0].2.contains(&envelope));
    assert_eq!(texts[1].0, 1);
    assert_eq!(texts[1].1, 0);
    assert_eq!(texts[1].2, "Second answer.");
    let report = accumulator.finalize(&host_id(), "sample/sse-multi-output");
    assert_eq!(report.captured.len(), 1);
}

#[test]
fn capture_saturates_at_max_entries_and_max_bytes() {
    let mut envelope = json!({"memory": {"entries": []}});
    let entries = envelope["memory"]["entries"].as_array_mut().unwrap();
    for i in 0..(MAX_ENTRIES_PER_RESPONSE + 4) {
        entries.push(json!({
            "schema": ROUTE_CODEX_MEMORY_RAW_ENTRY_V1,
            "category": "knowledge", "title": format!("Entry {i}"), "content": format!("Body {i}"), "tags": []
        }));
    }
    let envelope_str = serde_json::to_string(&envelope).unwrap();
    let body = json!({"status": "completed", "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": format!("Trailing prose {envelope_str}")}]}]});
    let report = capture_responses_json(&body, &host_id(), "sample/overflow").unwrap();
    assert_eq!(report.captured.len(), MAX_ENTRIES_PER_RESPONSE);
    assert!(report
        .diagnostics
        .iter()
        .any(|d| d.code == "memory_entry_overflow"));
}

#[test]
fn oversized_content_rejected_without_losing_other_entries() {
    let big = "x".repeat(MAX_BYTES_PER_ENTRY + 32);
    let envelope = json!({"memory": {"entries": [
        valid_entry(),
        json!({"schema": ROUTE_CODEX_MEMORY_RAW_ENTRY_V1, "category": "knowledge", "title": "Drop", "content": big, "tags": []})
    ]}});
    let envelope_str = serde_json::to_string(&envelope).unwrap();
    let body = json!({"status": "completed", "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": format!("Prose {envelope_str}")}]}]});
    let report = capture_responses_json(&body, &host_id(), "sample/oversized").unwrap();
    assert_eq!(report.captured.len(), 1);
    assert_eq!(
        report.captured[0].entry.title,
        "Raw capture contract is strict"
    );
    assert!(report
        .diagnostics
        .iter()
        .any(|d| d.code == "memory_entry_invalid"));
}

#[test]
fn chat_completion_with_memory_captures_chat_response() {
    let envelope = json!({"memory": {"entries": [json!({
        "schema": ROUTE_CODEX_MEMORY_RAW_ENTRY_V1,
        "category": "lesson",
        "title": "Chat lesson",
        "content": "Chat path mirrors Responses grammar.",
        "tags": ["chat"]
    })]}});
    let envelope_str = serde_json::to_string(&envelope).unwrap();
    let body = json!({"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": format!("Preceeding chat answer. {envelope_str}")}}]});
    let report = capture_responses_chat(&body, &host_id(), "sample/chat-stop").unwrap();
    assert_eq!(report.captured.len(), 1);
    assert_eq!(
        strip_memory_envelope_from_text(
            &body["choices"][0]["message"]["content"].as_str().unwrap(),
            &report
        ),
        "Preceeding chat answer."
    );
}

#[test]
fn published_markdown_matches_project_memory_l3_marker_contract() {
    let envelope = json!({"memory": {"entries": [json!({
        "schema": ROUTE_CODEX_MEMORY_RAW_ENTRY_V1,
        "category": "knowledge",
        "title": "Marker contract",
        "content": "Project-memory:v1 marker + metadata id == filename.",
        "tags": ["marker", "appsdk"]
    })]}});
    let envelope_str = serde_json::to_string(&envelope).unwrap();
    let body = json!({"status": "completed", "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": format!("Prose {envelope_str}")}]}]});
    let host = host_id();
    let report = capture_responses_json(&body, &host, "sample/marker").unwrap();
    let entry = report.captured.first().unwrap();
    let markdown = render_l3_markdown(entry);
    let metadata_line = markdown
        .lines()
        .find(|line| line.starts_with("<!-- project-memory:v1 "))
        .unwrap();
    let meta_json = metadata_line
        .trim_start_matches("<!-- project-memory:v1 ")
        .trim_end_matches(" -->");
    let meta: Value = serde_json::from_str(meta_json).unwrap();
    assert_eq!(meta["id"].as_str(), Some(entry.host_id.as_str()));
    let root = unique_root("publish");
    let path = publish_l3_entry(&root, entry).unwrap();
    assert_eq!(
        path.file_name().and_then(|x| x.to_str()),
        Some(format!("{}.md", entry.host_id).as_str())
    );
    let on_disk = fs::read_to_string(&path).unwrap();
    assert_eq!(on_disk, markdown);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn multiple_entries_publish_unique_l3_files() {
    let envelope = json!({"memory": {"entries": [
        json!({"schema": ROUTE_CODEX_MEMORY_RAW_ENTRY_V1, "category": "plan", "title": "First", "content": "One", "tags": []}),
        json!({"schema": ROUTE_CODEX_MEMORY_RAW_ENTRY_V1, "category": "path", "title": "Second", "content": "Two", "tags": []})
    ]}});
    let envelope_str = serde_json::to_string(&envelope).unwrap();
    let body = json!({"status": "completed", "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": format!("Prose {envelope_str}")}]}]});
    let report = capture_responses_json(&body, &host_id(), "sample/multi").unwrap();
    assert_eq!(report.captured.len(), 2);
    assert_ne!(report.captured[0].host_id, report.captured[1].host_id);
    let root = unique_root("multi-publish");
    let first = publish_l3_entry(&root, &report.captured[0]).unwrap();
    let second = publish_l3_entry(&root, &report.captured[1]).unwrap();
    assert_ne!(first.file_name(), second.file_name());
    fs::remove_dir_all(&root).ok();
}

#[test]
fn long_host_id_and_source_remain_collision_resistant_after_typed_identity() {
    let long = format!("rcc-{}", "a".repeat(96));
    let entries = [
        json!({"schema": ROUTE_CODEX_MEMORY_RAW_ENTRY_V1, "category": "knowledge", "title": "First", "content": "Body one", "tags": []}),
        json!({"schema": ROUTE_CODEX_MEMORY_RAW_ENTRY_V1, "category": "path", "title": "Second", "content": "Body two", "tags": []}),
    ];
    let envelope_str = serde_json::to_string(&json!({"memory": {"entries": entries}})).unwrap();
    let body = json!({"status": "completed", "output": [
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": format!("{envelope_str}")}]},
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": format!("{envelope_str}")}]}
    ]});
    let report = capture_responses_json(&body, &long, "sample/long-host").unwrap();
    assert_eq!(report.captured.len(), 4);
    let mut ids = report
        .captured
        .iter()
        .map(|entry| entry.host_id.clone())
        .collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 4);

    let report_other = capture_responses_json(&body, &long, "sample/other-source").unwrap();
    assert_eq!(report_other.captured.len(), 4);
    assert!(report_other.captured.iter().all(|entry| !report
        .captured
        .iter()
        .any(|other| other.host_id == entry.host_id)));
}

#[test]
fn response_level_byte_budget_spans_output_parts() {
    let entry = || {
        json!({
            "schema": ROUTE_CODEX_MEMORY_RAW_ENTRY_V1,
            "category": "knowledge",
            "title": "Response budget",
            "content": "x".repeat(7000),
            "tags": []
        })
    };
    let envelope_str = serde_json::to_string(&json!({"memory": {"entries": [
        entry(), entry(), entry(), entry(), entry(), entry(), entry(), entry(),
        entry(), entry(), entry(), entry(), entry(), entry(), entry(), entry()
    ]}}))
    .unwrap();
    let body = json!({"status": "completed", "output": [
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": format!("{envelope_str}")}]},
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": format!("{envelope_str}")}]}
    ]});
    let report = capture_responses_json(&body, &host_id(), "sample/response-bytes").unwrap();
    assert!(report.captured.len() < 16);
    assert!(report.captured.len() >= 8);
    assert!(report
        .diagnostics
        .iter()
        .any(|d| d.code == "memory_entry_overflow"));
    let captured_bytes: usize = report
        .captured
        .iter()
        .map(|entry| serde_json::to_vec(&entry.entry).unwrap_or_default().len())
        .sum();
    assert!(captured_bytes <= MAX_BYTES_PER_RESPONSE);
}

#[test]
fn nested_memory_inside_content_uses_outer_envelope() {
    let inner = json!({"memory": {"entries": []}});
    let envelope = json!({"memory": {"entries": [json!({
        "schema": ROUTE_CODEX_MEMORY_RAW_ENTRY_V1,
        "category": "knowledge",
        "title": "Outer",
        "content": format!("quoted {}", serde_json::to_string(&inner).unwrap())
    })]}});
    let envelope_str = serde_json::to_string(&envelope).unwrap();
    let body = json!({"status": "completed", "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": format!("Prose {envelope_str}")}]}]});
    let report = capture_responses_json(&body, &host_id(), "sample/nested").unwrap();
    assert_eq!(report.captured.len(), 1);
    assert_eq!(report.captured[0].entry.title, "Outer");
    let mut stripped = body.clone();
    strip_memory_envelope_from_responses_payload(&mut stripped, &report);
    assert_eq!(stripped["output"][0]["content"][0]["text"], "Prose");
}

#[test]
fn publish_refuses_to_overwrite_existing_l3_file() {
    let root = unique_root("existing");
    let host = stable_host_id("sample-refuse");
    let placeholder = root.join("memory").join("L3").join(format!("{host}.md"));
    fs::create_dir_all(placeholder.parent().unwrap()).unwrap();
    fs::write(&placeholder, b"existing reviewed memory\n").unwrap();
    let envelope = json!({"memory": {"entries": [valid_entry()]}});
    let envelope_str = serde_json::to_string(&envelope).unwrap();
    let body = json!({"status": "completed", "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": format!("Prose {envelope_str}")}]}]});
    let report = capture_responses_json(&body, &host, "sample/refuse").unwrap();
    let entry = report.captured.first().unwrap();
    let placeholder = root
        .join("memory")
        .join("L3")
        .join(format!("{}.md", entry.host_id));
    fs::write(&placeholder, b"existing reviewed memory\n").unwrap();
    let result = publish_l3_entry(&root, entry);
    assert!(result.is_err());
    assert_eq!(
        fs::read_to_string(&placeholder).unwrap(),
        "existing reviewed memory\n"
    );
    fs::remove_dir_all(&root).ok();
}

#[test]
fn publish_is_idempotent_for_same_id_and_content_but_rejects_conflict() {
    let root = unique_root("idempotent");
    let envelope = json!({"memory": {"entries": [valid_entry()]}});
    let body = json!({"status": "completed", "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": format!("Prose {}", serde_json::to_string(&envelope).unwrap())}]}]});
    let report = capture_responses_json(&body, &host_id(), "sample/idempotent").unwrap();
    let entry = report.captured.first().unwrap();
    let first = publish_l3_entry(&root, entry).unwrap();
    let second = publish_l3_entry(&root, entry).unwrap();
    assert_eq!(first, second);

    let mut conflict = entry.clone();
    conflict.entry.content = "Different content".to_owned();
    assert!(publish_l3_entry(&root, &conflict).is_err());
    fs::remove_dir_all(&root).ok();
}

#[test]
fn terminal_memory_allows_json_whitespace_after_open_brace() {
    let text = format!(
        "Answer. {{ \n  \"memory\" : {{ \"entries\" : [ {} ] }} }}",
        serde_json::to_string(&valid_entry()).unwrap()
    );
    let body = json!({
        "status": "completed",
        "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}]
    });
    let report = capture_responses_json(&body, &host_id(), "sample/whitespace").unwrap();
    assert_eq!(report.captured.len(), 1);
    let mut stripped = body.clone();
    strip_memory_envelope_from_responses_payload(&mut stripped, &report);
    assert_eq!(stripped["output"][0]["content"][0]["text"], "Answer.");
}

#[test]
fn empty_memory_envelope_is_stripped_without_diagnostics() {
    let body = json!({
        "status": "completed",
        "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Answer. {\"memory\":{\"entries\":[]}}"}]}]
    });
    let report = capture_responses_json(&body, &host_id(), "sample/empty").unwrap();
    assert!(report.captured.is_empty());
    assert!(report.diagnostics.is_empty());
    assert!(report.memory_unit_found);
    let mut stripped = body.clone();
    strip_memory_envelope_from_responses_payload(&mut stripped, &report);
    assert_eq!(stripped["output"][0]["content"][0]["text"], "Answer.");
}

#[test]
fn incomplete_terminal_memory_is_not_silently_stripped() {
    let text = "Answer. {\"memory\":{\"entries\":[";
    let body = json!({
        "status": "completed",
        "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}]
    });
    let report = capture_responses_json(&body, &host_id(), "sample/incomplete").unwrap();
    assert!(report.captured.is_empty());
    assert!(report.diagnostics.is_empty());
    assert!(!report.memory_unit_found);
    assert_eq!(strip_memory_envelope_from_text(text, &report), text);
}

#[test]
fn tool_handoff_and_failed_terminal_do_not_capture() {
    let envelope = json!({"memory": {"entries": [valid_entry()]}});
    let envelope_str = serde_json::to_string(&envelope).unwrap();
    let tool_body = json!({
        "status": "in_progress",
        "output": [
            {"type": "function_call", "call_id": "call_1", "name": "lookup", "arguments": "{}"},
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": format!("Prose {envelope_str}")}]}
        ]
    });
    let report = capture_responses_json(&tool_body, &host_id(), "sample/tool").unwrap();
    assert!(report.captured.is_empty());
    assert!(report.diagnostics.is_empty());
    assert!(!report.memory_unit_found);

    let failed_body = json!({
        "status": "failed",
        "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": format!("Prose {envelope_str}")}]}]
    });
    let report = capture_responses_json(&failed_body, &host_id(), "sample/failed").unwrap();
    assert!(report.captured.is_empty());
    assert!(!report.memory_unit_found);
}

#[test]
fn unknown_envelope_and_entry_fields_diagnose_and_strip() {
    let envelope = json!({"memory": {"entries": [], "extra": true}});
    let envelope_str = serde_json::to_string(&envelope).unwrap();
    let body = json!({"status": "completed", "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": format!("Prose {envelope_str}")}]}]});
    let report = capture_responses_json(&body, &host_id(), "sample/envelope-unknown").unwrap();
    assert!(report
        .diagnostics
        .iter()
        .any(|d| d.code == "memory_envelope_unknown_field"));
    assert!(report.memory_unit_found);
    let mut stripped = body.clone();
    strip_memory_envelope_from_responses_payload(&mut stripped, &report);
    assert_eq!(stripped["output"][0]["content"][0]["text"], "Prose");

    let envelope = json!({"memory": {"entries": [json!({
        "schema": ROUTE_CODEX_MEMORY_RAW_ENTRY_V1,
        "category": "knowledge",
        "title": "Good",
        "content": "Kept",
        "tags": [],
        "extra": true
    }), valid_entry()]}});
    let envelope_str = serde_json::to_string(&envelope).unwrap();
    let body = json!({"status": "completed", "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": format!("Prose {envelope_str}")}]}]});
    let report = capture_responses_json(&body, &host_id(), "sample/entry-unknown").unwrap();
    assert_eq!(report.captured.len(), 1);
    assert_eq!(
        report.captured[0].entry.title,
        "Raw capture contract is strict"
    );
    assert!(report
        .diagnostics
        .iter()
        .any(|d| d.code == "memory_entry_unknown_field"));
    let mut stripped = body.clone();
    strip_memory_envelope_from_responses_payload(&mut stripped, &report);
    assert_eq!(stripped["output"][0]["content"][0]["text"], "Prose");
}

#[test]
fn wrong_type_tags_are_diagnosed() {
    let envelope = json!({"memory": {"entries": [
        json!({"schema": ROUTE_CODEX_MEMORY_RAW_ENTRY_V1, "category": "path", "title": "Bad tags", "content": "Body", "tags": "knowledge"})
    ]}});
    let envelope_str = serde_json::to_string(&envelope).unwrap();
    let body = json!({"status": "completed", "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": format!("Prose {envelope_str}")}]}]});
    let report = capture_responses_json(&body, &host_id(), "sample/tags-type").unwrap();
    assert!(report.captured.is_empty());
    assert!(report
        .diagnostics
        .iter()
        .any(|d| d.code == "memory_entry_invalid"));
    let mut stripped = body.clone();
    strip_memory_envelope_from_responses_payload(&mut stripped, &report);
    assert_eq!(stripped["output"][0]["content"][0]["text"], "Prose");
}

#[test]
fn quoted_code_containing_memory_marker_is_not_scanned() {
    let text = "```json\n{\"memory\":{\"entries\":[]}}\n```\n";
    let body = json!({"status": "completed", "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}]});
    let report = capture_responses_json(&body, &host_id(), "sample/code").unwrap();
    assert!(report.captured.is_empty());
    assert!(report.diagnostics.is_empty());
    assert!(!report.memory_unit_found);
    assert_eq!(strip_memory_envelope_from_text(text, &report), text);
}

#[test]
fn marker_injection_title_is_rejected_but_still_stripped() {
    let envelope = json!({"memory": {"entries": [json!({
        "schema": ROUTE_CODEX_MEMORY_RAW_ENTRY_V1,
        "category": "knowledge",
        "title": "bad --> marker",
        "content": "Body"
    })]}});
    let envelope_str = serde_json::to_string(&envelope).unwrap();
    let body = json!({"status": "completed", "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": format!("Prose {envelope_str}")}]}]});
    let report = capture_responses_json(&body, &host_id(), "sample/injection").unwrap();
    assert!(report.captured.is_empty());
    assert!(report
        .diagnostics
        .iter()
        .any(|d| d.code == "memory_entry_invalid"));
    let mut stripped = body.clone();
    strip_memory_envelope_from_responses_payload(&mut stripped, &report);
    assert_eq!(stripped["output"][0]["content"][0]["text"], "Prose");
}

#[test]
fn repeated_sse_terminal_is_idempotent() {
    let envelope = json!({"memory": {"entries": [valid_entry()]}});
    let envelope_str = serde_json::to_string(&envelope).unwrap();
    let mut accumulator = ResponsesSseAccumulator::new();
    accumulator.feed_event(&json!({"type": "response.output_text.delta", "delta": format!("Prose {envelope_str}")})).unwrap();
    let completed = json!({"type": "response.completed", "response": {"id": "resp_repeat", "status": "completed", "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": format!("Prose {envelope_str}")}]}]}});
    accumulator.feed_event(&completed).unwrap();
    accumulator.feed_event(&completed).unwrap();
    assert_eq!(
        accumulator.terminal_kind(),
        Some(MemoryTerminalKind::ResponsesCompletedEvent)
    );
    let report = accumulator.finalize(&host_id(), "sample/repeat");
    assert_eq!(report.captured.len(), 1);
}

#[test]
fn sse_incomplete_terminal_publishes_nothing_and_does_not_strip() {
    let envelope = json!({"memory": {"entries": [valid_entry()]}});
    let envelope_str = serde_json::to_string(&envelope).unwrap();
    let mut accumulator = ResponsesSseAccumulator::new();
    accumulator.feed_event(&json!({"type": "response.output_text.delta", "delta": format!("Prose {envelope_str}")})).unwrap();
    accumulator
        .feed_event(&json!({"type": "response.incomplete", "status": "incomplete"}))
        .unwrap();
    assert_eq!(accumulator.terminal_kind(), None);
    let report = accumulator.finalize(&host_id(), "sample/incomplete-sse");
    assert!(report.captured.is_empty());
    assert!(!report.memory_unit_found);
    assert_eq!(
        strip_memory_envelope_from_text(&format!("Prose {envelope_str}"), &report),
        format!("Prose {envelope_str}")
    );
}
