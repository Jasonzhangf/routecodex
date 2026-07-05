use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

// feature_id: responses.request_compat_normalization

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterContext {
    #[serde(default)]
    pub compatibility_profile: Option<String>,
    #[serde(default)]
    pub provider_protocol: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub entry_endpoint: Option<String>,
    #[serde(default)]
    pub route_id: Option<String>,
    #[serde(default, rename = "__rt")]
    pub rt: Option<Value>,
    #[serde(default)]
    pub captured_chat_request: Option<Value>,
    #[serde(default)]
    pub deepseek: Option<Value>,
    #[serde(default)]
    pub anthropic_thinking: Option<String>,
    #[serde(default)]
    pub estimated_input_tokens: Option<f64>,
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub client_model_id: Option<String>,
    #[serde(default)]
    pub original_model_id: Option<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub provider_key: Option<String>,
    #[serde(default)]
    pub runtime_key: Option<String>,
    #[serde(default)]
    pub client_request_id: Option<String>,
    #[serde(default)]
    pub group_request_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReqOutboundCompatInput {
    pub payload: Value,
    pub adapter_context: AdapterContext,
    #[serde(default)]
    pub explicit_profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatResult {
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_profile: Option<String>,
    pub native_applied: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeReqOutboundCompatAdapterContextBuilderInput {
    #[serde(default)]
    metadata_center_snapshot: Option<Value>,
}

pub(crate) mod gemini;
mod glm;
mod lmstudio;
mod profile;
mod request_stage;
mod response_stage;
pub(crate) mod responses;
mod shared_tool_text_guidance;
mod single_tool_call_history;
mod thinking_history;
mod tool_text_request_guidance;
pub(crate) mod universal_shape_filter;

pub use request_stage::run_req_outbound_stage3_compat;
pub use response_stage::run_resp_inbound_stage3_compat;

#[napi_derive::napi]
pub fn run_req_outbound_stage3_compat_json(input_json: String) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }

    let input: ReqOutboundCompatInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output = run_req_outbound_stage3_compat(input).map_err(napi::Error::from_reason)?;

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi_derive::napi]
pub fn run_resp_inbound_stage3_compat_json(input_json: String) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }

    let input: ReqOutboundCompatInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output = run_resp_inbound_stage3_compat(input).map_err(napi::Error::from_reason)?;

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

fn read_trimmed_string(source: Option<&Value>, key: &str) -> Option<String> {
    source
        .and_then(|value| value.as_object())
        .and_then(|row| row.get(key))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn read_object<'a>(source: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    source
        .and_then(|value| value.as_object())
        .and_then(|row| row.get(key))
        .filter(|value| value.is_object())
}

fn build_native_req_outbound_compat_adapter_context(
    metadata_center_snapshot: Option<&Value>,
) -> Result<AdapterContext, String> {
    let runtime_control = read_object(metadata_center_snapshot, "runtimeControl");
    let request_truth = read_object(metadata_center_snapshot, "requestTruth");
    let provider_observation = read_object(metadata_center_snapshot, "providerObservation");
    let target = read_object(provider_observation, "target");

    let provider_protocol = read_trimmed_string(runtime_control, "providerProtocol").ok_or_else(|| {
        "Native req outbound compat adapter context requires metadata center runtime_control.providerProtocol"
            .to_string()
    })?;

    Ok(AdapterContext {
        compatibility_profile: read_trimmed_string(provider_observation, "compatibilityProfile"),
        provider_protocol: Some(provider_protocol),
        request_id: read_trimmed_string(request_truth, "requestId"),
        entry_endpoint: read_trimmed_string(request_truth, "entryEndpoint"),
        route_id: read_trimmed_string(runtime_control, "routeId"),
        rt: None,
        captured_chat_request: None,
        deepseek: None,
        anthropic_thinking: None,
        estimated_input_tokens: None,
        model_id: read_trimmed_string(provider_observation, "assignedModelId")
            .or_else(|| read_trimmed_string(provider_observation, "modelId")),
        client_model_id: read_trimmed_string(provider_observation, "clientModelId"),
        original_model_id: None,
        provider_id: read_trimmed_string(target, "providerId")
            .or_else(|| read_trimmed_string(target, "id")),
        provider_key: read_trimmed_string(provider_observation, "providerKey"),
        runtime_key: None,
        client_request_id: read_trimmed_string(request_truth, "clientRequestId"),
        group_request_id: None,
        session_id: read_trimmed_string(request_truth, "sessionId"),
        conversation_id: read_trimmed_string(request_truth, "conversationId"),
    })
}

