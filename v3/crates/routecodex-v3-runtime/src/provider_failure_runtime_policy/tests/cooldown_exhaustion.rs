use super::*;
use crate::hub_v1::V3HubEntryProtocol;
use crate::operation_runner::plan_execution::{
    run_v3_plan_execution_operator_with_recovery, V3PlanExecutionModePolicy, V3PlanExecutionStop,
    V3PlanExecutionTargetSource,
};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, Notify};

fn set_provider_interface_base_url(
    manifest: &mut V3Config05ManifestPublished,
    provider_id: &str,
    interface_id: &str,
    base_url: String,
) {
    let provider = manifest
        .providers
        .get_mut(provider_id)
        .expect("provider fixture must exist");
    provider
        .interfaces
        .get_mut(interface_id)
        .expect("provider interface fixture must exist")
        .base_url = base_url;
    if interface_id == "default" {
        provider.base_url = provider
            .interfaces
            .get(interface_id)
            .expect("default interface fixture must exist")
            .base_url
            .clone();
    }
}
fn all_candidate_keys(expanded: &V3Target09CandidateSetExpanded) -> BTreeSet<String> {
    expanded
        .candidates
        .iter()
        .map(v3_relay_provider_candidate_key)
        .collect()
}

fn put_all_candidates_in_provider_cooldown(
    health: &V3ProviderFailureRuntimeHealth,
    expanded: &V3Target09CandidateSetExpanded,
) {
    for candidate in &expanded.candidates {
        health
            .store
            .record_provider_cooldown_failure_for_interface(
                &candidate.provider_id,
                &candidate.interface_id,
                Some(&candidate.auth_alias),
                Some(&candidate.model_id),
                "controlled cooldown-only exhaustion",
                10_000,
                10_000,
            )
            .expect("provider cooldown setup");
    }
}

fn put_identity_in_global_cooldown(
    health: &V3ProviderFailureRuntimeHealth,
    provider_id: &str,
    auth_alias: &str,
    model_id: &str,
    now_ms: u64,
) {
    for _ in 0..10 {
        health
            .store
            .record_real_provider_failure_for_interface(
                provider_id,
                "default",
                auth_alias,
                model_id,
                Some(401),
                now_ms,
            )
            .expect("real account error must contribute to identity cooldown");
    }
}

fn acquire_rescue_probe(
    health: &V3ProviderFailureRuntimeHealth,
    provider_id: &str,
    auth_alias: &str,
    model_id: &str,
) -> routecodex_v3_provider_responses::V3ProviderHealthProbePermit {
    health
        .store
        .acquire_provider_cooldown_rescue_probe(provider_id, Some(auth_alias), Some(model_id))
        .expect("rescue probe acquisition")
        .expect("rescue probe must be acquired")
}

fn closed_availability_for_current_utc_minute(
) -> routecodex_v3_config::V3ProviderModelAvailabilityAuthoringConfig {
    let now_seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("test clock must be after the unix epoch")
        .as_secs();
    let current_minute = (now_seconds / 60) % 1_440;
    let start_minute = (current_minute + 2) % 1_440;
    let end_minute = (start_minute + 1) % 1_440;
    routecodex_v3_config::V3ProviderModelAvailabilityAuthoringConfig {
        timezone: "UTC".to_string(),
        guard_minutes: 0,
        periods: vec![routecodex_v3_config::V3DailyTimeWindowAuthoringConfig {
            start: format!("{:02}:{:02}", start_minute / 60, start_minute % 60),
            end: format!("{:02}:{:02}", end_minute / 60, end_minute % 60),
        }],
    }
}

fn append_emergency_third_candidate(
    expanded: &mut V3Target09CandidateSetExpanded,
    selected_provider_id: &str,
    sibling_provider_id: &str,
) -> V3TargetCandidate {
    let initial_pool_id = expanded
        .route
        .target_plan
        .first()
        .expect("expanded route must have an initial plan")
        .pool_id
        .clone();
    let selected = expanded
        .candidates
        .iter_mut()
        .find(|candidate| candidate.provider_id == selected_provider_id)
        .expect("selected candidate");
    selected.pool_ids = vec![initial_pool_id];
    let sibling = expanded
        .candidates
        .iter_mut()
        .find(|candidate| candidate.provider_id == sibling_provider_id)
        .expect("sibling candidate");
    sibling.pool_ids = vec!["fallback".to_string()];
    let mut third = sibling.clone();
    third.provider_id = "third".to_string();
    third.pool_ids = vec!["emergency".to_string()];
    expanded.candidates.push(third.clone());

    let target_kind = expanded
        .route
        .target_plan
        .first()
        .expect("expanded route must have an initial plan")
        .target_kind
        .clone();
    expanded.route.target_plan.push(
        routecodex_v3_virtual_router::V3Router07OpaqueTargetPlanEntry {
            tier_index: 1,
            pool_id: "fallback".to_string(),
            target_index: 0,
            target_kind: target_kind.clone(),
            target_id: None,
            interface: None,
            priority: 1,
            weight: 1,
            session_sticky: false,
            direct_provider_model: Some((sibling_provider_id.to_string(), "gpt-test".to_string())),
        },
    );
    expanded.route.target_plan.push(
        routecodex_v3_virtual_router::V3Router07OpaqueTargetPlanEntry {
            tier_index: 2,
            pool_id: "emergency".to_string(),
            target_index: 0,
            target_kind,
            target_id: None,
            interface: None,
            priority: 1,
            weight: 1,
            session_sticky: false,
            direct_provider_model: Some(("third".to_string(), "gpt-test".to_string())),
        },
    );
    third
}

fn mixed_policy_fixture(
    server_id: &str,
    session_id: &str,
) -> (
    V3Config05ManifestPublished,
    V3ProviderFailureRuntimeHealth,
    V3ProviderFailureSessionScope,
    V3Target10ConcreteProviderSelected,
    V3Target09CandidateSetExpanded,
    String,
    String,
) {
    let manifest = global_pool_alive_manifest(server_id);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, session_id)
            .expect("failure session scope");
    let selected = match resolve_target(&manifest, server_id, &BTreeSet::new(), &health) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("a healthy provider must be selected"),
    };
    let target = V3TargetInterpreter::default();
    let mut expanded = target
        .expand_candidates(
            &manifest,
            target.classify_kind(selected.route.clone()),
            0,
        )
        .expect("captured target expansion");
    let selected_provider_id = selected.candidate.provider_id.clone();
    let sibling_provider_id = expanded
        .candidates
        .iter()
        .map(|candidate| candidate.provider_id.clone())
        .find(|provider_id| provider_id != &selected_provider_id)
        .expect("the manifest must declare one non-selected sibling provider");
    append_emergency_third_candidate(
        &mut expanded,
        &selected_provider_id,
        &sibling_provider_id,
    );
    (
        manifest,
        health,
        failure_session_scope,
        selected,
        expanded,
        selected_provider_id,
        sibling_provider_id,
    )
}

