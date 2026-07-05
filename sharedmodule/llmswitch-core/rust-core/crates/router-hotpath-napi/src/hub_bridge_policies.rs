use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::Deserialize;
use serde_json::{json, Value};

const RESPONSES_INSTRUCTIONS_REASONING_FIELD: &str = "__rcc_reasoning_instructions";

const OPENAI_CHAT_ALLOWED_FIELDS: &[&str] = &[
    "messages",
    "tools",
    "tool_outputs",
    "model",
    "temperature",
    "top_p",
    "top_k",
    "max_tokens",
    "frequency_penalty",
    "presence_penalty",
    "logit_bias",
    "response_format",
    "parallel_tool_calls",
    "tool_choice",
    "seed",
    "user",
    "metadata",
    "stop",
    "stop_sequences",
    "stream",
];

const ANTHROPIC_ALLOWED_FIELDS: &[&str] = &[
    "model",
    "messages",
    "tools",
    "system",
    "stop_sequences",
    "temperature",
    "top_p",
    "top_k",
    "max_tokens",
    "max_output_tokens",
    "metadata",
    "stream",
    "tool_choice",
];

const OPENAI_RESPONSES_ALLOWED_FIELDS: &[&str] = &[
    "id",
    "object",
    "created_at",
    "model",
    "status",
    "input",
    "instructions",
    "output",
    "output_text",
    "required_action",
    "response_id",
    "previous_response_id",
    "tool_outputs",
    "tools",
    "metadata",
    "include",
    "store",
    "user",
    "response_format",
    "temperature",
    "top_p",
    "top_k",
    "max_tokens",
    "max_output_tokens",
    "logit_bias",
    "seed",
    "parallel_tool_calls",
    "tool_choice",
    "prompt_cache_key",
    "reasoning",
    "stream",
    "instructions_is_raw",
];

const GEMINI_ALLOWED_FIELDS: &[&str] = &[
    "model",
    "contents",
    "systemInstruction",
    "system_instruction",
    "generationConfig",
    "generation_config",
    "safetySettings",
    "safety_settings",
    "metadata",
    "toolConfig",
    "tool_config",
    "tools",
    "tool_choice",
    "parallelToolCalls",
    "parallel_tool_calls",
    "responseMimeType",
    "response_mime_type",
    "stopSequences",
    "stop_sequences",
    "cachedContent",
    "prompt",
    "response",
    "candidates",
    "usageMetadata",
    "responseMetadata",
    "promptFeedback",
    "modelVersion",
    "client",
    "user",
    "stream",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveBridgePolicyInput {
    #[serde(default)]
    protocol: Option<String>,
    #[serde(default)]
    module_type: Option<String>,
}

fn normalize_token(value: Option<&String>) -> Option<String> {
    let raw = value?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_ascii_lowercase())
}

fn string_array(values: &[&str]) -> Value {
    Value::Array(
        values
            .iter()
            .map(|entry| Value::String((*entry).to_string()))
            .collect(),
    )
}

fn action(name: &str) -> Value {
    json!({ "name": name })
}

fn action_with_options(name: &str, options: Value) -> Value {
    json!({
      "name": name,
      "options": options
    })
}

fn reasoning_action(id_prefix: &str) -> Value {
    action_with_options(
        "reasoning.extract",
        json!({
          "dropFromContent": true,
          "idPrefix": id_prefix
        }),
    )
}

fn normalize_tool_call_action(id_prefix: &str) -> Value {
    action_with_options(
        "tools.normalize-call-ids",
        json!({
          "idPrefix": id_prefix
        }),
    )
}

