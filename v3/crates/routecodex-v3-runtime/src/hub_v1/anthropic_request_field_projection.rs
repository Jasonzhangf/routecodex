use serde_json::{json, Map, Value};

use super::anthropic_codec::V3AnthropicCodecError;
use crate::projection_drop_log::V3ProjectionDropRecord;

pub(super) fn project_chat_store_to_anthropic_wire(
    projected: &mut Value,
    drops: &mut Vec<V3ProjectionDropRecord>,
) -> Result<(), String> {
    let Some(store) = projected.get("store") else {
        return Ok(());
    };
    match store {
        Value::Bool(enabled) => {
            anthropic_store_value(
                projected.as_object().unwrap(),
                projected
                    .pointer("/routecodex_chat_extension/responses_request")
                    .and_then(Value::as_object),
            )
            .map_err(|error| error.to_string())?;
            if *enabled {
                drops.push(V3ProjectionDropRecord::new(
                    "anthropic",
                    "$.store",
                    "unmapped_target_protocol_field_unrepresentable",
                    store.clone(),
                    "project_chat_store_to_anthropic_wire",
                ));
            }
            projected.as_object_mut().unwrap().remove("store");
            if let Some(extension) = projected
                .pointer_mut("/routecodex_chat_extension/responses_request")
                .and_then(Value::as_object_mut)
            {
                extension.remove("store");
            }
            Ok(())
        }
        _ => {
            Err("MalformedOutboundField target_protocol=anthropic path=$.request.store".to_string())
        }
    }
}

pub(super) fn anthropic_store_value<'a>(
    object: &'a Map<String, Value>,
    responses_request_extension: Option<&'a Map<String, Value>>,
) -> Result<Option<&'a Value>, V3AnthropicCodecError> {
    let root_store = object.get("store");
    let extension_store = responses_request_extension.and_then(|extension| extension.get("store"));
    match (root_store, extension_store) {
        (Some(root), Some(extension)) if root != extension => {
            Err(V3AnthropicCodecError::MalformedField { field: "store" })
        }
        (Some(root), _) => {
            if root.is_boolean() {
                Ok(Some(root))
            } else {
                Err(V3AnthropicCodecError::MalformedField { field: "store" })
            }
        }
        (None, Some(extension)) => {
            if extension.is_boolean() {
                Ok(Some(extension))
            } else {
                Err(V3AnthropicCodecError::MalformedField {
                    field: "routecodex_chat_extension.responses_request.store",
                })
            }
        }
        (None, None) => Ok(None),
    }
}

pub(super) fn responses_metadata_as_anthropic_metadata(
    responses_request_extension: Option<&Map<String, Value>>,
) -> Result<Option<Value>, V3AnthropicCodecError> {
    let public_user_id = responses_public_metadata_user_id(responses_request_extension)?;
    let client_user_id = responses_client_user_id(responses_request_extension)?;
    let user_id = match (public_user_id, client_user_id) {
        (Some(public), Some(client)) if public != client => {
            return Err(V3AnthropicCodecError::MalformedField {
                field:
                    "routecodex_chat_extension.responses_request.metadata/client_metadata.user_id",
            });
        }
        (Some(public), _) => Some(public),
        (_, Some(client)) => Some(client),
        (None, None) => None,
    };
    Ok(user_id.map(|user_id| json!({"user_id": user_id})))
}

pub(super) fn validate_responses_cache_and_store_for_anthropic(
    extension: Option<&Map<String, Value>>,
    drops: &mut Vec<V3ProjectionDropRecord>,
) -> Result<(), V3AnthropicCodecError> {
    let Some(extension) = extension else {
        return Ok(());
    };
    if let Some(prompt_cache_key) = extension.get("prompt_cache_key") {
        let valid_prompt_cache_key = prompt_cache_key
            .as_str()
            .is_some_and(|value| !value.trim().is_empty());
        if !valid_prompt_cache_key {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "routecodex_chat_extension.responses_request.prompt_cache_key",
            });
        }
        drops.push(V3ProjectionDropRecord::new(
            "anthropic",
            "$.prompt_cache_key",
            "unmapped_target_protocol_field_unrepresentable",
            prompt_cache_key.clone(),
            "validate_responses_cache_and_store_for_anthropic",
        ));
    }
    if let Some(store) = extension.get("store") {
        let Some(enabled) = store.as_bool() else {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "routecodex_chat_extension.responses_request.store",
            });
        };
        if enabled {
            drops.push(V3ProjectionDropRecord::new(
                "anthropic",
                "$.store",
                "unmapped_target_protocol_field_unrepresentable",
                store.clone(),
                "validate_responses_cache_and_store_for_anthropic",
            ));
        }
    }
    Ok(())
}

