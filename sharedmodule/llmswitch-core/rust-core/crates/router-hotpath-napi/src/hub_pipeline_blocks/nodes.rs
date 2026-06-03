use serde_json::{Map, Value};

pub(crate) fn build_req_outbound_node_result(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "req outbound node result input must be object".to_string())?;

    let outbound_start = read_i64_from_input(row, "outboundStart")
        .ok_or_else(|| "outboundStart is required".to_string())?;
    let outbound_end = read_i64_from_input(row, "outboundEnd")
        .ok_or_else(|| "outboundEnd is required".to_string())?;
    let messages = read_i64_from_input(row, "messages").unwrap_or(0);
    let tools = read_i64_from_input(row, "tools").unwrap_or(0);

    let observation = build_node_observation(messages, tools);

    let mut metadata = Map::<String, Value>::new();
    metadata.insert(
        "node".to_string(),
        Value::String("req_outbound".to_string()),
    );
    metadata.insert(
        "executionTime".to_string(),
        Value::Number(serde_json::Number::from(outbound_end - outbound_start)),
    );
    metadata.insert(
        "startTime".to_string(),
        Value::Number(serde_json::Number::from(outbound_start)),
    );
    metadata.insert(
        "endTime".to_string(),
        Value::Number(serde_json::Number::from(outbound_end)),
    );

    let mut out = Map::<String, Value>::new();
    out.insert("id".to_string(), Value::String("req_outbound".to_string()));
    out.insert("success".to_string(), Value::Bool(true));
    out.insert("metadata".to_string(), Value::Object(metadata));
    out.insert("observation".to_string(), observation);

    Ok(Value::Object(out))
}

pub(crate) fn build_req_inbound_node_result(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "req inbound node result input must be object".to_string())?;

    let inbound_start = read_i64_from_input(row, "inboundStart")
        .ok_or_else(|| "inboundStart is required".to_string())?;
    let inbound_end = read_i64_from_input(row, "inboundEnd")
        .ok_or_else(|| "inboundEnd is required".to_string())?;
    let messages = read_i64_from_input(row, "messages").unwrap_or(0);
    let tools = read_i64_from_input(row, "tools").unwrap_or(0);

    let observation = build_node_observation(messages, tools);

    let mut metadata = Map::<String, Value>::new();
    metadata.insert("node".to_string(), Value::String("req_inbound".to_string()));
    metadata.insert(
        "executionTime".to_string(),
        Value::Number(serde_json::Number::from(inbound_end - inbound_start)),
    );
    metadata.insert(
        "startTime".to_string(),
        Value::Number(serde_json::Number::from(inbound_start)),
    );
    metadata.insert(
        "endTime".to_string(),
        Value::Number(serde_json::Number::from(inbound_end)),
    );

    let mut out = Map::<String, Value>::new();
    out.insert("id".to_string(), Value::String("req_inbound".to_string()));
    out.insert("success".to_string(), Value::Bool(true));
    out.insert("metadata".to_string(), Value::Object(metadata));
    out.insert("observation".to_string(), observation);
    Ok(Value::Object(out))
}

pub(crate) fn build_req_inbound_skipped_node(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "req inbound skipped node input must be object".to_string())?;
    let reason = row
        .get("reason")
        .and_then(|v| v.as_str())
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .unwrap_or("stage=outbound")
        .to_string();

    let mut metadata = Map::<String, Value>::new();
    metadata.insert("node".to_string(), Value::String("req_inbound".to_string()));
    metadata.insert("skipped".to_string(), Value::Bool(true));
    metadata.insert("reason".to_string(), Value::String(reason));

    let mut out = Map::<String, Value>::new();
    out.insert("id".to_string(), Value::String("req_inbound".to_string()));
    out.insert("success".to_string(), Value::Bool(true));
    out.insert("metadata".to_string(), Value::Object(metadata));
    out.insert("observation".to_string(), build_node_observation(0, 0));
    Ok(Value::Object(out))
}