fn responses_policy() -> Value {
    json!({
      "id": "openai-responses-default",
      "protocol": "openai-responses",
      "request": {
        "inbound": [
          action_with_options("messages.inject-system-instruction", json!({
            "field": "instructions",
            "reasoningField": RESPONSES_INSTRUCTIONS_REASONING_FIELD
          })),
          action("messages.ensure-system-instruction"),
          reasoning_action("responses_reasoning"),
          normalize_tool_call_action("responses_tool_call"),
          action("compat.fix-apply-patch"),
          action("tools.ensure-placeholders"),
          action_with_options("metadata.extra-fields", json!({
            "allowedKeys": string_array(OPENAI_RESPONSES_ALLOWED_FIELDS)
          })),
          action_with_options("metadata.provider-field", json!({
            "field": "metadata",
            "target": "providerMetadata"
          })),
          action_with_options("metadata.provider-sentinel", json!({
            "sentinel": "__rcc_provider_metadata",
            "target": "providerMetadata"
          }))
        ],
        "outbound": [
          action("tools.capture-results"),
          normalize_tool_call_action("responses_tool_call"),
          action("compat.fix-apply-patch"),
          action("tools.ensure-placeholders"),
          action("messages.normalize-history"),
          action("messages.ensure-output-fields"),
          action("messages.ensure-system-instruction"),
          reasoning_action("responses_reasoning"),
          action_with_options("metadata.extra-fields", json!({
            "allowedKeys": string_array(OPENAI_RESPONSES_ALLOWED_FIELDS)
          })),
          action_with_options("metadata.provider-field", json!({
            "field": "metadata",
            "target": "providerMetadata"
          })),
          action_with_options("metadata.provider-sentinel", json!({
            "sentinel": "__rcc_provider_metadata",
            "target": "providerMetadata"
          }))
        ]
      },
      "response": {
        "inbound": [
          action("reasoning.attach-output"),
          reasoning_action("responses_reasoning"),
          normalize_tool_call_action("responses_tool_call"),
          action("compat.fix-apply-patch"),
          action_with_options("metadata.extra-fields", json!({
            "allowedKeys": string_array(OPENAI_RESPONSES_ALLOWED_FIELDS)
          }))
        ],
        "outbound": [
          reasoning_action("responses_reasoning"),
          normalize_tool_call_action("responses_tool_call"),
          action("compat.fix-apply-patch"),
          action_with_options("metadata.extra-fields", json!({
            "allowedKeys": string_array(OPENAI_RESPONSES_ALLOWED_FIELDS)
          }))
        ]
      }
    })
}

fn openai_chat_policy() -> Value {
    json!({
      "id": "openai-chat-default",
      "protocol": "openai-chat",
      "request": {
        "inbound": [
          reasoning_action("openai_chat_reasoning"),
          normalize_tool_call_action("openai_chat_tool_call"),
          action("compat.fix-apply-patch"),
          action("messages.ensure-system-instruction"),
          action_with_options("metadata.extra-fields", json!({
            "allowedKeys": string_array(OPENAI_CHAT_ALLOWED_FIELDS)
          })),
          action_with_options("metadata.provider-field", json!({
            "field": "metadata",
            "target": "providerMetadata"
          })),
          action_with_options("metadata.provider-sentinel", json!({
            "sentinel": "__rcc_provider_metadata",
            "target": "providerMetadata"
          }))
        ],
        "outbound": [
          action("messages.normalize-history"),
          action("tools.capture-results"),
          normalize_tool_call_action("openai_chat_tool_call"),
          action("compat.fix-apply-patch"),
          action("tools.ensure-placeholders"),
          action("messages.ensure-output-fields"),
          action("messages.ensure-system-instruction"),
          reasoning_action("openai_chat_reasoning"),
          action_with_options("metadata.extra-fields", json!({
            "allowedKeys": string_array(OPENAI_CHAT_ALLOWED_FIELDS)
          })),
          action_with_options("metadata.provider-field", json!({
            "field": "metadata",
            "target": "providerMetadata"
          })),
          action_with_options("metadata.provider-sentinel", json!({
            "sentinel": "__rcc_provider_metadata",
            "target": "providerMetadata"
          }))
        ]
      },
      "response": {
        "inbound": [
          reasoning_action("openai_chat_reasoning"),
          normalize_tool_call_action("openai_chat_tool_call"),
          action("compat.fix-apply-patch"),
          action_with_options("metadata.extra-fields", json!({
            "allowedKeys": string_array(OPENAI_CHAT_ALLOWED_FIELDS)
          }))
        ],
        "outbound": [
          reasoning_action("openai_chat_reasoning"),
          normalize_tool_call_action("openai_chat_tool_call"),
          action("compat.fix-apply-patch"),
          action_with_options("metadata.extra-fields", json!({
            "allowedKeys": string_array(OPENAI_CHAT_ALLOWED_FIELDS)
          }))
        ]
      }
    })
}

fn anthropic_policy() -> Value {
    json!({
      "id": "anthropic-messages-default",
      "protocol": "anthropic-messages",
      "request": {
        "inbound": [
          reasoning_action("anthropic_reasoning"),
          normalize_tool_call_action("anthropic_tool_call"),
          action("messages.ensure-system-instruction"),
          action_with_options("metadata.extra-fields", json!({
            "allowedKeys": string_array(ANTHROPIC_ALLOWED_FIELDS)
          }))
        ],
        "outbound": [
          action("messages.normalize-history"),
          action("tools.capture-results"),
          normalize_tool_call_action("anthropic_tool_call"),
          action("tools.ensure-placeholders"),
          action("messages.ensure-output-fields"),
          action("messages.ensure-system-instruction"),
          reasoning_action("anthropic_reasoning"),
          action_with_options("metadata.extra-fields", json!({
            "allowedKeys": string_array(ANTHROPIC_ALLOWED_FIELDS)
          }))
        ]
      },
      "response": {
        "inbound": [
          reasoning_action("anthropic_reasoning"),
          normalize_tool_call_action("anthropic_tool_call"),
          action_with_options("metadata.extra-fields", json!({
            "allowedKeys": string_array(ANTHROPIC_ALLOWED_FIELDS)
          }))
        ],
        "outbound": [
          reasoning_action("anthropic_reasoning"),
          normalize_tool_call_action("anthropic_tool_call"),
          action_with_options("metadata.extra-fields", json!({
            "allowedKeys": string_array(ANTHROPIC_ALLOWED_FIELDS)
          }))
        ]
      }
    })
}

