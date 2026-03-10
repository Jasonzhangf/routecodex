use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::Deserialize;
use serde_json::{Map, Value};

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct OpenAiOpenAiRequestOptions {
    #[serde(default = "default_true")]
    preserve_stream_field: bool,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct OpenAiOpenAiResponseOptions {
    #[serde(default)]
    stream: bool,
    #[serde(default)]
    reasoning_mode: Option<String>,
    #[serde(default)]
    endpoint: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    id_prefix_base: Option<String>,
}

fn default_true() -> bool {
    true
}

fn parse_options<T>(options_json: Option<String>) -> NapiResult<T>
where
    T: for<'de> Deserialize<'de> + Default,
{
    match options_json {
        Some(raw) if !raw.trim().is_empty() => {
            serde_json::from_str(&raw).map_err(|e| napi::Error::from_reason(e.to_string()))
        }
        _ => Ok(T::default()),
    }
}

fn parse_value(raw: &str) -> NapiResult<Value> {
    serde_json::from_str(raw).map_err(|e| napi::Error::from_reason(e.to_string()))
}

fn stringify_value(value: &Value) -> NapiResult<String> {
    serde_json::to_string(value).map_err(|e| napi::Error::from_reason(e.to_string()))
}

fn stringify_json_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        _ => serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string()),
    }
}

fn normalize_request_tool_call_arguments(payload: &mut Value) {
    let Some(messages) = payload.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };

    for message in messages.iter_mut() {
        let Some(tool_calls) = message
            .as_object_mut()
            .and_then(|row| row.get_mut("tool_calls"))
            .and_then(Value::as_array_mut)
        else {
            continue;
        };

        for tool_call in tool_calls.iter_mut() {
            let Some(function) = tool_call
                .as_object_mut()
                .and_then(|row| row.get_mut("function"))
                .and_then(Value::as_object_mut)
            else {
                continue;
            };

            let arguments = function
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()));
            function.insert(
                "arguments".to_string(),
                Value::String(stringify_json_value(&arguments)),
            );
        }
    }
}

fn unwrap_response_payload(payload: Value) -> Value {
    let mut current = payload;
    loop {
        let Some(row) = current.as_object() else {
            return current;
        };
        if row.contains_key("choices") || row.contains_key("id") || row.contains_key("object") {
            return current;
        }
        let Some(next) = row.get("data") else {
            return current;
        };
        if !next.is_object() {
            return current;
        }
        current = next.clone();
    }
}

#[napi(js_name = "runOpenaiOpenaiRequestCodecJson")]
pub fn run_openai_openai_request_codec_json(
    payload_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    let options: OpenAiOpenAiRequestOptions = parse_options(options_json)?;
    let mut payload = parse_value(&payload_json)?;
    normalize_request_tool_call_arguments(&mut payload);

    let pruned_raw = crate::shared_chat_request_filters::prune_chat_request_payload_json(
        serde_json::to_string(&serde_json::json!({
            "payload": payload,
            "preserveStreamField": options.preserve_stream_field,
        }))
        .map_err(|e| napi::Error::from_reason(e.to_string()))?,
    )?;
    let pruned = parse_value(&pruned_raw)?;
    stringify_value(&pruned)
}

#[napi(js_name = "runOpenaiOpenaiResponseCodecJson")]
pub fn run_openai_openai_response_codec_json(
    payload_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    let options: OpenAiOpenAiResponseOptions = parse_options(options_json)?;
    let unwrapped = unwrap_response_payload(parse_value(&payload_json)?);

    let normalized_raw =
        crate::hub_reasoning_tool_normalizer::normalize_chat_response_reasoning_tools_json(
            stringify_value(&unwrapped)?,
            options.id_prefix_base.clone(),
        )?;
    let normalized = parse_value(&normalized_raw)?;

    let finalized_raw = crate::resp_process_stage2_finalize::finalize_chat_response_json(
        serde_json::to_string(&serde_json::json!({
            "payload": normalized,
            "stream": options.stream,
            "reasoningMode": options.reasoning_mode,
            "endpoint": options.endpoint,
            "requestId": options.request_id,
        }))
        .map_err(|e| napi::Error::from_reason(e.to_string()))?,
    )?;
    let finalized = parse_value(&finalized_raw)?;
    let output = finalized
        .as_object()
        .and_then(|row| {
            row.get("finalizedPayload")
                .or_else(|| row.get("finalized_payload"))
        })
        .cloned()
        .unwrap_or(finalized);
    stringify_value(&output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_codec_stringifies_arguments_and_preserves_stream() {
        let raw = run_openai_openai_request_codec_json(
            json!({
                "model": "gpt-4.1",
                "stream": true,
                "metadata": { "drop": true },
                "messages": [
                    {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "call_id": "call_1",
                                "tool_call_id": "call_1",
                                "function": {
                                    "name": "exec_command",
                                    "arguments": { "cmd": "pwd" }
                                }
                            }
                        ]
                    }
                ]
            })
            .to_string(),
            None,
        )
        .unwrap();

        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["stream"], true);
        assert!(value.get("metadata").is_none());
        assert_eq!(
            value["messages"][0]["tool_calls"][0]["function"]["arguments"],
            Value::String("{\"cmd\":\"pwd\"}".to_string())
        );
        assert!(value["messages"][0]["tool_calls"][0]
            .get("call_id")
            .is_none());
    }

    #[test]
    fn response_codec_normalizes_reasoning_tools_and_finalizes() {
        let raw = run_openai_openai_response_codec_json(
            json!({
                "data": {
                    "choices": [
                        {
                            "finish_reason": null,
                            "message": {
                                "role": "assistant",
                                "content": "Working on it",
                                "reasoning_content": "<tool_call>{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"pwd\"}}</tool_call>"
                            }
                        }
                    ],
                    "messages": [
                        {
                            "role": "assistant",
                            "tool_calls": [
                                {
                                    "id": "call_1",
                                    "function": {
                                        "name": "exec_command",
                                        "arguments": { "cmd": "pwd" }
                                    }
                                }
                            ]
                        },
                        {
                            "role": "tool",
                            "tool_call_id": "call_1",
                            "content": { "ok": true }
                        }
                    ]
                }
            })
            .to_string(),
            Some(json!({ "requestId": "req_resp" }).to_string()),
        )
        .unwrap();

        let value: Value = serde_json::from_str(&raw).unwrap();
        let finalized = value
            .get("finalizedPayload")
            .cloned()
            .unwrap_or(value.clone());
        assert_eq!(finalized["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(finalized["choices"][0]["message"]["content"], Value::Null);
        assert_eq!(
            finalized["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"],
            Value::String("{\"cmd\":\"pwd\"}".to_string())
        );
        assert_eq!(finalized["messages"][1]["name"], "exec_command");
        assert_eq!(
            finalized["messages"][1]["content"],
            Value::String("{\"ok\":true}".to_string())
        );
    }
}
