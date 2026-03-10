use serde_json::{json, Map, Number, Value};

const AUTO_THINKING_MODEL_PREFIXES: [&str; 4] = ["glm-4.7", "glm-4.6", "glm-4.5", "glm-z1"];
const AUTO_THINKING_EXCLUDE_PREFIXES: [&str; 1] = ["glm-4.6v"];
const GLM_VISION_SYSTEM_PROMPT: &str = r#"你是 Codex 的截图理解子系统，专门用于分析 UI 截图和网页图片。请仅根据用户提供的图片，输出一个结构化的 JSON，用于后续自动化处理，不要输出额外解释性文字或自然语言说明。

输出必须是**单个合法 JSON 对象**，不要包含 Markdown、代码块标记或多余文本。请严格遵循下面的结构（字段可以为空数组，但必须存在）：
{
  "summary": "用 1-3 句整体描述这张图片（例如页面类型、主要区域、核心信息）",
  "marks": [
    {
      "type": "circle | arrow | underline | box | other",
      "color": "red | green | blue | yellow | other",
      "bbox": [x, y, width, height],
      "description": "该标记所圈出/指向/强调的内容，包含相关文字或 UI 元素描述"
    }
  ],
  "regions": [
    {
      "bbox": [x, y, width, height],
      "description": "该区域的可见内容（控件/图标/布局，以及其中出现的所有清晰可辨的文字）",
      "is_marked": true | false
    }
  ],
  "metadata": {
    "image_size_hint": "如果能推断出大致分辨率，请给出类似 1920x1080 的字符串；无法判断时用 null",
    "screenshot": true
  }
}

细则：
1. 文字提取要求：
   - 如果图片中存在清晰可辨的文字（包括标题、菜单、按钮、标签、提示信息、弹窗、错误信息等），必须在对应的 regions.description 中**完整抄写**这些文字，按自然阅读顺序组织，避免遗漏。
   - 如果有多行文字，可以用换行符分隔，但仍放在同一个 description 字段中。
   - 对确实无法看清的文字，用类似 "（模糊，无法辨认）" 标注即可；没有任何文字也视为正常情况，此时只需描述界面结构。
2. 标记识别（marks）：
   - 对所有明显的圈选、箭头、下划线、高亮框等标记，必须在 marks 中列出，每一项提供大致 bbox、颜色和简短说明，说明其强调或指向的内容。
3. 区域划分（regions）：
   - 将截图拆分为若干有意义的区域：如导航栏、侧边栏、主内容区、弹窗、对话框、表格、代码块、表单等。
   - 每个区域的 description 中，既要描述布局/控件类型，也要包含该区域内的全部清晰文字内容。
   - is_marked 为 true 表示该区域与某个标记（marks）相关或被标记强调。
4. 坐标规范：所有 bbox 使用相对于当前图片的像素坐标，左上角为 (0,0)，width/height 为正数近似值。
5. 无论图片内容如何，最终回答必须是合法 JSON，不能在 JSON 前后添加任何额外文本。"#;
const GLM_VISION_DEFAULT_USER_TEXT: &str = "请按照上面的 JSON 结构，详细描述这张图片的内容和标记。";

