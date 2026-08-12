use serde_json::{Map, Value};

use routecodex_v3_config::V3WebSearchExecutionMode;

use super::is_v3_gpt_canonical_model;

#[cfg(test)]
pub(super) fn project_openai_chat_provider_tools(payload: &mut Value) -> Result<(), String> {
    project_openai_chat_provider_tools_for_web_search_mode(
        payload,
        None,
        V3WebSearchExecutionMode::NativeRemoteSearchToolMix,
        true,
    )
}

pub(super) fn project_openai_chat_provider_tools_for_web_search_mode(
    payload: &mut Value,
    model_id: Option<&str>,
    web_search_execution_mode: V3WebSearchExecutionMode,
    has_web_search_capability: bool,
) -> Result<(), String> {
    let Some(root) = payload.as_object_mut() else {
        return Ok(());
    };
    let Some(tools) = root.remove("tools") else {
        return Ok(());
    };
    let tools = tools.as_array().ok_or_else(|| {
        "MalformedOutboundField target_protocol=openai_chat path=$.tools".to_string()
    })?;
    // gpt 家族模型保留标准 hosted web_search 语义（openai 官方支持）；其余
    // 所有模型统一替换为内部 websearch 工具（RouteCodex 本地搜索 hop 执行，
    // 不区分 provider、不依赖 provider 原生搜索能力）。家族判定真源在 compat
    // 层（is_v3_gpt_canonical_model 委托 config 家族判定），本节点只消费结果。
    let is_gpt_model = model_id.is_some_and(is_v3_gpt_canonical_model);
    let mut normalized_tools = Vec::new();
    let mut web_search_options = Map::new();
    let mut has_web_search = false;
    for (index, tool) in tools.iter().enumerate() {
        let tool_type = tool.get("type").and_then(Value::as_str);
        if matches!(tool_type, Some("web_search" | "web_search_preview")) {
            if web_search_execution_mode == V3WebSearchExecutionMode::NativeRemoteSearchToolMix {
                has_web_search = true;
                merge_openai_chat_web_search_options(
                    &mut web_search_options,
                    tool,
                    &format!("$.tools[{index}]"),
                )?;
            } else if web_search_execution_mode.is_metadata_center_local_search() || !is_gpt_model {
                // Mode B（显式内部路由，如 MiniMax 走标准 web search 内部路由）
                // 或非 gpt 模型：标准 web_search 声明投影为本地 websearch
                // function tool（单一工具名 websearch，供 Resp03 同轮拦截本地执行）。
                normalized_tools.push(build_local_web_search_function_tool(
                    tool,
                    index,
                    "websearch",
                )?);
            } else if has_web_search_capability {
                // gpt 模型 + provider 具备 web_search 能力：保持既有 hosted
                // web_search_options 投影（与 HEAD 行为一致）。
                has_web_search = true;
                merge_openai_chat_web_search_options(
                    &mut web_search_options,
                    tool,
                    &format!("$.tools[{index}]"),
                )?;
            }
            // gpt 模型 + provider 无 web_search 能力：web_search 工具声明与
            // web_search_options 完全移除（无能力 provider 不收到搜索工具，
            // 避免未知字段/误调用）。
        } else {
            normalized_tools.push(normalize_openai_chat_provider_tool(tool, index)?);
        }
    }
    if !normalized_tools.is_empty() {
        root.insert("tools".to_string(), Value::Array(normalized_tools));
    }
    if has_web_search {
        let projected = Value::Object(web_search_options);
        if root
            .get("web_search_options")
            .is_some_and(|existing| existing != &projected)
        {
            return Err("ConflictingOutboundFields target_protocol=openai_chat paths=$.web_search_options,$.tools[].type".to_string());
        }
        root.insert("web_search_options".to_string(), projected);
    }
    Ok(())
}

