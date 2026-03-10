use crate::hub_bridge_actions::utils::normalize_function_call_output_id;
use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{Map, Value};

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
                    if let Some(args) = row.get("arguments") {
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
        if let Some(arguments) = row.get("arguments") {
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
        let call_id = raw_id
            .clone()
            .unwrap_or_else(|| format!("call_resume_{}", index));

        let mapped_item_id = call_id_to_function_item_id
            .get(&call_id)
            .and_then(Value::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let output_id = if let Some(mapped) = mapped_item_id {
            normalize_function_call_output_id(Some(mapped.as_str()), mapped.as_str())
        } else {
            let fallback = raw_id
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| format!("fc_resume_{}", index));
            normalize_function_call_output_id(Some(call_id.as_str()), fallback.as_str())
        };

        let output_text = match row.get("output") {
            Some(Value::String(text)) => text.clone(),
            Some(other) => serde_json::to_string(other).unwrap_or_else(|_| other.to_string()),
            None => "null".to_string(),
        };

        items.push(serde_json::json!({
            "type": "function_call_output",
            "id": output_id,
            "call_id": call_id,
            "output": output_text,
        }));

        submitted.push(serde_json::json!({
            "callId": call_id,
            "originalId": raw_id.unwrap_or_else(|| call_id.clone()),
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

    serde_json::json!({
        "basePayload": Value::Object(base_payload),
        "input": Value::Array(input),
        "tools": tools.map(Value::Array).unwrap_or(Value::Null),
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
            "toolOutputs": tool_outputs.len(),
            "toolOutputsDetailed": submitted_details,
            "requestId": request_id.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
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

#[cfg(test)]
mod tests {
    use super::{prepare_responses_conversation_entry, resume_responses_conversation_payload};
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
}