fn model_token(root: &Map<String, Value>) -> String {
    root.get("model")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default()
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value.and_then(|v| v.as_str())?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

fn normalize_image_part(part: &Map<String, Value>) -> Option<Value> {
    let raw_type = part
        .get("type")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if raw_type != "image" && raw_type != "image_url" {
        return None;
    }

    let image_url_block = part.get("image_url").and_then(|v| v.as_object());
    let url = image_url_block
        .and_then(|row| read_trimmed_string(row.get("url")))
        .or_else(|| read_trimmed_string(part.get("image_url")))
        .or_else(|| read_trimmed_string(part.get("url")))
        .or_else(|| read_trimmed_string(part.get("uri")))
        .or_else(|| read_trimmed_string(part.get("data")));
    let Some(url) = url else {
        return None;
    };

    let detail = image_url_block
        .and_then(|row| read_trimmed_string(row.get("detail")))
        .or_else(|| read_trimmed_string(part.get("detail")));

    let mut image_url = Map::<String, Value>::new();
    image_url.insert("url".to_string(), Value::String(url));
    if let Some(detail) = detail {
        image_url.insert("detail".to_string(), Value::String(detail));
    }

    let mut normalized = Map::<String, Value>::new();
    normalized.insert("type".to_string(), Value::String("image_url".to_string()));
    normalized.insert("image_url".to_string(), Value::Object(image_url));
    Some(Value::Object(normalized))
}

fn apply_glm_image_content_transform(root: &mut Map<String, Value>) {
    let Some(messages) = root.get_mut("messages").and_then(|v| v.as_array_mut()) else {
        return;
    };

    for message in messages.iter_mut() {
        let Some(message_obj) = message.as_object_mut() else {
            continue;
        };
        let Some(content) = message_obj.get_mut("content").and_then(|v| v.as_array_mut()) else {
            continue;
        };

        let next_content = content
            .iter()
            .map(|part| {
                part.as_object()
                    .and_then(normalize_image_part)
                    .unwrap_or_else(|| part.clone())
            })
            .collect::<Vec<Value>>();

        *content = next_content;
    }
}

fn should_drop_inline_image_part(part: &Map<String, Value>) -> bool {
    let raw_type = part
        .get("type")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if raw_type != "image" && raw_type != "image_url" && raw_type != "input_image" {
        return false;
    }

    let image_url_block = part.get("image_url").and_then(|v| v.as_object());
    let url = image_url_block
        .and_then(|row| read_trimmed_string(row.get("url")))
        .or_else(|| image_url_block.and_then(|row| read_trimmed_string(row.get("data"))))
        .or_else(|| read_trimmed_string(part.get("url")))
        .or_else(|| read_trimmed_string(part.get("data")));

    url.map(|value| value.starts_with("data:image"))
        .unwrap_or(false)
}

fn apply_glm_history_image_trim(root: &mut Map<String, Value>) {
    if !model_token(root).starts_with("glm-4.7") {
        return;
    }
    let Some(messages) = root.get("messages").and_then(|v| v.as_array()) else {
        return;
    };

    let mut last_user_idx: Option<usize> = None;
    for (idx, message) in messages.iter().enumerate().rev() {
        let role = message
            .as_object()
            .and_then(|row| row.get("role"))
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if role == "user" {
            last_user_idx = Some(idx);
            break;
        }
    }
    let Some(last_user_idx) = last_user_idx else {
        return;
    };

    let mut next_messages: Vec<Value> = Vec::new();
    for (idx, message) in messages.iter().enumerate() {
        let Some(message_obj) = message.as_object() else {
            next_messages.push(message.clone());
            continue;
        };
        let role = message_obj
            .get("role")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();

        if idx < last_user_idx && role == "user" {
            let Some(content) = message_obj.get("content").and_then(|v| v.as_array()) else {
                next_messages.push(message.clone());
                continue;
            };

            let mut changed = false;
            let next_content = content
                .iter()
                .filter_map(|part| {
                    let Some(part_obj) = part.as_object() else {
                        return Some(part.clone());
                    };
                    if should_drop_inline_image_part(part_obj) {
                        changed = true;
                        return None;
                    }
                    Some(part.clone())
                })
                .collect::<Vec<Value>>();

            if next_content.is_empty() {
                continue;
            }
            if changed {
                let mut cloned = message_obj.clone();
                cloned.insert("content".to_string(), Value::Array(next_content));
                next_messages.push(Value::Object(cloned));
                continue;
            }
        }

        next_messages.push(message.clone());
    }

    root.insert("messages".to_string(), Value::Array(next_messages));
}

fn extract_image_url_from_part(part: &Map<String, Value>) -> Option<String> {
    let image_url_block = part.get("image_url").and_then(|v| v.as_object());
    image_url_block
        .and_then(|row| read_trimmed_string(row.get("url")))
        .or_else(|| read_trimmed_string(part.get("image_url")))
        .or_else(|| read_trimmed_string(part.get("url")))
        .or_else(|| read_trimmed_string(part.get("uri")))
        .or_else(|| read_trimmed_string(part.get("data")))
}

fn collect_user_text_from_message(message: &Map<String, Value>) -> String {
    let Some(content) = message.get("content") else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    let Some(parts) = content.as_array() else {
        return String::new();
    };
    let mut rows: Vec<String> = Vec::new();
    for part in parts {
        let Some(part_obj) = part.as_object() else {
            continue;
        };
        if let Some(text) = read_trimmed_string(part_obj.get("text")) {
            rows.push(text);
        }
    }
    rows.join("\n")
}

fn apply_glm_vision_prompt_transform(root: &mut Map<String, Value>) {
    if !model_token(root).starts_with("glm-4.6v") {
        return;
    }
    let Some(messages) = root.get("messages").and_then(|v| v.as_array()) else {
        return;
    };

    let mut latest_user_with_image: Option<Map<String, Value>> = None;
    let mut image_url: Option<String> = None;

    for message in messages.iter().rev() {
        let Some(message_obj) = message.as_object() else {
            continue;
        };
        let role = message_obj
            .get("role")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if role != "user" {
            continue;
        }
        let Some(content) = message_obj.get("content").and_then(|v| v.as_array()) else {
            continue;
        };

        for part in content {
            let Some(part_obj) = part.as_object() else {
                continue;
            };
            let part_type = part_obj
                .get("type")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_default();
            if part_type != "image" && part_type != "image_url" && part_type != "input_image" {
                continue;
            }
            if let Some(candidate_url) = extract_image_url_from_part(part_obj) {
                latest_user_with_image = Some(message_obj.clone());
                image_url = Some(candidate_url);
                break;
            }
        }
        if image_url.is_some() {
            break;
        }
    }

    let Some(latest_user_with_image) = latest_user_with_image else {
        return;
    };
    let Some(image_url) = image_url else {
        return;
    };

    let original_user_text = collect_user_text_from_message(&latest_user_with_image);
    let user_text = if original_user_text.trim().is_empty() {
        GLM_VISION_DEFAULT_USER_TEXT.to_string()
    } else {
        original_user_text.trim().to_string()
    };

    root.insert(
        "messages".to_string(),
        Value::Array(vec![
            json!({
                "role": "system",
                "content": GLM_VISION_SYSTEM_PROMPT
            }),
            json!({
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": user_text
                    },
                    {
                        "type": "image_url",
                        "image_url": { "url": image_url }
                    }
                ]
            }),
        ]),
    );

    if let Some(raw) = root.get("max_tokens").and_then(|v| v.as_f64()) {
        if raw.is_finite() {
            let normalized = raw.min(4096.0).floor() as i64;
            if normalized > 0 {
                root.insert(
                    "max_tokens".to_string(),
                    Value::Number(Number::from(normalized)),
                );
            }
        }
    }
}

