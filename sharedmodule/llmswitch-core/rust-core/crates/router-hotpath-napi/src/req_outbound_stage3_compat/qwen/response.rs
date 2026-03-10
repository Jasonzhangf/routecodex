use serde_json::{Map, Number, Value};

fn number_or_default(value: Option<&Value>, fallback: i64) -> Value {
    if let Some(raw) = value {
        if let Some(num) = raw.as_i64() {
            return Value::Number(Number::from(num));
        }
        if let Some(num) = raw.as_u64() {
            return Value::Number(Number::from(num));
        }
        if let Some(num) = raw.as_f64() {
            if let Some(number) = Number::from_f64(num) {
                return Value::Number(number);
            }
        }
    }
    Value::Number(Number::from(fallback))
}

fn transform_qwen_finish_reason(reason: Option<&str>) -> String {
    match reason.unwrap_or("stop") {
        "stop" => "stop".to_string(),
        "length" => "length".to_string(),
        "tool_calls" => "tool_calls".to_string(),
        "content_filter" => "content_filter".to_string(),
        other => other.to_string(),
    }
}

fn transform_qwen_tool_calls(tool_calls: Option<&Value>) -> Vec<Value> {
    let Some(entries) = tool_calls.and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    entries
        .iter()
        .enumerate()
        .map(|(index, raw_call)| {
            let call_obj = raw_call.as_object().cloned().unwrap_or_default();
            let function_obj = call_obj
                .get("function")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            let id = call_obj
                .get("id")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
                .unwrap_or_else(|| format!("call_{}_{}", now_ms, index));
            let name = function_obj
                .get("name")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
                .unwrap_or_else(String::new);
            let args = match function_obj.get("arguments") {
                Some(Value::String(text)) => text.clone(),
                Some(other) => serde_json::to_string(other).unwrap_or_else(|_| "{}".to_string()),
                None => "{}".to_string(),
            };
            let mut function = Map::new();
            function.insert("name".to_string(), Value::String(name));
            function.insert("arguments".to_string(), Value::String(args));

            let mut tool_call = Map::new();
            tool_call.insert("id".to_string(), Value::String(id));
            tool_call.insert("type".to_string(), Value::String("function".to_string()));
            tool_call.insert("function".to_string(), Value::Object(function));
            Value::Object(tool_call)
        })
        .collect::<Vec<Value>>()
}

fn transform_qwen_choices(raw_choices: Option<&Value>) -> Vec<Value> {
    let Some(choices) = raw_choices.and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    choices
        .iter()
        .enumerate()
        .map(|(index, raw_choice)| {
            let choice_obj = raw_choice.as_object().cloned().unwrap_or_default();
            let message_obj = choice_obj
                .get("message")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            let index_value = number_or_default(choice_obj.get("index"), index as i64);
            let role = message_obj
                .get("role")
                .and_then(|v| v.as_str())
                .unwrap_or("assistant")
                .to_string();
            let content = message_obj
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let reasoning = message_obj
                .get("reasoning_content")
                .and_then(|v| v.as_str())
                .or_else(|| message_obj.get("reasoning").and_then(|v| v.as_str()))
                .map(|v| v.trim())
                .filter(|v| !v.is_empty())
                .map(|v| v.to_string());
            let tool_calls = transform_qwen_tool_calls(message_obj.get("tool_calls"));
            let finish_reason = transform_qwen_finish_reason(
                choice_obj.get("finish_reason").and_then(|v| v.as_str()),
            );

            let mut message = Map::new();
            message.insert("role".to_string(), Value::String(role));
            message.insert("content".to_string(), Value::String(content));
            message.insert("tool_calls".to_string(), Value::Array(tool_calls));
            if let Some(reasoning) = reasoning {
                message.insert("reasoning_content".to_string(), Value::String(reasoning));
            }

            let mut out = Map::new();
            out.insert("index".to_string(), index_value);
            out.insert("message".to_string(), Value::Object(message));
            out.insert("finish_reason".to_string(), Value::String(finish_reason));
            Value::Object(out)
        })
        .collect::<Vec<Value>>()
}

pub(crate) fn apply_qwen_response_compat(payload: Value) -> Value {
    let response_obj = payload.as_object().cloned().unwrap_or_default();
    let data_obj = response_obj
        .get("data")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or(response_obj);
    let usage = data_obj
        .get("usage")
        .and_then(|v| v.as_object())
        .cloned()
        .map(Value::Object)
        .unwrap_or_else(|| {
            let mut usage_obj = Map::new();
            usage_obj.insert("prompt_tokens".to_string(), Value::Number(Number::from(0)));
            usage_obj.insert(
                "completion_tokens".to_string(),
                Value::Number(Number::from(0)),
            );
            usage_obj.insert("total_tokens".to_string(), Value::Number(Number::from(0)));
            Value::Object(usage_obj)
        });
    let now_ms = chrono::Utc::now().timestamp_millis();
    let now_s = chrono::Utc::now().timestamp();
    let id = data_obj
        .get("id")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
        .unwrap_or_else(|| format!("chatcmpl-{}", now_ms));
    let model = data_obj
        .get("model")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
        .unwrap_or_else(|| "qwen-turbo".to_string());
    let created = number_or_default(data_obj.get("created"), now_s);
    let choices = transform_qwen_choices(data_obj.get("choices"));

    let mut transformed = Map::new();
    transformed.insert("id".to_string(), Value::String(id));
    transformed.insert(
        "object".to_string(),
        Value::String("chat.completion".to_string()),
    );
    transformed.insert("created".to_string(), created);
    transformed.insert("model".to_string(), Value::String(model));
    transformed.insert("choices".to_string(), Value::Array(choices));
    transformed.insert("usage".to_string(), usage);
    transformed.insert("_transformed".to_string(), Value::Bool(true));
    transformed.insert(
        "_originalFormat".to_string(),
        Value::String("qwen".to_string()),
    );
    transformed.insert(
        "_targetFormat".to_string(),
        Value::String("openai".to_string()),
    );
    Value::Object(transformed)
}
