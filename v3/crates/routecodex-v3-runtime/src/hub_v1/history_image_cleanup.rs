// feature: 唯一登记的历史图片清理例外 —— 历史图片统一占位清理（最小恢复）
//
// 规则（Jason 2026-10-06，恢复自 736607d 删除的 history_image_cleanup.rs）：
// - 纯函数、无状态；同一 body 必产出同一结果；不读任何跨请求状态。
// - 仅清理当前轮起点之前的图片；当前轮（最后一个 user run 及其后的工具段）
//   内的所有用户图片与工具图片完整保留；多个同轮载体不得只保留最后一个。
//   当前轮边界复用 route-classifier 的 typed current-turn 投影，与路由事实
//   保持同一语义；后续纯文本提醒不改变图片边界。
// - 历史图片 part 原位替换为统一固定文本占位符 {"type":"text","text":"[Image]"}
//   （chat wire）/ {"type":"input_text","text":"[Image]"}（responses wire）；
//   无编号、无前缀、不随图片数量/位置变化 —— 同位置永远同 token。
// - 消息结构保持：只有图片的消息 content 变为 ["[Image]"]，不产生空消息。
// - 占位符保留图片 part 上的无关 opaque 字段（如 future_sibling），只在确定性
//   图片字段与 type 上改写，保证 cache 命中与历史关联稳定。
use routecodex_v3_route_classifier::{
    is_v3_inline_image_reference, project_v3_current_turn_entries_from_value, ChatTurnRole,
    GeminiTurnRole, ResponsesTurnKind, ResponsesTurnRole, V3CurrentTurnEntries,
};
use serde_json::{Map, Value};

/// 统一占位符文本（chat wire 与 responses wire 共用同一字符串，保证确定性）。
pub(crate) const V3_HISTORY_IMAGE_PLACEHOLDER: &str = "[Image]";

fn is_v3_text_content_part(row: &Map<String, Value>) -> bool {
    matches!(
        row.get("type").and_then(Value::as_str),
        Some("text" | "input_text" | "output_text")
    )
}

/// 统计 payload 中图片引用数（临时诊断辅助：image_url / data / file_id /
/// file_url 键的 part）。
pub(crate) fn count_v3_payload_image_refs(body: &Value) -> usize {
    let mut total = 0;
    if let Some(input) = body.get("input").and_then(Value::as_array) {
        for item in input {
            total += count_v3_item_image_refs(item);
        }
    }
    if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        for message in messages {
            total += count_v3_item_image_refs(message);
        }
    }
    total
}

fn count_v3_item_image_refs(item: &Value) -> usize {
    if is_top_level_input_image(item) {
        return 1;
    }
    ["content", "output", "parts"]
        .iter()
        .map(|field| match item.get(*field) {
            Some(Value::String(_))
                if *field == "content"
                    && item.get("role").and_then(Value::as_str) != Some("tool") =>
            {
                0
            }
            Some(value) => count_v3_image_refs(value),
            None => 0,
        })
        .sum()
}

fn count_v3_image_refs(value: &Value) -> usize {
    match value {
        Value::Array(parts) => parts.iter().map(count_v3_image_refs).sum(),
        Value::Object(row) => {
            if is_v3_text_content_part(row) {
                return 0;
            }
            let image_type = matches!(
                row.get("type").and_then(Value::as_str),
                Some("image" | "input_image" | "output_image" | "image_url")
            );
            let image_reference = is_v3_embedded_image_carrier(row);
            if image_reference
                || row.contains_key("inline_data")
                || row.contains_key("file_data")
                || image_type
            {
                1
            } else {
                row.values().map(count_v3_image_refs).sum()
            }
        }
        Value::String(text) => serde_json::from_str::<Value>(text)
            .map(|parsed| count_v3_image_refs(&parsed))
            .unwrap_or_else(|_| usize::from(is_v3_inline_image_reference(text))),
        _ => 0,
    }
}