async fn serve_one_responses_probe(listener: TcpListener) {
    let (mut socket, _) = listener
        .accept()
        .await
        .expect("provider probe listener must accept one request");
    let mut request = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        let read = tokio::time::timeout(Duration::from_secs(1), socket.read(&mut chunk))
            .await
            .expect("provider probe request headers must arrive")
            .expect("provider probe request must be readable");
        if read == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..read]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let body = r#"{"status":"completed"}"#;
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    socket
        .write_all(response.as_bytes())
        .await
        .expect("provider probe response must be writable");
}

async fn serve_two_gated_responses_probes(
    listener: TcpListener,
    arrivals: mpsc::UnboundedSender<()>,
    release: oneshot::Receiver<()>,
) {
    let mut sockets = Vec::with_capacity(2);
    for _ in 0..2 {
        let (mut socket, _) = listener
            .accept()
            .await
            .expect("provider probe listener must accept both requests");
        let mut request = Vec::new();
        let mut chunk = [0_u8; 4096];
        loop {
            let read = tokio::time::timeout(Duration::from_secs(1), socket.read(&mut chunk))
                .await
                .expect("provider probe request headers must arrive")
                .expect("provider probe request must be readable");
            if read == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..read]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        arrivals
            .send(())
            .expect("probe test must observe both requests");
        sockets.push(socket);
    }
    release
        .await
        .expect("test must release both provider probes");
    let body = r#"{"status":"completed"}"#;
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    for mut socket in sockets {
        socket
            .write_all(response.as_bytes())
            .await
            .expect("provider probe response must be writable");
    }
}

#[test]
fn request_local_provider_failure_excludes_only_failed_candidate() {
    let scope = "request_local_provider_exclusion";
    let mut manifest = global_pool_alive_manifest(scope);
    let primary = manifest.providers.get_mut("first").expect("first provider");
    let mut key2 = primary.auth.entries[0].clone();
    key2.alias = "key2".to_string();
    primary.auth.entries.push(key2);

    let group = manifest
        .route_groups
        .get_mut(scope)
        .expect("request-local provider exclusion group");
    for pool in group.pools.values_mut() {
        for target in &mut pool.targets {
            if target.provider.as_deref() == Some("first") {
                target.key = None;
                target.priority = Some(2);
            } else {
                target.priority = Some(1);
            }
        }
    }

    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let selected = match resolve_target(&manifest, scope, &BTreeSet::new(), &health) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("first provider must be selectable before failure"),
    };
    let failed_key = selected.candidate.auth_alias.clone();
    let excluded = BTreeSet::from([v3_relay_provider_candidate_key(&selected.candidate)]);

    let V3RelayProviderTargetResolution::Selected(selected) =
        resolve_target(&manifest, scope, &excluded, &health)
    else {
        panic!("the sibling key must remain selectable");
    };
    assert_eq!(selected.candidate.provider_id, "first");
    assert_ne!(selected.candidate.auth_alias, failed_key);
}

#[test]
fn request_local_exclusion_identity_preserves_sibling_interface() {
    // Request-local exclusion is keyed by the exact
    // provider:interface:auth:model identity, so excluding the default
    // interface must leave a sibling interface candidate selectable.
    let default_key = v3_relay_provider_candidate_key_parts_for_interface(
        "primary",
        "default",
        Some("key1"),
        Some("gpt-test"),
    );
    let sibling_key = v3_relay_provider_candidate_key_parts_for_interface(
        "primary",
        "sibling",
        Some("key1"),
        Some("gpt-test"),
    );
    assert_ne!(default_key, sibling_key);
    let excluded = BTreeSet::from([default_key]);
    assert!(!excluded.contains(&sibling_key));
}

#[tokio::test]
async fn fresh_cooldown_only_exhaustion_runs_one_rescue_probe_and_resumes_same_request() {
    let server_id = "fresh_cooldown_only_exhaustion";
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("provider probe listener must bind");
    let base_url = format!(
        "http://{}/v1",
        listener
            .local_addr()
            .expect("provider probe listener address")
    );
    let mut manifest = global_pool_alive_manifest(server_id);
    set_provider_interface_base_url(&mut manifest, "first", "default", base_url);
    let provider = manifest.providers.get_mut("first").expect("first provider");
    provider.auth.entries[0].env = Some("ROUTECODEX_V3_FRESH_COOLDOWN_PROBE_KEY".into());
    std::env::set_var(
        "ROUTECODEX_V3_FRESH_COOLDOWN_PROBE_KEY",
        "routecodex-test-key",
    );
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "fresh-cooldown-session")
            .expect("failure session scope");
    let expanded = match build_v3_relay_target_candidates(&V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id,
        failure_session_scope: &failure_session_scope,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &json!({"model":"client-responses","input":"hello"}),
        request_local_excluded_candidates: &BTreeSet::new(),
        provider_health: &health,
        now_ms: 20_001,
        deterministic_sample: 0,
    }) {
        Ok(expanded) => expanded,
        Err(_) => panic!("expanded candidates failed"),
    };
    put_all_candidates_in_provider_cooldown(&health, &expanded);
    let probe_server = tokio::spawn(serve_one_responses_probe(listener));

    let outcome = tokio::time::timeout(
        Duration::from_secs(2),
        run_v3_plan_execution_operator_with_recovery(
            crate::execution_control::V3AttemptBudget::process_default(),
            json!({"model":"client-responses","input":"hello"}),
            &manifest,
            V3PlanExecutionTargetSource::Expanded(expanded),
            &failure_session_scope,
            &health,
            &BTreeSet::new(),
            &BTreeSet::new(),
            20_001,
            0,
            None,
            V3PlanExecutionModePolicy::RelayOnly {
                entry_protocol: V3HubEntryProtocol::Responses,
            },
        ),
    )
    .await
    .expect("fresh cooldown exhaustion must not wait forever");
    assert!(
        outcome.is_ok(),
        "successful fresh rescue probe must resume the same request"
    );
    tokio::time::timeout(Duration::from_secs(1), probe_server)
        .await
        .expect("fresh cooldown exhaustion must run a rescue probe")
        .expect("provider probe task must not panic");
}

