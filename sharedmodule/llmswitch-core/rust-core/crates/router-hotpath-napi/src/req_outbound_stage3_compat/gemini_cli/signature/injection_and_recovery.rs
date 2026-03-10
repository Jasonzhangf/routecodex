fn inject_antigravity_thought_signature(request_node: &mut Map<String, Value>, signature: &str) {
    if signature.trim().is_empty() {
        return;
    }
    let Some(contents) = request_node.get("contents").and_then(|v| v.as_array()) else {
        return;
    };
    let mut next_contents: Vec<Value> = Vec::new();
    for item in contents {
        let Some(item_obj) = item.as_object() else {
            next_contents.push(item.clone());
            continue;
        };
        let mut item_next = item_obj.clone();
        let Some(parts) = item_next.get("parts").and_then(|v| v.as_array()) else {
            next_contents.push(Value::Object(item_next));
            continue;
        };
        let mut next_parts: Vec<Value> = Vec::new();
        for part in parts {
            let Some(part_obj) = part.as_object() else {
                next_parts.push(part.clone());
                continue;
            };
            let mut part_next = part_obj.clone();
            if part_next
                .get("functionCall")
                .and_then(|v| v.as_object())
                .is_some()
                && should_treat_as_missing_thought_signature(part_next.get("thoughtSignature"))
            {
                part_next.insert(
                    "thoughtSignature".to_string(),
                    Value::String(signature.trim().to_string()),
                );
            }
            next_parts.push(Value::Object(part_next));
        }
        item_next.insert("parts".to_string(), Value::Array(next_parts));
        next_contents.push(Value::Object(item_next));
    }
    request_node.insert("contents".to_string(), Value::Array(next_contents));
}

fn inject_antigravity_thought_signature_in_value(value: &mut Value, signature: &str) {
    match value {
        Value::Object(map) => {
            inject_antigravity_thought_signature(map, signature);
            for child in map.values_mut() {
                inject_antigravity_thought_signature_in_value(child, signature);
            }
        }
        Value::Array(rows) => {
            for row in rows {
                inject_antigravity_thought_signature_in_value(row, signature);
            }
        }
        _ => {}
    }
}

fn strip_antigravity_thought_signatures(request_node: &mut Map<String, Value>) {
    let contents = request_node
        .get_mut("contents")
        .and_then(|v| v.as_array_mut());
    let Some(contents) = contents else {
        return;
    };
    for entry in contents.iter_mut() {
        let Some(entry_obj) = entry.as_object_mut() else {
            continue;
        };
        let parts = entry_obj.get_mut("parts").and_then(|v| v.as_array_mut());
        let Some(parts) = parts else {
            continue;
        };
        for part in parts.iter_mut() {
            let Some(part_obj) = part.as_object_mut() else {
                continue;
            };
            part_obj.remove("thoughtSignature");
            part_obj.remove("thought_signature");
        }
    }
}

fn inject_signature_recovery_prompt(request_node: &mut Map<String, Value>) {
    let contents = request_node
        .get_mut("contents")
        .and_then(|v| v.as_array_mut());
    let Some(contents) = contents else {
        return;
    };
    if contents.is_empty() {
        return;
    }
    let Some(last) = contents.last_mut().and_then(|v| v.as_object_mut()) else {
        return;
    };
    if !last
        .get("parts")
        .map(|v| v.is_array())
        .unwrap_or(false)
    {
        last.insert("parts".to_string(), Value::Array(Vec::new()));
    }
    let Some(parts) = last.get_mut("parts").and_then(|v| v.as_array_mut()) else {
        return;
    };
    let already_injected = parts.iter().any(|part| {
        part.as_object()
            .and_then(|obj| obj.get("text"))
            .and_then(|v| v.as_str())
            .map(|text| text.contains("[System Recovery]"))
            .unwrap_or(false)
    });
    if already_injected {
        return;
    }
    parts.push(json!({
        "text": ANTIGRAVITY_SIGNATURE_RECOVERY_PROMPT
    }));
}