fn serialize_adapter_context_without_nulls(output: &AdapterContext) -> napi::Result<String> {
    let mut value = serde_json::to_value(output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize adapter context: {}", e))
    })?;
    if let Some(row) = value.as_object_mut() {
        row.retain(|_, value| !value.is_null());
    }
    serde_json::to_string(&value)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi_derive::napi(js_name = "buildNativeReqOutboundCompatAdapterContextJson")]
pub fn build_native_req_outbound_compat_adapter_context_json(
    input_json: String,
) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }

    let input: NativeReqOutboundCompatAdapterContextBuilderInput =
        serde_json::from_str(&input_json)
            .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output =
        build_native_req_outbound_compat_adapter_context(input.metadata_center_snapshot.as_ref())
            .map_err(napi::Error::from_reason)?;

    serialize_adapter_context_without_nulls(&output)
}

#[napi_derive::napi]
pub fn apply_claude_thinking_tool_schema_compat_json(payload_json: String) -> napi::Result<String> {
    if payload_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Payload JSON is empty"));
    }

    let payload: Value = serde_json::from_str(&payload_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse payload JSON: {}", e)))?;
    let output = gemini::apply_claude_thinking_tool_schema_compat(payload);

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi_derive::napi]
pub fn apply_tool_text_request_guidance_json(
    payload_json: String,
    config_json: Option<String>,
) -> napi::Result<String> {
    tool_text_request_guidance::apply_tool_text_request_guidance_json(payload_json, config_json)
}

pub fn build_system_tool_guidance_json() -> napi::Result<String> {
    let bullet = |value: &str| format!("- {}", value);
    let lines = vec![
        "Tool usage guidance (OpenAI tool_calls) / 工具使用指引（OpenAI 标准）".to_string(),
        bullet("Always use assistant.tool_calls[].function.{name,arguments}; never embed tool calls in plain text. / 一律通过 tool_calls 调用工具，不要把工具调用写进普通文本。"),
        bullet("function.arguments must be a single JSON string. / arguments 必须是单个 JSON 字符串。"),
        bullet("update_plan: Keep exactly one step in_progress; others pending/completed. / 仅一个 in_progress 步骤。"),
        bullet("view_image: Path must be an image file (.png .jpg .jpeg .gif .webp .bmp .svg). / 仅图片路径。"),
        bullet("Do NOT use view_image for text files (.md/.ts/.js/.json). Use shell: {\"command\":[\"cat\",\"<path>\"]}. / 文本文件请用 shell: cat。"),
    ];
    serde_json::to_string(&lines.join("\n"))
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize guidance: {}", e)))
}

fn append_once(desc: Option<&str>, guidance: &str, marker: &str) -> String {
    let base = desc.unwrap_or_default();
    if base.contains(marker) {
        return base.to_string();
    }
    if base.is_empty() {
        guidance.to_string()
    } else {
        format!("{}\n\n{}", base, guidance)
    }
}

fn ensure_object_schema(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = json!({});
    }
    let row = value.as_object_mut().expect("object initialized");
    if !matches!(row.get("type"), Some(Value::String(_))) {
        row.insert("type".to_string(), Value::String("object".to_string()));
    }
    if !matches!(row.get("properties"), Some(Value::Object(_))) {
        row.insert("properties".to_string(), json!({}));
    }
    if !matches!(row.get("additionalProperties"), Some(Value::Bool(_))) {
        row.insert("additionalProperties".to_string(), Value::Bool(true));
    }
    row
}