#[tokio::test]
async fn stale_rescue_probe_completion_does_not_abort_reselection_of_next_provider() {
    let server_id = "stale_rescue_probe_completion";
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("provider probe listener must bind");
    let base_url = format!(
        "http://{}/v1",
        listener
            .local_addr()
            .expect("provider probe listener address")
    );
    let mut manifest = global_pool_alive_manifest(server_id);
    for provider_id in ["first", "second"] {
        set_provider_interface_base_url(&mut manifest, provider_id, "default", base_url.clone());
        let provider = manifest
            .providers
            .get_mut(provider_id)
            .expect("configured provider");
        provider.auth.entries[0].env = Some("ROUTECODEX_V3_STALE_RESCUE_PROBE_KEY".into());
    }
    std::env::set_var(
        "ROUTECODEX_V3_STALE_RESCUE_PROBE_KEY",
        "routecodex-test-key",
    );
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "stale-rescue-session")
            .expect("failure session scope");
    let expanded = match build_v3_relay_target_candidates(&V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id,
        failure_session_scope: &failure_session_scope,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &json!({"model":"client-responses","input":"hello"}),
        request_local_excluded_candidates: &BTreeSet::new(),
        provider_health: &health,
        now_ms: 20_001,
        deterministic_sample: 0,
    }) {
        Ok(expanded) => expanded,
        Err(_) => panic!("expanded candidates failed"),
    };
    put_all_candidates_in_provider_cooldown(&health, &expanded);
    let stale_candidate = expanded.candidates[0].clone();
    let (arrivals_tx, mut arrivals_rx) = mpsc::unbounded_channel();
    let (release_tx, release_rx) = oneshot::channel();
    let probe_server = tokio::spawn(serve_two_gated_responses_probes(
        listener,
        arrivals_tx,
        release_rx,
    ));
    let selection_manifest = manifest.clone();
    let selection_expanded = expanded.clone();
    let selection_scope = failure_session_scope.clone();
    let selection_health = health.clone();
    let selection = tokio::spawn(async move {
        run_v3_plan_execution_operator_with_recovery(
            crate::execution_control::V3AttemptBudget::process_default(),
            json!({"model":"client-responses","input":"hello"}),
            &selection_manifest,
            V3PlanExecutionTargetSource::Expanded(selection_expanded),
            &selection_scope,
            &selection_health,
            &BTreeSet::new(),
            &BTreeSet::new(),
            20_001,
            0,
            None,
            V3PlanExecutionModePolicy::RelayOnly {
                entry_protocol: V3HubEntryProtocol::Responses,
            },
        )
        .await
    });
    for _ in 0..2 {
        tokio::time::timeout(Duration::from_secs(10), arrivals_rx.recv())
            .await
            .expect("both provider rescue probes must start")
            .expect("probe arrival channel must stay open");
    }

    health
        .store
        .record_provider_failure_action(
            &stale_candidate.provider_id,
            &stale_candidate.auth_alias,
            &stale_candidate.model_id,
            &V3ProviderFailureAction::recoverable("transport"),
            20_002,
        )
        .expect("newer provider failure must advance health generation");
    release_tx
        .send(())
        .expect("both probes must be released after the generation advances");

    let selection = tokio::time::timeout(Duration::from_secs(2), selection)
        .await
        .expect("stale probe completion must not hold target reselection")
        .expect("selection task must not panic");
    match selection {
        Ok((_execution_planned_request, plan)) => assert_ne!(
            plan.selected.candidate.provider_id, stale_candidate.provider_id,
            "newer failure must keep the stale-probe provider excluded and select the next provider"
        ),
        Err(V3PlanExecutionStop::Failed(source)) => {
            panic!("stale rescue probe must not fail target reselection: {source:?}")
        }
        Err(V3PlanExecutionStop::Exhausted { .. }) => {
            panic!("successful next-provider probe must prevent pool exhaustion")
        }
        Err(V3PlanExecutionStop::OperatorFault(fault)) => {
            panic!("stale rescue probe must not raise an SDK operator fault: {fault:?}")
        }
    }
    tokio::time::timeout(Duration::from_secs(1), probe_server)
        .await
        .expect("both rescue probes must finish")
        .expect("provider probe server must not panic");
}

#[tokio::test]
async fn cooldown_only_exhaustion_waits_for_other_requests_successful_probe() {
    let server_id = "cooldown_only_exhaustion";
    let manifest = global_pool_alive_manifest(server_id);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "cooldown-only-session")
            .expect("failure session scope");
    let expanded = match build_v3_relay_target_candidates(&V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id,
        failure_session_scope: &failure_session_scope,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &json!({"model":"client-responses","input":"hello"}),
        request_local_excluded_candidates: &BTreeSet::new(),
        provider_health: &health,
        now_ms: 20_001,
        deterministic_sample: 0,
    }) {
        Ok(expanded) => expanded,
        Err(_) => panic!("expanded candidates failed"),
    };
    put_all_candidates_in_provider_cooldown(&health, &expanded);
    let first = expanded.candidates[0].clone();
    let second = expanded.candidates[1].clone();
    let excluded_key = v3_relay_provider_candidate_key(&first);
    let first_permit = acquire_rescue_probe(
        &health,
        &first.provider_id,
        &first.auth_alias,
        &first.model_id,
    );
    let second_permit = acquire_rescue_probe(
        &health,
        &second.provider_id,
        &second.auth_alias,
        &second.model_id,
    );

    let selection_started = Arc::new(Notify::new());
    let selection = {
        let health = health.clone();
        let failure_session_scope = failure_session_scope.clone();
        let selection_started = selection_started.clone();
        let request_local_excluded_candidates = BTreeSet::from([excluded_key.clone()]);
        let request_local_busy_candidates = BTreeSet::new();
        tokio::spawn(async move {
            let task = run_v3_plan_execution_operator_with_recovery(
                crate::execution_control::V3AttemptBudget::process_default(),
                json!({"model":"client-responses","input":"hello"}),
                &manifest,
                V3PlanExecutionTargetSource::Expanded(expanded),
                &failure_session_scope,
                &health,
                &request_local_excluded_candidates,
                &request_local_busy_candidates,
                20_001,
                0,
                None,
                V3PlanExecutionModePolicy::RelayOnly {
                    entry_protocol: V3HubEntryProtocol::Responses,
                },
            );
            selection_started.notify_one();
            task.await
        })
    };
    selection_started.notified().await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !selection.is_finished(),
        "cooldown-only exhaustion must await an eligible recovery"
    );

    health
        .store
        .complete_provider_cooldown_probe_success_with_permit(&first_permit, 20_001)
        .expect("first rescue probe success");

    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !selection.is_finished(),
        "success of the permanently excluded candidate must not release this request"
    );

    health
        .store
        .complete_provider_cooldown_probe_success_with_permit(&second_permit, 20_001)
        .expect("second rescue probe success");

    let selection = tokio::time::timeout(Duration::from_millis(500), selection)
        .await
        .expect("selection must wake after rescue probe success")
        .expect("selection task must not panic");
    let Ok((_, plan)) = selection else {
        panic!("eligible successful probe must restore selection")
    };
    assert_eq!(plan.selected.candidate.provider_id, second.provider_id);
    assert!(
        health
            .availability(
                &second.provider_id,
                Some(&second.auth_alias),
                Some(&second.model_id),
                20_001
            )
            .unwrap()
            .available,
        "independent successful probe must still restore provider health"
    );
}

