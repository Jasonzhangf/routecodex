use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};

fn build_validation_error(
    stage: &str,
    direction: &str,
    code: &str,
    detail: &str,
    source: Option<&str>,
) -> napi::Error {
    let stage = stage.trim();
    let direction = direction.trim();
    let source_suffix = source
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| format!(" source={v}"))
        .unwrap_or_default();
    napi::Error::from_reason(format!(
        "ChatEnvelopeValidationError({stage}/{direction})[{code}] {detail}{source_suffix}"
    ))
}

fn expect_object<'a>(
    candidate: &'a Value,
    stage: &str,
    direction: &str,
    code: &str,
    detail: &str,
    source: Option<&str>,
) -> Result<&'a Map<String, Value>, napi::Error> {
    candidate
        .as_object()
        .ok_or_else(|| build_validation_error(stage, direction, code, detail, source))
}

fn assert_no_reserved_keys(
    target: &Map<String, Value>,
    path: &str,
    stage: &str,
    direction: &str,
    source: Option<&str>,
    allow_stage_keys: bool,
) -> Result<(), napi::Error> {
    for key in target.keys() {
        if !allow_stage_keys && (key == "stages" || key == "stageExpectations") {
            return Err(build_validation_error(
                stage,
                direction,
                "reserved_key",
                format!("{path} contains reserved field \"{key}\"").as_str(),
                source,
            ));
        }
        if key.starts_with("__rcc_") {
            return Err(build_validation_error(
                stage,
                direction,
                "reserved_key",
                format!("{path} contains reserved field \"{key}\"").as_str(),
                source,
            ));
        }
    }
    Ok(())
}

fn validate_tool_calls(
    message: &Map<String, Value>,
    message_index: usize,
    stage: &str,
    direction: &str,
    source: Option<&str>,
) -> Result<(), napi::Error> {
    let Some(tool_calls) = message.get("tool_calls") else {
        return Ok(());
    };
    let Some(entries) = tool_calls.as_array() else {
        return Ok(());
    };

    for (call_index, entry) in entries.iter().enumerate() {
        let row = expect_object(
            entry,
            stage,
            direction,
            "tool_call_shape",
            format!("messages[{message_index}].tool_calls[{call_index}] must be an object")
                .as_str(),
            source,
        )?;

        if row.get("type").and_then(|v| v.as_str()) != Some("function") {
            return Err(build_validation_error(
                stage,
                direction,
                "tool_call_type",
                format!(
          "messages[{message_index}].tool_calls[{call_index}].type must equal \"function\""
        )
                .as_str(),
                source,
            ));
        }

        let fn_node = row.get("function").ok_or_else(|| {
            build_validation_error(
                stage,
                direction,
                "tool_call_function",
                format!(
                    "messages[{message_index}].tool_calls[{call_index}].function must be an object"
                )
                .as_str(),
                source,
            )
        })?;
        let fn_row = fn_node.as_object().ok_or_else(|| {
            build_validation_error(
                stage,
                direction,
                "tool_call_function",
                format!(
                    "messages[{message_index}].tool_calls[{call_index}].function must be an object"
                )
                .as_str(),
                source,
            )
        })?;

        let valid_name = fn_row
            .get("name")
            .and_then(|v| v.as_str())
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false);
        if !valid_name {
            return Err(build_validation_error(
                stage,
                direction,
                "tool_call_name",
                format!(
          "messages[{message_index}].tool_calls[{call_index}].function.name must be a string"
        )
                .as_str(),
                source,
            ));
        }

        if !fn_row
            .get("arguments")
            .map(|v| v.is_string())
            .unwrap_or(false)
        {
            return Err(build_validation_error(
        stage,
        direction,
        "tool_call_arguments",
        format!(
          "messages[{message_index}].tool_calls[{call_index}].function.arguments must be a JSON string"
        )
        .as_str(),
        source,
      ));
        }
    }

    Ok(())
}

