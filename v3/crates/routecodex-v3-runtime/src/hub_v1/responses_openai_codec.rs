use serde_json::{json, Map, Value};

pub(crate) fn build_v3_chat_canonical_request_from_responses_payload(
    payload: &Value,
) -> Result<Value, String> {
    let root = payload.as_object().ok_or_else(|| {
        "Responses request payload must be an object before OpenAI Chat encoding".to_string()
    })?;
    let input = match root.get("input") {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(text)) => vec![json!({
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": text}]
        })],
        _ => {
            return Err(
                "Responses request payload must contain input array before OpenAI Chat encoding"
                    .to_string(),
            );
        }
    };
    let mut messages = Vec::new();
    let mut pending_tool_message_index: Option<usize> = None;
    let mut pending_tool_call_ids: Vec<String> = Vec::new();
    // 同轮 assistant 输出尾部 index：由 `output_text`/`reasoning` item 生成的
    // assistant 文本消息，后续同轮 `function_call` 必须合并进它（前缀缓存硬约束，
    // 拆分会让 provider chat renderer 插入 EOS 破坏前缀缓存）。显式 assistant
    // `message` item 属于独立历史轮次，不进入该尾部，禁止改写历史边界。
    let mut turn_assistant_tail_index: Option<usize> = None;
    if let Some(instructions) = root
        .get("instructions")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        messages.push(json!({"role":"system","content":instructions}));
    }
    let original_tools = root.get("tools").cloned();
    let mut tools = original_tools
        .as_ref()
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for (input_index, item) in input.iter().enumerate() {
        let item = item.as_object().ok_or_else(|| {
            "Responses input item must be an object before OpenAI Chat encoding".to_string()
        })?;
        let item_type = item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("message");
        match item_type {
            "additional_tools" => {
                let embedded = item.get("tools").and_then(Value::as_array).ok_or_else(|| {
                    "Responses additional_tools.tools must be an array before OpenAI Chat encoding"
                        .to_string()
                })?;
                for tool in embedded {
                    tools.push(tool.clone());
                }
            }
            "message" => {
                let is_assistant_message = item
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("user")
                    .trim()
                    .eq_ignore_ascii_case("assistant");
                let message = build_v3_openai_chat_message_from_responses_message(item)?;
                append_v3_openai_chat_message_preserving_tool_adjacency(
                    &mut messages,
                    &mut pending_tool_message_index,
                    &pending_tool_call_ids,
                    message,
                    turn_assistant_tail_index,
                )?;
                if is_assistant_message {
                    // 前缀缓存硬约束：Codex relay 输入中同轮 assistant 输出以
                    // message(role=assistant) item 呈现（文本 + 紧随的 function_call）。
                    // 必须允许后续 function_call 合并进它，否则相邻 assistant 消息
                    // 让 provider chat renderer 插入 EOS，破坏所有 relay provider 的
                    // 前缀缓存（如 DwarfStar usage_cache 0%）。仅 user/tool 类 message
                    // 清空 tail。
                    turn_assistant_tail_index = Some(messages.len() - 1);
                } else {
                    turn_assistant_tail_index = None;
                }
            }
            "output_text" => {
                append_v3_openai_chat_message_preserving_tool_adjacency(
                    &mut messages,
                    &mut pending_tool_message_index,
                    &pending_tool_call_ids,
                    build_v3_openai_chat_assistant_output_text_message(item),
                    turn_assistant_tail_index,
                )?;
                turn_assistant_tail_index = Some(messages.len() - 1);
            }
            "reasoning" => {
                if let Some(message) = build_v3_openai_chat_assistant_reasoning_message(item) {
                    append_v3_openai_chat_message_preserving_tool_adjacency(
                        &mut messages,
                        &mut pending_tool_message_index,
                        &pending_tool_call_ids,
                        message,
                        turn_assistant_tail_index,
                    )?;
                    turn_assistant_tail_index = Some(messages.len() - 1);
                }
            }
            "function_call" | "tool_call" | "custom_tool_call" => {
                append_v3_openai_chat_tool_call_message(
                    &mut messages,
                    &mut pending_tool_message_index,
                    &mut pending_tool_call_ids,
                    build_v3_openai_chat_assistant_tool_call_message(item)?,
                    turn_assistant_tail_index,
                )?;
                turn_assistant_tail_index = None;
            }
            "function_call_output"
            | "tool_call_output"
            | "custom_tool_call_output"
            | "tool_result"
            | "tool_message" => {
                append_v3_openai_chat_tool_result_message(
                    &mut messages,
                    &mut pending_tool_message_index,
                    &mut pending_tool_call_ids,
                    build_v3_openai_chat_tool_result_message(item)?,
                )?;
                turn_assistant_tail_index = None;
            }
            "web_search_call" => {
                append_v3_openai_chat_hosted_tool_call_history_pair(
                    &mut messages,
                    &mut pending_tool_message_index,
                    &mut pending_tool_call_ids,
                    item,
                    input_index,
                    V3OpenAiChatHostedToolHistoryKind::WebSearch,
                )?;
                turn_assistant_tail_index = None;
            }
            "tool_search_call" => {
                ensure_v3_openai_chat_hosted_tool_event_has_no_side_channel(
                    item,
                    V3OpenAiChatHostedToolHistoryKind::ToolSearch,
                )?;
                let assistant = build_v3_openai_chat_hosted_tool_assistant_tool_call_message(
                    item,
                    read_v3_non_empty_str(item.get("call_id")).ok_or_else(|| {
                        "Responses tool_search_call is missing call_id before Chat canonicalization"
                            .to_string()
                    })?,
                    V3OpenAiChatHostedToolHistoryKind::ToolSearch,
                )?;
                append_v3_openai_chat_tool_call_message(
                    &mut messages,
                    &mut pending_tool_message_index,
                    &mut pending_tool_call_ids,
                    assistant,
                    None,
                )?;
                turn_assistant_tail_index = None;
            }
            "tool_search_output" => {
                ensure_v3_openai_chat_hosted_tool_output_has_no_side_channel(item)?;
                let call_id = read_v3_non_empty_str(item.get("call_id")).ok_or_else(|| {
                    "Responses tool_search_output is missing call_id before Chat canonicalization"
                        .to_string()
                })?;
                if !pending_tool_call_ids.iter().any(|entry| entry == call_id) {
                    return Err(format!(
                        "OpenAI Chat provider encoding tool_search_output has no preceding assistant tool_call: {call_id}"
                    ));
                }
                let tool_result = build_v3_openai_chat_tool_search_output_message(item)?;
                append_v3_openai_chat_tool_result_message(
                    &mut messages,
                    &mut pending_tool_message_index,
                    &mut pending_tool_call_ids,
                    tool_result,
                )?;
            }
            other => {
                return Err(format!(
                    "unsupported Responses input item type for OpenAI Chat provider encoding: {other}"
                ));
            }
        }
    }
    if messages.is_empty() {
        return Err("OpenAI Chat provider encoding produced no messages".to_string());
    }
    let mut request = Map::new();
    if let Some(model) = root.get("model") {
        request.insert("model".to_string(), model.clone());
    }
    request.insert("messages".to_string(), Value::Array(messages));
    if !tools.is_empty() {
        request.insert("tools".to_string(), Value::Array(tools));
    } else if let Some(value) = original_tools.filter(|value| !value.is_null()) {
        request.insert("tools".to_string(), value);
    }
    for key in [
        "tool_choice",
        "parallel_tool_calls",
        "user",
        "temperature",
        "top_p",
        "top_k",
        "logit_bias",
        "seed",
        "stream",
        "response_format",
        "max_tokens",
        "stop",
        "service_tier",
        "prompt_cache_retention",
        "background",
        "conversation",
        "max_tool_calls",
        "prompt",
        "truncation",
        "web_search_options",
    ] {
        if let Some(value) = root.get(key) {
            request.insert(key.to_string(), value.clone());
        }
    }
    let mut responses_request_extension = Map::new();
    if let Some(metadata) = root.get("metadata") {
        if !metadata.is_object() {
            return Err("Responses metadata/client_metadata must be an object".to_string());
        }
        responses_request_extension.insert("metadata".to_string(), metadata.clone());
    }
    if let Some(client_metadata) = root.get("client_metadata") {
        if !client_metadata.is_object() {
            return Err("Responses metadata/client_metadata must be an object".to_string());
        }
        responses_request_extension.insert("client_metadata".to_string(), client_metadata.clone());
    }
    for key in ["prompt_cache_key", "store", "text"] {
        if let Some(value) = root.get(key) {
            responses_request_extension.insert(key.to_string(), value.clone());
        }
    }
    if !responses_request_extension.is_empty() {
        request.insert(
            "routecodex_chat_extension".to_string(),
            json!({"responses_request": Value::Object(responses_request_extension)}),
        );
    }
    if let Some(value) = root.get("max_output_tokens") {
        request
            .entry("max_completion_tokens".to_string())
            .or_insert_with(|| value.clone());
    }
    if let Some(value) = root.get("top_logprobs") {
        request.insert("logprobs".to_string(), Value::Bool(true));
        request.insert("top_logprobs".to_string(), value.clone());
    }
    project_responses_reasoning_to_chat_fields(root, &mut request)?;
    Ok(Value::Object(request))
}

