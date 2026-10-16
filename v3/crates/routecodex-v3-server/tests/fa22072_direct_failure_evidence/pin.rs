//! Pinned single-candidate Direct Step5 known-failure evidence (fa22072 P1/P2).
//!
//! One explicit `lifeai.step-5-preview` pin serves every request. GOOD cases
//! must complete with the real business result and never write failure
//! evidence; DROP cases must terminate the client transport and record exactly
//! one provider_failure attempt plus its terminal source.
use super::*;
use crate::test_ports;
use futures_util::StreamExt;
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::Mutex;

#[tokio::test]
async fn fa22072_pinned_direct_step5_known_failure_evidence_public_entry() {
    let (home, _lock) = LOCK.lock().await;
    std::env::set_var(KEY_ENV, KEY);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let peer = listener.local_addr().unwrap().port();
    let drop_head = Arc::new(AtomicBool::new(false));
    let captures = Arc::new(Mutex::new(Vec::new()));
    let task = tokio::spawn(serve_peer(listener, drop_head.clone(), captures.clone()));
    let decoy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let decoy_port = decoy_listener.local_addr().unwrap().port();
    let decoy_captures = Arc::new(Mutex::new(Vec::new()));
    let decoy_task = tokio::spawn(serve_peer(
        decoy_listener,
        Arc::new(AtomicBool::new(false)),
        decoy_captures.clone(),
    ));
    let handle = spawn_v3_server_aggregate(manifest(test_ports::free_port(), peer, decoy_port))
        .await
        .unwrap();
    let port = handle.listeners[0].addr.port();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let mut controls = Vec::new();
    let mut diagnostics = Vec::new();
    let samples = std::path::PathBuf::from(std::env::var_os("HOME").unwrap()).join(format!(
        ".rcc/codex-samples/openai-chat-completions/ports/{port}"
    ));
    for (case, (drop, stream)) in [
        (false, false),
        (false, true),
        (true, false),
        (true, true),
        (false, false),
        (false, true),
    ]
    .into_iter()
    .enumerate()
    {
        drop_head.store(drop, Ordering::SeqCst);
        let marker = format!("OWNED_DIRECT_STEP5_CASE_{case}");
        let content = format!("Reply exactly {TEXT} {marker}");
        let before = captures.lock().await.len();
        let result = client
            .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
            .json(&json!({"model":"lifeai.step-5-preview","messages":[{"role":"user","content":content}],"stream":stream}))
            .send()
            .await;
        let mut wire = Vec::new();
        let mut completed = false;
        let mut status = None;
        if let Ok(response) = result {
            status = Some(response.status().as_u16());
            let mut body = response.bytes_stream();
            completed = true;
            while let Some(chunk) = body.next().await {
                match chunk {
                    Ok(chunk) => wire.extend_from_slice(&chunk),
                    Err(_) => {
                        completed = false;
                        break;
                    }
                }
            }
        }
        if let Err(error) = handle.wait_for_codex_sample_persistence().await {
            controls.push(format!(
                "case{case}: diagnostic worker did not drain: {error}"
            ));
        }
        let text = String::from_utf8_lossy(&wire);
        let received = captures.lock().await;
        let business: Vec<_> = received[before..]
            .iter()
            .filter(|c| c.body.to_string().contains(&marker))
            .collect();
        if business.len() != 1 {
            controls.push(format!(
                "case{case}: pinned single candidate must send exactly one business request, got {}",
                business.len()
            ));
        }
        for capture in &business {
            if capture.body["model"] != MODEL || capture.authorization != format!("Bearer {KEY}") {
                controls.push(format!(
                    "case{case}: wire model/auth was not the exact fixture pin"
                ));
            }
            let valid_shape = if capture.path.ends_with("/responses") {
                capture.body.get("input").is_some()
            } else {
                capture.path.ends_with("/chat/completions") && capture.body["messages"].is_array()
            };
            if !valid_shape {
                controls.push(format!(
                    "case{case}: selected protocol shape was invalid: {capture:?}"
                ));
            }
        }
        eprintln!("direct-step5 case{case} drop={drop} stream={stream} status={status:?} complete={completed} bytes={} captures={business:?}", wire.len());
        std::mem::drop(received);
        if drop {
            if completed
                || text.contains(TEXT)
                || text.contains("[DONE]")
                || text.contains("\"error\"")
                || text.contains(KEY)
            {
                controls.push(format!(
                    "case{case}: known pre-head drop leaked error or fabricated completion: {text}"
                ));
            }
        } else {
            if status != Some(200) || !completed || !text.contains(TEXT) || !text.contains(MODEL) {
                controls.push(format!(
                    "case{case}: real pinned Direct Step5 result did not complete: {text}"
                ));
            }
            if stream && !text.contains("[DONE]") {
                controls.push(format!("case{case}: real SSE completion missing"));
            }
            if !stream {
                let value = serde_json::from_slice::<Value>(&wire).ok();
                if !value.is_some_and(|v| {
                    v["choices"][0]["finish_reason"] == "stop" && v["usage"]["total_tokens"] == 5
                }) {
                    controls.push(format!("case{case}: genuine finish/usage missing"));
                }
            }
        }
        let dirs: Vec<_> = std::fs::read_dir(&samples)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                std::fs::read_to_string(p.join("request.json")).is_ok_and(|s| s.contains(&marker))
            })
            .collect();
        if dirs.len() != 1 {
            controls.push(format!("case{case}: no exact request-qualified sample"));
        } else if drop {
            let evidence = std::fs::read_to_string(dirs[0].join("provider-failed-attempts.json"))
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok());
            let attempt_ok = evidence.as_ref().is_some_and(|a| {
                a["attempts"].as_array().is_some_and(|attempts| {
                    attempts.len() == 1
                        && attempts[0]["diagnostic_source"]["source_kind"] == "provider_failure"
                        && attempts[0]["diagnostic_source"]["message"]
                            .as_str()
                            .is_some_and(|s| !s.is_empty() && s != "provider_error")
                        && attempts[0]["provider_status"].is_null()
                })
            });
            let terminal_ok = evidence
                .as_ref()
                .is_some_and(|a| a["terminal_source"]["source_kind"] == "provider_failure");
            if !attempt_ok || !terminal_ok {
                diagnostics.push(format!(
                    "case{case}: known Direct failure lost original typed cause: {evidence:?}"
                ));
            }
        } else if dirs[0].join("provider-failed-attempts.json").exists() {
            controls.push(format!(
                "case{case}: healthy Direct request gained failure evidence"
            ));
        }
    }
    let logs: Value = client
        .get(format!("http://127.0.0.1:{port}/_routecodex/debug/logs"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let modes: Vec<_> = logs["logs"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| {
            e["node_id"] == "V3Server03HttpRequestRaw"
                && e["details"]["path"] == "/v1/chat/completions"
        })
        .filter_map(|e| e["details"]["execution_mode"].as_str())
        .collect();
    if modes.len() != 6 || modes.iter().any(|m| *m != "direct") {
        controls.push(format!("actual entry was not Direct: {modes:?}"));
    }
    let failures = handle.shutdown().await;
    if !failures.is_empty() {
        controls.push(format!("diagnostic writer failed: {failures:?}"));
    }
    if !decoy_captures.lock().await.is_empty() {
        controls.push("explicit pin entered the unrelated default pool".into());
    }
    task.abort();
    decoy_task.abort();
    let _ = task.await;
    let _ = decoy_task.await;
    std::env::remove_var(KEY_ENV);
    drop(home);
    assert!(
        controls.is_empty(),
        "equivalent Direct public controls failed: {controls:?}"
    );
    assert!(
        diagnostics.is_empty(),
        "known Direct diagnostic RED: {diagnostics:?}"
    );
}
