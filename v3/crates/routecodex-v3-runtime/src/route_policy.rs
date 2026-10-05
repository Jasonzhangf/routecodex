use routecodex_v3_config::{
    V3Config05ManifestPublished, V3RouteActionManifest, V3RouteConditionManifest,
    V3RoutePolicyManifest,
};
use routecodex_v3_route_classifier::{
    build_v3_current_turn_route_facts_from_value, evaluate_v3_route_policies, V3RouteCondition,
    V3RouteHistoryWindow, V3RoutePolicy, V3RoutePolicyAction, V3RouteTurnObservation,
};
use routecodex_v3_virtual_router::{V3Router05RequestClassified, V3VirtualRouter};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, Weak};

const V3_ROUTE_POLICY_PENDING_TTL_MS: u64 = 60 * 60 * 1000;
const V3_ROUTE_POLICY_HISTORY_TTL_MS: u64 = 24 * 60 * 60 * 1000;
const V3_ROUTE_POLICY_MAX_PENDING_TURNS: usize = 4096;
const V3_ROUTE_POLICY_MAX_HISTORY_SCOPES: usize = 4096;

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
    guard_identity: Weak<()>,
    last_seen_ms: u64,
}

#[derive(Debug, Clone)]
struct V3RoutePolicyHistoryEntry {
    window: V3RouteHistoryWindow,
    last_seen_ms: u64,
}

#[derive(Debug, Clone)]
pub struct V3RoutePolicyPendingGuard {
    state: V3RoutePolicyRuntimeState,
    scope: V3RoutePolicyScope,
    request_id: String,
    identity: Arc<()>,
}

impl Drop for V3RoutePolicyPendingGuard {
    fn drop(&mut self) {
        if Arc::strong_count(&self.identity) == 1 {
            let _ =
                self.state
                    .discard_pending_identity(&self.scope, &self.request_id, &self.identity);
        }
    }
}

impl V3RoutePolicyPendingGuard {
    pub(crate) fn scope(&self) -> &V3RoutePolicyScope {
        &self.scope
    }

    /// Commit at the current wall-clock time. Relay/Direct runtimes own their
    /// clock; route policy only needs the resolved millisecond value.
    pub(crate) fn commit_manifest_now<E: From<String>>(
        &self,
        manifest: &V3Config05ManifestPublished,
    ) -> Result<(), E> {
        self.commit_from_manifest(
            manifest,
            crate::provider_failure_runtime_policy::v3_relay_provider_policy_now_epoch_ms()?,
        )
        .map_err(E::from)
    }

    pub(crate) fn commit(
        &self,
        policies: &[V3RoutePolicy],
        now_epoch_ms: u64,
    ) -> Result<(), String> {
        self.state.commit_request_from_guard(
            &self.scope,
            &self.request_id,
            policies,
            now_epoch_ms,
            &self.identity,
        )
    }

    pub(crate) fn commit_from_manifest(
        &self,
        manifest: &V3Config05ManifestPublished,
        now_epoch_ms: u64,
    ) -> Result<(), String> {
        let policies = compile_route_policies(manifest, &self.scope.routing_group_id)?;
        self.commit(&policies, now_epoch_ms)
    }
}

#[derive(Debug, Clone, Default)]
pub struct V3RoutePolicyRuntimeState {
    histories: Arc<Mutex<BTreeMap<V3RoutePolicyScope, V3RoutePolicyHistoryEntry>>>,
    pending: Arc<Mutex<BTreeMap<V3RoutePolicyRequestKey, V3PendingRoutePolicyTurn>>>,
}