fn project_responses_reasoning_to_chat_fields(
    root: &Map<String, Value>,
    request: &mut Map<String, Value>,
) -> Result<(), String> {
    if root.contains_key("reasoning_effort") {
        return Err(
            "Responses reasoning_effort is not a declared top-level Responses field".to_string(),
        );
    }
    let Some(reasoning) = root.get("reasoning") else {
        return Ok(());
    };
    let reasoning = reasoning
        .as_object()
        .ok_or_else(|| "Responses reasoning must be an object".to_string())?;
    for key in reasoning.keys() {
        if !matches!(
            key.as_str(),
            "effort" | "summary" | "generate_summary" | "context" | "mode"
        ) {
            return Err(format!("Unsupported Responses reasoning field: {key}"));
        }
    }
    if let Some(effort) = reasoning.get("effort").filter(|value| !value.is_null()) {
        let effort = effort
            .as_str()
            .map(str::trim)
            .filter(|value| {
                matches!(
                    *value,
                    "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
                )
            })
            .ok_or_else(|| "Responses reasoning.effort has an invalid value".to_string())?;
        request.insert(
            "reasoning_effort".to_string(),
            Value::String(effort.to_string()),
        );
    }
    let summary = match (reasoning.get("summary"), reasoning.get("generate_summary")) {
        (Some(summary), Some(generate_summary)) if summary != generate_summary => {
            return Err(
                "Responses reasoning.summary conflicts with reasoning.generate_summary".to_string(),
            );
        }
        (Some(summary), _) | (_, Some(summary)) => Some(summary),
        (None, None) => None,
    };
    if let Some(summary) = summary.filter(|value| !value.is_null()) {
        if !summary
            .as_str()
            .is_some_and(|value| matches!(value, "auto" | "concise" | "detailed"))
        {
            return Err("Responses reasoning summary policy has an invalid value".to_string());
        }
        request.insert("reasoning_summary_policy".to_string(), summary.clone());
    }
    if let Some(context) = reasoning.get("context").filter(|value| !value.is_null()) {
        if !context
            .as_str()
            .is_some_and(|value| matches!(value, "auto" | "current_turn" | "all_turns"))
        {
            return Err("Responses reasoning.context has an invalid value".to_string());
        }
        request.insert("reasoning_context_policy".to_string(), context.clone());
    }
    if let Some(mode) = reasoning.get("mode").filter(|value| !value.is_null()) {
        if !mode.as_str().is_some_and(|value| !value.trim().is_empty()) {
            return Err("Responses reasoning.mode must be a non-empty string".to_string());
        }
        request.insert("reasoning_mode".to_string(), mode.clone());
    }
    Ok(())
}