#[tokio::test]
async fn cooldown_only_exhaustion_preserves_independent_failed_and_successful_probes() {
    let server_id = "cooldown_only_exhaustion_failure";
    let manifest = global_pool_alive_manifest(server_id);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "cooldown-only-failure-session")
            .expect("failure session scope");
    let expanded = match build_v3_relay_target_candidates(&V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id,
        failure_session_scope: &failure_session_scope,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &json!({"model":"client-responses","input":"hello"}),
        request_local_excluded_candidates: &BTreeSet::new(),
        provider_health: &health,
        now_ms: 20_001,
        deterministic_sample: 0,
    }) {
        Ok(expanded) => expanded,
        Err(_) => panic!("expanded candidates failed"),
    };
    put_all_candidates_in_provider_cooldown(&health, &expanded);
    let first = expanded.candidates[0].clone();
    let second = expanded.candidates[1].clone();
    let excluded_key = v3_relay_provider_candidate_key(&first);
    let first_permit = acquire_rescue_probe(
        &health,
        &first.provider_id,
        &first.auth_alias,
        &first.model_id,
    );
    let second_permit = acquire_rescue_probe(
        &health,
        &second.provider_id,
        &second.auth_alias,
        &second.model_id,
    );

    let selection_started = Arc::new(Notify::new());
    let selection = {
        let health = health.clone();
        let failure_session_scope = failure_session_scope.clone();
        let selection_started = selection_started.clone();
        let request_local_excluded_candidates = BTreeSet::from([excluded_key.clone()]);
        let request_local_busy_candidates = BTreeSet::new();
        tokio::spawn(async move {
            let task = run_v3_plan_execution_operator_with_recovery(
                crate::execution_control::V3AttemptBudget::process_default(),
                json!({"model":"client-responses","input":"hello"}),
                &manifest,
                V3PlanExecutionTargetSource::Expanded(expanded),
                &failure_session_scope,
                &health,
                &request_local_excluded_candidates,
                &request_local_busy_candidates,
                20_001,
                0,
                None,
                V3PlanExecutionModePolicy::RelayOnly {
                    entry_protocol: V3HubEntryProtocol::Responses,
                },
            );
            selection_started.notify_one();
            task.await
        })
    };
    selection_started.notified().await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !selection.is_finished(),
        "in-flight probes must retain the request within its recovery budget"
    );

    health
        .store
        .complete_provider_cooldown_probe_failure_with_permit(&first_permit, 20_001)
        .expect("first rescue probe failure");

    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !selection.is_finished(),
        "one failed probe must not terminate the remaining eligible recovery"
    );

    health
        .store
        .complete_provider_cooldown_probe_success_with_permit(&second_permit, 20_001)
        .expect("second rescue probe success");

    let selection = tokio::time::timeout(Duration::from_millis(500), selection)
        .await
        .expect("selection must wake after a later rescue probe succeeds")
        .expect("selection task must not panic");
    let Ok((_, plan)) = selection else {
        panic!("eligible successful probe must restore selection")
    };
    assert_eq!(plan.selected.candidate.provider_id, second.provider_id);
    assert!(
        !health
            .availability(
                &first.provider_id,
                Some(&first.auth_alias),
                Some(&first.model_id),
                20_001
            )
            .unwrap()
            .available
    );
    assert!(
        health
            .availability(
                &second.provider_id,
                Some(&second.auth_alias),
                Some(&second.model_id),
                20_001
            )
            .unwrap()
            .available
    );
}

#[tokio::test]
async fn cooldown_only_exhaustion_recovers_after_independent_probe_failure() {
    let server_id = "cooldown_only_exhaustion_due_retry";
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("provider probe listener must bind");
    let base_url = format!(
        "http://{}/v1",
        listener
            .local_addr()
            .expect("provider probe listener address")
    );
    let mut manifest = global_pool_alive_manifest_with_rescue_timeout(server_id, Some(200));
    set_provider_interface_base_url(&mut manifest, "first", "default", base_url);
    let provider = manifest.providers.get_mut("first").expect("first provider");
    provider.auth.entries[0].env = Some("ROUTECODEX_V3_DUE_RETRY_PROBE_KEY".into());
    std::env::set_var("ROUTECODEX_V3_DUE_RETRY_PROBE_KEY", "routecodex-test-key");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "cooldown-due-retry-session")
            .expect("failure session scope");
    let expanded = match build_v3_relay_target_candidates(&V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id,
        failure_session_scope: &failure_session_scope,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &json!({"model":"client-responses","input":"hello"}),
        request_local_excluded_candidates: &BTreeSet::new(),
        provider_health: &health,
        now_ms: 20_001,
        deterministic_sample: 0,
    }) {
        Ok(expanded) => expanded,
        Err(_) => panic!("expanded candidates failed"),
    };
    put_all_candidates_in_provider_cooldown(&health, &expanded);
    let second = expanded.candidates[1].clone();
    let second_permit = acquire_rescue_probe(
        &health,
        &second.provider_id,
        &second.auth_alias,
        &second.model_id,
    );

    let selection = tokio::spawn({
        let health = health.clone();
        let failure_session_scope = failure_session_scope.clone();
        async move {
            run_v3_plan_execution_operator_with_recovery(
                crate::execution_control::V3AttemptBudget::from_manifest(&manifest, server_id)
                    .unwrap(),
                json!({"model":"client-responses","input":"hello"}),
                &manifest,
                V3PlanExecutionTargetSource::Expanded(expanded),
                &failure_session_scope,
                &health,
                &BTreeSet::new(),
                &BTreeSet::new(),
                20_001,
                0,
                None,
                V3PlanExecutionModePolicy::RelayOnly {
                    entry_protocol: V3HubEntryProtocol::Responses,
                },
            )
            .await
        }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !selection.is_finished(),
        "failed rescue must wait for the original request residence budget"
    );
    health
        .store
        .complete_provider_cooldown_probe_failure_with_permit(&second_permit, 20_001)
        .expect("first rescue probe failure");

    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(
        !selection.is_finished(),
        "a failed probe and elapsed budget must not end recoverable pool waiting"
    );
    assert!(
        health
            .store
            .provider_cooldown_probe_next_deadline_ms(
                &second.provider_id,
                Some(&second.auth_alias),
                Some(&second.model_id)
            )
            .unwrap()
            .is_some(),
        "independent failed probe must retain its next scheduled recovery"
    );
    // A rescue may already have reached the listener before cancellation.
    let _initial_probe = tokio::time::timeout(Duration::from_millis(50), listener.accept()).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err(),
        "the waiting request must not hammer the provider before its next probe"
    );
    health
        .store
        .record_provider_key_success_for_interface(
            &second.provider_id,
            &second.interface_id,
            &second.auth_alias,
            &second.model_id,
            20_002,
        )
        .expect("matching success restores the independently cooled identity");
    let outcome = tokio::time::timeout(Duration::from_secs(3), selection)
        .await
        .expect("a matching recovery must wake selection")
        .expect("selection task must not panic");
    assert!(
        outcome.is_ok(),
        "the accepted request must resume after recovery"
    );
}

