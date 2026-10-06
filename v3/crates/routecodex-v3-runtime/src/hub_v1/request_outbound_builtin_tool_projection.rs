use provider_compat_core::namespace_tools::{
    flatten_namespace_tool_for_provider_with_sources, openai_chat_freeform_custom_tool_parameters,
    provider_function_tool_name, push_unique_provider_function_tool,
    replace_provider_function_tool, validate_namespace_tool_dispatch_names,
};
use serde_json::{Map, Value};
use std::collections::{BTreeSet, HashMap};

use routecodex_v3_config::V3WebSearchExecutionMode;

use super::is_v3_gpt_canonical_model;
use super::request_outbound_declaration_emission::StandardOutboundDeclarationObserver;
use super::request_outbound_mcp_names::provider_function_name;
use crate::projection_drop_log::{V3ProjectionDropContext, V3ProjectionDropRecord};

pub(crate) fn project_openai_responses_hosted_web_search_for_selected_target(
    payload: &mut Value,
    has_web_search_capability: bool,
) {
    project_openai_responses_hosted_web_search_tools_for_selected_target(
        payload,
        has_web_search_capability,
    );
    project_openai_responses_hosted_web_search_options_for_selected_target(
        payload,
        has_web_search_capability,
    );
}

fn project_openai_responses_hosted_web_search_tools_for_selected_target(
    payload: &mut Value,
    has_web_search_capability: bool,
) {
    if has_web_search_capability {
        return;
    }
    if let Some(tools) = payload.get_mut("tools").and_then(Value::as_array_mut) {
        tools.retain(|tool| !is_openai_responses_hosted_web_search_tool(tool));
    }
}

pub(super) fn project_openai_responses_hosted_web_search_options_for_selected_target(
    payload: &mut Value,
    has_web_search_capability: bool,
) {
    if has_web_search_capability {
        return;
    }
    if let Some(root) = payload.as_object_mut() {
        root.remove("web_search_options");
        if root
            .get("tool_choice")
            .is_some_and(is_hosted_web_search_choice)
        {
            root.remove("tool_choice");
        }
    }
}

pub(super) fn is_openai_responses_hosted_web_search_tool(tool: &Value) -> bool {
    matches!(
        tool.get("type").and_then(Value::as_str),
        Some("web_search" | "web_search_preview" | "web_search_20250305")
    )
}

fn is_hosted_web_search_choice(choice: &Value) -> bool {
    matches!(
        choice
            .get("type")
            .and_then(Value::as_str)
            .or_else(|| choice.as_str()),
        Some("web_search" | "web_search_preview" | "web_search_20250305")
    )
}

