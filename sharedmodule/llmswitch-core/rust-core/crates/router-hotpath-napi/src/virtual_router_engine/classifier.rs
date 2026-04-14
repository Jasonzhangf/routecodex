use serde_json::Value;

use super::features::RoutingFeatures;

#[derive(Debug, Clone)]
pub(crate) struct ClassificationResult {
    pub route_name: String,
    pub confidence: f64,
    pub reasoning: String,
    pub fallback: bool,
    pub candidates: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct RoutingClassifier {
    long_context_threshold_tokens: i64,
    thinking_keywords: Vec<String>,
    background_keywords: Vec<String>,
}

impl RoutingClassifier {
    pub(crate) fn new(config: &Value) -> Self {
        let long_context_threshold_tokens = config
            .get("longContextThresholdTokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(180_000);
        let thinking_keywords = normalize_list(
            config
                .get("thinkingKeywords")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                }),
            vec![
                "think step".to_string(),
                "analysis".to_string(),
                "reasoning".to_string(),
            ],
        );
        let background_keywords = normalize_list(
            config
                .get("backgroundKeywords")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                }),
            vec!["background".to_string(), "context dump".to_string()],
        );
        Self {
            long_context_threshold_tokens,
            thinking_keywords,
            background_keywords,
        }
    }

    pub(crate) fn classify(&self, features: &RoutingFeatures) -> ClassificationResult {
        let last_tool_category = features
            .last_assistant_tool_category
            .clone()
            .unwrap_or_default();
        let web_search_continuation = last_tool_category == "websearch";
        let local_tool_continuation = matches!(
            last_tool_category.as_str(),
            "read" | "write" | "search" | "other"
        );
        let reached_long_context = features.estimated_tokens >= self.long_context_threshold_tokens;
        let latest_message_from_user = features.latest_message_from_user;
        let has_tool_activity = features.has_tools || features.has_tool_call_responses;
        let thinking_continuation = last_tool_category == "read";
        let thinking_from_user =
            latest_message_from_user && features.has_thinking_keyword && !has_tool_activity;
        let thinking_from_read = !thinking_from_user && thinking_continuation;
        let coding_continuation = last_tool_category == "write";
        let search_continuation = last_tool_category == "search";
        let tools_continuation = last_tool_category == "other";
        let has_remote_video_attachment =
            features.has_video_attachment && features.has_remote_video_attachment;

        let mut evaluation: Vec<(String, bool, String)> = Vec::new();
        evaluation.push((
            "video".to_string(),
            has_remote_video_attachment,
            "video:remote-video-detected".to_string(),
        ));
        evaluation.push((
            "multimodal".to_string(),
            features.has_image_attachment,
            "multimodal:media-detected".to_string(),
        ));
        evaluation.push((
            "thinking".to_string(),
            thinking_from_user || thinking_from_read,
            if thinking_from_user {
                "thinking:user-input".to_string()
            } else {
                "thinking:last-tool-read".to_string()
            },
        ));
        evaluation.push((
            "longcontext".to_string(),
            reached_long_context,
            "longcontext:token-threshold".to_string(),
        ));
        evaluation.push((
            "coding".to_string(),
            coding_continuation,
            "coding:last-tool-write".to_string(),
        ));
        evaluation.push((
            "web_search".to_string(),
            !local_tool_continuation && web_search_continuation,
            "web_search:last-tool-websearch".to_string(),
        ));
        evaluation.push((
            "search".to_string(),
            search_continuation,
            "search:last-tool-search".to_string(),
        ));
        evaluation.push((
            "tools".to_string(),
            tools_continuation || (!search_continuation && has_tool_activity),
            if tools_continuation {
                "tools:last-tool-other".to_string()
            } else {
                "tools:tool-request-detected".to_string()
            },
        ));
        evaluation.push((
            "background".to_string(),
            contains_keywords(&features.user_text_sample, &self.background_keywords),
            "background:keywords".to_string(),
        ));

        for route in ROUTE_PRIORITY.iter() {
            if let Some((_, triggered, reason)) =
                evaluation.iter().find(|(name, _, _)| name == route)
            {
                if *triggered {
                    return build_classification(route, reason, &evaluation);
                }
            }
        }
        build_classification(DEFAULT_ROUTE, "fallback:default", &evaluation)
    }
}

