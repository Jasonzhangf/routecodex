//! P5 ordered-failure and P6 terminal-failure real Runtime consumer cases.

use super::*;

/// P5 Runtime consumer: the Direct producer carries A once and the receiving
/// Relay carries the authoritative ordered [A, B] exactly once, with no router
/// re-entry into the unrelated decoy.
#[tokio::test]
async fn fa22072_seeded_relay_ordered_failure_evidence_public_consumer() {
    let (home, _lock) = LOCK.lock().await;
    std::env::set_var(KEY_ENV, KEY);
    let mut diagnostics = Vec::new();
    let (alpha_listener, alpha_port) = peer_listener();
    let (beta_listener, beta_port) = peer_listener();
    let (gamma_listener, gamma_port) = peer_listener();
    let (delta_listener, delta_port) = peer_listener();
    let order: OrderLog = Arc::new(Mutex::new(Vec::new()));
    let alpha = spawn_peer(
        alpha_listener,
        "alpha",
        PeerReply::HttpError {
            status: 503,
            body: owned_a_503_body(),
        },
        false,
        order.clone(),
    );
    let beta = spawn_peer(
        beta_listener,
        "beta",
        PeerReply::HttpError {
            status: 503,
            body: owned_b_503_body(),
        },
        false,
        order.clone(),
    );
    let gamma = spawn_peer(
        gamma_listener,
        "gamma",
        PeerReply::Business {
            text: C_TEXT,
            wire: GAMMA_WIRE,
        },
        false,
        order.clone(),
    );
    let delta = spawn_peer(
        delta_listener,
        "delta",
        PeerReply::Business {
            text: "DELTA",
            wire: "delta-wire",
        },
        false,
        order.clone(),
    );
    let server_id = "relay_recovery_consumer";
    let port = test_ports::free_port();
    let plan = recovery_manifest(
        server_id,
        port,
        &[
            ProviderSpec {
                id: "alpha",
                wire: ALPHA_WIRE,
                interface: "openai_chat",
                port: alpha_port,
                priority: Some(3),
            },
            ProviderSpec {
                id: "beta",
                wire: BETA_WIRE,
                interface: "responses",
                port: beta_port,
                priority: Some(2),
            },
            ProviderSpec {
                id: "gamma",
                wire: GAMMA_WIRE,
                interface: "responses",
                port: gamma_port,
                priority: Some(1),
            },
        ],
    );
    let receiving = recovery_manifest(
        server_id,
        port,
        &[
            ProviderSpec {
                id: "alpha",
                wire: ALPHA_WIRE,
                interface: "openai_chat",
                port: alpha_port,
                priority: None,
            },
            ProviderSpec {
                id: "beta",
                wire: BETA_WIRE,
                interface: "responses",
                port: beta_port,
                priority: None,
            },
            ProviderSpec {
                id: "gamma",
                wire: GAMMA_WIRE,
                interface: "responses",
                port: gamma_port,
                priority: None,
            },
            ProviderSpec {
                id: "delta",
                wire: "delta-wire",
                interface: "responses",
                port: delta_port,
                priority: Some(1),
            },
        ],
    );
    let request_id = "owned-p5-consumer";
    let payload = recovery_chat_request("OWNED_RECOVERY_P5_CONSUMER", false);
    let (producer, _observed) =
        run_direct_producer(&plan, server_id, port, request_id, payload.clone()).await;
    let handoff = producer
        .protocol_relay_handoff
        .expect("Direct must return the selected Relay handoff");
    let handoff_sources: Vec<Value> = handoff
        .provider_failure_events
        .iter()
        .map(source_json)
        .collect();
    if handoff_sources != vec![serde_json::to_value(expected_direct_a()).unwrap()] {
        diagnostics.push(format!(
            "Direct producer must carry A exactly once before the handoff: {handoff_sources:?}"
        ));
    }
    let outcome =
        run_relay_consumer(&receiving, server_id, port, request_id, payload, handoff).await;
    if relay_ordered_sources(&outcome) != expected_pair() {
        diagnostics.push(format!(
            "seeded Relay consumer must carry the ordered [A, B] once: {:?}",
            relay_ordered_sources(&outcome)
        ));
    }
    let counts = [
        alpha.captured().await.len(),
        beta.captured().await.len(),
        gamma.captured().await.len(),
        delta.captured().await.len(),
    ];
    let actual_order = order.lock().await.clone();
    if counts != [1, 1, 1, 0] || actual_order != ["alpha", "beta", "gamma"] {
        diagnostics.push(format!(
            "seeded Relay consumer order must be [alpha, beta, gamma] with decoy zero: counts={counts:?} order={actual_order:?}"
        ));
    }
    alpha.abort().await;
    beta.abort().await;
    gamma.abort().await;
    delta.abort().await;
    std::env::remove_var(KEY_ENV);
    drop(home);
    assert!(
        diagnostics.is_empty(),
        "seeded Relay ordered consumer diagnostic RED: {diagnostics:?}"
    );
}

