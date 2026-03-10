use napi::bindgen_prelude::Result as NapiResult;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::hub_reasoning_tool_normalizer::sanitize_reasoning_tagged_text;

const DEFAULT_MIN_LENGTH: usize = 50;
const DEFAULT_ALLOW_EMPTY_WITH_SIGNATURE: bool = true;
const DEFAULT_CONVERT_TO_TEXT_ON_FAILURE: bool = true;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThoughtSignatureValidationOptionsInput {
    min_length: Option<usize>,
    allow_empty_thinking_with_signature: Option<bool>,
    convert_to_text_on_failure: Option<bool>,
}

#[derive(Debug, Clone)]
struct ThoughtSignatureValidationOptions {
    min_length: usize,
    allow_empty_thinking_with_signature: bool,
    convert_to_text_on_failure: bool,
}

fn resolve_options(value: Option<&Value>) -> ThoughtSignatureValidationOptions {
    let mut resolved = ThoughtSignatureValidationOptions {
        min_length: DEFAULT_MIN_LENGTH,
        allow_empty_thinking_with_signature: DEFAULT_ALLOW_EMPTY_WITH_SIGNATURE,
        convert_to_text_on_failure: DEFAULT_CONVERT_TO_TEXT_ON_FAILURE,
    };
    let Some(Value::Object(obj)) = value else {
        return resolved;
    };
    let raw: ThoughtSignatureValidationOptionsInput = serde_json::from_value(Value::Object(
        obj.clone(),
    ))
    .unwrap_or(ThoughtSignatureValidationOptionsInput {
        min_length: None,
        allow_empty_thinking_with_signature: None,
        convert_to_text_on_failure: None,
    });
    if let Some(min_length) = raw.min_length {
        resolved.min_length = min_length;
    }
    if let Some(allow_empty) = raw.allow_empty_thinking_with_signature {
        resolved.allow_empty_thinking_with_signature = allow_empty;
    }
    if let Some(convert_to_text) = raw.convert_to_text_on_failure {
        resolved.convert_to_text_on_failure = convert_to_text;
    }
    resolved
}

fn coerce_thought_signature(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(raw)) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        _ => None,
    }
}

fn is_thinking_block_type(block_type: &str) -> bool {
    matches!(block_type, "thinking" | "reasoning" | "redacted_thinking")
}

fn read_block_type(obj: &Map<String, Value>) -> Option<String> {
    obj.get("type")
        .and_then(Value::as_str)
        .map(|value| value.to_string())
}

