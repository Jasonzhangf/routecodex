use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{json, Map, Value};
use std::collections::HashSet;

fn uniq_servers(discovered_servers: &[String]) -> Vec<String> {
    let mut seen = HashSet::<String>::new();
    let mut out = Vec::<String>::new();
    for server in discovered_servers {
        let trimmed = server.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        if seen.insert(trimmed.clone()) {
            out.push(trimmed);
        }
    }
    out
}

fn build_known_servers_line(discovered_servers: &[String]) -> String {
    if discovered_servers.is_empty() {
        return String::new();
    }
    let list = uniq_servers(discovered_servers);
    if list.is_empty() {
        return String::new();
    }
    let head = list.iter().take(8).cloned().collect::<Vec<String>>();
    let suffix = if list.len() > head.len() {
        format!(" (+{} more)", list.len() - head.len())
    } else {
        String::new()
    };
    format!("Known MCP servers: {}{}.", head.join(", "), suffix)
}

fn build_mcp_server_reminder() -> &'static str {
    "Note: arguments.server is an MCP server label (NOT a tool name like shell/exec_command/apply_patch)."
}

fn join_description(lines: Vec<String>) -> String {
    lines
        .into_iter()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<String>>()
        .join("\n")
}

fn build_list_resources_description(discovered_servers: &[String]) -> String {
    join_description(vec![
        "List resources exposed by MCP servers.".to_string(),
        "Only use this for MCP resources (not MCP tools). Many MCP servers expose tools only; if the result is empty, do not retry.".to_string(),
        "If you do not know the MCP server name yet, call this tool with {} once; then reuse the returned server names for subsequent calls.".to_string(),
        build_mcp_server_reminder().to_string(),
        build_known_servers_line(discovered_servers),
    ])
}

fn build_list_templates_description(discovered_servers: &[String]) -> String {
    join_description(vec![
        "List resource templates exposed by MCP servers.".to_string(),
        "Only use this for MCP resources (not MCP tools). If list_mcp_resources returns empty, do not retry.".to_string(),
        "If you do not know the MCP server name yet, call list_mcp_resources({}) once first.".to_string(),
        build_mcp_server_reminder().to_string(),
        build_known_servers_line(discovered_servers),
    ])
}

fn build_read_resource_description(discovered_servers: &[String]) -> String {
    join_description(vec![
        "Read a specific MCP resource by { server, uri }.".to_string(),
        "Only use this for MCP resources (not MCP tools). If list_mcp_resources returns empty, do not retry.".to_string(),
        "If you do not know the MCP server name yet, call list_mcp_resources({}) once first.".to_string(),
        build_mcp_server_reminder().to_string(),
        build_known_servers_line(discovered_servers),
    ])
}

fn obj_schema(props: Map<String, Value>, required: Option<Vec<&str>>) -> Value {
    let mut schema = Map::new();
    schema.insert("type".to_string(), Value::String("object".to_string()));
    schema.insert("properties".to_string(), Value::Object(props));
    schema.insert("additionalProperties".to_string(), Value::Bool(false));
    if let Some(req) = required {
        if !req.is_empty() {
            schema.insert(
                "required".to_string(),
                Value::Array(
                    req.into_iter()
                        .map(|v| Value::String(v.to_string()))
                        .collect(),
                ),
            );
        }
    }
    Value::Object(schema)
}

fn server_schema(discovered_servers: &[String], enforce_enum: bool) -> Value {
    let mut server = Map::new();
    server.insert("type".to_string(), Value::String("string".to_string()));
    if enforce_enum {
        let uniq = uniq_servers(discovered_servers);
        if !uniq.is_empty() {
            server.insert(
                "enum".to_string(),
                Value::Array(uniq.into_iter().map(Value::String).collect()),
            );
        }
    }
    server.insert("minLength".to_string(), Value::Number(1_i64.into()));
    Value::Object(server)
}