fn build_local_web_search_function_tool(
    tool: &Value,
    index: usize,
    local_tool_name: &str,
) -> Result<Value, String> {
    let path = format!("$.tools[{index}]");
    let row = tool
        .as_object()
        .ok_or_else(|| format!("MalformedOutboundField target_protocol=openai_chat path={path}"))?;
    for key in row.keys() {
        if !matches!(
            key.as_str(),
            "type"
                | "search_context_size"
                | "user_location"
                | "external_web_access"
                | "search_content_types"
        ) {
            return Err(format!(
                "UnmappedOutboundFields target_protocol=openai_chat paths={path}.{key}"
            ));
        }
    }
    let content_types = row
        .get("search_content_types")
        .cloned()
        .unwrap_or_else(|| Value::Array(vec![Value::String("text".to_string())]));
    if !content_types
        .as_array()
        .is_some_and(|values| !values.is_empty() && values.iter().all(Value::is_string))
    {
        return Err(format!(
            "MalformedOutboundField target_protocol=openai_chat path={path}.search_content_types"
        ));
    }
    let mut properties = Map::new();
    properties.insert(
        "query".to_string(),
        serde_json::json!({
            "type":"string",
            "description":"The search query. Construct a concise query with the key terms for the information the user needs."
        }),
    );
    properties.insert(
        "search_content_types".to_string(),
        serde_json::json!({
            "type":"array",
            "items":{"type":"string","enum":content_types},
            "default":content_types
        }),
    );
    if let Some(value) = row.get("search_context_size") {
        properties.insert(
            "search_context_size".to_string(),
            serde_json::json!({"type":"string","default":value}),
        );
    }
    if let Some(value) = row.get("user_location") {
        properties.insert(
            "user_location".to_string(),
            serde_json::json!({"type":"object","default":value}),
        );
    }
    normalize_openai_chat_function_tool(
        &Map::from_iter([
            ("type".to_string(), Value::String("function".to_string())),
            (
                "name".to_string(),
                Value::String(local_tool_name.to_string()),
            ),
            (
                "description".to_string(),
                Value::String("Search the web for up-to-date information.".to_string()),
            ),
            (
                "parameters".to_string(),
                Value::Object(Map::from_iter([
                    ("type".to_string(), Value::String("object".to_string())),
                    ("properties".to_string(), Value::Object(properties)),
                    (
                        "required".to_string(),
                        Value::Array(vec![Value::String("query".to_string())]),
                    ),
                    ("additionalProperties".to_string(), Value::Bool(false)),
                ])),
            ),
        ]),
        &path,
    )
}

fn merge_openai_chat_web_search_options(
    output: &mut Map<String, Value>,
    tool: &Value,
    path: &str,
) -> Result<(), String> {
    let row = tool
        .as_object()
        .ok_or_else(|| format!("MalformedOutboundField target_protocol=openai_chat path={path}"))?;
    for key in row.keys() {
        if !matches!(
            key.as_str(),
            "type"
                | "search_context_size"
                | "user_location"
                | "external_web_access"
                | "search_content_types"
        ) {
            return Err(format!(
                "UnmappedOutboundFields target_protocol=openai_chat paths={path}.{key}"
            ));
        }
    }
    if row
        .get("external_web_access")
        .is_some_and(|value| value != true)
    {
        return Err(format!(
            "UnmappedOutboundFields target_protocol=openai_chat paths={path}.external_web_access"
        ));
    }
    if let Some(search_content_types) = row.get("search_content_types") {
        let values = search_content_types.as_array().ok_or_else(|| {
            format!(
                "MalformedOutboundField target_protocol=openai_chat path={path}.search_content_types"
            )
        })?;
        if values.as_slice() != [Value::String("text".to_string())] {
            return Err(format!(
                "UnmappedOutboundFields target_protocol=openai_chat paths={path}.search_content_types"
            ));
        }
    }
    for key in ["search_context_size", "user_location"] {
        let Some(value) = row.get(key) else {
            continue;
        };
        if output.get(key).is_some_and(|existing| existing != value) {
            return Err(format!(
                "ConflictingOutboundFields target_protocol=openai_chat paths={path}.{key}"
            ));
        }
        output.insert(key.to_string(), value.clone());
    }
    Ok(())
}

