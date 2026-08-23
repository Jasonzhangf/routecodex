use serde_json::{json, Map, Value};

/// Console Go 风格 responses 网关（opencode.ai/zen/go）custom tool 约束：
/// 上游只接受 `apply_patch` 一个 `type=custom` 工具；`tool_search` 以及其余 custom 工具
/// （exec_command / web_search / reasoningStop 等）必须以 `type=function`
/// 形态声明才会被接受；直接透传 custom 会返回
/// `Unsupported custom tool: '<name>'. Only 'apply_patch' is supported.`（400）。
///
/// 本 compat 只做工具面映射，不改变工具语义：
/// - 请求侧：custom(≠apply_patch) 声明 → function 声明；历史
///   `custom_tool_call.input`（原始字符串）→ `function_call.arguments`
///   （`{"input":"<raw>"}` JSON 字符串，上游 function 工具要求字符串 arguments）。
/// - 响应侧：上游返回的 `function_call`（对应映射过的 function 声明）→
///   `custom_tool_call`（arguments 解包 `input` 回原始字符串），客户端按
///   其声明的 custom 工具形态继续执行。
///
/// `apply_patch` 保持 custom 透传（上游原生支持，避免双向改写）。
pub(crate) fn apply_request_compat(payload: Value) -> Result<Value, String> {
    let mut root = payload.as_object().cloned().ok_or_else(|| {
        "MalformedPayload profile=responses:deepseek reason=request_object_required".to_string()
    })?;
    if let Some(tools) = root.get_mut("tools").and_then(Value::as_array_mut) {
        for tool in tools.iter_mut() {
            let Some(tool_obj) = tool.as_object_mut() else {
                continue;
            };
            let tool_type = tool_obj.get("type").and_then(Value::as_str);
            if tool_type == Some("tool_search") {
                tool_obj.insert("type".to_string(), Value::String("function".to_string()));
                tool_obj.insert("name".to_string(), Value::String("tool_search".to_string()));
                continue;
            }
            if tool_type != Some("custom") {
                continue;
            }
            let name = tool_obj
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty());
            let Some(name) = name else {
                continue;
            };
            if name == "apply_patch" {
                continue;
            }
            let mut function = Map::new();
            function.insert("type".to_string(), Value::String("function".to_string()));
            function.insert("name".to_string(), Value::String(name.to_string()));
            if let Some(description) = tool_obj
                .get("description")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                function.insert(
                    "description".to_string(),
                    Value::String(description.to_string()),
                );
            }
            function.insert(
                "parameters".to_string(),
                json!({
                    "type": "object",
                    "properties": {
                        "input": {"type": "string", "description": name}
                    },
                    "required": ["input"]
                }),
            );
            *tool = Value::Object(function);
        }
    }
    if let Some(input) = root.get_mut("input").and_then(Value::as_array_mut) {
        for item in input.iter_mut() {
            let Some(item_obj) = item.as_object_mut() else {
                continue;
            };
            if item_obj.get("type").and_then(Value::as_str) == Some("tool_search_call") {
                let arguments = item_obj
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                item_obj.insert(
                    "type".to_string(),
                    Value::String("function_call".to_string()),
                );
                item_obj.insert("name".to_string(), Value::String("tool_search".to_string()));
                item_obj.insert(
                    "arguments".to_string(),
                    Value::String(serde_json::to_string(&arguments).map_err(|error| {
                        format!(
                            "MalformedPayload profile=responses:deepseek reason=tool_search_arguments_serialize error={error}"
                        )
                    })?),
                );
                continue;
            }
            if item_obj.get("type").and_then(Value::as_str) != Some("custom_tool_call") {
                continue;
            }
            let name = item_obj
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty());
            if name == Some("tool_search") {
                let arguments = item_obj
                    .get("arguments")
                    .and_then(Value::as_str)
                    .and_then(|text| serde_json::from_str::<Value>(text).ok())
                    .unwrap_or_else(|| json!({}));
                item_obj.insert(
                    "type".to_string(),
                    Value::String("tool_search_call".to_string()),
                );
                item_obj.insert("arguments".to_string(), arguments);
                item_obj.remove("name");
                continue;
            }
            if name == Some("apply_patch") {
                continue;
            }
            let Some(raw_input) = item_obj.get("input").cloned() else {
                continue;
            };
            let arguments = match raw_input {
                Value::String(text) => {
                    serde_json::to_string(&json!({"input": text}))
                        .map_err(|error| {
                            format!(
                                "MalformedPayload profile=responses:deepseek reason=custom_input_serialize error={error}"
                            )
                        })?
                }
                other => {
                    serde_json::to_string(&json!({"input": other}))
                        .map_err(|error| {
                            format!(
                                "MalformedPayload profile=responses:deepseek reason=custom_input_serialize error={error}"
                            )
                        })?
                }
            };
            item_obj.insert(
                "type".to_string(),
                Value::String("function_call".to_string()),
            );
            item_obj.insert("arguments".to_string(), Value::String(arguments));
            item_obj.remove("input");
        }
    }
    if let Some(input) = root.get_mut("input").and_then(Value::as_array_mut) {
        for item in input.iter_mut() {
            let Some(item_obj) = item.as_object_mut() else {
                continue;
            };
            if item_obj.get("type").and_then(Value::as_str) == Some("tool_search_output") {
                let output = item_obj.get("tools").cloned().unwrap_or_else(|| json!([]));
                item_obj.insert(
                    "type".to_string(),
                    Value::String("function_call_output".to_string()),
                );
                item_obj.insert(
                    "output".to_string(),
                    Value::String(serde_json::to_string(&output).map_err(|error| {
                        format!(
                            "MalformedPayload profile=responses:deepseek reason=tool_search_output_serialize error={error}"
                        )
                    })?),
                );
                item_obj.remove("tools");
                continue;
            }
            if item_obj.get("type").and_then(Value::as_str) != Some("custom_tool_call_output") {
                continue;
            }
            let name = item_obj
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty());
            if name == Some("apply_patch") {
                continue;
            }
            item_obj.insert(
                "type".to_string(),
                Value::String("function_call_output".to_string()),
            );
        }
    }
    let mut payload = Value::Object(root);
    apply_deepseek_v4_thinking_chat_compat(&mut payload);
    Ok(payload)
}

