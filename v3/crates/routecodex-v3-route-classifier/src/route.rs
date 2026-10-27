#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct V3CurrentTurnRouteFacts {
    /// Typed facts are the only input to route classification. This type must
    /// not expose request/response payload or metadata carriers.
    pub reached_long_context: bool,
    pub is_compaction: bool,
    pub has_image_attachment: bool,
    pub latest_message_from_user: bool,
    pub has_current_turn_tool_output: bool,
    pub has_current_turn_tool_execution_error: bool,
    pub has_current_turn_web_search: bool,
    pub last_assistant_tool_category: Option<String>,
    /// Every independent tool category observed in the current turn. A turn
    /// can contain several calls; route classification must keep all real
    /// matches so a later lower-priority call cannot shadow an earlier one.
    /// Empty means "no full set was supplied" and the single
    /// `last_assistant_tool_category` is used as a legacy fallback.
    pub current_turn_tool_categories: Vec<String>,
    pub has_background_keyword: bool,
    pub current_user_text: String,
}

pub type RouteClassifierInput = V3CurrentTurnRouteFacts;

pub const DEFAULT_ROUTE: &str = "default";

pub const ROUTE_PRIORITY: [&str; 9] = [
    "compact",
    "web_search",
    "multimodal",
    "longcontext",
    "coding",
    "thinking",
    "search",
    "tools",
    DEFAULT_ROUTE,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteClassification {
    pub route_name: String,
    pub reasoning: String,
    pub candidates: Vec<String>,
    pub required_capabilities: Vec<String>,
}

impl Default for RouteClassification {
    fn default() -> Self {
        Self {
            route_name: DEFAULT_ROUTE.to_string(),
            reasoning: "default:route-selected".to_string(),
            candidates: vec![DEFAULT_ROUTE.to_string()],
            required_capabilities: Vec::new(),
        }
    }
}

pub fn classify_route(input: &V3CurrentTurnRouteFacts) -> RouteClassification {
    let thinking_from_user = input.latest_message_from_user;
    let continuation = !input.latest_message_from_user && input.has_current_turn_tool_output;
    let categories: Vec<&str> = if input.current_turn_tool_categories.is_empty() {
        input
            .last_assistant_tool_category
            .iter()
            .map(String::as_str)
            .collect()
    } else {
        input
            .current_turn_tool_categories
            .iter()
            .map(String::as_str)
            .collect()
    };
    let has_category = |category: &str| categories.contains(&category);
    let thinking_continuation = continuation && has_category("thinking");
    let coding_continuation = continuation && has_category("coding");
    let search_continuation = continuation && has_category("search");
    let other_tool_continuation = continuation && has_category("other");
    let unknown_tool_continuation = continuation && categories.is_empty();
    let current_user_web_search_intent = input.latest_message_from_user
        && crate::tools::has_current_user_web_search_intent(&input.current_user_text);
    let web_search = input.latest_message_from_user
        && (input.has_current_turn_web_search || current_user_web_search_intent);

    let evaluation = vec![
        ("compact", input.is_compaction, "compact:registered-ingress"),
        ("compact", input.is_compaction, "compact:request-purpose"),
        (
            "web_search",
            web_search,
            if current_user_web_search_intent {
                "web_search:user-text-intent"
            } else {
                "web_search:explicit-or-intent"
            },
        ),
        (
            "multimodal",
            input.has_image_attachment,
            "multimodal:metadata-attachment",
        ),
        (
            "longcontext",
            input.reached_long_context,
            "longcontext:token-threshold",
        ),
        ("coding", coding_continuation, "coding:last-tool-coding"),
        (
            "thinking",
            thinking_from_user || thinking_continuation,
            if thinking_continuation {
                "thinking:last-tool-thinking"
            } else {
                "thinking:user-input"
            },
        ),
        ("search", search_continuation, "search:last-tool-search"),
        (
            "tools",
            other_tool_continuation || unknown_tool_continuation,
            if other_tool_continuation {
                "tools:last-tool-other"
            } else {
                "tools:tool-request-detected"
            },
        ),
    ];

    let mut matched = ROUTE_PRIORITY.iter().filter_map(|route| {
        evaluation
            .iter()
            .find(|(name, triggered, _)| name == route && *triggered)
            .map(|(_, _, reason)| ((*route).to_string(), (*reason).to_string()))
    });
    let (route_name, primary_reason) = matched.next().unwrap_or_else(|| {
        (
            DEFAULT_ROUTE.to_string(),
            "default:route-selected".to_string(),
        )
    });
    let candidates = if route_name == "compact" {
        vec!["compact".to_string(), DEFAULT_ROUTE.to_string()]
    } else {
        let mut candidates = ROUTE_PRIORITY
            .iter()
            .filter(|route| **route != "compact" && **route != DEFAULT_ROUTE)
            .filter(|route| {
                evaluation
                    .iter()
                    .any(|(name, triggered, _)| name == *route && *triggered)
            })
            .map(|route| (*route).to_string())
            .collect::<Vec<_>>();
        if !candidates.iter().any(|route| route == &route_name) {
            candidates.push(route_name.clone());
        }
        if !candidates.iter().any(|route| route == DEFAULT_ROUTE) {
            candidates.push(DEFAULT_ROUTE.to_string());
        }
        candidates
    };

    let mut reasoning = vec![primary_reason.clone()];
    for (_, triggered, reason) in &evaluation {
        if *triggered && *reason != primary_reason && !reasoning.iter().any(|item| item == reason) {
            reasoning.push((*reason).to_string());
        }
    }
    let mut required_capabilities = Vec::new();
    if web_search && !input.is_compaction {
        required_capabilities.push("web_search".to_string());
    }

    RouteClassification {
        route_name,
        reasoning: reasoning.join("|"),
        candidates,
        required_capabilities,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_priority_keeps_longcontext_between_multimodal_and_coding() {
        assert_eq!(
            ROUTE_PRIORITY,
            [
                "compact",
                "web_search",
                "multimodal",
                "longcontext",
                "coding",
                "thinking",
                "search",
                "tools",
                DEFAULT_ROUTE,
            ]
        );
    }
}