fn apply_antigravity_signature_recovery(
    request_node: &mut Map<String, Value>,
    adapter_context: &AdapterContext,
    request_id_hint: Option<&Value>,
) -> bool {
    if !should_enable_signature_recovery(adapter_context) {
        return false;
    }

    let alias_key = resolve_antigravity_alias_key(adapter_context, request_id_hint);
    let original_session_id =
        extract_antigravity_gemini_session_id(&Value::Object(request_node.clone()));
    let message_count = request_node
        .get("contents")
        .and_then(|v| v.as_array())
        .map(|rows| rows.len() as i64)
        .filter(|v| *v > 0)
        .unwrap_or(1);

    strip_antigravity_thought_signatures(request_node);
    inject_signature_recovery_prompt(request_node);

    let keys = [
        adapter_context.request_id.as_ref(),
        adapter_context.client_request_id.as_ref(),
        adapter_context.group_request_id.as_ref(),
    ];
    for key in keys.into_iter().flatten() {
        cache_antigravity_request_session_meta(key, &alias_key, &original_session_id, message_count);
    }

    true
}

fn prepare_antigravity_signature_from_root(
    root: &Map<String, Value>,
    adapter_context: &AdapterContext,
) -> Option<String> {
    let request_node = find_gemini_contents_node_in_map(root).cloned().unwrap_or_default();
    if !should_enable_antigravity_signature(root, &request_node, adapter_context) {
        return None;
    }

    let alias_key = resolve_antigravity_alias_key(adapter_context, root.get("requestId"));
    let session_payload = Value::Object(request_node.clone());
    let original_session_id = extract_antigravity_gemini_session_id(&session_payload);
    let message_count = request_node
        .get("contents")
        .and_then(|v| v.as_array())
        .map(|rows| rows.len() as i64)
        .filter(|v| *v > 0)
        .unwrap_or(1);

    let mut effective_session_id = original_session_id.clone();
    let mut used_leased_session = false;
    let mut lookup = lookup_antigravity_session_signature(&alias_key, &effective_session_id)
        .or_else(|| {
            lookup_antigravity_session_signature(ANTIGRAVITY_GLOBAL_ALIAS_KEY, &effective_session_id)
        });
    if lookup.is_none() {
        if let Some(leased_sid) = get_latest_signature_session_id_for_alias(&alias_key) {
            let leased_trimmed = leased_sid.trim();
            if !leased_trimmed.is_empty() && leased_trimmed != effective_session_id {
                let leased_lookup =
                    lookup_antigravity_session_signature(&alias_key, leased_trimmed).or_else(|| {
                        lookup_antigravity_session_signature(
                            ANTIGRAVITY_GLOBAL_ALIAS_KEY,
                            leased_trimmed,
                        )
                    });
                if leased_lookup.is_some() {
                    effective_session_id = leased_trimmed.to_string();
                    lookup = leased_lookup;
                    used_leased_session = true;
                }
            }
        }
    }

    let keys = [
        adapter_context.request_id.as_ref(),
        adapter_context.client_request_id.as_ref(),
        adapter_context.group_request_id.as_ref(),
    ];
    for key in keys.into_iter().flatten() {
        cache_antigravity_request_session_meta(key, &alias_key, &effective_session_id, message_count);
    }

    if let Some(found) = lookup {
        if !used_leased_session && message_count > 0 && message_count < found.message_count {
            clear_antigravity_session_signature(&alias_key, &effective_session_id);
            mark_antigravity_session_signature_rewind(&alias_key, &effective_session_id, message_count);
            clear_antigravity_session_signature(ANTIGRAVITY_GLOBAL_ALIAS_KEY, &effective_session_id);
            mark_antigravity_session_signature_rewind(
                ANTIGRAVITY_GLOBAL_ALIAS_KEY,
                &effective_session_id,
                message_count,
            );
            return None;
        }
        return Some(found.signature);
    }

    None
}