impl V3RoutePolicyRuntimeState {
    pub fn process_shared() -> Self {
        use std::sync::OnceLock;
        static SHARED: OnceLock<
            Arc<Mutex<BTreeMap<V3RoutePolicyScope, V3RoutePolicyHistoryEntry>>>,
        > = OnceLock::new();
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
        now_epoch_ms: u64,
    ) -> Result<(V3Router05RequestClassified, V3RoutePolicyPendingGuard), String> {
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
        self.prune_pending(now_epoch_ms)?;
        self.prune_histories(now_epoch_ms)?;
        let mut pending_entries = self
            .pending
            .lock()
            .map_err(|error| format!("route policy pending lock poisoned: {error}"))?;
        if let Some(pending) = pending_entries.get(&key).cloned() {
            if let Some(identity) = pending.guard_identity.upgrade() {
                return Ok((
                    V3VirtualRouter::with_route_policy_pool(
                        classified,
                        if request_is_compaction {
                            Some("compact".to_string())
                        } else {
                            pending.action.map(|action| action.route_pool)
                        },
                    ),
                    V3RoutePolicyPendingGuard {
                        state: self.clone(),
                        scope,
                        request_id: request_id.to_string(),
                        identity,
                    },
                ));
            }
            // A dead guard cannot own this entry. Remove it before evaluating
            // a fresh turn so a reused request id cannot inherit stale state.
            pending_entries.remove(&key);
        }
        drop(pending_entries);

        let history = self
            .histories
            .lock()
            .map_err(|error| format!("route policy history lock poisoned: {error}"))?
            .get(&scope)
            .map(|entry| entry.window.clone())
            .unwrap_or_else(|| V3RouteHistoryWindow::new(max_policy_window(&policies)));
        let mut history_with_current = history;
        history_with_current.record_turn(observation.clone());
        let action =
            evaluate_v3_route_policies(&policies, observation.clone(), &history_with_current)
                .map_err(|error| format!("route policy evaluation failed: {error:?}"))?;
        let identity = Arc::new(());
        self.pending
            .lock()
            .map_err(|error| format!("route policy pending lock poisoned: {error}"))?
            .insert(
                key,
                V3PendingRoutePolicyTurn {
                    observation,
                    action: action.clone(),
                    guard_identity: Arc::downgrade(&identity),
                    last_seen_ms: now_epoch_ms,
                },
            );
        Ok((
            V3VirtualRouter::with_route_policy_pool(
                classified,
                if request_is_compaction {
                    Some("compact".to_string())
                } else {
                    action.map(|action| action.route_pool)
                },
            ),
            V3RoutePolicyPendingGuard {
                state: self.clone(),
                scope,
                request_id: request_id.to_string(),
                identity,
            },
        ))
    }

    pub(crate) fn commit_request_from_guard(
        &self,
        scope: &V3RoutePolicyScope,
        request_id: &str,
        policies: &[V3RoutePolicy],
        now_epoch_ms: u64,
        guard_identity: &Arc<()>,
    ) -> Result<(), String> {
        self.commit_or_discard_request(scope, request_id, policies, now_epoch_ms, guard_identity)
    }

    fn commit_or_discard_request(
        &self,
        scope: &V3RoutePolicyScope,
        request_id: &str,
        policies: &[V3RoutePolicy],
        now_epoch_ms: u64,
        guard_identity: &Arc<()>,
    ) -> Result<(), String> {
        let key = V3RoutePolicyRequestKey {
            scope: scope.clone(),
            request_id: request_id.to_string(),
        };
        let pending = {
            let mut pending_entries = self
                .pending
                .lock()
                .map_err(|error| format!("route policy pending lock poisoned: {error}"))?;
            let Some(pending) = pending_entries.get(&key).cloned() else {
                return Ok(());
            };
            let owns_pending = pending
                .guard_identity
                .upgrade()
                .is_some_and(|pending_identity| Arc::ptr_eq(&pending_identity, guard_identity));
            if !owns_pending {
                return Ok(());
            }
            pending_entries.remove(&key);
            pending
        };
        if !scope.history_key_is_valid() {
            return Ok(());
        }
        self.prune_histories(now_epoch_ms)?;
        self.histories
            .lock()
            .map_err(|error| format!("route policy history lock poisoned: {error}"))?
            .entry(scope.clone())
            .and_modify(|entry| {
                entry.window.record_turn(pending.observation.clone());
                entry.last_seen_ms = now_epoch_ms;
            })
            .or_insert_with(|| {
                let mut window = V3RouteHistoryWindow::new(max_policy_window(policies));
                window.record_turn(pending.observation);
                V3RoutePolicyHistoryEntry {
                    window,
                    last_seen_ms: now_epoch_ms,
                }
            });
        Ok(())
    }

    fn discard_pending_identity(
        &self,
        scope: &V3RoutePolicyScope,
        request_id: &str,
        identity: &Arc<()>,
    ) -> Result<(), String> {
        let key = V3RoutePolicyRequestKey {
            scope: scope.clone(),
            request_id: request_id.to_string(),
        };
        let mut pending = self
            .pending
            .lock()
            .map_err(|error| format!("route policy pending lock poisoned: {error}"))?;
        let owns_pending = pending.get(&key).is_some_and(|turn| {
            turn.guard_identity
                .upgrade()
                .is_some_and(|pending_identity| Arc::ptr_eq(&pending_identity, identity))
        });
        if owns_pending {
            pending.remove(&key);
        }
        Ok(())
    }

