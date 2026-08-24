use routecodex_v3_config::{
    V3Config05ManifestPublished, V3RouteActionManifest, V3RouteConditionManifest,
    V3RoutePolicyManifest,
};
use routecodex_v3_route_classifier::{
    build_v3_current_turn_route_facts, evaluate_v3_route_policies, V3RouteCondition,
    V3RouteHistoryWindow, V3RoutePolicy, V3RoutePolicyAction, V3RouteTurnObservation,
};
use routecodex_v3_virtual_router::{V3Router05RequestClassified, V3VirtualRouter};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

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
        static SHARED_PENDING: OnceLock<
            Arc<Mutex<BTreeMap<V3RoutePolicyRequestKey, V3PendingRoutePolicyTurn>>>,
        > = OnceLock::new();
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
        let request_is_compaction = classified
            .endpoint
            .trim_end_matches('/')
            .ends_with("/responses/compact")
            || classified.facts.route_classification.route_name == "compact";
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
                if request_is_compaction {
                    Some("compact".to_string())
                } else {
                    pending.action.map(|action| action.route_pool)
                },
            ));
        }

        let history = self
            .histories
            .lock()
            .map_err(|error| format!("route policy history lock poisoned: {error}"))?
            .get(&scope)
            .cloned()
            .unwrap_or_else(|| V3RouteHistoryWindow::new(max_policy_window(&policies)));
        let mut history_with_current = history;
        history_with_current.record_turn(observation.clone());
        let action =
            evaluate_v3_route_policies(&policies, observation.clone(), &history_with_current)
                .map_err(|error| format!("route policy evaluation failed: {error:?}"))?;
        self.pending
            .lock()
            .map_err(|error| format!("route policy pending lock poisoned: {error}"))?
            .insert(
                key,
                V3PendingRoutePolicyTurn {
                    observation,
                    action: action.clone(),
                },
            );
        Ok(V3VirtualRouter::with_route_policy_pool(
            classified,
            if request_is_compaction {
                Some("compact".to_string())
            } else {
                action.map(|action| action.route_pool)
            },
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
    let Some(group) = manifest.route_groups.get(routing_group_id) else {
        return Ok(Vec::new());
    };
    group
        .route_policies
        .iter()
        .map(compile_route_policy)
        .collect()
}

pub fn observe_route_turn(body: &Value, route_name: &str) -> V3RouteTurnObservation {
    let current = build_v3_current_turn_route_facts(body);
    V3RouteTurnObservation {
        new_user_input: current.latest_message_from_user,
        is_compaction: current.is_compaction || route_name == "compact",
        search_pool_hit: route_name == "search",
        tool_execution_error: current.has_current_turn_tool_execution_error,
        tool_name: current.last_assistant_tool.map(|tool| tool.name),
        route_pool: route_name.to_string(),
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
        .max(5)
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
    use routecodex_v3_route_classifier::{RouteClassification, V3RouteCondition};
    use routecodex_v3_virtual_router::V3RouterRequestFacts;
    use std::collections::BTreeSet;

    fn manifest() -> V3Config05ManifestPublished {
        let source = r#"
version = 3
[servers.test]
bind = "127.0.0.1"
port = 5555
routing_group = "test"
endpoints = ["responses"]
[providers.primary]
type = "responses"
base_url = "http://primary.invalid/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "PRIMARY_KEY" }] }
[providers.primary.models.gpt-test]
wire_name = "gpt-test"
capabilities = ["text", "tools", "reasoning"]
[route_groups.test]
compact_route_object = "compact"
[[route_groups.test.route_policies]]
id = "compact"
precedence = 1
condition = { kind = "current_compaction" }
action = { select_route_pool = "compact" }
[[route_groups.test.route_policies]]
id = "search"
precedence = 2
condition = { kind = "search_pool_turn_ratio_at_least", window_turns = 10, numerator = 4, denominator = 5 }
action = { select_route_pool = "thinking" }
[[route_groups.test.route_policies]]
id = "errors"
precedence = 3
condition = { kind = "tool_execution_error_turns_at_least", window_turns = 5, count = 3 }
action = { select_route_pool = "thinking" }
[route_groups.test.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "primary", model = "gpt-test", key = "key1", priority = 1 }]
[route_groups.test.pools.compact]
route_object = "compact"
selection = { strategy = "priority" }
match = { precedence = 5, entry_protocol = "responses" }
targets = [{ kind = "provider_model", provider = "primary", model = "gpt-test", key = "key1", priority = 1 }]
[route_groups.test.pools.thinking]
selection = { strategy = "priority" }
match = { precedence = 6, entry_protocol = "responses" }
targets = [{ kind = "provider_model", provider = "primary", model = "gpt-test", key = "key1", priority = 1 }]
"#;
        compile_v3_config_05_manifest(
            parse_v3_config_02_authoring(source).expect("route policy authoring"),
        )
        .expect("route policy manifest")
    }

    fn classified() -> V3Router05RequestClassified {
        V3Router05RequestClassified {
            server_id: "test".into(),
            routing_group_id: "test".into(),
            endpoint: "/v1/responses".into(),
            facts: V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: None,
                capabilities: BTreeSet::new(),
                input_tokens: 0,
                route_classification: RouteClassification::default(),
            },
            route_policy_pool: None,
        }
    }

    fn scope() -> V3RoutePolicyScope {
        V3RoutePolicyScope::without_conversation("test", "test", "session", "5555")
            .with_conversation("session")
    }

    #[test]
    fn runtime_commits_current_turn_once_and_discard_does_not_pollute_history() {
        let state = V3RoutePolicyRuntimeState::default();
        let manifest = manifest();
        let scope = scope();
        let policies = compile_route_policies(&manifest, "test").expect("policies");
        let search = V3RouteTurnObservation {
            search_pool_hit: true,
            ..Default::default()
        };
        for request in 0..7 {
            let request_id = format!("search-{request}");
            state
                .evaluate_request(
                    &manifest,
                    classified(),
                    scope.clone(),
                    &request_id,
                    search.clone(),
                )
                .expect("evaluate");
            state
                .commit_request(&scope, &request_id, &policies)
                .expect("commit");
        }
        let dropped = "dropped";
        state
            .evaluate_request(
                &manifest,
                classified(),
                scope.clone(),
                dropped,
                V3RouteTurnObservation::default(),
            )
            .expect("evaluate dropped");
        state.discard_request(&scope, dropped).expect("discard");
        let action = state
            .evaluate_request(&manifest, classified(), scope.clone(), "current", search)
            .expect("evaluate current")
            .route_policy_pool;
        assert_eq!(action.as_deref(), Some("thinking"));
    }

    #[test]
    fn provider_failure_observation_is_not_a_tool_error() {
        let body = serde_json::json!({
            "error": {"message": "upstream unavailable"},
            "messages": [{"role": "user", "content": "hi"}]
        });
        let observation = observe_route_turn(&body, "default");
        assert!(!observation.tool_execution_error);
        assert!(!observation.search_pool_hit);
    }

    #[test]
    fn compact_observation_is_independent_from_history_conditions() {
        let observation = observe_route_turn(&serde_json::json!({}), "compact");
        assert!(observation.is_compaction);
        let policy = V3RoutePolicy {
            id: "compact".into(),
            precedence: 1,
            condition: V3RouteCondition::CurrentCompaction,
            route_pool: "compact".into(),
        };
        let action =
            evaluate_v3_route_policies(&[policy], observation, &V3RouteHistoryWindow::new(1))
                .expect("compact evaluation")
                .expect("compact action");
        assert_eq!(action.route_pool, "compact");
    }
}
