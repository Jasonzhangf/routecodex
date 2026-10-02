// feature_id: v3.admin_api
//! Provider model authoring: model CRUD on an existing provider (E1) and the
//! capability test that gates a manual capability tick (E3).
//!
//! E1 is a server-side read-modify-write on `<config_dir>/provider/<id>/config.v2.toml`
//! so the client never round-trips a whole provider config. Validation, backup and
//! revision come from Config Core (`routecodex-v3-config-mgmt`) exactly like every
//! other provider write, so a rejected candidate writes nothing.
//!
//! E3 is a read-only operator diagnostic: it sends real provider requests through the
//! runtime provider path and returns the per-capability outcome to the caller. It never
//! writes the provider file and never mutates provider health or cooldown state.

use crate::api::providers::{config_dir, now_ms};
use crate::provider_onboarding::{api_error, candidate_invalid_error, ApiError};
use crate::provider_probe::SecretRedactor;
use crate::AppState;
use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use routecodex_v3_config::V2ProviderModelConfig;
use routecodex_v3_config_mgmt::provider::{
    compile_provider_candidate_manifest, provider_file_source_sha256, read_provider_file,
    validate_provider_candidate, write_provider_file_with_backup, V2_PROVIDER_CONFIG_FILE_NAME,
};
use routecodex_v3_provider_responses::{
    build_v3_provider_global_request, ProviderResponsesTransport, ResponsesTransport,
    V3ProviderError, V3ResponsesProviderTarget,
};
use routecodex_v3_runtime::build_v3_provider_global_probe_target;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/providers/:id/models", post(mutate_provider_models))
        .route(
            "/api/providers/:id/models/capability-test",
            post(test_provider_model_capabilities),
        )
}