#[tokio::test]
async fn cooldown_only_exhaustion_recovers_after_request_residence_budget() {
    let server_id = "cooldown_only_exhaustion_rescue_deadline";
    let manifest = global_pool_alive_manifest_with_rescue_timeout(server_id, Some(150));
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope = test_provider_failure_scope(
        server_id,
        server_id,
        "cooldown-only-rescue-deadline-session",
    )
    .expect("failure session scope");
    let expanded = match build_v3_relay_target_candidates(&V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id,
        failure_session_scope: &failure_session_scope,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &json!({"model":"client-responses","input":"hello"}),
        request_local_excluded_candidates: &BTreeSet::new(),
        provider_health: &health,
        now_ms: 20_001,
        deterministic_sample: 0,
    }) {
        Ok(expanded) => expanded,
        Err(_) => panic!("expanded candidates failed"),
    };
    put_all_candidates_in_provider_cooldown(&health, &expanded);
    let recovered = expanded.candidates[0].clone();
    let excluded = BTreeSet::new();
    let busy = BTreeSet::new();
    let selection = run_v3_plan_execution_operator_with_recovery(
        crate::execution_control::V3AttemptBudget::from_manifest(&manifest, server_id).unwrap(),
        json!({"model":"client-responses","input":"hello"}),
        &manifest,
        V3PlanExecutionTargetSource::Expanded(expanded),
        &failure_session_scope,
        &health,
        &excluded,
        &busy,
        20_001,
        0,
        None,
        V3PlanExecutionModePolicy::RelayOnly {
            entry_protocol: V3HubEntryProtocol::Responses,
        },
    );
    tokio::pin!(selection);
    assert!(
        tokio::time::timeout(Duration::from_millis(400), &mut selection)
            .await
            .is_err(),
        "the original residence deadline must not end recoverable pool waiting"
    );
    health
        .store
        .record_provider_key_success_for_interface(
            &recovered.provider_id,
            &recovered.interface_id,
            &recovered.auth_alias,
            &recovered.model_id,
            20_002,
        )
        .expect("matching business success restores the candidate");
    let outcome = tokio::time::timeout(Duration::from_secs(2), &mut selection)
        .await
        .expect("the matching recovery must wake selection");
    assert!(
        outcome.is_ok(),
        "the request must resume when its candidate recovers"
    );
}

#[tokio::test]
async fn request_local_exclusion_without_cooldown_probe_success_waits_residence_budget() {
    let server_id = "request_local_exclusion_without_probe";
    let manifest = global_pool_alive_manifest_with_rescue_timeout(server_id, Some(300));
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "request-local-exclusion-session")
            .expect("failure session scope");
    let expanded = match build_v3_relay_target_candidates(&V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id,
        failure_session_scope: &failure_session_scope,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &json!({"model":"client-responses","input":"hello"}),
        request_local_excluded_candidates: &BTreeSet::new(),
        provider_health: &health,
        now_ms: 20_001,
        deterministic_sample: 0,
    }) {
        Ok(expanded) => expanded,
        Err(_) => panic!("expanded candidates failed"),
    };
    let request_local_excluded_candidates = all_candidate_keys(&expanded);
    let attempt_budget =
        crate::execution_control::V3AttemptBudget::from_manifest(&manifest, server_id)
            .expect("attempt budget");

    let started = tokio::time::Instant::now();
    let selection = tokio::time::timeout(
        Duration::from_secs(2),
        run_v3_plan_execution_operator_with_recovery(
            attempt_budget.clone(),
            json!({"model":"client-responses","input":"hello"}),
            &manifest,
            V3PlanExecutionTargetSource::Expanded(expanded),
            &failure_session_scope,
            &health,
            &request_local_excluded_candidates,
            &BTreeSet::new(),
            20_001,
            0,
            None,
            V3PlanExecutionModePolicy::RelayOnly {
                entry_protocol: V3HubEntryProtocol::Responses,
            },
        ),
    )
    .await
    .expect("an excluded request must still reach its own residence deadline");
    assert!(
        matches!(selection, Err(V3PlanExecutionStop::Exhausted { .. })),
        "exhaustion may only terminate after the original request residence budget"
    );
    assert!(
        started.elapsed() >= Duration::from_millis(300),
        "the protected request must wait its original residence budget instead of closing immediately"
    );
    assert_eq!(
        attempt_budget.transport_attempts(),
        0,
        "a wait held by request-local exclusions must not send another provider attempt"
    );

    // Cancellation must end the same wait promptly, without a default 600s hang
    // and without a new provider attempt. The waiter owns no business lease.
    let cancel_manifest = global_pool_alive_manifest_with_rescue_timeout(server_id, Some(2000));
    let cancel_health = V3ProviderFailureRuntimeHealth::from_manifest(&cancel_manifest);
    let cancel_scope =
        test_provider_failure_scope(server_id, server_id, "request-local-cancel-session")
            .expect("cancel session scope");
    let cancel_expanded =
        match build_v3_relay_target_candidates(&V3RelayProviderTargetResolutionInput {
            manifest: &cancel_manifest,
            server_id,
            failure_session_scope: &cancel_scope,
            entry_kind: "responses",
            endpoint_path: "/v1/responses",
            body: &json!({"model":"client-responses","input":"hello"}),
            request_local_excluded_candidates: &BTreeSet::new(),
            provider_health: &cancel_health,
            now_ms: 20_001,
            deterministic_sample: 0,
        }) {
            Ok(expanded) => expanded,
            Err(_) => panic!("expanded candidates failed"),
        };
    let cancel_budget =
        crate::execution_control::V3AttemptBudget::from_manifest(&cancel_manifest, server_id)
            .expect("cancel attempt budget");
    let cancel_excluded = all_candidate_keys(&cancel_expanded);
    let busy = BTreeSet::new();
    let waiting = tokio::spawn(async move {
        run_v3_plan_execution_operator_with_recovery(
            cancel_budget,
            json!({"model":"client-responses","input":"hello"}),
            &cancel_manifest,
            V3PlanExecutionTargetSource::Expanded(cancel_expanded),
            &cancel_scope,
            &cancel_health,
            &cancel_excluded,
            &busy,
            20_001,
            0,
            None,
            V3PlanExecutionModePolicy::RelayOnly {
                entry_protocol: V3HubEntryProtocol::Responses,
            },
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !waiting.is_finished(),
        "the excluded request must still be pending before cancellation"
    );
    waiting.abort();
    let cancelled = tokio::time::timeout(Duration::from_millis(500), waiting)
        .await
        .expect("client cancellation must end the excluded request wait promptly");
    assert!(
        cancelled.is_err(),
        "client cancellation must cancel the pending wait instead of letting it run to its residence deadline"
    );
}

#[tokio::test]
async fn identity_cooldown_exhaustion_preserves_independent_probe_recovery() {
    let server_id = "auth_key_cooldown_with_provider_probe";
    let manifest = global_pool_alive_manifest(server_id);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "auth-key-with-provider-probe")
            .expect("failure session scope");
    let expanded = match build_v3_relay_target_candidates(&V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id,
        failure_session_scope: &failure_session_scope,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &json!({"model":"client-responses","input":"hello"}),
        request_local_excluded_candidates: &BTreeSet::new(),
        provider_health: &health,
        now_ms: 20_001,
        deterministic_sample: 0,
    }) {
        Ok(expanded) => expanded,
        Err(_) => panic!("expanded candidates failed"),
    };
    for provider_id in ["first", "second"] {
        put_identity_in_global_cooldown(&health, provider_id, "key1", "gpt-test", 20_001);
    }
    let first_permit = health
        .store
        .acquire_provider_cooldown_probe_if_due("first", Some("key1"), Some("gpt-test"), 25_001)
        .expect("auth-key due probe acquisition")
        .expect("the model candidate must acquire its exact identity probe");
    assert_eq!(first_permit.auth_alias(), Some("key1"));
    assert_eq!(
        first_permit.model_id(),
        Some("gpt-test"),
        "the auth-key probe must retain the failed model identity"
    );

    let selection = tokio::spawn({
        let health = health.clone();
        let failure_session_scope = failure_session_scope.clone();
        async move {
            run_v3_plan_execution_operator_with_recovery(
                crate::execution_control::V3AttemptBudget::process_default(),
                json!({"model":"client-responses","input":"hello"}),
                &manifest,
                V3PlanExecutionTargetSource::Expanded(expanded),
                &failure_session_scope,
                &health,
                &BTreeSet::new(),
                &BTreeSet::new(),
                25_001,
                0,
                None,
                V3PlanExecutionModePolicy::RelayOnly {
                    entry_protocol: V3HubEntryProtocol::Responses,
                },
            )
            .await
        }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !selection.is_finished(),
        "auth-key cooldown must wait for independent recovery within its budget"
    );

    health
        .store
        .complete_provider_cooldown_probe_failure_with_permit(&first_permit, 25_001)
        .expect("failed auth-key probe");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !selection.is_finished(),
        "a failed auth-key probe must retain recovery waiting"
    );
    let retry_deadline_ms = health
        .store
        .provider_cooldown_probe_next_deadline_ms("first", Some("key1"), Some("gpt-test"))
        .expect("auth-key retry deadline")
        .expect("failed auth-key probe must schedule a retry");
    let retry = health
        .store
        .acquire_provider_cooldown_probe_if_due(
            "first",
            Some("key1"),
            Some("gpt-test"),
            retry_deadline_ms,
        )
        .expect("auth-key retry probe acquisition")
        .expect("the model candidate must resolve the next auth-key probe deadline");
    health
        .store
        .complete_provider_cooldown_probe_success_with_permit(&retry, retry_deadline_ms)
        .expect("successful auth-key retry probe");
    let selection = tokio::time::timeout(Duration::from_millis(500), selection)
        .await
        .expect("selection must wake after auth-key probe success")
        .expect("selection task must not panic");
    assert!(
        selection.is_ok(),
        "successful independent retry must restore the held request"
    );
    assert!(
        health
            .availability("first", Some("key1"), Some("gpt-test"), retry_deadline_ms)
            .unwrap()
            .available
    );
}

