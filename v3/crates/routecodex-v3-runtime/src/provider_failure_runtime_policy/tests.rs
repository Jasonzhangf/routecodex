use super::*;
use crate::provider_action_gate::V3ProviderActionRecoveryTransition;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_01_source_raised_external,
    V3Error05ExecutionAction, V3ErrorSourceKind, V3ExternalErrorKind, V3ExternalErrorLink,
    V3ProviderHealthScope,
};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;

#[test]
fn late_compact_preserves_newer_conversation_turn_limit_rejections() {
    let manifest =
        global_pool_alive_manifest_with_rescue_timeout("conversation-turn-limit", Some(5_000));
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let control = crate::execution_control::V3RequestExecutionControl::from_manifest(
        &manifest,
        "conversation-turn-limit",
    )
    .unwrap();
    let scope = V3ProviderFailureSessionScope::new("listener", "default", "conversation").unwrap();
    let other = V3ProviderFailureSessionScope::new("listener", "default", "another").unwrap();
    let receipt = crate::nodes::V3AttemptSuccessReceipt::from_buffered_terminal_attempt();
    health.record_session_turn_limit(&scope, "old");
    health.record_session_turn_limit(&scope, "new");
    health.record_session_turn_limit(&other, "old");
    let generation = control
        .retain_compaction_generation(health.compaction_turn_limit_generation(&scope))
        .unwrap();
    health.record_session_turn_limit(&scope, "new");
    let handoff_generation = control
        .clone()
        .retain_compaction_generation(health.compaction_turn_limit_generation(&scope))
        .unwrap();
    assert_eq!(handoff_generation, generation);
    health.clear_turn_limits_after_compaction(&scope, handoff_generation, &receipt);
    assert!(!health.provider_blocked_until_compact(&scope, "old"));
    assert!(health.provider_blocked_until_compact(&scope, "new"));
    assert!(health.provider_blocked_until_compact(&other, "old"));
}

// Test the post-observation policy separately from the public hold tests.
// Await the real declared action gate, then finish a qualified physical
// observation. No sleep, forced due time or synthetic cooldown is used.
pub(crate) async fn complete_due_precool_failures(
    health: &V3ProviderFailureRuntimeHealth,
    now_ms: u64,
) {
    let tickets: Vec<_> = health
        .precool
        .lock()
        .unwrap()
        .iter()
        .map(|(identity, action)| (identity.clone(), action.ticket.clone()))
        .collect();
    for (identity, ticket) in tickets {
        let transition = tokio::time::timeout(
            Duration::from_secs(15),
            health
                .action_gate
                .wait_for_recovery_ticket(&ticket, ticket.key().provider_scope.clone()),
        )
        .await
        .expect("declared observation gate must become due")
        .unwrap();
        let V3ProviderActionRecoveryTransition::Admitted(mut admission) = transition else {
            panic!("isolated test observation must retain its current action: {transition:?}");
        };
        let permit = health
            .store
            .acquire_provider_precool_probe_for_interface(
                &identity.provider_id,
                &identity.interface_id,
                identity.auth_alias.as_deref(),
                identity.model_id.as_deref(),
            )
            .unwrap()
            .expect("test observation must own the exact physical probe");
        let observation = V3PrecoolObservationGuard {
            health: health.clone(),
            identity: identity.clone(),
            generation: ticket.generation(),
            _admission: admission.take_permit().expect("current action admission"),
        };
        let cancellation = V3ProviderProbeCancellationGuard {
            store: health.store.clone(),
            permit,
        };
        health
            .complete_precool_observation(
                &observation,
                &cancellation,
                Err(V3ProviderHealthProbeFailure::Provider(
                    V3ProviderError::Transport {
                        request_id: "controlled-negative-observation".into(),
                        provider_id: identity.provider_id.clone(),
                        reason: "controlled failed observation after declared hold".into(),
                    },
                )),
                now_ms,
            )
            .unwrap();
    }
}

#[path = "tests/terminal_projection.rs"]
mod terminal_projection;
include!("provider_action_gate_tests.rs");

#[path = "classified_global_tests.rs"]
mod classified_global;

#[path = "tests/no_first_failure.rs"]
mod no_first_failure;

#[path = "tests/cooldown_exhaustion.rs"]
mod cooldown_exhaustion;

#[path = "tests/provider_compat.rs"]
mod provider_compat;

#[path = "auth_key_policy_tests.rs"]
mod auth_key_policy;

#[path = "matched_policy_fingerprint_tests.rs"]
mod matched_policy_fingerprint;

#[path = "tests/probe_recovery.rs"]
mod probe_recovery;

#[path = "tests/responses_probe_terminal.rs"]
mod responses_probe_terminal;

#[path = "tests/relay_error_operator_fault.rs"]
mod relay_error_operator_fault;

// 归一化优先级基线：隔离自适应分数阻断，让用例专测阈值语义。
#[test]
fn late_failure_of_already_cooled_identity_does_not_shadow_recovery_owner() {
    let manifest = target_resolution_manifest("late-cooled-observation");
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope = test_provider_failure_scope(
        "late-cooled-observation",
        "late-cooled-observation",
        "late-inflight",
    )
    .unwrap();
    health
        .store
        .record_provider_cooldown_failure(
            "primary",
            Some("key1"),
            Some("gpt-test"),
            "first qualified observation committed cooldown",
            100,
            5000,
        )
        .unwrap();
    let record = health
        .record_provider_failure_record_with_policy(
            None,
            &manifest,
            &scope,
            "primary",
            Some("responses"),
            Some("key1"),
            Some("gpt-test"),
            Some("late in-flight transport failure"),
            "V3ProviderResp14Raw",
            502,
            Some("provider_transport_error"),
            "late in-flight transport failure",
            101,
        )
        .unwrap();
    assert!(health.precool_probe_keys().unwrap().is_empty(),
        "an already-cooled identity must stay with its cooldown recovery owner, not a new unacquirable precool lane");
    assert_eq!(record.state, "cooldown");
    let permit = health
        .store
        .acquire_provider_cooldown_probe("primary", Some("key1"), Some("gpt-test"))
        .unwrap()
        .unwrap();
    health
        .store
        .complete_provider_cooldown_probe_success_with_permit(&permit, 6000)
        .unwrap();
    assert!(
        health
            .session_bound_availability(&scope)
            .availability_for_interface("primary", "default", Some("key1"), Some("gpt-test"), 6001)
            .available,
        "qualified recovery must not remain hidden behind a late precool entry"
    );
}

fn normalize_global_pool_priorities(manifest: &mut V3Config05ManifestPublished) {
    for target in manifest
        .route_groups
        .values_mut()
        .flat_map(|group| group.pools.values_mut())
        .flat_map(|pool| pool.targets.iter_mut())
    {
        target.priority = Some(100);
    }
}

fn test_provider_failure_scope(
    server_id: &str,
    routing_group: &str,
    session_id: &str,
) -> Result<V3ProviderFailureSessionScope, String> {
    V3ProviderFailureSessionScope::new(server_id, routing_group, session_id)
}

fn target_resolution_manifest(scope: &str) -> V3Config05ManifestPublished {
    let source = r#"
version = 3
[servers.__SCOPE__]
bind = "127.0.0.1"
port = 5555
routing_group = "__SCOPE__"
endpoints = ["responses"]
[providers.primary]
type = "responses"
base_url = "http://primary.invalid/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "PRIMARY_KEY" }] }
[providers.primary.models.gpt-test]
wire_name = "gpt-test"
supports_streaming = true
supports_thinking = true
capabilities = ["text", "tools", "reasoning"]
[route_groups.__SCOPE__.pools.client_responses]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", models = ["client-responses"] }
targets = [
  { kind = "provider_model", provider = "primary", model = "gpt-test", key = "key1", priority = 1 }
]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "primary", model = "gpt-test", key = "key1", priority = 1 }
]
"#
    .replace("__SCOPE__", scope);
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source).expect("target-resolution authoring"),
    )
    .expect("target-resolution manifest")
}

