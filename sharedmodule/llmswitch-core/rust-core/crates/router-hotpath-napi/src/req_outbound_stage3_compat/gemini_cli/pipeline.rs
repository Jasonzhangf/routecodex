fn apply_claude_thinking_tool_schema_compat_to_root(root: &mut Map<String, Value>) {
    let model = root
        .get("model")
        .and_then(|v| v.as_str())
        .map(|v| v.trim())
        .unwrap_or_default();
    if !model.starts_with("claude-") {
        return;
    }

    let request_is_object = root.get("request").and_then(|v| v.as_object()).is_some();
    let tools = if request_is_object {
        root.get("request")
            .and_then(|v| v.as_object())
            .and_then(|request| request.get("tools"))
            .and_then(|v| v.as_array())
            .cloned()
    } else {
        root.get("tools").and_then(|v| v.as_array()).cloned()
    };
    let Some(tools) = tools else {
        return;
    };

    let mut next_tools: Vec<Value> = Vec::new();
    for entry in tools {
        let Some(entry_obj) = entry.as_object() else {
            next_tools.push(entry);
            continue;
        };
        let Some(decls) = entry_obj
            .get("functionDeclarations")
            .and_then(|v| v.as_array())
            .cloned()
        else {
            next_tools.push(Value::Object(entry_obj.clone()));
            continue;
        };
        let mut next_decls: Vec<Value> = Vec::new();
        for decl in decls {
            let Some(decl_obj) = decl.as_object() else {
                next_decls.push(decl);
                continue;
            };
            let mut next_decl = decl_obj.clone();
            next_decl.insert(
                "parameters".to_string(),
                json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": true
                }),
            );
            next_decl.remove("strict");
            next_decls.push(Value::Object(next_decl));
        }
        let mut tool_node = Map::<String, Value>::new();
        tool_node.insert(
            "functionDeclarations".to_string(),
            Value::Array(next_decls),
        );
        next_tools.push(Value::Object(tool_node));
    }

    if request_is_object {
        if let Some(request) = root.get_mut("request").and_then(|v| v.as_object_mut()) {
            request.insert("tools".to_string(), Value::Array(next_tools));
        }
    } else {
        root.insert("tools".to_string(), Value::Array(next_tools));
    }
}

