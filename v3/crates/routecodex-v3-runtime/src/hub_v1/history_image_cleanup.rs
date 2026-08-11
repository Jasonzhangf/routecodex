// feature: 唯一登记的历史 payload 清理例外 —— 历史图片统一占位清理
//
// 规则（v5，Jason 2026-08-08）：
// - 所有请求在 inbound 归一化阶段统一执行（Relay ReqInbound02 + Direct
//   V3Req04StandardizedResponses 共用本纯函数）。
// - 仅清理历史轮次（最后一个 user 消息/input item 之外）的图片 part；
//   当前轮图片保留（驱动 multimodal 路由）。
// - 历史图片 part 原位替换为统一固定文本占位符 {"type":"text","text":"[Image]"}
//   （chat wire）/ {"type":"input_text","text":"[Image]"}（responses wire）；
//   无编号、无前缀、不随图片数量/位置变化 —— 同位置永远同 token。
// - 纯函数、无状态：同一 body 必产出同一结果；不读任何跨请求状态。
// - 消息结构保持：只有图片的消息 content 变为 ["[Image]"]，不产生空消息。
// - cache 规则：固定占位符 -> 同会话同位置 token 逐字节一致 -> provider
//   prefix cache 可命中（首次替换后稳定命中）；图片位置之后首次 miss、之后
//   稳定命中；图片位置之前不受影响。
use serde_json::Value;

/// 统一占位符文本（chat wire 与 responses wire 共用同一字符串，保证确定性）。
pub(crate) const V3_HISTORY_IMAGE_PLACEHOLDER: &str = "[Image]";

/// 历史图片统一占位清理（纯函数）。
///
/// 处理三种形状：
/// - `messages[]`（chat canonical）：content 数组中的 `{"type":"image_url",...}`
///   part -> `{"type":"text","text":"[Image]"}`；
/// - `input[]`（responses）：item content 数组中的 `{"type":"input_image",...}`
///   part -> `{"type":"input_text","text":"[Image]"}`；
/// - `contents[]`（gemini）：parts 中的 image/inline_data/file_data part ->
///   `{"text":"[Image]"}`。
///
/// 当前轮判定与 Virtual Router 的 `extract_active_turn_signals` 对齐：
/// 最后一个 user carrier（role=="user"，或 responses 无 role 的
/// input_text/text/output_text item，或 gemini role=="user" content）即当前轮，
/// 其及其之后的内容一律不动；`function_call_output` / tool 结果不是 user
/// carrier，不会把真实当前轮图片误判为历史。
pub(crate) fn normalize_v3_history_image_placeholders(body: &mut Value) {
    if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
        let current_turn_index = messages
            .iter()
            .rposition(|message| message.get("role").and_then(Value::as_str) == Some("user"))
            .unwrap_or(0);
        for message in messages.iter_mut().take(current_turn_index) {
            normalize_chat_content_parts(message);
        }
        return;
    }
    if let Some(input) = body.get_mut("input").and_then(Value::as_array_mut) {
        let current_turn_index = input
            .iter()
            .rposition(is_responses_user_carrier)
            .unwrap_or(0);
        for item in input.iter_mut().take(current_turn_index) {
            normalize_responses_content_parts(item);
            normalize_responses_output_parts(item);
            if is_top_level_input_image(item) {
                *item = serde_json::json!({"type":"input_text","text":V3_HISTORY_IMAGE_PLACEHOLDER});
            }
        }
        return;
    }
    if let Some(contents) = body.get_mut("contents").and_then(Value::as_array_mut) {
        let current_turn_index = contents
            .iter()
            .rposition(|content| content.get("role").and_then(Value::as_str) == Some("user"))
            .unwrap_or(0);
        for content in contents.iter_mut().take(current_turn_index) {
            normalize_gemini_content_parts(content);
        }
    }
}

fn is_responses_user_carrier(item: &Value) -> bool {
    if item.get("role").and_then(Value::as_str) == Some("user") {
        return true;
    }
    matches!(
        item.get("type").and_then(Value::as_str),
        Some("input_text" | "text" | "output_text")
    )
}

