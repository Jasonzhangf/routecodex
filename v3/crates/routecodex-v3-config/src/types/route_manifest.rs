#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3RouteGroupManifest {
    pub id: String,
    pub pools: BTreeMap<String, V3RoutePoolManifest>,
    pub compact_route_object: Option<String>,
    pub route_policies: Vec<V3RoutePolicyManifest>,
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3RoutePolicyManifest {
    pub id: String,
    pub precedence: i32,
    pub condition: V3RouteConditionManifest,
    pub action: V3RouteActionManifest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3RouteConditionManifest {
    CurrentCompaction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3RouteActionManifest {
    pub select_route_pool: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3RoutePoolManifest {
    pub id: String,
    pub selection: V3SelectionPolicy,
    pub route_object: Option<String>,
    pub match_rule: Option<V3RoutePoolMatchManifest>,
    pub targets: Vec<V3RoutePoolTargetManifest>,
    pub features: BTreeMap<String, bool>,
}

impl V3RouteGroupManifest {
    pub fn route_pool_for_object(&self, route_object: &str) -> Option<&str> {
        self.pools.values().find_map(|pool| {
            (pool.route_object.as_deref() == Some(route_object)).then_some(pool.id.as_str())
        })
    }

    pub fn compact_route_pool(&self) -> Option<&str> {
        self.compact_route_object
            .as_deref()
            .and_then(|route_object| self.route_pool_for_object(route_object))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3RoutePoolMatchManifest {
    pub precedence: i32,
    pub entry_protocol: Option<String>,
    pub models: Vec<String>,
    pub required_capabilities: Vec<String>,
    pub min_input_tokens: Option<u64>,
    pub max_input_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3RoutePoolTargetManifest {
    pub kind: V3RouteTargetKind,
    pub id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub key: Option<String>,
    pub interface: Option<String>,
    pub priority: Option<i32>,
    pub weight: Option<u32>,
}

fn default_true() -> bool {
    true
}

fn default_hub_v1_skeleton() -> String {
    "hub_v1".to_string()
}

fn default_all_entry_protocols() -> Vec<String> {
    vec![
        "responses".to_string(),
        "anthropic".to_string(),
        "gemini".to_string(),
        "openai_chat".to_string(),
    ]
}
