// feature: 唯一登记的历史 payload 清理例外 —— 历史图片统一占位清理
//
// 规则（Jason 2026-10-06）：
// - 所有请求在 inbound 归一化阶段统一执行（Relay ReqInbound02 + Direct
//   V3Req04StandardizedResponses 共用本纯函数）。
// - 仅清理最后一条图片载体之前的图片；最后一条消息/工具结果中的图片全部保留。
//   后续纯文本提醒不改变图片边界；保留的图片驱动 multimodal 路由。
// - 历史图片 part 原位替换为统一固定文本占位符 {"type":"text","text":"[Image]"}
//   （chat wire）/ {"type":"input_text","text":"[Image]"}（responses wire）；
//   无编号、无前缀、不随图片数量/位置变化 —— 同位置永远同 token。
// - 纯函数、无状态：同一 body 必产出同一结果；不读任何跨请求状态。
// - 消息结构保持：只有图片的消息 content 变为 ["[Image]"]，不产生空消息。
// - cache 规则：固定占位符 -> 同会话同位置 token 逐字节一致 -> provider
//   prefix cache 可命中（首次替换后稳定命中）；图片位置之后首次 miss、之后
//   稳定命中；图片位置之前不受影响。
use routecodex_v3_route_classifier::is_v3_inline_image_reference;
use serde_json::Value;

/// 统一占位符文本（chat wire 与 responses wire 共用同一字符串，保证确定性）。
pub(crate) const V3_HISTORY_IMAGE_PLACEHOLDER: &str = "[Image]";

fn is_v3_text_content_part(row: &serde_json::Map<String, Value>) -> bool {
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

/// 历史图片统一占位清理（唯一清洗真源——所有入口/形态/边界在此一次处理完，
/// 禁止在调用点/其他文件零散补丁）。
///
/// ## 边界（历史轮定义，统一）
/// - 最后一条包含图片的消息/input item 之前的图片属于历史，清洗为占位符；
/// - 最后图片载体内的所有图片保留，包括刚返回的工具结果；
/// - 时间提醒、模型切换提示等后续纯文本消息不改变图片边界。
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
    if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
        let history_end = messages
            .iter()
            .rposition(|message| count_v3_item_image_refs(message) > 0)
            .unwrap_or(0);
        for message in messages.iter_mut().take(history_end) {
            normalize_chat_content_parts(message);
        }
        return;
    }
    if let Some(input) = body.get_mut("input").and_then(Value::as_array_mut) {
        let history_end = input
            .iter()
            .rposition(|item| count_v3_item_image_refs(item) > 0)
            .unwrap_or(0);
        for item in input.iter_mut().take(history_end) {
            normalize_responses_content_parts(item);
            normalize_responses_output_parts(item);
            if is_top_level_input_image(item) {
                *item =
                    serde_json::json!({"type":"input_text","text":V3_HISTORY_IMAGE_PLACEHOLDER});
            }
        }
        return;
    }
    if let Some(contents) = body.get_mut("contents").and_then(Value::as_array_mut) {
        let current_turn_index = contents
            .iter()
            .rposition(|content| count_v3_item_image_refs(content) > 0)
            .unwrap_or(0);
        for content in contents.iter_mut().take(current_turn_index) {
            normalize_gemini_content_parts(content);
        }
    }
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
                *value = serde_json::json!({"type":"text","text":V3_HISTORY_IMAGE_PLACEHOLDER});
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