// ---------------------------------------------------------------------------
// E1 - POST /api/providers/:id/models
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelMutationRequest {
    /// 新增/编辑的模型条目；值就是 provider 文件里的 model 字段，不含任何控制标志。
    #[serde(default)]
    pub add: BTreeMap<String, V2ProviderModelConfig>,
    /// 顶层控制字段：`add` 里允许覆盖既有条目的名字。
    #[serde(default)]
    pub replace: Vec<String>,
    #[serde(default)]
    pub remove: Vec<String>,
    /// 结果 defaultModel；缺省或 null 表示不改动（provider 文件的 defaultModel 是必填字段）。
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

/// 对已存在 provider 的模型表做一次原子 read-modify-write。
///
/// `remove` 先于 `add`：同一次请求里先删后加同名条目是显式编辑，不是冲突。
async fn mutate_provider_models(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<ModelMutationRequest>,
) -> Result<Json<Value>, ApiError> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "provider_id_required",
            "provider id path segment is required",
        ));
    }
    if request.add.is_empty() && request.remove.is_empty() {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "no_model_mutation",
            "provide `add` and/or `remove`; a `defaultModel`-only request is not a model mutation",
        ));
    }
    let config_dir = config_dir(&state);
    let entry = read_provider_file(&config_dir, &id)
        .map_err(|error| api_error(StatusCode::NOT_FOUND, "provider_not_found", error))?;
    let mut config = entry.config;
    let current_default = config.provider.default_model.clone();

    for name in &request.remove {
        if !config.provider.models.contains_key(name) {
            return Err(api_error(
                StatusCode::NOT_FOUND,
                "model_not_found",
                format!("provider {id} has no model {name:?} to remove"),
            ));
        }
    }
    for name in request.add.keys() {
        let removed_in_this_request = request.remove.iter().any(|removed| removed == name);
        let replaced_in_this_request = request.replace.iter().any(|replaced| replaced == name);
        if config.provider.models.contains_key(name)
            && !removed_in_this_request
            && !replaced_in_this_request
        {
            return Err(api_error(
                StatusCode::CONFLICT,
                "model_exists",
                format!(
                    "provider {id} already has model {name:?}; list it in `replace` to overwrite it"
                ),
            ));
        }
    }
    let drops_default = !current_default.trim().is_empty()
        && request
            .remove
            .iter()
            .any(|removed| removed == &current_default)
        && request.default_model.is_none()
        && !request.add.contains_key(&current_default);
    if drops_default {
        return Err(api_error(
            StatusCode::CONFLICT,
            "default_model_in_use",
            format!(
                "removing model {current_default:?} would drop defaultModel; set `defaultModel` or re-add that model in the same request"
            ),
        ));
    }

    for name in &request.remove {
        config.provider.models.remove(name);
    }
    for (name, model) in request.add {
        config.provider.models.insert(name, model);
    }
    if let Some(default_model) = request.default_model {
        config.provider.default_model = default_model;
    }
    if config.provider.models.is_empty() && !config.provider.default_model.trim().is_empty() {
        return Err(api_error(
            StatusCode::CONFLICT,
            "default_model_requires_model",
            "an empty model map cannot keep a defaultModel",
        ));
    }

    let validation = validate_provider_candidate(&id, &config);
    if !validation.ok {
        return Err(candidate_invalid_error(&validation));
    }
    let source_sha256 = provider_file_source_sha256(&config_dir, &id);
    let (path, backup) =
        write_provider_file_with_backup(&config_dir, &id, &config).map_err(|error| {
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "provider_write_failed",
                error,
            )
        })?;
    let reason = request
        .reason
        .unwrap_or_else(|| "webui provider models update".to_string());
    let revision = state
        .store
        .revision_store()
        .append(
            "provider.models.update",
            &format!("provider/{id}/{V2_PROVIDER_CONFIG_FILE_NAME}"),
            &reason,
            backup.as_deref(),
            &source_sha256,
            "committed",
        )
        .map_err(|error| {
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "revision_append_failed",
                error.to_string(),
            )
        })?;
    Ok(Json(json!({
        "ok": true,
        "provider_id": id,
        "models": config.provider.models,
        "defaultModel": config.provider.default_model,
        "path": path.display().to_string(),
        "backup": backup.map(|path| path.display().to_string()),
        "source_sha256": source_sha256,
        "revision_seq": revision.seq,
    })))
}

// ---------------------------------------------------------------------------
// E3 - POST /api/providers/:id/models/capability-test
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct CapabilityTestRequest {
    pub model: String,
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct CapabilityTestResult {
    capability: String,
    tested: bool,
    passed: bool,
    detail: String,
    evidence: Value,
}

impl CapabilityTestResult {
    fn not_testable(capability: &str, detail: String) -> Self {
        Self {
            capability: capability.to_string(),
            tested: false,
            passed: false,
            detail,
            evidence: json!({ "provider_request_sent": false }),
        }
    }

    fn failed(capability: &str, detail: String, evidence: Value) -> Self {
        Self {
            capability: capability.to_string(),
            tested: true,
            passed: false,
            detail,
            evidence,
        }
    }
}

/// 只读能力诊断：对每个能力发一条真实 provider 请求并检查真实响应。
///
/// 无法用一条便宜且确定性的请求证明的能力返回 `tested: false`，绝不猜测。
async fn test_provider_model_capabilities(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<CapabilityTestRequest>,
) -> Result<Json<Value>, ApiError> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "provider_id_required",
            "provider id path segment is required",
        ));
    }
    if request.capabilities.is_empty() {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "capabilities_required",
            "provide at least one capability to test",
        ));
    }
    let model = request.model.trim().to_string();
    if model.is_empty() {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "model_required",
            "`model` is required",
        ));
    }
    let config_dir = config_dir(&state);
    let entry = read_provider_file(&config_dir, &id)
        .map_err(|error| api_error(StatusCode::NOT_FOUND, "provider_not_found", error))?;
    let manifest = compile_provider_candidate_manifest(&id, &entry.config).map_err(|error| {
        api_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "candidate_compile_failed",
            error,
        )
    })?;
    let target = build_v3_provider_global_probe_target(&manifest, &id, None, Some(model.as_str()))
        .map_err(|error| {
            api_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "probe_target_unavailable",
                error,
            )
        })?;
    let redactor = SecretRedactor::for_candidate(&entry.config);
    let mut results = Vec::with_capacity(request.capabilities.len());
    for capability in &request.capabilities {
        results.push(run_capability_test(&target, capability, &redactor).await);
    }
    Ok(Json(json!({
        "ok": true,
        "provider_id": id,
        "model": target.canonical_model_id,
        "results": results,
    })))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CapabilityUnderTest {
    Text,
    Tools,
    Vision,
    Reasoning,
}

