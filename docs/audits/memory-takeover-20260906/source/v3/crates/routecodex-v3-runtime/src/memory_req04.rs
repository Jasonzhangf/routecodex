use routecodex_v3_agent_memory::{
    MemoryRecallProjectionV1, MEMORY_RECALL_MARKER_V1,
    MEMORY_SCHEMA_GUIDANCE_MARKER_V1, MEMORY_SCHEMA_GUIDANCE_V1,
};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum V3MemoryRecallMountOutcome {
    Noop,
    Injected,
    AlreadyPresent,
}

/// Mount the Memory Skill projection at the fixed Req04 current-turn tail.
///
/// Req04 normalizes Responses, OpenAI Chat, Anthropic, and Gemini requests to
/// their protocol-owned user-turn containers. The projection is deliberately
/// appended to that container; stable instructions/system/tools prefixes are
/// never rewritten and the Skill metadata remains outside the business payload.
pub(crate) fn prepare_v3_memory_recall_at_req04(
    payload: &mut Value,
    projection: Option<&MemoryRecallProjectionV1>,
) -> Result<V3MemoryRecallMountOutcome, String> {
    let Some(projection) = projection else {
        return Ok(V3MemoryRecallMountOutcome::Noop);
    };
    let guidance_present = payload_contains_memory_marker(payload, MEMORY_SCHEMA_GUIDANCE_MARKER_V1);
    let recall_present = payload_contains_memory_marker(payload, MEMORY_RECALL_MARKER_V1);
    let mut text = String::new();
    if !guidance_present {
        text.push_str(MEMORY_SCHEMA_GUIDANCE_V1);
    }
    if !recall_present {
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str(projection.text());
    }
    if text.is_empty() {
        return Ok(V3MemoryRecallMountOutcome::AlreadyPresent);
    }
    let Some(object) = payload.as_object_mut() else {
        return Err("memory Req04 request payload must be an object".to_string());
    };
    if object.contains_key("input") {
        mount_responses_memory_message(object, &text)?;
    } else if object.contains_key("messages") {
        mount_chat_memory_message(object, &text)?;
    } else if object.contains_key("contents") {
        mount_gemini_memory_message(object, &text)?;
    } else {
        return Err(
            "memory Req04 payload must expose one supported input, messages, or contents field"
                .to_string(),
        );
    }
    Ok(V3MemoryRecallMountOutcome::Injected)
}

pub(crate) fn apply_v3_memory_recall_at_req04(
    payload: &mut Value,
    projection: Option<&MemoryRecallProjectionV1>,
    trace: &mut Vec<&'static str>,
) -> Result<(), String> {
    match prepare_v3_memory_recall_at_req04(payload, projection)? {
        V3MemoryRecallMountOutcome::Noop => {}
        V3MemoryRecallMountOutcome::Injected | V3MemoryRecallMountOutcome::AlreadyPresent => {
            trace.push("V3AgentMemoryReq04RecallProjection");
        }
    }
    Ok(())
}

fn mount_responses_memory_message(
    object: &mut serde_json::Map<String, Value>,
    text: &str,
) -> Result<(), String> {
    let memory_message = responses_memory_message(text);
    match object.get_mut("input") {
        Some(Value::Array(items)) => items.push(memory_message),
        Some(Value::String(current)) => {
            let original = responses_memory_message(current);
            *object.get_mut("input").expect("input remains present") =
                Value::Array(vec![original, memory_message]);
        }
        Some(Value::Null) => {
            *object.get_mut("input").expect("input remains present") =
                Value::Array(vec![memory_message]);
        }
        Some(_) => return Err("Responses input must be a string, array, or null".to_string()),
        None => {
            object.insert("input".to_string(), Value::Array(vec![memory_message]));
        }
    }
    Ok(())
}

