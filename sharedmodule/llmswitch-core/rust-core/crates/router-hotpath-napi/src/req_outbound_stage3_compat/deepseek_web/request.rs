use serde_json::{Map, Value};

use self::history_context::{
    build_history_context_transcript, RCC_HISTORY_CONTENT_TYPE, RCC_HISTORY_FILENAME,
};
use self::prompt::{build_deepseek_continuation_prompt, build_deepseek_prompt};
use super::{read_trimmed_string, AdapterContext};

const SEARCH_ROUTE_PREFIXES: [&str; 2] = ["web_search", "search"];

mod history_context;
mod prompt;

fn read_optional_boolean(value: Option<&Value>) -> Option<bool> {
    match value {
        Some(Value::Bool(v)) => Some(*v),
        Some(Value::String(raw)) => {
            let normalized = raw.trim().to_ascii_lowercase();
            if ["true", "1", "yes", "on"].contains(&normalized.as_str()) {
                return Some(true);
            }
            if ["false", "0", "no", "off"].contains(&normalized.as_str()) {
                return Some(false);
            }
            None
        }
        _ => None,
    }
}

fn resolve_deepseek_options(adapter_context: &AdapterContext) -> (bool, bool) {
    let Some(deepseek) = adapter_context
        .deepseek
        .as_ref()
        .and_then(|v| v.as_object())
    else {
        return (true, true);
    };

    let strict_tool_required =
        read_optional_boolean(deepseek.get("strictToolRequired")).unwrap_or(true);
    let text_tool_fallback =
        read_optional_boolean(deepseek.get("textToolFallback")).unwrap_or(true);
    (strict_tool_required, text_tool_fallback)
}

fn resolve_model(root: &Map<String, Value>) -> String {
    read_trimmed_string(root.get("model")).unwrap_or_default()
}

fn normalize_model_token(model_raw: &str) -> String {
    let normalized = model_raw.trim().to_ascii_lowercase();
    normalized
        .strip_suffix("-nothinking")
        .unwrap_or(normalized.as_str())
        .to_string()
}

fn resolve_thinking_search_flags(model_raw: &str) -> (bool, bool) {
    let model = normalize_model_token(model_raw);
    if model == "deepseek-v3" || model == "deepseek-chat" {
        return (false, false);
    }
    if model == "deepseek-v4-flash" {
        return (false, false);
    }
    if model == "deepseek-r1" || model == "deepseek-reasoner" {
        return (true, false);
    }
    if model == "deepseek-v4-pro" {
        return (true, false);
    }
    if model == "deepseek-v3-search" || model == "deepseek-chat-search" {
        return (false, true);
    }
    if model == "deepseek-v4-flash-search" {
        return (false, true);
    }
    if model == "deepseek-r1-search" || model == "deepseek-reasoner-search" {
        return (true, true);
    }
    if model == "deepseek-v4-pro-search" {
        return (true, true);
    }
    (false, false)
}

fn resolve_model_type(model_raw: &str) -> &'static str {
    let model = normalize_model_token(model_raw);
    match model.as_str() {
        "deepseek-v4-pro"
        | "deepseek-v4-pro-search"
        | "deepseek-r1"
        | "deepseek-reasoner"
        | "deepseek-r1-search"
        | "deepseek-reasoner-search" => "expert",
        "deepseek-v4-vision" => "vision",
        _ => "default",
    }
}

fn resolve_explicit_thinking_flag(root: &Map<String, Value>, fallback: bool) -> bool {
    read_optional_boolean(root.get("thinking_enabled")).unwrap_or(fallback)
}

fn resolve_explicit_search_flag(root: &Map<String, Value>, fallback: bool) -> bool {
    read_optional_boolean(root.get("search_enabled")).unwrap_or(fallback)
}

fn should_force_search(root: &Map<String, Value>, adapter_context: &AdapterContext) -> bool {
    let route_id = adapter_context
        .route_id
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if SEARCH_ROUTE_PREFIXES
        .iter()
        .any(|prefix| route_id.starts_with(prefix))
    {
        return true;
    }
    root.get("web_search").and_then(|v| v.as_object()).is_some()
}

fn route_starts_with(adapter_context: &AdapterContext, prefixes: &[&str]) -> bool {
    let route_id = adapter_context
        .route_id
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    prefixes.iter().any(|prefix| route_id.starts_with(prefix))
}

fn has_declared_tools(root: &Map<String, Value>) -> bool {
    root.get("tools")
        .and_then(|v| v.as_array())
        .map(|rows| !rows.is_empty())
        .unwrap_or(false)
}

fn latest_message_role(root: &Map<String, Value>) -> Option<String> {
    root.get("messages")
        .and_then(|v| v.as_array())
        .and_then(|rows| rows.iter().rev().find_map(|item| item.as_object()))
        .and_then(|obj| read_trimmed_string(obj.get("role")))
        .map(|role| role.to_ascii_lowercase())
}