pub(super) fn normalize_openai_chat_provider_tool(
    tool: &Value,
    index: usize,
) -> Result<Value, String> {
    let Some(row) = tool.as_object() else {
        return Ok(tool.clone());
    };
    let path = format!("$.tools[{index}]");
    match row.get("type").and_then(Value::as_str) {
        Some("function") => normalize_openai_chat_function_tool(row, &path),
        Some("tool_search") => normalize_openai_chat_tool_search(row, &path),
        Some("custom") => normalize_openai_chat_custom_tool(row, &path),
        _ => Ok(tool.clone()),
    }
}

fn normalize_openai_chat_custom_tool(
    row: &Map<String, Value>,
    path: &str,
) -> Result<Value, String> {
    // OpenAI Chat completions wire 只定义 function 工具（custom 是 Responses
    // 协议形状，opencode-go 等上游以 `unknown variant 'custom'` 拒绝）。
    // custom -> function 扁平化：name/description 保留，parameters 用
    // `{"type":"object"}`（go 要求 parameters 必须是 type:object 的 JSON
    // Schema，空对象会被拒）；format（grammar）是 Responses/扩展形状，chat
    // wire 无法表达，按协议收窄丢弃（ds4 源码无 grammar 引擎，等价透传）。
    for key in row.keys() {
        if !matches!(key.as_str(), "type" | "name" | "description" | "format") {
            return Err(format!(
                "UnmappedOutboundFields target_protocol=openai_chat paths={path}.{key}"
            ));
        }
    }
    let name = row
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!("MalformedOutboundField target_protocol=openai_chat path={path}.name")
        })?;
    let mut function = Map::from_iter([
        ("name".to_string(), Value::String(name.to_string())),
        ("parameters".to_string(), serde_json::json!({"type":"object"})),
    ]);
    if let Some(description) = row.get("description") {
        if !description.is_string() {
            return Err(format!(
                "MalformedOutboundField target_protocol=openai_chat path={path}.description"
            ));
        }
        function.insert("description".to_string(), description.clone());
    }
    Ok(Value::Object(Map::from_iter([
        ("type".to_string(), Value::String("function".to_string())),
        ("function".to_string(), Value::Object(function)),
    ])))
}

fn normalize_openai_chat_tool_search(
    row: &Map<String, Value>,
    path: &str,
) -> Result<Value, String> {
    for key in row.keys() {
        if !matches!(
            key.as_str(),
            "type" | "execution" | "description" | "parameters"
        ) {
            return Err(format!(
                "UnmappedOutboundFields target_protocol=openai_chat paths={path}.{key}"
            ));
        }
    }
    if row
        .get("execution")
        .is_some_and(|value| value.as_str() != Some("client"))
    {
        return Err(format!(
            "UnmappedOutboundFields target_protocol=openai_chat paths={path}.execution"
        ));
    }
    let mut function_row = Map::new();
    function_row.insert("type".to_string(), Value::String("function".to_string()));
    function_row.insert("name".to_string(), Value::String("tool_search".to_string()));
    for key in ["description", "parameters"] {
        if let Some(value) = row.get(key) {
            function_row.insert(key.to_string(), value.clone());
        }
    }
    normalize_openai_chat_function_tool(&function_row, path)
}

fn normalize_openai_chat_function_tool(
    row: &Map<String, Value>,
    path: &str,
) -> Result<Value, String> {
    if row.get("function").and_then(Value::as_object).is_some() {
        let normalized = row.clone();
        return Ok(Value::Object(normalized));
    }
    let mut function = Map::new();
    for key in ["name", "description", "parameters", "strict"] {
        if let Some(value) = row.get(key) {
            function.insert(key.to_string(), value.clone());
        }
    }
    Ok(Value::Object(Map::from_iter([
        ("type".to_string(), Value::String("function".to_string())),
        ("function".to_string(), Value::Object(function)),
    ])))
}
