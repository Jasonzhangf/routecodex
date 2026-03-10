use napi::Ref;
use serde_json::{Map, Value};
use std::collections::HashMap;

use super::super::classifier::RoutingClassifier;
use super::super::health::{ProviderHealthConfig, ProviderHealthManager};
use super::super::instructions::RoutingInstructionState;
use super::super::load_balancer::{LoadBalancingPolicy, RouteLoadBalancer};
use super::super::provider_registry::ProviderRegistry;
use super::super::routing::{parse_routing, RoutingPools};
use super::types::PendingAliasBinding;

pub(crate) struct VirtualRouterEngineCore {
    pub routing: RoutingPools,
    pub provider_registry: ProviderRegistry,
    pub health_manager: ProviderHealthManager,
    pub load_balancer: RouteLoadBalancer,
    pub classifier: RoutingClassifier,
    pub routing_instruction_state: HashMap<String, RoutingInstructionState>,
    pub web_search_force: bool,
    pub pending_alias: Option<PendingAliasBinding>,
    pub antigravity_session_alias_store: HashMap<String, String>,
    pub quota_view: Option<Ref<()>>,
}

impl VirtualRouterEngineCore {
    pub(crate) fn new() -> Self {
        Self {
            routing: RoutingPools::default(),
            provider_registry: ProviderRegistry::default(),
            health_manager: ProviderHealthManager::new(),
            load_balancer: RouteLoadBalancer::new(None),
            classifier: RoutingClassifier::new(&Value::Object(Map::new())),
            routing_instruction_state: HashMap::new(),
            web_search_force: false,
            pending_alias: None,
            antigravity_session_alias_store: HashMap::new(),
            quota_view: None,
        }
    }

    pub(crate) fn initialize(&mut self, config: &Value) -> Result<(), String> {
        let routing_value = config
            .get("routing")
            .and_then(|v| v.as_object())
            .ok_or("routing configuration missing")?;
        let providers_value = config
            .get("providers")
            .and_then(|v| v.as_object())
            .ok_or("providers configuration missing")?;
        let routing = parse_routing(routing_value);
        self.provider_registry.load(providers_value);
        self.routing = routing;
        let health_config = config
            .get("health")
            .cloned()
            .and_then(|v| serde_json::from_value::<ProviderHealthConfig>(v).ok());
        self.health_manager.configure(health_config);
        let provider_keys = self.provider_registry.list_keys();
        self.health_manager.register_providers(&provider_keys);
        let load_balancing = config
            .get("loadBalancing")
            .cloned()
            .and_then(|v| serde_json::from_value::<LoadBalancingPolicy>(v).ok());
        self.load_balancer = RouteLoadBalancer::new(load_balancing);
        let classifier_config = config
            .get("classifier")
            .cloned()
            .unwrap_or(Value::Object(Map::new()));
        self.classifier = RoutingClassifier::new(&classifier_config);
        let web_search_force = config
            .get("webSearch")
            .and_then(|v| v.get("force"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        self.web_search_force = web_search_force;
        Ok(())
    }

    pub(crate) fn update_quota_view(&mut self, quota_view: Option<Ref<()>>) {
        self.quota_view = quota_view;
    }
}