impl CapabilityUnderTest {
    fn parse(capability: &str) -> Option<Self> {
        match capability.trim().to_ascii_lowercase().as_str() {
            "text" => Some(Self::Text),
            "tools" => Some(Self::Tools),
            "vision" => Some(Self::Vision),
            "thinking" | "reasoning" => Some(Self::Reasoning),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Tools => "tools",
            Self::Vision => "vision",
            Self::Reasoning => "reasoning",
        }
    }
}

async fn run_capability_test(
    target: &V3ResponsesProviderTarget,
    capability: &str,
    redactor: &SecretRedactor,
) -> CapabilityTestResult {
    let Some(under_test) = CapabilityUnderTest::parse(capability) else {
        return CapabilityTestResult::not_testable(
            capability,
            format!(
                "capability {capability:?} is not provable by one cheap deterministic provider request"
            ),
        );
    };
    let Some(body) = capability_request_body(&target.provider_type, &target.wire_model, under_test)
    else {
        return CapabilityTestResult::not_testable(
            capability,
            format!(
                "provider protocol {:?} cannot express capability {capability:?} in a diagnostic request",
                target.provider_type
            ),
        );
    };
    let request_id = format!(
        "admin-capability-{}-{}-{}",
        target.provider_id,
        under_test.label(),
        now_ms()
    );
    let built = match build_v3_provider_global_request(target.clone(), request_id.clone(), body) {
        Ok(built) => built,
        Err(error) => {
            return CapabilityTestResult::failed(
                capability,
                format!("provider request build failed: {error}"),
                json!({ "request_id": request_id }),
            )
        }
    };
    let url = built.url().to_string();
    match ProviderResponsesTransport::default().send(built).await {
        Ok(response) => {
            let status = response.status();
            let decoded = response
                .json_body()
                .and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok());
            let evidence = json!({
                "request_id": request_id,
                "url": url,
                "status": status,
                "response_excerpt": response
                    .json_body()
                    .map(|bytes| redactor.scrub(&preview(&String::from_utf8_lossy(bytes)))),
            });
            let Some(decoded) = decoded else {
                return CapabilityTestResult::failed(
                    capability,
                    format!("provider returned HTTP {status} without a JSON body"),
                    evidence,
                );
            };
            let passed = capability_satisfied(&target.provider_type, under_test, &decoded);
            CapabilityTestResult {
                capability: capability.to_string(),
                tested: true,
                passed,
                detail: capability_detail(under_test, passed).to_string(),
                evidence,
            }
        }
        Err(V3ProviderError::HttpStatus { response }) => {
            let evidence = json!({
                "request_id": request_id,
                "url": url,
                "status": response.status,
                "response_excerpt": redactor.scrub(&preview(&String::from_utf8_lossy(&response.body))),
            });
            CapabilityTestResult::failed(
                capability,
                format!("provider returned HTTP {}", response.status),
                evidence,
            )
        }
        Err(error) => CapabilityTestResult::failed(
            capability,
            error.to_string(),
            json!({ "request_id": request_id, "url": url }),
        ),
    }
}

