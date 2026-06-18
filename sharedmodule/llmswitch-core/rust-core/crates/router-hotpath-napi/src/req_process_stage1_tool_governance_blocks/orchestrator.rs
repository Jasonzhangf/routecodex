use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

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
    "当你准备结束当前轮时，必须同时给出两部分：\n",
    "1. 简洁 summary，说明这轮完成了什么或为什么现在必须停。\n",
    "2. 回复末尾附一段 JSON，字段必须按真实情况填写。\n",
    "标准 JSON 字段：stopreason, reason, has_evidence, evidence, issue_cause, excluded_factors, diagnostic_order, done_steps, next_step, next_suggested_path, needs_user_input, learned。\n",
    "stopreason 取值：0=finished，1=blocked，2=continue_needed。\n",
    "finished：表示已经完成，可停止；blocked：表示确实卡住且需要停止；continue_needed：表示还不能停，必须继续推进并给 next_step。\n",
    "示例 JSON（已完成）：{\"stopreason\":0,\"reason\":\"已完成并验证\",\"has_evidence\":1,\"evidence\":\"列出已验证的日志/测试/文件\",\"done_steps\":\"概述已完成动作\",\"next_step\":\"无\",\"needs_user_input\":0,\"learned\":\"补充本轮结论\"}\n",
    "示例 JSON（需继续）：{\"stopreason\":2,\"reason\":\"当前还不能收尾\",\"has_evidence\":1,\"evidence\":\"列出当前证据\",\"next_step\":\"写清楚下一步动作\",\"needs_user_input\":0}"
);

fn request_already_has_stopless_system_instruction(request: &Map<String, Value>) -> bool {
    request
        .get("instructions")
        .and_then(Value::as_str)
        .map(|content| {
            content.contains("stopreason 取值：0=finished，1=blocked，2=continue_needed")
        })
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

fn should_inject_stopless_system_instruction(metadata: &Map<String, Value>) -> bool {
    metadata
        .get("stopMessageEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || metadata
            .get("routecodexPortStopMessageEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

pub fn apply_req_process_tool_governance(
    input: ToolGovernanceInput,
) -> Result<ToolGovernanceOutput, String> {
    let start_time_ms = now_millis();

    let ctx = resolve_governance_context(&input.metadata, &input.entry_endpoint);

    let metadata = normalize_record(input.metadata);
    let request_metadata = Value::Object(metadata.clone());
    let mut request = normalize_record(input.request);
    apply_chat_process_request_sanitizer(&mut request);
    if should_inject_stopless_system_instruction(&metadata) {
        inject_stopless_system_instruction(&mut request);
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
        let name = function_name
            .or(direct_name)
            .unwrap_or("")
            .trim();
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
    use super::{apply_req_process_tool_governance, normalize_apply_patch_freeform_tool_schema, ToolGovernanceInput};
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