#[tokio::test]
async fn identity_cooldown_exhaustion_waits_for_other_requests_successful_probe() {
    let server_id = "auth_key_cooldown_with_successful_provider_probe";
    let manifest = global_pool_alive_manifest(server_id);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope = test_provider_failure_scope(
        server_id,
        server_id,
        "auth-key-with-successful-provider-probe",
    )
    .expect("failure session scope");
    let expanded = match build_v3_relay_target_candidates(&V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id,
        failure_session_scope: &failure_session_scope,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &json!({"model":"client-responses","input":"hello"}),
        request_local_excluded_candidates: &BTreeSet::new(),
        provider_health: &health,
        now_ms: 20_001,
        deterministic_sample: 0,
    }) {
        Ok(expanded) => expanded,
        Err(_) => panic!("expanded candidates failed"),
    };
    for provider_id in ["first", "second"] {
        put_identity_in_global_cooldown(&health, provider_id, "key1", "gpt-test", 20_001);
    }
    let first_permit = health
        .store
        .acquire_provider_cooldown_probe_if_due("first", Some("key1"), Some("gpt-test"), 25_001)
        .expect("auth-key due probe acquisition")
        .expect("the model candidate must acquire its exact identity probe");
    assert_eq!(first_permit.auth_alias(), Some("key1"));
    assert_eq!(
        first_permit.model_id(),
        Some("gpt-test"),
        "the auth-key probe must retain the failed model identity"
    );

    let selection = tokio::spawn({
        let health = health.clone();
        let failure_session_scope = failure_session_scope.clone();
        async move {
            run_v3_plan_execution_operator_with_recovery(
                crate::execution_control::V3AttemptBudget::process_default(),
                json!({"model":"client-responses","input":"hello"}),
                &manifest,
                V3PlanExecutionTargetSource::Expanded(expanded),
                &failure_session_scope,
                &health,
                &BTreeSet::new(),
                &BTreeSet::new(),
                25_001,
                0,
                None,
                V3PlanExecutionModePolicy::RelayOnly {
                    entry_protocol: V3HubEntryProtocol::Responses,
                },
            )
            .await
        }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !selection.is_finished(),
        "auth-key cooldown must await an eligible in-flight probe"
    );
    health
        .store
        .complete_provider_cooldown_probe_success_with_permit(&first_permit, 25_001)
        .expect("successful auth-key probe");
    let selection = tokio::time::timeout(Duration::from_millis(500), selection)
        .await
        .expect("a successful auth-key probe must resume the held request")
        .expect("selection task must not panic");
    assert!(
        selection.is_ok(),
        "successful independent probe recovery must restore the held request"
    );
    assert!(
        health
            .availability("first", Some("key1"), Some("gpt-test"), 25_001)
            .unwrap()
            .available
    );
}