#[tokio::test]
async fn legacy_failure_never_prefers_an_unwitnessed_active_successor() {
    use routecodex_v3_config::{
        V3ActiveKeyFailureAction, V3ActiveKeyMember, V3ActiveKeyPolicy, V3SelectionStrategy,
    };
    let mut manifest = global_pool_alive_manifest("mixed-occurrence-recovery");
    let pools = &mut manifest
        .route_groups
        .get_mut("mixed-occurrence-recovery")
        .unwrap()
        .pools;
    pools
        .get_mut("client_responses")
        .unwrap()
        .targets
        .retain(|target| target.provider.as_deref() == Some("second"));
    let default = pools.get_mut("default").unwrap();
    default
        .targets
        .retain(|target| target.provider.as_deref() == Some("first"));
    default.selection.strategy = V3SelectionStrategy::ActiveQueue;
    default.active_keys = Some(V3ActiveKeyPolicy {
        members: vec![V3ActiveKeyMember {
            provider: "first".into(),
            alias: "key1".into(),
        }],
        retries: 3,
        on_failure: V3ActiveKeyFailureAction::Hold,
    });
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let target = V3TargetInterpreter::default();
    let mut hit = resolve_v3_relay_opaque_target_once(
        &manifest,
        "mixed-occurrence-recovery",
        "responses",
        "/v1/responses",
        &json!({"model":"client-responses","input":"hello"}),
        0,
    )
    .unwrap();
    // Keep the captured primary-to-default plan explicit: model-name routing
    // is covered by the public fixture; this regression owns Error recovery.
    let mut primary = hit.target_plan[0].clone();
    primary.pool_id = "client_responses".into();
    primary.tier_index = 0;
    hit.target_plan[0].tier_index = 1;
    hit.target_plan.insert(0, primary);
    hit.pool_id = "client_responses".into();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    let keys = routecodex_v3_target::V3ActiveKeySelectionState::default();
    let excluded = BTreeSet::new();
    let active = V3ActiveKeySelectionContext {
        listener_id: "mixed-occurrence-recovery",
        session_id: Some("session"),
        state: &keys,
        excluded: &excluded,
    };
    let scope = test_provider_failure_scope(
        "mixed-occurrence-recovery",
        "mixed-occurrence-recovery",
        "session",
    )
    .unwrap();
    let selected = select_v3_target_with_session_then_global(
        &target,
        expanded.clone(),
        &scope,
        &health.session_bound_availability(&scope),
        &health,
        &BTreeSet::new(),
        1,
        0,
        Some(&active),
    )
    .unwrap();
    assert!(
        selected.active_selection.is_none(),
        "selected={selected:?}; expanded={expanded:?}"
    );
    let observed = observe_v3_target_successors(
        &expanded,
        &health.session_bound_availability(&scope),
        &health,
        &BTreeSet::from([v3_relay_provider_candidate_key(&selected.candidate)]),
        &scope,
        Some(&keys),
        v3_relay_provider_policy_now_epoch_ms().unwrap(),
    );
    assert!(
        !observed.is_empty(),
        "active successor observation: expanded={expanded:?}"
    );
    let context = V3RelayProviderFailurePolicyContext {
        recovery_control: None,
        manifest: &manifest,
        captured_target_09: Some(&expanded),
        failure_session_scope: test_provider_failure_scope(
            "mixed-occurrence-recovery",
            "mixed-occurrence-recovery",
            "session",
        )
        .unwrap(),
        provider_health: &health,
        retry_policy: V3RelayProviderFailureRetryPolicy::default(),
        deterministic_sample: 0,
    };
    let mut failed = BTreeSet::new();
    let mut retries = BTreeMap::new();
    let mut trace = Vec::new();
    let mut witness = None;
    let mut state = V3RelayProviderFailurePolicyState {
        failed_candidates: &mut failed,
        same_candidate_retries: &mut retries,
        trace: &mut trace,
        last_external_http: &mut witness,
    };
    let result = run_v3_relay_provider_failure_policy_with_response_source_and_active_keys(
        &context,
        selected.clone(),
        "V3ProviderReqOutbound09TransportRequest",
        429,
        Some("provider_http_429".into()),
        "controlled failure".into(),
        None,
        &mut state,
        None,
        None,
        Some(429),
        None,
        Some(&keys),
    )
    .await
    .unwrap();
    assert_eq!(
        result.decision.action,
        V3Error05ExecutionAction::Reselect,
        "the eligible active default must remain a recovery successor: {:?}",
        result.event
    );
    assert!(
        result
            .retry_selected
            .as_ref()
            .is_none_or(|next| next.active_selection.is_some()),
        "an observed active successor must return through Target choice before preferred dispatch"
    );
    let excluded = expanded
        .candidates
        .iter()
        .filter(|candidate| {
            state
                .failed_candidates
                .contains(&v3_relay_provider_candidate_key(candidate))
        })
        .map(V3TargetCandidate::active_key_identity)
        .collect();
    let active = V3ActiveKeySelectionContext {
        listener_id: scope.server_id(),
        session_id: Some("session"),
        state: &keys,
        excluded: &excluded,
    };
    let successor = select_v3_target_with_session_then_global(
        &target,
        expanded.clone(),
        &scope,
        &health.session_bound_availability(&scope),
        &health,
        state.failed_candidates,
        1,
        0,
        Some(&active),
    )
    .unwrap();
    assert_eq!(successor.occurrence.pool_id, "default");
    assert!(
        selection_invalidation(&successor, &expanded, Some(&keys), &health, &scope, 1).is_none()
    );
    let mut untagged = successor.clone();
    untagged.active_selection = None;
    assert!(
        selection_invalidation(&untagged, &expanded, Some(&keys), &health, &scope, 1).is_some(),
        "None must not bypass an active occurrence's dispatch guard"
    );
    let mut episode =
        routecodex_v3_target::V3ActiveKeyEpisode::new(successor.active_selection.unwrap());
    for _ in 0..4 {
        episode.begin_attempt().unwrap();
        keys.record_delivery_failure(&mut episode).unwrap();
    }
    let observed = observe_v3_target_successors(
        &expanded,
        &health.session_bound_availability(&scope),
        &health,
        state.failed_candidates,
        &scope,
        Some(&keys),
        1,
    );
    assert!(
        observed.is_empty(),
        "held-only default cannot count as a health successor"
    );
    let mut failed = BTreeSet::new();
    let mut retries = BTreeMap::new();
    let mut trace = Vec::new();
    let mut witness = None;
    let mut held_state = V3RelayProviderFailurePolicyState {
        failed_candidates: &mut failed,
        same_candidate_retries: &mut retries,
        trace: &mut trace,
        last_external_http: &mut witness,
    };
    let held = run_v3_relay_provider_failure_policy_with_response_source_and_active_keys(
        &context,
        selected,
        "V3ProviderReqOutbound09TransportRequest",
        429,
        Some("provider_http_429".into()),
        "controlled final failure".into(),
        None,
        &mut held_state,
        None,
        None,
        Some(429),
        None,
        Some(&keys),
    )
    .await
    .unwrap();
    assert_eq!(held.event.health_record.state, "last_candidate_terminal");
    assert_eq!(held.event.health_record.failure_count, 0);
}

