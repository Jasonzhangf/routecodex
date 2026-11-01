//! Attempt-zero original-source retention for the pinned Direct pin (fa22072 P3).
use super::*;
use crate::test_ports;
use futures_util::StreamExt;
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::Mutex;

/// A declared text-only pin cannot serve an image request. This existing
/// route-plan rejection must keep its original source without inventing a
/// provider attempt or escaping into the unrelated normal pool.
#[tokio::test]
async fn fa22072_direct_attempt_zero_original_source_public_entry() {
    let (home, _lock) = LOCK.lock().await;
    std::env::set_var(KEY_ENV, KEY);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let peer = listener.local_addr().unwrap().port();
    let captures = Arc::new(Mutex::new(Vec::new()));
    let task = tokio::spawn(serve_peer(
        listener,
        Arc::new(AtomicBool::new(false)),
        captures.clone(),
    ));
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
    let samples = std::path::PathBuf::from(std::env::var_os("HOME").unwrap()).join(format!(
        ".rcc/codex-samples/openai-chat-completions/ports/{port}"
    ));
    let original = serde_json::to_value(routecodex_v3_error::build_v3_error_01_source_raised(
        routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure,
        "V3Router06RoutePoolResolved",
        "v3_route_target_runtime_failure",
        "direct route lifeai.step-5-preview cannot serve this request: model lacks vision",
    ))
    .unwrap();
    let mut controls = Vec::new();
    let mut diagnostics = Vec::new();
    for (case, (image, stream)) in [(false, false), (true, false), (true, true), (false, true)]
        .into_iter()
        .enumerate()
    {
        let marker = format!("OWNED_DIRECT_ZERO_CASE_{case}");
        let content = if image {
            json!([
                {"type":"text","text":marker},
                {"type":"image_url","image_url":{"url":"https://example.invalid/owned-image.png"}}
            ])
        } else {
            json!(format!("Reply exactly {TEXT} {marker}"))
        };
        let before = captures.lock().await.len();
        let response = client
            .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
            .json(&json!({
                "model":"lifeai.step-5-preview",
                "messages":[{"role":"user","content":content}],
                "stream":stream
            }))
            .send()
            .await;
        let mut wire = Vec::new();
        let mut completed = false;
        let mut status = None;
        if let Ok(response) = response {
            status = Some(response.status().as_u16());
            completed = true;
            let mut body = response.bytes_stream();
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
        let current = &received[before..];
        if image {
            if !current.is_empty() {
                controls.push(format!(
                    "case{case}: attempt-zero request reached provider: {current:?}"
                ));
            }
            if completed
                || text.contains(TEXT)
                || text.contains("[DONE]")
                || text.contains("\"error\"")
                || text.contains(KEY)
                || text.contains("model lacks vision")
                || text.contains("v3_route_target_runtime_failure")
            {
                controls.push(format!(
                    "case{case}: attempt-zero error leaked or completed: {text}"
                ));
            }
        } else if current.len() != 1
            || current[0].body["model"] != MODEL
            || current[0].authorization != format!("Bearer {KEY}")
            || status != Some(200)
            || !completed
            || !text.contains(TEXT)
            || !text.contains(MODEL)
            || !text.contains("stop")
            || (stream && !text.contains("[DONE]"))
        {
            controls.push(format!(
                "case{case}: healthy pin control failed: {text}, {current:?}"
            ));
        }
        eprintln!("direct-zero case{case} image={image} stream={stream} complete={completed} provider_calls={} bytes={}", current.len(), wire.len());
        drop(received);
        let dirs: Vec<_> = std::fs::read_dir(&samples)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                std::fs::read_to_string(path.join("request.json"))
                    .is_ok_and(|request| request.contains(&marker))
            })
            .collect();
        if dirs.len() != 1 {
            controls.push(format!(
                "case{case}: exact request sample missing: {dirs:?}"
            ));
            continue;
        }
        let artifact = dirs[0].join("provider-failed-attempts.json");
        if image {
            let evidence = std::fs::read_to_string(artifact)
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok());
            if !evidence.as_ref().is_some_and(|value| {
                value["object"] == "routecodex.v3.provider_failed_attempt_evidence"
                    && value["attempts"] == json!([])
                    && value["terminal_source"] == original
            }) {
                diagnostics.push(format!("case{case}: exact attempt-zero source absent: {evidence:?}; expected {original}"));
            }
        } else if artifact.exists() {
            controls.push(format!(
                "case{case}: healthy request gained failure evidence"
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
        .filter(|event| {
            event["node_id"] == "V3Server03HttpRequestRaw"
                && event["details"]["path"] == "/v1/chat/completions"
        })
        .filter_map(|event| event["details"]["execution_mode"].as_str())
        .collect();
    if modes.len() != 4 || modes.iter().any(|mode| *mode != "direct") {
        controls.push(format!(
            "actual attempt-zero entry was not Direct: {modes:?}"
        ));
    }
    let failures = handle.shutdown().await;
    if !failures.is_empty() {
        controls.push(format!("owned diagnostic shutdown failed: {failures:?}"));
    }
    if !decoy_captures.lock().await.is_empty() {
        controls.push("attempt-zero pin entered unrelated default pool".into());
    }
    task.abort();
    decoy_task.abort();
    let _ = task.await;
    let _ = decoy_task.await;
    std::env::remove_var(KEY_ENV);
    drop(home);
    eprintln!("direct-zero cleanup completed");
    assert!(
        controls.is_empty(),
        "attempt-zero public controls failed: {controls:?}"
    );
    assert!(
        diagnostics.is_empty(),
        "known Direct attempt-zero diagnostic RED: {diagnostics:?}"
    );
}
