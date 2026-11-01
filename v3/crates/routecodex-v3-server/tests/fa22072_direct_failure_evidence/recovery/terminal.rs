//! P6 seeded Relay terminal-failure public-entry case.

use super::*;

/// P6: seeded Relay A(503) -> B(503) exhaustion. The artifact still records the
/// ordered [A, B] and carries B's original terminal source; the client transport
/// terminates without an error payload or fabricated success.
#[tokio::test]
async fn fa22072_seeded_relay_terminal_failure_evidence_public_entry() {
    let (home, _lock) = LOCK.lock().await;
    std::env::set_var(KEY_ENV, KEY);
    let mut controls = Vec::new();
    let mut diagnostics = Vec::new();
    for stream in [false, true] {
        let case = start_http_case(
            "relay_recovery_terminal",
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
                    interface: "responses",
                    priority: Some(1),
                    reply: PeerReply::HttpError {
                        status: 503,
                        body: owned_b_503_body(),
                    },
                },
                CasePeer {
                    id: "decoy",
                    wire: "decoy-wire",
                    interface: "responses",
                    priority: None,
                    reply: PeerReply::Business {
                        text: "DECOY",
                        wire: "decoy-wire",
                    },
                },
            ],
        )
        .await;
        let label = format!("seeded-relay-terminal stream={stream}");
        let marker = format!("OWNED_RECOVERY_P6_STREAM_{stream}");
        let raw = raw_post_chat(case.port, &recovery_chat_request(&marker, stream)).await;
        let text = String::from_utf8_lossy(&raw);
        if !stream && !raw.is_empty() {
            controls.push(format!(
                "{label}: exhausted JSON transport delivered bytes: {text}"
            ));
        }
        if stream
            && (text.contains("data:")
                || text.contains("[DONE]")
                || text.contains("event: error")
                || text.contains("\"error\"")
                || text.contains(KEY)
                || text.contains("503"))
        {
            controls.push(format!(
                "{label}: exhausted SSE delivered a business/error terminal: {text}"
            ));
        }
        let counts = case.counts().await;
        let order = case.order.lock().await.clone();
        if counts != [1, 1, 0] || order != ["alpha", "beta"] {
            controls.push(format!(
                "{label}: expected A and B once each in order [alpha, beta] with decoy zero: counts={counts:?} order={order:?}"
            ));
        }
        if let Err(error) = case.barrier().await {
            controls.push(format!("{label}: diagnostic worker did not drain: {error}"));
        }
        let (_dirs, artifact) = read_case_artifact(case.port, &marker, &mut controls, &label);
        match artifact {
            Some(artifact) => {
                check_failed_wire_pair(&artifact, &marker, &mut diagnostics);
                if artifact_sources(&artifact) != expected_pair()
                    || artifact["attempts"][0]["provider_status"] != 503
                    || artifact["attempts"][1]["provider_status"] != 503
                    || artifact["terminal_source"]
                        != serde_json::to_value(expected_relay_b()).unwrap()
                {
                    diagnostics.push(format!(
                        "{label}: seeded Relay exhaustion must keep the ordered [A, B] and B's terminal source: {artifact:?}"
                    ));
                }
            }
            None => diagnostics.push(format!(
                "{label}: seeded Relay exhaustion lost its [A, B] artifact"
            )),
        }
        case.shutdown(&mut controls).await;
    }
    std::env::remove_var(KEY_ENV);
    drop(home);
    assert!(
        controls.is_empty(),
        "seeded Relay terminal controls failed: {controls:?}"
    );
    assert!(
        diagnostics.is_empty(),
        "seeded Relay terminal diagnostic RED: {diagnostics:?}"
    );
}