#[test]
fn active_dispatch_observes_health_changes_after_selection_without_spending_a_send() {
    use routecodex_v3_config::{
        V3ActiveKeyFailureAction, V3ActiveKeyMember, V3ActiveKeyPolicy, V3SelectionStrategy,
    };
    use routecodex_v3_target::{V3ActiveKeyEpisode, V3ActiveKeyScope, V3ActiveKeySelectionState};
    let manifest = target_resolution_manifest("active-dispatch-health");
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let V3RelayProviderTargetResolution::Selected(selected) = resolve_target(
        &manifest,
        "active-dispatch-health",
        &BTreeSet::new(),
        &health,
    ) else {
        panic!("healthy target");
    };
    let candidate = &selected.candidate;
    let scope = V3ActiveKeyScope {
        listener_id: "active-dispatch-health".into(),
        routing_group_id: "active-dispatch-health".into(),
        pool_id: "default".into(),
    };
    let keys = V3ActiveKeySelectionState::default();
    let identity = candidate.active_key_identity();
    keys.configure(
        scope.clone(),
        V3ActiveKeyPolicy {
            members: vec![V3ActiveKeyMember {
                provider: identity.provider_id.clone(),
                alias: identity.auth_alias.clone(),
            }],
            retries: 3,
            on_failure: V3ActiveKeyFailureAction::Hold,
        },
        V3SelectionStrategy::ActiveQueue,
        std::slice::from_ref(&identity),
    )
    .unwrap();
    let selection = keys
        .choose(
            &scope,
            &BTreeSet::from([identity]),
            &BTreeSet::new(),
            Some("session"),
        )
        .unwrap()
        .unwrap();
    let session = test_provider_failure_scope(
        "active-dispatch-health",
        "active-dispatch-health",
        "session",
    )
    .unwrap();
    assert!(
        active_selection_invalidation(&selection, candidate, &keys, &health, &session, 1).is_none()
    );
    health
        .store()
        .record_provider_cooldown_failure(
            &candidate.provider_id,
            Some(&candidate.auth_alias),
            Some(&candidate.model_id),
            "health changed after planning",
            2,
            5000,
        )
        .unwrap();
    let mut episode = V3ActiveKeyEpisode::new(selection);
    if active_selection_invalidation(&episode.selection, candidate, &keys, &health, &session, 3)
        .is_none()
    {
        episode.begin_attempt();
    }
    assert!(
        !keys.accepted_success(&mut episode).unwrap(),
        "a newly unavailable identity must not spend an actual send or accept success"
    );
}

#[test]
fn hold_during_recovery_acquisition_releases_trial_without_consuming_a_dispatch() {
    use routecodex_v3_config::{
        V3ActiveKeyFailureAction, V3ActiveKeyMember, V3ActiveKeyPolicy, V3SelectionStrategy,
    };
    use routecodex_v3_target::{V3ActiveKeyEpisode, V3ActiveKeyScope, V3ActiveKeySelectionState};
    let manifest =
        global_pool_alive_manifest_with_rescue_timeout("post-acquire-selection", Some(60_000));
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let V3RelayProviderTargetResolution::Selected(mut selected) = resolve_target(
        &manifest,
        "post-acquire-selection",
        &BTreeSet::new(),
        &health,
    ) else {
        panic!("healthy target")
    };
    let identity = selected.candidate.active_key_identity();
    let scope = V3ActiveKeyScope {
        listener_id: "post-acquire-selection".into(),
        routing_group_id: "post-acquire-selection".into(),
        pool_id: "default".into(),
    };
    let keys = V3ActiveKeySelectionState::default();
    keys.configure(
        scope.clone(),
        V3ActiveKeyPolicy {
            members: vec![V3ActiveKeyMember {
                provider: identity.provider_id.clone(),
                alias: identity.auth_alias.clone(),
            }],
            retries: 3,
            on_failure: V3ActiveKeyFailureAction::Hold,
        },
        V3SelectionStrategy::ActiveQueue,
        std::slice::from_ref(&identity),
    )
    .unwrap();
    let selection = keys
        .choose(
            &scope,
            &BTreeSet::from([identity.clone()]),
            &BTreeSet::new(),
            None,
        )
        .unwrap()
        .unwrap();
    selected.active_selection = Some(selection.clone());
    let mut unsent = V3ActiveKeyEpisode::new(selection.clone());
    let control = crate::execution_control::V3RequestExecutionControl::from_manifest(
        &manifest,
        "post-acquire-selection",
    )
    .unwrap();
    health
        .store()
        .add_cooldown_entry_for_interface(
            routecodex_v3_provider_responses::V3ProviderIdentityRef::new(
                &identity.provider_id,
                Some(&identity.auth_alias),
                Some(&identity.model_id),
            ),
            &identity.interface_id,
            "probe",
            1000,
            1000,
        )
        .unwrap();
    assert!(control
        .acquire_business_recovery_trial(
            &health.store(),
            &identity.provider_id,
            &identity.interface_id,
            &identity.auth_alias,
            &identity.model_id,
            2000
        )
        .unwrap());
    for _ in 0..4 {
        let mut sibling = V3ActiveKeyEpisode::new(selection.clone());
        sibling.begin_attempt().unwrap();
        keys.record_delivery_failure(&mut sibling).unwrap();
    }
    assert!(
        !begin_v3_active_dispatch(&selected, Some(&keys), Some(&mut unsent), &control, 2000)
            .unwrap(),
        "hold after acquisition must reject the unsent generation"
    );
    assert!(!keys.accepted_success(&mut unsent).unwrap());
    let other = crate::execution_control::V3RequestExecutionControl::from_manifest(
        &manifest,
        "post-acquire-selection",
    )
    .unwrap();
    assert!(
        other
            .acquire_business_recovery_trial(
                &health.store(),
                &identity.provider_id,
                &identity.interface_id,
                &identity.auth_alias,
                &identity.model_id,
                2000
            )
            .unwrap(),
        "no-send rejection must release its trial without deferring cadence"
    );
}

fn codec_failure_manifest(scope: &str) -> V3Config05ManifestPublished {
    let source = r#"
version = 3
[servers.__SCOPE__]
bind = "127.0.0.1"
port = 5555
routing_group = "__SCOPE__"
endpoints = ["responses"]
[providers.primary]
type = "responses"
base_url = "http://primary.invalid/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "PRIMARY_KEY" }] }
[providers.primary.models.gpt-test]
wire_name = "gpt-test"
supports_streaming = true
supports_thinking = true
capabilities = ["text", "tools", "reasoning"]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "primary", model = "gpt-test", key = "key1", priority = 1 }
]
[error]
provider_error_default_path = [
  { step = "wait_retry", retry_mode = "retry_same", max_attempts = 3, backoff_ms = 0 },
  { step = "cooldown", scope = "provider_model", duration_ms = 900000, provider_global_failure = false },
  { step = "project", reason_code = "provider_failure" },
]
[[error.provider_error_action_policy]]
policy_id = "provider_response_event_codec_failure_reselect"
match = { provider_code = "provider_response_event_codec_failure" }
path = [
  { step = "wait_retry", retry_mode = "reselect_before_client_projection", max_attempts = 2, backoff_ms = 1000 },
  { step = "project", reason_code = "provider_response_event_codec_failure" },
]
"#
    .replace("__SCOPE__", scope);
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source).expect("codec-failure authoring"),
    )
    .expect("codec-failure manifest")
}

#[tokio::test]
async fn cancelled_scheduled_probe_releases_single_flight_permit() {
    let manifest = global_pool_alive_manifest("cancelled_scheduled_probe");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    health
        .store
        .record_provider_cooldown_failure(
            "first",
            Some("key1"),
            Some("gpt-test"),
            "pending provider probe",
            0,
            1,
        )
        .expect("provider cooldown setup");
    let started = Arc::new(Notify::new());
    let running = {
        let health = health.clone();
        let started = started.clone();
        tokio::spawn(async move {
            health
                .run_due_provider_health_probes(u64::MAX, false, move |_, _, _, _| {
                    let started = started.clone();
                    async move {
                        started.notify_one();
                        futures_util::future::pending::<Result<(), V3ProviderHealthProbeFailure>>()
                            .await
                    }
                })
                .await
        })
    };
    started.notified().await;
    running.abort();
    let _ = running.await;

    assert!(
        health
            .store
            .acquire_provider_cooldown_probe("first", Some("key1"), Some("gpt-test"))
            .expect("probe permit acquisition after cancellation")
            .is_some(),
        "dropping the scheduled probe must release its single-flight permit"
    );
}

fn global_pool_alive_manifest(scope: &str) -> V3Config05ManifestPublished {
    global_pool_alive_manifest_with_rescue_timeout(scope, None)
}

fn global_pool_alive_manifest_with_rescue_timeout(
    scope: &str,
    residence_timeout_ms: Option<u64>,
) -> V3Config05ManifestPublished {
    global_pool_alive_manifest_with_provider_names(scope, residence_timeout_ms, "first", "second")
}