    fn prune_pending(&self, now_epoch_ms: u64) -> Result<(), String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|error| format!("route policy pending lock poisoned: {error}"))?;
        pending.retain(|_, turn| {
            turn.guard_identity.strong_count() > 0
                || now_epoch_ms.saturating_sub(turn.last_seen_ms) <= V3_ROUTE_POLICY_PENDING_TTL_MS
        });
        while pending.len() > V3_ROUTE_POLICY_MAX_PENDING_TURNS {
            let Some(oldest) = pending
                .iter()
                .filter(|(_, turn)| turn.guard_identity.strong_count() == 0)
                .min_by_key(|(_, turn)| turn.last_seen_ms)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            pending.remove(&oldest);
        }
        Ok(())
    }

    fn prune_histories(&self, now_epoch_ms: u64) -> Result<(), String> {
        let mut histories = self
            .histories
            .lock()
            .map_err(|error| format!("route policy history lock poisoned: {error}"))?;
        histories.retain(|_, entry| {
            now_epoch_ms.saturating_sub(entry.last_seen_ms) <= V3_ROUTE_POLICY_HISTORY_TTL_MS
        });
        while histories.len() > V3_ROUTE_POLICY_MAX_HISTORY_SCOPES {
            let Some(oldest) = histories
                .iter()
                .min_by_key(|(_, entry)| entry.last_seen_ms)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            histories.remove(&oldest);
        }
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
    let current = build_v3_current_turn_route_facts_from_value(body);
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
            let (_classified, pending) = state
                .evaluate_request(
                    &manifest,
                    classified(),
                    scope.clone(),
                    &request_id,
                    search.clone(),
                    request as u64,
                )
                .expect("evaluate");
            pending.commit(&policies, request as u64).expect("commit");
            drop(pending);
        }
        let dropped = "dropped";
        let (_classified, pending) = state
            .evaluate_request(
                &manifest,
                classified(),
                scope.clone(),
                dropped,
                V3RouteTurnObservation::default(),
                8,
            )
            .expect("evaluate dropped");
        drop(pending);
        let (classified, pending) = state
            .evaluate_request(&manifest, classified(), scope.clone(), "current", search, 9)
            .expect("evaluate current");
        let action = classified.route_policy_pool;
        assert_eq!(action.as_deref(), Some("thinking"));
        drop(pending);
    }

    #[test]
    fn pending_guard_discards_non_commit_turns() {
        let state = V3RoutePolicyRuntimeState::default();
        let manifest = manifest();
        let scope = scope();
        for request in 0..32 {
            let request_id = format!("failed-{request}");
            let (_classified, pending) = state
                .evaluate_request(
                    &manifest,
                    classified(),
                    scope.clone(),
                    &request_id,
                    V3RouteTurnObservation::default(),
                    request,
                )
                .expect("evaluate");
            drop(pending);
        }
        assert!(state.pending.lock().expect("pending lock").is_empty());
        assert!(state.histories.lock().expect("history lock").is_empty());
    }

    #[test]
    fn stale_guard_does_not_remove_reused_request_id() {
        let state = V3RoutePolicyRuntimeState::default();
        let manifest = manifest();
        let scope = scope();
        let (_, stale_guard) = state
            .evaluate_request(
                &manifest,
                classified(),
                scope.clone(),
                "reused",
                V3RouteTurnObservation::default(),
                1,
            )
            .expect("evaluate stale");
        let (_, current_guard) = state
            .evaluate_request(
                &manifest,
                classified(),
                scope.clone(),
                "reused",
                V3RouteTurnObservation::default(),
                2,
            )
            .expect("evaluate current");
        drop(stale_guard);
        assert_eq!(state.pending.lock().expect("pending lock").len(), 1);
        drop(current_guard);
        assert!(state.pending.lock().expect("pending lock").is_empty());
    }

    #[test]
    fn stale_history_scope_is_evicted_on_next_request() {
        let state = V3RoutePolicyRuntimeState::default();
        let manifest = manifest();
        let stale_scope = scope();
        let policies = compile_route_policies(&manifest, "test").expect("policies");
        let (_, pending) = state
            .evaluate_request(
                &manifest,
                classified(),
                stale_scope.clone(),
                "stale",
                V3RouteTurnObservation::default(),
                1,
            )
            .expect("evaluate stale");
        pending.commit(&policies, 1).expect("commit stale");
        drop(pending);
        assert!(state
            .histories
            .lock()
            .expect("history lock")
            .contains_key(&stale_scope));

        let fresh_scope = V3RoutePolicyScope::without_conversation("test", "test", "fresh", "5555")
            .with_conversation("fresh");
        let (_, pending) = state
            .evaluate_request(
                &manifest,
                classified(),
                fresh_scope.clone(),
                "fresh",
                V3RouteTurnObservation::default(),
                V3_ROUTE_POLICY_HISTORY_TTL_MS + 2,
            )
            .expect("evaluate fresh");
        let histories = state.histories.lock().expect("history lock");
        assert!(!histories.contains_key(&stale_scope));
        assert!(!histories.contains_key(&fresh_scope));
        drop(histories);
        drop(pending);
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