pub(super) fn promote_tool_search_output_tools_to_provider_tools(
    payload: &mut Value,
) -> Result<(), String> {
    let mut discovered = Vec::new();
    if let Some(messages) = payload.get("messages").and_then(Value::as_array) {
        for (index, message) in messages.iter().enumerate() {
            let Some(row) = message.as_object() else {
                continue;
            };
            let output_type = row
                .get("routecodex_chat_extension")
                .and_then(Value::as_object)
                .and_then(|extension| extension.get("responses_tool_output_type"))
                .and_then(Value::as_str);
            if row.get("role").and_then(Value::as_str) != Some("tool")
                || output_type != Some("tool_search_output")
            {
                continue;
            }
            let content = row.get("content").ok_or_else(|| {
                format!(
                    "MalformedOutboundField target_protocol=provider path=$.messages[{index}].content"
                )
            })?;
            let tools = match content {
                Value::String(text) => serde_json::from_str::<Value>(text).map_err(|error| {
                    format!(
                        "MalformedOutboundField target_protocol=provider path=$.messages[{index}].content: {error}"
                    )
                })?,
                value => value.clone(),
            };
            let tools = tools.as_array().ok_or_else(|| {
                format!(
                    "MalformedOutboundField target_protocol=provider path=$.messages[{index}].content"
                )
            })?;
            discovered.extend(tools.iter().cloned());
        }
    } else if let Some(input) = payload.get("input").and_then(Value::as_array) {
        for (index, item) in input.iter().enumerate() {
            if item.get("type").and_then(Value::as_str) != Some("tool_search_output") {
                continue;
            }
            let tools = item.get("tools").and_then(Value::as_array).ok_or_else(|| {
                format!(
                    "MalformedOutboundField target_protocol=responses path=$.input[{index}].tools"
                )
            })?;
            discovered.extend(tools.iter().cloned());
        }
    }
    if discovered.is_empty() {
        return Ok(());
    }
    let top_level = payload.as_object_mut().ok_or_else(|| {
        "MalformedOutboundField target_protocol=provider path=$: expected object".to_string()
    })?;
    let tools = top_level
        .entry("tools".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    let tools = tools.as_array_mut().ok_or_else(|| {
        "MalformedOutboundField target_protocol=provider path=$.tools: expected array".to_string()
    })?;
    for tool in discovered {
        if !tools.iter().any(|existing| existing == &tool) {
            tools.push(tool);
        }
    }
    Ok(())
}

/// Structural declaration sources consumed by the standard declaration
/// producer. History keeps its declaration domain; only actual provider
/// emission creates a target declaration and records this source address.
pub(super) fn provider_tool_declaration_sources(
    payload: &Value,
) -> Result<Vec<(String, Value)>, String> {
    let mut sources = Vec::new();
    if let Some(tools) = payload.get("tools").and_then(Value::as_array) {
        sources.extend(
            tools
                .iter()
                .enumerate()
                .map(|(index, tool)| (format!("chat.tools[{index}]"), tool.clone())),
        );
    }
    if let Some(messages) = payload.get("messages").and_then(Value::as_array) {
        for (message_index, message) in messages.iter().enumerate() {
            if !matches!(
                message.get("type").and_then(Value::as_str),
                Some("tool_search_output" | "additional_tools")
            ) {
                if message
                    .pointer("/routecodex_chat_extension/responses_tool_output_type")
                    .and_then(Value::as_str)
                    == Some("tool_search_output")
                {
                    if let Some(content) = message.get("content") {
                        let declarations = match content {
                            Value::String(text) => serde_json::from_str::<Value>(text)
                                .map_err(|error| format!("tool declaration source chat.messages[{message_index}].content: {error}"))?,
                            value => value.clone(),
                        };
                        if let Some(tools) = declarations.as_array() {
                            sources.extend(tools.iter().enumerate().map(|(index, tool)| {
                                (
                                    format!("chat.messages[{message_index}].content[{index}]"),
                                    tool.clone(),
                                )
                            }));
                        }
                    }
                }
                continue;
            }
            if let Some(tools) = message.get("tools").and_then(Value::as_array) {
                sources.extend(tools.iter().enumerate().map(|(index, tool)| {
                    (
                        format!("chat.messages[{message_index}].tools[{index}]"),
                        tool.clone(),
                    )
                }));
            }
        }
    }
    Ok(sources)
}

#[cfg(test)]
pub(super) fn project_openai_chat_provider_tools(payload: &mut Value) -> Result<(), String> {
    project_openai_chat_provider_tools_for_web_search_mode(
        payload,
        None,
        V3WebSearchExecutionMode::NativeRemoteSearchToolMix,
        true,
        None,
    )
}

pub(super) fn project_openai_chat_provider_tools_for_web_search_mode(
    payload: &mut Value,
    model_id: Option<&str>,
    web_search_execution_mode: V3WebSearchExecutionMode,
    has_web_search_capability: bool,
    mut observer: Option<&mut StandardOutboundDeclarationObserver<'_>>,
) -> Result<(), String> {
    let mut drops = Vec::new();
    let sources = provider_tool_declaration_sources(payload)?;
    project_openai_chat_provider_tools_for_web_search_mode_recording(
        payload,
        model_id,
        web_search_execution_mode,
        has_web_search_capability,
        &V3ProjectionDropContext::disabled(),
        &mut drops,
        observer.as_mut().map(|observer| &mut **observer),
        &sources,
    )
}

/// stage-3 openai_chat provider tools 投影：非数组 `tools` 不再 hard error，
/// 而是 DROP（`root.remove` 已移除）+ RECORD + PRINT 后继续请求。
#[allow(clippy::too_many_arguments)]
pub(super) fn project_openai_chat_provider_tools_for_web_search_mode_recording(
    payload: &mut Value,
    model_id: Option<&str>,
    web_search_execution_mode: V3WebSearchExecutionMode,
    has_web_search_capability: bool,
    drop_context: &V3ProjectionDropContext,
    drops: &mut Vec<V3ProjectionDropRecord>,
    mut observer: Option<&mut StandardOutboundDeclarationObserver<'_>>,
    sources: &[(String, Value)],
) -> Result<(), String> {
    let refreshed_provider_tool_names = validate_namespace_tool_dispatch_names(payload)?;
    // The provider declaration traversal below is the single place that chooses
    // the emitted namespace wire name. Resolve the collision-free alias here so
    // the wire declaration, the recorded attempt mapping, and the history/forced
    // choice rewrite all name the same tool.
    let namespace_wire_aliases = {
        let declarations: Vec<Value> = sources.iter().map(|(_, tool)| tool.clone()).collect();
        super::request_outbound_mcp_names::openai_chat_namespace_wire_aliases(&serde_json::json!({
            "tools": declarations,
        }))?
    };
    let Some(root) = payload.as_object_mut() else {
        return Ok(());
    };
    // 客户端可能发送非数组 `tools`（例如字符串/对象）。openai_chat wire 的
    // tools 必须是声明数组，非数组不携带任何可转换的工具声明语义；stage 1/2
    // 对 tools 无损，因此这里证明是客户端原始形态。没有兼容表示 → 丢弃并继续，
    // 不再让客户端收到 598 provider_request_payload_invalid。
    if let Some(tools) = root.remove("tools") {
        if !tools.is_array() {
            drops.push(V3ProjectionDropRecord::new(
                "openai_chat",
                "$.tools",
                "non_array_tools_unrepresentable",
                tools,
                "project_openai_chat_provider_tools_for_web_search_mode",
            ));
        }
    }
    // gpt 家族模型保留标准 hosted web_search 语义（openai 官方支持）；其余
    // 所有模型统一替换为内部 websearch 工具（RouteCodex 本地搜索 hop 执行，
    // 不区分 provider、不依赖 provider 原生搜索能力）。家族判定真源在 compat
    // 层（is_v3_gpt_canonical_model 委托 config 家族判定），本节点只消费结果。
    let is_gpt_model = model_id.is_some_and(is_v3_gpt_canonical_model);
    let mut normalized_tools = Vec::new();
    let mut normalized_tool_indexes = HashMap::<String, usize>::new();
    let mut web_search_options = Map::new();
    let mut has_web_search = false;
    for (index, (canonical_source_path, tool)) in sources.iter().enumerate() {
        let tool_type = tool.get("type").and_then(Value::as_str);
        if tool_type == Some("namespace") {
            let projection = flatten_namespace_tool_for_provider_with_sources("openai-chat", tool)
                .map_err(|error| format!("$.tools[{index}]: {error}"))?
                .ok_or_else(|| format!("$.tools[{index}]: namespace tool was not flattened"))?;
            for (emission, flattened) in projection.sources.iter().zip(projection.tools) {
                let flattened = apply_namespace_wire_alias(flattened, &namespace_wire_aliases);
                let source_path = namespace_child_canonical_path(
                    canonical_source_path,
                    &emission.source_child_indices,
                );
                push_provider_tool_with_emission(
                    &mut normalized_tools,
                    &mut normalized_tool_indexes,
                    flattened,
                    "openai_chat",
                    &refreshed_provider_tool_names,
                    observer.as_mut().map(|observer| &mut **observer),
                    &source_path,
                )?;
            }
            continue;
        }
        if matches!(
            tool_type,
            Some("web_search" | "web_search_preview" | "web_search_20250305")
        ) {
            if web_search_execution_mode == V3WebSearchExecutionMode::NativeRemoteSearchToolMix {
                // Mode A 与 Mode B 共用同一 capability 护栏：provider 未声明
                // web_search 能力时不保留 hosted web_search 声明（工具与
                // web_search_options 一并移除），避免无能力 provider 收到
                // 未知字段或误调用。
                if has_web_search_capability {
                    has_web_search = true;
                    merge_openai_chat_web_search_options(
                        &mut web_search_options,
                        tool,
                        &format!("$.tools[{index}]"),
                    )?;
                }
            } else if has_web_search_capability
                && (web_search_execution_mode.is_metadata_center_local_search() || !is_gpt_model)
            {
                // Mode B（显式内部路由，如 MiniMax 走标准 web search 内部路由）
                // 或非 gpt 模型：标准 web_search 声明投影为本地 websearch
                // function tool（单一工具名 websearch，供 Resp03 同轮拦截本地执行）。
                let local = build_local_web_search_function_tool(tool, index, "websearch")?;
                let source_path = format!("chat.tools[{index}]");
                push_provider_tool_with_emission(
                    &mut normalized_tools,
                    &mut normalized_tool_indexes,
                    local,
                    "openai_chat",
                    &refreshed_provider_tool_names,
                    observer.as_mut().map(|observer| &mut **observer),
                    &source_path,
                )?;
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
            let normalized = normalize_openai_chat_provider_tool(tool, index)?;
            push_provider_tool_with_emission(
                &mut normalized_tools,
                &mut normalized_tool_indexes,
                normalized,
                "openai_chat",
                &refreshed_provider_tool_names,
                observer.as_mut().map(|observer| &mut **observer),
                canonical_source_path,
            )?;
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
    } else if !has_web_search_capability
        && root
            .get("tool_choice")
            .is_some_and(is_hosted_web_search_choice)
    {
        root.remove("tool_choice");
    }
    Ok(())
}

/// Push one provider declaration and, when an observer is present, record the
/// actual emitted destination from the canonical source that produced it. The
/// association is written at the real producer point using the emitter's own
/// `tool_indexes` identity: a refresh replacement records the new destination,
/// a deduplicated no-op keeps the source the emitter actually retained, and a
/// genuinely new declaration records the push index.
/// Replace the emitted namespace child name with its collision-free wire alias
/// when the allocator had to disambiguate it against another declaration.
pub(super) fn apply_namespace_wire_alias(
    mut tool: Value,
    aliases: &HashMap<String, String>,
) -> Value {
    let name = tool
        .get("function")
        .and_then(Value::as_object)
        .and_then(|function| function.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| tool.get("name").and_then(Value::as_str).map(str::to_string));
    let Some(alias) = name.as_ref().and_then(|name| aliases.get(name)).cloned() else {
        return tool;
    };
    if let Some(function) = tool.get_mut("function").and_then(Value::as_object_mut) {
        function.insert("name".to_string(), Value::String(alias));
    } else if let Some(row) = tool.as_object_mut() {
        row.insert("name".to_string(), Value::String(alias));
    }
    tool
}

fn push_provider_tool_with_emission(
    tools: &mut Vec<Value>,
    tool_indexes: &mut HashMap<String, usize>,
    tool: Value,
    target_protocol: &str,
    refreshed_provider_tool_names: &BTreeSet<String>,
    observer: Option<&mut StandardOutboundDeclarationObserver<'_>>,
    canonical_source_path: &str,
) -> Result<(), String> {
    let name = provider_function_tool_name(&tool).map(str::to_string);
    let prior_index = name
        .as_ref()
        .and_then(|name| tool_indexes.get(name).copied());
    let replaces = name
        .as_ref()
        .is_some_and(|name| refreshed_provider_tool_names.contains(name));
    if replaces {
        replace_provider_function_tool(tools, tool_indexes, tool);
    } else {
        push_unique_provider_function_tool(tools, tool_indexes, tool, target_protocol)?;
    }
    if let Some(observer) = observer {
        // A named declaration that already existed and was not refreshed was
        // deduplicated by the emitter, which retained the earlier source.
        if prior_index.is_some() && !replaces {
            return Ok(());
        }
        let destination_index = name
            .as_ref()
            .and_then(|name| tool_indexes.get(name).copied())
            .or_else(|| tools.len().checked_sub(1));
        if let Some(destination_index) = destination_index {
            observer.note_emitted(
                destination_index,
                canonical_source_path,
                &tools[destination_index],
            );
        }
    }
    Ok(())
}

/// Canonical path of a namespace child: the outer namespace tool path followed
/// by every structural child index the flattener recorded at the actual leaf
/// push. Nested namespace indices accumulate so the path matches the canonical
/// declaration location, not the emitted provider name.
fn namespace_child_canonical_path(namespace_path: &str, source_child_indices: &[usize]) -> String {
    let mut path = String::from(namespace_path);
    for child_index in source_child_indices {
        path.push_str(&format!(".tools[{child_index}]"));
    }
    path
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
        // openai_chat hosted web_search 只能表达文本结果（web_search_options 无
        // search_content_types 字段）。Codex 标准声明 ["text","image"]（生产样本
        // tools[13]）：image 是已知合法内容类型但协议无法表达 → 显式剥离
        // （降级 text 投影，对齐图片附件在无 vision provider 的剥离语义）；
        // 未知内容类型（如 video）保持 fail-fast，禁止静默丢弃。
        for value in values {
            if !matches!(value.as_str(), Some("text" | "image")) {
                return Err(format!(
                    "UnmappedOutboundFields target_protocol=openai_chat paths={path}.search_content_types"
                ));
            }
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
    // Schema）；freeform 的真实输入挂到唯一的 `input` 字符串字段，保证 Chat
    // provider 不会把 apply_patch 误生成成空 object。format（grammar）是
    // Responses/扩展形状，chat wire 无法表达，按协议收窄丢弃。
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
        (
            "parameters".to_string(),
            openai_chat_freeform_custom_tool_parameters(),
        ),
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
    if let Some(function) = row.get("function").and_then(Value::as_object) {
        // Req04 owns the only Tool-Thinking schema compilation. Preserve the
        // governed declaration while normalizing only the legacy MCP name.
        let mut normalized = row.clone();
        if let Some(name) = function.get("name").and_then(Value::as_str) {
            if let Some(function) = normalized
                .get_mut("function")
                .and_then(Value::as_object_mut)
            {
                function.insert(
                    "name".to_string(),
                    Value::String(provider_function_name(name)),
                );
            }
        }
        return Ok(Value::Object(normalized));
    }
    let mut function = Map::new();
    for key in ["name", "description", "parameters", "strict"] {
        if let Some(value) = row.get(key) {
            function.insert(
                key.to_string(),
                if key == "name" {
                    value
                        .as_str()
                        .map(|name| Value::String(provider_function_name(name)))
                        .unwrap_or_else(|| value.clone())
                } else {
                    value.clone()
                },
            );
        }
    }
    Ok(Value::Object(Map::from_iter([
        ("type".to_string(), Value::String("function".to_string())),
        ("function".to_string(), Value::Object(function)),
    ])))
}