fn global_pool_alive_manifest_with_provider_names(
    scope: &str,
    residence_timeout_ms: Option<u64>,
    first_provider: &str,
    second_provider: &str,
) -> V3Config05ManifestPublished {
    let execution = match residence_timeout_ms {
        Some(residence_timeout_ms) => format!(
            r#"
[servers.__SCOPE__.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]
[servers.__SCOPE__.execution.attempt_store]
residence_timeout_ms = {residence_timeout_ms}
"#
        ),
        None => String::new(),
    };
    let source = r#"
version = 3
[servers.__SCOPE__]
bind = "127.0.0.1"
port = 5555
routing_group = "__SCOPE__"
endpoints = ["responses"]
__EXECUTION__
[providers.__FIRST_PROVIDER__]
type = "responses"
base_url = "http://first.invalid/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "FIRST_KEY" }] }
[providers.__FIRST_PROVIDER__.models.gpt-test]
wire_name = "gpt-test"
capabilities = ["text", "tools", "reasoning"]
[providers.__SECOND_PROVIDER__]
type = "responses"
base_url = "http://second.invalid/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "SECOND_KEY" }] }
[providers.__SECOND_PROVIDER__.models.gpt-test]
wire_name = "gpt-test"
capabilities = ["text", "tools", "reasoning"]
[route_groups.__SCOPE__.pools.client_responses]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", models = ["client-responses"] }
targets = [
  { kind = "provider_model", provider = "__FIRST_PROVIDER__", model = "gpt-test", key = "key1", priority = 1 },
  { kind = "provider_model", provider = "__SECOND_PROVIDER__", model = "gpt-test", key = "key1", priority = 2 }
]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "__FIRST_PROVIDER__", model = "gpt-test", key = "key1", priority = 1 },
  { kind = "provider_model", provider = "__SECOND_PROVIDER__", model = "gpt-test", key = "key1", priority = 2 }
]
"#
    .replace("__EXECUTION__", &execution)
    .replace("__SCOPE__", scope)
    .replace("__FIRST_PROVIDER__", first_provider)
    .replace("__SECOND_PROVIDER__", second_provider);
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source).expect("global-pool-alive authoring"),
    )
    .expect("global-pool-alive manifest")
}

fn resolve_target(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    excluded: &BTreeSet<String>,
    health: &V3ProviderFailureRuntimeHealth,
) -> V3RelayProviderTargetResolution {
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "target-resolution-session")
            .expect("target resolution session scope");
    resolve_target_for_scope(
        manifest,
        server_id,
        excluded,
        health,
        &failure_session_scope,
        1,
    )
}

fn resolve_target_for_scope(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    excluded: &BTreeSet<String>,
    health: &V3ProviderFailureRuntimeHealth,
    failure_session_scope: &V3ProviderFailureSessionScope,
    now_ms: u64,
) -> V3RelayProviderTargetResolution {
    resolve_v3_relay_target_outcome(V3RelayProviderTargetResolutionInput {
        manifest,
        server_id,
        failure_session_scope,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &json!({"model":"client-responses","input":"hello"}),
        request_local_excluded_candidates: excluded,
        provider_health: health,
        now_ms,
        deterministic_sample: 0,
    })
}

#[test]
fn recovered_primary_failback_is_not_starved_by_backup_successes() {
    let manifest = global_pool_alive_manifest("failback_liveness");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure = V3ProviderFailureAction::recoverable("transport");

    let selected = resolve_target(&manifest, "failback_liveness", &BTreeSet::new(), &health);
    let V3RelayProviderTargetResolution::Selected(selected) = selected else {
        panic!("healthy primary must be selected");
    };
    assert_eq!(selected.candidate.provider_id, "second");

    for now_ms in 101..111 {
        health
            .store
            .record_provider_failure_action("second", "key1", "gpt-test", &failure, now_ms)
            .expect("primary failure");
    }
    let selected = resolve_target(&manifest, "failback_liveness", &BTreeSet::new(), &health);
    let V3RelayProviderTargetResolution::Selected(selected) = selected else {
        panic!("backup must be selected while primary is blocked");
    };
    assert_eq!(selected.candidate.provider_id, "first");

    for now_ms in 105..155 {
        health
            .store
            .record_provider_key_success("first", "key1", "gpt-test", now_ms)
            .expect("stable backup success");
    }
    let permit = health
        .store
        .acquire_provider_cooldown_probe("second", Some("key1"), Some("gpt-test"))
        .expect("probe permit acquisition")
        .expect("blocked primary probe permit");
    health
        .store
        .complete_provider_cooldown_probe_success_with_permit(&permit, 3_600_111)
        .expect("semantic probe recovery");

    let selected = resolve_target_for_scope(
        &manifest,
        "failback_liveness",
        &BTreeSet::new(),
        &health,
        &test_provider_failure_scope(
            "failback_liveness",
            "failback_liveness",
            "target-resolution-session",
        )
        .expect("target resolution session scope"),
        3_600_112,
    );
    let V3RelayProviderTargetResolution::Selected(selected) = selected else {
        panic!("recovered primary must be selected");
    };
    assert_eq!(selected.candidate.provider_id, "second");
}

#[tokio::test]
async fn runtime_policy_maps_account_and_recoverable_http_classes_to_global_health() {
    let mut manifest = global_pool_alive_manifest("global_status_policy");
    normalize_global_pool_priorities(&mut manifest);
    // A confirmed authentication failure cools immediately. HTTP 403 uses
    // its consecutive threshold even when the body reports a permission error.
    let cases = [
        (401, "invalid_api_key", 5),
        (403, "permission_error", 5),
        (429, "provider_http_error", 10),
        (500, "provider_http_error", 10),
        (502, "provider_http_error", 10),
        (599, "provider_http_error", 10),
    ];
    for (status, code, threshold) in cases {
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        let scope = test_provider_failure_scope(
            "global_status_policy",
            "global_status_policy",
            "runtime-policy-status",
        )
        .expect("failure session scope");
        for attempt in 1..=threshold {
            let now_ms = 10_000 + attempt as u64;
            let source = build_v3_error_01_source_raised_external(
                V3ErrorSourceKind::ProviderFailure,
                "V3ProviderRespInbound01Raw",
                code,
                "upstream status",
                V3ExternalErrorLink {
                    kind: V3ExternalErrorKind::Provider,
                    status: Some(status),
                    code: Some(code.to_string()),
                    provider_id: Some("first".to_string()),
                    upstream_request_id: None,
                    message: Some("upstream status".to_string()),
                },
            );
            let record = health
                .record_provider_failure_record_from_source(
                    &scope,
                    "first",
                    Some("key1"),
                    Some("gpt-test"),
                    &source,
                    now_ms,
                )
                .expect("real typed provider failure must record");
            assert_eq!(record.failure_count, attempt as u32);
            assert_eq!(
                record.state,
                if threshold == 1 || attempt == threshold {
                    "cooldown"
                } else {
                    "provider_failure_observed"
                }
            );
            assert_eq!(
                record.cooldown_until_ms.is_some(),
                threshold == 1 || attempt == threshold,
                "status {status} must use its declared threshold"
            );
        }
        assert_eq!(
            health
                .store()
                .availability_for_session(&scope, "first", Some("key1"), Some("gpt-test"), 10_010)
                .available,
            false,
            "status {status} must leave the exact identity unavailable at threshold"
        );
        assert!(
            health
                .store()
                .availability_for_session(&scope, "second", Some("key1"), Some("gpt-test"), 10_010)
                .available,
            "status {status} cooldown must remain exact to the failed identity"
        );
    }

    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let scope = test_provider_failure_scope(
        "global_status_policy",
        "global_status_policy",
        "runtime-policy-negative",
    )
    .expect("failure session scope");
    // Generic provider rejection counts once and remains below the threshold.
    for attempt in 0..2 {
        let now_ms = 20_000 + attempt as u64;
        let record = health
            .record_provider_failure_record_with_policy(
                None,
                &manifest,
                &scope,
                "first",
                Some("responses"),
                Some("key1"),
                Some("gpt-test"),
                Some("request-shaped failure"),
                "V3ProviderReqOutbound09TransportRequest",
                400,
                Some("provider_http_error"),
                "request rejected",
                now_ms,
            )
            .expect("ordinary provider policy failure must remain distinct from a Source01 fault");
        assert_eq!(
            record.failure_count,
            attempt + 1,
            "generic rejection counts once; attempt={attempt}"
        );
        assert_eq!(record.state, "provider_failure_observed");
        let available = health
            .store()
            .availability_for_session(&scope, "first", Some("key1"), Some("gpt-test"), now_ms)
            .available;
        assert!(
            available,
            "generic rejection must stay available before its observation; attempt={attempt}"
        );
    }
    assert!(
        health
            .store()
            .availability_for_session(&scope, "first", Some("key1"), Some("gpt-test"), 20_010)
            .available,
        "one generic 400 observation must remain below the recoverable threshold"
    );
}