/// P6 Runtime consumer: the same ordered [A, B] evidence at the real consumer,
/// whether the receiving Relay projects a terminal or reports exhaustion.
#[tokio::test]
async fn fa22072_seeded_relay_terminal_failure_evidence_public_consumer() {
    let (home, _lock) = LOCK.lock().await;
    std::env::set_var(KEY_ENV, KEY);
    let mut diagnostics = Vec::new();
    let (alpha_listener, alpha_port) = peer_listener();
    let (beta_listener, beta_port) = peer_listener();
    let (delta_listener, delta_port) = peer_listener();
    let order: OrderLog = Arc::new(Mutex::new(Vec::new()));
    let alpha = spawn_peer(
        alpha_listener,
        "alpha",
        PeerReply::HttpError {
            status: 503,
            body: owned_a_503_body(),
        },
        false,
        order.clone(),
    );
    let beta = spawn_peer(
        beta_listener,
        "beta",
        PeerReply::HttpError {
            status: 503,
            body: owned_b_503_body(),
        },
        false,
        order.clone(),
    );
    let delta = spawn_peer(
        delta_listener,
        "delta",
        PeerReply::Business {
            text: "DELTA",
            wire: "delta-wire",
        },
        false,
        order.clone(),
    );
    let server_id = "relay_recovery_terminal_consumer";
    let port = test_ports::free_port();
    let plan = recovery_manifest(
        server_id,
        port,
        &[
            ProviderSpec {
                id: "alpha",
                wire: ALPHA_WIRE,
                interface: "openai_chat",
                port: alpha_port,
                priority: Some(2),
            },
            ProviderSpec {
                id: "beta",
                wire: BETA_WIRE,
                interface: "responses",
                port: beta_port,
                priority: Some(1),
            },
        ],
    );
    let receiving = recovery_manifest(
        server_id,
        port,
        &[
            ProviderSpec {
                id: "alpha",
                wire: ALPHA_WIRE,
                interface: "openai_chat",
                port: alpha_port,
                priority: None,
            },
            ProviderSpec {
                id: "beta",
                wire: BETA_WIRE,
                interface: "responses",
                port: beta_port,
                priority: None,
            },
            ProviderSpec {
                id: "delta",
                wire: "delta-wire",
                interface: "responses",
                port: delta_port,
                priority: Some(1),
            },
        ],
    );
    let request_id = "owned-p6-consumer";
    let payload = recovery_chat_request("OWNED_RECOVERY_P6_CONSUMER", false);
    let (producer, _observed) =
        run_direct_producer(&plan, server_id, port, request_id, payload.clone()).await;
    let handoff = producer
        .protocol_relay_handoff
        .expect("Direct must return the selected Relay handoff");
    let outcome =
        run_relay_consumer(&receiving, server_id, port, request_id, payload, handoff).await;
    if relay_ordered_sources(&outcome) != expected_pair() {
        diagnostics.push(format!(
            "seeded Relay terminal consumer must carry the ordered [A, B] once: {:?}",
            relay_ordered_sources(&outcome)
        ));
    }
    let counts = [
        alpha.captured().await.len(),
        beta.captured().await.len(),
        delta.captured().await.len(),
    ];
    let actual_order = order.lock().await.clone();
    if counts != [1, 1, 0] || actual_order != ["alpha", "beta"] {
        diagnostics.push(format!(
            "seeded Relay terminal consumer order must be [alpha, beta] with decoy zero: counts={counts:?} order={actual_order:?}"
        ));
    }
    alpha.abort().await;
    beta.abort().await;
    delta.abort().await;
    std::env::remove_var(KEY_ENV);
    drop(home);
    assert!(
        diagnostics.is_empty(),
        "seeded Relay terminal consumer diagnostic RED: {diagnostics:?}"
    );
}