fn set_description(target: &mut Map<String, Value>, guidance: &str, marker: &str) {
    let desc = target.get("description").and_then(Value::as_str);
    target.insert(
        "description".to_string(),
        Value::String(append_once(desc, guidance, marker)),
    );
}

fn augment_exec_command(target: &mut Map<String, Value>) {
    let marker = "[Codex ExecCommand Guidance]";
    let guidance = [
        marker,
        "Use exec_command only for shell execution.",
        "Keep shell intent inside exec_command arguments; do not mix shell planning prose into tool arguments.",
        "When shell features are needed, prefer a single `bash -lc` command string.",
    ]
    .join("\n");
    set_description(target, &guidance, marker);
}

fn augment_shell_openai(function: &mut Map<String, Value>) {
    let marker = "[Codex Shell Guidance]";
    let guidance = [
        marker,
        "Execute shell commands. Two accepted forms:",
        "  1) argv tokens: [\"ls\",\"-la\"]",
        "  2) bash -lc with a single string: [\"bash\",\"-lc\",\"<single command string>\"] (required for complex/multi-line/pipe/&&/||/here-doc to interpreter).",
        "The 3rd arg of bash -lc MUST be exactly one string. Do not split meta-operators (|, >, &&, ||) into separate elements.",
        "Do not invent extra keys.",
        "Examples: [\"ls\",\"-la\",\"Obsidian\"]; [\"bash\",\"-lc\",\"cd Obsidian && ls -la\"]; [\"bash\",\"-lc\",\"python3 - <<'PY'\\nprint(\\\"ok\\\")\\nPY\"]",
        "If arguments are invalid (e.g., bash -lc without a single string), return a structured error as the tool result (role=tool, same tool_call_id) and continue the conversation.",
        "Prefer ripgrep (rg) when available. Keep explanations in assistant text; do not mix narration into tool arguments.",
    ]
    .join("\n");

    let params = function.entry("parameters").or_insert_with(|| json!({}));
    let params_row = ensure_object_schema(params);
    let props = params_row
        .entry("properties".to_string())
        .or_insert_with(|| json!({}));
    let props_row = props.as_object_mut().expect("properties initialized");
    props_row.insert(
        "command".to_string(),
        json!({
            "description": "Shell command. Use argv tokens OR [\"bash\",\"-lc\",\"<single command string>\"] for complex commands.",
            "oneOf": [
                {
                    "type": "array",
                    "minItems": 3,
                    "maxItems": 3,
                    "items": [
                        { "const": "bash" },
                        { "const": "-lc" },
                        { "type": "string" }
                    ]
                },
                {
                    "type": "array",
                    "items": { "type": "string" }
                }
            ]
        }),
    );
    params_row.insert("additionalProperties".to_string(), Value::Bool(false));
    set_description(function, &guidance, marker);
}

fn augment_update_plan(target: &mut Map<String, Value>, anthropic: bool) {
    let marker = "[Codex Plan Guidance]";
    let guidance = if anthropic {
        [marker, "Maintain a short plan; one in_progress step only."].join("\n")
    } else {
        [
            marker,
            "Maintain a short stepwise plan. Exactly one step should be in_progress; others pending/completed.",
        ]
        .join("\n")
    };
    set_description(target, &guidance, marker);
}

fn augment_view_image_openai(function: &mut Map<String, Value>) {
    let marker = "[Codex ViewImage Guidance]";
    let guidance = [
        marker,
        "Attach a local image only. Path must point to an existing image file (.png .jpg .jpeg .gif .webp .bmp .svg .tif .tiff .ico .heic .jxl).",
        "Never use view_image to read text documents (e.g., .md/.ts/.js/.json). For text content, use shell: {\"command\":[\"cat\",\"<path>\"]}.",
    ]
    .join("\n");
    let params = function.entry("parameters").or_insert_with(|| json!({}));
    let params_row = ensure_object_schema(params);
    let props = params_row
        .entry("properties".to_string())
        .or_insert_with(|| json!({}));
    let props_row = props.as_object_mut().expect("properties initialized");
    if !matches!(props_row.get("path"), Some(Value::Object(_))) {
        props_row.insert(
            "path".to_string(),
            json!({ "type": "string", "description": "Local filesystem path to an image file" }),
        );
    }
    params_row.insert("additionalProperties".to_string(), Value::Bool(false));
    set_description(function, &guidance, marker);
}