fn gemini_policy() -> Value {
    json!({
      "id": "gemini-chat-default",
      "protocol": "gemini-chat",
      "request": {
        "inbound": [
          reasoning_action("gemini_reasoning"),
          action("compat.fix-apply-patch"),
          action("messages.ensure-system-instruction"),
          action_with_options("metadata.extra-fields", json!({
            "allowedKeys": string_array(GEMINI_ALLOWED_FIELDS)
          }))
        ],
        "outbound": [
          action("messages.normalize-history"),
          action("tools.capture-results"),
          action("tools.ensure-placeholders"),
          action("messages.ensure-output-fields"),
          action("messages.ensure-system-instruction"),
          reasoning_action("gemini_reasoning"),
          action("compat.fix-apply-patch"),
          action_with_options("metadata.extra-fields", json!({
            "allowedKeys": string_array(GEMINI_ALLOWED_FIELDS)
          }))
        ]
      },
      "response": {
        "inbound": [
          reasoning_action("gemini_reasoning"),
          action("compat.fix-apply-patch"),
          action_with_options("metadata.extra-fields", json!({
            "allowedKeys": string_array(GEMINI_ALLOWED_FIELDS)
          }))
        ],
        "outbound": [
          reasoning_action("gemini_reasoning"),
          action("compat.fix-apply-patch"),
          action_with_options("metadata.extra-fields", json!({
            "allowedKeys": string_array(GEMINI_ALLOWED_FIELDS)
          }))
        ]
      }
    })
}

pub(crate) fn resolve_bridge_policy(input: &ResolveBridgePolicyInput) -> Option<Value> {
    match normalize_token(input.protocol.as_ref()).as_deref() {
        Some("openai-responses") => return Some(responses_policy()),
        Some("openai-chat") => return Some(openai_chat_policy()),
        Some("anthropic-messages") => return Some(anthropic_policy()),
        Some("gemini-chat") => return Some(gemini_policy()),
        _ => {}
    }
    match normalize_token(input.module_type.as_ref()).as_deref() {
        Some("openai-responses") => Some(responses_policy()),
        Some("openai-chat") => Some(openai_chat_policy()),
        Some("anthropic-messages") => Some(anthropic_policy()),
        Some("gemini-chat") => Some(gemini_policy()),
        _ => None,
    }
}

fn resolve_stage_keys(stage: &str) -> Option<(&'static str, &'static str)> {
    let normalized = stage.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "request_inbound" => Some(("request", "inbound")),
        "request_outbound" => Some(("request", "outbound")),
        "response_inbound" => Some(("response", "inbound")),
        "response_outbound" => Some(("response", "outbound")),
        _ => None,
    }
}

pub(crate) fn resolve_bridge_policy_actions(policy: Option<&Value>, stage: &str) -> Option<Value> {
    let (phase_key, direction_key) = resolve_stage_keys(stage)?;
    let policy_obj = policy?.as_object()?;
    let phase = policy_obj.get(phase_key)?.as_object()?;
    let actions = phase.get(direction_key)?.as_array()?;
    Some(Value::Array(actions.clone()))
}

pub(crate) fn resolve_bridge_policy_actions_for_tokens(
    protocol: Option<&str>,
    module_type: Option<&str>,
    stage: &str,
) -> Option<Value> {
    let input = ResolveBridgePolicyInput {
        protocol: protocol.map(|value| value.to_string()),
        module_type: module_type.map(|value| value.to_string()),
    };
    let policy = resolve_bridge_policy(&input)?;
    resolve_bridge_policy_actions(Some(&policy), stage)
}

fn read_action_name(action: &Value) -> String {
    action
        .as_object()
        .and_then(|row| row.get("name"))
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default()
}

fn message_has_tool_signal(message: &Value) -> bool {
    let Some(row) = message.as_object() else {
        return false;
    };
    if row
        .get("role")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().eq_ignore_ascii_case("tool"))
        .unwrap_or(false)
    {
        return true;
    }
    if row
        .get("tool_call_id")
        .and_then(|value| value.as_str())
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    row.get("tool_calls")
        .and_then(|value| value.as_array())
        .map(|items| !items.is_empty())
        .unwrap_or(false)
}

fn messages_have_tool_signal(messages: Option<&Vec<Value>>) -> bool {
    messages
        .map(|items| items.iter().any(message_has_tool_signal))
        .unwrap_or(false)
}