#[tokio::test]
async fn later_tier_selection_skips_in_flight_rescue_probes_without_waiting() {
    let server_id = "later_tier_probe";
    let mut manifest = global_pool_alive_manifest(server_id);
    set_provider_interface_base_url(
        &mut manifest,
        "first",
        "default",
        "http://127.0.0.1:1/v1".to_string(),
    );
    let mut third_provider = manifest
        .providers
        .get("second")
        .expect("second provider")
        .clone();
    set_provider_interface_base_url(
        &mut manifest,
        "second",
        "default",
        "http://third.invalid/v1".to_string(),
    );
    manifest
        .providers
        .insert("third".to_string(), third_provider);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "later-tier-session")
            .expect("failure session scope");
    let body = json!({"model":"client-responses","input":"hello"});
    let mut expanded =
        match build_v3_relay_target_candidates(&V3RelayProviderTargetResolutionInput {
            manifest: &manifest,
            server_id,
            failure_session_scope: &failure_session_scope,
            entry_kind: "responses",
            endpoint_path: "/v1/responses",
            body: &body,
            request_local_excluded_candidates: &BTreeSet::new(),
            provider_health: &health,
            now_ms: 20_001,
            deterministic_sample: 0,
        }) {
            Ok(expanded) => expanded,
            Err(_) => panic!("expanded candidates"),
        };

    let first = expanded
        .candidates
        .iter_mut()
        .find(|candidate| candidate.provider_id == "first")
        .expect("first candidate");
    let initial_pool_id = expanded
        .route
        .target_plan
        .first()
        .expect("initial target plan")
        .pool_id
        .clone();
    first.pool_ids = vec![initial_pool_id];
    let second = expanded
        .candidates
        .iter_mut()
        .find(|candidate| candidate.provider_id == "second")
        .expect("second candidate");
    second.pool_ids = vec!["fallback".to_string()];
    let mut third = second.clone();
    third.provider_id = "third".to_string();
    third.pool_ids = vec!["emergency".to_string()];
    expanded.candidates.push(third);
    let target_kind = expanded
        .route
        .target_plan
        .first()
        .expect("initial target plan")
        .target_kind
        .clone();
    expanded.route.target_plan.push(
        routecodex_v3_virtual_router::V3Router07OpaqueTargetPlanEntry {
            tier_index: 1,
            pool_id: "fallback".to_string(),
            target_index: 0,
            target_kind: target_kind.clone(),
            target_id: None,
            interface: None,
            priority: 1,
            weight: 1,
            session_sticky: false,
            direct_provider_model: Some(("second".to_string(), "gpt-test".to_string())),
        },
    );
    expanded.route.target_plan.push(
        routecodex_v3_virtual_router::V3Router07OpaqueTargetPlanEntry {
            tier_index: 2,
            pool_id: "emergency".to_string(),
            target_index: 0,
            target_kind: target_kind.clone(),
            target_id: None,
            interface: None,
            priority: 1,
            weight: 1,
            session_sticky: false,
            direct_provider_model: Some(("third".to_string(), "gpt-test".to_string())),
        },
    );
    assert_eq!(
        V3TargetInterpreter::route_tier_index_for_candidate(
            &expanded.route,
            expanded
                .candidates
                .iter()
                .find(|candidate| candidate.provider_id == "first")
                .expect("first candidate"),
        ),
        0
    );
    assert_eq!(
        V3TargetInterpreter::route_tier_index_for_candidate(
            &expanded.route,
            expanded
                .candidates
                .iter()
                .find(|candidate| candidate.provider_id == "second")
                .expect("second candidate"),
        ),
        1
    );
    assert_eq!(
        V3TargetInterpreter::route_tier_index_for_candidate(
            &expanded.route,
            expanded
                .candidates
                .iter()
                .find(|candidate| candidate.provider_id == "third")
                .expect("third candidate"),
        ),
        2
    );

    for provider_id in ["first", "second"] {
        for _ in 0..3 {
            health
                .store
                .record_provider_cooldown_failure(
                    provider_id,
                    Some("key1"),
                    Some("gpt-test"),
                    "preceding tier is cooled",
                    20_000,
                    100_000,
                )
                .expect("preceding candidate cooldown");
        }
    }

    let first_probe = acquire_rescue_probe(&health, "first", "key1", "gpt-test");
    let second_probe = acquire_rescue_probe(&health, "second", "key1", "gpt-test");

    let selection = tokio::time::timeout(
        Duration::from_millis(500),
        run_v3_plan_execution_operator_with_recovery(
            crate::execution_control::V3AttemptBudget::process_default(),
            json!({"model":"client-responses","input":"hello"}),
            &manifest,
            V3PlanExecutionTargetSource::Expanded(expanded),
            &failure_session_scope,
            &health,
            &BTreeSet::new(),
            &BTreeSet::new(),
            20_001,
            0,
            None,
            V3PlanExecutionModePolicy::RelayOnly {
                entry_protocol: V3HubEntryProtocol::Responses,
            },
        ),
    )
    .await
    .expect("preceding-tier probe must not hang");
    let Ok((_execution_planned_request, plan)) = selection else {
        panic!("a later tier must remain selectable while prior probes are in flight");
    };
    assert_eq!(plan.selected.candidate.provider_id, "third");
    for (provider_id, permit) in [("first", first_probe), ("second", second_probe)] {
        health
            .store
            .complete_provider_cooldown_probe_failure_with_permit(&permit, 20_001)
            .expect("finish the pre-existing rescue probe");
        assert!(
            !health
                .store
                .availability(provider_id, Some("key1"), Some("gpt-test"), 20_001)
                .unwrap()
                .available,
            "skipping a probe in flight must preserve the preceding candidate cooldown"
        );
    }
}

#[tokio::test]
async fn health_neutral_mixed_window_keeps_pending_probe_recovery() {
    let (
        manifest,
        health,
        failure_session_scope,
        selected,
        mut expanded,
        _selected_provider_id,
        sibling_provider_id,
    ) = mixed_policy_fixture("mixed_window_probe", "mixed-window-probe-session");
    let now_ms = v3_relay_provider_policy_now_epoch_ms().expect("current policy epoch");
    let third = expanded
        .candidates
        .iter_mut()
        .find(|candidate| candidate.provider_id == "third")
        .expect("third candidate");
    third.model_availability = Some(closed_availability_for_current_utc_minute());
    assert!(
        V3TargetInterpreter::candidate_context_fits_request(
            third,
            expanded.route.request_input_tokens,
        ),
        "the window-closed candidate must remain context-compliant"
    );
    assert!(
        !V3TargetInterpreter::candidate_in_availability_window(third, now_ms),
        "the test must construct a genuinely closed availability window"
    );

    put_identity_in_global_cooldown(&health, &sibling_provider_id, "key1", "gpt-test", now_ms);
    let b_permit = acquire_rescue_probe(&health, &sibling_provider_id, "key1", "gpt-test");

    let mut failed_candidates = BTreeSet::new();
    let mut same_candidate_retries = BTreeMap::new();
    let mut trace = Vec::new();
    let mut last_external_http = None;
    let context = V3RelayProviderFailurePolicyContext {
        manifest: &manifest,
        captured_target_09: Some(&expanded),
        failure_session_scope,
        provider_health: &health,
        attempt_budget: None,
        retry_policy: V3RelayProviderFailureRetryPolicy::default(),
        deterministic_sample: 0,
    };
    let result = run_v3_relay_provider_failure_policy(
        &context,
        selected,
        "ProviderReqCompat06ProviderCompat",
        400,
        Some("provider_request_compat_error".to_string()),
        "arguments must be valid JSON".to_string(),
        None,
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            trace: &mut trace,
            last_external_http: &mut last_external_http,
        },
    )
    .await
    .expect("mixed window failure must classify recovery");
    assert_eq!(
        result.event.action, "wait_target_recovery",
        "a closed window must not erase a pending cooldown probe"
    );
    assert!(result.terminal_projection.is_none());
    assert!(result.retry_selected.is_none());

    health
        .store
        .complete_provider_cooldown_probe_success_with_permit(&b_permit, now_ms)
        .expect("pending probe success");
    assert!(
        health
            .availability(&sibling_provider_id, Some("key1"), Some("gpt-test"), now_ms)
            .unwrap()
            .available,
        "the retained probe must still be able to recover its own identity"
    );
}

