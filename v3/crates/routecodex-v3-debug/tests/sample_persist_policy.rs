use routecodex_v3_debug::{V3CodexSamplePersistJob, V3CodexSampleStore};
use serde_json::json;
use std::fs;
use std::sync::Arc;

#[tokio::test(flavor = "current_thread")]
async fn skipped_samples_do_not_displace_error_evidence() {
    let home = std::env::temp_dir().join(format!("rcc-sample-policy-{}", std::process::id()));
    fs::create_dir_all(&home).unwrap();
    let previous_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &home);
    let store = Arc::new(V3CodexSampleStore::new(true, 100, true));
    let mut handle = store.start_persist_worker().unwrap();
    // A synchronous capture burst precedes the worker's first poll. Ordinary
    // samples and excluded account errors must never occupy persistence slots.
    for index in 0..100 {
        store
            .enqueue_persist(V3CodexSamplePersistJob {
                request_id: format!("ordinary-{index}"),
                payload: Arc::new(json!({"input": "passable request"})),
                ..Default::default()
            })
            .unwrap();
        store
            .enqueue_persist(V3CodexSamplePersistJob {
                request_id: format!("quota-{index}"),
                force: true,
                status: Some(429),
                ..Default::default()
            })
            .unwrap();
    }
    store
        .enqueue_persist(V3CodexSamplePersistJob {
            request_id: "actual-error".into(),
            file_name: "error.json".into(),
            force: true,
            status: Some(502),
            payload: Arc::new(json!({"status": 502, "error": "upstream disconnected"})),
            ..Default::default()
        })
        .unwrap();
    let failures = handle.shutdown().await;
    let path = home.join(".rcc/codex-samples/openai-responses/ports/10000/actual-error/error.json");
    let saved = fs::read_to_string(&path);
    if let Some(previous) = previous_home {
        std::env::set_var("HOME", previous);
    } else {
        std::env::remove_var("HOME");
    }
    fs::remove_dir_all(&home).unwrap();
    assert!(
        failures.is_empty(),
        "skipped captures filled the queue: {failures:?}"
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&saved.unwrap()).unwrap(),
        json!({"status": 502, "error": "upstream disconnected"})
    );
}

#[test]
fn disabled_samples_need_no_worker_but_forced_errors_still_report_missing_worker() {
    let store = Arc::new(V3CodexSampleStore::new(false, 100, false));
    store
        .enqueue_persist(V3CodexSamplePersistJob::default())
        .unwrap();
    assert!(
        store.persist_failures().is_empty(),
        "disabled capture must not report a persistence failure"
    );
    store
        .enqueue_persist(V3CodexSamplePersistJob {
            force: true,
            status: Some(502),
            ..Default::default()
        })
        .unwrap();
    let failures = store.persist_failures();
    assert_eq!(failures.len(), 1);
    assert!(failures[0].reason.contains("worker is not running"));
}

#[test]
#[ignore = "diagnostic throughput experiment; no wall-clock assertion"]
fn measure_sample_persistence_throughput() {
    let home = std::env::temp_dir().join(format!("rcc-sample-throughput-{}", std::process::id()));
    fs::create_dir_all(&home).unwrap();
    let previous_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &home);
    let store = V3CodexSampleStore::new(true, 100, false);
    let payload = json!({"input": (0..12000).map(|index| json!({"role":"user", "content":format!("sample-{index}: preserve original request fields and errors")})).collect::<Vec<_>>()});
    let started = std::time::Instant::now();
    store
        .persist(
            10000,
            "responses",
            "/v1/responses",
            "throughput",
            "request.json",
            &payload,
            true,
            Some(502),
        )
        .unwrap();
    let elapsed = started.elapsed();
    let path = home.join(".rcc/codex-samples/openai-responses/ports/10000/throughput/request.json");
    let text = fs::read_to_string(path).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&text).unwrap(),
        payload
    );
    eprintln!(
        "sample persistence bytes={} elapsed_ms={:.3}",
        text.len(),
        elapsed.as_secs_f64() * 1000.0
    );
    if let Some(previous) = previous_home {
        std::env::set_var("HOME", previous);
    } else {
        std::env::remove_var("HOME");
    }
    fs::remove_dir_all(&home).unwrap();
}
