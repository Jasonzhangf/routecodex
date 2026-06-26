use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::metadata_center::{
    build_metadata_center_from_snapshot, MetadataCenter, MetadataCenterReader,
};
use crate::req_process_stage1_tool_governance_blocks::request_result::{
    apply_chat_process_request_sanitizer, build_governed_filter_payload, build_node_result,
    build_processed_request, now_millis,
};
use crate::req_process_stage1_tool_governance_blocks::request_sanitizer::{
    apply_anthropic_tool_alias_semantics, apply_post_governed_media_cleanup,
    resolve_governance_context,
};
use crate::req_process_stage1_tool_governance_blocks::servertool_injection::{
    maybe_apply_servertool_orchestration, resolve_client_inject_ready,
};
use crate::shared_json_utils::{normalize_record, normalize_record_ref};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolGovernanceInput {
    pub request: Value,
    pub raw_payload: Value,
    pub metadata: Value,
    pub entry_endpoint: String,
    pub request_id: String,
    #[serde(default)]
    pub has_active_stop_message_for_continue_execution: Option<bool>,
    #[serde(default)]
    pub metadata_center_snapshot: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolGovernanceOutput {
    pub processed_request: Value,
    pub node_result: Value,
}

#[derive(Debug)]
struct GovernanceContext {
    entry_endpoint: String,
}

const STOPLESS_SYSTEM_INSTRUCTION: &str = concat!(
    "当你准备结束当前轮时，必须使用唯一 stop schema 合同。\n",
    "优先路径：直接调用名为 reasoningStop 的 function tool，并把完整 JSON schema 放进该 tool call 的 arguments。\n",
    "禁止把 reasoningStop 当成 shell / CLI 命令；不要输出或执行 exec_command(cmd=\"reasoningStop\")。\n",
    "如果你直接 finish_reason=stop，正文末尾必须附：\n",
    "<rcc_stop_schema>\n",
    "{\"stopreason\":2,\"reason\":\"当前状态原因\",\"has_evidence\":0,\"evidence\":\"\",\"issue_cause\":\"\",\"excluded_factors\":\"\",\"diagnostic_order\":\"\",\"done_steps\":\"\",\"next_step\":\"如果仍需继续，写立刻执行的下一步；否则写无\",\"next_suggested_path\":\"\",\"needs_user_input\":false,\"learned\":\"\"}\n",
    "</rcc_stop_schema>\n",
    "标准 JSON 字段：stopreason, reason, has_evidence, evidence, issue_cause, excluded_factors, diagnostic_order, done_steps, next_step, next_suggested_path, needs_user_input, learned。\n",
    "stopreason 取值：0=finished，1=blocked，2=continue_needed。\n",
    "finished：表示已经完成，可停止；blocked：表示确实卡住且需要停止；continue_needed：表示还不能停，必须继续推进并给 next_step。\n",
    "needs_user_input 只能是 true/false；true 只用于真的需要向用户提一个问题。\n",
    "无 arguments 且无 <rcc_stop_schema> 时，不允许停止。"
);

fn request_already_has_stopless_system_instruction(request: &Map<String, Value>) -> bool {
    request
        .get("instructions")
        .and_then(Value::as_str)
        .map(|content| content.contains("<rcc_stop_schema>"))
        .unwrap_or(false)
}

fn inject_stopless_system_instruction(request: &mut Map<String, Value>) {
    if request_already_has_stopless_system_instruction(request) {
        return;
    }
    let has_supported_turns = request
        .get("input")
        .map(|value| matches!(value, Value::Array(_)))
        .unwrap_or(false)
        || request
            .get("messages")
            .map(|value| matches!(value, Value::Array(_)))
            .unwrap_or(false);
    if !has_supported_turns {
        return;
    }
    request.insert(
        "instructions".to_string(),
        Value::String(STOPLESS_SYSTEM_INSTRUCTION.to_string()),
    );
}

fn should_inject_stopless_system_instruction(
    center: &MetadataCenter,
    metadata: &Map<String, Value>,
) -> bool {
    center.stop_message_enabled().unwrap_or(false)
        || metadata
            .get("stopMessageEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

fn request_has_tool(request: &Map<String, Value>, tool_name: &str) -> bool {
    request
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools.iter().any(|tool| {
                let direct_name = tool.get("name").and_then(Value::as_str).map(str::trim);
                let function_name = tool
                    .get("function")
                    .and_then(Value::as_object)
                    .and_then(|row| row.get("name"))
                    .and_then(Value::as_str)
                    .map(str::trim);
                direct_name == Some(tool_name) || function_name == Some(tool_name)
            })
        })
        .unwrap_or(false)
}

fn output_has_terminal_stopless_trigger(output: &Value) -> bool {
    let row = match output {
        Value::String(raw) => serde_json::from_str::<Value>(raw).ok(),
        Value::Object(_) => Some(output.clone()),
        _ => None,
    };
    let Some(row) = row.and_then(|value| value.as_object().cloned()) else {
        return false;
    };
    row.get("schemaGuidance")
        .or_else(|| row.get("schema_guidance"))
        .and_then(Value::as_object)
        .and_then(|schema| {
            schema
                .get("triggerHint")
                .or_else(|| schema.get("trigger_hint"))
        })
        .or_else(|| {
            row.get("input")
                .or_else(|| row.get("input_json"))
                .and_then(Value::as_object)
                .and_then(|input| {
                    input
                        .get("triggerHint")
                        .or_else(|| input.get("trigger_hint"))
                })
        })
        .and_then(Value::as_str)
        .map(is_terminal_stopless_trigger)
        .unwrap_or(false)
}

fn is_terminal_stopless_trigger(value: &str) -> bool {
    let normalized = value.trim();
    normalized.eq_ignore_ascii_case("budget_exhausted")
        || normalized.eq_ignore_ascii_case("schema_pass")
        || normalized.eq_ignore_ascii_case("stop_schema_budget_exhausted")
        || normalized.eq_ignore_ascii_case("stop_schema_finished")
        || normalized.eq_ignore_ascii_case("stop_schema_blocked")
        || normalized.eq_ignore_ascii_case("stop_schema_needs_user_input")
        || normalized.eq_ignore_ascii_case("stop_schema_forcestop")
}

fn value_contains_terminal_stopless_output(value: Option<&Value>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let Some(items) = value.as_array() else {
        return false;
    };
    items.iter().any(|entry| {
        let Some(row) = entry.as_object() else {
            return false;
        };
        let item_type = row
            .get("type")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(
            item_type.as_str(),
            "function_call_output" | "tool_result" | "tool_message"
        ) {
            return output_has_terminal_stopless_trigger(row.get("output").unwrap_or(&Value::Null));
        }
        let role = row
            .get("role")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_ascii_lowercase();
        if role == "tool" {
            return output_has_terminal_stopless_trigger(
                row.get("content")
                    .or_else(|| row.get("output"))
                    .unwrap_or(&Value::Null),
            );
        }
        false
    })
}

fn request_has_terminal_stopless_output(request: &Map<String, Value>) -> bool {
    value_contains_terminal_stopless_output(request.get("input"))
        || value_contains_terminal_stopless_output(request.get("messages"))
}

fn metadata_has_terminal_stopless_runtime_control(metadata: &Map<String, Value>) -> bool {
    metadata
        .get("runtime_control")
        .and_then(Value::as_object)
        .and_then(|runtime_control| runtime_control.get("stopless"))
        .and_then(Value::as_object)
        .filter(|stopless| {
            stopless
                .get("active")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .and_then(|stopless| {
            stopless
                .get("triggerHint")
                .or_else(|| stopless.get("trigger_hint"))
        })
        .and_then(Value::as_str)
        .map(is_terminal_stopless_trigger)
        .unwrap_or(false)
}

fn strip_tool_choice_for_terminal_stopless_turn(request: &mut Map<String, Value>) {
    let should_remove = request
        .get("tool_choice")
        .or_else(|| request.get("toolChoice"))
        .map(|tool_choice| match tool_choice {
            Value::String(raw) => raw.trim().eq_ignore_ascii_case("required"),
            Value::Object(row) => row
                .get("function")
                .and_then(Value::as_object)
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
                .map(|name| name.trim().eq_ignore_ascii_case("reasoningStop"))
                .unwrap_or_else(|| {
                    row.get("type")
                        .and_then(Value::as_str)
                        .map(|value| value.trim().eq_ignore_ascii_case("function"))
                        .unwrap_or(false)
                }),
            _ => false,
        })
        .unwrap_or(false);
    if should_remove {
        request.remove("tool_choice");
        request.remove("toolChoice");
    }
}

fn strip_stopless_terminal_controls(request: &mut Map<String, Value>) {
    if request_already_has_stopless_system_instruction(request) {
        request.remove("instructions");
    }
    if let Some(tools) = request.get_mut("tools").and_then(Value::as_array_mut) {
        tools.retain(|tool| {
            let direct_name = tool.get("name").and_then(Value::as_str).map(str::trim);
            let function_name = tool
                .get("function")
                .and_then(Value::as_object)
                .and_then(|row| row.get("name"))
                .and_then(Value::as_str)
                .map(str::trim);
            direct_name != Some("reasoningStop") && function_name != Some("reasoningStop")
        });
    }
    strip_tool_choice_for_terminal_stopless_turn(request);
}

fn build_reasoning_stop_tool() -> Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "reasoningStop",
            "description": concat!(
                "Use this tool every time you want to stop. ",
                "Schema means the structured JSON contract for the stop result: it tells the system what is finished, what is blocked, and what still needs to continue. ",
                "Provide the real stop schema as JSON arguments and fill every field with concrete content. ",
                "If you do not call this tool and still stop, the assistant text must end with <rcc_stop_schema>...</rcc_stop_schema>. ",
                "stopreason values: 0=finished, 1=blocked, 2=continue_needed. ",
                "If work remains, use stopreason=2 and write next_step. ",
                "Field meanings: stopreason, reason, has_evidence, evidence, issue_cause, excluded_factors, diagnostic_order, done_steps, next_step, next_suggested_path, needs_user_input, learned. ",
                "示例 finished payload: ",
                "{\"stopreason\":0,\"reason\":\"已完成并验证\",\"has_evidence\":1,\"evidence\":\"列出已验证日志/测试/文件\",\"issue_cause\":\"问题已修复\",\"excluded_factors\":\"无\",\"diagnostic_order\":\"1.定位 2.修复 3.验证\",\"done_steps\":\"概述已完成动作\",\"next_step\":\"无\",\"next_suggested_path\":\"无\",\"needs_user_input\":false,\"learned\":\"补充本轮结论\"}"
            ),
            "parameters": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "stopreason": {
                        "type": "integer",
                        "enum": [0, 1, 2],
                        "description": "0=finished, 1=blocked, 2=continue_needed"
                    },
                    "reason": {
                        "type": "string",
                        "description": "Real current state summary."
                    },
                    "has_evidence": {
                        "type": "integer",
                        "enum": [0, 1],
                        "description": "Whether concrete evidence is available."
                    },
                    "evidence": {
                        "type": "string",
                        "description": "Concrete logs, tests, files, outputs, or observations."
                    },
                    "issue_cause": {
                        "type": "string",
                        "description": "Root cause or current blocker cause."
                    },
                    "excluded_factors": {
                        "type": "string",
                        "description": "Things already ruled out."
                    },
                    "diagnostic_order": {
                        "type": "string",
                        "description": "Investigation order already taken."
                    },
                    "done_steps": {
                        "type": "string",
                        "description": "Concrete steps already completed."
                    },
                    "next_step": {
                        "type": "string",
                        "description": "Required next action. Use \"无\" only when truly finished or blocked."
                    },
                    "next_suggested_path": {
                        "type": "string",
                        "description": "Suggested next path if another turn is needed."
                    },
                    "needs_user_input": {
                        "type": "boolean",
                        "description": "true only when user input is required before progress can continue."
                    },
                    "learned": {
                        "type": "string",
                        "description": "Key lesson or durable conclusion from this turn."
                    }
                },
                "required": [
                    "stopreason",
                    "reason",
                    "has_evidence",
                    "evidence",
                    "issue_cause",
                    "excluded_factors",
                    "diagnostic_order",
                    "done_steps",
                    "next_step",
                    "next_suggested_path",
                    "needs_user_input",
                    "learned"
                ]
            }
        }
    })
}