fn enrich_root_with_captured_semantics(
    root: &Map<String, Value>,
    adapter_context: &AdapterContext,
) -> Map<String, Value> {
    if root.contains_key("semantics") {
        return root.clone();
    }
    let mut next = root.clone();
    if let Some(semantics) = adapter_context
        .captured_chat_request
        .as_ref()
        .and_then(|value| value.as_object())
        .and_then(|row| row.get("semantics"))
    {
        next.insert("semantics".to_string(), semantics.clone());
    }
    next
}

fn deepseek_config_node<'a>(adapter_context: &'a AdapterContext) -> Option<&'a Map<String, Value>> {
    adapter_context
        .deepseek
        .as_ref()
        .and_then(|v| v.as_object())
}

fn metadata_deepseek_node<'a>(root: &'a Map<String, Value>) -> Option<&'a Map<String, Value>> {
    root.get("metadata")
        .and_then(|v| v.as_object())
        .and_then(|metadata| metadata.get("deepseek"))
        .and_then(|v| v.as_object())
}

fn read_boolean_from_node(node: Option<&Map<String, Value>>, key: &str) -> Option<bool> {
    node.and_then(|obj| read_optional_boolean(obj.get(key)))
}

fn should_enable_context_file(root: &Map<String, Value>, adapter_context: &AdapterContext) -> bool {
    read_boolean_from_node(metadata_deepseek_node(root), "contextFileEnabled")
        .or_else(|| {
            metadata_deepseek_node(root)
                .and_then(|obj| obj.get("contextFile"))
                .and_then(|v| v.as_object())
                .and_then(|obj| read_optional_boolean(obj.get("enabled")))
        })
        .or_else(|| {
            read_boolean_from_node(deepseek_config_node(adapter_context), "contextFileEnabled")
        })
        .or_else(|| {
            deepseek_config_node(adapter_context)
                .and_then(|obj| obj.get("contextFile"))
                .and_then(|v| v.as_object())
                .and_then(|obj| read_optional_boolean(obj.get("enabled")))
        })
        .unwrap_or(false)
}

fn append_context_file_metadata(metadata: &mut Map<String, Value>, transcript: &str) {
    let mut deepseek = metadata
        .get("deepseek")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let mut context_file = Map::new();
    context_file.insert(
        "filename".to_string(),
        Value::String(RCC_HISTORY_FILENAME.to_string()),
    );
    context_file.insert("content".to_string(), Value::String(transcript.to_string()));
    context_file.insert(
        "contentType".to_string(),
        Value::String(RCC_HISTORY_CONTENT_TYPE.to_string()),
    );
    context_file.insert("enabled".to_string(), Value::Bool(true));
    deepseek.insert("contextFile".to_string(), Value::Object(context_file));
    deepseek.insert("contextFileEnabled".to_string(), Value::Bool(true));
    metadata.insert("deepseek".to_string(), Value::Object(deepseek));
}

fn read_image_url_from_part(obj: &Map<String, Value>) -> Option<String> {
    let type_value = read_trimmed_string(obj.get("type"))
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if !matches!(type_value.as_str(), "input_image" | "image" | "image_url") {
        return None;
    }

    if let Some(raw) = read_trimmed_string(obj.get("image_url")) {
        return Some(raw);
    }

    if let Some(image_url_obj) = obj.get("image_url").and_then(|value| value.as_object()) {
        if let Some(raw) = read_trimmed_string(image_url_obj.get("url")) {
            return Some(raw);
        }
    }

    read_trimmed_string(obj.get("url"))
}

fn infer_inline_filename(image_url: &str, index: usize) -> String {
    let trimmed = image_url.trim();
    if trimmed.starts_with("data:") {
        let media_type = trimmed
            .strip_prefix("data:")
            .and_then(|rest| rest.split([';', ',']).next())
            .unwrap_or("image/png")
            .trim()
            .to_ascii_lowercase();
        let ext = media_type
            .split('/')
            .nth(1)
            .filter(|value| !value.is_empty())
            .unwrap_or("png");
        return format!("inline-image-{}.{}", index, ext);
    }

    let candidate = trimmed
        .split(['?', '#'])
        .next()
        .unwrap_or(trimmed)
        .rsplit('/')
        .next()
        .unwrap_or("")
        .trim();
    if !candidate.is_empty() {
        return candidate.to_string();
    }

    format!("inline-image-{}.png", index)
}

fn collect_inline_image_contracts(root: &Map<String, Value>) -> Vec<Value> {
    let rows = root
        .get("messages")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out: Vec<Value> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for item in rows {
        let Some(message) = item.as_object() else {
            continue;
        };
        let Some(parts) = message.get("content").and_then(|value| value.as_array()) else {
            continue;
        };
        for part in parts {
            let Some(obj) = part.as_object() else {
                continue;
            };
            let Some(image_url) = read_image_url_from_part(obj) else {
                continue;
            };
            if seen.iter().any(|value| value == &image_url) {
                continue;
            }
            seen.push(image_url.clone());
            let filename = infer_inline_filename(image_url.as_str(), seen.len());
            out.push(Value::Object(Map::from_iter([
                ("type".to_string(), Value::String("image".to_string())),
                ("imageUrl".to_string(), Value::String(image_url)),
                ("filename".to_string(), Value::String(filename)),
            ])));
        }
    }
    out
}

