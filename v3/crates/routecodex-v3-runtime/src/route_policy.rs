use routecodex_v3_config::{
    V3RouteConditionManifest, V3RoutePolicyManifest, V3RouteActionManifest,
    V3Config05ManifestPublished,
};
use routecodex_v3_route_classifier::{
    build_v3_current_turn_route_facts, evaluate_v3_route_policies, V3RouteCondition,
    V3RouteHistoryWindow, V3RoutePolicy, V3RoutePolicyAction, V3RouteTurnObservation,
};
use routecodex_v3_virtual_router::{
    V3Router05RequestClassified, V3VirtualRouter,
};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct V3RoutePolicyScope {
    pub server_id: String,
    pub routing_group_id: String,
    pub session_id: String,
    pub conversation_id: String,
    pub port: String,
}

impl V3RoutePolicyScope {
    pub fn without_conversation(
        server_id: impl Into<String>,
        routing_group_id: impl Into<String>,
        session_id: impl Into<String>,
        port: impl Into<String>,
    ) -> Self {
        Self {
            server_id: server_id.into(),
            routing_group_id: routing_group_id.into(),
            session_id: session_id.into(),
            conversation_id: String::new(),
            port: port.into(),
        }
    }

    pub fn with_conversation(mut self, conversation_id: impl Into<String>) -> Self {
        self.conversation_id = conversation_id.into();
        self
    }