fn inject_reasoning_stop_tool(request: &mut Map<String, Value>) {
    if request_has_tool(request, "reasoningStop") {
        return;
    }
    let tools = request
        .entry("tools".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !tools.is_array() {
        *tools = Value::Array(Vec::new());
    }
    if let Some(items) = tools.as_array_mut() {
        items.push(build_reasoning_stop_tool());
    }
}

pub fn apply_req_process_tool_governance(
    input: ToolGovernanceInput,
) -> Result<ToolGovernanceOutput, String> {
    let start_time_ms = now_millis();

    let ctx = resolve_governance_context(&input.metadata, &input.entry_endpoint);

    let metadata = normalize_record(input.metadata);
    let metadata_center = build_metadata_center_from_snapshot(&input.metadata_center_snapshot);
    let request_metadata = Value::Object(metadata.clone());
    let mut request = normalize_record(input.request);
    apply_chat_process_request_sanitizer(&mut request);
    let has_terminal_stopless_turn = request_has_terminal_stopless_output(&request)
        || metadata_has_terminal_stopless_runtime_control(&metadata);
    if has_terminal_stopless_turn {
        strip_stopless_terminal_controls(&mut request);
    }
    if should_inject_stopless_system_instruction(&metadata_center, &metadata)
        && !has_terminal_stopless_turn
    {
        inject_stopless_system_instruction(&mut request);
        inject_reasoning_stop_tool(&mut request);
    }
    normalize_apply_patch_freeform_tool_schema(&mut request);

    apply_anthropic_tool_alias_semantics(&mut request, &ctx.entry_endpoint);

    let governed = build_governed_filter_payload(&Value::Object(request));
    let mut governed_request = normalize_record(governed);
    maybe_apply_servertool_orchestration(
        &mut governed_request,
        &metadata,
        input
            .has_active_stop_message_for_continue_execution
            .unwrap_or(false),
    );
    apply_post_governed_media_cleanup(&mut governed_request);

    let processed = build_processed_request(Value::Object(governed_request), &metadata);
    let processed_request_map = normalize_record_ref(&processed);
    let end_time_ms = now_millis();

    let node_result = build_node_result(
        true,
        start_time_ms,
        end_time_ms,
        &processed_request_map,
        None,
    );

    Ok(ToolGovernanceOutput {
        processed_request: processed,
        node_result,
    })
}

fn normalize_apply_patch_freeform_tool_schema(request: &mut Map<String, Value>) {
    const APPLY_PATCH_LARK_GRAMMAR: &str = r#"start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?
hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?
filename: /(.+)/
add_line: "+" /(.*)/ LF
change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF
%import common.LF"#;
    let Some(tools) = request.get_mut("tools").and_then(Value::as_array_mut) else {
        return;
    };
    for tool in tools {
        let Some(tool_obj) = tool.as_object_mut() else {
            continue;
        };
        let function_name = tool_obj
            .get("function")
            .and_then(Value::as_object)
            .and_then(|function| function.get("name"))
            .and_then(Value::as_str);
        let direct_name = tool_obj.get("name").and_then(Value::as_str);
        let name = function_name.or(direct_name).unwrap_or("").trim();
        if name != "apply_patch" {
            continue;
        }
        let description = tool_obj
            .get("function")
            .and_then(Value::as_object)
            .and_then(|function| function.get("description"))
            .and_then(Value::as_str)
            .or_else(|| tool_obj.get("description").and_then(Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Use the `apply_patch` tool to edit files.");
        *tool_obj = serde_json::json!({
            "type": "custom",
            "name": "apply_patch",
            "description": description,
            "format": {
                "type": "grammar",
                "syntax": "lark",
                "definition": APPLY_PATCH_LARK_GRAMMAR
            }
        })
        .as_object()
        .cloned()
        .unwrap_or_default();
    }
}

#[cfg(test)]
mod apply_patch_tool_schema_tests {
    use super::{
        apply_req_process_tool_governance, normalize_apply_patch_freeform_tool_schema,
        ToolGovernanceInput,
    };
    use serde_json::{json, Map, Value};

    fn normalize_tools(input: Value) -> Value {
        let mut request = Map::new();
        request.insert("tools".to_string(), input);
        normalize_apply_patch_freeform_tool_schema(&mut request);
        request.get("tools").cloned().unwrap_or(Value::Null)
    }

    #[test]
    fn normalize_apply_patch_freeform_tool_schema_converts_function_shape_to_custom_freeform() {
        let tools = normalize_tools(json!([{
            "type": "function",
            "function": {
                "name": "apply_patch",
                "description": "Edit files by patch",
                "parameters": {
                    "type": "object",
                    "properties": { "patch": { "type": "string" } },
                    "required": ["patch"]
                }
            }
        }]));

        let tool = &tools.as_array().unwrap()[0];
        assert_eq!(tool["type"], json!("custom"));
        assert_eq!(tool["name"], json!("apply_patch"));
        assert_eq!(tool["description"], json!("Edit files by patch"));
        assert_eq!(tool["format"]["type"], json!("grammar"));
        assert_eq!(tool["format"]["syntax"], json!("lark"));
        let definition = tool["format"]["definition"]
            .as_str()
            .expect("apply_patch grammar definition");
        assert!(definition.contains("begin_patch:"));
        assert!(definition.contains("end_patch:"));
        assert!(definition.contains("%import common.LF"));
        assert!(tool.get("function").is_none());
        assert!(tool.get("parameters").is_none());
    }

    #[test]
    fn normalize_apply_patch_freeform_tool_schema_removes_direct_patch_parameters() {
        let tools = normalize_tools(json!([{
            "type": "custom",
            "name": "apply_patch",
            "description": "Use apply_patch",
            "parameters": {
                "type": "object",
                "properties": { "patch": { "type": "string" } },
                "required": ["patch"]
            }
        }]));

        let tool = &tools.as_array().unwrap()[0];
        assert_eq!(tool["type"], json!("custom"));
        assert_eq!(tool["name"], json!("apply_patch"));
        assert!(tool.get("parameters").is_none());
        assert_eq!(tool["format"]["type"], json!("grammar"));
        let definition = tool["format"]["definition"]
            .as_str()
            .expect("apply_patch grammar definition");
        assert!(definition.contains("begin_patch:"));
    }

    #[test]
    fn apply_req_process_tool_governance_projects_apply_patch_as_custom_freeform_tool() {
        let output = apply_req_process_tool_governance(ToolGovernanceInput {
            request: json!({
                "model": "gpt-test",
                "messages": [{ "role": "user", "content": "edit a file" }],
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "apply_patch",
                        "description": "canonical client apply_patch tool",
                        "parameters": {
                            "type": "object",
                            "properties": { "patch": { "type": "string" } },
                            "required": ["patch"]
                        }
                    }
                }],
                "parameters": {}
            }),
            raw_payload: Value::Null,
            metadata: json!({}),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req-apply-patch-freeform-prod".to_string(),
            has_active_stop_message_for_continue_execution: Some(false),
            metadata_center_snapshot: Value::Null,
        })
        .expect("governed request");

        let tool = output.processed_request["tools"][0].clone();
        assert_eq!(tool["type"], json!("custom"));
        assert_eq!(tool["name"], json!("apply_patch"));
        assert_eq!(tool["format"]["type"], json!("grammar"));
        assert_eq!(tool["format"]["syntax"], json!("lark"));
        assert!(tool.get("parameters").is_none());
        assert!(tool.get("function").is_none());
    }
}

#[napi]
pub fn apply_req_process_tool_governance_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: ToolGovernanceInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output =
        apply_req_process_tool_governance(input).map_err(|e| napi::Error::from_reason(e))?;

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}