fn build_classification(
    route: &str,
    reason: &str,
    evaluation: &[(String, bool, String)],
) -> ClassificationResult {
    let mut diagnostics: Vec<String> = Vec::new();
    for (_, triggered, why) in evaluation.iter() {
        if *triggered {
            diagnostics.push(why.clone());
        }
    }
    let mut reasoning_parts = Vec::new();
    reasoning_parts.push(reason.to_string());
    for entry in diagnostics.iter() {
        if entry != reason && !reasoning_parts.contains(entry) {
            reasoning_parts.push(entry.clone());
        }
    }
    let mut candidates = vec![route.to_string()];
    if !candidates.contains(&DEFAULT_ROUTE.to_string()) {
        candidates.push(DEFAULT_ROUTE.to_string());
    }
    ClassificationResult {
        route_name: route.to_string(),
        confidence: 0.9,
        reasoning: reasoning_parts.join("|"),
        fallback: route == DEFAULT_ROUTE,
        candidates,
    }
}

fn normalize_list(source: Option<Vec<String>>, fallback: Vec<String>) -> Vec<String> {
    if let Some(list) = source {
        if !list.is_empty() {
            return list.into_iter().map(|item| item.to_lowercase()).collect();
        }
    }
    fallback
}

fn contains_keywords(text: &str, keywords: &[String]) -> bool {
    if text.is_empty() || keywords.is_empty() {
        return false;
    }
    let normalized = text.to_lowercase();
    keywords.iter().any(|keyword| normalized.contains(keyword))
}

pub(crate) const DEFAULT_ROUTE: &str = "default";

pub(crate) const ROUTE_PRIORITY: [&str; 10] = [
    "video",
    "multimodal",
    "longcontext",
    "web_search",
    "thinking",
    "coding",
    "search",
    "tools",
    "background",
    DEFAULT_ROUTE,
];

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn classifier() -> RoutingClassifier {
        RoutingClassifier::new(&json!({}))
    }

    #[test]
    fn tools_declared_without_thinking_keyword_route_to_tools() {
        let features = RoutingFeatures {
            latest_message_from_user: true,
            has_tools: true,
            has_thinking_keyword: false,
            ..Default::default()
        };

        let result = classifier().classify(&features);

        assert_eq!(result.route_name, "tools");
        assert!(result.reasoning.contains("tools:tool-request-detected"));
        assert!(!result.reasoning.contains("thinking:user-input"));
    }

    #[test]
    fn explicit_thinking_keyword_without_tools_route_to_thinking() {
        let features = RoutingFeatures {
            latest_message_from_user: true,
            has_thinking_keyword: true,
            has_tools: false,
            ..Default::default()
        };

        let result = classifier().classify(&features);

        assert_eq!(result.route_name, "thinking");
        assert!(result.reasoning.contains("thinking:user-input"));
    }

    #[test]
    fn server_tool_required_does_not_force_web_search_route() {
        let features = RoutingFeatures {
            latest_message_from_user: true,
            has_tools: true,
            metadata: json!({ "serverToolRequired": true }),
            ..Default::default()
        };

        let result = classifier().classify(&features);

        assert_eq!(result.route_name, "tools");
        assert!(result.reasoning.contains("tools:tool-request-detected"));
        assert!(!result.reasoning.contains("web_search:servertool-required"));
    }

    #[test]
    fn declared_web_search_tool_does_not_force_web_search_route_on_first_turn() {
        let features = RoutingFeatures {
            latest_message_from_user: true,
            has_tools: true,
            has_web_search_tool_declared: true,
            ..Default::default()
        };

        let result = classifier().classify(&features);

        assert_eq!(result.route_name, "tools");
        assert!(result.reasoning.contains("tools:tool-request-detected"));
        assert!(!result.reasoning.contains("web_search:tool-declared"));
    }
}
