// feature_id: hub.servertool_followup

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolPostflightObservationInput {
    pub engine_result: Value,
}

fn string_field<'a>(record: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    record.get(key).and_then(Value::as_str)
}

fn object_field<'a>(record: &'a Map<String, Value>, key: &str) -> Option<&'a Map<String, Value>> {
    record.get(key).and_then(Value::as_object)
}

fn array_len_field(record: &Map<String, Value>, key: &str) -> Option<usize> {
    record.get(key).and_then(Value::as_array).map(Vec::len)
}

/// feature_id: hub.servertool_followup
pub fn build_servertool_postflight_observation_summary(
    input: ServertoolPostflightObservationInput,
) -> Result<Value, String> {
    let engine = input
        .engine_result
        .as_object()
        .ok_or_else(|| "SERVERTOOL_POSTFLIGHT_INVALID_FIELD: engineResult".to_string())?;
    let final_chat = object_field(engine, "finalChatResponse");
    let execution = object_field(engine, "execution");
    let tool_outputs = final_chat
        .and_then(|chat| chat.get("tool_outputs"))
        .and_then(Value::as_array);
    let mut summary = Map::new();
    summary.insert(
        "mode".to_string(),
        engine.get("mode").cloned().unwrap_or(Value::Null),
    );
    summary.insert(
        "flowId".to_string(),
        execution
            .and_then(|value| value.get("flowId"))
            .cloned()
            .unwrap_or(Value::Null),
    );
    summary.insert(
        "hasFollowup".to_string(),
        Value::Bool(
            execution
                .and_then(|value| value.get("followup"))
                .is_some_and(|value| !value.is_null()),
        ),
    );
    summary.insert(
        "pendingInjection".to_string(),
        Value::Bool(
            engine
                .get("pendingInjection")
                .is_some_and(|value| !value.is_null()),
        ),
    );
    summary.insert(
        "toolOutputCount".to_string(),
        json!(tool_outputs.map(Vec::len).unwrap_or(0)),
    );

    if let Some(first_tool_output) = tool_outputs
        .and_then(|items| items.first())
        .and_then(Value::as_object)
    {
        if let Some(tool_name) = string_field(first_tool_output, "tool_name") {
            summary.insert("toolName".to_string(), json!(tool_name));
        }
        if let Some(tool_call_id) = string_field(first_tool_output, "tool_call_id") {
            summary.insert("toolCallId".to_string(), json!(tool_call_id));
        }
        if let Some(content) = string_field(first_tool_output, "content") {
            summary.insert("toolOutputContent".to_string(), json!(content));
        }
    }

    if let Some(followup) = execution
        .and_then(|value| value.get("followup"))
        .and_then(Value::as_object)
    {
        let mut followup_summary = Map::new();
        if let Some(request_id_suffix) = string_field(followup, "requestIdSuffix") {
            followup_summary.insert("requestIdSuffix".to_string(), json!(request_id_suffix));
        }
        if let Some(entry_endpoint) = string_field(followup, "entryEndpoint") {
            followup_summary.insert("entryEndpoint".to_string(), json!(entry_endpoint));
        }

        if let Some(payload) = object_field(followup, "payload") {
            followup_summary.insert("mode".to_string(), json!("payload"));
            if let Some(message_count) = array_len_field(payload, "messages") {
                followup_summary.insert("messageCount".to_string(), json!(message_count));
            }
            if let Some(input_count) = array_len_field(payload, "input") {
                followup_summary.insert("inputCount".to_string(), json!(input_count));
            }
        } else if let Some(injection) = object_field(followup, "injection") {
            followup_summary.insert("mode".to_string(), json!("injection"));
            let ops = injection
                .get("ops")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| {
                            item.as_object()
                                .and_then(|record| string_field(record, "op"))
                                .map(|value| json!(value))
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            followup_summary.insert("injectionOps".to_string(), Value::Array(ops));
        } else {
            followup_summary.insert("mode".to_string(), json!("metadata_only"));
        }

        summary.insert("followup".to_string(), Value::Object(followup_summary));
    }

    Ok(Value::Object(summary))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_postflight_observation_summary() {
        let summary =
            build_servertool_postflight_observation_summary(ServertoolPostflightObservationInput {
                engine_result: json!({
                    "mode": "tool_flow",
                    "finalChatResponse": {
                        "tool_outputs": [{
                            "tool_name": "reasoningStop",
                            "tool_call_id": "call_1",
                            "content": "ok"
                        }]
                    },
                    "execution": {
                        "flowId": "flow_1",
                        "followup": {
                            "requestIdSuffix": "next",
                            "entryEndpoint": "/v1/responses",
                            "payload": {
                                "messages": [{ "role": "user" }],
                                "input": [{ "type": "message" }]
                            }
                        }
                    },
                    "pendingInjection": { "sessionId": "s1" }
                }),
            })
            .expect("summary");

        assert_eq!(summary["mode"], "tool_flow");
        assert_eq!(summary["flowId"], "flow_1");
        assert_eq!(summary["hasFollowup"], true);
        assert_eq!(summary["pendingInjection"], true);
        assert_eq!(summary["toolOutputCount"], 1);
        assert_eq!(summary["toolName"], "reasoningStop");
        assert_eq!(summary["toolCallId"], "call_1");
        assert_eq!(summary["toolOutputContent"], "ok");
        assert_eq!(summary["followup"]["mode"], "payload");
        assert_eq!(summary["followup"]["messageCount"], 1);
        assert_eq!(summary["followup"]["inputCount"], 1);
    }

    #[test]
    fn builds_injection_followup_observation_summary() {
        let summary =
            build_servertool_postflight_observation_summary(ServertoolPostflightObservationInput {
                engine_result: json!({
                    "mode": "tool_flow",
                    "finalChatResponse": {},
                    "execution": {
                        "flowId": "flow_2",
                        "followup": {
                            "injection": {
                                "ops": [{ "op": "append" }, { "op": 1 }]
                            }
                        }
                    }
                }),
            })
            .expect("summary");

        assert_eq!(summary["hasFollowup"], true);
        assert_eq!(summary["toolOutputCount"], 0);
        assert_eq!(summary["followup"]["mode"], "injection");
        assert_eq!(summary["followup"]["injectionOps"], json!(["append"]));
    }
}