/// 1x1 PNG（RGBA）常量：最小图片 part，只为证明 provider 接受图片输入。
const CAPABILITY_IMAGE_PNG_BASE64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

const CAPABILITY_PROMPT: &str = "routecodex capability probe: reply with the single word ok";

const CAPABILITY_TOOL_PROMPT: &str = "Call the probe_ping tool.";

fn capability_image_data_url() -> String {
    format!("data:image/png;base64,{CAPABILITY_IMAGE_PNG_BASE64}")
}

/// 每个 provider 协议 + 能力对应一条真实请求体；协议无法表达该能力时返回 None。
fn capability_request_body(
    provider_type: &str,
    wire_model: &str,
    capability: CapabilityUnderTest,
) -> Option<Value> {
    Some(match provider_type {
        "openai_chat" => match capability {
            CapabilityUnderTest::Text => json!({
                "model": wire_model,
                "messages": [{ "role": "user", "content": CAPABILITY_PROMPT }],
                "max_tokens": 16,
                "stream": false,
            }),
            CapabilityUnderTest::Tools => json!({
                "model": wire_model,
                "messages": [{ "role": "user", "content": CAPABILITY_TOOL_PROMPT }],
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "probe_ping",
                        "description": "routecodex capability probe",
                        "parameters": { "type": "object", "properties": {} },
                    },
                }],
                "tool_choice": { "type": "function", "function": { "name": "probe_ping" } },
                "max_tokens": 64,
                "stream": false,
            }),
            CapabilityUnderTest::Vision => json!({
                "model": wire_model,
                "messages": [{
                    "role": "user",
                    "content": [
                        { "type": "text", "text": CAPABILITY_PROMPT },
                        { "type": "image_url", "image_url": { "url": capability_image_data_url() } },
                    ],
                }],
                "max_tokens": 16,
                "stream": false,
            }),
            CapabilityUnderTest::Reasoning => json!({
                "model": wire_model,
                "messages": [{ "role": "user", "content": CAPABILITY_PROMPT }],
                "reasoning_effort": "low",
                "max_tokens": 512,
                "stream": false,
            }),
        },
        "anthropic" => match capability {
            CapabilityUnderTest::Text => json!({
                "model": wire_model,
                "max_tokens": 16,
                "messages": [{ "role": "user", "content": CAPABILITY_PROMPT }],
            }),
            CapabilityUnderTest::Tools => json!({
                "model": wire_model,
                "max_tokens": 64,
                "messages": [{ "role": "user", "content": CAPABILITY_TOOL_PROMPT }],
                "tools": [{
                    "name": "probe_ping",
                    "description": "routecodex capability probe",
                    "input_schema": { "type": "object", "properties": {} },
                }],
                "tool_choice": { "type": "tool", "name": "probe_ping" },
            }),
            CapabilityUnderTest::Vision => json!({
                "model": wire_model,
                "max_tokens": 16,
                "messages": [{
                    "role": "user",
                    "content": [
                        { "type": "text", "text": CAPABILITY_PROMPT },
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": CAPABILITY_IMAGE_PNG_BASE64,
                            },
                        },
                    ],
                }],
            }),
            CapabilityUnderTest::Reasoning => json!({
                "model": wire_model,
                "max_tokens": 1024,
                "thinking": { "type": "enabled", "budget_tokens": 512 },
                "messages": [{ "role": "user", "content": CAPABILITY_PROMPT }],
            }),
        },
        "gemini" => match capability {
            CapabilityUnderTest::Text => json!({
                "contents": [{ "role": "user", "parts": [{ "text": CAPABILITY_PROMPT }] }],
                "generationConfig": { "maxOutputTokens": 16 },
            }),
            CapabilityUnderTest::Tools => json!({
                "contents": [{ "role": "user", "parts": [{ "text": CAPABILITY_TOOL_PROMPT }] }],
                "tools": [{
                    "functionDeclarations": [{
                        "name": "probe_ping",
                        "description": "routecodex capability probe",
                        "parameters": { "type": "OBJECT", "properties": {} },
                    }],
                }],
                "toolConfig": { "functionCallingConfig": { "mode": "ANY" } },
                "generationConfig": { "maxOutputTokens": 64 },
            }),
            CapabilityUnderTest::Vision => json!({
                "contents": [{
                    "role": "user",
                    "parts": [
                        { "text": CAPABILITY_PROMPT },
                        { "inlineData": { "mimeType": "image/png", "data": CAPABILITY_IMAGE_PNG_BASE64 } },
                    ],
                }],
                "generationConfig": { "maxOutputTokens": 16 },
            }),
            CapabilityUnderTest::Reasoning => json!({
                "contents": [{ "role": "user", "parts": [{ "text": CAPABILITY_PROMPT }] }],
                "generationConfig": { "maxOutputTokens": 512, "thinkingConfig": { "includeThoughts": true } },
            }),
        },
        "responses" => match capability {
            CapabilityUnderTest::Text => json!({
                "model": wire_model,
                "input": [{
                    "role": "user",
                    "content": [{ "type": "input_text", "text": CAPABILITY_PROMPT }],
                }],
                "max_output_tokens": 16,
                "stream": false,
            }),
            CapabilityUnderTest::Tools => json!({
                "model": wire_model,
                "input": [{
                    "role": "user",
                    "content": [{ "type": "input_text", "text": CAPABILITY_TOOL_PROMPT }],
                }],
                "tools": [{
                    "type": "function",
                    "name": "probe_ping",
                    "description": "routecodex capability probe",
                    "parameters": { "type": "object", "properties": {} },
                }],
                "tool_choice": { "type": "function", "name": "probe_ping" },
                "max_output_tokens": 64,
                "stream": false,
            }),
            CapabilityUnderTest::Vision => json!({
                "model": wire_model,
                "input": [{
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": CAPABILITY_PROMPT },
                        { "type": "input_image", "image_url": capability_image_data_url() },
                    ],
                }],
                "max_output_tokens": 16,
                "stream": false,
            }),
            CapabilityUnderTest::Reasoning => json!({
                "model": wire_model,
                "input": [{
                    "role": "user",
                    "content": [{ "type": "input_text", "text": CAPABILITY_PROMPT }],
                }],
                "reasoning": { "effort": "low" },
                "max_output_tokens": 512,
                "stream": false,
            }),
        },
        _ => return None,
    })
}