#[test]
fn target_resolution_does_not_expose_default_floor_error_while_global_pool_is_alive() {
    let scope = "global_pool_alive";
    let manifest = global_pool_alive_manifest(scope);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let session = test_provider_failure_scope(scope, scope, "session-all-cooldown")
        .expect("failure session scope");
    let now = 2_000_000;
    for provider_id in ["first", "second"] {
        health
            .store
            .record_provider_cooldown_failure(
                provider_id,
                Some("key1"),
                Some("gpt-test"),
                "seed exact global cooldown for target selection",
                now,
                now + 60 * 60_000,
            )
            .expect("target selection must use the real global cooldown owner");
    }

    let resolution = resolve_target_for_scope(
        &manifest,
        scope,
        &BTreeSet::new(),
        &health,
        &session,
        now + 10,
    );
    let V3RelayProviderTargetResolution::Selected(selected) = resolution else {
        panic!(
            "cooled multi-candidate pool must fall back to an untried candidate before exhausting"
        );
    };
    assert!(
        ["first", "second"].contains(&selected.candidate.provider_id.as_str()),
        "unexpected fallback candidate: {}",
        selected.candidate.provider_id
    );
}

#[test]
fn session_transient_bypass_is_not_labeled_as_global_probe_pending() {
    let scope = "session_transient_bypass";
    let manifest = global_pool_alive_manifest(scope);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let session =
        test_provider_failure_scope(scope, scope, "session-only").expect("failure session scope");
    health
        .store()
        .record_provider_transient_bypass_in_session(
            &session,
            "first",
            Some("key1"),
            Some("gpt-test"),
            Some("transient session bypass"),
            2_000_000,
        )
        .expect("session transient bypass should be recorded");

    let session_availability = health.session_bound_availability(&session);
    let reader = V3SessionGlobalSchedulingReader {
        session: &session_availability,
        global: &health,
        excluded: &BTreeSet::new(),
    };
    let scheduling = V3ProviderSchedulingReader::scheduling_projection(
        &reader, "first", "key1", "gpt-test", 1, 1, 2_000_001,
    );
    assert!(!scheduling.available);
    assert!(!scheduling
        .blocked_scopes
        .iter()
        .any(|scope| scope == "provider_cooldown_probe_pending"));
    let projection = health.store().availability_for_session(
        &session,
        "first",
        Some("key1"),
        Some("gpt-test"),
        2_000_001,
    );
    assert!(!projection.available);
    assert!(projection
        .blocked_scopes
        .iter()
        .any(|scope| scope.starts_with("provider_failure_session:")));
}

#[test]
fn exhaustion_rescue_identity_is_model_scoped() {
    let mut identities = BTreeSet::new();
    assert!(identities.insert(("opencode-go-zen", "key1", "mimo-v2.5-free",)));
    assert!(identities.insert(("opencode-go-zen", "key1", "hy3-free")));
    assert!(!identities.insert(("opencode-go-zen", "key1", "mimo-v2.5-free",)));
}

fn assert_resolution_failure(
    resolution: V3RelayProviderTargetResolution,
    expected_stage: &str,
    expected_code: &str,
) {
    let V3RelayProviderTargetResolution::Failed(source) = resolution else {
        panic!("expected independent target-resolution source failure");
    };
    assert_eq!(source.source_kind, V3ErrorSourceKind::RuntimeFailure);
    assert_eq!(source.source_stage, expected_stage);
    assert_eq!(source.code, expected_code);
}

#[test]
fn classifier_failure_preserves_its_own_error01_stage_and_code() {
    let manifest = target_resolution_manifest("resolution_classifier");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);

    assert_resolution_failure(
        resolve_target(&manifest, "missing-server", &BTreeSet::new(), &health),
        "V3Router05RequestClassified",
        "target_resolution_classification_failed",
    );
}

#[test]
fn route_plan_failure_preserves_its_own_error01_stage_and_code() {
    let mut manifest = target_resolution_manifest("resolution_plan");
    manifest
        .route_groups
        .get_mut("resolution_plan")
        .expect("route group")
        .pools
        .remove("default");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);

    assert_resolution_failure(
        resolve_target(&manifest, "resolution_plan", &BTreeSet::new(), &health),
        "V3Router06RoutePoolResolved",
        "target_resolution_route_plan_failed",
    );
}

#[test]
fn candidate_expansion_failure_preserves_its_own_error01_stage_and_code() {
    let mut manifest = target_resolution_manifest("resolution_expand");
    manifest.providers.remove("primary");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);

    assert_resolution_failure(
        resolve_target(&manifest, "resolution_expand", &BTreeSet::new(), &health),
        "V3Target09CandidateSetExpanded",
        "target_resolution_candidate_expansion_failed",
    );
}

#[test]
fn unavailable_candidate_is_exhaustion_not_runtime_failure() {
    let manifest = target_resolution_manifest("resolution_exhausted");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let mut excluded = BTreeSet::new();
    excluded.insert(v3_relay_provider_candidate_key_parts(
        "primary",
        None,
        Some("key1"),
        Some("gpt-test"),
    ));

    let V3RelayProviderTargetResolution::Exhausted {
        attempted_candidates,
    } = resolve_target(&manifest, "resolution_exhausted", &excluded, &health)
    else {
        panic!("unavailable selected candidates must produce typed exhaustion");
    };
    assert!(!attempted_candidates.is_empty());
}

#[test]
fn post_commit_response_stream_failure_updates_global_key_health_after_ten() {
    let manifest = target_resolution_manifest("post_commit_sse_counted");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let session = test_provider_failure_scope(
        "post_commit_sse_counted",
        "post_commit_sse_counted",
        "counted-session",
    )
    .expect("counted session scope");
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderRespInbound01Raw",
        "provider_response_sse_stream",
        "Responses SSE event must be a JSON object",
    );

    for _ in 0..10 {
        health
            .record_post_commit_provider_stream_failure_from_source(
                &session,
                "primary",
                Some("key1"),
                Some("gpt-test"),
                &source,
            )
            .expect("post-commit response stream failure must update key health");
    }

    let projection =
        routecodex_v3_provider_responses::V3ProviderSchedulingReader::scheduling_projection(
            &health,
            "primary",
            "key1",
            "gpt-test",
            1,
            1,
            v3_relay_provider_policy_now_epoch_ms().expect("current epoch"),
        );
    assert_eq!(projection.score_milli, 50);
    assert!(!projection.available);
}

