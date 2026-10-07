use super::*;

pub(super) fn responses_tools_for_anthropic_wire(
    object: &Map<String, Value>,
) -> Result<Vec<Value>, V3AnthropicCodecError> {
    responses_tools_for_anthropic_wire_with_declarations(object, None)
}

pub(super) fn responses_tool_as_anthropic_tool(
    tool: &Map<String, Value>,
) -> Result<Value, V3AnthropicCodecError> {
    if tool.get("type").and_then(Value::as_str) == Some("custom") {
        return responses_custom_tool_as_anthropic_compatibility_tool(tool);
    }
    if matches!(
        tool.get("type").and_then(Value::as_str),
        Some("web_search" | "web_search_preview")
    ) {
        return responses_web_search_tool_as_anthropic_tool(tool);
    }
    // Anthropic hosted server-tool 实际类型为 `web_search_20250305`（或未来
    // `_20990101` 等变体）：type 以 `web_search_` 开头即按 hosted 投影。
    // Mode A 直通 minimax 必须保留 `type:"web_search_20250305"`，否则
    // provider 把 tool 视作普通 function tool，model 返回 `function_call`
    // 而非 hosted `server_tool_use`（实测 root cause：wire 缺 type）。
    if tool
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind.starts_with("web_search_"))
    {
        return responses_web_search_tool_as_anthropic_tool(tool);
    }
    // Mode B 本地 websearch function（chat 入口 client 声明
    // `{"type":"function","function":{"name":"websearch"}}`，outbound 投影保留
    // 为本地 function tool）在 Anthropic wire 上必须以官方 server tool 名
    // `web_search` 编码——MiniMax 等 Anthropic provider 不识别 `websearch`，
    // 否则 provider 收不到搜索工具（表现为"我没有 websearch 工具"纯文本回答）。
    // Codex client 也可能声明 `name:"web_search"`（无 type），按 hosted
    // 投影兼容处理。
    if tool
        .get("name")
        .or_else(|| tool.get("function").and_then(|f| f.get("name")))
        .and_then(Value::as_str)
        .is_some_and(|name| {
            let normalized = name.trim();
            normalized.eq_ignore_ascii_case("websearch")
                || normalized.eq_ignore_ascii_case("web_search")
        })
    {
        return responses_web_search_tool_as_anthropic_tool(tool);
    }
    let mut output = Map::new();
    let name = tool
        .get("name")
        .or_else(|| {
            tool.get("function")
                .and_then(|function| function.get("name"))
        })
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            tool.get("type")
                .and_then(Value::as_str)
                .filter(|tool_type| matches!(*tool_type, "tool_search"))
                .map(str::to_string)
        })
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "tools[].name",
        })?;
    output.insert(
        "name".to_string(),
        Value::String(super::super::request_outbound_mcp_names::provider_function_name(&name)),
    );
    if let Some(description) = tool.get("description").or_else(|| {
        tool.get("function")
            .and_then(|function| function.get("description"))
    }) {
        output.insert("description".to_string(), description.clone());
    }
    let input_schema = tool
        .get("parameters")
        .or_else(|| {
            tool.get("function")
                .and_then(|function| function.get("parameters"))
        })
        .cloned()
        .unwrap_or_else(|| json!({"type":"object"}));
    output.insert("input_schema".to_string(), input_schema);
    Ok(Value::Object(output))
}

fn responses_custom_tool_as_anthropic_compatibility_tool(
    tool: &Map<String, Value>,
) -> Result<Value, V3AnthropicCodecError> {
    for key in tool.keys() {
        if !matches!(key.as_str(), "type" | "name" | "description" | "format") {
            return Err(V3AnthropicCodecError::UnmappedOutboundFields {
                paths: format!("$.request.tools[].{key}"),
            });
        }
    }
    let name = tool
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "tools[].name",
        })?;
    let source_description = match tool.get("description") {
        Some(Value::String(description)) => Some(description.as_str()),
        Some(_) => {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "tools[].description",
            })
        }
        None => None,
    };
    let compatibility_note = match tool.get("format") {
        Some(Value::String(format)) if format == "custom" => format!(
            "RouteCodex compatibility v3.custom_tool.anthropic_string_input_wrapper.v1: Anthropic does not natively enforce the source free-form custom-tool format; provide the exact raw string in the input field."
        ),
        Some(Value::Object(format)) => {
            let format_type = format.get("type").and_then(Value::as_str).ok_or(
                V3AnthropicCodecError::MalformedField {
                    field: "tools[].format.type",
                },
            )?;
            match format_type {
                "text" if format.len() == 1 => format!(
                    "RouteCodex compatibility v3.custom_tool.anthropic_string_input_wrapper.v1: Anthropic does not natively enforce the source free-form custom-tool format; provide the exact raw string in the input field."
                ),
                "grammar" if format.len() == 3 => {
                    let syntax = format
                        .get("syntax")
                        .and_then(Value::as_str)
                        .ok_or(V3AnthropicCodecError::MalformedField {
                            field: "tools[].format.syntax",
                        })?;
                    let definition = format
                        .get("definition")
                        .and_then(Value::as_str)
                        .ok_or(V3AnthropicCodecError::MalformedField {
                            field: "tools[].format.definition",
                        })?;
                    format!(
                        "RouteCodex compatibility v3.custom_tool.anthropic_string_input_wrapper.v1: source grammar syntax={} definition={}; Anthropic does not natively enforce this grammar; provide the exact raw string in the input field.",
                        serde_json::to_string(syntax).map_err(|_| V3AnthropicCodecError::MalformedField { field: "tools[].format.syntax" })?,
                        serde_json::to_string(definition).map_err(|_| V3AnthropicCodecError::MalformedField { field: "tools[].format.definition" })?
                    )
                }
                _ => {
                    return Err(V3AnthropicCodecError::UnmappedOutboundFields {
                        paths: "$.request.tools[].format".to_string(),
                    })
                }
            }
        }
        _ => {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "tools[].format",
            })
        }
    };
    let description = source_description
        .map(|source| format!("{source}\n\n{compatibility_note}"))
        .unwrap_or_else(|| compatibility_note.clone());
    let mut input_schema = json!({
        "type":"object",
        "properties":{
            "input":{
                "type":"string",
                "description":compatibility_note
            }
        },
        "required":["input"],
        "additionalProperties":false
    });
    Ok(json!({
        "name":name,
        "description":description,
        "input_schema":input_schema
    }))
}