#[tokio::test]
async fn health_neutral_closed_window_does_not_forge_recovery_when_context_is_permanent() {
    let (
        manifest,
        health,
        failure_session_scope,
        selected,
        mut expanded,
        selected_provider_id,
        _sibling_provider_id,
    ) = mixed_policy_fixture("mixed_window_context", "mixed-window-context-session");
    let now_ms = v3_relay_provider_policy_now_epoch_ms().expect("current policy epoch");
    expanded.route.request_input_tokens = 100;
    for candidate in expanded
        .candidates
        .iter_mut()
        .filter(|candidate| candidate.provider_id != selected_provider_id.as_str())
    {
        candidate.max_context_tokens = Some(1);
    }
    let third = expanded
        .candidates
        .iter_mut()
        .find(|candidate| candidate.provider_id == "third")
        .expect("third candidate");
    third.model_availability = Some(closed_availability_for_current_utc_minute());
    assert!(
        !V3TargetInterpreter::candidate_context_fits_request(third, 100),
        "the window-closed candidate must also be permanently context ineligible"
    );

    let mut failed_candidates = BTreeSet::new();
    let mut same_candidate_retries = BTreeMap::new();
    let mut trace = Vec::new();
    let mut last_external_http = None;
    let context = V3RelayProviderFailurePolicyContext {
        manifest: &manifest,
        captured_target_09: Some(&expanded),
        failure_session_scope,
        provider_health: &health,
        attempt_budget: None,
        retry_policy: V3RelayProviderFailureRetryPolicy::default(),
        deterministic_sample: 0,
    };
    let result = run_v3_relay_provider_failure_policy(
        &context,
        selected.clone(),
        "ProviderReqCompat06ProviderCompat",
        400,
        Some("provider_request_compat_error".to_string()),
        "arguments must be valid JSON".to_string(),
        None,
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            trace: &mut trace,
            last_external_http: &mut last_external_http,
        },
    )
    .await
    .expect("mixed context failure must classify terminal");
    assert_eq!(
        result.event.action,
        "terminal_request_local_provider_compat_exhausted",
        "a closed window must not fabricate recovery for a context-ineligible candidate"
    );
    assert!(result.terminal_projection.is_some());
    assert!(result.retry_selected.is_none());
    assert_eq!(result.event.wait_ms, None);
}

#[tokio::test]
async fn health_neutral_permanent_context_does_not_erase_other_pending_probe() {
    let (
        manifest,
        health,
        failure_session_scope,
        selected,
        mut expanded,
        _selected_provider_id,
        sibling_provider_id,
    ) = mixed_policy_fixture("mixed_context_probe", "mixed-context-probe-session");
    let now_ms = v3_relay_provider_policy_now_epoch_ms().expect("current policy epoch");
    expanded.route.request_input_tokens = 100;
    let third = expanded
        .candidates
        .iter_mut()
        .find(|candidate| candidate.provider_id == "third")
        .expect("third candidate");
    third.max_context_tokens = Some(1);
    assert!(
        !V3TargetInterpreter::candidate_context_fits_request(third, 100),
        "the third candidate must have a permanent context restriction"
    );

    put_identity_in_global_cooldown(&health, &sibling_provider_id, "key1", "gpt-test", now_ms);
    let b_permit = acquire_rescue_probe(&health, &sibling_provider_id, "key1", "gpt-test");

    let mut failed_candidates = BTreeSet::new();
    let mut same_candidate_retries = BTreeMap::new();
    let mut trace = Vec::new();
    let mut last_external_http = None;
    let context = V3RelayProviderFailurePolicyContext {
        manifest: &manifest,
        captured_target_09: Some(&expanded),
        failure_session_scope,
        provider_health: &health,
        attempt_budget: None,
        retry_policy: V3RelayProviderFailureRetryPolicy::default(),
        deterministic_sample: 0,
    };
    let result = run_v3_relay_provider_failure_policy(
        &context,
        selected.clone(),
        "ProviderReqCompat06ProviderCompat",
        400,
        Some("provider_request_compat_error".to_string()),
        "arguments must be valid JSON".to_string(),
        None,
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            trace: &mut trace,
            last_external_http: &mut last_external_http,
        },
    )
    .await
    .expect("mixed context recovery must classify");
    assert_eq!(
        result.event.action, "wait_target_recovery",
        "one permanent context restriction must not erase another pending probe"
    );
    assert!(result.terminal_projection.is_none());
    assert!(result.retry_selected.is_none());

    health
        .store
        .complete_provider_cooldown_probe_success_with_permit(&b_permit, now_ms)
        .expect("pending probe success");
    assert!(
        health
            .availability(&sibling_provider_id, Some("key1"), Some("gpt-test"), now_ms)
            .unwrap()
            .available
    );
}

#[tokio::test]
async fn health_neutral_permanent_exclusion_survives_unrelated_probe_success() {
    let (
        manifest,
        health,
        failure_session_scope,
        selected,
        mut expanded,
        selected_provider_id,
        sibling_provider_id,
    ) = mixed_policy_fixture(
        "mixed_permanent_exclusion",
        "mixed-permanent-exclusion-session",
    );
    let now_ms = v3_relay_provider_policy_now_epoch_ms().expect("current policy epoch");
    let third = expanded
        .candidates
        .iter_mut()
        .find(|candidate| candidate.provider_id == "third")
        .expect("third candidate");
    third.model_availability = Some(closed_availability_for_current_utc_minute());

    put_identity_in_global_cooldown(&health, &sibling_provider_id, "key1", "gpt-test", now_ms);
    let b_permit = acquire_rescue_probe(&health, &sibling_provider_id, "key1", "gpt-test");

    let mut failed_candidates = BTreeSet::new();
    let mut same_candidate_retries = BTreeMap::new();
    let mut trace = Vec::new();
    let mut last_external_http = None;
    let context = V3RelayProviderFailurePolicyContext {
        manifest: &manifest,
        captured_target_09: Some(&expanded),
        failure_session_scope,
        provider_health: &health,
        attempt_budget: None,
        retry_policy: V3RelayProviderFailureRetryPolicy::default(),
        deterministic_sample: 0,
    };
    let result = run_v3_relay_provider_failure_policy(
        &context,
        selected.clone(),
        "ProviderReqCompat06ProviderCompat",
        400,
        Some("provider_request_compat_error".to_string()),
        "arguments must be valid JSON".to_string(),
        None,
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            trace: &mut trace,
            last_external_http: &mut last_external_http,
        },
    )
    .await
    .expect("mixed permanent-exclusion failure must classify recovery");
    assert_eq!(result.event.action, "wait_target_recovery");
    assert!(result.terminal_projection.is_none());

    health
        .store
        .complete_provider_cooldown_probe_success_with_permit(&b_permit, now_ms)
        .expect("unrelated pending probe success");

    // The original failed candidate stays request-locally excluded. Once the
    // pending probe recovers its own identity, the policy must switch to that
    // identity and must not reselect the excluded candidate.
    let mut failed_candidates = BTreeSet::new();
    let mut same_candidate_retries = BTreeMap::new();
    let mut trace = Vec::new();
    let mut last_external_http = None;
    let reselected = run_v3_relay_provider_failure_policy(
        &context,
        selected,
        "ProviderReqCompat06ProviderCompat",
        400,
        Some("provider_request_compat_error".to_string()),
        "arguments must be valid JSON".to_string(),
        None,
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            trace: &mut trace,
            last_external_http: &mut last_external_http,
        },
    )
    .await
    .expect("recovered alternative must be selected");
    assert_eq!(
        reselected.event.action, "switch_provider",
        "recovered alternative must be selected without clearing the permanent exclusion"
    );
    let retry = reselected
        .retry_selected
        .expect("recovered alternative must be selected");
    assert_eq!(retry.candidate.provider_id, sibling_provider_id);
    assert_ne!(retry.candidate.provider_id, selected_provider_id);
}