#[test]
fn post_commit_transient_stream_failures_count_toward_global_cooldown() {
    // 统一错误模型回归：瞬态型 post-commit 流失败（无状态码）不允许
    // health-neutral 旁路；同一身份连续十次进入全局冷却。
    let manifest = target_resolution_manifest("post_commit_transient_counted");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let session = test_provider_failure_scope(
        "post_commit_transient_counted",
        "post_commit_transient_counted",
        "transient-session",
    )
    .expect("transient session scope");
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderResp14Raw",
        "provider.sse_decode",
        "Responses SSE event was not decodable JSON",
    );

    for _ in 0..10 {
        health
            .record_post_commit_provider_stream_failure_from_source(
                &session,
                "primary",
                Some("key1"),
                Some("gpt-test"),
                &source,
            )
            .expect("post-commit transient stream failure must update key health");
    }

    let fresh_session = test_provider_failure_scope(
        "post_commit_transient_counted",
        "post_commit_transient_counted",
        "fresh-observer-session",
    )
    .expect("fresh session scope");
    let projection =
        routecodex_v3_provider_responses::V3ProviderSchedulingReader::scheduling_projection(
            &health,
            "primary",
            "key1",
            "gpt-test",
            1,
            1,
            v3_relay_provider_policy_now_epoch_ms().expect("current epoch"),
        );
    assert_eq!(projection.score_milli, 50);
    assert!(
        !projection.available,
        "ten transient post-commit failures must cool the key down globally"
    );
    let fresh_projection = health.store().availability_for_session(
        &fresh_session,
        "primary",
        Some("key1"),
        Some("gpt-test"),
        v3_relay_provider_policy_now_epoch_ms().expect("current epoch"),
    );
    assert!(
        !fresh_projection.available,
        "global cooldown must be visible to a fresh session"
    );
}

#[test]
fn incomplete_key_identity_fails_before_provider_cooldown_write() {
    let manifest = target_resolution_manifest("incomplete_key_identity");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let action = V3ProviderFailureAction {
        class_code: "provider_auth_failure".to_string(),
        failure_fingerprint: None,
        recovery: V3ProviderRecoveryKind::IrrecoverableGlobalCooldown,
        scope: V3ProviderHealthScope::GlobalProviderKey,
        score_delta_milli: -400,
        failure_threshold: 1,
        cooldown_ms: 60 * 60_000,
        long_probe_backoff: false,
        advisory_probe: false,
    };
    let scope = test_provider_failure_scope(
        "incomplete_key_identity",
        "incomplete_key_identity",
        "scope",
    )
    .expect("failure session scope");

    let result = health.record_provider_key_failure_action(
        "primary",
        None,
        None,
        &action,
        v3_relay_provider_policy_now_epoch_ms().expect("current epoch"),
    );
    assert!(result.is_err());
    assert!(
        health
            .store()
            .availability_for_session(&scope, "primary", None, None, u64::MAX)
            .available
    );
}

#[test]
fn post_commit_sse_failures_cool_provider_and_block_fresh_session() {
    let manifest = target_resolution_manifest("post_commit_sse_transient");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failed_session = test_provider_failure_scope(
        "post_commit_sse_transient",
        "post_commit_sse_transient",
        "failed-session",
    )
    .expect("failed session scope");
    let fresh_session = test_provider_failure_scope(
        "post_commit_sse_transient",
        "post_commit_sse_transient",
        "fresh-session",
    )
    .expect("fresh session scope");
    let before =
        routecodex_v3_provider_responses::V3ProviderSchedulingReader::scheduling_projection(
            &health, "primary", "key1", "gpt-test", 1, 1, 2_000_000,
        );

    for _ in 0..10 {
        health
            .record_post_commit_provider_stream_failure(
                &failed_session,
                "primary",
                Some("key1"),
                Some("gpt-test"),
                "provider_response_sse_inter_event_timeout",
                "controlled post-commit SSE EOF",
            )
            .expect("post-commit SSE observation must close cleanly");
    }

    let now_ms = v3_relay_provider_policy_now_epoch_ms().expect("current epoch");
    assert!(
        !health
            .store()
            .availability_for_session(
                &fresh_session,
                "primary",
                Some("key1"),
                Some("gpt-test"),
                now_ms,
            )
            .available
    );
    assert!(!health
        .store()
        .provider_cooldown_probe_keys_due(u64::MAX)
        .expect("provider cooldown probe query")
        .is_empty());
    let after = routecodex_v3_provider_responses::V3ProviderSchedulingReader::scheduling_projection(
        &health, "primary", "key1", "gpt-test", 1, 1, 2_000_000,
    );
    assert!(!after.available);
    assert_eq!(after.effective_priority, before.effective_priority);
}

#[tokio::test]
async fn target_resolution_failure_projects_itself_instead_of_prior_provider_429() {
    let mut manifest = target_resolution_manifest("resolution_policy");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let selected = match resolve_target(&manifest, "resolution_policy", &BTreeSet::new(), &health) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("valid fixture must select a provider"),
    };
    manifest.providers.remove("primary");
    let mut failed_candidates = BTreeSet::new();
    let mut same_candidate_retries = BTreeMap::new();
    let mut trace = Vec::new();
    let context = V3RelayProviderFailurePolicyContext {
        recovery_control: None,
        manifest: &manifest,
        captured_target_09: None,
        failure_session_scope: test_provider_failure_scope(
            "resolution_policy",
            "resolution_policy",
            "session-resolution-policy",
        )
        .expect("test failure session scope"),
        provider_health: &health,
        retry_policy: V3RelayProviderFailureRetryPolicy::default(),
        deterministic_sample: 0,
    };
    let mut state = V3RelayProviderFailurePolicyState {
        failed_candidates: &mut failed_candidates,
        same_candidate_retries: &mut same_candidate_retries,
        trace: &mut trace,
        last_external_http: &mut None,
    };

    let result = run_v3_relay_provider_failure_policy(
        &context,
        selected,
        "V3ProviderReqOutbound09TransportRequest",
        429,
        Some("provider_transport_error".to_string()),
        "prior provider returned 429".to_string(),
        None,
        &mut state,
    )
    .await
    .expect("ordinary provider policy failure must remain distinct from a Source01 fault");

    assert_eq!(
        result
            .decision
            .exhaustion
            .local_action
            .classified
            .source
            .code,
        "captured_target_plan_expansion_failed"
    );
    assert_eq!(
        result
            .decision
            .exhaustion
            .local_action
            .classified
            .source
            .source_stage,
        "V3Target09CandidateSetExpanded"
    );
    let projection = result
        .terminal_projection
        .expect("non-provider target-resolution failure is terminal");
    assert_eq!(projection.status, 598);
    assert_ne!(projection.status, 429);
    assert_eq!(
        projection.body["error"]["code"],
        "captured_target_plan_expansion_failed"
    );
    assert!(!projection
        .body
        .to_string()
        .contains("prior provider returned 429"));
}

#[tokio::test]
async fn captured_relay_protocol_admission_does_not_truncate_failure_reselection() {
    let mut manifest = global_pool_alive_manifest("relay_protocol_filter");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let selected = match resolve_target(
        &manifest,
        "relay_protocol_filter",
        &BTreeSet::new(),
        &health,
    ) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("fixture must select the first provider"),
    };
    let selected_key = v3_relay_provider_candidate_key(&selected.candidate);
    let target = V3TargetInterpreter::default();
    let captured_target_09 = target
        .expand_candidates(&manifest, target.classify_kind(selected.route.clone()), 0)
        .expect("capture Target09 before execution");
    manifest.providers.clear();
    let context = V3RelayProviderFailurePolicyContext {
        recovery_control: None,
        manifest: &manifest,
        captured_target_09: Some(&captured_target_09),
        failure_session_scope: test_provider_failure_scope(
            "relay_protocol_filter",
            "relay_protocol_filter",
            "session-relay-protocol-filter",
        )
        .expect("test failure session scope"),
        provider_health: &health,
        retry_policy: V3RelayProviderFailureRetryPolicy::default(),
        deterministic_sample: 0,
    };

    let resolution = reselect_from_captured_target_plan(
        &context,
        &selected,
        &BTreeSet::from([selected_key.clone()]),
        1,
        None,
    )
    .await;
    let V3RelayProviderSuccessorObservation::Resolution(V3RelayProviderTargetResolution::Selected(
        reselected,
    )) = resolution
    else {
        panic!("provider failure must reselect from the full captured route pool");
    };
    assert_ne!(
        v3_relay_provider_candidate_key(&reselected.candidate),
        selected_key
    );
}