fn apply_glm_web_search_request_transform(root: &mut Map<String, Value>) {
    let web_search = root.get("web_search").and_then(|v| v.as_object()).cloned();
    let Some(web_search) = web_search else {
        return;
    };

    let query = web_search
        .get("query")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    let recency = web_search
        .get("recency")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let count = web_search
        .get("count")
        .and_then(|v| v.as_f64())
        .filter(|v| v.is_finite())
        .map(|v| v.floor() as i64)
        .filter(|v| *v >= 1 && *v <= 50);

    root.remove("web_search");
    if query.is_empty() {
        return;
    }

    let mut web_search_config = Map::<String, Value>::new();
    web_search_config.insert(
        "search_engine".to_string(),
        Value::String("search_std".to_string()),
    );
    web_search_config.insert("enable".to_string(), Value::Bool(true));
    web_search_config.insert("search_query".to_string(), Value::String(query));
    web_search_config.insert("search_result".to_string(), Value::Bool(true));
    if let Some(value) = recency {
        web_search_config.insert("search_recency_filter".to_string(), Value::String(value));
    }
    if let Some(value) = count {
        web_search_config.insert("count".to_string(), Value::Number(Number::from(value)));
    }

    root.insert(
        "tools".to_string(),
        Value::Array(vec![json!({
            "type": "web_search",
            "web_search": Value::Object(web_search_config)
        })]),
    );
}

fn apply_auto_thinking(root: &mut Map<String, Value>) {
    let model_id = model_token(root);
    if model_id.is_empty() {
        return;
    }
    let matches = AUTO_THINKING_MODEL_PREFIXES
        .iter()
        .any(|prefix| model_id.starts_with(prefix));
    if !matches {
        return;
    }
    let excluded = AUTO_THINKING_EXCLUDE_PREFIXES
        .iter()
        .any(|prefix| model_id.starts_with(prefix));
    if excluded {
        return;
    }
    if root.get("thinking").and_then(|v| v.as_object()).is_some() {
        return;
    }
    root.insert("thinking".to_string(), json!({ "type": "enabled" }));
}

pub(crate) fn apply_glm_request_compat(payload: Value) -> Value {
    let mut payload = payload;
    let Some(root) = payload.as_object_mut() else {
        return payload;
    };

    apply_glm_image_content_transform(root);
    apply_glm_vision_prompt_transform(root);
    apply_glm_history_image_trim(root);
    apply_glm_web_search_request_transform(root);
    apply_auto_thinking(root);
    payload
}