fn append_v3_openai_chat_message_preserving_tool_adjacency(
    messages: &mut Vec<Value>,
    pending_tool_message_index: &mut Option<usize>,
    pending_tool_call_ids: &[String],
    message: Value,
    turn_assistant_tail_index: Option<usize>,
) -> Result<(), String> {
    if let Some(index) = *pending_tool_message_index {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user")
            .trim();
        if role.eq_ignore_ascii_case("assistant") {
            merge_v3_openai_chat_message_into_pending_tool_message(messages, index, &message)?;
            return Ok(());
        }
        if v3_openai_chat_message_has_visible_payload(&message) {
            return Err(format!(
                "OpenAI Chat provider encoding cannot place {role} message before pending tool results: {}",
                pending_tool_call_ids.join(",")
            ));
        }
    } else if let Some(tail_index) = turn_assistant_tail_index {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user")
            .trim();
        // 前缀缓存硬约束：同一 assistant 轮的内容（message(assistant 文本) ->
        // reasoning -> output_text -> function_call 连续 items，Codex relay 真实
        // 形态）必须合并为单条 assistant 消息，禁止相邻 assistant 消息（provider
        // chat renderer 会插入 EOS 破坏前缀缓存）。前一条或新消息任一 content
        // 为空时合并是安全的（reasoning 类 content=""），不会改写历史或插入
        // 新换行；两个非空文本 assistant 保持原消息边界。
        if role.eq_ignore_ascii_case("assistant")
            && messages.len() == tail_index + 1
            && (v3_openai_chat_content_is_empty(
                messages[tail_index].get("content").unwrap_or(&Value::Null),
            ) || v3_openai_chat_content_is_empty(
                message.get("content").unwrap_or(&Value::Null),
            ))
        {
            merge_v3_openai_chat_message_into_pending_tool_message(messages, tail_index, &message)?;
            return Ok(());
        }
    }
    messages.push(message);
    Ok(())
}

fn append_v3_openai_chat_tool_call_message(
    messages: &mut Vec<Value>,
    pending_tool_message_index: &mut Option<usize>,
    pending_tool_call_ids: &mut Vec<String>,
    message: Value,
    turn_assistant_tail_index: Option<usize>,
) -> Result<(), String> {
    let call_ids = collect_v3_openai_chat_tool_call_ids(&message);
    if call_ids.is_empty() {
        messages.push(message);
        return Ok(());
    }
    if let Some(index) = *pending_tool_message_index {
        merge_v3_openai_chat_message_into_pending_tool_message(messages, index, &message)?;
    } else if let Some(tail_index) = turn_assistant_tail_index {
        // 前缀缓存硬约束：Responses 同轮 `output_text`/`reasoning` item 生成的
        // assistant 文本消息后紧邻的 `function_call` 必须合并进同一条 assistant
        // 消息（content + tool_calls 同存）。若拆成两条相邻 assistant 消息，
        // provider chat renderer 会在 tool-call 标记前插入 EOS，使下一轮请求的
        // 前缀 token 与上一轮生成输出分叉，导致所有 relay provider 的前缀缓存
        // （如 DwarfStar usage_cache）永久 miss、费用虚高。显式 assistant
        // `message` item（历史轮次）不在此列，禁止改写历史边界。
        if messages.len() == tail_index + 1 {
            merge_v3_openai_chat_message_into_pending_tool_message(messages, tail_index, &message)?;
            *pending_tool_message_index = Some(tail_index);
        } else {
            messages.push(message);
            *pending_tool_message_index = Some(messages.len() - 1);
        }
    } else {
        messages.push(message);
        *pending_tool_message_index = Some(messages.len() - 1);
    }
    for call_id in call_ids {
        if !pending_tool_call_ids.iter().any(|entry| entry == &call_id) {
            pending_tool_call_ids.push(call_id);
        }
    }
    Ok(())
}

fn append_v3_openai_chat_tool_result_message(
    messages: &mut Vec<Value>,
    pending_tool_message_index: &mut Option<usize>,
    pending_tool_call_ids: &mut Vec<String>,
    message: Value,
) -> Result<(), String> {
    let call_id = message
        .get("tool_call_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(call_id) = call_id {
        if let Some(position) = pending_tool_call_ids
            .iter()
            .position(|entry| entry == &call_id)
        {
            messages.push(message);
            pending_tool_call_ids.remove(position);
            if pending_tool_call_ids.is_empty() {
                *pending_tool_message_index = None;
            }
            return Ok(());
        }
    }
    messages.push(message);
    Ok(())
}

fn merge_v3_openai_chat_message_into_pending_tool_message(
    messages: &mut [Value],
    index: usize,
    source: &Value,
) -> Result<(), String> {
    let target = messages
        .get_mut(index)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            "OpenAI Chat provider encoding pending tool message is not an object".to_string()
        })?;
    if let Some(source_tool_calls) = source.get("tool_calls").and_then(Value::as_array) {
        let target_tool_calls = target
            .entry("tool_calls".to_string())
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| {
                "OpenAI Chat provider encoding pending tool_calls is not an array".to_string()
            })?;
        target_tool_calls.extend(source_tool_calls.iter().cloned());
    }
    if let Some(source_content) = source.get("content") {
        merge_v3_openai_chat_message_content(target, source_content);
    }
    if let Some(source_reasoning) = source
        .get("reasoning_content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let existing = target
            .get("reasoning_content")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_default();
        let merged = if existing.trim().is_empty() {
            source_reasoning.to_string()
        } else {
            format!("{existing}\n{source_reasoning}")
        };
        target.insert("reasoning_content".to_string(), Value::String(merged));
    }
    Ok(())
}

fn merge_v3_openai_chat_message_content(target: &mut Map<String, Value>, source_content: &Value) {
    if v3_openai_chat_content_is_empty(source_content) {
        return;
    }
    let Some(existing) = target.get_mut("content") else {
        target.insert("content".to_string(), source_content.clone());
        return;
    };
    if v3_openai_chat_content_is_empty(existing) {
        *existing = source_content.clone();
        return;
    }
    match (existing, source_content) {
        (Value::String(existing_text), Value::String(source_text)) => {
            if !existing_text.trim().is_empty() && !source_text.trim().is_empty() {
                existing_text.push('\n');
            }
            existing_text.push_str(source_text);
        }
        (existing_value, source_value) => {
            let mut parts = v3_openai_chat_content_to_parts(existing_value);
            parts.extend(v3_openai_chat_content_to_parts(source_value));
            *existing_value = Value::Array(parts);
        }
    }
}

fn v3_openai_chat_content_is_empty(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.trim().is_empty(),
        Value::Array(parts) => parts.is_empty(),
        _ => false,
    }
}

fn v3_openai_chat_content_to_parts(value: &Value) -> Vec<Value> {
    match value {
        Value::Array(parts) => parts.clone(),
        Value::String(text) => {
            if text.trim().is_empty() {
                Vec::new()
            } else {
                vec![json!({"type":"text","text":text})]
            }
        }
        Value::Null => Vec::new(),
        other => vec![other.clone()],
    }
}