#[test]
fn openai_chat_image_url_request_selects_multimodal_pool() {
    let scope = "chat_image_multimodal";
    let source = r#"
version = 3
[servers.__SCOPE__]
bind = "127.0.0.1"
port = 5555
routing_group = "__SCOPE__"
endpoints = ["openai_chat", "responses"]
[providers.multimodal]
type = "anthropic"
base_url = "http://multimodal.invalid/v1"
default_model = "mini-m3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MM_KEY" }] }
[providers.multimodal.models.mini-m3]
wire_name = "mini-m3"
capabilities = ["text", "tools", "multimodal", "vision"]
[providers.text]
type = "openai_chat"
base_url = "http://text.invalid/v1"
default_model = "ds-flash"
auth = { type = "api_key", entries = [{ alias = "key1", env = "TXT_KEY" }] }
[providers.text.models.ds-flash]
wire_name = "ds-flash"
capabilities = ["text", "tools"]
[route_groups.__SCOPE__.pools.multimodal]
selection = { strategy = "priority" }
match = { precedence = 0, required_capabilities = ["multimodal"] }
targets = [
  { kind = "provider_model", provider = "multimodal", model = "mini-m3", key = "key1", priority = 1 }
]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "text", model = "ds-flash", key = "key1", priority = 1 }
]
"#
    .replace("__SCOPE__", scope);
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source).expect("chat image multimodal authoring"),
    )
    .expect("chat image multimodal manifest");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope = V3ProviderFailureSessionScope::new(scope, scope, "image-session")
        .expect("image session scope");
    let body = json!({
        "model": "ds-flash",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "what is this?"},
                {"type": "image_url", "image_url": {"url": "https://example.com/cat.jpg"}}
            ]
        }]
    });
    let resolution = resolve_v3_relay_target_outcome(V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id: scope,
        failure_session_scope: &failure_session_scope,
        entry_kind: "openai_chat",
        endpoint_path: "/v1/chat/completions",
        body: &body,
        request_local_excluded_candidates: &BTreeSet::new(),
        provider_health: &health,
        now_ms: 1,
        deterministic_sample: 0,
    });
    match resolution {
        V3RelayProviderTargetResolution::Selected(selected) => {
            assert_eq!(
                selected.candidate.provider_id, "multimodal",
                "openai_chat image_url request must select the multimodal pool target"
            );
        }
        _other => panic!("openai_chat image_url request must resolve to a target"),
    }
}

fn transport_thrash_manifest(scope: &str) -> V3Config05ManifestPublished {
    let source = r#"
version = 3
[servers.__SCOPE__]
bind = "127.0.0.1"
port = 5555
routing_group = "__SCOPE__"
endpoints = ["responses"]
[providers.first]
type = "responses"
base_url = "http://first.invalid/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "FIRST_KEY1" }, { alias = "key2", env = "FIRST_KEY2" }] }
[providers.first.models.gpt-test]
wire_name = "gpt-test"
capabilities = ["text", "tools", "reasoning"]
[providers.second]
type = "responses"
base_url = "http://second.invalid/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "SECOND_KEY" }] }
[providers.second.models.gpt-test]
wire_name = "gpt-test"
capabilities = ["text", "tools", "reasoning"]
[route_groups.__SCOPE__.pools.client_responses]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", models = ["client-responses"] }
targets = [
  { kind = "provider_model", provider = "first", model = "gpt-test", key = "key1", priority = 3 },
  { kind = "provider_model", provider = "first", model = "gpt-test", key = "key2", priority = 2 },
  { kind = "provider_model", provider = "second", model = "gpt-test", key = "key1", priority = 1 }
]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "first", model = "gpt-test", key = "key1", priority = 3 },
  { kind = "provider_model", provider = "first", model = "gpt-test", key = "key2", priority = 2 },
  { kind = "provider_model", provider = "second", model = "gpt-test", key = "key1", priority = 1 }
]
"#
    .replace("__SCOPE__", scope);
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source).expect("transport-thrash authoring"),
    )
    .expect("transport-thrash manifest")
}

#[tokio::test]
async fn transport_error_selects_untried_same_provider_sibling_key() {
    let manifest = transport_thrash_manifest("transport_thrash");
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let selected = match resolve_target(&manifest, "transport_thrash", &BTreeSet::new(), &health) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("valid fixture must select the first provider"),
    };
    assert!(
        ["first", "second"].contains(&selected.candidate.provider_id.as_str()),
        "unexpected fallback candidate: {}",
        selected.candidate.provider_id
    );
    assert_eq!(selected.candidate.auth_alias, "key1");
    let target = V3TargetInterpreter::default();
    let captured_target_09 = target
        .expand_candidates(&manifest, target.classify_kind(selected.route.clone()), 0)
        .expect("capture Target09 before execution");
    let mut failed_candidates = BTreeSet::new();
    let mut same_candidate_retries = BTreeMap::new();
    let mut trace = Vec::new();
    let context = V3RelayProviderFailurePolicyContext {
        recovery_control: None,
        manifest: &manifest,
        captured_target_09: Some(&captured_target_09),
        failure_session_scope: test_provider_failure_scope(
            "transport_thrash",
            "transport_thrash",
            "session-transport-thrash",
        )
        .expect("test failure session scope"),
        provider_health: &health,
        retry_policy: V3RelayProviderFailureRetryPolicy::default(),
        deterministic_sample: 0,
    };
    let mut state = V3RelayProviderFailurePolicyState {
        failed_candidates: &mut failed_candidates,
        same_candidate_retries: &mut same_candidate_retries,
        trace: &mut trace,
        last_external_http: &mut None,
    };

    let result = run_v3_relay_provider_failure_policy(
        &context,
        selected,
        "V3ProviderReqOutbound09TransportRequest",
        502,
        Some("provider_transport_error".to_string()),
        "error sending request for url".to_string(),
        None,
        &mut state,
    )
    .await
    .expect("ordinary provider policy failure must remain distinct from a Source01 fault");

    let reselected = result
        .retry_selected
        .expect("transport failure must reselect");
    assert_eq!(reselected.candidate.provider_id, "first");
    assert_eq!(reselected.candidate.auth_alias, "key2");
    // The failed exact identity is excluded for this request while typed
    // observation and health still own the recovery policy.
    assert_eq!(
        *state.failed_candidates,
        BTreeSet::from(["first:default:key1:gpt-test".to_string()])
    );
    assert!(!state
        .failed_candidates
        .contains(&"second:default:key1:gpt-test".to_string()));
    assert!(!state
        .failed_candidates
        .contains(&"first:default:key2:gpt-test".to_string()));
    assert_eq!(
        result.event.health_record.state,
        "request_local_provider_compat"
    );
    assert_eq!(
        result.event.health_record.failure_count, 0,
        "health-neutral transport failure does not increment provider health failure_count"
    );
    assert_eq!(result.event.health_record.cooldown_until_ms, None);
    assert!(
        health
            .availability("first", Some("key1"), Some("gpt-test"), 10_000)
            .available,
        "one failure must leave the key available to independent requests"
    );
    assert!(
        health
            .availability("first", Some("key2"), Some("gpt-test"), 10_000)
            .available,
        "the untried sibling key must stay eligible"
    );
    assert!(
        health
            .availability("second", Some("key1"), Some("gpt-test"), 10_000)
            .available,
        "another provider must stay eligible"
    );
    assert!(
        health
            .store()
            .availability_for_session(
                &context.failure_session_scope,
                "first",
                Some("key1"),
                Some("gpt-test"),
                10_000,
            )
            .available,
        "one policy-only transport observation must remain below the recoverable threshold"
    );
    assert!(
        health
            .store()
            .availability_for_session(
                &context.failure_session_scope,
                "first",
                Some("key2"),
                Some("gpt-test"),
                10_000,
            )
            .available,
        "the sibling key must keep its own health"
    );
    assert!(
        health
            .store()
            .availability_for_session(
                &context.failure_session_scope,
                "second",
                Some("key1"),
                Some("gpt-test"),
                10_000,
            )
            .available,
        "another provider must keep its own health"
    );
}

