use crate::V3ProviderError;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use provider_compat_core::namespace_tools::flatten_namespace_tool_for_provider;
use routecodex_v3_config::internal::is_v3_gpt_family_model;
use routecodex_v3_config::{V3ProviderRequestCleanupAuthoringConfig, V3ResponsesTransportKind};
use serde_json::{json, Map, Value};

/// Protocol name recognized by the shared namespace-tool flattener for Responses wire
/// function shape (`{type:"function", name, description?, parameters?, strict?}`).
const RESPONSES_WIRE_PROTOCOL_NAME: &str = "openai-responses";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3ProviderAuthSecretHandle {
    Environment(String),
    TokenFile(String),
    /// 集中 secret 文件（每行 `name = value`），按 key 名取值。
    SecretFile {
        path: String,
        key: String,
    },
    ApiKey(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderAuthHandle {
    pub alias: String,
    pub secret: V3ProviderAuthSecretHandle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ResponsesProviderTarget {
    pub provider_id: String,
    pub provider_type: String,
    pub base_url: String,
    pub canonical_model_id: String,
    pub wire_model: String,
    /// 配置声明的 provider 兼容契约（如 opencode-go 的
    /// `responses:deepseek-console-go`）；wire 层按契约能力分支，不按部署身份分支。
    pub compatibility_profile: Option<String>,
    pub auth: V3ProviderAuthHandle,
    pub responses_transport: V3ResponsesTransportKind,
    pub websocket_v2_url: Option<String>,
    pub provider_request_cleanup: V3ProviderRequestCleanupAuthoringConfig,
    /// per-request 总超时（毫秒）；用于覆盖连接、响应头等待与 body 读取
    pub request_timeout_ms: u64,
    pub initial_concurrency_budget: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3ResponsesStreamIntent {
    Json,
    Sse,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3Provider12ResponsesWirePayload {
    request_id: String,
    target: V3ResponsesProviderTarget,
    stream_intent: V3ResponsesStreamIntent,
    body: Value,
}

impl V3Provider12ResponsesWirePayload {
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn target(&self) -> &V3ResponsesProviderTarget {
        &self.target
    }

    pub fn stream_intent(&self) -> V3ResponsesStreamIntent {
        self.stream_intent
    }

    pub fn body(&self) -> &Value {
        &self.body
    }

    pub(crate) fn into_parts(
        self,
    ) -> (
        String,
        V3ResponsesProviderTarget,
        V3ResponsesStreamIntent,
        Value,
    ) {
        (self.request_id, self.target, self.stream_intent, self.body)
    }
}

pub fn build_v3_provider_12_responses_wire_payload(
    request_id: impl Into<String>,
    target: V3ResponsesProviderTarget,
    current_request_body: Value,
) -> Result<V3Provider12ResponsesWirePayload, V3ProviderError> {
    let request_id = request_id.into();
    let stream_intent = match current_request_body
        .as_object()
        .ok_or_else(|| V3ProviderError::InvalidWireBody {
            request_id: request_id.clone(),
        })?
        .get("stream")
    {
        None | Some(Value::Bool(false)) => V3ResponsesStreamIntent::Json,
        Some(Value::Bool(true)) => V3ResponsesStreamIntent::Sse,
        Some(_) => {
            return Err(V3ProviderError::InvalidStreamIntent {
                request_id: request_id.clone(),
            })
        }
    };
    if let Some(field) = find_v3_routecodex_control_payload_key(&current_request_body) {
        return Err(V3ProviderError::ControlFieldInWireBody { request_id, field });
    }
    validate_current_responses_data_images(&request_id, &current_request_body)?;
    let actual_model = current_request_body
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string);
    if actual_model.as_deref() != Some(target.wire_model.as_str()) {
        return Err(V3ProviderError::ProviderModelBindingMismatch {
            request_id,
            provider_id: target.provider_id.clone(),
            expected_model: target.wire_model.clone(),
            actual_model,
        });
    }
    let mut body = expand_namespace_tools_in_responses_wire_body(
        &request_id,
        &target.provider_type,
        current_request_body,
    )?;
    normalize_deepseek_thinking_stopless_tool_choice(&mut body, &target);
    // 请求侧 reasoning wire 兜底（非 gpt 目标，每次请求必经）：
    // 1. 历史密文剥离（encrypted_content）对所有非 gpt 目标统一执行——gpt 官方系
    //    接受密文，保留透传；响应侧主防线（`apply_v3_response_cipher_policy`，
    //    唯一 hook）保证客户端正常情况拿不到密文，此兜底只处理历史残留密文跨
    //    provider 回传的窗口。
    // 2. DeepSeek/opencode 目标额外把 reasoning 重写为统一
    //    `content:[{type:"reasoning_text",text}]` 形态（否则上游 400
    //    `reasoning_text must be passed back`）；该重写只在已证明需要的模型上
    //    执行，避免未经证实的其他非 gpt responses provider 被改写 reasoning 形态。
    if !is_v3_gpt_family_model(&target.canonical_model_id) {
        let deepseek_compat = target.canonical_model_id == "deepseek-v4-flash"
            || target.wire_model == "deepseek-v4-flash";
        strip_v3_request_encrypted_reasoning(&mut body, deepseek_compat);
        // junction 合成 reasoning 只属于已证实的 opencode-go/Console Go 网关：
        // compatibility profile（responses:deepseek-console-go）锁网关契约
        // （请求侧 custom->function 工具映射 + 响应侧回射也按同一 profile
        // 门控），deepseek-v4-flash 额外锁 400 的已证实载体——该失败只在
        // deepseek thinking 模式下被证实，其他模型即使走同一网关也不追加
        // 未经证明的条目。
        if deepseek_compat
            && target.compatibility_profile.as_deref() == Some("responses:deepseek-console-go")
            && v3_wire_payload_is_thinking_mode(&body)
        {
            // 先做 call/output 配对归一（Console Go Chat 降级契约），再做
            // junction reasoning 合成；两者同属已证实的 opencode-go/Console Go
            // 网关契约，deepseek-v4-flash + thinking 模式为已证实载体。
            normalize_v3_deepseek_console_go_tool_output_pairing(&mut body);
            insert_v3_deepseek_interleaved_tool_segment_reasoning(&mut body);
        }
    }
    Ok(V3Provider12ResponsesWirePayload {
        request_id,
        target,
        stream_intent,
        body,
    })
}

/// 唯一密文剥离 hook（响应侧，direct 与 relay 共用）：
/// `retain_response_cipher=true`（仅 gpt 模型且路由只有单一 provider 候选时，
/// 由调用方 VR 路由决策用 `is_v3_retain_response_cipher` 算好传入）原样保留
/// `encrypted_content`（Codex 客户端需要官方密文重建 reasoning 历史）；
/// 其余场景递归删除 payload 中所有 Codex 密文字段，保证密文不进入客户端。
/// 响应侧是密文治理的唯一入口；本 hook 只消费判定结果，不重复判定。
pub fn apply_v3_response_cipher_policy(payload: &mut Value, retain_response_cipher: bool) {
    if !retain_response_cipher {
        strip_v3_encrypted_fields_recursive(payload);
    }
}

/// 递归删除 Codex 密文字段：`encrypted_content` 值以 `rsn_` / `gAAAA` 开头
/// （Codex 客户端本地密文）一律删除；anthropic 链的 thinking signature 载体
/// （redacted_thinking.data / thinking.signature，值非 rsn_/gAAAA 前缀）不是
/// Codex 密文，保留给客户端签名校验。请求侧与响应侧共用此唯一递归剥离器。
fn strip_v3_encrypted_fields_recursive(value: &mut Value) {
    match value {
        Value::Object(map) => {
            strip_v3_cipher_field(map);
            for child in map.values_mut() {
                strip_v3_encrypted_fields_recursive(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                strip_v3_encrypted_fields_recursive(item);
            }
        }
        _ => {}
    }
}

/// 单一对象的密文键剥离（请求侧 reasoning 条目与响应侧递归共用同一语义）。
fn strip_v3_cipher_field(map: &mut Map<String, Value>) {
    if let Some(Value::String(cipher)) = map.get("encrypted_content") {
        if cipher.starts_with("rsn_") || cipher.starts_with("gAAAA") {
            map.remove("encrypted_content");
        }
    }
}

/// 请求侧 reasoning wire 兜底（非 gpt 目标，每次请求必经）。
///
/// 密文剥离对所有非 gpt 目标统一执行；DeepSeek/opencode 目标（deepseek_compat）
/// 额外做统一重写：opencode/DeepSeek 网关把 Responses reasoning 转 Chat 时只认
/// `content:[{type:"reasoning_text",text}]`（对应官方 `reasoning_content` 回传
/// 规则），`summary`、顶层 `text`、`encrypted_content` 形态都会让上游 400
/// （`reasoning_text must be passed back`）。重写确定性执行，同一请求反复构建
/// wire 输出字节不变，保证上游缓存前缀稳定。
fn strip_v3_request_encrypted_reasoning(body: &mut Value, deepseek_compat: bool) {
    let Some(input) = body.get_mut("input").and_then(Value::as_array_mut) else {
        return;
    };
    for item in input.iter_mut() {
        let Some(obj) = item.as_object_mut() else {
            continue;
        };
        if obj.get("type").and_then(Value::as_str) != Some("reasoning") {
            continue;
        }
        obj.remove("encrypted_content");
        if deepseek_compat {
            let plain = join_v3_reasoning_plain_text(obj);
            let text = if plain.is_empty() {
                "[thinking redacted]".to_string()
            } else {
                plain
            };
            obj.insert(
                "content".to_string(),
                json!([{"type": "reasoning_text", "text": text}]),
            );
            obj.remove("summary");
            obj.remove("text");
            obj.remove("reasoning_content");
        } else {
            // 既有窄清理：只剥密文；无任何明文（summary/content/text/
            // reasoning_content 均缺失/空/null）时补 `[thinking redacted]`
            // 占位，保持该条 assistant reasoning 表示存在。
            let has_plain_content = ["summary", "content", "text", "reasoning_content"]
                .iter()
                .any(|key| {
                    obj.get(*key).is_some_and(|value| {
                        !(value.is_null()
                            || value.as_str().is_some_and(str::is_empty)
                            || (value.is_array() && value.as_array().is_some_and(Vec::is_empty)))
                    })
                });
            if !has_plain_content {
                obj.insert(
                    "text".to_string(),
                    Value::String("[thinking redacted]".to_string()),
                );
            }
        }
    }
}

/// 提取 reasoning 条目的明文表示，按 content -> summary -> text/reasoning_content
/// 顺序取第一段非空明文并 join 所有 text 片段；全空返回空串。
fn join_v3_reasoning_plain_text(obj: &Map<String, Value>) -> String {
    for key in ["content", "summary"] {
        if let Some(Value::Array(items)) = obj.get(key) {
            let mut joined = String::new();
            for item in items {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    joined.push_str(text);
                }
            }
            if !joined.is_empty() {
                return joined;
            }
        }
    }
    for key in ["text", "reasoning_content"] {
        if let Some(text) = obj.get(key).and_then(Value::as_str) {
            if !text.is_empty() {
                return text.to_string();
            }
        }
    }
    String::new()
}

/// Console Go 网关把 Responses input 转 Chat 时按 `call -> 最近 output` 配对；
/// call 与其 output 之间的 assistant 文本消息会打断配对，导致上游 400
/// `No tool output found for tool call ...`（DeepSeek 原生 API 接受该交错，
/// 只有 Console Go 的 Chat 降级不接受）。把每个工具 run（一个或多个连续
/// calls + 其 outputs，窗口内只含 calls/outputs/assistant 文本消息）内的
/// assistant 消息移动到该 run 最后一个 output 之后，保持消息相对顺序；
/// calls 与 outputs 原序不动。纯函数、确定性，同一请求反复构建 wire 输出
/// 字节不变。
fn normalize_v3_deepseek_console_go_tool_output_pairing(body: &mut Value) {
    let Some(input) = body.get_mut("input").and_then(Value::as_array_mut) else {
        return;
    };
    let mut pending_calls = 0usize;
    let mut run_assistant: Vec<Value> = Vec::new();
    let mut index = 0usize;
    while index < input.len() {
        let kind = input[index].get("type").and_then(Value::as_str);
        match kind {
            Some("function_call" | "custom_tool_call") => {
                if pending_calls == 0 {
                    run_assistant.clear();
                }
                pending_calls += 1;
                index += 1;
            }
            Some("function_call_output" | "custom_tool_call_output") => {
                pending_calls = pending_calls.saturating_sub(1);
                index += 1;
                if pending_calls == 0 && !run_assistant.is_empty() {
                    let tail_len = run_assistant.len();
                    let insert_at = index;
                    for message in run_assistant.drain(..) {
                        input.insert(insert_at, message);
                    }
                    index += tail_len;
                }
            }
            Some("message") => {
                let role = input[index]
                    .get("role")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if role.as_deref() == Some("assistant") && pending_calls > 0 {
                    let message = input.remove(index);
                    run_assistant.push(message);
                    // 索引不前进：后续条目前移，继续扫描同一位置。
                } else {
                    if role.as_deref() == Some("user") && !run_assistant.is_empty() {
                        // 未闭合 run 遇到轮边界：先放回已收集消息，不丢数据。
                        let tail_len = run_assistant.len();
                        let insert_at = index;
                        for message in run_assistant.drain(..) {
                            input.insert(insert_at, message);
                        }
                        index += tail_len;
                    }
                    if role.as_deref() == Some("user") {
                        pending_calls = 0;
                    }
                    index += 1;
                }
            }
            _ => {
                index += 1;
            }
        }
    }
    // 畸形输入：pending calls 未闭合时把 run 内 assistant 消息追加到末尾，
    // 不丢数据、确定性输出。
    if !run_assistant.is_empty() {
        input.append(&mut run_assistant);
    }
}

/// DeepSeek thinking mode 的交错工具段兼容：opencode-go Console Go 网关把
/// Responses input 转 Chat 时，`function_call_output/custom_tool_call_output`
/// 后直接跟随的 `function_call/custom_tool_call` 会生成新的 assistant tool_calls
/// 消息，thinking mode 下该消息必须附着 reasoning（官方 400
/// `reasoning_text must be passed back`）。在 output->call 交界插入继承最近一条
/// reasoning 明文（无前文时用确定性占位符）的 reasoning 条目；规则只依赖相邻
/// item 类型，纯函数、确定性，同一请求重复构建 wire 字节不变。
fn insert_v3_deepseek_interleaved_tool_segment_reasoning(body: &mut Value) {
    let Some(input) = body.get_mut("input").and_then(Value::as_array_mut) else {
        return;
    };
    let mut last_reasoning_text: Option<String> = None;
    let mut index = 0;
    while index < input.len() {
        // 跨轮边界不继承 reasoning：user 消息后的工具段属于新一轮，上一轮明文
        // 不能错配到当前轮（否则 provider 会把该工具段归因到旧 turn）。
        if input[index].get("type").and_then(Value::as_str) == Some("message")
            && input[index].get("role").and_then(Value::as_str) == Some("user")
        {
            last_reasoning_text = None;
        }
        if input[index].get("type").and_then(Value::as_str) == Some("reasoning") {
            if let Some(object) = input[index].as_object() {
                let text = join_v3_reasoning_plain_text(object);
                last_reasoning_text = if text.is_empty() { None } else { Some(text) };
            }
        }
        // 只在交错工具段（output -> call 交界）补 reasoning：thinking mode
        // 的 provider 要求后继 tool-call 段回传 reasoning。user 消息后的首个
        // tool call 属于新轮，不能凭空插入占位 reasoning（会把本轮的
        // `[thinking redacted]` 错配给 provider）；无前文 reasoning 时仍用
        // 确定性占位符保持 wire 字节稳定。
        let is_output = matches!(
            input[index].get("type").and_then(Value::as_str),
            Some("function_call_output" | "custom_tool_call_output")
        );
        let next_is_call = input
            .get(index + 1)
            .and_then(|item| item.get("type"))
            .and_then(Value::as_str)
            .is_some_and(|kind| matches!(kind, "function_call" | "custom_tool_call"));
        if is_output && next_is_call {
            let text = last_reasoning_text
                .clone()
                .unwrap_or_else(|| "[thinking redacted]".to_string());
            input.insert(
                index + 1,
                json!({"type": "reasoning", "content": [{"type": "reasoning_text", "text": text}]}),
            );
        }
        // 首个工具段（assistant 文本后直接跟 call、同轮无前文 reasoning）：
        // Console Go 转 Chat 时该 tool_calls 消息同样必须附着 reasoning，
        // 否则上游 400 `reasoning_text must be passed back`；无前文时用
        // 确定性占位符保持 wire 字节稳定。有前文 reasoning 时该条目已存在
        // 于工具段之前，不再重复插入。
        let is_assistant_message = matches!(
            input[index].get("type").and_then(Value::as_str),
            Some("message")
        ) && input[index].get("role").and_then(Value::as_str)
            == Some("assistant");
        if is_assistant_message && next_is_call && last_reasoning_text.is_none() {
            input.insert(
                index + 1,
                json!({"type": "reasoning", "content": [{"type": "reasoning_text", "text": "[thinking redacted]"}]}),
            );
        }
        index += 1;
    }
}

fn normalize_deepseek_thinking_stopless_tool_choice(
    body: &mut Value,
    target: &V3ResponsesProviderTarget,
) {
    if target.provider_type != "openai_chat"
        || (target.canonical_model_id != "deepseek-v4-flash"
            && target.wire_model != "deepseek-v4-flash")
        || !v3_wire_payload_is_thinking_mode(body)
    {
        return;
    }
    let has_reasoning_stop = body
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| {
            tools.iter().any(|tool| {
                tool.get("name").and_then(Value::as_str) == Some("reasoningStop")
                    || tool.pointer("/function/name").and_then(Value::as_str)
                        == Some("reasoningStop")
            })
        });
    if has_reasoning_stop {
        if let Some(object) = body.as_object_mut() {
            object.remove("tool_choice");
        }
    }
}

/// Responses wire tools only support provider-native tool types; a Codex `type=namespace`
/// container (MCP tool discovery) is not a standard Responses tool and fails strict providers.
/// Flatten each namespace child into a plain `function` tool, preserving order and child
/// name/description/parameters/strict, so no `namespace` container crosses the provider wire.
///
/// The expanded `function` shape follows the target provider's native tool convention:
/// `responses` providers (OpenAI Responses standard) receive the flat form
/// (`{"type":"function","name":...}`), while `openai_chat` providers (Chat-style gateways
/// such as Console Go, whose `/v1/responses` endpoint reuses the Chat tool serde) receive
/// the nested form (`{"type":"function","function":{...}}`).
fn expand_namespace_tools_in_responses_wire_body(
    request_id: &str,
    provider_type: &str,
    mut body: Value,
) -> Result<Value, V3ProviderError> {
    let Some(tools) = body.get("tools").and_then(Value::as_array) else {
        return Ok(body);
    };
    let has_namespace = tools
        .iter()
        .any(|tool| tool.get("type").and_then(Value::as_str) == Some("namespace"));
    if !has_namespace && provider_type != "openai_chat" {
        return Ok(body);
    }
    let protocol = match provider_type {
        "openai_chat" => "openai-chat",
        _ => RESPONSES_WIRE_PROTOCOL_NAME,
    };
    let tools = tools.clone();
    let mut expanded = Vec::with_capacity(tools.len());
    for tool in tools {
        match flatten_namespace_tool_for_provider(protocol, &tool) {
            Ok(Some(children)) => expanded.extend(children),
            Ok(None) => expanded.push(tool),
            Err(detail) => {
                return Err(V3ProviderError::NamespaceToolFlattenFailed {
                    request_id: request_id.to_string(),
                    detail,
                })
            }
        }
    }
    if provider_type == "openai_chat" {
        expanded = normalize_openai_chat_function_tools(request_id, expanded)?;
    }
    body["tools"] = Value::Array(expanded);
    Ok(body)
}

/// Console Go (`openai_chat`) 的 `/v1/responses` 端点使用 Chat 风格工具 serde 的变体：
/// 每个 function 工具必须**同时**携带顶层 `name` 与嵌套 `function`（双字段）。
/// 纯嵌套（缺顶层 `name`）报 `missing field 'name'`，标准 Responses 平铺（缺 `function`）
/// 报 `missing field 'function'`，二者都会让上游 400。
///
/// 归一化：为每个 function 工具补上顶层 `name`，并保证嵌套 `function` 存在且含 `name`，
/// 其余字段（description/parameters/strict）从已有 `function` 或顶层合并。
fn normalize_openai_chat_function_tools(
    request_id: &str,
    tools: Vec<Value>,
) -> Result<Vec<Value>, V3ProviderError> {
    let mut normalized = Vec::with_capacity(tools.len());
    for (index, tool) in tools.into_iter().enumerate() {
        let object = tool
            .as_object()
            .ok_or_else(|| V3ProviderError::FunctionToolShapeFailed {
                request_id: request_id.to_string(),
                detail: format!("tools[{index}] must be a JSON object"),
            })?;
        if object.get("type").and_then(Value::as_str) != Some("function") {
            return Err(V3ProviderError::FunctionToolShapeFailed {
                request_id: request_id.to_string(),
                detail: format!("tools[{index}].type must be function for openai_chat provider"),
            });
        }
        let top_level_name = object.get("name").and_then(Value::as_str);
        let nested_name = object
            .get("function")
            .and_then(Value::as_object)
            .and_then(|function| function.get("name"))
            .and_then(Value::as_str);
        let name = top_level_name
            .or(nested_name)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| V3ProviderError::FunctionToolShapeFailed {
                request_id: request_id.to_string(),
                detail: format!("tools[{index}] requires a non-empty function name"),
            })?;
        let mut function = match object.get("function") {
            Some(Value::Object(function)) => function.clone(),
            _ => Map::new(),
        };
        function.insert("name".to_string(), Value::String(name.to_string()));
        for key in ["description", "parameters", "strict"] {
            if !function.contains_key(key) {
                if let Some(value) = object.get(key) {
                    function.insert(key.to_string(), value.clone());
                }
            }
        }
        let mut dual = Map::new();
        dual.insert("type".to_string(), Value::String("function".to_string()));
        dual.insert("name".to_string(), Value::String(name.to_string()));
        dual.insert("function".to_string(), Value::Object(function));
        normalized.push(Value::Object(dual));
    }
    Ok(normalized)
}

fn validate_current_responses_data_images(
    request_id: &str,
    body: &Value,
) -> Result<(), V3ProviderError> {
    let Some(input) = body.get("input").and_then(Value::as_array) else {
        return Ok(());
    };
    let Some(latest_user_index) = input.iter().rposition(is_responses_user_input_item) else {
        return Ok(());
    };
    for item in input.iter().skip(latest_user_index) {
        validate_data_image_urls_in_value(request_id, item)?;
    }
    Ok(())
}

fn is_responses_user_input_item(item: &Value) -> bool {
    item.as_object()
        .and_then(|object| object.get("role"))
        .and_then(Value::as_str)
        == Some("user")
}

fn validate_data_image_urls_in_value(
    request_id: &str,
    value: &Value,
) -> Result<(), V3ProviderError> {
    match value {
        Value::Object(object) => {
            if object.get("type").and_then(Value::as_str) == Some("input_image") {
                if let Some(image_url) = object.get("image_url").and_then(image_url_as_str) {
                    validate_data_image_url(request_id, image_url)?;
                }
            }
            for child in object.values() {
                validate_data_image_urls_in_value(request_id, child)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                validate_data_image_urls_in_value(request_id, item)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn image_url_as_str(value: &Value) -> Option<&str> {
    value
        .as_str()
        .or_else(|| value.as_object()?.get("url")?.as_str())
}

fn validate_data_image_url(request_id: &str, image_url: &str) -> Result<(), V3ProviderError> {
    if !image_url.starts_with("data:image/") {
        return Ok(());
    }
    let Some((header, encoded)) = image_url.split_once(',') else {
        return Err(invalid_data_image(
            request_id,
            "image/*",
            "missing base64 separator",
        ));
    };
    let header_lower = header.to_ascii_lowercase();
    let Some(media_type) = header_lower
        .strip_prefix("data:")
        .and_then(|rest| rest.split(';').next())
        .filter(|media_type| media_type.starts_with("image/"))
    else {
        return Ok(());
    };
    if !header_lower.split(';').any(|part| part == "base64") {
        return Err(invalid_data_image(
            request_id,
            media_type,
            "data image must use base64 encoding",
        ));
    }
    let bytes = BASE64_STANDARD
        .decode(encoded.as_bytes())
        .map_err(|error| invalid_data_image(request_id, media_type, error.to_string()))?;
    validate_image_magic(request_id, media_type, &bytes)
}

fn validate_image_magic(
    request_id: &str,
    media_type: &str,
    bytes: &[u8],
) -> Result<(), V3ProviderError> {
    let valid = match media_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" | "image/jpg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && bytes[8..12] == *b"WEBP",
        _ => !bytes.is_empty(),
    };
    if valid {
        Ok(())
    } else {
        Err(invalid_data_image(
            request_id,
            media_type,
            "decoded bytes do not match declared image type",
        ))
    }
}

fn invalid_data_image(
    request_id: &str,
    media_type: impl Into<String>,
    reason: impl Into<String>,
) -> V3ProviderError {
    V3ProviderError::InvalidDataImage {
        request_id: request_id.to_string(),
        media_type: media_type.into(),
        reason: reason.into(),
    }
}

pub const V3_ROUTECODEX_CONTROL_PAYLOAD_KEYS: &[&str] = &[
    "routecodex_internal",
    "routecodexInternal",
    "route_hint",
    "routeHint",
    "metadata_center",
    "metadataCenter",
    "__metadataCenter",
    "debug_snapshot",
    "debugSnapshot",
    "provider_protocol",
    "providerProtocol",
    "provider_runtime",
    "providerRuntime",
    "resource_handle",
    "resourceHandle",
    "continuation_owner",
    "continuationOwner",
    "runtime_control",
    "runtimeControl",
    "request_truth",
    "requestTruth",
    "route_selection",
    "routeSelection",
    "retry_exclusion_set",
    "retryExclusionSet",
    "selected_target",
    "selectedTarget",
    "opaque_target",
    "opaqueTarget",
    "resume_meta",
    "resumeMeta",
    "servertool_state",
    "servertoolState",
    "stopless_state",
    "stoplessState",
    "stopless_center",
    "stoplessCenter",
    "__routecodex_stopless_center",
    "error_chain",
    "errorChain",
    "node_trace",
    "nodeTrace",
    "capturedChatRequest",
    "entryOriginRequest",
    "requestSemantics",
    "responsesRequestContext",
    "__raw_request_body",
    "__rt",
    "__rccDryRunSerialized",
    "request_capabilities",
    "requestCapabilities",
    "required_capabilities",
    "requiredCapabilities",
    "model_capabilities",
    "modelCapabilities",
    "selection_plan",
    "selectionPlan",
];

pub fn find_v3_routecodex_control_payload_key(value: &Value) -> Option<&'static str> {
    match value {
        Value::Array(items) => items
            .iter()
            .find_map(find_v3_routecodex_control_payload_key),
        Value::Object(object) => {
            for &key in V3_ROUTECODEX_CONTROL_PAYLOAD_KEYS {
                if object.contains_key(key) {
                    return Some(key);
                }
            }
            object
                .values()
                .find_map(find_v3_routecodex_control_payload_key)
        }
        _ => None,
    }
}

include!("../tests/support/wire_unit.rs");