fn function_name(tool: &Value) -> Option<String> {
    tool.as_object()
        .and_then(|row| row.get("function"))
        .and_then(Value::as_object)
        .and_then(|fn_row| fn_row.get("name"))
        .and_then(Value::as_str)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn function_description(tool: &Value) -> Option<String> {
    tool.as_object()
        .and_then(|row| row.get("function"))
        .and_then(Value::as_object)
        .and_then(|fn_row| fn_row.get("description"))
        .and_then(Value::as_str)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn build_list_resources_tool(
    discovered_servers: &[String],
    description_override: Option<String>,
    enforce_server_enum: bool,
) -> Value {
    let mut props = Map::new();
    props.insert(
        "server".to_string(),
        server_schema(discovered_servers, enforce_server_enum),
    );
    props.insert("filter".to_string(), json!({"type":"string"}));
    props.insert("root".to_string(), json!({"type":"string"}));
    json!({
        "type": "function",
        "function": {
            "name": "list_mcp_resources",
            "description": description_override.unwrap_or_else(|| build_list_resources_description(discovered_servers)),
            "parameters": obj_schema(props, None)
        }
    })
}

fn build_list_templates_tool(
    discovered_servers: &[String],
    description_override: Option<String>,
    enforce_server_enum: bool,
) -> Value {
    let mut props = Map::new();
    props.insert(
        "server".to_string(),
        server_schema(discovered_servers, enforce_server_enum),
    );
    props.insert("cursor".to_string(), json!({"type":"string"}));
    json!({
        "type": "function",
        "function": {
            "name": "list_mcp_resource_templates",
            "description": description_override.unwrap_or_else(|| build_list_templates_description(discovered_servers)),
            "parameters": obj_schema(props, None)
        }
    })
}

fn build_read_resource_tool(
    discovered_servers: &[String],
    description_override: Option<String>,
) -> Value {
    let mut props = Map::new();
    props.insert(
        "server".to_string(),
        server_schema(discovered_servers, true),
    );
    props.insert("uri".to_string(), json!({"type":"string"}));
    json!({
        "type": "function",
        "function": {
            "name": "read_mcp_resource",
            "description": description_override.unwrap_or_else(|| build_read_resource_description(discovered_servers)),
            "parameters": obj_schema(props, Some(vec!["server", "uri"]))
        }
    })
}

pub(crate) fn inject_mcp_tools(tools: &Value, discovered_servers: &[String], mode: &str) -> Value {
    let current = tools.as_array().cloned().unwrap_or_default();
    let mut out = Vec::<Value>::new();
    let mut keep = HashSet::<String>::new();
    let has_servers = !uniq_servers(discovered_servers).is_empty();
    let is_chat = mode == "chat";
    let list_server_enum = is_chat && has_servers;
    let template_server_enum = has_servers;

    for tool in current {
        let name = match function_name(&tool) {
            Some(v) => v,
            None => {
                out.push(tool);
                continue;
            }
        };
        let lower = name.to_lowercase();
        if lower == "list_mcp_resources" {
            ensure_tool(
                &mut keep,
                &mut out,
                "list_mcp_resources",
                build_list_resources_tool(
                    discovered_servers,
                    function_description(&tool),
                    list_server_enum,
                ),
            );
            continue;
        }
        if lower == "list_mcp_resource_templates" {
            ensure_tool(
                &mut keep,
                &mut out,
                "list_mcp_resource_templates",
                build_list_templates_tool(
                    discovered_servers,
                    function_description(&tool),
                    template_server_enum,
                ),
            );
            continue;
        }
        if lower == "read_mcp_resource" {
            if has_servers {
                ensure_tool(
                    &mut keep,
                    &mut out,
                    "read_mcp_resource",
                    build_read_resource_tool(discovered_servers, function_description(&tool)),
                );
            }
            continue;
        }
        keep.insert(lower);
        out.push(tool);
    }

    if !keep.contains("list_mcp_resources") {
        ensure_tool(
            &mut keep,
            &mut out,
            "list_mcp_resources",
            build_list_resources_tool(discovered_servers, None, list_server_enum),
        );
    }
    if !keep.contains("list_mcp_resource_templates") {
        ensure_tool(
            &mut keep,
            &mut out,
            "list_mcp_resource_templates",
            build_list_templates_tool(discovered_servers, None, template_server_enum),
        );
    }

    Value::Array(out)
}

fn ensure_tool(keep: &mut HashSet<String>, out: &mut Vec<Value>, name: &str, tool: Value) {
    let key = name.to_lowercase();
    if keep.insert(key) {
        out.push(tool);
    }
}

#[napi_derive::napi]
pub fn inject_mcp_tools_for_chat_json(
    tools_json: String,
    discovered_servers_json: String,
) -> NapiResult<String> {
    let tools: Value =
        serde_json::from_str(&tools_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let discovered_servers: Vec<String> = serde_json::from_str(&discovered_servers_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = inject_mcp_tools(&tools, &discovered_servers, "chat");
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn inject_mcp_tools_for_responses_json(
    tools_json: String,
    discovered_servers_json: String,
) -> NapiResult<String> {
    let tools: Value =
        serde_json::from_str(&tools_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let discovered_servers: Vec<String> = serde_json::from_str(&discovered_servers_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = inject_mcp_tools(&tools, &discovered_servers, "responses");
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