pub(crate) fn responses_web_search_tool_as_anthropic_tool(
    tool: &Map<String, Value>,
) -> Result<Value, V3AnthropicCodecError> {
    let mut output = Map::from_iter([
        (
            "type".to_string(),
            Value::String("web_search_20250305".to_string()),
        ),
        ("name".to_string(), Value::String("web_search".to_string())),
    ]);
    for key in ["blocked_domains", "cache_control", "max_uses", "strict"] {
        if let Some(value) = tool.get(key) {
            output.insert(key.to_string(), value.to_owned());
        }
    }
    let allowed_domains = tool.get("allowed_domains").or_else(|| {
        tool.get("filters")
            .and_then(Value::as_object)
            .and_then(|filters| filters.get("allowed_domains"))
    });
    if let Some(allowed_domains) = allowed_domains {
        output.insert("allowed_domains".to_string(), allowed_domains.to_owned());
    }
    if let Some(user_location) = tool.get("user_location") {
        output.insert("user_location".to_string(), user_location.to_owned());
    }
    if output.contains_key("allowed_domains") && output.contains_key("blocked_domains") {
        return Err(V3AnthropicCodecError::MalformedField {
            field: "tools[].web_search.allowed_domains",
        });
    }
    Ok(Value::Object(output))
}

pub(super) fn responses_tool_choice_as_anthropic_tool_choice(
    value: &Value,
) -> Result<Value, V3AnthropicCodecError> {
    // responses tool_choice type -> hub -> anthropic type（查表；未命中与原 match 一致报错/透传）
    let responses_to_anthropic_type = |responses_type: &str| -> Option<&'static str> {
        let hub = crate::protocol_tables::map_value(
            crate::protocol_tables::V3TableKind::ToolChoice,
            "responses",
            responses_type,
            crate::protocol_tables::V3TableDirection::Inbound,
        )
        .ok()
        .flatten()?;
        crate::protocol_tables::map_value(
            crate::protocol_tables::V3TableKind::ToolChoice,
            "anthropic",
            hub,
            crate::protocol_tables::V3TableDirection::Outbound,
        )
        .ok()
        .flatten()
    };
    if let Some(choice) = value.as_str() {
        return match responses_to_anthropic_type(choice) {
            Some(anthropic_type) => Ok(json!({"type": anthropic_type})),
            None => Err(V3AnthropicCodecError::MalformedField {
                field: "tool_choice",
            }),
        };
    }
    let Some(object) = value.as_object() else {
        return Err(V3AnthropicCodecError::MalformedField {
            field: "tool_choice",
        });
    };
    let mut projected = match object.get("type").and_then(Value::as_str) {
        Some("function") | Some("tool") | Some("custom") => object
            .get("name")
            .or_else(|| {
                object
                    .get("function")
                    .and_then(|function| function.get("name"))
            })
            .cloned()
            .map(|name| {
                json!({"type": responses_to_anthropic_type("tool").unwrap_or("tool"), "name": name})
            })
            .ok_or(V3AnthropicCodecError::MalformedField {
                field: "tool_choice.name",
            })?,
        Some("auto") | Some("any") | Some("none") => json!({
            "type": object.get("type").cloned().unwrap_or(Value::Null)
        }),
        Some("required") => json!({"type": responses_to_anthropic_type("required").unwrap_or("any")}),
        _ => {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "tool_choice",
            })
        }
    };
    if let Some(disable_parallel) = object.get("disable_parallel_tool_use") {
        projected
            .as_object_mut()
            .ok_or(V3AnthropicCodecError::PayloadNotObject)?
            .insert(
                "disable_parallel_tool_use".to_string(),
                disable_parallel.clone(),
            );
    }
    Ok(projected)
}
