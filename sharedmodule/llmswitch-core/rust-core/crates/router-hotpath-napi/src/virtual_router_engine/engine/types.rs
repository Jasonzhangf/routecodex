#[derive(Debug, Clone)]
pub(super) struct SelectionResult {
    pub provider_key: String,
    pub route_used: String,
    pub pool: Vec<String>,
    pub pool_id: Option<String>,
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
        }
    }
}

