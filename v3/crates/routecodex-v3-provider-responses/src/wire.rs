use crate::V3ProviderError;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use provider_compat_core::namespace_tools::flatten_namespace_tool_for_provider;
use routecodex_v3_config::internal::is_v3_gpt_family_model;
use routecodex_v3_config::{V3ProviderRequestCleanupAuthoringConfig, V3ResponsesTransportKind};
use serde_json::{Map, Value};

/// Protocol name recognized by the shared namespace-tool flattener for Responses wire
/// function shape (`{type:"function", name, description?, parameters?, strict?}`).
const RESPONSES_WIRE_PROTOCOL_NAME: &str = "openai-responses";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3ProviderAuthSecretHandle {
    Environment(String),
    TokenFile(String),
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
    // 请求侧密文兜底：非 gpt 目标不携带 Codex 密文（encrypted_content）——
    // opencode-go/DeepSeek 等网关不识别加密 reasoning 回传，原样透传会 400
    // （`reasoning_text must be passed back`）。gpt 官方系接受密文，保留透传。
    // 响应侧主防线（`apply_v3_response_cipher_policy`，唯一 hook）保证客户端
    // 正常情况拿不到密文，此兜底只处理历史残留密文跨 provider 回传的窗口。
    if !is_v3_gpt_family_model(&target.canonical_model_id) {
        strip_v3_request_encrypted_reasoning(&mut body);
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

/// 请求侧密文剥离（wire 兜底）：剥离 reasoning 条目的 `encrypted_content` 后，
/// 若该条目没有任何明文内容（summary/content/text），补空 `text` 占位——
/// opencode（DeepSeek 上游）要求每条 assistant 消息都必须带 reasoning 表示，
/// 直接丢弃会让该轮缺 reasoning，触发 `reasoning_content must be passed back` 400。
fn strip_v3_request_encrypted_reasoning(body: &mut Value) {
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
        strip_v3_cipher_field(obj);
        // 现象：Codex 客户端历史里的 reasoning 常为 `{"type":"reasoning","summary":[]}`
        // （密文已剥离或本就无明文）。opencode.ai zen/go 网关在 thinking 模式要求每条
        // assistant reasoning 必须携带非空 reasoning_text 表示；空 `summary:[]` 或
        // `text:""` 都会被上游 400 `reasoning_text must be passed back`。因此**空数组/
        // 空文本一律补非空占位文本**——实测只有非空 reasoning_text 被上游接受。
        // 注意：这是有意保留 reasoning item（不删除）并填充占位；删除或留空都会让
        // 该轮缺 reasoning 表示，触发 400。wire.rs 测试
        // `wire_keeps_encrypted_only_reasoning_as_empty_text_placeholder` 锁住该行为；
        // 后续任何"清理空 reasoning"的修改都会破坏 opencode DeepSeek 链路。
        let has_plain_content = ["summary", "content", "text", "reasoning_content"]
            .iter()
            .any(|key| {
                obj.get(*key).is_some_and(|value| {
                    !value.is_null()
                        && !(value.is_array() && value.as_array().is_some_and(Vec::is_empty))
                        && !(value.as_str().is_some_and(str::is_empty))
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
                    || tool
                        .pointer("/function/name")
                        .and_then(Value::as_str)
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
        let object = tool.as_object().ok_or_else(|| {
            V3ProviderError::FunctionToolShapeFailed {
                request_id: request_id.to_string(),
                detail: format!("tools[{index}] must be a JSON object"),
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const VALID_PNG_DATA_URL: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

    #[test]
    fn wire_accepts_only_prebound_selected_model() {
        let body = json!({
            "model":"upstream-model",
            "input":"hello",
            "metadata":{"client":"kept"},
            "unknown_client_field":true
        });
        let wire = build_v3_provider_12_responses_wire_payload(
            "req-1",
            V3ResponsesProviderTarget {
                provider_id: "neutral-provider".into(),
                provider_type: "responses".into(),
                base_url: "http://upstream.invalid/v1".into(),
                canonical_model_id: "canonical-model".into(),
                wire_model: "upstream-model".into(),
                auth: V3ProviderAuthHandle {
                    alias: "primary".into(),
                    secret: V3ProviderAuthSecretHandle::Environment("NEUTRAL_KEY".into()),
                },
                responses_transport: V3ResponsesTransportKind::Http,
                websocket_v2_url: None,
                provider_request_cleanup: Default::default(),
                request_timeout_ms: 300_000,
                initial_concurrency_budget: 8,
            },
            body,
        )
        .unwrap();
        assert_eq!(wire.body()["model"], "upstream-model");
        assert_eq!(wire.body()["input"], "hello");
        assert_eq!(wire.body()["metadata"], json!({"client":"kept"}));
        assert_eq!(wire.body()["unknown_client_field"], true);
        assert_eq!(wire.stream_intent(), V3ResponsesStreamIntent::Json);
    }

    #[test]
    fn wire_preserves_historical_tool_output_data_images_byte_for_byte() {
        let current_user_image = VALID_PNG_DATA_URL;
        let current_tool_image = VALID_PNG_DATA_URL;
        let body = json!({
            "model": "upstream-model",
            "stream": true,
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "old turn"}]
                },
                {
                    "type": "function_call",
                    "name": "view_image",
                    "call_id": "call_old",
                    "arguments": "{}"
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_old",
                    "output": [
                        {"type": "input_image", "image_url": "data:image/png;base64,OLD", "detail": "high"},
                        {"type": "input_image", "image_url": {"url": "data:image/png;base64,OLD_OBJECT"}, "detail": "low"},
                        {"type": "input_text", "text": "tool text stays"}
                    ]
                },
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "current turn"},
                        {"type": "input_image", "image_url": current_user_image}
                    ]
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_after_latest_user",
                    "output": [
                        {"type": "input_image", "image_url": current_tool_image}
                    ]
                }
            ]
        });
        let expected = body.clone();
        let wire =
            build_v3_provider_12_responses_wire_payload("req-images", target(), body).unwrap();
        assert_eq!(wire.body(), &expected);
        assert_eq!(wire.stream_intent(), V3ResponsesStreamIntent::Sse);
    }

    #[test]
    fn wire_does_not_broadly_replace_text_or_non_data_historical_tool_images() {
        let body = json!({
            "model": "upstream-model",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": "old turn"
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_old",
                    "output": [
                        {"type": "input_text", "text": "literal data:image/png;base64,TEXT stays text"},
                        {"type": "input_image", "image_url": "https://example.invalid/old.png"}
                    ]
                },
                {
                    "type": "message",
                    "role": "user",
                    "content": "latest turn"
                }
            ]
        });
        let wire =
            build_v3_provider_12_responses_wire_payload("req-no-broad", target(), body).unwrap();
        let input = wire.body()["input"].as_array().unwrap();
        assert_eq!(
            input[1]["output"][0]["text"],
            "literal data:image/png;base64,TEXT stays text"
        );
        assert_eq!(
            input[1]["output"][1]["image_url"],
            "https://example.invalid/old.png"
        );
    }

    #[test]
    fn wire_preserves_historical_reasoning_even_when_legacy_cleanup_is_configured() {
        let body = json!({
            "model": "upstream-model",
            "input": [
                {"type": "message", "role": "user", "content": "old turn"},
                {
                    "type": "reasoning",
                    "summary": [{"type": "summary_text", "text": "old summary"}],
                    "encrypted_content": "rsn_old_foreign"
                },
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "literal rsn_text_stays"}]
                },
                {"type": "message", "role": "user", "content": "latest turn"},
                {
                    "type": "reasoning",
                    "summary": [{"type": "summary_text", "text": "current summary"}],
                    "encrypted_content": "rsn_current_same_turn"
                }
            ]
        });
        let expected = body.clone();
        // gpt 目标（OpenAI 官方 canonical）保留 encrypted_content 透传；
        // 本测试验证 legacy cleanup 配置不会剥离密文（cleanup 仅处理历史字段名，非密文语义）。
        let mut gpt_target = cleanup_target(&["reasoning.encrypted_content"]);
        gpt_target.canonical_model_id = "gpt-5.6-sol".into();
        let wire = build_v3_provider_12_responses_wire_payload(
            "req-encrypted-history",
            gpt_target,
            body,
        )
        .unwrap();
        assert_eq!(wire.body(), &expected);
    }

    #[test]
    fn wire_preserves_historical_encrypted_content_when_cleanup_is_not_configured() {
        let body = json!({
            "model": "upstream-model",
            "input": [
                {"type": "message", "role": "user", "content": "old turn"},
                {"type": "reasoning", "encrypted_content": "rsn_old_same_provider"},
                {"type": "message", "role": "user", "content": "latest turn"}
            ]
        });
        // gpt 目标（OpenAI 官方 canonical）保留 encrypted_content 透传。
        let mut gpt_target = target();
        gpt_target.canonical_model_id = "gpt-5.6-sol".into();
        let wire =
            build_v3_provider_12_responses_wire_payload("req-no-cleanup", gpt_target, body).unwrap();
        assert_eq!(
            wire.body()["input"][1]["encrypted_content"],
            "rsn_old_same_provider"
        );
    }

    #[test]
    fn current_turn_invalid_png_data_image_is_rejected_before_provider_transport() {
        let body = json!({
            "model": "upstream-model",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "current turn"},
                        {"type": "input_image", "image_url": "data:image/png;base64,AAAA"}
                    ]
                }
            ]
        });
        let error =
            build_v3_provider_12_responses_wire_payload("req-invalid-image", target(), body)
                .expect_err("invalid current-turn data image must fail before provider transport");
        assert!(error.to_string().contains("invalid data:image/png payload"));
    }

    #[test]
    fn non_object_or_non_boolean_stream_fails_without_rebuilding_payload() {
        let target = V3ResponsesProviderTarget {
            provider_id: "neutral-provider".into(),
            provider_type: "responses".into(),
            base_url: "http://upstream.invalid/v1".into(),
            canonical_model_id: "model".into(),
            wire_model: "model".into(),
            auth: V3ProviderAuthHandle {
                alias: "primary".into(),
                secret: V3ProviderAuthSecretHandle::Environment("NEUTRAL_KEY".into()),
            },
            responses_transport: V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
            provider_request_cleanup: Default::default(),
            request_timeout_ms: 300_000,
            initial_concurrency_budget: 8,
        };
        assert!(matches!(
            build_v3_provider_12_responses_wire_payload("req-array", target.clone(), json!([])),
            Err(V3ProviderError::InvalidWireBody { .. })
        ));
        assert!(matches!(
            build_v3_provider_12_responses_wire_payload(
                "req-stream",
                target,
                json!({"stream":"yes"})
            ),
            Err(V3ProviderError::InvalidStreamIntent { .. })
        ));
    }

    #[test]
    fn wire_rejects_routecodex_control_keys_before_provider_transport() {
        let body = json!({
            "model":"upstream-model",
            "input":[{
                "role":"user",
                "content":"hello",
                "metadataCenter":{"provider_key":"must-not-leak"}
            }],
            "metadata":{"client":"kept"},
            "client_metadata":{"session_id":"client-owned"}
        });
        let error = build_v3_provider_12_responses_wire_payload("req-control", target(), body)
            .expect_err("provider wire body must reject internal control fields");
        assert!(matches!(
            error,
            V3ProviderError::ControlFieldInWireBody {
                request_id,
                field: "metadataCenter"
            } if request_id == "req-control"
        ));
    }

    #[test]
    fn wire_flattens_namespace_tool_children_into_function_tools() {
        let body = json!({
            "model": "upstream-model",
            "input": "hello",
            "tools": [
                {"type": "function", "name": "plain_tool", "description": "d", "parameters": {"type": "object"}},
                {
                    "type": "namespace",
                    "name": "mcp__node_repl",
                    "tools": [
                        {"type": "function", "name": "mcp__node_repl__js", "description": "run js", "parameters": {"type": "object", "properties": {}}, "strict": false},
                        {"type": "function", "name": "mcp__node_repl__npm", "description": "npm", "parameters": {"type": "object", "properties": {}}}
                    ]
                }
            ]
        });
        let wire =
            build_v3_provider_12_responses_wire_payload("req-namespace", target(), body).unwrap();
        let tools = wire.body()["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 3, "namespace container must be replaced by its children: {tools:?}");
        assert_eq!(tools[0]["type"], json!("function"));
        assert_eq!(tools[1], json!({
            "type": "function",
            "name": "mcp__node_repl__js",
            "description": "run js",
            "parameters": {"type": "object", "properties": {}},
            "strict": false
        }));
        assert_eq!(tools[2]["type"], json!("function"));
        assert_eq!(tools[2]["name"], json!("mcp__node_repl__npm"));
        assert!(
            tools.iter().all(|tool| tool["type"] != json!("namespace")),
            "no namespace container may cross provider wire payload: {tools:?}"
        );
    }

    #[test]
    fn wire_namespace_tool_empty_children_fails_explicitly() {
        let body = json!({
            "model": "upstream-model",
            "input": "hello",
            "tools": [
                {"type": "namespace", "name": "mcp__node_repl", "tools": []}
            ]
        });
        let error = build_v3_provider_12_responses_wire_payload("req-empty-ns", target(), body)
            .expect_err("empty namespace container must fail explicitly, not reach provider");
        assert!(matches!(
            error,
            V3ProviderError::NamespaceToolFlattenFailed { request_id, .. } if request_id == "req-empty-ns"
        ));
    }

    #[test]
    fn wire_flattens_namespace_children_into_dual_field_functions_for_openai_chat_provider() {
        let mut chat_target = target();
        chat_target.provider_type = "openai_chat".into();
        let body = json!({
            "model": "upstream-model",
            "input": "hello",
            "tools": [
                {"type": "function", "function": {"name": "plain_tool", "description": "d", "parameters": {"type": "object"}}},
                {
                    "type": "namespace",
                    "name": "mcp__node_repl",
                    "tools": [
                        {"type": "function", "name": "mcp__node_repl__js", "description": "run js", "parameters": {"type": "object", "properties": {}}, "strict": false},
                        {"type": "function", "name": "mcp__node_repl__npm", "description": "npm", "parameters": {"type": "object", "properties": {}}}
                    ]
                }
            ]
        });
        let wire = build_v3_provider_12_responses_wire_payload(
            "req-ns-chat",
            chat_target,
            body,
        )
        .unwrap();
        let tools = wire.body()["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 3, "namespace container must be replaced by its children: {tools:?}");
        assert_eq!(tools[0], json!({
            "type": "function",
            "name": "plain_tool",
            "function": {"name": "plain_tool", "description": "d", "parameters": {"type": "object"}}
        }), "Console Go requires dual-field tools (top-level name + nested function): {:?}", tools[0]);
        assert_eq!(tools[1], json!({
            "type": "function",
            "name": "mcp__node_repl__js",
            "function": {
                "name": "mcp__node_repl__js",
                "description": "run js",
                "parameters": {"type": "object", "properties": {}},
                "strict": false
            }
        }), "Console Go requires dual-field tools (top-level name + nested function): {:?}", tools[1]);
        assert_eq!(tools[2]["type"], json!("function"));
        assert_eq!(tools[2]["name"], json!("mcp__node_repl__npm"));
        assert_eq!(tools[2]["function"]["name"], json!("mcp__node_repl__npm"));
        assert!(
            tools.iter().all(|tool| tool["type"] != json!("namespace")),
            "no namespace container may cross provider wire payload: {tools:?}"
        );
    }

    #[test]
    fn openai_chat_normalizes_flat_client_function_tools_to_dual_field_without_namespace() {
        let mut chat_target = target();
        chat_target.provider_type = "openai_chat".into();
        // OneStop 会话实际形状：无 namespace、纯嵌套 function（缺顶层 name），
        // 原样透传会导致 Console Go 上游 400 missing field `name`。
        let body = json!({
            "model": "upstream-model",
            "input": "say hi in one word",
            "tools": [
                {"type": "function", "function": {"name": "plain_tool", "description": "d", "parameters": {"properties": {}, "type": "object"}}}
            ]
        });
        let wire = build_v3_provider_12_responses_wire_payload("req-chat-plain", chat_target, body)
            .unwrap();
        let tools = wire.body()["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0], json!({
            "type": "function",
            "name": "plain_tool",
            "function": {"name": "plain_tool", "description": "d", "parameters": {"properties": {}, "type": "object"}}
        }), "Console Go rejects nested-only tools; wire must add top-level name: {:?}", tools[0]);
    }

    #[test]
    fn openai_responses_provider_keeps_flat_tool_shape_untouched() {
        let body = json!({
            "model": "upstream-model",
            "input": "hello",
            "tools": [
                {"type": "function", "name": "plain_tool", "description": "d", "parameters": {"type": "object", "properties": {}}}
            ]
        });
        let wire = build_v3_provider_12_responses_wire_payload("req-flat", target(), body).unwrap();
        assert_eq!(wire.body()["tools"], json!([
            {"type": "function", "name": "plain_tool", "description": "d", "parameters": {"type": "object", "properties": {}}}
        ]), "standard responses provider must keep flat function shape unchanged");
    }

    #[test]
    fn wire_rejects_routing_capability_control_keys_before_provider_transport() {
        let body = json!({
            "model":"upstream-model",
            "input":"hello",
            "request_capabilities":["vision"]
        });
        let error = build_v3_provider_12_responses_wire_payload("req-cap", target(), body)
            .expect_err("request capability facts are control-plane, not provider payload");
        assert!(matches!(
            error,
            V3ProviderError::ControlFieldInWireBody {
                request_id,
                field: "request_capabilities"
            } if request_id == "req-cap"
        ));
    }

    #[test]
    fn canonical_control_key_guard_rejects_route_facts_and_keeps_client_metadata_data_plane() {
        assert!(!V3_ROUTECODEX_CONTROL_PAYLOAD_KEYS.contains(&"metadata"));
        assert!(!V3_ROUTECODEX_CONTROL_PAYLOAD_KEYS.contains(&"client_metadata"));
        assert_eq!(
            find_v3_routecodex_control_payload_key(&json!({
                "metadata": {"client": "kept"},
                "client_metadata": {"session_id": "client-owned"}
            })),
            None
        );
        assert_eq!(
            find_v3_routecodex_control_payload_key(&json!({
                "input": "hello",
                "routeHint": {"route": "must-not-enter-wire"}
            })),
            Some("routeHint")
        );
        assert_eq!(
            find_v3_routecodex_control_payload_key(&json!({
                "input": "hello",
                "opaque_target": {"target": "must-not-enter-wire"}
            })),
            Some("opaque_target")
        );
    }

    #[test]
    fn opencode_go_deepseek_responses_wire_omits_thinking_stopless_tool_choice() {
        let mut selected = target();
        selected.provider_id = "opencode-go".into();
        selected.provider_type = "openai_chat".into();
        selected.canonical_model_id = "deepseek-v4-flash".into();
        selected.wire_model = "deepseek-v4-flash".into();
        let wire = build_v3_provider_12_responses_wire_payload(
            "req-deepseek-stopless",
            selected,
            json!({
                "model": "deepseek-v4-flash",
                "input": "continue",
                "reasoning": {"effort": "high"},
                "tool_choice": "required",
                "tools": [{
                    "type": "function",
                    "name": "reasoningStop",
                    "description": "stopless control"
                }]
            }),
        )
        .expect("DeepSeek Responses wire must not reject Stopless thinking mode");
        assert!(wire.body().get("tool_choice").is_none());
        assert!(wire.body()["tools"].as_array().is_some_and(|tools| {
            tools.iter().any(|tool| {
                tool.pointer("/function/name").and_then(Value::as_str) == Some("reasoningStop")
            })
        }));
    }

    fn target() -> V3ResponsesProviderTarget {
        V3ResponsesProviderTarget {
            provider_id: "neutral-provider".into(),
            provider_type: "responses".into(),
            base_url: "http://upstream.invalid/v1".into(),
            canonical_model_id: "canonical-model".into(),
            wire_model: "upstream-model".into(),
            auth: V3ProviderAuthHandle {
                alias: "primary".into(),
                secret: V3ProviderAuthSecretHandle::Environment("NEUTRAL_KEY".into()),
            },
            responses_transport: V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
            provider_request_cleanup: Default::default(),
            request_timeout_ms: 300_000,
            initial_concurrency_budget: 8,
        }
    }

    fn cleanup_target(fields: &[&str]) -> V3ResponsesProviderTarget {
        let mut target = target();
        target.provider_request_cleanup.historical_fields =
            fields.iter().map(|field| field.to_string()).collect();
        target
    }

    #[test]
    fn wire_strips_encrypted_reasoning_content_for_non_gpt_target() {
        let mut target = target();
        target.canonical_model_id = "deepseek-v4-flash".into();
        let body = json!({
            "model": "upstream-model",
            "input": [
                {
                    "type": "reasoning",
                    "id": "item_rsn_1",
                    "summary": [{"type": "summary_text", "text": "plain summary"}],
                    "encrypted_content": "rsn_encrypted",
                    "content": null
                },
                {
                    "type": "reasoning",
                    "id": "item_rsn_2",
                    "encrypted_content": "rsn_only",
                    "content": null,
                    "summary": null
                },
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "user turn"}]
                }
            ]
        });
        let wire = build_v3_provider_12_responses_wire_payload("req-1", target, body).unwrap();
        let input = wire.body()["input"].as_array().unwrap();
        assert_eq!(
            input.len(),
            3,
            "encrypted-only reasoning item is kept as non-empty text placeholder (opencode DeepSeek requires non-empty reasoning_text on every assistant reasoning item)"
        );
        assert_eq!(input[0]["type"], "reasoning");
        assert_eq!(
            input[0]["summary"],
            json!([{"type": "summary_text", "text": "plain summary"}])
        );
        assert!(
            input[0].get("encrypted_content").is_none(),
            "encrypted_content must be stripped for non-gpt target"
        );
        assert_eq!(input[1]["type"], "reasoning");
        assert_eq!(
            input[1]["text"], "[thinking redacted]",
            "empty reasoning item becomes non-empty text placeholder; empty or missing reasoning_text triggers upstream 400 `reasoning_text must be passed back`"
        );
        assert!(
            input[1].get("encrypted_content").is_none(),
            "placeholder must not carry encrypted_content"
        );
        assert_eq!(input[2]["type"], "message");
    }

    #[test]
    fn wire_keeps_encrypted_reasoning_content_for_gpt_target() {
        let mut target = target();
        target.canonical_model_id = "gpt-5.6-sol".into();
        let body = json!({
            "model": "upstream-model",
            "input": [
                {
                    "type": "reasoning",
                    "id": "item_rsn_1",
                    "summary": [{"type": "summary_text", "text": "plain summary"}],
                    "encrypted_content": "rsn_encrypted"
                }
            ]
        });
        let wire = build_v3_provider_12_responses_wire_payload("req-1", target, body).unwrap();
        let input = wire.body()["input"].as_array().unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["encrypted_content"], "rsn_encrypted");
    }

    #[test]
    fn response_cipher_policy_strips_codex_cipher_but_keeps_anthropic_signature() {
        let mut payload = json!({
            "status": "completed",
            "output": [
                {
                    "type": "reasoning",
                    "id": "rs_rsn",
                    "encrypted_content": "rsn_CIPHERTEXT",
                    "summary": [{"type": "summary_text", "text": "plain"}]
                },
                {
                    "type": "reasoning",
                    "id": "rs_gaaaa",
                    "encrypted_content": "gAAAA_cipher",
                    "content": [{"type": "reasoning_text", "text": "visible"}]
                },
                {
                    "type": "reasoning",
                    "id": "rs_sig",
                    "encrypted_content": "anthropic-signature-value",
                    "summary": [{"type": "summary_text", "text": "signed"}]
                }
            ]
        });
        apply_v3_response_cipher_policy(&mut payload, false);
        assert!(
            !payload.to_string().contains("rsn_CIPHERTEXT"),
            "rsn_ cipher must be stripped"
        );
        assert!(
            !payload.to_string().contains("gAAAA_cipher"),
            "gAAAA cipher must be stripped"
        );
        assert_eq!(
            payload["output"][2]["encrypted_content"], "anthropic-signature-value",
            "non-rsn_/gAAAA signature carrier is not Codex cipher and must be kept"
        );
        assert_eq!(payload["output"][0]["summary"][0]["text"], "plain");
        assert_eq!(payload["output"][1]["content"][0]["text"], "visible");

        let mut retained =
            json!({"output": [{"type": "reasoning", "encrypted_content": "rsn_KEEP"}]});
        apply_v3_response_cipher_policy(&mut retained, true);
        assert_eq!(
            retained["output"][0]["encrypted_content"], "rsn_KEEP",
            "retain=true must keep cipher verbatim"
        );
    }
}

/// thinking 模式判定：`reasoning.effort` 或顶层 `reasoning_effort` 非空且
/// 非 "none" 才视为 thinking（`{"effort":"none"}` 显式关闭推理不是 thinking）。
fn v3_wire_payload_is_thinking_mode(body: &Value) -> bool {
    let effort = body
        .get("reasoning")
        .and_then(|reasoning| reasoning.get("effort"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "none");
    if effort.is_some() {
        return true;
    }
    body.get("reasoning_effort")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty() && value != "none")
}