fn augment_mcp_openai(target: &mut Map<String, Value>, tool_name: &str) {
    let marker = format!("[Codex MCP Guidance:{}]", tool_name);
    let guidance = [
        marker.as_str(),
        "Use MCP resources sparingly. Provide only required fields; avoid unnecessary large reads.",
        "Do not call MCP resource tools unless you actually need MCP resources (not MCP tools).",
        "If list_mcp_resources returns an empty list or a \"Method not found\" error (-32601), do not retry; assume no MCP resources are available in this session.",
        "If you need MCP resources but do not know the MCP server label, call list_mcp_resources({}) once and reuse the returned server labels.",
        "Note: arguments.server is an MCP server label (NOT a tool name like shell/exec_command/apply_patch).",
    ]
    .join("\n");
    set_description(target, &guidance, &marker);
}

fn augment_anthropic_schema(tool: &mut Map<String, Value>) {
    let schema = tool.entry("input_schema").or_insert_with(|| json!({}));
    ensure_object_schema(schema);
}

pub fn augment_openai_tools_json(tools_json: String) -> napi::Result<String> {
    let mut tools: Value = serde_json::from_str(&tools_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse tools JSON: {}", e)))?;
    let Some(items) = tools.as_array_mut() else {
        return serde_json::to_string(&tools)
            .map_err(|e| napi::Error::from_reason(format!("Failed to serialize tools: {}", e)));
    };

    for item in items {
        let Some(item_row) = item.as_object_mut() else {
            continue;
        };
        let Some(function) = item_row.get_mut("function").and_then(Value::as_object_mut) else {
            continue;
        };
        let Some(name) = function
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
        else {
            continue;
        };
        match name.as_str() {
            "shell" => augment_shell_openai(function),
            "exec_command" => augment_exec_command(function),
            "apply_patch" => {}
            "update_plan" => augment_update_plan(function, false),
            "view_image" => augment_view_image_openai(function),
            "list_mcp_resources" | "read_mcp_resource" | "list_mcp_resource_templates" => {
                augment_mcp_openai(function, &name)
            }
            _ => {}
        }
    }

    serde_json::to_string(&tools)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize tools: {}", e)))
}

pub fn augment_anthropic_tools_json(tools_json: String) -> napi::Result<String> {
    let mut tools: Value = serde_json::from_str(&tools_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse tools JSON: {}", e)))?;
    let Some(items) = tools.as_array_mut() else {
        return serde_json::to_string(&tools)
            .map_err(|e| napi::Error::from_reason(format!("Failed to serialize tools: {}", e)));
    };

    for item in items {
        let Some(tool) = item.as_object_mut() else {
            continue;
        };
        augment_anthropic_schema(tool);
        let Some(name) = tool
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
        else {
            continue;
        };
        match name.as_str() {
            "exec_command" => augment_exec_command(tool),
            "shell" => {
                let marker = "[Codex Shell Guidance]";
                let guidance = [
                    marker,
                    "Execute commands via argv tokens only (no redirection).",
                ]
                .join("\n");
                set_description(tool, &guidance, marker);
            }
            "update_plan" => augment_update_plan(tool, true),
            "view_image"
            | "list_mcp_resources"
            | "read_mcp_resource"
            | "list_mcp_resource_templates" => {
                let marker = format!("[Codex MCP Guidance:{}]", name);
                let guidance = [
                    marker.as_str(),
                    "Use minimally; avoid unnecessary large reads.",
                ]
                .join("\n");
                set_description(tool, &guidance, &marker);
            }
            _ => {}
        }
    }

    serde_json::to_string(&tools)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize tools: {}", e)))
}

#[cfg(test)]
mod tests;
