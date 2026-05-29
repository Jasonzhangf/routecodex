use serde_json::{Map, Value};

#[derive(Debug, Clone)]
pub(super) struct SelectionResult {
    pub provider_key: String,
    pub route_used: String,
    pub pool: Vec<String>,
    pub pool_id: Option<String>,
    pub route_params: Option<Map<String, Value>>,
    pub unavailable_providers: Option<Value>,
}

impl SelectionResult {
    pub(super) fn new(
        provider_key: String,
        route_used: String,
        pool: Vec<String>,
        pool_id: Option<String>,
    ) -> Self {
        Self {
            provider_key,
            route_used,
            pool,
            pool_id,
            route_params: None,
            unavailable_providers: None,
        }
    }

    pub(super) fn with_route_params(mut self, route_params: Option<Map<String, Value>>) -> Self {
        self.route_params = route_params;
        self
    }

    pub(super) fn with_unavailable_providers(
        mut self,
        unavailable_providers: Option<Value>,
    ) -> Self {
        self.unavailable_providers = unavailable_providers;
        self
    }
}
