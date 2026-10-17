//! P5 ordered-failure and P7 clean-success seeded Relay public-entry cases.

use super::*;

/// P5: seeded Relay A(chat 503) -> B(responses 503) -> C(responses business).
/// The artifact records the ordered [A, B] exactly once.
#[tokio::test]
async fn fa22072_seeded_relay_ordered_failure_evidence_public_entry() {
    let (home, _lock) = LOCK.lock().await;
    std::env::set_var(KEY_ENV, KEY);
    let mut controls = Vec::new();
    let mut diagnostics = Vec::new();
    for stream in [false, true] {
        let case = start_http_case(
            "relay_recovery",
            &[
                CasePeer {
                    id: "alpha",
                    wire: ALPHA_WIRE,
                    interface: "openai_chat",
                    priority: Some(3),
                    reply: PeerReply::HttpError {
                        status: 503,
                        body: owned_a_503_body(),
                    },
                },
                CasePeer {
                    id: "beta",
                    wire: BETA_WIRE,
                    interface: "responses",
                    priority: Some(2),
                    reply: PeerReply::HttpError {
                        status: 503,
                        body: owned_b_503_body(),
                    },
                },
                CasePeer {
                    id: "gamma",
                    wire: GAMMA_WIRE,
                    interface: "responses",
                    priority: Some(1),
                    reply: PeerReply::Business {
                        text: C_TEXT,
                        wire: GAMMA_WIRE,
                    },
                },
                CasePeer {
                    id: "decoy",
                    wire: "decoy-wire",
                    interface: "responses",
                    priority: Some(0),
                    reply: PeerReply::Business {
                        text: "DECOY",
                        wire: "decoy-wire",
                    },
                },
            ],
        )
        .await;
        let label = format!("seeded-relay-recovered stream={stream}");
        let marker = format!("OWNED_RECOVERY_P5_STREAM_{stream}");
        let (status, wire, completed) = post_chat(
            &recovery_client(),
            case.port,
            &recovery_chat_request(&marker, stream),
        )
        .await;
        check_business(
            &label,
            stream,
            status,
            &wire,
            completed,
            C_TEXT,
            GAMMA_WIRE,
            &mut controls,
        );
        let counts = case.counts().await;
        let order = case.order.lock().await.clone();
        if counts != [1, 1, 1, 0] || order != ["alpha", "beta", "gamma"] {
            controls.push(format!(
                "{label}: expected A/B/C once each in order [alpha, beta, gamma] with decoy zero: counts={counts:?} order={order:?}"
            ));
        }
        check_capture(
            &label,
            &case.captures(0).await,
            "/v1/chat/completions",
            ALPHA_WIRE,
            &marker,
            &mut controls,
        );
        check_capture(
            &label,
            &case.captures(1).await,
            "/v1/responses",
            BETA_WIRE,
            &marker,
            &mut controls,
        );
        check_capture(
            &label,
            &case.captures(2).await,
            "/v1/responses",
            GAMMA_WIRE,
            &marker,
            &mut controls,
        );
        if let Err(error) = case.barrier().await {
            controls.push(format!("{label}: diagnostic worker did not drain: {error}"));
        }
        let (_dirs, artifact) = read_case_artifact(case.port, &marker, &mut controls, &label);
        match artifact {
            Some(artifact) => {
                if artifact_sources(&artifact) != expected_pair()
                    || artifact["attempts"][0]["provider_status"] != 503
                    || artifact["attempts"][1]["provider_status"] != 503
                    || !artifact["terminal_source"].is_null()
                {
                    diagnostics.push(format!(
                        "{label}: seeded Relay success must keep the ordered [A, B] once: {artifact:?}"
                    ));
                }
            }
            None => diagnostics.push(format!(
                "{label}: seeded Relay success lost its [A, B] artifact"
            )),
        }
        case.shutdown(&mut controls).await;
    }
    std::env::remove_var(KEY_ENV);
    drop(home);
    assert!(
        controls.is_empty(),
        "seeded Relay ordered controls failed: {controls:?}"
    );
    assert!(
        diagnostics.is_empty(),
        "seeded Relay ordered diagnostic RED: {diagnostics:?}"
    );
}

/// P7: clean seeded Relay success with no preceding failure must not create any
/// failure artifact.
#[tokio::test]
async fn fa22072_seeded_relay_clean_success_omission_public_entry() {
    let (home, _lock) = LOCK.lock().await;
    std::env::set_var(KEY_ENV, KEY);
    let mut controls = Vec::new();
    let mut diagnostics = Vec::new();
    for stream in [false, true] {
        let case = start_http_case(
            "relay_recovery_clean",
            &[
                CasePeer {
                    id: "beta",
                    wire: BETA_WIRE,
                    interface: "responses",
                    priority: Some(1),
                    reply: PeerReply::Business {
                        text: B_TEXT,
                        wire: BETA_WIRE,
                    },
                },
                CasePeer {
                    id: "decoy",
                    wire: "decoy-wire",
                    interface: "responses",
                    priority: Some(0),
                    reply: PeerReply::Business {
                        text: "DECOY",
                        wire: "decoy-wire",
                    },
                },
            ],
        )
        .await;
        let label = format!("clean-relay-success stream={stream}");
        let marker = format!("OWNED_RECOVERY_P7_STREAM_{stream}");
        let (status, wire, completed) = post_chat(
            &recovery_client(),
            case.port,
            &recovery_chat_request(&marker, stream),
        )
        .await;
        check_business(
            &label,
            stream,
            status,
            &wire,
            completed,
            B_TEXT,
            BETA_WIRE,
            &mut controls,
        );
        let counts = case.counts().await;
        if counts != [1, 0] || case.order.lock().await.clone() != ["beta"] {
            controls.push(format!(
                "{label}: clean success must attempt beta once with decoy zero: counts={counts:?}"
            ));
        }
        check_capture(
            &label,
            &case.captures(0).await,
            "/v1/responses",
            BETA_WIRE,
            &marker,
            &mut controls,
        );
        if let Err(error) = case.barrier().await {
            controls.push(format!("{label}: diagnostic worker did not drain: {error}"));
        }
        let (dirs, artifact) = read_case_artifact(case.port, &marker, &mut controls, &label);
        if !dirs.is_empty() && artifact.is_some() {
            diagnostics.push(format!(
                "{label}: clean Relay success gained failure evidence"
            ));
        }
        case.shutdown(&mut controls).await;
    }
    std::env::remove_var(KEY_ENV);
    drop(home);
    assert!(
        controls.is_empty(),
        "clean Relay success controls failed: {controls:?}"
    );
    assert!(
        diagnostics.is_empty(),
        "clean Relay success diagnostic RED: {diagnostics:?}"
    );
}
