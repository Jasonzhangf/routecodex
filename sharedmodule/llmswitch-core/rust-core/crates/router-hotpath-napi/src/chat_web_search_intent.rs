use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatWebSearchIntentOutput {
    pub has_intent: bool,
    pub google_preferred: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchSemanticsHintOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disable: Option<bool>,
}

fn read_role(message: &Value) -> &str {
    message
        .as_object()
        .and_then(|obj| obj.get("role"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
}

fn extract_latest_user_content(messages: &[Value]) -> String {
    let last = match messages.last() {
        Some(v) => v,
        None => return String::new(),
    };
    if read_role(last) != "user" {
        return String::new();
    }
    let content = match last.as_object().and_then(|obj| obj.get("content")) {
        Some(v) => v,
        None => return String::new(),
    };
    if let Some(raw) = content.as_str() {
        return raw.to_string();
    }
    let parts = match content.as_array() {
        Some(v) => v,
        None => return String::new(),
    };
    let mut texts: Vec<String> = Vec::new();
    for part in parts {
        if let Some(raw) = part.as_str() {
            texts.push(raw.to_string());
            continue;
        }
        if let Some(text) = part
            .as_object()
            .and_then(|obj| obj.get("text"))
            .and_then(|v| v.as_str())
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
        {
            texts.push(text.to_string());
        }
    }
    texts.join("\n")
}

pub fn analyze_chat_web_search_intent(messages: Vec<Value>) -> ChatWebSearchIntentOutput {
    let content = extract_latest_user_content(&messages);
    if content.is_empty() {
        return ChatWebSearchIntentOutput {
            has_intent: false,
            google_preferred: false,
        };
    }

    if content.contains("谷歌搜索") || content.contains("谷歌一下") || content.contains("百度一下")
    {
        return ChatWebSearchIntentOutput {
            has_intent: true,
            google_preferred: true,
        };
    }

    let text = content.to_ascii_lowercase();
    let english_direct = [
        "web search",
        "web_search",
        "websearch",
        "internet search",
        "search the web",
        "web-search",
        "internet-search",
        "/search",
    ];
    if english_direct.iter().any(|key| text.contains(key)) {
        return ChatWebSearchIntentOutput {
            has_intent: true,
            google_preferred: text.contains("google"),
        };
    }

    let verb_tokens_en = ["search", "find", "look up", "look for", "google"];
    let noun_tokens_en = [
        "web",
        "internet",
        "online",
        "news",
        "information",
        "info",
        "report",
        "reports",
        "article",
        "articles",
    ];
    if verb_tokens_en.iter().any(|key| text.contains(key))
        && noun_tokens_en.iter().any(|key| text.contains(key))
    {
        return ChatWebSearchIntentOutput {
            has_intent: true,
            google_preferred: text.contains("google"),
        };
    }

    if content.contains("上网") {
        return ChatWebSearchIntentOutput {
            has_intent: true,
            google_preferred: false,
        };
    }
    let zh_verb_tokens = ["搜索", "查找", "搜"];
    let zh_noun_tokens = ["网络", "联网", "新闻", "信息", "报道"];
    if zh_verb_tokens.iter().any(|key| content.contains(key))
        && zh_noun_tokens.iter().any(|key| content.contains(key))
    {
        return ChatWebSearchIntentOutput {
            has_intent: true,
            google_preferred: false,
        };
    }

    ChatWebSearchIntentOutput {
        has_intent: false,
        google_preferred: false,
    }
}

pub fn extract_web_search_semantics_hint(
    semantics: &Value,
) -> Option<WebSearchSemanticsHintOutput> {
    let extras = semantics
        .as_object()
        .and_then(|obj| obj.get("providerExtras"))
        .and_then(|v| v.as_object())?;
    let hint = extras.get("webSearch")?;

    if let Some(enabled) = hint.as_bool() {
        return if enabled {
            Some(WebSearchSemanticsHintOutput {
                force: Some(true),
                disable: None,
            })
        } else {
            Some(WebSearchSemanticsHintOutput {
                force: None,
                disable: Some(true),
            })
        };
    }

    let row = hint.as_object()?;
    let force = row.get("force").and_then(|v| v.as_bool()).filter(|v| *v);
    let disable = row.get("disable").and_then(|v| v.as_bool()).filter(|v| *v);
    if force.is_none() && disable.is_none() {
        return None;
    }
    Some(WebSearchSemanticsHintOutput { force, disable })
}
