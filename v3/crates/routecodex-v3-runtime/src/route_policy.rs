use routecodex_v3_config::{
    V3Config05ManifestPublished, V3RouteActionManifest, V3RouteConditionManifest,
    V3RoutePolicyManifest,
};
use routecodex_v3_route_classifier::{
    build_v3_current_turn_route_facts_from_value, evaluate_v3_route_policies, V3RouteCondition,
    V3RoutePolicy, V3RoutePolicyAction, V3RouteTurnObservation,
};
use routecodex_v3_virtual_router::{V3Router05RequestClassified, V3VirtualRouter};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, Weak};

const V3_ROUTE_POLICY_PENDING_TTL_MS: u64 = 60 * 60 * 1000;
const V3_ROUTE_POLICY_MAX_PENDING_TURNS: usize = 4096;

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

    pub(crate) fn commit<E: From<String>>(&self) -> Result<(), E> {
        self.state
            .commit_request_from_guard(&self.scope, &self.request_id, &self.identity)
            .map_err(E::from)
    }
}

#[derive(Debug, Clone, Default)]
pub struct V3RoutePolicyRuntimeState {
    pending: Arc<Mutex<BTreeMap<V3RoutePolicyRequestKey, V3PendingRoutePolicyTurn>>>,
}

impl V3RoutePolicyRuntimeState {
    pub fn process_shared() -> Self {
        use std::sync::OnceLock;
        static SHARED_PENDING: OnceLock<
            Arc<Mutex<BTreeMap<V3RoutePolicyRequestKey, V3PendingRoutePolicyTurn>>>,
        > = OnceLock::new();
        Self {
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

        let action = evaluate_v3_route_policies(&policies, observation.clone())
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
        guard_identity: &Arc<()>,
    ) -> Result<(), String> {
        self.commit_or_discard_request(scope, request_id, guard_identity)
    }

    fn commit_or_discard_request(
        &self,
        scope: &V3RoutePolicyScope,
        request_id: &str,
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
        let _ = (scope, &pending.observation);
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
        is_compaction: current.is_compaction || route_name == "compact",
    }
}

fn compile_route_policy(policy: &V3RoutePolicyManifest) -> Result<V3RoutePolicy, String> {
    let condition = match &policy.condition {
        V3RouteConditionManifest::CurrentCompaction => V3RouteCondition::CurrentCompaction,
    };
    let V3RouteActionManifest { select_route_pool } = &policy.action;
    Ok(V3RoutePolicy {
        id: policy.id.clone(),
        precedence: policy.precedence,
        condition,
        route_pool: select_route_pool.clone(),
    })
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
    fn current_turn_compaction_selects_compact_pool_and_commit_clears_pending() {
        let state = V3RoutePolicyRuntimeState::default();
        let manifest = manifest();
        let scope = scope();
        let (classified, pending) = state
            .evaluate_request(
                &manifest,
                classified(),
                scope,
                "compact-1",
                V3RouteTurnObservation { is_compaction: true },
                1,
            )
            .expect("evaluate");
        assert_eq!(classified.route_policy_pool.as_deref(), Some("compact"));
        pending.commit::<String>().expect("commit");
        drop(pending);
        assert!(state.pending.lock().expect("pending lock").is_empty());
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
    fn compact_observation_selects_compact_pool() {
        let observation = observe_route_turn(&serde_json::json!({}), "compact");
        assert!(observation.is_compaction);
        let policy = V3RoutePolicy {
            id: "compact".into(),
            precedence: 1,
            condition: V3RouteCondition::CurrentCompaction,
            route_pool: "compact".into(),
        };
        let action = evaluate_v3_route_policies(&[policy], observation)
            .expect("compact evaluation")
            .expect("compact action");
        assert_eq!(action.route_pool, "compact");
    }
}