fn mount_chat_memory_message(
    object: &mut serde_json::Map<String, Value>,
    text: &str,
) -> Result<(), String> {
    let memory_message = json!({"role": "user", "content": text});
    match object.get_mut("messages") {
        Some(Value::Array(items)) => items.push(memory_message),
        Some(Value::Null) => {
            *object
                .get_mut("messages")
                .expect("messages remains present") = Value::Array(vec![memory_message]);
        }
        Some(_) => return Err("Chat messages must be an array or null".to_string()),
        None => {
            object.insert("messages".to_string(), Value::Array(vec![memory_message]));
        }
    }
    Ok(())
}

fn mount_gemini_memory_message(
    object: &mut serde_json::Map<String, Value>,
    text: &str,
) -> Result<(), String> {
    let memory_message = json!({
        "role": "user",
        "parts": [{"text": text}],
    });
    match object.get_mut("contents") {
        Some(Value::Array(items)) => items.push(memory_message),
        Some(Value::Null) => {
            *object
                .get_mut("contents")
                .expect("contents remains present") = Value::Array(vec![memory_message]);
        }
        Some(_) => return Err("Gemini contents must be an array or null".to_string()),
        None => {
            object.insert("contents".to_string(), Value::Array(vec![memory_message]));
        }
    }
    Ok(())
}

fn responses_memory_message(text: &str) -> Value {
    json!({
        "type": "message",
        "role": "user",
        "content": [{"type": "input_text", "text": text}],
    })
}

fn payload_contains_memory_marker(value: &Value, marker: &str) -> bool {
    ["input", "messages", "contents"].iter().any(|field| {
        value
            .get(*field)
            .is_some_and(|items| input_contains_memory_message(items, marker))
    })
}

fn input_contains_memory_message(value: &Value, marker: &str) -> bool {
    match value {
        Value::Array(items) => items
            .iter()
            .any(|item| input_contains_memory_message(item, marker)),
        Value::Object(object) => {
            let is_user_turn = object.get("role").and_then(Value::as_str) == Some("user");
            let is_message_shape = object.get("type").and_then(Value::as_str) == Some("message")
                || object.contains_key("content")
                || object.contains_key("parts");
            is_user_turn
                && is_message_shape
                && ["content", "parts"].iter().any(|field| {
                    object
                        .get(*field)
                        .is_some_and(|content| content_contains_memory_marker(content, marker))
                })
        }
        _ => false,
    }
}