fn validate_tools(
    tools: Option<&Value>,
    stage: &str,
    direction: &str,
    source: Option<&str>,
) -> Result<(), napi::Error> {
    fn is_function_tool_type(raw: Option<&Value>) -> bool {
        raw.and_then(|v| v.as_str())
            .map(|v| v.trim().eq_ignore_ascii_case("function"))
            .unwrap_or(false)
    }

    fn has_builtin_web_search_type(raw: Option<&Value>) -> bool {
        raw.and_then(|v| v.as_str())
            .map(|v| {
                let lowered = v.trim().to_ascii_lowercase();
                lowered == "web_search" || lowered.starts_with("web_search")
            })
            .unwrap_or(false)
    }

    fn has_gemini_builtin_tool_shape(row: &Map<String, Value>) -> bool {
        row.get("googleSearch")
            .map(|value| value.is_object())
            .unwrap_or(false)
            || row
                .get("googleSearchRetrieval")
                .map(|value| value.is_object())
                .unwrap_or(false)
    }

    fn has_function_node_with_name(row: &Map<String, Value>) -> bool {
        row.get("function")
            .and_then(|v| v.as_object())
            .and_then(|fn_row| fn_row.get("name"))
            .and_then(|v| v.as_str())
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
    }

    let Some(tools) = tools else {
        return Ok(());
    };
    let Some(entries) = tools.as_array() else {
        return Err(build_validation_error(
            stage,
            direction,
            "tools_shape",
            "Chat envelope tools must be an array when provided",
            source,
        ));
    };

    for (index, tool) in entries.iter().enumerate() {
        let row = expect_object(
            tool,
            stage,
            direction,
            "tools_shape",
            format!("tools[{index}] must be an object").as_str(),
            source,
        )?;
        let raw_type = row.get("type");
        let is_function = is_function_tool_type(raw_type);
        let is_builtin_web_search = has_builtin_web_search_type(raw_type);
        let has_builtin_gemini_shape = has_gemini_builtin_tool_shape(row);
        if !is_function
            && !is_builtin_web_search
            && !has_builtin_gemini_shape
            && !has_function_node_with_name(row)
        {
            return Err(build_validation_error(
        stage,
        direction,
        "tools_type",
        format!(
          "tools[{index}].type must be \"function\" or supported builtin tool type (e.g. \"web_search\")"
        )
        .as_str(),
        source,
      ));
        }
        if !is_function {
            continue;
        }
        let fn_node = row.get("function").ok_or_else(|| {
            build_validation_error(
                stage,
                direction,
                "tools_function",
                format!("tools[{index}].function.name must be a string").as_str(),
                source,
            )
        })?;
        let fn_row = fn_node.as_object().ok_or_else(|| {
            build_validation_error(
                stage,
                direction,
                "tools_function",
                format!("tools[{index}].function.name must be a string").as_str(),
                source,
            )
        })?;
        let has_name = fn_row
            .get("name")
            .and_then(|v| v.as_str())
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false);
        if !has_name {
            return Err(build_validation_error(
                stage,
                direction,
                "tools_function",
                format!("tools[{index}].function.name must be a string").as_str(),
                source,
            ));
        }
    }

    Ok(())
}

fn validate_tool_outputs(
    outputs: Option<&Value>,
    stage: &str,
    direction: &str,
    source: Option<&str>,
) -> Result<(), napi::Error> {
    let Some(outputs) = outputs else {
        return Ok(());
    };
    let Some(entries) = outputs.as_array() else {
        return Err(build_validation_error(
            stage,
            direction,
            "tool_outputs_shape",
            "toolOutputs must be an array when provided",
            source,
        ));
    };

    for (index, entry) in entries.iter().enumerate() {
        let row = expect_object(
            entry,
            stage,
            direction,
            "tool_outputs_shape",
            format!("toolOutputs[{index}] must be an object").as_str(),
            source,
        )?;
        let has_tool_call_id = row
            .get("tool_call_id")
            .and_then(|v| v.as_str())
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false);
        if !has_tool_call_id {
            return Err(build_validation_error(
                stage,
                direction,
                "tool_outputs_id",
                format!("toolOutputs[{index}].tool_call_id must be a string").as_str(),
                source,
            ));
        }
        if !row.get("content").map(|v| v.is_string()).unwrap_or(false) {
            return Err(build_validation_error(
                stage,
                direction,
                "tool_outputs_content",
                format!("toolOutputs[{index}].content must be a string").as_str(),
                source,
            ));
        }
    }

    Ok(())
}