    fn history_key_is_valid(&self) -> bool {
        !self.server_id.trim().is_empty()
            && !self.routing_group_id.trim().is_empty()
            && !self.session_id.trim().is_empty()
            && !self.port.trim().is_empty()
            && !self.conversation_id.trim().is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct V3RoutePolicyRequestKey {
    scope: V3RoutePolicyScope,
    request_id: String,
}

#[derive(Debug, Clone)]
struct V3PendingRoutePolicyTurn {
    observation: V3RouteTurnObservation,
    action: Option<V3RoutePolicyAction>,
}

#[derive(Debug, Clone, Default)]
pub struct V3RoutePolicyRuntimeState {
    histories: Arc<Mutex<BTreeMap<V3RoutePolicyScope, V3RouteHistoryWindow>>>,
    pending: Arc<Mutex<BTreeMap<V3RoutePolicyRequestKey, V3PendingRoutePolicyTurn>>>,
}

impl V3RoutePolicyRuntimeState {
    pub fn process_shared() -> Self {
        use std::sync::OnceLock;
        static SHARED: OnceLock<Arc<Mutex<BTreeMap<V3RoutePolicyScope, V3RouteHistoryWindow>>>> =
            OnceLock::new();
        static SHARED_PENDING: OnceLock<Arc<Mutex<BTreeMap<V3RoutePolicyRequestKey, V3PendingRoutePolicyTurn>>>> =
            OnceLock::new();
        Self {
            histories: SHARED.get_or_init(Default::default).clone(),
            pending: SHARED_PENDING.get_or_init(Default::default).clone(),
        }
    }

    pub fn evaluate_request(
        &self,
        manifest: &V3Config05ManifestPublished,
        classified: V3Router05RequestClassified,
        scope: V3RoutePolicyScope,
        request_id: &str,
        observation: V3RouteTurnObservation,
    ) -> Result<V3Router05RequestClassified, String> {
        let policies = compile_route_policies(manifest, &classified.routing_group_id)?;
        let key = V3RoutePolicyRequestKey {
            scope: scope.clone(),
            request_id: request_id.to_string(),
        };
        if let Some(pending) = self
            .pending
            .lock()
            .map_err(|error| format!("route policy pending lock poisoned: {error}"))?
            .get(&key)
            .cloned()
        {
            return Ok(V3VirtualRouter::with_route_policy_pool(
                classified,
                pending.action.map(|action| action.route_pool),
            ));
        }

        let history = self
            .histories
            .lock()
            .map_err(|error| format!("route policy history lock poisoned: {error}"))?
            .get(&scope)
            .cloned()
            .unwrap_or_else(|| V3RouteHistoryWindow::new(max_policy_window(&policies)));
        let action = evaluate_v3_route_policies(&policies, observation.clone(), &history)
            .map_err(|error| format!("route policy evaluation failed: {error:?}"))?;
        self.pending
            .lock()
            .map_err(|error| format!("route policy pending lock poisoned: {error}"))?
            .insert(key, V3PendingRoutePolicyTurn { observation, action: action.clone() });
        Ok(V3VirtualRouter::with_route_policy_pool(
            classified,
            action.map(|action| action.route_pool),
        ))
    }

    pub fn commit_request(
        &self,
        scope: &V3RoutePolicyScope,
        request_id: &str,
        policies: &[V3RoutePolicy],
    ) -> Result<(), String> {
        let key = V3RoutePolicyRequestKey {
            scope: scope.clone(),
            request_id: request_id.to_string(),
        };
        let Some(pending) = self
            .pending
            .lock()
            .map_err(|error| format!("route policy pending lock poisoned: {error}"))?
            .remove(&key)
        else {
            return Ok(());
        };
        if !scope.history_key_is_valid() {
            return Ok(());
        }
        self.histories
            .lock()
            .map_err(|error| format!("route policy history lock poisoned: {error}"))?
            .entry(scope.clone())
            .or_insert_with(|| V3RouteHistoryWindow::new(max_policy_window(policies)))
            .record_turn(pending.observation);
        Ok(())
    }

    pub fn discard_request(
        &self,
        scope: &V3RoutePolicyScope,
        request_id: &str,
    ) -> Result<(), String> {
        let key = V3RoutePolicyRequestKey {
            scope: scope.clone(),
            request_id: request_id.to_string(),
        };
        self.pending
            .lock()
            .map_err(|error| format!("route policy pending lock poisoned: {error}"))?
            .remove(&key);
        Ok(())
    }
}

pub fn compile_route_policies(
    manifest: &V3Config05ManifestPublished,
    routing_group_id: &str,
) -> Result<Vec<V3RoutePolicy>, String> {
    let group = manifest
        .route_groups
        .get(routing_group_id)
        .ok_or_else(|| format!("route group {routing_group_id} is absent"))?;
    group
        .route_policies
        .iter()
        .map(compile_route_policy)
        .collect()
}

pub fn observe_route_turn(
    body: &Value,
    route_name: &str,
) -> V3RouteTurnObservation {
    let current = build_v3_current_turn_route_facts(body);
    V3RouteTurnObservation {
        new_user_input: current.latest_message_from_user,
        is_compaction: current.is_compaction || route_name == "compact",
        search_pool_hit: route_name == "search",
        tool_execution_error: current.has_current_turn_tool_execution_error,
    }
}

fn compile_route_policy(policy: &V3RoutePolicyManifest) -> Result<V3RoutePolicy, String> {
    let condition = match &policy.condition {
        V3RouteConditionManifest::CurrentCompaction => V3RouteCondition::CurrentCompaction,
        V3RouteConditionManifest::SearchPoolTurnRatioAtLeast {
            window_turns,
            numerator,
            denominator,
        } => V3RouteCondition::SearchPoolTurnRatioAtLeast {
            window_turns: *window_turns,
            numerator: *numerator,
            denominator: *denominator,
        },
        V3RouteConditionManifest::ToolExecutionErrorTurnsAtLeast {
            window_turns,
            count,
        } => V3RouteCondition::ToolExecutionErrorTurnsAtLeast {
            window_turns: *window_turns,
            count: *count,
        },
    };
    let V3RouteActionManifest { select_route_pool } = &policy.action;
    Ok(V3RoutePolicy {
        id: policy.id.clone(),
        precedence: policy.precedence,
        condition,
        route_pool: select_route_pool.clone(),
    })
}

fn max_policy_window(policies: &[V3RoutePolicy]) -> usize {
    policies
        .iter()
        .map(|policy| match &policy.condition {
            V3RouteCondition::CurrentCompaction => 1,
            V3RouteCondition::SearchPoolTurnRatioAtLeast { window_turns, .. }
            | V3RouteCondition::ToolExecutionErrorTurnsAtLeast { window_turns, .. } => {
                *window_turns
            }
        })
        .max()
        .unwrap_or(1)
}
