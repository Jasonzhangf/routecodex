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
#[cfg(test)]
use crate::req_process_stage1_tool_governance_blocks::servertool_injection::resolve_tool_name;
use crate::req_process_stage1_tool_governance_blocks::servertool_injection::{
    maybe_apply_servertool_orchestration, read_runtime_metadata, resolve_client_inject_ready,
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

pub fn apply_req_process_tool_governance(
    input: ToolGovernanceInput,
) -> Result<ToolGovernanceOutput, String> {
    let start_time_ms = now_millis();

    let ctx = resolve_governance_context(&input.metadata, &input.entry_endpoint);

    let metadata = normalize_record(input.metadata);
    let request_metadata = Value::Object(metadata.clone());
    let mut request = normalize_record(input.request);
    let runtime_metadata = read_runtime_metadata(&metadata);
    let client_inject_ready = resolve_client_inject_ready(&metadata);
    apply_chat_process_request_sanitizer(&mut request);
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
    let Some(tools) = request.get_mut("tools").and_then(Value::as_array_mut) else {
        return;
    };
    for tool in tools {
        let Some(tool_obj) = tool.as_object_mut() else {
            continue;
        };
        let function_obj =
            if let Some(function) = tool_obj.get_mut("function").and_then(Value::as_object_mut) {
                function
            } else {
                tool_obj
            };
        let name = function_obj
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if name != "apply_patch" {
            continue;
        }
        function_obj.insert(
            "description".to_string(),
            Value::String(
                "Apply a file patch using canonical *** Begin Patch / *** End Patch grammar. Paths in patch headers must be workspace-relative, for example *** Add File: tmp/example.txt or *** Update File: src/main.ts. Send exactly one patch string in this tool call for file edits.".to_string(),
            ),
        );
        function_obj.insert(
            "parameters".to_string(),
            serde_json::json!({
                "type": "object",
                "properties": {
                    "patch": {
                        "type": "string",
                        "description": "One raw patch string using *** Begin Patch / *** End Patch grammar with workspace-relative file headers."
                    }
                },
                "required": ["patch"],
                "additionalProperties": false
            }),
        );
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
