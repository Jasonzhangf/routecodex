use crate::hub_bridge_actions::utils::normalize_function_call_output_id;
use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{Map, Value};

fn is_shell_like_function_name(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "exec_command" | "shell_command" | "shell" | "bash" | "terminal"
    )
}

fn read_trimmed_text(value: Option<&Value>) -> Option<String> {
    let raw = value.and_then(Value::as_str)?.trim().to_string();
    if raw.is_empty() {
        None
    } else {
        Some(raw)
    }
}

fn read_string_array_command(value: Option<&Value>) -> Option<String> {
    let parts = value.and_then(Value::as_array)?;
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

fn parse_arguments_record(value: Option<&Value>) -> Option<Map<String, Value>> {
    match value {
        Some(Value::Object(row)) => Some(row.clone()),
        Some(Value::String(raw)) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Some(Map::new());
            }
            let parsed: Value = serde_json::from_str(trimmed).ok()?;
            parsed.as_object().cloned()
        }
        _ => None,
    }
}

fn read_command_from_args_map(args: &Map<String, Value>) -> Option<String> {
    let read_value = |value: Option<&Value>| -> Option<String> {
        read_trimmed_text(value).or_else(|| read_string_array_command(value))
    };

    let direct = read_value(args.get("cmd")).or_else(|| read_value(args.get("command")));
    if direct.is_some() {
        return direct;
    }

    args.get("input")
        .and_then(Value::as_object)
        .and_then(|row| read_value(row.get("cmd")).or_else(|| read_value(row.get("command"))))
        .or_else(|| {
            args.get("args").and_then(Value::as_object).and_then(|row| {
                read_value(row.get("cmd")).or_else(|| read_value(row.get("command")))
            })
        })
}

fn read_workdir_from_args_map(args: &Map<String, Value>) -> Option<String> {
    let input = args.get("input").and_then(Value::as_object);
    read_trimmed_text(args.get("workdir"))
        .or_else(|| read_trimmed_text(args.get("cwd")))
        .or_else(|| read_trimmed_text(args.get("workDir")))
        .or_else(|| input.and_then(|row| read_trimmed_text(row.get("workdir"))))
        .or_else(|| input.and_then(|row| read_trimmed_text(row.get("cwd"))))
}

fn args_contain_direct_or_nested_key(args: &Map<String, Value>, key: &str) -> bool {
    if args.contains_key(key) {
        return true;
    }
    ["input", "args"].iter().any(|container_key| {
        args.get(*container_key)
            .and_then(Value::as_object)
            .map(|row| row.contains_key(key))
            .unwrap_or(false)
    })
}

fn build_shell_like_output_arguments(
    raw_name: Option<&str>,
    args: &Map<String, Value>,
) -> Option<String> {
    let cmd = read_command_from_args_map(args)?;
    let has_cmd = args_contain_direct_or_nested_key(args, "cmd");
    let has_command = args_contain_direct_or_nested_key(args, "command");
    let source_is_shell_alias = raw_name
        .map(|name| {
            let lowered = name.trim().to_ascii_lowercase();
            matches!(
                lowered.as_str(),
                "shell_command" | "shell" | "bash" | "terminal"
            )
        })
        .unwrap_or(false);

    let emit_cmd = has_cmd || (!has_command && !source_is_shell_alias);
    let emit_command = has_command || (source_is_shell_alias && !has_cmd);

    let mut normalized = Map::new();
    if emit_command {
        normalized.insert("command".to_string(), Value::String(cmd.clone()));
    }
    if emit_cmd {
        normalized.insert("cmd".to_string(), Value::String(cmd));
    }
    if let Some(workdir) = read_workdir_from_args_map(args) {
        normalized.insert("workdir".to_string(), Value::String(workdir));
    }
    serde_json::to_string(&Value::Object(normalized)).ok()
}

