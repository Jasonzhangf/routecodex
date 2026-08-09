pub const DEFAULT_ROUTE: &str = "default";

pub const ROUTE_PRIORITY: [&str; 8] = [
    "multimodal",
    "web_search",
    "longcontext",
    "thinking",
    "coding",
    "search",
    "tools",
    DEFAULT_ROUTE,
];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RouteClassifierInput {
    pub reached_long_context: bool,
    pub has_image_attachment: bool,
    pub latest_message_from_user: bool,
    pub stopless_followup: bool,
    pub has_current_turn_tool_output: bool,
    pub has_current_turn_web_search: bool,
    pub last_assistant_tool_category: Option<String>,
    pub current_user_text: String,
    pub has_background_keyword: bool,
}

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

pub fn classify_route(input: &RouteClassifierInput) -> RouteClassification {
    let last_tool_category = if input.latest_message_from_user {
        ""
    } else {
        input
            .last_assistant_tool_category
            .as_deref()
            .unwrap_or_default()
    };
    let thinking_from_user = input.latest_message_from_user || input.stopless_followup;
    let continuation = !input.latest_message_from_user && input.has_current_turn_tool_output;
    let thinking_continuation = continuation && last_tool_category == "thinking";
    let coding_continuation = continuation && last_tool_category == "coding";
    let search_continuation = continuation && last_tool_category == "search";
    let web_search_tool_intent = continuation && last_tool_category == "websearch";
    // V2 final semantics: web_search text-intent only counts when the request is a
    // user input turn (latest message from user, no tool output in current turn)
    // and has no image attachment (multimodal takes precedence). Restoration
    // targets the strict STRICT_TERMS list in `tools::has_web_search_intent`.
    let current_user_web_search_intent = input.latest_message_from_user
        && !input.has_current_turn_tool_output
        && !input.has_image_attachment
        && !input.current_user_text.trim().is_empty()
        && crate::tools::has_web_search_intent(&input.current_user_text);
    let other_tool_continuation = continuation && last_tool_category == "other";
    let unknown_tool_continuation = continuation && last_tool_category.is_empty();
    let web_search = web_search_tool_intent
        || input.has_current_turn_web_search
        || current_user_web_search_intent;

    let evaluation = vec![
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
        (
            "web_search",
            web_search,
            if web_search_tool_intent {
                "web_search:tool-intent"
            } else if current_user_web_search_intent {
                "web_search:user-text-intent"
            } else {
                "web_search:explicit-or-intent"
            },
        ),
        (
            "thinking",
            (thinking_from_user || thinking_continuation) && !input.reached_long_context,
            if thinking_continuation {
                "thinking:last-tool-thinking"
            } else {
                "thinking:user-input"
            },
        ),
        ("coding", coding_continuation, "coding:last-tool-coding"),
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

    let (route_name, primary_reason) = ROUTE_PRIORITY
        .iter()
        .find_map(|route| {
            evaluation
                .iter()
                .find(|(name, triggered, _)| name == route && *triggered)
                .map(|(_, _, reason)| ((*route).to_string(), (*reason).to_string()))
        })
        .unwrap_or_else(|| {
            (
                DEFAULT_ROUTE.to_string(),
                "default:route-selected".to_string(),
            )
        });

    let mut reasoning = vec![primary_reason.clone()];
    for (_, triggered, reason) in &evaluation {
        if *triggered && *reason != primary_reason && !reasoning.iter().any(|item| item == reason) {
            reasoning.push((*reason).to_string());
        }
    }
    let mut required_capabilities = Vec::new();
    if web_search {
        required_capabilities.push("web_search".to_string());
    }

    let mut candidates = vec![route_name.clone()];
    if route_name != "longcontext"
        && input.reached_long_context
        && !candidates.iter().any(|route| route == "longcontext")
    {
        candidates.push("longcontext".to_string());
    }
    if !candidates.iter().any(|route| route == DEFAULT_ROUTE) {
        candidates.push(DEFAULT_ROUTE.to_string());
    }

    RouteClassification {
        route_name,
        reasoning: reasoning.join("|"),
        candidates,
        required_capabilities,
    }
}