fn v3_openai_chat_message_has_visible_payload(message: &Value) -> bool {
    message
        .get("content")
        .is_some_and(|content| !v3_openai_chat_content_is_empty(content))
        || message
            .get("tool_calls")
            .and_then(Value::as_array)
            .is_some_and(|tool_calls| !tool_calls.is_empty())
}

fn collect_v3_openai_chat_tool_call_ids(message: &Value) -> Vec<String> {
    message
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|tool_calls| {
            tool_calls
                .iter()
                .filter_map(|call| {
                    call.get("id")
                        .or_else(|| call.get("call_id"))
                        .or_else(|| call.get("tool_call_id"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

pub(crate) fn build_v3_chat_canonical_request_from_responses_payload_for_req_inbound(
    payload: &Value,
) -> Result<Value, String> {
    build_v3_chat_canonical_request_from_responses_payload(payload)
}

fn build_v3_openai_chat_message_from_responses_message(
    item: &Map<String, Value>,
) -> Result<Value, String> {
    let role = item
        .get("role")
        .and_then(Value::as_str)
        .map(v3_openai_chat_wire_role)
        .unwrap_or("user");
    let (content, mut reasoning_segments) =
        build_v3_openai_chat_content_from_responses_content(item.get("content"))?;
    reasoning_segments.extend(collect_v3_openai_chat_reasoning_segments(
        item.get("reasoning_content")
            .or_else(|| item.get("reasoning_text"))
            .or_else(|| item.get("thinking")),
    ));
    let mut message = Map::new();
    message.insert("role".to_string(), Value::String(role.to_string()));
    message.insert("content".to_string(), content);
    if let Some(reasoning_content) =
        join_v3_openai_chat_reasoning_segments(reasoning_segments.as_slice())
    {
        message.insert(
            "reasoning_content".to_string(),
            Value::String(reasoning_content),
        );
    }
    Ok(Value::Object(message))
}

fn build_v3_openai_chat_assistant_output_text_message(item: &Map<String, Value>) -> Value {
    let content = item
        .get("text")
        .or_else(|| item.get("content"))
        .or_else(|| item.get("output"))
        .map(|value| match value {
            Value::String(text) => text.clone(),
            other => serde_json::to_string(other).unwrap_or_else(|_| String::new()),
        })
        .unwrap_or_default();
    json!({"role":"assistant", "content":content})
}

fn build_v3_openai_chat_assistant_reasoning_message(item: &Map<String, Value>) -> Option<Value> {
    let reasoning_content = join_v3_openai_chat_reasoning_segments(
        collect_v3_openai_chat_reasoning_segments(Some(&Value::Object(item.clone()))).as_slice(),
    )?;
    Some(json!({
        "role":"assistant",
        "content":"",
        "reasoning_content":reasoning_content
    }))
}

fn build_v3_openai_chat_assistant_tool_call_message(
    item: &Map<String, Value>,
) -> Result<Value, String> {
    let call_id = read_v3_non_empty_str(item.get("call_id"))
        .or_else(|| read_v3_non_empty_str(item.get("tool_call_id")))
        .or_else(|| read_v3_non_empty_str(item.get("id")))
        .ok_or_else(|| {
            "Responses function_call is missing call_id/id before OpenAI Chat encoding".to_string()
        })?;
    let name = read_v3_non_empty_str(item.get("name"))
        .or_else(|| {
            item.get("function")
                .and_then(Value::as_object)
                .and_then(|function| read_v3_non_empty_str(function.get("name")))
        })
        .ok_or_else(|| {
            "Responses function_call is missing name before OpenAI Chat encoding".to_string()
        })?;
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
    let arguments = if item_type == "custom_tool_call" {
        let input = item.get("input").ok_or_else(|| {
            "Responses custom_tool_call is missing input before OpenAI Chat encoding".to_string()
        })?;
        let input = match input {
            Value::String(text) => Value::String(text.clone()),
            other => {
                Value::String(serde_json::to_string(other).map_err(|error| error.to_string())?)
            }
        };
        serde_json::to_string(&json!({ "input": input })).map_err(|error| error.to_string())?
    } else {
        let arguments = read_v3_responses_function_call_arguments_for_openai_chat(item)?;
        project_v3_responses_arguments_to_openai_chat_wire(arguments.as_str())
    };
    let mut message = Map::new();
    message.insert("role".to_string(), Value::String("assistant".to_string()));
    message.insert("content".to_string(), Value::String(String::new()));
    let mut tool_call = json!({
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": arguments}
    });
    let responses_item_id = read_v3_non_empty_str(item.get("id"));
    if item_type == "custom_tool_call" || responses_item_id.is_some() {
        let mut extension = Map::new();
        if item_type == "custom_tool_call" {
            extension.insert(
                "responses_tool_call_type".to_string(),
                Value::String("custom_tool_call".to_string()),
            );
        }
        if let Some(item_id) = responses_item_id {
            extension.insert(
                "responses_item_id".to_string(),
                Value::String(item_id.to_string()),
            );
        }
        if let Some(object) = tool_call.as_object_mut() {
            object.insert(
                "routecodex_chat_extension".to_string(),
                Value::Object(extension),
            );
        }
    }
    message.insert("tool_calls".to_string(), Value::Array(vec![tool_call]));
    if let Some(reasoning_content) = join_v3_openai_chat_reasoning_segments(
        collect_v3_openai_chat_reasoning_segments(
            item.get("reasoning_content")
                .or_else(|| item.get("reasoning_text"))
                .or_else(|| item.get("thinking")),
        )
        .as_slice(),
    ) {
        message.insert(
            "reasoning_content".to_string(),
            Value::String(reasoning_content),
        );
    }
    Ok(Value::Object(message))
}

fn read_v3_responses_function_call_arguments_for_openai_chat(
    item: &Map<String, Value>,
) -> Result<String, String> {
    let arguments = item
        .get("arguments")
        .or_else(|| {
            item.get("function")
                .and_then(Value::as_object)
                .and_then(|function| function.get("arguments"))
        })
        .ok_or("Responses function_call is missing arguments before OpenAI Chat encoding")?;
    match arguments {
        Value::String(text) => Ok(text.clone()),
        other => serde_json::to_string(other).map_err(|error| error.to_string()),
    }
}

fn project_v3_responses_arguments_to_openai_chat_wire(arguments: &str) -> String {
    arguments.to_string()
}

fn build_v3_openai_chat_tool_result_message(item: &Map<String, Value>) -> Result<Value, String> {
    let call_id = read_v3_non_empty_str(item.get("tool_call_id"))
        .or_else(|| read_v3_non_empty_str(item.get("call_id")))
        .or_else(|| read_v3_non_empty_str(item.get("tool_use_id")))
        .or_else(|| read_v3_non_empty_str(item.get("id")))
        .ok_or_else(|| {
            "Responses tool output is missing call_id/tool_call_id before OpenAI Chat encoding"
                .to_string()
        })?;
    let output = item
        .get("output")
        .or_else(|| item.get("content"))
        .ok_or("Responses tool output is missing output/content before OpenAI Chat encoding")?;
    let content = match output {
        Value::String(text) => text.clone(),
        other => serde_json::to_string(other).map_err(|error| error.to_string())?,
    };
    let item_type = item
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("function_call_output");
    let mut extension = Map::new();
    extension.insert(
        "responses_tool_output_type".to_string(),
        Value::String(item_type.to_string()),
    );
    if let Some(item_id) = read_v3_non_empty_str(item.get("id")) {
        extension.insert(
            "responses_item_id".to_string(),
            Value::String(item_id.to_string()),
        );
    }
    Ok(json!({
        "role":"tool",
        "tool_call_id":call_id,
        "content":content,
        "routecodex_chat_extension":Value::Object(extension)
    }))
}

#[derive(Clone, Copy)]
enum V3OpenAiChatHostedToolHistoryKind {
    WebSearch,
    ToolSearch,
}

impl V3OpenAiChatHostedToolHistoryKind {
    fn responses_item_type(self) -> &'static str {
        match self {
            Self::WebSearch => "web_search_call",
            Self::ToolSearch => "tool_search_call",
        }
    }

    fn openai_chat_function_name(self) -> &'static str {
        match self {
            Self::WebSearch => "web_search",
            Self::ToolSearch => "tool_search",
        }
    }

    fn synthetic_call_id_prefix(self) -> &'static str {
        match self {
            Self::WebSearch => "call_routecodex_web_search",
            Self::ToolSearch => "call_routecodex_tool_search",
        }
    }
}

fn ensure_v3_openai_chat_hosted_tool_output_has_no_side_channel(
    item: &Map<String, Value>,
) -> Result<(), String> {
    let event = Value::Object(item.clone());
    if let Some(key) = super::find_v3_hub_side_channel_key(&event) {
        return Err(format!(
            "Responses tool_search_output contains RouteCodex side-channel field before Chat canonicalization: {key}"
        ));
    }
    if let Some(key) = find_v3_openai_chat_hosted_tool_private_payload_key(&event) {
        return Err(format!(
            "Responses tool_search_output contains private debug field before Chat canonicalization: {key}"
        ));
    }
    Ok(())
}

fn append_v3_openai_chat_hosted_tool_call_history_pair(
    messages: &mut Vec<Value>,
    pending_tool_message_index: &mut Option<usize>,
    pending_tool_call_ids: &mut Vec<String>,
    item: &Map<String, Value>,
    input_index: usize,
    kind: V3OpenAiChatHostedToolHistoryKind,
) -> Result<(), String> {
    ensure_v3_openai_chat_hosted_tool_event_has_no_side_channel(item, kind)?;
    let call_id = build_v3_openai_chat_hosted_tool_history_call_id(item, input_index, kind);
    let assistant =
        build_v3_openai_chat_hosted_tool_assistant_tool_call_message(item, call_id.as_str(), kind)?;
    let tool_result =
        build_v3_openai_chat_hosted_tool_result_message(item, call_id.as_str(), kind)?;
    append_v3_openai_chat_tool_call_message(
        messages,
        pending_tool_message_index,
        pending_tool_call_ids,
        assistant,
        None,
    )?;
    append_v3_openai_chat_tool_result_message(
        messages,
        pending_tool_message_index,
        pending_tool_call_ids,
        tool_result,
    )
}

fn ensure_v3_openai_chat_hosted_tool_event_has_no_side_channel(
    item: &Map<String, Value>,
    kind: V3OpenAiChatHostedToolHistoryKind,
) -> Result<(), String> {
    let event = Value::Object(item.clone());
    let item_type = kind.responses_item_type();
    if let Some(key) = super::find_v3_hub_side_channel_key(&event) {
        return Err(format!(
            "Responses {item_type} contains RouteCodex side-channel field before OpenAI Chat provider encoding: {key}"
        ));
    }
    if let Some(key) = find_v3_openai_chat_hosted_tool_private_payload_key(&event) {
        return Err(format!(
            "Responses {item_type} contains private debug field before OpenAI Chat provider encoding: {key}"
        ));
    }
    Ok(())
}

fn find_v3_openai_chat_hosted_tool_private_payload_key(value: &Value) -> Option<String> {
    match value {
        Value::Object(object) => {
            for key in object.keys() {
                if key.starts_with('_') {
                    return Some(key.clone());
                }
            }
            object
                .values()
                .find_map(find_v3_openai_chat_hosted_tool_private_payload_key)
        }
        Value::Array(items) => items
            .iter()
            .find_map(find_v3_openai_chat_hosted_tool_private_payload_key),
        _ => None,
    }
}

fn build_v3_openai_chat_hosted_tool_history_call_id(
    item: &Map<String, Value>,
    input_index: usize,
    kind: V3OpenAiChatHostedToolHistoryKind,
) -> String {
    read_v3_non_empty_str(item.get("call_id"))
        .or_else(|| read_v3_non_empty_str(item.get("tool_call_id")))
        .or_else(|| read_v3_non_empty_str(item.get("id")))
        .map(str::to_string)
        .unwrap_or_else(|| format!("{}_{}", kind.synthetic_call_id_prefix(), input_index))
}

fn build_v3_openai_chat_hosted_tool_assistant_tool_call_message(
    item: &Map<String, Value>,
    call_id: &str,
    kind: V3OpenAiChatHostedToolHistoryKind,
) -> Result<Value, String> {
    let arguments_value = build_v3_openai_chat_hosted_tool_arguments_value(item, kind);
    let arguments = serde_json::to_string(&arguments_value).map_err(|error| error.to_string())?;
    let function_name = kind.openai_chat_function_name();
    let mut extension = Map::new();
    extension.insert(
        "responses_tool_call_type".to_string(),
        Value::String(kind.responses_item_type().to_string()),
    );
    copy_v3_responses_item_extension_fields(item, &mut extension);
    Ok(json!({
        "role": "assistant",
        "content": "",
        "tool_calls": [{
            "id": call_id,
            "type": "function",
            "function": {
                "name": function_name,
                "arguments": arguments
            },
            "routecodex_chat_extension": Value::Object(extension)
        }]
    }))
}

fn build_v3_openai_chat_tool_search_output_message(
    item: &Map<String, Value>,
) -> Result<Value, String> {
    let call_id = read_v3_non_empty_str(item.get("call_id")).ok_or_else(|| {
        "Responses tool_search_output is missing call_id before Chat canonicalization".to_string()
    })?;
    let tools = item.get("tools").and_then(Value::as_array).ok_or_else(|| {
        "Responses tool_search_output is missing tools array before Chat canonicalization"
            .to_string()
    })?;
    let content = serde_json::to_string(tools).map_err(|error| error.to_string())?;
    let mut extension = Map::new();
    extension.insert(
        "responses_tool_output_type".to_string(),
        Value::String("tool_search_output".to_string()),
    );
    extension.insert(
        "responses_output_field".to_string(),
        Value::String("tools".to_string()),
    );
    copy_v3_responses_item_extension_fields(item, &mut extension);
    Ok(json!({
        "role": "tool",
        "tool_call_id": call_id,
        "content": content,
        "routecodex_chat_extension": Value::Object(extension)
    }))
}

fn copy_v3_responses_item_extension_fields(
    item: &Map<String, Value>,
    extension: &mut Map<String, Value>,
) {
    for (source, target) in [
        ("id", "responses_item_id"),
        ("status", "responses_status"),
        ("execution", "responses_execution"),
    ] {
        if let Some(value) = item.get(source) {
            extension.insert(target.to_string(), value.clone());
        }
    }
}

fn build_v3_openai_chat_hosted_tool_arguments_value(
    item: &Map<String, Value>,
    kind: V3OpenAiChatHostedToolHistoryKind,
) -> Value {
    let source = match kind {
        V3OpenAiChatHostedToolHistoryKind::WebSearch => item.get("action"),
        V3OpenAiChatHostedToolHistoryKind::ToolSearch => {
            item.get("arguments").or_else(|| item.get("action"))
        }
    };
    match source {
        Some(Value::Object(object)) => Value::Object(object.clone()),
        Some(value) => json!({ "value": value }),
        None => Value::Object(Map::new()),
    }
}

fn build_v3_openai_chat_hosted_tool_result_message(
    item: &Map<String, Value>,
    call_id: &str,
    kind: V3OpenAiChatHostedToolHistoryKind,
) -> Result<Value, String> {
    let event = build_v3_openai_chat_hosted_tool_result_event(item, kind);
    let content = serde_json::to_string(&event).map_err(|error| error.to_string())?;
    Ok(json!({"role":"tool","tool_call_id":call_id,"content":content}))
}

fn build_v3_openai_chat_hosted_tool_result_event(
    item: &Map<String, Value>,
    kind: V3OpenAiChatHostedToolHistoryKind,
) -> Value {
    let mut event = Map::new();
    for key in [
        "type",
        "id",
        "call_id",
        "tool_call_id",
        "status",
        "action",
        "arguments",
        "execution",
        "result",
        "result_items",
        "results",
        "output",
        "error",
        "errors",
    ] {
        if let Some(value) = item.get(key) {
            event.insert(key.to_string(), value.clone());
        }
    }
    for (key, value) in item {
        if event.contains_key(key) {
            continue;
        }
        event.insert(key.clone(), value.clone());
    }
    if !event.contains_key("type") {
        event.insert(
            "type".to_string(),
            Value::String(kind.responses_item_type().to_string()),
        );
    }
    Value::Object(event)
}

fn build_v3_openai_chat_content_from_responses_content(
    content: Option<&Value>,
) -> Result<(Value, Vec<String>), String> {
    let Some(content) = content else {
        return Ok((Value::String(String::new()), Vec::new()));
    };
    if let Some(text) = content.as_str() {
        return Ok((Value::String(text.to_string()), Vec::new()));
    }
    let Some(parts) = content.as_array() else {
        return Ok((Value::String(content.to_string()), Vec::new()));
    };
    let mut text_segments = Vec::new();
    let mut converted_parts = Vec::new();
    let mut reasoning_segments = Vec::new();
    let mut text_only = true;
    for part in parts {
        let object = part.as_object().ok_or_else(|| {
            "Responses message content part must be an object before OpenAI Chat encoding"
                .to_string()
        })?;
        match object.get("type").and_then(Value::as_str) {
            Some("input_text" | "output_text" | "text") => {
                let text = object
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                text_segments.push(text.to_string());
                converted_parts.push(json!({"type":"text","text":text}));
            }
            Some("reasoning_text" | "thinking" | "reasoning") => {
                reasoning_segments.extend(collect_v3_openai_chat_reasoning_segments(Some(part)));
            }
            Some("input_image" | "image_url") => {
                text_only = false;
                converted_parts.push(convert_v3_responses_image_part_to_openai_chat_part(object));
            }
            Some(other) => {
                return Err(format!(
                    "unsupported Responses message content part for OpenAI Chat provider encoding: {other}"
                ));
            }
            None => {
                return Err(
                    "Responses message content part is missing type before OpenAI Chat encoding"
                        .to_string(),
                );
            }
        }
    }
    if text_only {
        Ok((Value::String(text_segments.join("")), reasoning_segments))
    } else {
        Ok((Value::Array(converted_parts), reasoning_segments))
    }
}

fn collect_v3_openai_chat_reasoning_segments(value: Option<&Value>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    match value {
        Value::String(text) => read_v3_trimmed_owned(text).into_iter().collect(),
        Value::Array(items) => items
            .iter()
            .flat_map(|item| collect_v3_openai_chat_reasoning_segments(Some(item)))
            .collect(),
        Value::Object(row) => row
            .get("text")
            .or_else(|| row.get("content"))
            .or_else(|| row.get("summary"))
            .or_else(|| row.get("reasoning_content"))
            .or_else(|| row.get("thinking"))
            .into_iter()
            .flat_map(|item| collect_v3_openai_chat_reasoning_segments(Some(item)))
            .collect(),
        _ => Vec::new(),
    }
}

fn join_v3_openai_chat_reasoning_segments(segments: &[String]) -> Option<String> {
    let joined = segments
        .iter()
        .map(String::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    read_v3_trimmed_owned(joined.as_str())
}

fn read_v3_trimmed_owned(text: &str) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn convert_v3_responses_image_part_to_openai_chat_part(part: &Map<String, Value>) -> Value {
    let image_url = normalize_v3_responses_image_url_for_openai_chat(part);
    json!({"type":"image_url","image_url":image_url})
}

fn normalize_v3_responses_image_url_for_openai_chat(part: &Map<String, Value>) -> Value {
    let source = part
        .get("image_url")
        .cloned()
        .or_else(|| part.get("url").cloned())
        .unwrap_or(Value::Null);

    let mut image_url = match source {
        Value::Object(object) => object,
        Value::String(url) => Map::from_iter([("url".to_string(), Value::String(url))]),
        other => Map::from_iter([("url".to_string(), other)]),
    };

    if let Some(detail) = part.get("detail").cloned() {
        image_url.entry("detail".to_string()).or_insert(detail);
    }

    Value::Object(image_url)
}

fn v3_openai_chat_wire_role(role: &str) -> &str {
    match role {
        "developer" => "system",
        other => other,
    }
}

fn read_v3_non_empty_str(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn responses_input_image_url_maps_to_openai_chat_image_url_url() {
        let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
            "model": "gpt-5.5",
            "input": [{
                "type": "message",
                "role": "user",
                "content": [{
                    "type": "input_image",
                    "image_url": "data:image/png;base64,AAAA",
                    "detail": "high"
                }]
            }]
        }))
        .expect("Responses image_url must project to OpenAI Chat image_url.url");

        let image_part = &request["messages"][0]["content"][0];
        assert_eq!(image_part["type"], json!("image_url"));
        assert_eq!(
            image_part["image_url"],
            json!({"url":"data:image/png;base64,AAAA","detail":"high"}),
            "OpenAI Chat provider wire must not emit bare string image_url: {request}"
        );
    }

    #[test]
    fn responses_web_search_call_projects_to_openai_chat_tool_pair_with_synthetic_id() {
        let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
            "model": "gpt-5.5",
            "input": [
                {
                    "type": "web_search_call",
                    "status": "failed",
                    "action": {
                        "type": "search",
                        "query": "微信小程序 发布流程",
                        "queries": ["微信小程序 发布流程", "微信小程序 request 合法域名"]
                    }
                },
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "继续"}]
                }
            ]
        }))
        .expect("web_search_call history must project to legal OpenAI Chat tool pair");

        let messages = request["messages"].as_array().expect("messages");
        assert_eq!(
            messages.len(),
            3,
            "must emit pair plus following user: {request}"
        );
        assert_eq!(messages[0]["role"], json!("assistant"));
        assert_eq!(messages[0]["content"], json!(""));
        assert_eq!(
            messages[0]["tool_calls"][0]["id"],
            json!("call_routecodex_web_search_0")
        );
        assert_eq!(
            messages[0]["tool_calls"][0]["function"]["name"],
            json!("web_search")
        );
        let arguments: Value = serde_json::from_str(
            messages[0]["tool_calls"][0]["function"]["arguments"]
                .as_str()
                .expect("arguments string"),
        )
        .expect("web_search arguments must be JSON");
        assert_eq!(
            arguments,
            json!({
                "type": "search",
                "query": "微信小程序 发布流程",
                "queries": ["微信小程序 发布流程", "微信小程序 request 合法域名"]
            })
        );
        assert_eq!(messages[1]["role"], json!("tool"));
        assert_eq!(
            messages[1]["tool_call_id"],
            json!("call_routecodex_web_search_0"),
            "tool result must pair with assistant tool_call"
        );
        let result: Value = serde_json::from_str(
            messages[1]["content"]
                .as_str()
                .expect("tool result content string"),
        )
        .expect("tool result content must preserve web_search event as JSON");
        assert_eq!(result["type"], json!("web_search_call"));
        assert_eq!(result["status"], json!("failed"));
        assert_eq!(result["action"], arguments);
        assert_eq!(messages[2], json!({"role": "user", "content": "继续"}));
    }

    #[test]
    fn responses_tool_search_call_and_output_normalize_as_adjacent_chat_extensions() {
        let discovered_tools = json!([{
            "type": "namespace",
            "name": "mcp__node_repl",
            "tools": [{
                "type": "function",
                "name": "js",
                "description": "Run JS",
                "parameters": {"type": "object"}
            }]
        }]);
        let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
            "model": "gpt-5.5",
            "input": [
                {
                    "type": "tool_search_call",
                    "call_id": "call_FTUTqdbVH4EQwpp0DWcX5q6M",
                    "execution": "client",
                    "status": "completed",
                    "arguments": {
                        "query": "multi-agent send message to existing agent status resume agent",
                        "limit": 8
                    }
                },
                {
                    "type": "tool_search_output",
                    "id": "tso_123",
                    "call_id": "call_FTUTqdbVH4EQwpp0DWcX5q6M",
                    "execution": "client",
                    "status": "completed",
                    "tools": discovered_tools
                },
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "继续"}]
                }
            ]
        }))
        .expect("tool_search call/output must normalize to adjacent Chat tool history");

        let messages = request["messages"].as_array().expect("messages");
        assert_eq!(
            messages.len(),
            3,
            "must emit pair plus following user: {request}"
        );
        assert_eq!(messages[0]["role"], json!("assistant"));
        assert_eq!(
            messages[0]["tool_calls"][0]["id"],
            json!("call_FTUTqdbVH4EQwpp0DWcX5q6M")
        );
        assert_eq!(
            messages[0]["tool_calls"][0]["function"]["name"],
            json!("tool_search")
        );
        assert_eq!(
            messages[0]["tool_calls"][0]["routecodex_chat_extension"]["responses_tool_call_type"],
            json!("tool_search_call")
        );
        let arguments: Value = serde_json::from_str(
            messages[0]["tool_calls"][0]["function"]["arguments"]
                .as_str()
                .expect("tool_search arguments string"),
        )
        .expect("tool_search arguments must be JSON");
        assert_eq!(
            arguments,
            json!({
                "query": "multi-agent send message to existing agent status resume agent",
                "limit": 8
            })
        );
        assert_eq!(messages[1]["role"], json!("tool"));
        assert_eq!(
            messages[1]["tool_call_id"],
            json!("call_FTUTqdbVH4EQwpp0DWcX5q6M")
        );
        let result: Value = serde_json::from_str(
            messages[1]["content"]
                .as_str()
                .expect("tool result content string"),
        )
        .expect("tool result content must preserve discovered tools as JSON");
        assert_eq!(result, discovered_tools);
        assert_eq!(
            messages[1]["routecodex_chat_extension"],
            json!({
                "responses_tool_output_type": "tool_search_output",
                "responses_output_field": "tools",
                "responses_item_id": "tso_123",
                "responses_status": "completed",
                "responses_execution": "client"
            })
        );
        assert_eq!(messages[2], json!({"role": "user", "content": "继续"}));
        assert!(
            messages.iter().all(|message| {
                message.get("type").and_then(Value::as_str) != Some("tool_search_call")
            }),
            "OpenAI Chat messages must not embed native Responses tool_search_call items: {request}"
        );
    }

    #[test]
    fn responses_tool_search_output_without_matching_call_fails_in_inbound_owner() {
        let error = build_v3_chat_canonical_request_from_responses_payload(&json!({
            "model": "gpt-5.5",
            "input": [{
                "type": "tool_search_output",
                "call_id": "call_missing",
                "status": "completed",
                "execution": "client",
                "tools": []
            }]
        }))
        .expect_err("orphan tool_search_output must not cross ReqInbound02");

        assert!(
            error.contains("no preceding assistant tool_call"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn responses_function_call_item_id_enters_chat_extension() {
        let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
            "model": "gpt-5.5",
            "input": [{
                "type": "function_call",
                "id": "fc_original",
                "call_id": "call_original",
                "name": "lookup",
                "arguments": "{\"q\":\"x\"}"
            }]
        }))
        .expect("Responses function_call must normalize to Chat canonical");

        let tool_call = &request["messages"][0]["tool_calls"][0];
        assert_eq!(tool_call["id"], "call_original");
        assert_eq!(
            tool_call["routecodex_chat_extension"]["responses_item_id"],
            "fc_original"
        );
    }

    #[test]
    fn responses_web_search_call_preserves_existing_id_for_tool_pair() {
        let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
            "model": "gpt-5.5",
            "input": [{
                "type": "web_search_call",
                "id": "ws_123",
                "status": "completed",
                "action": {"type": "open_page", "url": "https://example.com"},
                "result": {"title": "Example"},
                "result_items": [{"url": "https://example.com", "title": "Example"}],
                "output": "opened"
            }]
        }))
        .expect("web_search_call with id must project");

        let messages = request["messages"].as_array().expect("messages");
        assert_eq!(messages.len(), 2, "web_search_call must be atomic pair");
        assert_eq!(messages[0]["tool_calls"][0]["id"], json!("ws_123"));
        assert_eq!(messages[1]["tool_call_id"], json!("ws_123"));
        let result: Value = serde_json::from_str(messages[1]["content"].as_str().unwrap())
            .expect("tool result content JSON");
        assert_eq!(result["id"], json!("ws_123"));
        assert_eq!(result["result"], json!({"title": "Example"}));
        assert_eq!(
            result["result_items"],
            json!([{"url": "https://example.com", "title": "Example"}])
        );
        assert_eq!(result["output"], json!("opened"));
    }

    #[test]
    fn responses_web_search_call_never_emits_unpaired_tool_call_or_native_item() {
        let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
            "model": "gpt-5.5",
            "input": [{
                "type": "web_search_call",
                "status": "failed"
            }]
        }))
        .expect("web_search_call without action still projects as empty-argument pair");

        let messages = request["messages"].as_array().expect("messages");
        assert_eq!(messages.len(), 2, "must not emit only assistant tool_call");
        assert_eq!(messages[0]["role"], json!("assistant"));
        assert_eq!(messages[1]["role"], json!("tool"));
        let call_id = messages[0]["tool_calls"][0]["id"].as_str().unwrap();
        assert_eq!(messages[1]["tool_call_id"], json!(call_id));
        let arguments: Value = serde_json::from_str(
            messages[0]["tool_calls"][0]["function"]["arguments"]
                .as_str()
                .unwrap(),
        )
        .expect("empty action arguments JSON");
        assert_eq!(arguments, json!({}));
        assert!(
            messages
                .iter()
                .all(|message| message.get("type").and_then(Value::as_str) != Some("web_search_call")),
            "provider Chat messages must not contain a native Responses input item object: {request}"
        );
    }

    #[test]
    fn responses_web_search_call_normalizes_to_chat_extension_at_req_inbound() {
        let payload = json!({
            "model": "gpt-5.5",
            "input": [{
                "type": "web_search_call",
                "status": "failed",
                "action": {"type": "search", "query": "RouteCodex"}
            }]
        });
        let request = build_v3_chat_canonical_request_from_responses_payload_for_req_inbound(&payload)
            .expect("ReqInbound must normalize web_search_call into Chat extension history without raw payload carry");
        let messages = request["messages"].as_array().expect("messages");
        assert_eq!(messages.len(), 2, "{request}");
        assert_eq!(
            messages[0]["tool_calls"][0]["function"]["name"],
            "web_search"
        );
        assert_eq!(
            messages[1]["tool_call_id"],
            messages[0]["tool_calls"][0]["id"]
        );
    }

    #[test]
    fn responses_web_search_call_rejects_side_channel_before_tool_result_stringification() {
        let error = build_v3_chat_canonical_request_from_responses_payload(&json!({
            "model": "gpt-5.5",
            "input": [{
                "type": "web_search_call",
                "status": "failed",
                "action": {"type": "search", "query": "RouteCodex"},
                "routeHint": "debug-control"
            }]
        }))
        .expect_err(
            "RouteCodex control fields must fail before provider tool-result JSON stringification",
        );
        assert!(
            error.contains("side-channel field") && error.contains("routeHint"),
            "unexpected error: {error}"
        );

        let error = build_v3_chat_canonical_request_from_responses_payload(&json!({
            "model": "gpt-5.5",
            "input": [{
                "type": "web_search_call",
                "status": "failed",
                "action": {"type": "search", "query": "RouteCodex", "_debug": true}
            }]
        }))
        .expect_err(
            "private debug fields must fail before provider tool-result JSON stringification",
        );
        assert!(
            error.contains("private debug field") && error.contains("_debug"),
            "unexpected error: {error}"
        );
    }
}

#[cfg(test)]
#[path = "responses_openai_codec_extra_tests.rs"]
mod responses_openai_codec_extra_tests;