fn capability_satisfied(
    provider_type: &str,
    capability: CapabilityUnderTest,
    body: &Value,
) -> bool {
    match capability {
        CapabilityUnderTest::Text | CapabilityUnderTest::Vision => {
            has_completion(provider_type, body)
        }
        CapabilityUnderTest::Tools => has_tool_call(provider_type, body),
        CapabilityUnderTest::Reasoning => has_reasoning_output(provider_type, body),
    }
}

fn capability_detail(capability: CapabilityUnderTest, passed: bool) -> &'static str {
    match (capability, passed) {
        (CapabilityUnderTest::Text, true) => {
            "provider returned a completion for a minimal text request"
        }
        (CapabilityUnderTest::Text, false) => {
            "provider answered the text request without a completion"
        }
        (CapabilityUnderTest::Tools, true) => "provider returned a tool call for the probe tool",
        (CapabilityUnderTest::Tools, false) => {
            "provider answered the tool request without a tool call"
        }
        (CapabilityUnderTest::Vision, true) => {
            "provider accepted a minimal image part and returned a completion"
        }
        (CapabilityUnderTest::Vision, false) => {
            "provider answered the image request without a completion"
        }
        (CapabilityUnderTest::Reasoning, true) => "provider returned reasoning output",
        (CapabilityUnderTest::Reasoning, false) => {
            "provider answered the reasoning request without reasoning output"
        }
    }
}