pub(crate) fn apply_gemini_cli_request_wrap(
    payload: Value,
    adapter_context: &AdapterContext,
) -> Value {
    let Some(root_obj) = payload.as_object() else {
        return payload;
    };

    let mut root = root_obj.clone();
    let existing_request = root
        .get("request")
        .and_then(|v| v.as_object())
        .map(normalize_request_node);
    let mut request_node = existing_request.unwrap_or_default();

    for key in REQUEST_FIELDS {
        if !request_node.contains_key(key) {
            if let Some(value) = root.get(key) {
                request_node.insert(key.to_string(), value.clone());
            }
        }
        root.remove(key);
    }

    for key in ROOT_ONLY_FIELDS {
        request_node.remove(key);
    }

    strip_web_search_tools(&mut request_node);
    normalize_tool_declarations(&mut request_node);
    normalize_function_call_args(&mut request_node);

    let recovered = apply_antigravity_signature_recovery(
        &mut request_node,
        adapter_context,
        root.get("requestId"),
    );
    if !recovered {
        let mut signature_root = root.clone();
        signature_root.insert("request".to_string(), Value::Object(request_node.clone()));
        if let Some(signature) = prepare_antigravity_signature_from_root(&signature_root, adapter_context) {
            inject_antigravity_thought_signature(&mut request_node, &signature);
        }
    }

    request_node.remove("metadata");
    request_node.remove("action");
    request_node.remove("web_search");
    request_node.remove("stream");
    request_node.remove("sessionId");

    root.remove("metadata");
    root.remove("stream");
    root.remove("sessionId");

    if !request_node.is_empty() {
        root.insert("request".to_string(), Value::Object(request_node));
    } else {
        root.remove("request");
    }

    apply_claude_thinking_tool_schema_compat_to_root(&mut root);

    let mut picked = Map::<String, Value>::new();
    for key in GEMINI_CLI_ALLOW_TOP_LEVEL {
        if let Some(value) = root.get(key) {
            picked.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(picked)
}

pub(crate) fn prepare_antigravity_signature_for_gemini_request(
    payload: Value,
    adapter_context: &AdapterContext,
) -> Value {
    let Some(root_obj) = payload.as_object() else {
        return payload;
    };
    let mut root = root_obj.clone();
    let request_id_hint_owned = root.get("requestId").cloned();
    if let Some(request_node) = find_gemini_contents_node_in_map_mut(&mut root) {
        let _ = apply_antigravity_signature_recovery(
            request_node,
            adapter_context,
            request_id_hint_owned.as_ref(),
        );
    }
    if should_enable_signature_recovery(adapter_context) {
        return Value::Object(root);
    }

    let maybe_signature = prepare_antigravity_signature_from_root(&root, adapter_context);
    let Some(signature) = maybe_signature else {
        return Value::Object(root);
    };

    let mut out = Value::Object(root);
    inject_antigravity_thought_signature_in_value(&mut out, &signature);
    out
}

fn resolve_stable_session_id(adapter_context: &AdapterContext) -> Option<String> {
    let candidates = [
        adapter_context.session_id.as_ref(),
        adapter_context.conversation_id.as_ref(),
    ];
    let raw = candidates
        .into_iter()
        .flatten()
        .map(|v| v.trim())
        .find(|v| !v.is_empty())?;
    if raw.to_ascii_lowercase().starts_with("sid-") {
        return Some(raw.to_string());
    }
    None
}

fn should_enable_signature_cache(adapter_context: &AdapterContext) -> bool {
    let protocol = adapter_context
        .provider_protocol
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if protocol != "gemini-chat" {
        return false;
    }
    let provider_id_or_key = adapter_context
        .provider_id
        .as_ref()
        .or(adapter_context.provider_key.as_ref())
        .or(adapter_context.runtime_key.as_ref())
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let effective_provider_id = provider_id_or_key.split('.').next().unwrap_or_default();
    effective_provider_id == "antigravity" || effective_provider_id == "gemini-cli"
}

pub(crate) fn cache_antigravity_thought_signature_from_gemini_response(
    payload: Value,
    adapter_context: &AdapterContext,
) -> Value {
    if !should_enable_signature_cache(adapter_context) {
        return payload;
    }
    let Some(payload_obj) = payload.as_object() else {
        return payload;
    };

    let fallback_alias_key = resolve_antigravity_alias_key(adapter_context, None);
    let key_candidates = [
        adapter_context
            .request_id
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty()),
        adapter_context
            .client_request_id
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty()),
        adapter_context
            .group_request_id
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty()),
        payload_obj
            .get("request_id")
            .and_then(|v| v.as_str())
            .map(|v| v.trim())
            .filter(|v| !v.is_empty()),
        payload_obj
            .get("requestId")
            .and_then(|v| v.as_str())
            .map(|v| v.trim())
            .filter(|v| !v.is_empty()),
    ];

    let mut alias_key = fallback_alias_key;
    let mut session_id = String::new();
    let mut message_count = 1_i64;
    for key in key_candidates.into_iter().flatten() {
        if let Some(resolved) = get_antigravity_request_session_meta(key) {
            alias_key = if resolved.alias_key.trim().is_empty() {
                "antigravity.unknown".to_string()
            } else {
                resolved.alias_key
            };
            session_id = resolved.session_id;
            message_count = resolved.message_count;
            break;
        }
    }

    if session_id.trim().is_empty() {
        if let Some(stable) = resolve_stable_session_id(adapter_context) {
            session_id = stable;
            message_count = 1;
        }
    }
    if session_id.trim().is_empty() {
        return Value::Object(payload_obj.clone());
    }

    let candidates = payload_obj
        .get("candidates")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for candidate in candidates {
        let Some(content) = candidate
            .as_object()
            .and_then(|obj| obj.get("content"))
            .and_then(|v| v.as_object())
        else {
            continue;
        };
        let parts = content
            .get("parts")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for part in parts {
            let Some(part_obj) = part.as_object() else {
                continue;
            };
            let sig = read_trimmed_string(part_obj.get("thoughtSignature"))
                .or_else(|| read_trimmed_string(part_obj.get("thought_signature")))
                .unwrap_or_default();
            if sig.is_empty() {
                continue;
            }
            cache_antigravity_session_signature(&alias_key, &session_id, &sig, message_count);
            if alias_key != ANTIGRAVITY_GLOBAL_ALIAS_KEY {
                cache_antigravity_session_signature(
                    ANTIGRAVITY_GLOBAL_ALIAS_KEY,
                    &session_id,
                    &sig,
                    message_count,
                );
            }
        }
    }

    Value::Object(payload_obj.clone())
}
