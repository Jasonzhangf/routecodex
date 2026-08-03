use serde_json::{json, Map, Value};

use super::anthropic_codec::V3AnthropicCodecError;
use super::client_metadata_projection::unsupported_client_metadata_paths;
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
    }
    if let Some(store) = extension.get("store") {
        match store.as_bool() {
            Some(false) => {}
            Some(true) => {
                return Err(V3AnthropicCodecError::UnmappedOutboundFields {
                    paths: "$.request.store".to_string(),
                });
            }
            None => {
                return Err(V3AnthropicCodecError::MalformedField {
                    field: "routecodex_chat_extension.responses_request.store",
                });
            }
        }
    }
    Ok(())
}

pub(super) fn project_responses_text_as_anthropic_output_config(
    output: &mut Map<String, Value>,
    extension: Option<&Map<String, Value>>,
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
            Some("text") => reject_unmapped_anthropic_text_format_fields(format, &["type"])?,
            Some("json_schema") => {
                reject_unmapped_anthropic_text_format_fields(
                    format,
                    &["type", "schema", "strict"],
                )?;
                if format.get("strict").and_then(Value::as_bool) == Some(false) {
                    return Err(V3AnthropicCodecError::UnmappedOutboundFields {
                        paths: "$.request.text.output_config.format.strict".to_string(),
                    });
                }
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
            _ => {
                return Err(V3AnthropicCodecError::UnmappedOutboundFields {
                    paths: "$.request.text.output_config.format.type".to_string(),
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

fn reject_unmapped_anthropic_text_format_fields(
    format: &Map<String, Value>,
    allowed: &[&str],
) -> Result<(), V3AnthropicCodecError> {
    let paths = format
        .keys()
        .filter(|key| !allowed.contains(&key.as_str()))
        .map(|key| format!("$.request.text.output_config.format.{key}"))
        .collect::<Vec<_>>();
    if paths.is_empty() {
        Ok(())
    } else {
        Err(V3AnthropicCodecError::UnmappedOutboundFields {
            paths: paths.join(","),
        })
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
    // V3AnthropicResponsesProjectionContext carries it on the adjacent response projection
    // and restores it before Resp03/continuation save; this helper extracts only the
    // exact Anthropic metadata.user_id intersection.
    let Some(user_id) = metadata.get("user_id") else {
        return Ok(None);
    };
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
    let unsupported = unsupported_client_metadata_paths(client_metadata);
    if !unsupported.is_empty() {
        return Err(V3AnthropicCodecError::UnmappedOutboundFields {
            paths: unsupported.join(","),
        });
    }
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