fn is_top_level_input_image(item: &Value) -> bool {
    // input_image/output_image 的 image_url / data / file_id 形态都必须清洗，
    // 否则历史图片以 base64 进 wire，导致 provider 侧 context 膨胀。
    matches!(
        item.get("type").and_then(Value::as_str),
        Some("input_image" | "output_image")
    ) && (item.get("image_url").is_some()
        || item.get("data").is_some()
        || item.get("file_id").is_some())
}

fn normalize_chat_content_parts(message: &mut Value) {
    let Some(content) = message.get_mut("content").and_then(Value::as_array_mut) else {
        return;
    };
    for part in content.iter_mut() {
        let Some(row) = part.as_object_mut() else {
            continue;
        };
        if row.get("type").and_then(Value::as_str) == Some("image_url")
            && row.contains_key("image_url")
        {
            *part = serde_json::json!({"type":"text","text":V3_HISTORY_IMAGE_PLACEHOLDER});
        }
    }
}

fn normalize_responses_content_parts(item: &mut Value) {
    let Some(content) = item.get_mut("content").and_then(Value::as_array_mut) else {
        return;
    };
    for part in content.iter_mut() {
        let Some(row) = part.as_object_mut() else {
            continue;
        };
        // 有 image_url / data / file_id 即视为图片（Codex 的 fco.output 图片 part
        // 有时不带 type 字段——只靠 type 匹配会漏，历史 base64 原样进 wire → context 400）。
        let is_image = row.contains_key("image_url")
            || row.contains_key("data")
            || row.contains_key("file_id");
        if is_image {
            *part = serde_json::json!({"type":"input_text","text":V3_HISTORY_IMAGE_PLACEHOLDER});
        }
    }
}

/// function_call_output 的 `output` 数组（Codex 工具输出图片的实际位置）：
/// 图片 part（input_image/output_image + image_url/data/file_id）同样替换为占位符，
/// 否则历史工具输出图片以 base64 原样进 wire，provider 侧 context 膨胀（400）。
fn normalize_responses_output_parts(item: &mut Value) {
    if item.get("type").and_then(Value::as_str) != Some("function_call_output") {
        return;
    }
    let Some(output) = item.get_mut("output").and_then(Value::as_array_mut) else {
        return;
    };
    for part in output.iter_mut() {
        let Some(row) = part.as_object_mut() else {
            continue;
        };
        // 与 content[] 一致：有 image_url / data / file_id 即视为图片
        // （Codex 的 fco.output 图片 part 有时不带 type 字段）。
        let is_image = row.contains_key("image_url")
            || row.contains_key("data")
            || row.contains_key("file_id");
        if is_image {
            *part = serde_json::json!({"type":"input_text","text":V3_HISTORY_IMAGE_PLACEHOLDER});
        }
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
            body["messages"][2]["content"][1]["type"],
            "image_url",
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
                {"role": "user", "content": "current text"}
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
                    {"type": "input_text", "text": "current"}
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
                    {"type": "input_text", "text": "current"}
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
                    {"role": "user", "content": "current text"}
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
            body["input"][1]["content"][0]["type"],
            "input_image",
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
            body["input"][1]["content"][0]["type"],
            "input_image",
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
            body["contents"][2]["parts"][0]["inline_data"]["data"],
            "BBBB",
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
                {"role": "user", "content": "second turn"}
            ]
        });
        normalize_v3_history_image_placeholders(&mut earlier);
        let mut later = json!({
            "messages": [
                {"role": "user", "content": [
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,A"}}
                ]},
                {"role": "user", "content": "second turn"},
                {"role": "assistant", "content": "reply"},
                {"role": "user", "content": "third turn"}
            ]
        });
        normalize_v3_history_image_placeholders(&mut later);
        assert_eq!(
            earlier["messages"][0]["content"],
            later["messages"][0]["content"],
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
                    {"type": "input_text", "text": "current turn"}
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
    fn current_turn_function_call_output_output_image_preserved() {
        // 当前轮（最后一个 user carrier 之后）的工具输出图片不清洗（当前轮输入语义保留）。
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
            body["input"][1]["output"][0]["type"],
            "input_image",
            "current-turn tool output image must be preserved"
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
                    {"type": "input_text", "text": "current turn"}
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
}