/// Single request-side owner for DeepSeek V4/OpenCode Go 400 compatibility.
/// Handles both Responses input history and projected OpenAI Chat messages.
pub fn apply_deepseek_v4_request_compat(payload: &mut Value) {
    apply_deepseek_v4_thinking_chat_compat(payload);
}

fn apply_deepseek_v4_thinking_chat_compat(payload: &mut Value) {
    let thinking = payload
        .get("reasoning_effort")
        .and_then(Value::as_str)
        .or_else(|| payload.pointer("/reasoning/effort").and_then(Value::as_str))
        .is_some_and(|effort| !effort.trim().is_empty() && effort != "none");
    if !thinking {
        return;
    }
    if let Some(root) = payload.as_object_mut() {
        root.remove("tool_choice");
    }
    if let Some(messages) = payload.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages {
            let Some(object) = message.as_object_mut() else {
                continue;
            };
            if object.get("role").and_then(Value::as_str) != Some("assistant") {
                continue;
            }
            object
                .entry("reasoning_content".to_string())
                .or_insert_with(|| Value::String(String::new()));
            if object.get("content").is_none_or(Value::is_null) {
                object.insert("content".to_string(), Value::String(String::new()));
            }
        }
    }
}

pub(crate) fn apply_response_compat(payload: Value) -> Value {
    let Some(mut root) = payload.as_object().cloned() else {
        return payload;
    };
    if let Some(output) = root.get_mut("output").and_then(Value::as_array_mut) {
        for item in output.iter_mut() {
            let Some(item_obj) = item.as_object_mut() else {
                continue;
            };
            if item_obj.get("type").and_then(Value::as_str) != Some("function_call") {
                continue;
            }
            let name = item_obj
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty());
            if name == Some("apply_patch") {
                continue;
            }
            let input = item_obj
                .get("arguments")
                .and_then(Value::as_str)
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .and_then(|arguments| arguments.get("input").cloned());
            let Some(input) = input else {
                continue;
            };
            item_obj.insert(
                "type".to_string(),
                Value::String("custom_tool_call".to_string()),
            );
            item_obj.insert("input".to_string(), input);
            item_obj.remove("arguments");
        }
    }
    Value::Object(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request_body() -> Value {
        json!({
            "model": "deepseek-v4-flash",
            "input": [
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "run ls"}]},
                {"type": "custom_tool_call", "call_id": "call_1", "name": "exec_command", "input": "ls -la"},
                {"type": "custom_tool_call_output", "call_id": "call_1", "output": "file1"}
            ],
            "tools": [
                {"type": "custom", "name": "apply_patch", "description": "patch", "format": "custom"},
                {"type": "custom", "name": "exec_command", "description": "run", "format": "custom"}
            ]
        })
    }

    #[test]
    fn thinking_chat_400_rules_are_applied_by_single_request_owner() {
        let mut body = json!({
            "model": "deepseek-v4-flash",
            "reasoning_effort": "high",
            "tool_choice": "auto",
            "messages": [
                {"role": "assistant", "content": null, "tool_calls": [{"id": "call_1"}]},
                {"role": "user", "content": "next"}
            ]
        });

        apply_deepseek_v4_request_compat(&mut body);

        assert!(body.get("tool_choice").is_none());
        assert_eq!(body["messages"][0]["content"], "");
        assert_eq!(body["messages"][0]["reasoning_content"], "");
    }

    #[test]
    fn non_thinking_chat_keeps_tool_choice() {
        let mut body = json!({
            "model": "deepseek-v4-flash",
            "reasoning_effort": "none",
            "tool_choice": "required",
            "messages": [{"role": "assistant", "content": null}]
        });

        apply_deepseek_v4_request_compat(&mut body);

        assert_eq!(body["tool_choice"], "required");
        assert!(body["messages"][0].get("reasoning_content").is_none());
    }

    #[test]
    fn maps_custom_tool_declarations_except_apply_patch_to_function() {
        let mapped = apply_request_compat(request_body()).unwrap();
        let tools = mapped["tools"].as_array().unwrap();
        assert_eq!(
            tools[0]["type"],
            json!("custom"),
            "apply_patch must stay custom"
        );
        assert_eq!(tools[0]["name"], json!("apply_patch"));
        assert_eq!(
            tools[1]["type"],
            json!("function"),
            "exec_command must map to function"
        );
        assert_eq!(tools[1]["name"], json!("exec_command"));
        assert_eq!(tools[1]["description"], json!("run"));
        assert_eq!(
            tools[1]["parameters"],
            json!({"type": "object", "properties": {"input": {"type": "string", "description": "exec_command"}}, "required": ["input"]})
        );
    }

    #[test]
    fn maps_custom_tool_call_input_to_function_arguments_except_apply_patch() {
        let mapped = apply_request_compat(request_body()).unwrap();
        let input = mapped["input"].as_array().unwrap();
        assert_eq!(input[0]["type"], json!("message"));
        assert_eq!(input[1]["type"], json!("function_call"));
        assert_eq!(input[1]["name"], json!("exec_command"));
        assert_eq!(input[1]["arguments"], json!("{\"input\":\"ls -la\"}"));
        assert!(
            input[1].get("input").is_none(),
            "raw input must be replaced"
        );
    }

    #[test]
    fn maps_custom_tool_call_output_to_function_call_output_except_apply_patch() {
        let mapped = apply_request_compat(request_body()).unwrap();
        let input = mapped["input"].as_array().unwrap();
        assert_eq!(input[2]["type"], json!("function_call_output"));
        assert_eq!(input[2]["call_id"], json!("call_1"));
        assert_eq!(input[2]["output"], json!("file1"));
    }

    #[test]
    fn maps_tool_search_history_to_console_go_function_shape() {
        let body = json!({
            "model": "m",
            "input": [
                {"type": "tool_search_call", "call_id": "search_1", "arguments": {"query": "dsh"}},
                {"type": "tool_search_output", "call_id": "search_1", "tools": [{"name": "dsh_review_start"}]}
            ],
            "tools": [{"type": "tool_search", "name": "tool_search", "parameters": {"type": "object"}}]
        });
        let mapped = apply_request_compat(body).unwrap();
        assert_eq!(mapped["tools"][0]["type"], json!("function"));
        assert_eq!(mapped["input"][0]["type"], json!("function_call"));
        assert_eq!(mapped["input"][0]["name"], json!("tool_search"));
        assert_eq!(
            mapped["input"][0]["arguments"],
            json!("{\"query\":\"dsh\"}")
        );
        assert_eq!(mapped["input"][1]["type"], json!("function_call_output"));
        assert_eq!(
            mapped["input"][1]["output"],
            json!("[{\"name\":\"dsh_review_start\"}]")
        );
    }

    #[test]
    fn keeps_apply_patch_call_history_untouched() {
        let body = json!({
            "model": "m",
            "input": [
                {"type": "custom_tool_call", "call_id": "c1", "name": "apply_patch", "input": "*** Begin Patch"}
            ],
            "tools": []
        });
        let mapped = apply_request_compat(body).unwrap();
        assert_eq!(mapped["input"][0]["type"], json!("custom_tool_call"));
        assert_eq!(mapped["input"][0]["input"], json!("*** Begin Patch"));
    }

    #[test]
    fn maps_function_call_response_back_to_custom_tool_call_except_apply_patch() {
        let body = json!({
            "id": "resp_1",
            "output": [
                {"type": "function_call", "call_id": "call_1", "name": "exec_command", "arguments": "{\"input\":\"ls -la\"}"}
            ]
        });
        let mapped = apply_response_compat(body);
        assert_eq!(mapped["output"][0]["type"], json!("custom_tool_call"));
        assert_eq!(mapped["output"][0]["name"], json!("exec_command"));
        assert_eq!(mapped["output"][0]["input"], json!("ls -la"));
        assert!(mapped["output"][0].get("arguments").is_none());
    }

    #[test]
    fn keeps_apply_patch_function_call_response_untouched() {
        let body = json!({
            "id": "resp_1",
            "output": [
                {"type": "function_call", "call_id": "call_1", "name": "apply_patch", "arguments": "{}"}
            ]
        });
        let mapped = apply_response_compat(body);
        assert_eq!(mapped["output"][0]["type"], json!("function_call"));
    }

    #[test]
    fn keeps_regular_function_call_response_untouched() {
        let body = json!({
            "id": "resp_1",
            "output": [
                {"type": "function_call", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"}
            ]
        });
        let mapped = apply_response_compat(body.clone());
        assert_eq!(mapped, body);
    }
}
