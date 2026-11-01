//! P4 Direct same-protocol recovery public-entry case.

use super::*;

/// P4: Direct same-protocol recovery. Alpha answers the fixed HTTP 503 and the
/// same-protocol beta completes, so the artifact keeps exactly the one Direct A
/// source and no terminal source.
#[tokio::test]
async fn fa22072_direct_same_protocol_recovered_success_evidence_public_entry() {
    let (home, _lock) = LOCK.lock().await;
    std::env::set_var(KEY_ENV, KEY);
    let mut controls = Vec::new();
    let mut diagnostics = Vec::new();
    for stream in [false, true] {
        let case = start_http_case(
            "direct_recovery",
            &[
                CasePeer {
                    id: "alpha",
                    wire: ALPHA_WIRE,
                    interface: "openai_chat",
                    priority: Some(2),
                    reply: PeerReply::HttpError {
                        status: 503,
                        body: owned_a_503_body(),
                    },
                },
                CasePeer {
                    id: "beta",
                    wire: BETA_WIRE,
                    interface: "openai_chat",
                    priority: Some(1),
                    reply: PeerReply::Business {
                        text: B_TEXT,
                        wire: BETA_WIRE,
                    },
                },
                CasePeer {
                    id: "decoy",
                    wire: "decoy-wire",
                    interface: "openai_chat",
                    priority: Some(0),
                    reply: PeerReply::Business {
                        text: "DECOY",
                        wire: "decoy-wire",
                    },
                },
            ],
        )
        .await;
        let label = format!("direct-recovered stream={stream}");
        let marker = format!("OWNED_RECOVERY_P4_STREAM_{stream}");
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
        let order = case.order.lock().await.clone();
        if counts != [1, 1, 0] || order != ["alpha", "beta"] {
            controls.push(format!(
                "{label}: expected one A, one B and decoy zero in order [alpha, beta]: counts={counts:?} order={order:?}"
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
            "/v1/chat/completions",
            BETA_WIRE,
            &marker,
            &mut controls,
        );
        if let Err(error) = case.barrier().await {
            controls.push(format!("{label}: diagnostic worker did not drain: {error}"));
        }
        let (_dirs, artifact) = read_case_artifact(case.port, &marker, &mut controls, &label);
        match artifact {
            Some(artifact) => {
                let expected = vec![serde_json::to_value(expected_direct_a()).unwrap()];
                if artifact["object"] != "routecodex.v3.provider_failed_attempt_evidence"
                    || artifact_sources(&artifact) != expected
                    || artifact["attempts"][0]["provider_status"] != 503
                    || !artifact["terminal_source"].is_null()
                {
                    diagnostics.push(format!(
                        "{label}: Direct recovered success must keep exactly the A source: {artifact:?}"
                    ));
                }
            }
            None => diagnostics.push(format!(
                "{label}: Direct recovered success lost its A artifact"
            )),
        }
        case.shutdown(&mut controls).await;
    }
    std::env::remove_var(KEY_ENV);
    drop(home);
    assert!(
        controls.is_empty(),
        "Direct same-protocol recovery controls failed: {controls:?}"
    );
    assert!(
        diagnostics.is_empty(),
        "Direct same-protocol recovery diagnostic RED: {diagnostics:?}"
    );
}