/// 历史图片统一占位清理（唯一清洗真源）。调用仅限 Anthropic 入口在已选择
/// OpenAI-Chat 目标后的出站投影；其他目标保留原始图片载体。
///
/// ## 边界（历史轮定义，统一）
/// - 当前轮起点（最后一个 user run 的起点，及其后的工具段）之前的图片属于历史，
///   清洗为占位符；
/// - 当前轮内的所有图片保留，包括同一轮的多个用户图片载体和多个工具图片载体；
/// - 起点直接复用 route-classifier 的 typed current-turn 投影，禁止在本文件另行
///   定义一套分类边界；时间提醒、模型切换提示等后续纯文本消息不改变图片边界。
///
/// ## 形态（全部覆盖）
/// - messages[]：content 数组的 image_url/data/file_id part + tool 消息字符串
///   content（JSON 数组字符串——解析后清洗）；
/// - input[]：item content 的 input_image/image_url part + function_call_output
///   output 数组（含无 type 字段的 image_url/data/file_id/file_url part）+ 顶层
///   input_image/output_image item；
/// - contents[]（gemini）：parts 的 inline_data/file_data/image。
///
/// 替换占位符：chat 用 `{"type":"text","text":"[Image]"}`，responses 用
/// `{"type":"input_text","text":"[Image]"}`——字节级确定性（任意 base64 →
/// 相同占位符 → 历史 wire 稳定 → provider 前缀缓存命中）。
pub(crate) fn normalize_v3_history_image_placeholders(body: &mut Value) {
    let entries = project_v3_current_turn_entries_from_value(body);
    if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
        // 最新图片载体即使位于历史轮也保留（例如工具结果截图后又有纯文本轮的追问），
        // 只把更早的图片载体替换为占位符；当前轮图片始终保留。
        let latest_image = messages
            .iter()
            .rposition(|message| count_v3_item_image_refs(message) > 0);
        let current_turn_start =
            chat_current_turn_start(&entries).unwrap_or_else(|| latest_image.unwrap_or(0));
        for (index, message) in messages.iter_mut().enumerate().take(current_turn_start) {
            if Some(index) == latest_image {
                continue;
            }
            normalize_chat_content_parts(message);
        }
        return;
    }
    if let Some(input) = body.get_mut("input").and_then(Value::as_array_mut) {
        let latest_image = input
            .iter()
            .rposition(|item| count_v3_item_image_refs(item) > 0);
        let current_turn_start =
            responses_current_turn_start(&entries).unwrap_or_else(|| latest_image.unwrap_or(0));
        for (index, item) in input.iter_mut().enumerate().take(current_turn_start) {
            if Some(index) == latest_image {
                continue;
            }
            normalize_responses_content_parts(item);
            normalize_responses_output_parts(item);
            if is_top_level_input_image(item) {
                if let Some(row) = item.as_object_mut() {
                    replace_image_carrier_with_placeholder(row, Some("input_text"));
                }
            }
        }
        return;
    }
    if let Some(contents) = body.get_mut("contents").and_then(Value::as_array_mut) {
        let latest_image = contents
            .iter()
            .rposition(|content| count_v3_item_image_refs(content) > 0);
        let current_turn_start =
            gemini_current_turn_start(&entries).unwrap_or_else(|| latest_image.unwrap_or(0));
        for (index, content) in contents.iter_mut().enumerate().take(current_turn_start) {
            if Some(index) == latest_image {
                continue;
            }
            normalize_gemini_content_parts(content);
        }
    }
}

/// Chat current-turn start: the first item of the trailing consecutive user
/// run. Mirrors the route-classifier typed boundary so the cleanup and the
/// routing fact see the same turn. `None` keeps the legacy last-carrier
/// boundary for payloads without a typed current-turn user.
fn chat_current_turn_start(entries: &V3CurrentTurnEntries) -> Option<usize> {
    let V3CurrentTurnEntries::Chat(entries) = entries else {
        return None;
    };
    let mut start = entries
        .iter()
        .rposition(|entry| matches!(entry.role, ChatTurnRole::User))?;
    while start > 0 && matches!(entries[start - 1].role, ChatTurnRole::User) {
        start -= 1;
    }
    Some(start)
}

/// Responses current-turn start: the first item of the trailing consecutive
/// user run, including a trailing explicit message item. Mirrors the
/// route-classifier typed boundary. `None` keeps the legacy last-carrier
/// boundary for payloads without a typed current-turn user.
fn responses_current_turn_start(entries: &V3CurrentTurnEntries) -> Option<usize> {
    let V3CurrentTurnEntries::Responses(entries) = entries else {
        return None;
    };
    let mut start = entries
        .iter()
        .rposition(|entry| matches!(entry.role, ResponsesTurnRole::User))?;
    if matches!(entries[start].kind, ResponsesTurnKind::Other) {
        return Some(
            if entries[..start]
                .iter()
                .any(|entry| matches!(entry.role, ResponsesTurnRole::User))
            {
                start
            } else {
                0
            },
        );
    }
    while start > 0 {
        let previous = &entries[start - 1];
        if !matches!(previous.role, ResponsesTurnRole::User)
            || matches!(previous.kind, ResponsesTurnKind::Other)
        {
            break;
        }
        start -= 1;
    }
    Some(start)
}