pub(super) fn project_responses_text_as_anthropic_output_config(
    output: &mut Map<String, Value>,
    extension: Option<&Map<String, Value>>,
    drops: &mut Vec<V3ProjectionDropRecord>,
) -> Result<(), V3AnthropicCodecError> {
    let Some(text) = extension.and_then(|row| row.get("text")) else {
        return Ok(());
    };
    let text = text
        .as_object()
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "routecodex_chat_extension.responses_request.text",
        })?;
    let mut output_config = output
        .remove("output_config")
        .map(into_object)
        .transpose()?
        .unwrap_or_default();
    if let Some(format) = text.get("format") {
        let format = format
            .as_object()
            .ok_or(V3AnthropicCodecError::MalformedField {
                field: "routecodex_chat_extension.responses_request.text.format",
            })?;
        match format.get("type").and_then(Value::as_str) {
            Some("text") => record_unmapped_anthropic_text_format_fields(format, &["type"], drops),
            Some("json_schema") => {
                record_unmapped_anthropic_text_format_fields(
                    format,
                    // Responses uses `name` to identify the source schema and `strict`
                    // to select a validation mode. Anthropic's output_config.format has
                    // no equivalent wire fields; consume both source-only values while
                    // projecting the exact target shape below.
                    &["type", "name", "schema", "strict"],
                    drops,
                );
                if format
                    .get("strict")
                    .is_some_and(|strict| !strict.is_boolean())
                {
                    return Err(V3AnthropicCodecError::MalformedField {
                        field: "routecodex_chat_extension.responses_request.text.format.strict",
                    });
                }
                let schema =
                    format
                        .get("schema")
                        .cloned()
                        .ok_or(V3AnthropicCodecError::MalformedField {
                            field: "routecodex_chat_extension.responses_request.text.format.schema",
                        })?;
                insert_matching_anthropic_output_config_field(
                    &mut output_config,
                    "format",
                    json!({"type":"json_schema","schema":schema}),
                )?;
            }
            Some(_) => {
                drops.push(V3ProjectionDropRecord::new(
                    "anthropic",
                    "$.text.format",
                    "unmapped_target_protocol_field_unrepresentable",
                    Value::Object(format.clone()),
                    "project_responses_text_as_anthropic_output_config",
                ));
            }
            None => {
                return Err(V3AnthropicCodecError::MalformedField {
                    field: "routecodex_chat_extension.responses_request.text.format.type",
                });
            }
        }
    }
    if let Some(verbosity) = text.get("verbosity") {
        if !verbosity
            .as_str()
            .is_some_and(|value| matches!(value, "low" | "medium" | "high"))
        {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "routecodex_chat_extension.responses_request.text.verbosity",
            });
        }
        drops.push(V3ProjectionDropRecord::new(
            "anthropic",
            "$.text.verbosity",
            "unmapped_target_protocol_field_unrepresentable",
            verbosity.clone(),
            "project_responses_text_as_anthropic_output_config",
        ));
    }
    if !output_config.is_empty() {
        output.insert("output_config".to_string(), Value::Object(output_config));
    }
    Ok(())
}

pub(super) fn insert_matching_anthropic_output_config_field(
    output_config: &mut Map<String, Value>,
    field: &'static str,
    value: Value,
) -> Result<(), V3AnthropicCodecError> {
    if output_config
        .get(field)
        .is_some_and(|existing| existing != &value)
    {
        return Err(V3AnthropicCodecError::MalformedField { field });
    }
    output_config.insert(field.to_string(), value);
    Ok(())
}

pub(super) fn reject_responses_reasoning_summary_for_anthropic(
    request: &Map<String, Value>,
) -> Result<(), V3AnthropicCodecError> {
    let Some(summary) = request.get("reasoning_summary_policy") else {
        return Ok(());
    };
    if !summary
        .as_str()
        .is_some_and(|value| matches!(value, "auto" | "concise" | "detailed"))
    {
        return Err(V3AnthropicCodecError::MalformedField {
            field: "reasoning_summary_policy",
        });
    }
    Ok(())
}

fn into_object(value: Value) -> Result<Map<String, Value>, V3AnthropicCodecError> {
    value
        .as_object()
        .cloned()
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "output_config",
        })
}

fn record_unmapped_anthropic_text_format_fields(
    format: &Map<String, Value>,
    allowed: &[&str],
    drops: &mut Vec<V3ProjectionDropRecord>,
) {
    for (key, value) in format {
        if allowed.contains(&key.as_str()) {
            continue;
        }
        drops.push(V3ProjectionDropRecord::new(
            "anthropic",
            format!("$.text.format.{key}"),
            "unmapped_target_protocol_field_unrepresentable",
            value.clone(),
            "record_unmapped_anthropic_text_format_fields",
        ));
    }
}

fn responses_public_metadata_user_id(
    extension: Option<&Map<String, Value>>,
) -> Result<Option<&str>, V3AnthropicCodecError> {
    let Some(metadata) = extension.and_then(|row| row.get("metadata")) else {
        return Ok(None);
    };
    let metadata = metadata
        .as_object()
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "routecodex_chat_extension.responses_request.metadata",
        })?;
    // Arbitrary public Responses metadata is not provider-wire metadata for Anthropic.
    // V3AnthropicResponsesProjectionContext carries it on the adjacent response projection;
    // this helper extracts only the exact Anthropic metadata.user_id intersection.
    let Some(user_id) = metadata.get("user_id") else {
        return Ok(None);
    };
    if user_id.is_null() {
        return Ok(None);
    }
    let user_id = user_id
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "routecodex_chat_extension.responses_request.metadata.user_id",
        })?;
    Ok(Some(user_id))
}

fn responses_client_user_id(
    extension: Option<&Map<String, Value>>,
) -> Result<Option<&str>, V3AnthropicCodecError> {
    let Some(client_metadata) = extension.and_then(|row| row.get("client_metadata")) else {
        return Ok(None);
    };
    let client_metadata =
        client_metadata
            .as_object()
            .ok_or(V3AnthropicCodecError::MalformedField {
                field: "routecodex_chat_extension.responses_request.client_metadata",
            })?;
    let Some(user_id) = client_metadata.get("user_id") else {
        return Ok(None);
    };
    user_id
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(Some)
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "routecodex_chat_extension.responses_request.client_metadata.user_id",
        })
}