fn read_thinking_text(obj: &Map<String, Value>) -> String {
    obj.get("thinking")
        .or_else(|| obj.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn read_thought_signature(obj: &Map<String, Value>) -> Option<String> {
    coerce_thought_signature(obj.get("thoughtSignature").or_else(|| obj.get("signature")))
}

fn has_valid_thought_signature_block(
    block: &Value,
    options: &ThoughtSignatureValidationOptions,
) -> bool {
    let Some(obj) = block.as_object() else {
        return true;
    };
    let Some(block_type) = read_block_type(obj) else {
        return true;
    };
    if !is_thinking_block_type(block_type.as_str()) {
        return true;
    }

    let thinking = sanitize_reasoning_tagged_text(read_thinking_text(obj).as_str());
    let signature = read_thought_signature(obj);

    if thinking.trim().is_empty()
        && signature.is_some()
        && options.allow_empty_thinking_with_signature
    {
        return true;
    }

    signature
        .as_ref()
        .map(|sig| sig.len() >= options.min_length)
        .unwrap_or(false)
}

fn sanitize_thinking_block_value(block: &Value) -> Value {
    let Some(obj) = block.as_object() else {
        return block.clone();
    };
    let Some(block_type) = read_block_type(obj) else {
        return block.clone();
    };
    if !is_thinking_block_type(block_type.as_str()) {
        return block.clone();
    }

    let thinking = sanitize_reasoning_tagged_text(read_thinking_text(obj).as_str());
    let signature = read_thought_signature(obj);

    let mut out = Map::new();
    out.insert("type".to_string(), Value::String(block_type));
    out.insert("thinking".to_string(), Value::String(thinking));
    if let Some(sig) = signature {
        out.insert("thoughtSignature".to_string(), Value::String(sig));
    }
    Value::Object(out)
}

fn filter_invalid_thinking_blocks(
    messages: &mut Vec<Value>,
    options: &ThoughtSignatureValidationOptions,
) {
    for msg in messages.iter_mut() {
        let Some(msg_obj) = msg.as_object_mut() else {
            continue;
        };
        let role = msg_obj
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        if role != "assistant" && role != "model" {
            continue;
        }
        let Some(content) = msg_obj.get_mut("content") else {
            continue;
        };
        let Value::Array(entries) = content else {
            continue;
        };

        let mut next_blocks: Vec<Value> = Vec::new();
        for block in entries.iter() {
            let Some(block_obj) = block.as_object() else {
                next_blocks.push(block.clone());
                continue;
            };
            let Some(block_type) = read_block_type(block_obj) else {
                next_blocks.push(block.clone());
                continue;
            };
            if !is_thinking_block_type(block_type.as_str()) {
                next_blocks.push(block.clone());
                continue;
            }

            if has_valid_thought_signature_block(block, options) {
                next_blocks.push(sanitize_thinking_block_value(block));
                continue;
            }

            let thinking_text = read_thinking_text(block_obj);
            if thinking_text.trim().is_empty() || !options.convert_to_text_on_failure {
                continue;
            }
            let mut text_block = Map::new();
            text_block.insert("type".to_string(), Value::String("text".to_string()));
            text_block.insert("text".to_string(), Value::String(thinking_text));
            next_blocks.push(Value::Object(text_block));
        }

        if next_blocks.is_empty() {
            let mut empty_block = Map::new();
            empty_block.insert("type".to_string(), Value::String("text".to_string()));
            empty_block.insert("text".to_string(), Value::String("".to_string()));
            next_blocks.push(Value::Object(empty_block));
        }

        *entries = next_blocks;
    }
}

fn remove_trailing_unsigned_thinking_blocks(
    blocks: &mut Vec<Value>,
    options: &ThoughtSignatureValidationOptions,
) {
    if blocks.is_empty() {
        return;
    }
    let mut end_index = blocks.len();
    for idx in (0..blocks.len()).rev() {
        let Some(block_obj) = blocks[idx].as_object() else {
            continue;
        };
        let Some(block_type) = read_block_type(block_obj) else {
            continue;
        };
        if is_thinking_block_type(block_type.as_str()) {
            if !has_valid_thought_signature_block(&blocks[idx], options) {
                end_index = idx;
            } else {
                break;
            }
        } else {
            break;
        }
    }
    if end_index < blocks.len() {
        blocks.truncate(end_index);
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HasValidThoughtSignatureInput {
    block: Option<Value>,
    options: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SanitizeThinkingBlockInput {
    block: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilterInvalidThinkingBlocksInput {
    messages: Option<Vec<Value>>,
    options: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveTrailingUnsignedThinkingBlocksInput {
    blocks: Option<Vec<Value>>,
    options: Option<Value>,
}

pub fn has_valid_thought_signature_json(input_json: String) -> NapiResult<String> {
    let input: HasValidThoughtSignatureInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let options = resolve_options(input.options.as_ref());
    let block = input.block.unwrap_or(Value::Null);
    let valid = has_valid_thought_signature_block(&block, &options);
    serde_json::to_string(&Value::Bool(valid)).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn sanitize_thinking_block_json(input_json: String) -> NapiResult<String> {
    let input: SanitizeThinkingBlockInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let block = input.block.unwrap_or(Value::Null);
    let sanitized = sanitize_thinking_block_value(&block);
    serde_json::to_string(&sanitized).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn filter_invalid_thinking_blocks_json(input_json: String) -> NapiResult<String> {
    let input: FilterInvalidThinkingBlocksInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let options = resolve_options(input.options.as_ref());
    let mut messages = input.messages.unwrap_or_default();
    filter_invalid_thinking_blocks(&mut messages, &options);
    serde_json::to_string(&messages).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn remove_trailing_unsigned_thinking_blocks_json(input_json: String) -> NapiResult<String> {
    let input: RemoveTrailingUnsignedThinkingBlocksInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let options = resolve_options(input.options.as_ref());
    let mut blocks = input.blocks.unwrap_or_default();
    remove_trailing_unsigned_thinking_blocks(&mut blocks, &options);
    serde_json::to_string(&blocks).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests;
