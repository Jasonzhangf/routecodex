use super::features::RoutingFeatures;
use serde_json::Value;

#[derive(Debug, Clone)]
pub(crate) struct ClassificationResult {
    pub route_name: String,
    pub confidence: f64,
    pub reasoning: String,
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
        let latest_message_from_user = features.latest_message_from_user;
        let stopless_followup = features
            .metadata
            .get("runtime_control")
            .and_then(|v| v.as_object())
            .and_then(|rt| rt.get("serverToolFollowup"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let last_tool_category = if latest_message_from_user {
            String::new()
        } else {
            features
                .last_assistant_tool_category
                .clone()
                .unwrap_or_default()
        };
        // Web-search routing must be decided from current-turn signals only.
        // Do not inherit web_search intent from historical tool continuation.
        let reached_long_context = features.estimated_tokens >= self.long_context_threshold_tokens;
        let has_tool_activity = !latest_message_from_user && features.has_tool_call_responses;
        let has_visual = features.has_image_attachment
            || (features.has_video_attachment && features.has_remote_video_attachment);
        // Jason 规则：thinking 只看当前轮是否为 fresh user input。
        // stopless followup 是内部续轮，必须走 thinking。
        let thinking_from_user = latest_message_from_user || stopless_followup;
        // Coding route must be based on current-turn continuation signal only.
        // If this turn does not contain tool-call response activity, do not inherit
        // historical "last tool was coding" into the new request.
        let has_current_turn_continuation_signal =
            !latest_message_from_user && features.has_tool_call_responses;
        let coding_continuation =
            has_current_turn_continuation_signal && last_tool_category == "coding";
        let search_continuation =
            has_current_turn_continuation_signal && last_tool_category == "search";
        let tools_continuation =
            has_current_turn_continuation_signal && last_tool_category == "other";
        let web_search_tool_intent =
            has_current_turn_continuation_signal && last_tool_category == "websearch";
        let user_text_lower = features.user_text_sample.to_lowercase();
        // Keep web-search intent strict to avoid over-routing:
        // only explicit web-search phrases should trigger web_search route.
        // Web-search intent is only valid on the *current fresh user turn*.
        // If tool-call responses already exist in the current segment, we are in a tool/followup loop
        // and must not keep inheriting the previous user search intent.
        let search_intent_from_text = latest_message_from_user
            && !features.has_tool_call_responses
            && contains_any_keyword(
                &user_text_lower,
                &[
                    "search the web",
                    "web search",
                    "browse the web",
                    "search online",
                    "look it up",
                    "with sources",
                    "联网搜索",
                    "上网搜索",
                    "上网搜",
                    "网页搜索",
                    "请搜索",
                    "引用来源",
                ],
            );
        // Web-search routing is current-turn intent only.
        // Servertool declaration itself must not force route switch.
        let should_route_search =
            web_search_tool_intent || (!has_visual && search_intent_from_text);

        let mut evaluation: Vec<(String, bool, String)> = Vec::new();
        evaluation.push((
            "multimodal".to_string(),
            has_visual,
            "multimodal:visual-content".to_string(),
        ));
        evaluation.push((
            "longcontext".to_string(),
            reached_long_context,
            "longcontext:token-threshold".to_string(),
        ));
        evaluation.push((
            "thinking".to_string(),
            thinking_from_user && !reached_long_context,
            "thinking:user-input".to_string(),
        ));
        evaluation.push((
            "coding".to_string(),
            coding_continuation,
            "coding:last-tool-coding".to_string(),
        ));
        evaluation.push((
            "web_search".to_string(),
            should_route_search,
            if web_search_tool_intent {
                "web_search:tool-intent".to_string()
            } else {
                "web_search:explicit-or-intent".to_string()
            },
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
        build_classification(DEFAULT_ROUTE, "default:route-selected", &evaluation)
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
    if route != "longcontext"
        && evaluation
            .iter()
            .any(|(name, triggered, _)| name == "longcontext" && *triggered)
        && !candidates.contains(&"longcontext".to_string())
    {
        candidates.push("longcontext".to_string());
    }
    if !candidates.contains(&DEFAULT_ROUTE.to_string()) {
        candidates.push(DEFAULT_ROUTE.to_string());
    }
    ClassificationResult {
        route_name: route.to_string(),
        confidence: 0.9,
        reasoning: reasoning_parts.join("|"),
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

fn contains_any_keyword(text: &str, keywords: &[&str]) -> bool {
    if text.is_empty() || keywords.is_empty() {
        return false;
    }
    keywords.iter().any(|keyword| text.contains(keyword))
}

pub(crate) const DEFAULT_ROUTE: &str = "default";

pub(crate) const ROUTE_PRIORITY: [&str; 9] = [
    "multimodal",
    "web_search",
    "thinking",
    "coding",
    "search",
    "longcontext",
    "tools",
    "background",
    DEFAULT_ROUTE,
];

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_classifier() -> RoutingClassifier {
        RoutingClassifier::new(&json!({}))
    }

    #[test]
    fn tools_declared_without_thinking_keyword_route_to_thinking_on_current_user_turn() {
        let features = RoutingFeatures {
            latest_message_from_user: true,
            has_tools: true,
            has_thinking_keyword: false,
            ..Default::default()
        };

        let result = test_classifier().classify(&features);

        assert_eq!(result.route_name, "thinking");
        assert!(result.reasoning.contains("thinking:user-input"));
    }

    #[test]
    fn explicit_thinking_keyword_without_tools_route_to_thinking() {
        let features = RoutingFeatures {
            latest_message_from_user: true,
            has_thinking_keyword: true,
            has_tools: false,
            ..Default::default()
        };

        let result = test_classifier().classify(&features);

        assert_eq!(result.route_name, "thinking");
        assert!(result.reasoning.contains("thinking:user-input"));
    }

    #[test]
    fn explicit_thinking_keyword_with_only_declared_tools_still_routes_to_thinking() {
        let features = RoutingFeatures {
            latest_message_from_user: true,
            has_thinking_keyword: true,
            has_tools: true,
            has_tool_call_responses: false,
            ..Default::default()
        };

        let result = test_classifier().classify(&features);

        assert_eq!(result.route_name, "thinking");
        assert!(result.reasoning.contains("thinking:user-input"));
        assert!(!result.reasoning.contains("tools:tool-request-detected"));
    }

    #[test]
    fn previous_turn_read_continuation_no_longer_routes_to_thinking() {
        let features = RoutingFeatures {
            latest_message_from_user: false,
            has_tools: true,
            has_tool_call_responses: true,
            last_assistant_tool_category: Some("thinking".to_string()),
            ..Default::default()
        };

        let result = test_classifier().classify(&features);

        assert_eq!(result.route_name, "tools");
        assert!(result.reasoning.contains("tools:tool-request-detected"));
        assert!(!result.reasoning.contains("thinking:user-input"));
    }

    #[test]
    fn previous_turn_other_tool_still_routes_to_tools() {
        let features = RoutingFeatures {
            latest_message_from_user: false,
            has_tools: true,
            has_tool_call_responses: true,
            last_assistant_tool_category: Some("other".to_string()),
            ..Default::default()
        };

        let result = test_classifier().classify(&features);

        assert_eq!(result.route_name, "tools");
        assert!(result.reasoning.contains("tools:last-tool-other"));
        assert!(!result.reasoning.contains("thinking:user-input"));
    }

    #[test]
    fn malformed_tool_followup_without_valid_last_tool_category_does_not_route_to_coding() {
        let features = RoutingFeatures {
            latest_message_from_user: false,
            has_tools: true,
            has_tool_call_responses: true,
            last_assistant_tool_category: None,
            ..Default::default()
        };

        let result = test_classifier().classify(&features);

        assert_ne!(result.route_name, "coding");
        assert!(result.reasoning.contains("tools:tool-request-detected"));
        assert!(!result.reasoning.contains("coding:last-tool-coding"));
    }

    #[test]
    fn historical_coding_label_without_current_tool_followup_does_not_route_to_coding() {
        let features = RoutingFeatures {
            latest_message_from_user: false,
            has_tools: true,
            has_tool_call_responses: false,
            last_assistant_tool_category: Some("coding".to_string()),
            ..Default::default()
        };

        let result = test_classifier().classify(&features);

        assert_ne!(result.route_name, "coding");
        assert!(!result.reasoning.contains("coding:last-tool-coding"));
    }

    #[test]
    fn historical_search_label_without_current_tool_followup_does_not_route_to_search() {
        let features = RoutingFeatures {
            latest_message_from_user: false,
            has_tools: true,
            has_tool_call_responses: false,
            last_assistant_tool_category: Some("search".to_string()),
            ..Default::default()
        };

        let result = test_classifier().classify(&features);

        assert_ne!(result.route_name, "search");
        assert!(!result.reasoning.contains("search:last-tool-search"));
    }

    #[test]
    fn historical_other_label_without_current_tool_followup_does_not_route_to_tools_by_continuation(
    ) {
        let features = RoutingFeatures {
            latest_message_from_user: false,
            has_tools: true,
            has_tool_call_responses: false,
            last_assistant_tool_category: Some("other".to_string()),
            ..Default::default()
        };

        let result = test_classifier().classify(&features);

        assert!(!result.reasoning.contains("tools:last-tool-other"));
    }

    #[test]
    fn historical_websearch_label_without_current_tool_followup_does_not_route_to_web_search() {
        let features = RoutingFeatures {
            latest_message_from_user: false,
            has_tools: true,
            has_tool_call_responses: false,
            last_assistant_tool_category: Some("websearch".to_string()),
            ..Default::default()
        };

        let result = test_classifier().classify(&features);

        assert_ne!(result.route_name, "web_search");
        assert!(!result.reasoning.contains("web_search:tool-intent"));
    }

    #[test]
    fn current_user_turn_ignores_previous_search_continuation_and_prefers_thinking() {
        let features = RoutingFeatures {
            latest_message_from_user: true,
            has_tools: true,
            has_tool_call_responses: true,
            last_assistant_tool_category: Some("search".to_string()),
            ..Default::default()
        };

        let result = test_classifier().classify(&features);

        assert_eq!(result.route_name, "thinking");
        assert!(result.reasoning.contains("thinking:user-input"));
        // tools:tool-request-detected is NOT triggered on fresh user turns
        // because has_tool_activity = !latest_message_from_user && has_tool_call_responses = false
        assert!(
            !result.reasoning.contains("tools:tool-request-detected"),
            "fresh user turn must not trigger tools:tool-request-detected"
        );
        assert!(!result.reasoning.contains("search:last-tool-search"));
    }

    #[test]
    fn tool_followup_after_user_web_search_does_not_stick_to_web_search() {
        let features = RoutingFeatures {
            latest_message_from_user: true,
            has_tools: true,
            has_tool_call_responses: true,
            user_text_sample: "please web search latest release notes".to_string(),
            ..Default::default()
        };

        let result = test_classifier().classify(&features);

        assert_eq!(result.route_name, "thinking");
        assert!(result.reasoning.contains("thinking:user-input"));
        assert!(!result.reasoning.contains("web_search:explicit-or-intent"));
    }

    #[test]
    fn server_tool_required_does_not_force_web_search_route() {
        let features = RoutingFeatures {
            latest_message_from_user: true,
            has_tools: true,
            metadata: json!({ "serverToolRequired": true }),
            ..Default::default()
        };

        let result = test_classifier().classify(&features);

        assert_eq!(result.route_name, "thinking");
        assert!(result.reasoning.contains("thinking:user-input"));
        // tools:tool-request-detected is NOT triggered on fresh user turns
        assert!(
            !result.reasoning.contains("tools:tool-request-detected"),
            "fresh user turn must not trigger tools:tool-request-detected"
        );
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

        let result = test_classifier().classify(&features);

        assert_eq!(result.route_name, "thinking");
        assert!(result.reasoning.contains("thinking:user-input"));
        // tools:tool-request-detected is NOT triggered on fresh user turns
        assert!(
            !result.reasoning.contains("tools:tool-request-detected"),
            "fresh user turn must not trigger tools:tool-request-detected"
        );
    }

    #[test]
    fn longcontext_overrides_current_user_thinking_route_when_context_is_too_large() {
        let features = RoutingFeatures {
            latest_message_from_user: true,
            has_tools: true,
            estimated_tokens: 250_000,
            ..Default::default()
        };

        let result = test_classifier().classify(&features);

        assert!(result.reasoning.contains("longcontext:token-threshold"));
        assert_eq!(result.route_name, "longcontext");
        assert_eq!(
            result.candidates,
            vec!["longcontext".to_string(), DEFAULT_ROUTE.to_string()]
        );
    }

    #[test]
    fn longcontext_does_not_override_coding_continuation() {
        let features = RoutingFeatures {
            latest_message_from_user: false,
            has_tools: true,
            has_tool_call_responses: true,
            estimated_tokens: 250_000,
            last_assistant_tool_category: Some("coding".to_string()),
            ..Default::default()
        };

        let result = test_classifier().classify(&features);

        assert_eq!(result.route_name, "coding");
        assert!(result.reasoning.contains("coding:last-tool-coding"));
        assert!(result.reasoning.contains("longcontext:token-threshold"));
    }

    #[test]
    fn longcontext_routes_when_no_stronger_route_signal_exists() {
        let features = RoutingFeatures {
            latest_message_from_user: false,
            has_tools: false,
            has_tool_call_responses: false,
            estimated_tokens: 250_000,
            ..Default::default()
        };

        let result = test_classifier().classify(&features);

        assert_eq!(result.route_name, "longcontext");
        assert!(result.reasoning.contains("longcontext:token-threshold"));
    }

    #[test]
    fn tool_intent_routes_to_web_search() {
        let features = RoutingFeatures {
            latest_message_from_user: false,
            has_tools: true,
            has_tool_call_responses: true,
            last_assistant_tool_category: Some("websearch".to_string()),
            ..Default::default()
        };

        let result = test_classifier().classify(&features);

        assert_eq!(result.route_name, "web_search");
        assert!(result.reasoning.contains("web_search:tool-intent"));
    }

    #[test]
    fn chinese_search_intent_routes_to_web_search() {
        let features = RoutingFeatures {
            latest_message_from_user: true,
            user_text_sample: "上网搜下 minimax m2.7 官方如何支持图片输入".to_string(),
            ..Default::default()
        };

        let result = test_classifier().classify(&features);

        assert_eq!(result.route_name, "web_search");
        assert!(result.reasoning.contains("web_search:explicit-or-intent"));
    }

    // Stopless followup forces thinking even when the next-turn message is tool role.
    #[test]
    fn stopless_followup_routes_to_thinking_without_user_text() {
        let features = RoutingFeatures {
            latest_message_from_user: false,
            has_tool_call_responses: true,
            metadata: json!({ "runtime_control": { "serverToolFollowup": true } }),
            ..Default::default()
        };

        let result = test_classifier().classify(&features);

        assert_eq!(result.route_name, "thinking");
        assert!(result.reasoning.contains("thinking:user-input"));
    }

    #[test]
    fn legacy_followup_metadata_does_not_force_thinking() {
        let features = RoutingFeatures {
            latest_message_from_user: false,
            has_tool_call_responses: true,
            metadata: json!({
                "serverToolFollowup": true,
                "__rt": { "serverToolFollowup": true }
            }),
            ..Default::default()
        };

        let result = test_classifier().classify(&features);

        assert_eq!(result.route_name, "tools");
        assert!(!result.reasoning.contains("thinking:user-input"));
    }

    // Without serverToolFollowup, tool-role continuation goes to tools (not thinking).
    #[test]
    fn no_followup_no_user_route_goes_to_tools_not_thinking() {
        let features = RoutingFeatures {
            latest_message_from_user: false,
            has_tool_call_responses: true,
            last_assistant_tool_category: Some("other".to_string()),
            metadata: json!({}),
            ..Default::default()
        };

        let result = test_classifier().classify(&features);

        assert_eq!(result.route_name, "tools");
        assert!(!result.reasoning.contains("thinking"));
    }
}
