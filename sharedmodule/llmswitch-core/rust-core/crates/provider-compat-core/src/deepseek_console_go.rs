use serde_json::{json, Map, Value};

/// Console Go 风格 responses 网关（opencode.ai/zen/go）custom tool 约束：
/// 上游只接受 `apply_patch` 一个 `type=custom` 工具，其余 custom 工具
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
            if tool_obj.get("type").and_then(Value::as_str) != Some("custom") {
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
            if item_obj.get("type").and_then(Value::as_str) != Some("custom_tool_call") {
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
    ensure_reasoning_text_before_each_tool_call(&mut root)?;
    Ok(Value::Object(root))
}

/// Console Go thinking 模式约束：上游要求每条 assistant 工具调用前的
/// `reasoning_text` 必须回传（缺失或为空都会 `reasoning_text must be passed
/// back` 400）。Codex 客户端历史里的 reasoning 可能是密文（encrypted_content）
/// 且 wire 层已剥离，或者完全没有 reasoning item。本函数在**每个映射过的
/// function_call 前**确保存在含非空 `reasoning_text` 的 reasoning item；
/// 缺失时插入最小占位（明文 `[thinking redacted]`）。**不会在
/// function_call_output 前插入**（上游要求 tool output 紧跟 tool call，
/// 中间插入任何 item 会触发 `No tool output found` 400）。
fn ensure_reasoning_text_before_each_tool_call(
    root: &mut Map<String, Value>,
) -> Result<(), String> {
    let Some(input) = root.get_mut("input").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    let mut index = 0;
    while index < input.len() {
        let Some(item) = input[index].as_object() else {
            index += 1;
            continue;
        };
        let kind = item.get("type").and_then(Value::as_str);
        if kind != Some("function_call") {
            index += 1;
            continue;
        }
        let preceded_by_reasoning = index
            .checked_sub(1)
            .and_then(|previous| input.get(previous))
            .and_then(Value::as_object)
            .filter(|previous| previous.get("type").and_then(Value::as_str) == Some("reasoning"))
            .is_some_and(|previous| {
                previous
                    .get("content")
                    .and_then(Value::as_array)
                    .and_then(|content| content.first())
                    .and_then(Value::as_object)
                    .and_then(|part| part.get("text"))
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.trim().is_empty())
            });
        if !preceded_by_reasoning {
            input.insert(
                index,
                json!({
                    "type": "reasoning",
                    "id": format!("rsn_placeholder_{index}"),
                    "summary": [],
                    "content": [{"type": "reasoning_text", "text": "[thinking redacted]"}]
                }),
            );
            index += 1;
        }
        index += 1;
    }
    Ok(())
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
                .and_then(|arguments| arguments.get("input").cloned())
                .unwrap_or(Value::Null);
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
        assert_eq!(
            input[1]["type"],
            json!("reasoning"),
            "reasoning placeholder precedes tool call"
        );
        assert_eq!(input[2]["type"], json!("function_call"));
        assert_eq!(input[2]["name"], json!("exec_command"));
        assert_eq!(input[2]["arguments"], json!("{\"input\":\"ls -la\"}"));
        assert!(
            input[2].get("input").is_none(),
            "raw input must be replaced"
        );
    }

    #[test]
    fn maps_custom_tool_call_output_to_function_call_output_except_apply_patch() {
        let mapped = apply_request_compat(request_body()).unwrap();
        let input = mapped["input"].as_array().unwrap();
        assert_eq!(input[3]["type"], json!("function_call_output"));
        assert_eq!(input[3]["call_id"], json!("call_1"));
        assert_eq!(input[3]["output"], json!("file1"));
    }

    #[test]
    fn inserts_reasoning_placeholder_before_tool_call_when_missing() {
        let body = json!({
            "model": "m",
            "input": [
                {"type": "custom_tool_call", "call_id": "c1", "name": "exec_command", "input": "ls"},
                {"type": "custom_tool_call_output", "call_id": "c1", "output": "f"}
            ],
            "tools": []
        });
        let mapped = apply_request_compat(body).unwrap();
        let input = mapped["input"].as_array().unwrap();
        assert_eq!(input[0]["type"], json!("reasoning"));
        assert_eq!(input[0]["content"][0]["text"], json!("[thinking redacted]"));
        assert_eq!(input[1]["type"], json!("function_call"));
        assert_eq!(
            input[2]["type"],
            json!("function_call_output"),
            "output must immediately follow call"
        );
    }

    #[test]
    fn does_not_insert_reasoning_when_non_empty_text_precedes_tool_call() {
        let body = json!({
            "model": "m",
            "input": [
                {"type": "reasoning", "id": "rsn_1", "summary": [], "content": [{"type": "reasoning_text", "text": "real thinking"}]},
                {"type": "custom_tool_call", "call_id": "c1", "name": "exec_command", "input": "ls"}
            ],
            "tools": []
        });
        let mapped = apply_request_compat(body).unwrap();
        let input = mapped["input"].as_array().unwrap();
        assert_eq!(input.len(), 2, "real reasoning must not be duplicated");
        assert_eq!(input[0]["content"][0]["text"], json!("real thinking"));
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
}