fn has_completion(provider_type: &str, body: &Value) -> bool {
    match provider_type {
        "openai_chat" => body
            .get("choices")
            .and_then(Value::as_array)
            .is_some_and(|choices| !choices.is_empty()),
        "anthropic" => body
            .get("content")
            .and_then(Value::as_array)
            .is_some_and(|content| !content.is_empty()),
        "gemini" => body
            .pointer("/candidates/0/content/parts")
            .and_then(Value::as_array)
            .is_some_and(|parts| !parts.is_empty()),
        "responses" => body
            .get("output")
            .and_then(Value::as_array)
            .is_some_and(|output| !output.is_empty()),
        _ => false,
    }
}

fn has_tool_call(provider_type: &str, body: &Value) -> bool {
    match provider_type {
        "openai_chat" => body
            .get("choices")
            .and_then(Value::as_array)
            .is_some_and(|choices| {
                choices.iter().any(|choice| {
                    let message = choice.get("message").unwrap_or(choice);
                    message
                        .get("tool_calls")
                        .and_then(Value::as_array)
                        .is_some_and(|calls| !calls.is_empty())
                })
            }),
        "anthropic" => body
            .get("content")
            .and_then(Value::as_array)
            .is_some_and(|content| {
                content
                    .iter()
                    .any(|part| part.get("type").and_then(Value::as_str) == Some("tool_use"))
            }),
        "gemini" => body
            .get("candidates")
            .and_then(Value::as_array)
            .is_some_and(|candidates| {
                candidates.iter().any(|candidate| {
                    candidate
                        .pointer("/content/parts")
                        .and_then(Value::as_array)
                        .is_some_and(|parts| {
                            parts.iter().any(|part| part.get("functionCall").is_some())
                        })
                })
            }),
        "responses" => body
            .get("output")
            .and_then(Value::as_array)
            .is_some_and(|output| {
                output
                    .iter()
                    .any(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
            }),
        _ => false,
    }
}

fn has_reasoning_output(provider_type: &str, body: &Value) -> bool {
    match provider_type {
        "openai_chat" => body
            .get("choices")
            .and_then(Value::as_array)
            .is_some_and(|choices| {
                choices.iter().any(|choice| {
                    let message = choice.get("message").unwrap_or(choice);
                    ["reasoning_content", "reasoning"]
                        .iter()
                        .any(|key| message.get(*key).is_some_and(non_empty))
                })
            }),
        "anthropic" => body
            .get("content")
            .and_then(Value::as_array)
            .is_some_and(|content| {
                content.iter().any(|part| {
                    matches!(
                        part.get("type").and_then(Value::as_str),
                        Some("thinking") | Some("redacted_thinking")
                    )
                })
            }),
        "gemini" => body
            .get("candidates")
            .and_then(Value::as_array)
            .is_some_and(|candidates| {
                candidates.iter().any(|candidate| {
                    candidate
                        .pointer("/content/parts")
                        .and_then(Value::as_array)
                        .is_some_and(|parts| {
                            parts.iter().any(|part| {
                                part.get("thought").and_then(Value::as_bool) == Some(true)
                            })
                        })
                })
            }),
        "responses" => body
            .get("output")
            .and_then(Value::as_array)
            .is_some_and(|output| {
                output
                    .iter()
                    .any(|item| item.get("type").and_then(Value::as_str) == Some("reasoning"))
            }),
        _ => false,
    }
}

fn non_empty(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(text) => !text.trim().is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
        Value::Bool(flag) => *flag,
        Value::Number(_) => true,
    }
}

/// 证据里的响应摘录：有界长度，且必须过 `SecretRedactor`。
fn preview(text: &str) -> String {
    const LIMIT: usize = 512;
    if text.chars().count() <= LIMIT {
        return text.to_string();
    }
    let mut excerpt: String = text.chars().take(LIMIT).collect();
    excerpt.push('…');
    excerpt
}
