use serde_json::{Map, Value};

#[derive(Debug, Clone)]
pub(super) struct SelectionResult {
    pub provider_key: String,
    pub route_used: String,
    pub pool: Vec<String>,
    pub route_pool: Vec<String>,
    pub pool_id: Option<String>,
    pub route_params: Option<Map<String, Value>>,
    pub route_thinking: Option<String>,
    pub unavailable_providers: Option<Value>,
    pub reasoning_tag: Option<String>,
    pub default_floor_protected: bool,
}

impl SelectionResult {
    pub(super) fn new(
        provider_key: String,
        route_used: String,
        pool: Vec<String>,
        route_pool: Vec<String>,
        pool_id: Option<String>,
    ) -> Self {
        Self {
            provider_key,
            route_used,
            pool,
            route_pool,
            pool_id,
            route_params: None,
            route_thinking: None,
            unavailable_providers: None,
            reasoning_tag: None,
            default_floor_protected: false,
        }
    }

    pub(super) fn with_route_params(mut self, route_params: Option<Map<String, Value>>) -> Self {
        self.route_params = route_params;
        self
    }

    pub(super) fn with_route_thinking(mut self, route_thinking: Option<String>) -> Self {
        self.route_thinking = route_thinking;
        self
    }

    pub(super) fn with_unavailable_providers(
        mut self,
        unavailable_providers: Option<Value>,
    ) -> Self {
        self.unavailable_providers = unavailable_providers;
        self
    }

    pub(super) fn with_reasoning_tag(mut self, reasoning_tag: Option<String>) -> Self {
        self.reasoning_tag = reasoning_tag;
        self
    }

    pub(super) fn with_default_floor_protected(mut self, protected: bool) -> Self {
        self.default_floor_protected = protected;
        self
    }
}