fn pick_responses_persisted_fields(payload: &Value) -> Value {
    let Some(row) = payload.as_object() else {
        return Value::Object(Map::new());
    };
    let fields = [
        "model",
        "instructions",
        "metadata",
        "include",
        "store",
        "tool_choice",
        "parallel_tool_calls",
        "response_format",
        "temperature",
        "top_p",
        "max_output_tokens",
        "max_tokens",
        "stop",
        "user",
        "modal",
        "truncation_strategy",
        "previous_response_id",
        "reasoning",
        "attachments",
        "input_audio",
        "output_audio",
        "routeHint",
    ];
    let mut next = Map::new();
    for key in fields {
        if let Some(value) = row.get(key) {
            next.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(next)
}

fn normalize_output_item_to_input(item: &Value) -> Option<Value> {
    let row = item.as_object()?;
    let item_type = row
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if item_type == "message" || item_type == "reasoning" {
        let role = row
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("assistant")
            .to_string();
        let content = row
            .get("content")
            .and_then(Value::as_array)
            .cloned()
            .map(Value::Array)
            .or_else(|| {
                row.get("text").and_then(Value::as_str).map(|text| {
                    Value::Array(vec![serde_json::json!({ "type": "text", "text": text })])
                })
            })
            .unwrap_or_else(|| Value::Array(Vec::new()));
        return Some(serde_json::json!({
          "type": "message",
          "role": role,
          "content": content,
          "message": {
            "role": role,
            "content": content
          }
        }));
    }

    if item_type == "function_call" {
        let raw_name = row
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| {
                row.get("function")
                    .and_then(Value::as_object)
                    .and_then(|f| f.get("name"))
                    .and_then(Value::as_str)
            })
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let is_shell_like = raw_name
            .as_deref()
            .map(is_shell_like_function_name)
            .unwrap_or(false);
        let raw_arguments = row.get("arguments").or_else(|| {
            row.get("function")
                .and_then(Value::as_object)
                .and_then(|f| f.get("arguments"))
        });

        let mut normalized_shell_args: Option<Value> = None;
        if is_shell_like {
            let args = parse_arguments_record(raw_arguments)?;
            let serialized = build_shell_like_output_arguments(raw_name.as_deref(), &args)?;
            normalized_shell_args = Some(Value::String(serialized));
        }

        let call_id = row
            .get("call_id")
            .and_then(Value::as_str)
            .or_else(|| row.get("id").and_then(Value::as_str));
        let function_node = row
            .get("function")
            .and_then(Value::as_object)
            .cloned()
            .or_else(|| {
                row.get("name").and_then(Value::as_str).map(|name| {
                    let mut fn_node = Map::new();
                    fn_node.insert("name".to_string(), Value::String(name.to_string()));
                    if let Some(args) = normalized_shell_args
                        .as_ref()
                        .or_else(|| row.get("arguments"))
                    {
                        fn_node.insert("arguments".to_string(), args.clone());
                    }
                    fn_node
                })
            });
        let mut out = Map::new();
        out.insert(
            "type".to_string(),
            Value::String("function_call".to_string()),
        );
        out.insert("role".to_string(), Value::String("assistant".to_string()));
        if let Some(id) = row.get("id").and_then(Value::as_str) {
            out.insert("id".to_string(), Value::String(id.to_string()));
        }
        if let Some(call_id) = call_id {
            out.insert("call_id".to_string(), Value::String(call_id.to_string()));
        }
        if let Some(name) = row.get("name").and_then(Value::as_str) {
            out.insert("name".to_string(), Value::String(name.to_string()));
        }
        if let Some(arguments) = normalized_shell_args
            .as_ref()
            .or_else(|| row.get("arguments"))
        {
            out.insert("arguments".to_string(), arguments.clone());
        }
        if let Some(fn_node) = function_node {
            out.insert("function".to_string(), Value::Object(fn_node));
        }
        return Some(Value::Object(out));
    }

    None
}

fn convert_responses_output_to_input_items(response: &Value) -> Value {
    let output = response
        .as_object()
        .and_then(|row| row.get("output"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut items: Vec<Value> = Vec::new();
    for entry in output {
        if let Some(mapped) = normalize_output_item_to_input(&entry) {
            items.push(mapped);
        }
    }
    Value::Array(items)
}

fn clone_object(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn clone_array(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

fn clone_optional_array(value: Option<&Value>) -> Option<Vec<Value>> {
    value.and_then(Value::as_array).cloned()
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value.and_then(Value::as_str)?.trim().to_string();
    if raw.is_empty() {
        None
    } else {
        Some(raw)
    }
}

fn normalize_submitted_tool_outputs(
    tool_outputs: &[Value],
    merged_input: &[Value],
) -> (Vec<Value>, Vec<Value>) {
    let mut call_id_to_function_item_id: Map<String, Value> = Map::new();
    for item in merged_input {
        let Some(row) = item.as_object() else {
            continue;
        };
        let item_type = row.get("type").and_then(Value::as_str).unwrap_or("");
        if item_type != "function_call" {
            continue;
        }
        let id = read_trimmed_string(row.get("id"));
        let call_id = read_trimmed_string(row.get("call_id"));
        if let Some(id_value) = id.clone() {
            call_id_to_function_item_id.insert(id_value.clone(), Value::String(id_value));
        }
        if let Some(call_id_value) = call_id {
            let mapped = id.clone().unwrap_or_else(|| call_id_value.clone());
            call_id_to_function_item_id.insert(call_id_value, Value::String(mapped));
        }
    }

    let mut items: Vec<Value> = Vec::new();
    let mut submitted: Vec<Value> = Vec::new();

    for (index, entry) in tool_outputs.iter().enumerate() {
        let Some(row) = entry.as_object() else {
            continue;
        };

        let raw_id = read_trimmed_string(row.get("tool_call_id"))
            .or_else(|| read_trimmed_string(row.get("call_id")))
            .or_else(|| read_trimmed_string(row.get("id")));
        let call_id = raw_id.clone();

        let mapped_item_id = call_id
            .as_ref()
            .and_then(|resolved_call_id| call_id_to_function_item_id.get(resolved_call_id))
            .and_then(Value::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let output_id = if let Some(mapped) = mapped_item_id {
            Some(normalize_function_call_output_id(
                Some(mapped.as_str()),
                mapped.as_str(),
            ))
        } else if let Some(resolved_call_id) = call_id.as_ref() {
            let fallback = raw_id
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| resolved_call_id.clone());
            Some(normalize_function_call_output_id(
                Some(resolved_call_id.as_str()),
                fallback.as_str(),
            ))
        } else {
            None
        };

        let output_text = match row.get("output") {
            Some(Value::String(text)) => text.clone(),
            Some(other) => serde_json::to_string(other).unwrap_or_else(|_| other.to_string()),
            None => "null".to_string(),
        };

        let mut item = Map::new();
        item.insert(
            "type".to_string(),
            Value::String("function_call_output".to_string()),
        );
        if let Some(output_id_value) = output_id {
            item.insert("id".to_string(), Value::String(output_id_value));
        }
        if let Some(resolved_call_id) = call_id.clone() {
            item.insert("call_id".to_string(), Value::String(resolved_call_id));
        }
        item.insert("output".to_string(), Value::String(output_text.clone()));
        items.push(Value::Object(item));

        submitted.push(serde_json::json!({
            "callId": call_id.clone(),
            "originalId": raw_id.clone(),
            "outputText": output_text,
        }));
    }

    (items, submitted)
}

fn prepare_responses_conversation_entry(payload: &Value, context: &Value) -> Value {
    let mut base_payload = pick_responses_persisted_fields(payload)
        .as_object()
        .cloned()
        .unwrap_or_default();

    if let Some(model) = read_trimmed_string(payload.as_object().and_then(|row| row.get("model"))) {
        base_payload.insert("model".to_string(), Value::String(model));
    }
    if let Some(stream) = payload
        .as_object()
        .and_then(|row| row.get("stream"))
        .and_then(Value::as_bool)
    {
        base_payload.insert("stream".to_string(), Value::Bool(stream));
    }

    let input = clone_array(context.as_object().and_then(|row| row.get("input")));

    let tools = context
        .as_object()
        .and_then(|row| row.get("toolsRaw"))
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| {
            payload
                .as_object()
                .and_then(|row| row.get("tools"))
                .and_then(Value::as_array)
                .cloned()
        });

    if let Some(tool_values) = tools.clone() {
        base_payload.insert("tools".to_string(), Value::Array(tool_values));
    }
    if let Some(route_hint) = read_trimmed_string(
        context
            .as_object()
            .and_then(|row| row.get("routeHint"))
            .or_else(|| payload.as_object().and_then(|row| row.get("routeHint"))),
    ) {
        base_payload.insert("routeHint".to_string(), Value::String(route_hint));
    }

    let route_hint_value = base_payload.get("routeHint").cloned().unwrap_or(Value::Null);

    serde_json::json!({
        "basePayload": Value::Object(base_payload),
        "input": Value::Array(input),
        "tools": tools.map(Value::Array).unwrap_or(Value::Null),
        "routeHint": route_hint_value,
    })
}

fn resume_responses_conversation_payload(
    entry: &Value,
    response_id: &str,
    submit_payload: &Value,
    request_id: Option<&str>,
) -> Value {
    let entry_obj = entry.as_object().cloned().unwrap_or_default();
    let base_payload = clone_object(entry_obj.get("basePayload"));
    let mut payload = base_payload.clone();
    let mut merged_input = clone_array(entry_obj.get("input"));
    let tool_outputs = clone_array(
        submit_payload
            .as_object()
            .and_then(|row| row.get("tool_outputs")),
    );

    let (normalized_items, submitted_details) =
        normalize_submitted_tool_outputs(&tool_outputs, &merged_input);
    merged_input.extend(normalized_items);
    payload.insert("input".to_string(), Value::Array(merged_input));

    let stream = submit_payload
        .as_object()
        .and_then(|row| row.get("stream"))
        .and_then(Value::as_bool)
        .or_else(|| base_payload.get("stream").and_then(Value::as_bool))
        .unwrap_or(false);
    payload.insert("stream".to_string(), Value::Bool(stream));
    payload.insert(
        "previous_response_id".to_string(),
        Value::String(response_id.to_string()),
    );

    if let Some(tools) = entry_obj.get("tools").and_then(Value::as_array).cloned() {
        if !tools.is_empty() {
            payload.insert("tools".to_string(), Value::Array(tools));
        }
    }
    if let Some(route_hint) = read_trimmed_string(entry_obj.get("routeHint")) {
        payload.insert("routeHint".to_string(), Value::String(route_hint.clone()));
    }

    if let Some(model) =
        read_trimmed_string(submit_payload.as_object().and_then(|row| row.get("model")))
    {
        payload.insert("model".to_string(), Value::String(model));
    }

    if let Some(submit_meta) = submit_payload
        .as_object()
        .and_then(|row| row.get("metadata"))
        .and_then(Value::as_object)
    {
        let mut merged_meta = payload
            .get("metadata")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for (key, value) in submit_meta {
            merged_meta.insert(key.clone(), value.clone());
        }
        payload.insert("metadata".to_string(), Value::Object(merged_meta));
    }

    payload.remove("tool_outputs");
    payload.remove("response_id");

    serde_json::json!({
        "payload": Value::Object(payload),
        "meta": {
            "restoredFromResponseId": response_id,
            "previousRequestId": entry_obj.get("requestId").cloned().unwrap_or(Value::Null),
            "routeHint": entry_obj.get("routeHint").cloned().unwrap_or(Value::Null),
            "toolOutputs": tool_outputs.len(),
            "toolOutputsDetailed": submitted_details,
            "requestId": request_id.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
        }
    })
}

fn canonicalize_continuation_item(value: &Value) -> Value {
    let Some(row) = value.as_object() else {
        return value.clone();
    };
    let item_type = read_trimmed_string(row.get("type"));
    let role = read_trimmed_string(row.get("role"));
    let content = row.get("content").cloned();

    if role.is_some() && content.is_some() && item_type.as_deref() == Some("message") {
        return serde_json::json!({
            "role": role,
            "content": content
        });
    }

    if role.is_some() && content.is_some() && !row.contains_key("type") {
        return serde_json::json!({
            "role": role,
            "content": content
        });
    }

    let mut normalized = row.clone();
    normalized.remove("message");
    Value::Object(normalized)
}

fn values_equal(left: &Value, right: &Value) -> bool {
    canonicalize_continuation_item(left) == canonicalize_continuation_item(right)
}

fn find_exact_prefix_delta(prefix: &[Value], incoming: &[Value]) -> Option<Vec<Value>> {
    if prefix.is_empty() || incoming.len() <= prefix.len() {
        return None;
    }
    for (index, expected) in prefix.iter().enumerate() {
        let candidate = incoming.get(index)?;
        if !values_equal(expected, candidate) {
            return None;
        }
    }
    Some(incoming[prefix.len()..].to_vec())
}

fn count_common_leading_items(left: &[Value], right: &[Value]) -> usize {
    let mut count = 0usize;
    let max = left.len().min(right.len());
    while count < max {
        if !values_equal(&left[count], &right[count]) {
            break;
        }
        count += 1;
    }
    count
}

fn collect_submitted_tool_output_details(input_items: &[Value]) -> Vec<Value> {
    let mut submitted: Vec<Value> = Vec::new();
    for (index, entry) in input_items.iter().enumerate() {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let item_type = row.get("type").and_then(Value::as_str).unwrap_or("");
        if item_type != "function_call_output" {
            continue;
        }
        let call_id = read_trimmed_string(row.get("call_id"))
            .or_else(|| read_trimmed_string(row.get("id")))
            .unwrap_or_else(|| format!("resume_tool_{}", index + 1));
        let output_text = match row.get("output") {
            Some(Value::String(text)) => text.clone(),
            Some(other) => serde_json::to_string(other).unwrap_or_else(|_| other.to_string()),
            None => "null".to_string(),
        };
        submitted.push(serde_json::json!({
            "callId": call_id.clone(),
            "originalId": call_id,
            "outputText": output_text,
        }));
    }
    submitted
}

fn read_bridge_function_call_id(row: &Map<String, Value>) -> Option<String> {
    read_trimmed_string(row.get("call_id"))
        .or_else(|| read_trimmed_string(row.get("tool_call_id")))
        .or_else(|| read_trimmed_string(row.get("id")))
}

fn is_bridge_tool_output_item_type(item_type: &str) -> bool {
    matches!(
        item_type,
        "function_call_output" | "tool_result" | "tool_message"
    )
}

fn collect_pending_bridge_function_call_ids(input_items: &[Value]) -> Vec<String> {
    let mut pending: Vec<String> = Vec::new();
    for entry in input_items {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let item_type = row.get("type").and_then(Value::as_str).unwrap_or("").trim().to_ascii_lowercase();
        if item_type == "function_call" {
            if let Some(call_id) = read_bridge_function_call_id(row) {
                if !pending.iter().any(|existing| existing == &call_id) {
                    pending.push(call_id);
                }
            }
            continue;
        }
        if !is_bridge_tool_output_item_type(item_type.as_str()) {
            continue;
        }
        let Some(call_id) = read_bridge_function_call_id(row) else {
            continue;
        };
        if let Some(position) = pending.iter().position(|existing| existing == &call_id) {
            pending.remove(position);
        }
    }
    pending
}

fn leading_input_consumes_pending_tool_calls(
    incoming_items: &[Value],
    pending_call_ids: &[String],
) -> bool {
    if pending_call_ids.is_empty() {
        return true;
    }
    let mut remaining = pending_call_ids.to_vec();
    for entry in incoming_items {
        let Some(row) = entry.as_object() else {
            return false;
        };
        let item_type = row.get("type").and_then(Value::as_str).unwrap_or("").trim().to_ascii_lowercase();
        if !is_bridge_tool_output_item_type(item_type.as_str()) {
            break;
        }
        let Some(call_id) = read_bridge_function_call_id(row) else {
            return false;
        };
        let Some(position) = remaining.iter().position(|existing| existing == &call_id) else {
            return false;
        };
        remaining.remove(position);
        if remaining.is_empty() {
            return true;
        }
    }
    remaining.is_empty()
}

fn restore_responses_continuation_payload(
    entry: &Value,
    incoming_payload: &Value,
    request_id: Option<&str>,
    scope_key: Option<&str>,
) -> Value {
    let entry_obj = entry.as_object().cloned().unwrap_or_default();
    let incoming_obj = incoming_payload.as_object().cloned().unwrap_or_default();
    let last_response_id = read_trimmed_string(entry_obj.get("lastResponseId"));
    let incoming_input = clone_optional_array(incoming_obj.get("input"));

    let Some(response_id) = last_response_id else {
        return Value::Null;
    };
    let Some(input_items) = incoming_input else {
        return Value::Null;
    };
    let submitted_details = collect_submitted_tool_output_details(&input_items);
    let prefix = clone_array(entry_obj.get("input"));
    let Some(delta_input) = find_exact_prefix_delta(&prefix, &input_items) else {
        return Value::Null;
    };

    let mut payload = pick_responses_persisted_fields(&Value::Object(incoming_obj.clone()))
        .as_object()
        .cloned()
        .unwrap_or_default();

    for (key, value) in incoming_obj {
        if key == "input"
            || key == "previous_response_id"
            || key == "response_id"
            || key == "tool_outputs"
        {
            continue;
        }
        payload.insert(key, value);
    }

    if let Some(tools) = entry_obj.get("tools").and_then(Value::as_array).cloned() {
        if !tools.is_empty() && !payload.contains_key("tools") {
            payload.insert("tools".to_string(), Value::Array(tools));
        }
    }
    if let Some(route_hint) = read_trimmed_string(entry_obj.get("routeHint")) {
        payload.insert("routeHint".to_string(), Value::String(route_hint.clone()));
    }

    payload.insert("input".to_string(), Value::Array(delta_input.clone()));
    payload.insert(
        "previous_response_id".to_string(),
        Value::String(response_id.clone()),
    );

    serde_json::json!({
        "payload": Value::Object(payload),
        "meta": {
            "restoredFromResponseId": response_id,
            "previousRequestId": entry_obj.get("requestId").cloned().unwrap_or(Value::Null),
            "routeHint": entry_obj.get("routeHint").cloned().unwrap_or(Value::Null),
            "requestId": request_id.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
            "scopeKey": scope_key.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
            "deltaInputItems": delta_input.len(),
            "toolOutputsDetailed": submitted_details,
            "restored": true,
        }
    })
}

fn materialize_responses_continuation_payload(
    entry: &Value,
    incoming_payload: &Value,
    request_id: Option<&str>,
    scope_key: Option<&str>,
) -> Value {
    let entry_obj = entry.as_object().cloned().unwrap_or_default();
    let incoming_obj = incoming_payload.as_object().cloned().unwrap_or_default();
    let incoming_input = clone_optional_array(incoming_obj.get("input"));
    let Some(input_items) = incoming_input else {
        return Value::Null;
    };
    if input_items.is_empty() {
        return Value::Null;
    }

    let prefix = clone_array(entry_obj.get("input"));
    if prefix.is_empty() {
        return Value::Null;
    }
    let pending_call_ids = collect_pending_bridge_function_call_ids(&prefix);

    if find_exact_prefix_delta(&prefix, &input_items).is_some() || input_items == prefix {
        return Value::Null;
    }

    let common_prefix_len = count_common_leading_items(&prefix, &input_items);
    if common_prefix_len > 0 {
        return Value::Null;
    }
    if !pending_call_ids.is_empty()
        && !leading_input_consumes_pending_tool_calls(&input_items, &pending_call_ids)
    {
        return Value::Null;
    }

    let last_response_id = read_trimmed_string(entry_obj.get("lastResponseId"));
    let submitted_details = collect_submitted_tool_output_details(&input_items);
    let mut full_input = prefix.clone();
    full_input.extend(input_items.clone());

    let mut payload = pick_responses_persisted_fields(&Value::Object(incoming_obj.clone()))
        .as_object()
        .cloned()
        .unwrap_or_default();

    for (key, value) in incoming_obj {
        if key == "input" || key == "response_id" || key == "tool_outputs" {
            continue;
        }
        if key == "previous_response_id" {
            continue;
        }
        payload.insert(key, value);
    }

    if let Some(tools) = entry_obj.get("tools").and_then(Value::as_array).cloned() {
        if !tools.is_empty() && !payload.contains_key("tools") {
            payload.insert("tools".to_string(), Value::Array(tools));
        }
    }
    if let Some(route_hint) = read_trimmed_string(entry_obj.get("routeHint")) {
        payload.insert("routeHint".to_string(), Value::String(route_hint.clone()));
    }

    payload.insert("input".to_string(), Value::Array(full_input.clone()));
    payload.remove("previous_response_id");

    serde_json::json!({
        "payload": Value::Object(payload),
        "meta": {
            "restoredFromResponseId": last_response_id.map(Value::String).unwrap_or(Value::Null),
            "previousRequestId": entry_obj.get("requestId").cloned().unwrap_or(Value::Null),
            "routeHint": entry_obj.get("routeHint").cloned().unwrap_or(Value::Null),
            "requestId": request_id.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
            "scopeKey": scope_key.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
            "materialized": true,
            "materializedMode": "local_full_input",
            "incomingInputItems": input_items.len(),
            "fullInputItems": full_input.len(),
            "toolOutputsDetailed": submitted_details,
        }
    })
}

#[napi_derive::napi]
pub fn pick_responses_persisted_fields_json(payload_json: String) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = pick_responses_persisted_fields(&payload);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn convert_responses_output_to_input_items_json(response_json: String) -> NapiResult<String> {
    let response: Value = serde_json::from_str(&response_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = convert_responses_output_to_input_items(&response);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn prepare_responses_conversation_entry_json(
    payload_json: String,
    context_json: String,
) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let context: Value =
        serde_json::from_str(&context_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = prepare_responses_conversation_entry(&payload, &context);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn resume_responses_conversation_payload_json(
    entry_json: String,
    response_id: String,
    submit_payload_json: String,
    request_id: Option<String>,
) -> NapiResult<String> {
    let entry: Value =
        serde_json::from_str(&entry_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let submit_payload: Value = serde_json::from_str(&submit_payload_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resume_responses_conversation_payload(
        &entry,
        &response_id,
        &submit_payload,
        request_id.as_deref(),
    );
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn restore_responses_continuation_payload_json(
    entry_json: String,
    incoming_payload_json: String,
    request_id: Option<String>,
    scope_key: Option<String>,
) -> NapiResult<String> {
    let entry: Value =
        serde_json::from_str(&entry_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let incoming_payload: Value = serde_json::from_str(&incoming_payload_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = restore_responses_continuation_payload(
        &entry,
        &incoming_payload,
        request_id.as_deref(),
        scope_key.as_deref(),
    );
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn materialize_responses_continuation_payload_json(
    entry_json: String,
    incoming_payload_json: String,
    request_id: Option<String>,
    scope_key: Option<String>,
) -> NapiResult<String> {
    let entry: Value =
        serde_json::from_str(&entry_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let incoming_payload: Value = serde_json::from_str(&incoming_payload_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = materialize_responses_continuation_payload(
        &entry,
        &incoming_payload,
        request_id.as_deref(),
        scope_key.as_deref(),
    );
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{
        convert_responses_output_to_input_items, materialize_responses_continuation_payload,
        prepare_responses_conversation_entry, restore_responses_continuation_payload,
        resume_responses_conversation_payload,
    };
    use serde_json::{json, Value};

    #[test]
    fn shared_responses_conversation_prepare_and_resume_json() {
        let payload = json!({
            "model": "gpt-base",
            "stream": true,
            "metadata": { "origin": "base" },
            "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
            "top_p": 0.5
        });
        let context = json!({
            "input": [
                { "type": "message", "role": "user", "content": [{ "type": "text", "text": "hi" }] },
                { "type": "function_call", "id": "fc_item_1", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" }
            ]
        });
        let entry = prepare_responses_conversation_entry(&payload, &context);
        let resumed = resume_responses_conversation_payload(
            &json!({
                "requestId": "req_1",
                "basePayload": entry.get("basePayload").cloned().unwrap_or(Value::Null),
                "input": entry.get("input").cloned().unwrap_or(Value::Null),
                "tools": entry.get("tools").cloned().unwrap_or(Value::Null)
            }),
            "resp_1",
            &json!({
                "tool_outputs": [{ "call_id": "call_1", "output": { "cmd": "pwd" } }],
                "metadata": { "resume": true },
                "stream": false
            }),
            Some("req_2"),
        );

        let payload = resumed.get("payload").and_then(Value::as_object).unwrap();
        assert_eq!(
            payload.get("model").and_then(Value::as_str),
            Some("gpt-base")
        );
        assert_eq!(payload.get("stream").and_then(Value::as_bool), Some(false));
        assert_eq!(
            payload.get("previous_response_id").and_then(Value::as_str),
            Some("resp_1")
        );
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        let output_item = input.last().and_then(Value::as_object).unwrap();
        assert_eq!(
            output_item.get("id").and_then(Value::as_str),
            Some("fc_item_1")
        );
        assert_eq!(
            output_item.get("output").and_then(Value::as_str),
            Some("{\"cmd\":\"pwd\"}")
        );
        let meta = resumed.get("meta").and_then(Value::as_object).unwrap();
        assert_eq!(meta.get("toolOutputs").and_then(Value::as_u64), Some(1));
    }

    #[test]
    fn restores_plain_responses_continuation_when_incoming_input_replays_exact_prefix() {
        let restored = restore_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "hello" }] }
                ]
            }),
            &json!({
                "model": "gpt-5.3-codex",
                "stream": true,
                "metadata": { "session_id": "sess-1" },
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "hello" }] },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        let payload = restored.get("payload").and_then(Value::as_object).unwrap();
        assert_eq!(
            payload.get("previous_response_id").and_then(Value::as_str),
            Some("resp_prev")
        );
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["content"][0]["text"].as_str(), Some("next"));
        let meta = restored.get("meta").and_then(Value::as_object).unwrap();
        assert_eq!(
            meta.get("scopeKey").and_then(Value::as_str),
            Some("session:sess-1")
        );
    }

    #[test]
    fn does_not_restore_plain_continuation_when_prefix_does_not_match() {
        let restored = restore_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] }
                ]
            }),
            &json!({
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "different" }] },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        assert!(restored.is_null());
    }

    #[test]
    fn materialize_plain_continuation_only_when_incoming_is_pure_delta() {
        let materialized = materialize_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "hello" }] }
                ]
            }),
            &json!({
                "model": "gpt-5.3-codex",
                "stream": true,
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        let payload = materialized.get("payload").and_then(Value::as_object).unwrap();
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 3);
        assert_eq!(input[2]["content"][0]["text"].as_str(), Some("next"));
    }

    #[test]
    fn does_not_materialize_plain_continuation_when_prefix_has_pending_tool_call_without_leading_output() {
        let materialized = materialize_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "run pwd" }] },
                    { "type": "function_call", "id": "fc_call_1", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" }
                ]
            }),
            &json!({
                "model": "gpt-5.3-codex",
                "stream": true,
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "继续" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        assert!(materialized.is_null());
    }

    #[test]
    fn materializes_plain_continuation_when_leading_tool_output_consumes_pending_tool_call() {
        let materialized = materialize_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "run pwd" }] },
                    { "type": "function_call", "id": "fc_call_1", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" }
                ]
            }),
            &json!({
                "model": "gpt-5.3-codex",
                "stream": true,
                "input": [
                    { "type": "function_call_output", "call_id": "call_1", "output": "/tmp" },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "继续" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        let payload = materialized.get("payload").and_then(Value::as_object).unwrap();
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 4);
        assert_eq!(input[1]["type"].as_str(), Some("function_call"));
        assert_eq!(input[2]["type"].as_str(), Some("function_call_output"));
        assert_eq!(input[3]["content"][0]["text"].as_str(), Some("继续"));
    }

    #[test]
    fn does_not_materialize_plain_continuation_when_incoming_partially_replays_prefix() {
        let materialized = materialize_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "hello" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "tool result summary" }] }
                ]
            }),
            &json!({
                "model": "gpt-5.3-codex",
                "stream": true,
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "hello" }] },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        assert!(materialized.is_null());
    }

    #[test]
    fn drops_invalid_shell_like_function_calls_when_converting_output_items() {
        let response = json!({
            "output": [
                {
                    "type": "function_call",
                    "id": "fc_bad",
                    "call_id": "call_bad",
                    "name": "exec_command",
                    "arguments": "{\"cmd<arg_value>cd /repo && git status</arg_value><arg_key>command\":\"cd /repo && git status\"}"
                },
                {
                    "type": "function_call",
                    "id": "fc_good",
                    "call_id": "call_good",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"pwd\",\"cwd\":\"/tmp\"}"
                }
            ]
        });

        let items = convert_responses_output_to_input_items(&response)
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["call_id"], "call_good");
        let args_text = items[0]["arguments"].as_str().unwrap_or("{}");
        let args: Value = serde_json::from_str(args_text).expect("args object");
        assert_eq!(args["cmd"], "pwd");
        assert_eq!(args["workdir"], "/tmp");
    }

    #[test]
    fn preserves_command_only_exec_command_when_converting_output_items() {
        let response = json!({
            "output": [
                {
                    "type": "function_call",
                    "id": "fc_bad",
                    "call_id": "call_bad",
                    "name": "exec_command",
                    "arguments": "{\"command\":\"pwd\",\"cwd\":\"/tmp\"}"
                }
            ]
        });

        let items = convert_responses_output_to_input_items(&response)
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["call_id"], "call_bad");
        let args_text = items[0]["arguments"].as_str().unwrap_or("{}");
        let args: Value = serde_json::from_str(args_text).expect("args object");
        assert_eq!(args["command"], "pwd");
        assert!(args.get("cmd").is_none());
        assert_eq!(args["workdir"], "/tmp");
    }
}