/// 判定 JSON 对象是否为图片载体 part：`image_url` / `data` / `file_id` 键的
/// **值**必须是图片引用形态（字符串或含 `url` 的对象），才视为图片 part。
///
/// 反向边界（2026-08-13 线上 400 根因）：工具 JSON Schema 的属性定义对象
/// （如 spawn_agent 的 `parameters.properties.items.items.properties`）可能
/// **恰好含 `image_url` / `data` / `file_id` 键名**，但值是
/// `{"description": "...", "type": "string"}` 这类 schema 定义，不是图片载体。
/// 只按 `contains_key` 判定会把整个 schema 对象替换成 `[Image]` 占位符 →
/// 上游 400 "Invalid schema for function 'spawn_agent'"。
fn is_v3_embedded_image_carrier(map: &serde_json::Map<String, Value>) -> bool {
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
            *part = serde_json::json!({"type":"input_text","text":V3_HISTORY_IMAGE_PLACEHOLDER});
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
            *part = serde_json::json!({"text":V3_HISTORY_IMAGE_PLACEHOLDER});
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn history_images_become_uniform_placeholder_current_turn_image_preserved() {
        let mut body = json!({
            "model": "deepseek-v4-flash",
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "first"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
                ]},
                {"role": "assistant", "content": "ok"},
                {"role": "user", "content": [
                    {"type": "text", "text": "current"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,BBBB"}}
                ]}
            ]
        });
        normalize_v3_history_image_placeholders(&mut body);
        assert_eq!(
            body["messages"][0]["content"][1],
            json!({"type":"text","text":"[Image]"})
        );
        assert_eq!(
            body["messages"][2]["content"][1]["type"], "image_url",
            "current turn image must be preserved"
        );
    }

    #[test]
    fn image_only_history_message_stays_non_empty() {
        let mut body = json!({
            "messages": [
                {"role": "user", "content": [
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
                ]},
                {"role": "assistant", "content": "ok"},
                {"role": "user", "content": [
                    {"type":"text","text":"current text"},
                    {"type":"image_url","image_url":{"url":"data:image/png;base64,LATEST"}}
                ]}
            ]
        });
        normalize_v3_history_image_placeholders(&mut body);
        assert_eq!(
            body["messages"][0]["content"],
            json!([{"type":"text","text":"[Image]"}])
        );
    }

    #[test]
    fn responses_history_output_image_and_data_form_cleaned() {
        // output_image（assistant 图片输出）与 input_image 的 data/file_id 形态
        // 在历史中必须替换为 [Image]，否则 base64 进 wire 导致 provider context 膨胀。
        let mut body = json!({
            "input": [
                {"type": "message", "role": "user", "content": [
                    {"type": "input_image", "data": "data:image/png;base64,DDDD"}
                ]},
                {"type": "message", "role": "assistant", "content": [
                    {"type": "output_image", "image_url": {"url": "data:image/png;base64,EEEE"}}
                ]},
                {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "current"},
                    {"type": "input_image", "image_url": "data:image/png;base64,LATEST"}
                ]}
            ]
        });
        normalize_v3_history_image_placeholders(&mut body);
        assert_eq!(
            body["input"][0]["content"][0],
            json!({"type":"input_text","text":"[Image]"})
        );
        assert_eq!(
            body["input"][1]["content"][0],
            json!({"type":"input_text","text":"[Image]"})
        );
        assert_eq!(
            body["input"][2]["content"][0],
            json!({"type":"input_text","text":"current"}),
            "current turn must be preserved"
        );
    }

    #[test]
    fn responses_top_level_input_image_data_form_cleaned() {
        let mut body = json!({
            "input": [
                {"type": "input_image", "data": "data:image/png;base64,FFFF"},
                {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "current"},
                    {"type": "input_image", "image_url": "data:image/png;base64,LATEST"}
                ]}
            ]
        });
        normalize_v3_history_image_placeholders(&mut body);
        assert_eq!(
            body["input"][0],
            json!({"type":"input_text","text":"[Image]"})
        );
    }

    #[test]
    fn multiple_history_images_all_replaced_deterministically() {
        let build = || {
            let mut body = json!({
                "messages": [
                    {"role": "user", "content": [
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64,A"}},
                        {"type": "text", "text": "between"},
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64,B"}}
                    ]},
                    {"role": "user", "content": [
                        {"type":"text","text":"current text"},
                        {"type":"image_url","image_url":{"url":"data:image/png;base64,LATEST"}}
                    ]}
                ]
            });
            normalize_v3_history_image_placeholders(&mut body);
            body
        };
        let first = build();
        let second = build();
        assert_eq!(first, second, "same body must produce identical result");
        assert_eq!(
            first["messages"][0]["content"],
            json!([
                {"type":"text","text":"[Image]"},
                {"type":"text","text":"between"},
                {"type":"text","text":"[Image]"}
            ])
        );
    }

    #[test]
    fn responses_input_image_parts_become_input_text_placeholder() {
        let mut body = json!({
            "input": [
                {"role": "user", "content": [
                    {"type": "input_text", "text": "look"},
                    {"type": "input_image", "image_url": {"url": "data:image/png;base64,AAAA"}}
                ]},
                {"role": "user", "content": [
                    {"type": "input_image", "image_url": {"url": "data:image/png;base64,BBBB"}}
                ]}
            ]
        });
        normalize_v3_history_image_placeholders(&mut body);
        assert_eq!(
            body["input"][0]["content"][1],
            json!({"type":"input_text","text":"[Image]"})
        );
        assert_eq!(
            body["input"][1]["content"][0]["type"], "input_image",
            "current turn image must be preserved"
        );
    }

    #[test]
    fn trailing_tool_output_does_not_shift_current_turn_image_to_history() {
        let mut body = json!({
            "input": [
                {"role": "user", "content": [
                    {"type": "input_text", "text": "old question"},
                    {"type": "input_image", "image_url": {"url": "data:image/png;base64,OLD"}}
                ]},
                {"role": "user", "content": [
                    {"type": "input_image", "image_url": {"url": "data:image/png;base64,CURRENT"}}
                ]},
                {"type": "function_call_output", "call_id": "call_1", "output": "done"}
            ]
        });
        normalize_v3_history_image_placeholders(&mut body);
        assert_eq!(
            body["input"][0]["content"][1],
            json!({"type":"input_text","text":"[Image]"}),
            "history image must become placeholder"
        );
        assert_eq!(
            body["input"][1]["content"][0]["type"], "input_image",
            "current turn image must be preserved even with trailing tool output"
        );
    }

    #[test]
    fn gemini_history_parts_become_text_placeholder_current_turn_preserved() {
        let mut body = json!({
            "contents": [
                {"role": "user", "parts": [
                    {"text": "old"},
                    {"inline_data": {"mime_type": "image/png", "data": "AAAA"}}
                ]},
                {"role": "model", "parts": [{"text": "ok"}]},
                {"role": "user", "parts": [
                    {"inline_data": {"mime_type": "image/png", "data": "BBBB"}}
                ]}
            ]
        });
        normalize_v3_history_image_placeholders(&mut body);
        assert_eq!(body["contents"][0]["parts"][1], json!({"text":"[Image]"}));
        assert_eq!(
            body["contents"][2]["parts"][0]["inline_data"]["data"], "BBBB",
            "current turn gemini image must be preserved"
        );
    }

    #[test]
    fn appended_turn_keeps_earlier_placeholder_stable() {
        let mut earlier = json!({
            "messages": [
                {"role": "user", "content": [
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,A"}}
                ]},
                {"role": "user", "content": [
                    {"type":"image_url","image_url":{"url":"data:image/png;base64,LATEST"}}
                ]}
            ]
        });
        normalize_v3_history_image_placeholders(&mut earlier);
        let mut later = json!({
            "messages": [
                {"role": "user", "content": [
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,A"}}
                ]},
                {"role": "user", "content": [
                    {"type":"image_url","image_url":{"url":"data:image/png;base64,LATEST"}}
                ]},
                {"role": "assistant", "content": "reply"},
                {"role": "user", "content": "third turn"}
            ]
        });
        normalize_v3_history_image_placeholders(&mut later);
        assert_eq!(
            earlier["messages"][0]["content"], later["messages"][0]["content"],
            "earlier history prefix must normalize identically across requests"
        );
    }

    #[test]
    fn function_call_output_images_in_output_field_become_placeholder() {
        // Codex 工具输出图片位于 function_call_output.output（不是 content）：
        // 历史轮必须清洗，否则 base64 图片原样进 wire → provider context 膨胀 400。
        let mut body = json!({
            "input": [
                {"type": "function_call_output", "call_id": "call_1", "output": [
                    {"type": "input_image", "detail": "original", "image_url": "data:image/png;base64,AAAA"}
                ]},
                {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "current turn"},
                    {"type": "input_image", "image_url": "data:image/png;base64,LATEST"}
                ]}
            ]
        });
        normalize_v3_history_image_placeholders(&mut body);
        assert_eq!(
            body["input"][0]["output"][0],
            json!({"type": "input_text", "text": V3_HISTORY_IMAGE_PLACEHOLDER}),
            "history function_call_output.output image must become placeholder"
        );
    }

    #[test]
    fn latest_function_call_output_image_is_preserved() {
        let mut body = json!({
            "input": [
                {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "current turn"}
                ]},
                {"type": "function_call_output", "call_id": "call_1", "output": [
                    {"type": "input_image", "detail": "original", "image_url": "data:image/png;base64,BBBB"}
                ]}
            ]
        });
        normalize_v3_history_image_placeholders(&mut body);
        assert_eq!(
            body["input"][1]["output"][0]["type"], "input_image",
            "latest tool image must reach the next model request"
        );
        assert_eq!(
            body["input"][1]["output"][0]["image_url"],
            "data:image/png;base64,BBBB"
        );
    }

    #[test]
    fn image_part_without_type_field_is_cleaned() {
        // Codex 的 fco.output 图片 part 有时不带 type 字段（只有 image_url）：
        // 只靠 type 匹配会漏，必须按 image_url/data/file_id 判定。
        let mut body = json!({
            "input": [
                {"type": "function_call_output", "call_id": "call_1", "output": [
                    {"detail": "original", "image_url": "data:image/png;base64,CCCC"}
                ]},
                {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "current turn"},
                    {"type": "input_image", "image_url": "data:image/png;base64,LATEST"}
                ]}
            ]
        });
        normalize_v3_history_image_placeholders(&mut body);
        assert_eq!(
            body["input"][0]["output"][0],
            json!({"type": "input_text", "text": V3_HISTORY_IMAGE_PLACEHOLDER}),
            "image part without type field must become placeholder"
        );
    }

    #[test]
    fn responses_trailing_tool_output_variants_preserve_latest_images() {
        for output_type in [
            "function_call_output",
            "custom_tool_call_output",
            "tool_call_output",
        ] {
            let mut body = json!({
                "input": [
                    {"type": "message", "role": "user", "content": [
                        {"type": "input_text", "text": "current turn"}
                    ]},
                    {"type": output_type, "call_id": "call_1", "output": [
                        {"detail": "original", "image_url": "data:image/png;base64,VARIANT"}
                    ]}
                ]
            });
            normalize_v3_history_image_placeholders(&mut body);
            assert_eq!(
                body["input"][1]["output"][0],
                json!({"detail": "original", "image_url": "data:image/png;base64,VARIANT"}),
                "latest {output_type} image must be preserved"
            );
        }
    }

    #[test]
    fn latest_function_call_output_json_string_image_is_preserved() {
        let mut body = json!({
            "input": [
                {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "current turn"}
                ]},
                {"type": "function_call_output", "call_id": "call_1", "output":
                    "[{\"detail\":\"original\",\"image_url\":\"data:image/png;base64,STRING\"}]"
                }
            ]
        });
        normalize_v3_history_image_placeholders(&mut body);
        let output = body["input"][1]["output"]
            .as_str()
            .expect("JSON-string function output must remain a string");
        assert!(
            output.contains("data:image/png;base64,STRING"),
            "latest JSON-string tool output must retain image bytes"
        );
    }

    #[test]
    fn output_images_any_base64_become_identical_placeholder_bytes() {
        // cache 影响确认：历史轮不同 base64 图片（不同请求/不同图片内容）必须归一为
        // 完全相同的占位符字节——历史 wire 字节稳定 → provider 前缀缓存命中。
        // 最后一条图片载体保留原始图片；其前面的图片保持稳定占位。
        let build = |b64: &str| {
            let mut body = json!({
                "input": [
                    {"type": "function_call_output", "call_id": "call_1", "output": [
                        {"detail": "original", "image_url": b64}
                    ]},
                    {"type": "message", "role": "user", "content": [
                        {"type": "input_text", "text": "current turn"},
                        {"type": "input_image", "image_url": "data:image/png;base64,LATEST"}
                    ]}
                ]
            });
            normalize_v3_history_image_placeholders(&mut body);
            serde_json::to_vec(&body).expect("serializable")
        };
        let bytes_a = build("data:image/png;base64,AAAA");
        let bytes_b = build("data:image/png;base64,BBBB…（不同图片内容）");
        let bytes_c = build("data:image/png;base64,<任意大 base64>");
        assert_eq!(
            bytes_a, bytes_b,
            "different base64 history images must produce identical bytes (cache stability)"
        );
        assert_eq!(
            bytes_a, bytes_c,
            "arbitrary base64 history image must produce identical bytes"
        );
        // 最新工具图片保留；不能以没有新 user 为由在模型读取前删除。
        let mut current = json!({
            "input": [
                {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "current turn"}
                ]},
                {"type": "function_call_output", "call_id": "call_2", "output": [
                    {"detail": "original", "image_url": "data:image/png;base64,CURRENT"}
                ]}
            ]
        });
        normalize_v3_history_image_placeholders(&mut current);
        assert_eq!(
            current["input"][1]["output"][0]["image_url"],
            "data:image/png;base64,CURRENT"
        );
    }

    #[test]
    fn chat_tool_string_content_images_are_cleaned() {
        // relay 路径：responses→chat canonical 转换把 fco output 图片数组序列化成
        // 字符串 content（`[{"detail":"original","image_url":"data:image/..."}]`）。
        // normalize 必须解析字符串 content 并清洗图片 part，否则 base64 原样进 wire。
        let mut body = json!({
            "messages": [
                {"role": "user", "content": "history"},
                {"role": "tool", "tool_call_id": "call_1", "content": concat!(
                    "[{\"detail\":\"original\",\"image_url\":\"data:image/png;base64,AAAA\"},",
                    "{\"type\":\"input_image\",\"data\":\"data:image/png;base64,BBBB\"}]"
                )},
                {"role": "user", "content": [
                    {"type":"text","text":"current turn"},
                    {"type":"image_url","image_url":{"url":"data:image/png;base64,LATEST"}}
                ]}
            ]
        });
        let raw_img = count_v3_payload_image_refs(&body);
        assert_eq!(
            raw_img, 3,
            "string content and latest images must be counted"
        );
        normalize_v3_history_image_placeholders(&mut body);
        let cleaned = count_v3_payload_image_refs(&body);
        assert_eq!(cleaned, 1, "only latest image must remain");
        let tool_content = body["messages"][1]["content"].as_str().unwrap();
        assert!(
            !tool_content.contains("data:image"),
            "tool string content must not keep base64: {tool_content}"
        );
        assert!(
            tool_content.contains(V3_HISTORY_IMAGE_PLACEHOLDER),
            "tool string content must contain placeholder: {tool_content}"
        );
    }

    #[test]
    fn tool_schema_image_url_property_definition_is_not_mistaken_for_image_carrier() {
        // 真实 OneStop 样本（2026-08-13 17:16 10000 端口）：tool_search_output 的
        // spawn_agent 工具 schema 的 parameters.properties.items.items.properties
        // 对象含 image_url 键（作为 schema 属性定义，值是 {"description", "type"}
        // 对象）。history_image_cleanup 的 strip_v3_embedded_image_bytes 递归清洗
        // 字符串 content 时曾把该 properties 对象误判为图片载体，整体替换为
        // [Image] 占位符 → 上游 400 "Invalid schema for function
        // 'spawn_agent': 'text' is not of type 'object', 'boolean'"。
        let spawn_agent = json!({
            "type": "function",
            "name": "spawn_agent",
            "defer_loading": true,
            "description": "spawn sub-agent",
            "parameters": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "items": {
                        "type": "array",
                        "description": "Structured input items.",
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                                "audio_url": {"description": "Audio data URL when type is audio.", "type": "string"},
                                "image_url": {"description": "Image URL when type is image.", "type": "string"},
                                "name": {"description": "Display name.", "type": "string"},
                                "path": {"description": "Path.", "type": "string"},
                                "text": {"description": "Text content when type is text.", "type": "string"},
                                "type": {"description": "Input item type.", "type": "string"}
                            }
                        }
                    }
                }
            }
        });
        let tools = json!([
            {"type": "namespace", "name": "tools", "tools": [spawn_agent]}
        ]);
        let mut body = json!({
            "messages": [
                {"role": "user", "content": "history"},
                {"role": "tool", "tool_call_id": "call_ts", "content": serde_json::to_string(&tools).unwrap()},
                {"role": "user", "content": "current turn"}
            ]
        });
        normalize_v3_history_image_placeholders(&mut body);
        let tool_content = body["messages"][1]["content"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(tool_content).unwrap();
        let tool = &parsed[0]["tools"][0];
        assert_eq!(tool["name"], "spawn_agent");
        assert_eq!(
            tool["parameters"]["properties"]["items"]["items"]["properties"]["image_url"]["type"],
            "string",
            "tool schema image_url property definition must survive normalization"
        );
        assert_eq!(
            tool["parameters"]["properties"]["items"]["items"]["properties"]["text"]["type"],
            "string",
            "tool schema text property definition must survive normalization"
        );
    }

    #[test]
    fn latest_chat_tool_image_is_preserved() {
        let mut body = json!({
            "messages": [
                {"role": "user", "content": "last user"},
                {"role": "assistant", "content": "calling tool"},
                {"role": "tool", "tool_call_id": "call_1", "content": [
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,TOOLIMG"}}
                ]}
            ]
        });
        normalize_v3_history_image_placeholders(&mut body);
        assert_eq!(body["messages"][2]["content"][0]["type"], "image_url");
        assert_eq!(
            body["messages"][2]["content"][0]["image_url"]["url"],
            "data:image/png;base64,TOOLIMG"
        );
    }
}