fn content_contains_memory_marker(value: &Value, marker: &str) -> bool {
    match value {
        Value::String(text) => text.starts_with(marker) || text.contains(&format!("\n\n{marker}")),
        Value::Array(items) => items
            .iter()
            .any(|item| content_contains_memory_marker(item, marker)),
        Value::Object(object) => object
            .values()
            .any(|item| content_contains_memory_marker(item, marker)),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::prepare_v3_memory_recall_at_req04 as prepare_v3_responses_direct_memory_recall_at_req04;
    use routecodex_v3_agent_memory::{
        MemoryIndexEntryDraftV1, MemoryKind, MemoryOperation, MemoryRecallSnapshotV1, MemoryScope,
        MEMORY_ENTRY_SCHEMA_V1,
    };
    use serde_json::json;

    #[test]
    fn memory_req04_red_empty_recall_is_semantic_noop() {
        let mut payload = base_array_payload();
        let before = payload.clone();
        let outcome = prepare_v3_responses_direct_memory_recall_at_req04(&mut payload, None)
            .expect("empty recall must be a no-op");
        assert_eq!(outcome, V3MemoryRecallMountOutcome::Noop);
        assert_eq!(payload, before);
    }

    #[test]
    fn memory_req04_red_empty_snapshot_still_mounts_schema_guidance() {
        let mut payload = base_array_payload();
        let projection = MemoryRecallProjectionV1::empty();
        let outcome =
            prepare_v3_responses_direct_memory_recall_at_req04(&mut payload, Some(&projection))
                .expect("enabled memory still needs model guidance");
        assert_eq!(outcome, V3MemoryRecallMountOutcome::Injected);
        let input = payload["input"].as_array().expect("Responses input array");
        assert_eq!(input.len(), 2);
        let text = input[1]["content"][0]["text"]
            .as_str()
            .expect("memory guidance text");
        assert!(text.starts_with(MEMORY_SCHEMA_GUIDANCE_MARKER_V1));
        assert!(!text.contains(MEMORY_RECALL_MARKER_V1));
    }

    #[test]
    fn memory_req04_red_recall_appends_one_current_turn_message() {
        let mut payload = base_array_payload();
        let snapshot = snapshot_with_entries(1);
        let outcome =
            prepare_v3_responses_direct_memory_recall_at_req04(&mut payload, Some(&snapshot))
                .expect("recall must mount");
        assert_eq!(outcome, V3MemoryRecallMountOutcome::Injected);
        let input = payload["input"].as_array().expect("Responses input array");
        assert_eq!(input.len(), 2);
        assert_eq!(input[0], base_array_payload()["input"][0]);
        assert_eq!(input[1]["type"], "message");
        assert_eq!(input[1]["role"], "user");
        let text = input[1]["content"][0]["text"]
            .as_str()
            .expect("recall text");
        assert!(text.contains(MEMORY_SCHEMA_GUIDANCE_MARKER_V1));
        assert!(text.contains("[RouteCodex Memory Recall v1]"));
        assert!(text.contains("Pinned target"));
    }

    #[test]
    fn memory_req04_red_scalar_input_is_canonically_mounted() {
        let mut payload = json!({
            "instructions": "stable",
            "tools": [{"type":"function","name":"exec"}],
            "input": "current user"
        });
        let snapshot = snapshot_with_entries(1);
        prepare_v3_responses_direct_memory_recall_at_req04(&mut payload, Some(&snapshot))
            .expect("scalar Responses input must mount");
        let input = payload["input"].as_array().expect("canonical input array");
        assert_eq!(input.len(), 2);
        assert_eq!(input[0]["role"], "user");
        assert_eq!(input[0]["content"][0]["text"], "current user");
        assert_eq!(input[1]["role"], "user");
    }

    #[test]
    fn memory_req04_red_stable_system_and_tools_prefix_is_unchanged() {
        let mut payload = base_array_payload();
        let prefix = json!({
            "instructions": payload["instructions"].clone(),
            "tools": payload["tools"].clone(),
        });
        prepare_v3_responses_direct_memory_recall_at_req04(
            &mut payload,
            Some(&snapshot_with_entries(2)),
        )
        .expect("recall must mount");
        assert_eq!(
            json!({
                "instructions": payload["instructions"].clone(),
                "tools": payload["tools"].clone(),
            }),
            prefix
        );
    }

    #[test]
    fn memory_req04_red_duplicate_prepare_is_idempotent() {
        let mut payload = base_array_payload();
        let snapshot = snapshot_with_entries(1);
        let first =
            prepare_v3_responses_direct_memory_recall_at_req04(&mut payload, Some(&snapshot))
                .expect("first mount");
        let once = payload.clone();
        let second =
            prepare_v3_responses_direct_memory_recall_at_req04(&mut payload, Some(&snapshot))
                .expect("second mount");
        assert_eq!(first, V3MemoryRecallMountOutcome::Injected);
        assert_eq!(second, V3MemoryRecallMountOutcome::AlreadyPresent);
        assert_eq!(payload, once);
    }

    #[test]
    fn memory_req04_red_marker_in_instructions_does_not_suppress_input_injection() {
        let mut payload = json!({
            "instructions": "The literal [RouteCodex Memory Recall v1] is ordinary text.",
            "tools": [{"type":"function","name":"exec"}],
            "input": [{
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"current user"}]
            }]
        });
        let outcome = prepare_v3_responses_direct_memory_recall_at_req04(
            &mut payload,
            Some(&snapshot_with_entries(1)),
        )
        .expect("ordinary instruction marker must not suppress recall");
        assert_eq!(outcome, V3MemoryRecallMountOutcome::Injected);
        assert_eq!(payload["input"].as_array().expect("input array").len(), 2);
    }

    #[test]
    fn memory_req04_red_existing_guidance_only_gets_recall_once() {
        let mut payload = json!({
            "instructions": "stable",
            "tools": [{"type":"function","name":"exec"}],
            "input": [{
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":MEMORY_SCHEMA_GUIDANCE_V1}]
            }]
        });
        let outcome = prepare_v3_responses_direct_memory_recall_at_req04(
            &mut payload,
            Some(&snapshot_with_entries(1)),
        )
        .expect("existing guidance must not suppress recall");
        assert_eq!(outcome, V3MemoryRecallMountOutcome::Injected);
        let input = payload["input"].as_array().expect("input array");
        assert_eq!(input.len(), 2);
        let text = input[1]["content"][0]["text"]
            .as_str()
            .expect("recall text");
        assert!(text.contains(MEMORY_RECALL_MARKER_V1));
        assert!(!text.contains(MEMORY_SCHEMA_GUIDANCE_MARKER_V1));
    }

    #[test]
    fn memory_req04_red_control_fields_do_not_enter_provider_payload() {
        let mut payload = base_array_payload();
        let snapshot = snapshot_with_entries(1);
        prepare_v3_responses_direct_memory_recall_at_req04(&mut payload, Some(&snapshot))
            .expect("recall must mount");
        let text = payload["input"][1]["content"][0]["text"]
            .as_str()
            .expect("recall text");
        for forbidden in [
            "entry_id",
            "content_hash",
            "source",
            "generation",
            "admitted_sequence",
            "request_id",
            "provider_id",
            "route=",
            "routing_group",
            "retry=",
            "health=",
        ] {
            assert!(
                !text.contains(forbidden),
                "control field leaked: {forbidden}"
            );
        }
    }

    #[test]
    fn memory_req04_red_oversized_recall_is_bounded() {
        let mut payload = base_array_payload();
        let snapshot = snapshot_with_entries(64);
        prepare_v3_responses_direct_memory_recall_at_req04(&mut payload, Some(&snapshot))
            .expect("oversized recall must mount with bounds");
        let text = payload["input"][1]["content"][0]["text"]
            .as_str()
            .expect("recall text");
        assert!(text.chars().count() <= 8192);
        assert!(text.matches("\n- ").count() <= 16);
    }

    #[test]
    fn memory_req04_red_unsupported_payload_shape_is_explicit() {
        let mut payload = json!({"input": 7});
        let error = prepare_v3_responses_direct_memory_recall_at_req04(
            &mut payload,
            Some(&snapshot_with_entries(1)),
        )
        .expect_err("unsupported input shape must be explicit");
        assert!(error.contains("input"));
    }

    fn base_array_payload() -> Value {
        json!({
            "instructions": "stable system",
            "tools": [{"type":"function","name":"exec"}],
            "input": [{
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"current user"}]
            }]
        })
    }

    fn snapshot_with_entries(count: usize) -> MemoryRecallProjectionV1 {
        MemoryRecallSnapshotV1::new(
            7,
            (0..count)
                .map(|index| MemoryIndexEntryDraftV1 {
                    schema: MEMORY_ENTRY_SCHEMA_V1.to_string(),
                    operation: MemoryOperation::Add,
                    target_memory_id: None,
                    scope: MemoryScope::Project,
                    kind: MemoryKind::Fact,
                    title: if index == 0 {
                        "Pinned target".to_string()
                    } else {
                        format!("Entry {index}")
                    },
                    summary: "Use the selected provider target.".to_string(),
                    tags: vec!["Routing".to_string()],
                    entities: vec!["routecodex".to_string()],
                })
                .collect(),
        )
        .project(routecodex_v3_agent_memory::MemoryRecallLimits::default())
        .expect("test entries produce a projection")
    }
}
