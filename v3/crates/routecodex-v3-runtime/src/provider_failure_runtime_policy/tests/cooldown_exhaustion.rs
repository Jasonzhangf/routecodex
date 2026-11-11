use super::*;
use crate::hub_v1::V3HubEntryProtocol;
use crate::operation_runner::plan_execution::{
    run_v3_plan_execution_operator_with_probes, V3PlanExecutionModePolicy, V3PlanExecutionStop,
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
        run_v3_plan_execution_operator_with_probes(
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
            true,
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
                .available,
            "skipping a probe in flight must preserve the preceding candidate cooldown"
        );
    }
}

#[tokio::test]
async fn later_tier_selection_does_not_wait_for_probe_transport_admission() {
    let server_id = "later_tier_probe_transport_busy";
    let first_provider = "later_tier_busy_first";
    let mut manifest =
        global_pool_alive_manifest_with_provider_names(server_id, None, first_provider, "second");
    set_provider_interface_base_url(
        &mut manifest,
        first_provider,
        "default",
        "http://127.0.0.1:1/v1".to_string(),
    );
    manifest
        .providers
        .get_mut(first_provider)
        .expect("first provider")
        .concurrency = Some(routecodex_v3_config::V3ProviderConcurrencyAuthoringConfig {
        max_in_flight: 1,
        acquire_timeout_ms: 60_000,
        stale_lease_ms: 300_000,
    });
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope = test_provider_failure_scope(
        server_id,
        server_id,
        "later-tier-probe-transport-busy-session",
    )
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
        .find(|candidate| candidate.provider_id == first_provider)
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
            target_kind,
            target_id: None,
            interface: None,
            priority: 1,
            weight: 1,
            session_sticky: false,
            direct_provider_model: Some(("second".to_string(), "gpt-test".to_string())),
        },
    );
    health
        .store
        .record_provider_cooldown_failure(
            first_provider,
            Some("key1"),
            Some("gpt-test"),
            "preceding tier is cooled",
            20_000,
            100_000,
        )
        .expect("first provider cooldown");

    let controller = V3AdaptiveConcurrencyController::process_shared();
    let first_key = format!("{first_provider}:key1");
    controller
        .ensure_initial_budget(&first_key, 1)
        .expect("first provider concurrency budget");
    let active_business_lease = controller
        .try_acquire_business(&first_key)
        .expect("first provider busy lease");

    let selection = tokio::time::timeout(
        Duration::from_millis(500),
        run_v3_plan_execution_operator_with_probes(
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
            true,
            None,
            V3PlanExecutionModePolicy::RelayOnly {
                entry_protocol: V3HubEntryProtocol::Responses,
            },
        ),
    )
    .await
    .expect("a busy probe transport must not block later-tier selection");
    let Ok((_execution_planned_request, plan)) = selection else {
        panic!("the available later tier must remain selectable");
    };
    assert_eq!(plan.selected.candidate.provider_id, "second");
    assert!(
        !health
            .store
            .availability(first_provider, Some("key1"), Some("gpt-test"), 20_001)
            .available,
        "skipping a capacity-blocked probe must preserve provider cooldown"
    );
    controller
        .release(active_business_lease.into_permit())
        .expect("release first provider busy lease");
}
