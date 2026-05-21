use napi::Ref;
use serde_json::{Map, Value};
use std::collections::HashMap;

use super::super::classifier::RoutingClassifier;
use super::super::health::{ProviderHealthConfig, ProviderHealthManager};
use super::super::instructions::RoutingInstructionState;
use super::super::load_balancer::{LoadBalancingPolicy, RouteLoadBalancer};
use super::super::provider_registry::ProviderRegistry;
use super::super::routing::{parse_routing, RoutingPools};
use super::super::routing_state_store::{load_provider_health_state, persist_provider_health_state};
use super::super::time_utils::now_ms;

/// Default TTL for concurrency busy entries (60 seconds).
/// Prevents leaked busy marks from permanently blocking a provider.
const CONCURRENCY_BUSY_TTL_MS: i64 = 60_000;
const DEFAULT_CONTEXT_WARN_RATIO: f64 = 0.9;

pub(crate) struct VirtualRouterEngineCore {
    pub routing: RoutingPools,
    pub provider_registry: ProviderRegistry,
    pub health_manager: ProviderHealthManager,
    pub load_balancer: RouteLoadBalancer,
    pub classifier: RoutingClassifier,
    pub routing_instruction_state: HashMap<String, RoutingInstructionState>,
    pub web_search_force: bool,
    pub quota_view: Option<Ref<()>>,
    pub context_warn_ratio: f64,
    pub context_hard_limit: bool,
    pub(crate) concurrency_busy_keys: HashMap<String, i64>,  // key -> expires_at_ms
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
            quota_view: None,
            context_warn_ratio: DEFAULT_CONTEXT_WARN_RATIO,
            context_hard_limit: false,
            concurrency_busy_keys: HashMap::new(),
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
        if let Some(raw) = load_provider_health_state() {
            self.health_manager.import_persistable_state(&raw, now_ms());
        }
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
        let context_routing = config.get("contextRouting").and_then(|v| v.as_object());
        self.context_warn_ratio = context_routing
            .and_then(|row| row.get("warnRatio").and_then(|v| v.as_f64()))
            .or_else(|| {
                context_routing.and_then(|row| row.get("warn_ratio").and_then(|v| v.as_f64()))
            })
            .map(|value| value.clamp(0.1, 0.99))
            .unwrap_or(DEFAULT_CONTEXT_WARN_RATIO);
        self.context_hard_limit = context_routing
            .and_then(|row| row.get("hardLimit").and_then(|v| v.as_bool()))
            .or_else(|| {
                context_routing.and_then(|row| row.get("hard_limit").and_then(|v| v.as_bool()))
            })
            .unwrap_or(false);
        Ok(())
    }

    pub(crate) fn persist_provider_health(&self) {
        let raw = self.health_manager.export_persistable_state(now_ms());
        persist_provider_health_state(&raw);
    }

    pub(crate) fn update_quota_view(&mut self, quota_view: Option<Ref<()>>) {
        self.quota_view = quota_view;
    }

    pub(crate) fn mark_concurrency_scope_busy(&mut self, scope_key: &str) {
        let expires_at = now_ms() + CONCURRENCY_BUSY_TTL_MS;
        self.concurrency_busy_keys
            .insert(scope_key.to_string(), expires_at);
    }

    pub(crate) fn mark_concurrency_scope_idle(&mut self, scope_key: &str) {
        self.concurrency_busy_keys.remove(scope_key);
    }

    /// GC expired concurrency busy entries. Call periodically (e.g. at route entry/exit).
    pub(crate) fn gc_concurrency_busy_expired(&mut self) {
        let now = now_ms();
        self.concurrency_busy_keys.retain(|_, expires_at| *expires_at > now);
    }

    pub(crate) fn is_concurrency_busy(&self, provider_key: &str) -> bool {
        let now = now_ms();
        match self.concurrency_busy_keys.get(provider_key) {
            Some(expires_at) => *expires_at > now,
            None => false,
        }
    }

    pub(crate) fn concurrency_busy_remaining_ms(&self, provider_key: &str, now_ms: i64) -> Option<i64> {
        let expires_at = *self.concurrency_busy_keys.get(provider_key)?;
        if expires_at <= now_ms {
            return None;
        }
        Some((expires_at - now_ms).max(1))
    }

    pub(crate) fn concurrency_busy_remaining_for_provider(
        &self,
        provider_key: &str,
        now_ms: i64,
    ) -> Option<i64> {
        let direct = self.concurrency_busy_remaining_ms(provider_key, now_ms);
        let runtime = self
            .provider_registry
            .get(provider_key)
            .and_then(|profile| profile.runtime_key.as_deref())
            .filter(|runtime_key| !runtime_key.is_empty() && *runtime_key != provider_key)
            .and_then(|runtime_key| self.concurrency_busy_remaining_ms(runtime_key, now_ms));
        match (direct, runtime) {
            (Some(left), Some(right)) => Some(left.min(right)),
            (Some(left), None) => Some(left),
            (None, Some(right)) => Some(right),
            (None, None) => None,
        }
    }
}