pub(crate) fn plan_responses_bridge_policy_actions(input: &Value) -> Value {
    let actions = match input.get("actions").and_then(|value| value.as_array()) {
        Some(items) => items,
        None => return Value::Null,
    };
    let stage = input
        .get("stage")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let has_tool_signals =
        messages_have_tool_signal(input.get("messages").and_then(|value| value.as_array()));
    let mut filtered: Vec<Value> = Vec::new();
    for action in actions {
        let name = read_action_name(action);
        if matches!(stage.as_str(), "request_inbound" | "request_outbound")
            && name == "reasoning.extract"
        {
            continue;
        }
        if stage == "request_inbound"
            && !has_tool_signals
            && matches!(
                name.as_str(),
                "tools.normalize-call-ids" | "tools.ensure-placeholders"
            )
        {
            continue;
        }
        filtered.push(action.clone());
    }
    Value::Array(filtered)
}

#[napi]
pub fn resolve_bridge_policy_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: ResolveBridgePolicyInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = resolve_bridge_policy(&input);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi]
pub fn resolve_bridge_policy_actions_json(
    policy_json: String,
    stage: String,
) -> NapiResult<String> {
    if policy_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Policy JSON is empty"));
    }
    let policy: Value = serde_json::from_str(&policy_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse policy JSON: {}", e)))?;
    let output = resolve_bridge_policy_actions(Some(&policy), &stage);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi]
pub fn plan_responses_bridge_policy_actions_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = plan_responses_bridge_policy_actions(&input);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_openai_responses_policy() {
        let input = ResolveBridgePolicyInput {
            protocol: Some("openai-responses".to_string()),
            module_type: None,
        };
        let out = resolve_bridge_policy(&input).unwrap();
        let id = out
            .as_object()
            .and_then(|row| row.get("id"))
            .and_then(|value| value.as_str());
        assert_eq!(id, Some("openai-responses-default"));
        let inbound_len = out
            .as_object()
            .and_then(|row| row.get("request"))
            .and_then(|value| value.as_object())
            .and_then(|row| row.get("inbound"))
            .and_then(|value| value.as_array())
            .map(|arr| arr.len())
            .unwrap_or(0);
        assert!(inbound_len >= 8);
    }

    #[test]
    fn returns_none_for_unknown_protocol() {
        let input = ResolveBridgePolicyInput {
            protocol: Some("unknown".to_string()),
            module_type: None,
        };
        assert!(resolve_bridge_policy(&input).is_none());
    }

    #[test]
    fn resolves_policy_actions_for_stage() {
        let input = ResolveBridgePolicyInput {
            protocol: Some("openai-responses".to_string()),
            module_type: None,
        };
        let policy = resolve_bridge_policy(&input).unwrap();
        let actions = resolve_bridge_policy_actions(Some(&policy), "request_inbound").unwrap();
        let arr = actions.as_array().cloned().unwrap_or_default();
        assert!(arr.len() >= 8);
    }

    #[test]
    fn returns_none_for_unknown_stage() {
        let input = ResolveBridgePolicyInput {
            protocol: Some("openai-responses".to_string()),
            module_type: None,
        };
        let policy = resolve_bridge_policy(&input).unwrap();
        assert!(resolve_bridge_policy_actions(Some(&policy), "unknown_stage").is_none());
    }

    #[test]
    fn responses_bridge_policy_action_plan_filters_ts_payload_hints() {
        let input = json!({
          "stage": "request_inbound",
          "actions": [
            { "name": "reasoning.extract" },
            { "name": "tools.normalize-call-ids" },
            { "name": "tools.ensure-placeholders" },
            { "name": "metadata.extra-fields" }
          ],
          "messages": [
            { "role": "user", "content": "hello" }
          ]
        });
        let out = plan_responses_bridge_policy_actions(&input);
        let names: Vec<String> = out
            .as_array()
            .unwrap()
            .iter()
            .map(read_action_name)
            .collect();
        assert_eq!(names, vec!["metadata.extra-fields"]);
    }

    #[test]
    fn responses_bridge_policy_action_plan_keeps_tool_actions_when_tool_signal_exists() {
        let input = json!({
          "stage": "request_inbound",
          "actions": [
            { "name": "reasoning.extract" },
            { "name": "tools.normalize-call-ids" },
            { "name": "tools.ensure-placeholders" }
          ],
          "messages": [
            { "role": "assistant", "tool_calls": [{ "id": "call_1" }] }
          ]
        });
        let out = plan_responses_bridge_policy_actions(&input);
        let names: Vec<String> = out
            .as_array()
            .unwrap()
            .iter()
            .map(read_action_name)
            .collect();
        assert_eq!(
            names,
            vec!["tools.normalize-call-ids", "tools.ensure-placeholders"]
        );
    }
}