fn validate_metadata(
    metadata: Option<&Value>,
    stage: &str,
    direction: &str,
    source: Option<&str>,
) -> Result<(), napi::Error> {
    let metadata_row = metadata.and_then(|v| v.as_object()).ok_or_else(|| {
        build_validation_error(
            stage,
            direction,
            "metadata_shape",
            "Chat envelope metadata must be an object",
            source,
        )
    })?;

    assert_no_reserved_keys(metadata_row, "metadata", stage, direction, source, false)?;

    if !metadata_row
        .get("context")
        .map(|v| v.is_object())
        .unwrap_or(false)
    {
        return Err(build_validation_error(
            stage,
            direction,
            "metadata_context",
            "metadata.context must be an object",
            source,
        ));
    }

    if let Some(extra_fields) = metadata_row.get("extraFields") {
        let extra_fields_row = extra_fields.as_object().ok_or_else(|| {
            build_validation_error(
                stage,
                direction,
                "metadata_extra_fields",
                "metadata.extraFields must be an object when provided",
                source,
            )
        })?;
        assert_no_reserved_keys(
            extra_fields_row,
            "metadata.extraFields",
            stage,
            direction,
            source,
            true,
        )?;
    }

    if let Some(provider_metadata) = metadata_row.get("providerMetadata") {
        if !provider_metadata.is_object() {
            return Err(build_validation_error(
                stage,
                direction,
                "metadata_provider",
                "metadata.providerMetadata must be an object when provided",
                source,
            ));
        }
    }

    Ok(())
}

fn validate_chat_envelope(
    chat: &Value,
    stage: &str,
    direction: &str,
    source: Option<&str>,
) -> Result<(), napi::Error> {
    let chat_row = chat.as_object().ok_or_else(|| {
        build_validation_error(
            stage,
            direction,
            "chatEnvelope_missing",
            "Chat envelope must be an object",
            source,
        )
    })?;

    assert_no_reserved_keys(chat_row, "chatEnvelope", stage, direction, source, false)?;

    let messages = chat_row
        .get("messages")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            build_validation_error(
                stage,
                direction,
                "messages_missing",
                "Chat envelope must include at least one message",
                source,
            )
        })?;
    if messages.is_empty() {
        return Err(build_validation_error(
            stage,
            direction,
            "messages_missing",
            "Chat envelope must include at least one message",
            source,
        ));
    }

    for (index, message) in messages.iter().enumerate() {
        let message_row = expect_object(
            message,
            stage,
            direction,
            "message_shape",
            format!("messages[{index}] must be an object").as_str(),
            source,
        )?;
        assert_no_reserved_keys(
            message_row,
            format!("messages[{index}]").as_str(),
            stage,
            direction,
            source,
            false,
        )?;

        let role = message_row
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let valid_role = matches!(role, "system" | "user" | "assistant" | "tool");
        if !valid_role {
            return Err(build_validation_error(
                stage,
                direction,
                "message_role",
                format!("messages[{index}].role must be one of system, user, assistant, tool")
                    .as_str(),
                source,
            ));
        }

        validate_tool_calls(message_row, index, stage, direction, source)?;
    }

    let parameters = chat_row
        .get("parameters")
        .and_then(|v| v.as_object())
        .ok_or_else(|| {
            build_validation_error(
                stage,
                direction,
                "parameters_model",
                "Chat envelope parameters.model must be a string",
                source,
            )
        })?;
    let model_ok = parameters
        .get("model")
        .and_then(|v| v.as_str())
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    if !model_ok {
        return Err(build_validation_error(
            stage,
            direction,
            "parameters_model",
            "Chat envelope parameters.model must be a string",
            source,
        ));
    }

    assert_no_reserved_keys(parameters, "parameters", stage, direction, source, false)?;
    validate_tools(chat_row.get("tools"), stage, direction, source)?;
    validate_tool_outputs(chat_row.get("toolOutputs"), stage, direction, source)?;
    validate_metadata(chat_row.get("metadata"), stage, direction, source)?;
    Ok(())
}

#[napi]
pub fn validate_chat_envelope_json(
    chat_json: String,
    stage: String,
    direction: String,
    source: Option<String>,
) -> NapiResult<String> {
    let chat: Value = serde_json::from_str(chat_json.as_str())
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    validate_chat_envelope(&chat, stage.as_str(), direction.as_str(), source.as_deref())?;
    serde_json::to_string(&true).map_err(|e| napi::Error::from_reason(e.to_string()))
}