pub(crate) fn build_captured_chat_request_snapshot(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "captured chat request snapshot input must be object".to_string())?;

    let mut out = Map::<String, Value>::new();
    out.insert(
        "model".to_string(),
        row.get("model").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "messages".to_string(),
        row.get("messages").cloned().unwrap_or(Value::Null),
    );
    if row.contains_key("input") {
        out.insert(
            "input".to_string(),
            row.get("input").cloned().unwrap_or(Value::Null),
        );
    }
    if let Some(tools) = row.get("tools") {
        out.insert("tools".to_string(), tools.clone());
    } else {
        out.insert("tools".to_string(), Value::Null);
    }
    if let Some(tool_choice) = row.get("tool_choice") {
        out.insert("tool_choice".to_string(), tool_choice.clone());
    }
    if let Some(semantics) = row.get("semantics") {
        out.insert("semantics".to_string(), semantics.clone());
    } else {
        out.insert("semantics".to_string(), Value::Null);
    }
    if let Some(parameters) = row.get("parameters") {
        out.insert("parameters".to_string(), parameters.clone());
    } else {
        out.insert("parameters".to_string(), Value::Null);
    }
    Ok(Value::Object(out))
}

pub(crate) fn build_tool_governance_node_result(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "tool governance node result input must be object".to_string())?;

    let success = row
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let metadata = row
        .get("metadata")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let mut out = Map::<String, Value>::new();
    out.insert(
        "id".to_string(),
        Value::String("chat_process.req.stage4.tool_governance".to_string()),
    );
    out.insert("success".to_string(), Value::Bool(success));
    out.insert("metadata".to_string(), Value::Object(metadata));

    if let Some(error_obj) = row.get("error").and_then(|v| v.as_object()) {
        let mut normalized_error = Map::<String, Value>::new();
        let code = match error_obj.get("code") {
            Some(value) if !value.is_null() => value.clone(),
            _ => Value::String("hub_chat_process_error".to_string()),
        };
        normalized_error.insert("code".to_string(), code);

        if let Some(message) = error_obj.get("message") {
            normalized_error.insert("message".to_string(), message.clone());
        }
        if let Some(details) = error_obj.get("details") {
            normalized_error.insert("details".to_string(), details.clone());
        }

        out.insert("error".to_string(), Value::Object(normalized_error));
    }

    Ok(Value::Object(out))
}

pub(crate) fn build_passthrough_governance_skipped_node() -> Value {
    let mut metadata = Map::<String, Value>::new();
    metadata.insert(
        "node".to_string(),
        Value::String("chat_process.req.stage4.tool_governance".to_string()),
    );
    metadata.insert("skipped".to_string(), Value::Bool(true));
    metadata.insert(
        "reason".to_string(),
        Value::String("process_mode_passthrough_parse_record_only".to_string()),
    );

    let mut out = Map::<String, Value>::new();
    out.insert(
        "id".to_string(),
        Value::String("chat_process.req.stage4.tool_governance".to_string()),
    );
    out.insert("success".to_string(), Value::Bool(true));
    out.insert("metadata".to_string(), Value::Object(metadata));
    Value::Object(out)
}

fn read_i64_from_input(row: &Map<String, Value>, key: &str) -> Option<i64> {
    row.get(key).and_then(|value| match value {
        Value::Number(num) => {
            if let Some(v) = num.as_i64() {
                return Some(v);
            }
            num.as_f64().and_then(|raw| {
                if raw.is_finite() {
                    Some(raw.trunc() as i64)
                } else {
                    None
                }
            })
        }
        _ => None,
    })
}

fn build_node_observation(messages: i64, tools: i64) -> Value {
    let mut data_processed = Map::<String, Value>::new();
    data_processed.insert(
        "messages".to_string(),
        Value::Number(serde_json::Number::from(messages.max(0))),
    );
    data_processed.insert(
        "tools".to_string(),
        Value::Number(serde_json::Number::from(tools.max(0))),
    );

    let mut observation = Map::<String, Value>::new();
    observation.insert("dataProcessed".to_string(), Value::Object(data_processed));
    Value::Object(observation)
}