fn append_inline_file_metadata(metadata: &mut Map<String, Value>, files: &[Value]) {
    if files.is_empty() {
        return;
    }
    let mut deepseek = metadata
        .get("deepseek")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let mut inline_files = Map::new();
    inline_files.insert("enabled".to_string(), Value::Bool(true));
    inline_files.insert("files".to_string(), Value::Array(files.to_vec()));
    deepseek.insert("inlineFiles".to_string(), Value::Object(inline_files));
    metadata.insert("deepseek".to_string(), Value::Object(deepseek));
}

fn should_force_tool_required(
    root: &Map<String, Value>,
    adapter_context: &AdapterContext,
    strict_tool_required: bool,
    search_enabled: bool,
) -> bool {
    if !strict_tool_required || !has_declared_tools(root) {
        return false;
    }
    if latest_message_role(root).as_deref() == Some("tool") {
        return false;
    }
    if route_starts_with(adapter_context, &["thinking"]) {
        return true;
    }
    if route_starts_with(adapter_context, &["coding"]) {
        return true;
    }
    if route_starts_with(adapter_context, &["tools"]) {
        return true;
    }
    if search_enabled && route_starts_with(adapter_context, &SEARCH_ROUTE_PREFIXES) {
        return true;
    }
    false
}

pub(crate) fn apply_deepseek_web_request_compat(
    payload: Value,
    adapter_context: &AdapterContext,
) -> Value {
    let Some(raw_root) = payload.as_object() else {
        return payload;
    };
    let root = enrich_root_with_captured_semantics(raw_root, adapter_context);

    let model = resolve_model(&root);
    let (thinking_by_model, search_by_model) = resolve_thinking_search_flags(&model);
    let model_type = resolve_model_type(&model);
    let thinking_enabled = resolve_explicit_thinking_flag(&root, thinking_by_model);
    let search_enabled = if should_force_search(&root, adapter_context) {
        true
    } else {
        resolve_explicit_search_flag(&root, search_by_model)
    };
    let (strict_tool_required, text_tool_fallback) = resolve_deepseek_options(adapter_context);
    let force_tool_required =
        should_force_tool_required(&root, adapter_context, strict_tool_required, search_enabled);
    let context_file_enabled = should_enable_context_file(&root, adapter_context);
    let history_transcript = if context_file_enabled {
        build_history_context_transcript(&root)
    } else {
        None
    };
    let inline_image_files = collect_inline_image_contracts(&root);
    let prompt = if history_transcript.is_some() {
        build_deepseek_continuation_prompt(&root, force_tool_required)
    } else {
        build_deepseek_prompt(&root, force_tool_required)
    };

    let mut next = Map::<String, Value>::new();
    if let Some(chat_session_id) = read_trimmed_string(raw_root.get("chat_session_id")) {
        next.insert(
            "chat_session_id".to_string(),
            Value::String(chat_session_id),
        );
    }
    next.insert(
        "parent_message_id".to_string(),
        read_trimmed_string(raw_root.get("parent_message_id"))
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    next.insert("prompt".to_string(), Value::String(prompt));
    next.insert(
        "ref_file_ids".to_string(),
        raw_root
            .get("ref_file_ids")
            .and_then(|v| v.as_array())
            .map(|v| Value::Array(v.clone()))
            .unwrap_or_else(|| Value::Array(Vec::new())),
    );
    next.insert(
        "thinking_enabled".to_string(),
        Value::Bool(thinking_enabled),
    );
    next.insert("search_enabled".to_string(), Value::Bool(search_enabled));
    next.insert(
        "model_type".to_string(),
        Value::String(model_type.to_string()),
    );
    if raw_root.get("stream") == Some(&Value::Bool(true)) {
        next.insert("stream".to_string(), Value::Bool(true));
    }

    let mut metadata = raw_root
        .get("metadata")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let mut deepseek = metadata
        .get("deepseek")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    deepseek.insert(
        "strictToolRequired".to_string(),
        Value::Bool(strict_tool_required),
    );
    deepseek.insert(
        "textToolFallback".to_string(),
        Value::Bool(text_tool_fallback),
    );
    metadata.insert("deepseek".to_string(), Value::Object(deepseek));
    if let Some(transcript) = history_transcript.as_deref() {
        append_context_file_metadata(&mut metadata, transcript);
    }
    append_inline_file_metadata(&mut metadata, inline_image_files.as_slice());
    next.insert("metadata".to_string(), Value::Object(metadata));

    Value::Object(next)
}