/// Gemini current-turn start: the last user content index, keeping that
/// content and every following tool/model content in the current turn.
/// `None` keeps the legacy last-carrier boundary for payloads without a
/// typed current-turn user.
fn gemini_current_turn_start(entries: &V3CurrentTurnEntries) -> Option<usize> {
    let V3CurrentTurnEntries::Gemini(entries) = entries else {
        return None;
    };
    entries
        .iter()
        .rposition(|entry| matches!(entry.role, GeminiTurnRole::User))
}

fn is_top_level_input_image(item: &Value) -> bool {
    // input_image/output_image 的 image_url / data / file_id / file_url 形态都必须清洗，
    // 否则历史图片以 base64 进 wire，导致 provider 侧 context 膨胀。
    matches!(
        item.get("type").and_then(Value::as_str),
        Some("input_image" | "output_image")
    ) && (item.get("image_url").is_some()
        || item.get("data").is_some()
        || item.get("file_id").is_some()
        || item.get("file_url").is_some())
}

fn normalize_chat_content_parts(message: &mut Value) {
    let tool_output = message.get("role").and_then(Value::as_str) == Some("tool");
    let Some(content) = message.get_mut("content") else {
        return;
    };
    if let Some(parts) = content.as_array_mut() {
        for part in parts.iter_mut() {
            strip_v3_embedded_image_bytes(part, &mut false);
        }
        return;
    }
    // tool 消息的字符串 content：responses→chat canonical 转换把 fco output
    // 图片 part 数组序列化成 JSON 字符串（形如
    // `[{"detail":"original","image_url":"data:image/..."}]`）。normalize 对
    // 数组 content 有效，但对字符串 content 必须解析后清洗，否则图片 base64
    // 原样进入 provider wire（context 400）。
    if let Some(text) = content.as_str().filter(|_| tool_output) {
        if let Ok(mut parsed) = serde_json::from_str::<Value>(text) {
            let mut changed = false;
            // 递归清洗解析后的 JSON（数组/对象/嵌套），裸图片引用
            // 替换为占位符（工具输出可能是
            // `{"image":"data:image/..."}` 对象形态，不只是 part 数组）。
            strip_v3_embedded_image_bytes(&mut parsed, &mut changed);
            if changed {
                *content = Value::String(
                    serde_json::to_string(&parsed).unwrap_or_else(|_| text.to_string()),
                );
            }
        } else if is_v3_inline_image_reference(text) {
            // 非 JSON 裸图片引用 → 替换为占位符，普通代码/句子保持原文。
            *content = Value::String(V3_HISTORY_IMAGE_PLACEHOLDER.to_string());
        }
    }
}

/// 递归清洗 JSON 中的裸图片引用及 `image_url`/`data`/`file_id`/`file_url` 图片载体。
/// 普通文字中提到 `data:image` 不构成图片引用，必须保留。
/// 覆盖工具输出字符串形态（`{"image":"data:image/..."}` 对象、part 数组、裸字符串）。
fn strip_v3_embedded_image_bytes(value: &mut Value, changed: &mut bool) {
    match value {
        Value::Object(map) => {
            if is_v3_text_content_part(map) {
                return;
            }
            if is_v3_embedded_image_carrier(map) {
                replace_image_carrier_with_placeholder(map, Some("text"));
                *changed = true;
                return;
            }
            for child in map.values_mut() {
                strip_v3_embedded_image_bytes(child, changed);
            }
        }
        Value::Array(items) => {
            for item in items.iter_mut() {
                strip_v3_embedded_image_bytes(item, changed);
            }
        }
        Value::String(text) => {
            if is_v3_inline_image_reference(text) {
                *text = V3_HISTORY_IMAGE_PLACEHOLDER.to_string();
                *changed = true;
            }
        }
        _ => {}
    }
}

fn remove_image_string_fields(row: &mut Map<String, Value>, fields: &[&str]) {
    for field in fields {
        if row.get(*field).is_some_and(Value::is_string) {
            row.remove(*field);
        }
    }
}

fn replace_image_carrier_with_placeholder(row: &mut Map<String, Value>, text_type: Option<&str>) {
    remove_image_string_fields(row, &["image_url", "data", "file_id", "file_url", "detail"]);
    for (container, fields) in [
        ("image_url", &["url", "detail"][..]),
        ("source", &["data", "url", "file_id", "media_type"][..]),
        ("inline_data", &["data", "mime_type"][..]),
        (
            "file_data",
            &["file_uri", "file_url", "url", "mime_type"][..],
        ),
    ] {
        let Some(Value::Object(inner)) = row.get_mut(container) else {
            continue;
        };
        remove_image_string_fields(inner, fields);
        if container == "source"
            && matches!(
                inner.get("type").and_then(Value::as_str),
                Some("base64" | "url" | "file")
            )
        {
            inner.remove("type");
        }
        if inner.is_empty() {
            row.remove(container);
        }
    }
    if let Some(kind) = text_type {
        row.insert("type".to_string(), Value::String(kind.to_string()));
    } else if row.get("type").and_then(Value::as_str) == Some("image") {
        row.remove("type");
    }
    row.insert(
        "text".to_string(),
        Value::String(V3_HISTORY_IMAGE_PLACEHOLDER.to_string()),
    );
}