#[tokio::test]
async fn provider_project_step_cannot_override_terminal_projection_status() {
    let scope = "path_project_override";
    let source = r#"
version = 3
[servers.__SCOPE__]
bind = "127.0.0.1"
port = 5555
routing_group = "__SCOPE__"
endpoints = ["responses"]
[providers.first]
type = "responses"
base_url = "http://first.invalid/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "FIRST_KEY" }] }
[providers.first.models.gpt-test]
wire_name = "gpt-test"
capabilities = ["text", "tools"]
[route_groups.__SCOPE__.pools.client_responses]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", models = ["client-responses"] }
targets = [
  { kind = "provider_model", provider = "first", model = "gpt-test", key = "key1", priority = 1 }
]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "first", model = "gpt-test", key = "key1", priority = 1 }
]
[[error.provider_error_action_policy]]
policy_id = "path_only"
scope = { provider_type = "responses", model_id = "gpt-test" }
match = { http_status = 503 }
[[error.provider_error_action_policy.path]]
step = "project"
reason_code = "path_rate_limit"
public_code = "E_PATH_RATE_LIMIT"
"#
    .replace("__SCOPE__", scope);
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source).expect("path-project authoring"),
    )
    .expect("path-project manifest");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let selected = match resolve_target(&manifest, scope, &BTreeSet::new(), &health) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("valid fixture must select the provider"),
    };
    let mut failed_candidates = BTreeSet::new();
    let mut same_candidate_retries = BTreeMap::new();
    let mut trace = Vec::new();
    let context = V3RelayProviderFailurePolicyContext {
        recovery_control: None,
        manifest: &manifest,
        captured_target_09: None,
        failure_session_scope: test_provider_failure_scope(scope, scope, "session-path-project")
            .expect("test failure session scope"),
        provider_health: &health,
        retry_policy: V3RelayProviderFailureRetryPolicy::default(),
        deterministic_sample: 0,
    };
    let mut state = V3RelayProviderFailurePolicyState {
        failed_candidates: &mut failed_candidates,
        same_candidate_retries: &mut same_candidate_retries,
        trace: &mut trace,
        last_external_http: &mut None,
    };

    let result = run_v3_relay_provider_failure_policy(
        &context,
        selected,
        "V3ProviderReqOutbound09TransportRequest",
        503,
        Some("provider_http_503".to_string()),
        "service unavailable".to_string(),
        None,
        &mut state,
    )
    .await
    .expect("ordinary provider policy failure must remain distinct from a Source01 fault");

    let projection = result
        .terminal_projection
        .expect("default-floor exhausted non-429 failure must be terminal");
    assert_eq!(
        projection.status, 502,
        "terminal pool exhaustion must use the declared public network error"
    );
    assert_eq!(
        projection.body["error"]["code"], "network_error",
        "project step public_code must not override terminal pool exhaustion"
    );
}

#[tokio::test]
async fn matched_response_policy_identity_drives_retry_without_message_rematch() {
    let scope = "response_policy_identity";
    let source = r#"
version = 3
[servers.__SCOPE__]
bind = "127.0.0.1"
port = 5555
routing_group = "__SCOPE__"
endpoints = ["responses"]
[providers.first]
type = "responses"
base_url = "http://first.invalid/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "FIRST_KEY" }] }
[[providers.first.response_error_policy]]
policy_id = "exact_response_policy"
[providers.first.response_error_policy.match]
http_status = 200
content_contains_any = ["original diagnostic payload"]
[[providers.first.response_error_policy.path]]
step = "wait_retry"
retry_mode = "retry_same"
max_attempts = 3
backoff_ms = 7000
backoff_multiplier = 2
[[providers.first.response_error_policy.path]]
step = "project"
reason_code = "wrapped_provider_error"
public_code = "E_WRAPPED_PROVIDER"
[[providers.first.response_error_policy]]
policy_id = "reselect_then_retry_policy"
[providers.first.response_error_policy.match]
http_status = 429
[[providers.first.response_error_policy.path]]
step = "wait_retry"
retry_mode = "reselect_before_client_projection"
max_attempts = 3
backoff_ms = 5000
[[providers.first.response_error_policy.path]]
step = "project"
reason_code = "reselect_exhausted"
public_code = "E_RESELECT_EXHAUSTED"
[providers.first.models.gpt-test]
wire_name = "gpt-test"
capabilities = ["text", "tools"]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "first", model = "gpt-test", key = "key1", priority = 1 }
]
"#
    .replace("__SCOPE__", scope);
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source).expect("response-policy authoring"),
    )
    .expect("response-policy manifest");
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let selected = match resolve_target(&manifest, scope, &BTreeSet::new(), &health) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("valid fixture must select the provider"),
    };
    let mut failed_candidates = BTreeSet::new();
    let mut same_candidate_retries = BTreeMap::new();
    let mut trace = Vec::new();
    let context = V3RelayProviderFailurePolicyContext {
        recovery_control: None,
        manifest: &manifest,
        captured_target_09: None,
        failure_session_scope: test_provider_failure_scope(scope, scope, "session-policy-id")
            .expect("test failure session scope"),
        provider_health: &health,
        retry_policy: V3RelayProviderFailureRetryPolicy::default(),
        deterministic_sample: 0,
    };
    let matched_policy = manifest
        .error
        .provider_error_action_policy
        .iter()
        .find(|policy| policy.policy_id == "exact_response_policy")
        .expect("response-policy fixture must expose its captured policy");
    let result = run_v3_relay_provider_failure_policy(
        &context,
        selected,
        "V3ProviderRespInbound01Raw",
        200,
        Some("provider_embedded_error".to_string()),
        "compressed message no longer contains configured keyword".to_string(),
        Some(matched_policy),
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            trace: &mut trace,
            last_external_http: &mut None,
        },
    )
    .await
    .expect("ordinary provider policy failure must remain distinct from a Source01 fault");

    assert_ne!(
        result.event.action, "policy_retry_same",
        "configured RetrySame must not create a production same-candidate retry"
    );
    assert_eq!(result.event.action, "terminal_route_and_default_exhausted");
    assert!(result.retry_selected.is_none());
    assert!(result.terminal_projection.is_some());
    assert!(same_candidate_retries.is_empty());
}

#[tokio::test]
async fn provider_response_event_codec_failure_never_retries_same_candidate() {
    let scope = "codec_failure_no_retry";
    let manifest = codec_failure_manifest(scope);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let selected = match resolve_target(&manifest, scope, &BTreeSet::new(), &health) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("valid fixture must select the provider"),
    };
    let mut failed_candidates = BTreeSet::new();
    let mut same_candidate_retries = BTreeMap::new();
    let mut trace = Vec::new();
    let context = V3RelayProviderFailurePolicyContext {
        recovery_control: None,
        manifest: &manifest,
        captured_target_09: None,
        failure_session_scope: test_provider_failure_scope(scope, scope, "session-codec")
            .expect("test failure session scope"),
        provider_health: &health,
        retry_policy: V3RelayProviderFailureRetryPolicy::from_manifest(&manifest),
        deterministic_sample: 0,
    };
    assert_eq!(
        context.retry_policy.same_candidate_retries, 0,
        "the default path must never expose a same-candidate retry budget"
    );
    let result = run_v3_relay_provider_failure_policy(
        &context,
        selected,
        "V3ProviderRespInbound01Raw",
        502,
        Some("provider_response_event_codec_failure".to_string()),
        "provider response event codec failed: Anthropic codec malformed reasoning content"
            .to_string(),
        None,
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            trace: &mut trace,
            last_external_http: &mut None,
        },
    )
    .await
    .expect("ordinary provider policy failure must remain distinct from a Source01 fault");

    assert_ne!(
        result.event.action, "policy_retry_same",
        "codec failure must never spend the same-candidate retry budget"
    );
    assert!(
        same_candidate_retries.is_empty(),
        "codec failure must not allocate a same-candidate retry counter: {same_candidate_retries:?}"
    );
    assert!(
        !trace.contains(&"V3TargetPolicyRetriedSame"),
        "codec failure trace must not contain V3TargetPolicyRetriedSame: {trace:?}"
    );
}