/// 判定 JSON 对象是否为图片载体 part：`image_url` / `data` / `file_id` 键的
/// **值**必须是图片引用形态（字符串或含 `url` 的对象），才视为图片 part。
///
/// 反向边界（2026-08-13 线上 400 根因）：工具 JSON Schema 的属性定义对象
/// （如 spawn_agent 的 `parameters.properties.items.items.properties`）可能
/// **恰好含 `image_url` / `data` / `file_id` 键名**，但值是
/// `{"description": "...", "type": "string"}` 这类 schema 定义，不是图片载体。
/// 只按 `contains_key` 判定会把整个 schema 对象替换成 `[Image]` 占位符 →
/// 上游 400 "Invalid schema for function 'spawn_agent'"。
fn is_v3_embedded_image_carrier(map: &Map<String, Value>) -> bool {
    if is_v3_text_content_part(map) {
        return false;
    }
    if matches!(
        map.get("type").and_then(Value::as_str),
        Some("image" | "input_image" | "output_image" | "image_url")
    ) {
        return true;
    }
    if let Some(image_url) = map.get("image_url") {
        return match image_url {
            Value::String(value) => !value.trim().is_empty(),
            Value::Object(inner) => inner.contains_key("url"),
            _ => false,
        };
    }
    if let Some(data) = map.get("data") {
        return data.as_str().is_some_and(|value| {
            !value.trim().is_empty()
                && (is_v3_inline_image_reference(value)
                    || matches!(
                        map.get("type").and_then(Value::as_str),
                        Some("image" | "input_image" | "output_image")
                    )
                    || map
                        .get("media_type")
                        .and_then(Value::as_str)
                        .is_some_and(|mime| mime.starts_with("image/")))
        });
    }
    if let Some(file_id) = map.get("file_id") {
        return file_id
            .as_str()
            .is_some_and(|value| !value.trim().is_empty());
    }
    if let Some(file_url) = map.get("file_url") {
        return file_url
            .as_str()
            .is_some_and(|value| value.trim().to_ascii_lowercase().starts_with("data:image/"));
    }
    false
}

fn normalize_responses_content_parts(item: &mut Value) {
    let Some(content) = item.get_mut("content").and_then(Value::as_array_mut) else {
        return;
    };
    normalize_responses_image_part_array(content);
}

fn normalize_responses_image_part_array(parts: &mut [Value]) -> bool {
    let mut changed = false;
    for part in parts.iter_mut() {
        let Some(row) = part.as_object_mut() else {
            continue;
        };
        if is_v3_embedded_image_carrier(row) {
            replace_image_carrier_with_placeholder(row, Some("input_text"));
            changed = true;
        }
    }
    changed
}

/// Responses tool output 的图片 part（数组或 JSON 字符串数组）统一替换为占位符，
/// 否则历史工具输出图片以 base64 原样进 wire，provider 侧 context 膨胀（400）。
fn normalize_responses_output_parts(item: &mut Value) {
    if !matches!(
        item.get("type").and_then(Value::as_str),
        Some("function_call_output" | "custom_tool_call_output" | "tool_call_output")
    ) {
        return;
    }
    let Some(output) = item.get_mut("output") else {
        return;
    };

    if let Some(parts) = output.as_array_mut() {
        normalize_responses_image_part_array(parts);
        return;
    }

    let Some(text) = output.as_str() else {
        return;
    };
    let Ok(mut parsed) = serde_json::from_str::<Value>(text) else {
        if is_v3_inline_image_reference(text) {
            *output = Value::String(V3_HISTORY_IMAGE_PLACEHOLDER.to_string());
        }
        return;
    };
    let Some(parts) = parsed.as_array_mut() else {
        return;
    };
    if normalize_responses_image_part_array(parts) {
        *output =
            Value::String(serde_json::to_string(&parsed).unwrap_or_else(|_| text.to_string()));
    }
}

fn normalize_gemini_content_parts(content: &mut Value) {
    let Some(parts) = content.get_mut("parts").and_then(Value::as_array_mut) else {
        return;
    };
    for part in parts.iter_mut() {
        let Some(row) = part.as_object_mut() else {
            continue;
        };
        if row.get("type").and_then(Value::as_str) == Some("image")
            || row.contains_key("inline_data")
            || row.contains_key("file_data")
        {
            replace_image_carrier_with_placeholder(row, None);
        }
    }
}
