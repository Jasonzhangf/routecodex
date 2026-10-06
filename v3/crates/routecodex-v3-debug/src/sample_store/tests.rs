
use super::*;
use serde_json::json;
use std::fs::Permissions;

static TEST_HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn with_test_home(f: impl FnOnce(&std::path::Path)) {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let _guard = TEST_HOME_LOCK.lock().unwrap_or_else(|err| err.into_inner());
    let seq = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let base = std::env::temp_dir().join(format!(
        "v3-codex-sample-store-test-{}-{}",
        std::process::id(),
        seq
    ));
    let _ = fs::remove_dir_all(&base);
    let home = base.join("home");
    fs::create_dir_all(&home).unwrap();
    let previous = std::env::var_os("HOME");
    std::env::set_var("HOME", &home);
    f(&base);
    if let Some(previous) = previous {
        std::env::set_var("HOME", previous);
    } else {
        std::env::remove_var("HOME");
    }
    let _ = fs::remove_dir_all(&base);
}

fn with_test_home_async<F, Fut>(f: F)
where
    F: Send + 'static + FnOnce(&std::path::Path) -> Fut,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let _guard = TEST_HOME_LOCK.lock().unwrap_or_else(|err| err.into_inner());
    let seq = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let base = std::env::temp_dir().join(format!(
        "v3-codex-sample-store-async-test-{}-{}",
        std::process::id(),
        seq
    ));
    let _ = fs::remove_dir_all(&base);
    let home = base.join("home");
    fs::create_dir_all(&home).unwrap();
    let previous = std::env::var_os("HOME");
    std::env::set_var("HOME", &home);
    let previous_home = previous;
    let cleanup_base = base.clone();
    std::thread::spawn(move || tokio::runtime::Runtime::new().unwrap().block_on(f(&base)))
        .join()
        .unwrap();
    if let Some(previous) = previous_home {
        std::env::set_var("HOME", previous);
    } else {
        std::env::remove_var("HOME");
    }
    let _ = fs::remove_dir_all(cleanup_base);
}

fn sample_dir(home_base: &std::path::Path) -> std::path::PathBuf {
    home_base
        .join("home")
        .join(".rcc")
        .join("codex-samples")
        .join("openai-responses")
        .join("ports")
        .join("10000")
}

#[test]
fn persist_writes_verbatim_sample_when_enabled() {
    with_test_home(|home_base| {
        let store = V3CodexSampleStore::new(true, V3_CODEX_SAMPLE_REQUEST_RETENTION, false);
        let payload =
            json!({"model": "deepseek-v4-flash", "input": [{"role": "user", "content": "hello"}]});
        store
            .persist(
                10000,
                "responses",
                "/v1/responses",
                "req-1",
                "request.json",
                &payload,
                false,
                None,
            )
            .unwrap();
        let path = sample_dir(home_base).join("req-1").join("request.json");
        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains("deepseek-v4-flash"));
        assert!(written.contains("hello"));
        assert!(!written.contains("ROUTECODEX_DEBUG"));
    });
}

#[test]
fn persist_merges_distinct_provider_snapshot_attempts_without_duplicates() {
    with_test_home(|home_base| {
        let store = V3CodexSampleStore::new(true, V3_CODEX_SAMPLE_REQUEST_RETENTION, false);
        let first = json!({
            "object": "routecodex.v3.provider_request_snapshots",
            "stage": "provider-request",
            "attempts": [{"attempt": 1, "request": {"providerId": "opencode-go"}}]
        });
        let second = json!({
            "object": "routecodex.v3.provider_request_snapshots",
            "stage": "provider-request",
            "attempts": [{"attempt": 1, "request": {"providerId": "opencode-go-zen"}}]
        });
        store
            .persist(
                10000,
                "responses",
                "/v1/responses",
                "req-merge",
                "provider-request.json",
                &first,
                false,
                None,
            )
            .unwrap();
        store
            .persist(
                10000,
                "responses",
                "/v1/responses",
                "req-merge",
                "provider-request.json",
                &second,
                false,
                None,
            )
            .unwrap();
        store
            .persist(
                10000,
                "responses",
                "/v1/responses",
                "req-merge",
                "provider-request.json",
                &second,
                false,
                None,
            )
            .unwrap();
        let path = sample_dir(home_base)
            .join("req-merge")
            .join("provider-request.json");
        let written: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(written["attempts"].as_array().unwrap().len(), 2);
        assert_eq!(
            written["attempts"][0]["request"]["providerId"],
            "opencode-go"
        );
        assert_eq!(
            written["attempts"][1]["request"]["providerId"],
            "opencode-go-zen"
        );
    });
}

#[test]
fn persist_skips_when_disabled_without_force() {
    with_test_home(|home_base| {
        let store = V3CodexSampleStore::new(false, V3_CODEX_SAMPLE_REQUEST_RETENTION, false);
        store
            .persist(
                10000,
                "responses",
                "/v1/responses",
                "req-1",
                "request.json",
                &json!({"a": 1}),
                false,
                None,
            )
            .unwrap();
        assert!(!sample_dir(home_base).join("req-1").exists());
    });
}

#[test]
fn persist_forces_error_evidence_when_disabled() {
    with_test_home(|home_base| {
        let store = V3CodexSampleStore::new(false, V3_CODEX_SAMPLE_REQUEST_RETENTION, false);
        store
            .persist(
                10000,
                "responses",
                "/v1/responses",
                "req-1",
                "error.json",
                &json!({"status": 502}),
                true,
                Some(502),
            )
            .unwrap();
        let path = sample_dir(home_base).join("req-1").join("error.json");
        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains("502"));
    });
}

#[test]
fn persist_skips_error_sample_for_skipped_status_even_when_forced() {
    with_test_home(|home_base| {
        let store = V3CodexSampleStore::new(false, V3_CODEX_SAMPLE_REQUEST_RETENTION, false);
        store
            .persist(
                10000,
                "responses",
                "/v1/responses",
                "req-1",
                "error.json",
                &json!({"status": 503}),
                true,
                Some(503),
            )
            .unwrap();
        assert!(
            !sample_dir(home_base).join("req-1").exists(),
            "skipped account/quota error status must not be persisted"
        );
        store
            .persist(
                10000,
                "responses",
                "/v1/responses",
                "req-2",
                "error.json",
                &json!({"status": 502}),
                true,
                Some(502),
            )
            .unwrap();
        assert!(
            sample_dir(home_base)
                .join("req-2")
                .join("error.json")
                .exists(),
            "non-skipped error status must still be persisted"
        );
    });
}

#[test]
fn persist_skips_normal_sample_when_error_samples_only() {
    with_test_home(|home_base| {
        let store = V3CodexSampleStore::new(true, V3_CODEX_SAMPLE_REQUEST_RETENTION, true);
        store
            .persist(
                10000,
                "responses",
                "/v1/responses",
                "req-1",
                "request.json",
                &json!({"a": 1}),
                false,
                None,
            )
            .unwrap();
        assert!(
            !sample_dir(home_base).join("req-1").exists(),
            "normal sample must not be persisted when error_samples_only"
        );
        store
            .persist(
                10000,
                "responses",
                "/v1/responses",
                "req-2",
                "error.json",
                &json!({"status": 500}),
                true,
                Some(500),
            )
            .unwrap();
        assert!(
            sample_dir(home_base)
                .join("req-2")
                .join("error.json")
                .exists(),
            "error evidence must still be persisted when error_samples_only"
        );
        store
            .persist(
                10000,
                "responses",
                "/v1/responses",
                "req-3",
                "error.json",
                &json!({"status": 400}),
                true,
                Some(400),
            )
            .unwrap();
        assert!(
            sample_dir(home_base)
                .join("req-3")
                .join("error.json")
                .exists(),
            "provider 400 error evidence must be persisted"
        );
    });
}

#[test]
fn retention_caps_samples_at_configured_limit() {
    with_test_home(|home_base| {
        let store = V3CodexSampleStore::new(true, V3_CODEX_SAMPLE_REQUEST_RETENTION, false);
        for index in 0..=V3_CODEX_SAMPLE_REQUEST_RETENTION {
            store
                .persist(
                    10000,
                    "responses",
                    "/v1/responses",
                    &format!("req-{index}"),
                    "request.json",
                    &json!({"n": index}),
                    true,
                    Some(502),
                )
                .unwrap();
        }
        let dirs = fs::read_dir(sample_dir(home_base)).unwrap().count();
        assert_eq!(dirs, V3_CODEX_SAMPLE_REQUEST_RETENTION);
    });
}

#[test]
fn retention_caps_samples_across_endpoints_and_ports() {
    with_test_home(|home_base| {
        let store = V3CodexSampleStore::new(true, V3_CODEX_SAMPLE_REQUEST_RETENTION, false);
        for index in 0..=V3_CODEX_SAMPLE_REQUEST_RETENTION {
            let (protocol, endpoint, port) = if index % 2 == 0 {
                ("responses", "/v1/responses", 10000)
            } else {
                ("openai_chat", "/v1/chat/completions", 5520)
            };
            store
                .persist(
                    port,
                    protocol,
                    endpoint,
                    &format!("req-{index}"),
                    "request.json",
                    &json!({"n": index}),
                    true,
                    Some(502),
                )
                .unwrap();
        }
        let root = home_base.join("home").join(".rcc").join("codex-samples");
        let total_dirs = fs::read_dir(&root)
            .unwrap()
            .filter(|entry| entry.as_ref().unwrap().file_type().unwrap().is_dir())
            .flat_map(|endpoint| {
                let ports = endpoint.unwrap().path().join("ports");
                fs::read_dir(ports)
                    .unwrap()
                    .flat_map(|port| fs::read_dir(port.unwrap().path()).unwrap())
                    .collect::<Vec<_>>()
            })
            .count();
        assert_eq!(total_dirs, V3_CODEX_SAMPLE_REQUEST_RETENTION);
    });
}

#[test]
fn endpoint_dir_mapping_is_stable() {
    assert_eq!(
        format_v3_codex_sample_endpoint_dir("responses", "/v1/responses"),
        "openai-responses"
    );
    assert_eq!(
        format_v3_codex_sample_endpoint_dir("openai_chat", "/v1/chat/completions"),
        "openai-chat-completions"
    );
    assert_eq!(
        format_v3_codex_sample_endpoint_dir("anthropic", "/v1/messages"),
        "anthropic-messages"
    );
    assert_eq!(
        format_v3_codex_sample_endpoint_dir(
            "gemini",
            "/v1beta/models/gemini-2.0-flash:generateContent"
        ),
        "gemini-generate-content"
    );
}

#[test]
fn unknown_request_id_encodes_to_unknown() {
    assert_eq!(encode_v3_codex_sample_path_segment("///"), "unknown");
    assert_eq!(
        encode_v3_codex_sample_path_segment("router-gpt-5.6-sol-20260810T223407524-738231-8043"),
        "router-gpt-5.6-sol-20260810T223407524-738231-8043"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn persist_async_worker_writes_without_business_thread_file_io() {
    with_test_home_async(|home_base| {
        let home_base = home_base.to_path_buf();
        Box::pin(async move {
            let store = Arc::new(V3CodexSampleStore::new(
                true,
                V3_CODEX_SAMPLE_REQUEST_RETENTION,
                false,
            ));
            let mut handle = store
                .start_persist_worker()
                .expect("persist worker should start");
            store
                .enqueue_persist(V3CodexSamplePersistJob {
                    port: 10000,
                    entry_protocol: "responses".to_string(),
                    endpoint: "/v1/responses".to_string(),
                    request_id: "req-async".to_string(),
                    file_name: "request.json".to_string(),
                    payload: Arc::new(json!({"hello": "async"})),
                    force: false,
                    status: None,
                })
                .expect("queued sample should be accepted");
            let _ = store.enqueue_persist(V3CodexSamplePersistJob {
                port: 10000,
                entry_protocol: "responses".to_string(),
                endpoint: "/v1/responses".to_string(),
                request_id: "req-after-stop".to_string(),
                file_name: "request.json".to_string(),
                payload: Arc::new(json!({"hello": "after-stop"})),
                force: false,
                status: None,
            });
            handle.shutdown().await;
            let path = sample_dir(&home_base)
                .join("req-async")
                .join("request.json");
            assert!(fs::read_to_string(path).unwrap().contains("async"));
            let after_stop_path = sample_dir(&home_base)
                .join("req-after-stop")
                .join("request.json");
            assert!(
                fs::read_to_string(after_stop_path)
                    .unwrap()
                    .contains("after-stop"),
                "accepted jobs must drain after stop"
            );
        })
    })
}

#[tokio::test(flavor = "current_thread")]
async fn persist_async_worker_records_explicit_failure_terminal() {
    with_test_home_async(|home_base| {
        let home_base = home_base.to_path_buf();
        Box::pin(async move {
            let store = Arc::new(V3CodexSampleStore::new(
                true,
                V3_CODEX_SAMPLE_REQUEST_RETENTION,
                false,
            ));
            fs::create_dir_all(sample_dir(&home_base)).unwrap();
            fs::set_permissions(sample_dir(&home_base), Permissions::from_mode(0o555)).unwrap();
            let mut handle = store
                .start_persist_worker()
                .expect("persist worker should start");
            store
                .enqueue_persist(V3CodexSamplePersistJob {
                    port: 10000,
                    entry_protocol: "responses".to_string(),
                    endpoint: "/v1/responses".to_string(),
                    request_id: "req-fail".to_string(),
                    file_name: "request.json".to_string(),
                    payload: Arc::new(json!({"hello": "failure"})),
                    force: false,
                    status: None,
                })
                .expect("queued sample should be accepted");
            let failures = handle.shutdown().await;
            assert_eq!(
                failures.len(),
                1,
                "persist worker failure terminal must not be silent"
            );
            assert_eq!(
                failures[0].request_id, "req-fail",
                "persist failure terminal must identify the request"
            );
            let failure_reason = failures[0].reason.to_ascii_lowercase();
            assert!(
                failure_reason.contains("create") || failure_reason.contains("permission denied")
            );
            assert!(
                handle.persist_failures().is_empty(),
                "shutdown must take ownership of the residual failure ledger"
            );
            let _ = fs::set_permissions(sample_dir(&home_base), Permissions::from_mode(0o755));
        })
    })
}

#[tokio::test(flavor = "current_thread")]
async fn persist_async_worker_keeps_every_sample_under_burst() {
    with_test_home_async(|home_base| {
        let home_base = home_base.to_path_buf();
        Box::pin(async move {
            const BURST: usize = 512;
            let store = Arc::new(V3CodexSampleStore::new(true, BURST, false));
            // Hold the persistence guard so the worker cannot drain while the
            // burst is enqueued: this reproduces the observed overload window.
            let persist_guard =
                lock_v3_codex_sample_filesystem(&resolve_v3_codex_samples_root().unwrap()).unwrap();
            let mut handle = store
                .start_persist_worker()
                .expect("persist worker should start");
            for index in 0..BURST {
                store
                    .enqueue_persist(V3CodexSamplePersistJob {
                        port: 10000,
                        entry_protocol: "responses".to_string(),
                        endpoint: "/v1/responses".to_string(),
                        request_id: format!("req-burst-{index}"),
                        file_name: "request.json".to_string(),
                        payload: Arc::new(json!({"hello": index})),
                        force: false,
                        status: None,
                    })
                    .expect("a diagnostic burst must never reject the business request");
            }
            drop(persist_guard);

            let failures = handle.shutdown().await;
            assert!(
                    failures.is_empty(),
                    "a full-sampling burst within the byte-and-overhead budget must not drop any diagnostic write: {failures:?}"
                );
            assert!(handle.persist_failures().is_empty());
            for index in 0..BURST {
                let path = sample_dir(&home_base)
                    .join(format!("req-burst-{index}"))
                    .join("request.json");
                assert!(path.exists(), "burst sample {index} must be persisted");
            }
        })
    })
}

#[tokio::test(flavor = "current_thread")]
async fn persist_async_worker_bounds_tiny_payload_job_count_by_fixed_overhead() {
    with_test_home_async(|_| {
        Box::pin(async move {
            let max_by_overhead = V3_CODEX_SAMPLE_PERSIST_QUEUE_BYTE_BUDGET as usize
                / V3_CODEX_SAMPLE_PERSIST_JOB_OVERHEAD_BYTES as usize;
            let store = Arc::new(V3CodexSampleStore::new(true, max_by_overhead, false));
            let persist_guard =
                lock_v3_codex_sample_filesystem(&resolve_v3_codex_samples_root().unwrap()).unwrap();
            let handle = store
                .start_persist_worker()
                .expect("persist worker should start");
            for index in 0..=max_by_overhead {
                store
                    .enqueue_persist(V3CodexSamplePersistJob {
                        port: 10000,
                        entry_protocol: "responses".to_string(),
                        endpoint: "/v1/responses".to_string(),
                        request_id: format!("req-tiny-{index}"),
                        file_name: "request.json".to_string(),
                        payload: Arc::new(json!({"tiny": index})),
                        force: false,
                        status: None,
                    })
                    .expect(
                        "fixed-overhead budget exhaustion must not reject the business request",
                    );
            }
            let failures = store.persist_failure_snapshot();
            assert!(
                failures
                    .iter()
                    .any(|failure| failure.reason.contains("64 MiB persistence budget")),
                "tiny-payload bursts must be bounded by the fixed per-job overhead: {failures:?}"
            );
            drop(persist_guard);
            // Keep the worker and guard held until task cancellation: this assertion
            // covers admission bounded by fixed overhead, not filesystem drain.
            drop(handle);
        })
    });
}

#[tokio::test(flavor = "current_thread")]
async fn persist_async_worker_rejects_payload_over_byte_budget() {
    let store = Arc::new(V3CodexSampleStore::new(
        true,
        V3_CODEX_SAMPLE_REQUEST_RETENTION,
        false,
    ));
    let mut handle = store
        .start_persist_worker()
        .expect("persist worker should start");
    let payload = Arc::new(json!({
        "payload": "x".repeat(
            V3_CODEX_SAMPLE_PERSIST_QUEUE_BYTE_BUDGET as usize
                - V3_CODEX_SAMPLE_PERSIST_JOB_OVERHEAD_BYTES as usize
                + 1
        )
    }));

    store
        .enqueue_persist(V3CodexSamplePersistJob {
            request_id: "req-byte-budget".to_string(),
            payload,
            ..V3CodexSamplePersistJob::default()
        })
        .expect("sample byte-budget exhaustion must not reject the business request");

    handle
        .quiesce_for_exec()
        .await
        .expect("reported diagnostic budget failures must not deny exec drain");

    let failures = handle.shutdown().await;
    assert!(failures.iter().any(|failure| {
        failure.request_id == "req-byte-budget"
            && failure.reason.contains("64 MiB persistence budget")
    }));
}

#[tokio::test(flavor = "current_thread")]
async fn persist_exec_cutoff_drains_cancels_and_resumes_without_second_worker() {
    with_test_home_async(|home_base| {
        let home_base = home_base.to_path_buf();
        Box::pin(async move {
            let store = Arc::new(V3CodexSampleStore::new(true, 100, false));
            let mut worker = store.start_persist_worker().unwrap();
            let filesystem_guard =
                lock_v3_codex_sample_filesystem(&resolve_v3_codex_samples_root().unwrap()).unwrap();
            for index in 0..32 {
                store
                    .enqueue_persist(V3CodexSamplePersistJob {
                        request_id: format!("accepted-{index}"),
                        payload: Arc::new(
                            json!({"accepted": index, "complete": "x".repeat(32768)}),
                        ),
                        ..V3CodexSamplePersistJob::default()
                    })
                    .unwrap();
            }
            let mut preparation = Box::pin(worker.quiesce_for_exec());
            std::future::poll_fn(|context| {
                use std::future::Future;
                assert!(preparation.as_mut().poll(context).is_pending());
                std::task::Poll::Ready(())
            })
            .await;
            store
                .enqueue_persist(V3CodexSamplePersistJob {
                    request_id: "refused-during-cancelled-drain".into(),
                    ..V3CodexSamplePersistJob::default()
                })
                .unwrap();
            drop(preparation);
            store
                .enqueue_persist(V3CodexSamplePersistJob {
                    request_id: "accepted-after-cancel".into(),
                    ..V3CodexSamplePersistJob::default()
                })
                .unwrap();
            drop(filesystem_guard);
            let preparation = worker.quiesce_for_exec().await.unwrap();
            assert!(store.start_persist_worker().is_err());
            assert!(worker.quiesce_for_exec().await.is_err());
            for index in 0..32 {
                let path = sample_dir(&home_base)
                    .join(format!("accepted-{index}"))
                    .join("request.json");
                let payload: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
                assert_eq!(payload["accepted"], index);
                assert_eq!(payload["complete"].as_str().unwrap().len(), 32768);
            }
            assert!(sample_dir(&home_base)
                .join("accepted-after-cancel/request.json")
                .exists());
            assert!(!sample_dir(&home_base)
                .join("refused-during-cancelled-drain")
                .exists());
            store
                .enqueue_persist(V3CodexSamplePersistJob {
                    request_id: "refused-during-held-preparation".into(),
                    ..V3CodexSamplePersistJob::default()
                })
                .unwrap();
            drop(preparation);
            store
                .enqueue_persist(V3CodexSamplePersistJob {
                    request_id: "accepted-after-rejection".into(),
                    ..V3CodexSamplePersistJob::default()
                })
                .unwrap();
            let preparation = worker.quiesce_for_exec().await.unwrap();
            assert!(sample_dir(&home_base)
                .join("accepted-after-rejection/request.json")
                .exists());
            drop(preparation);
            let failures = worker.shutdown().await;
            assert_eq!(failures.len(), 2, "{failures:?}");
            assert!(failures
                .iter()
                .all(|failure| failure.reason.contains("exec preparation")));
        })
    });
}

#[tokio::test(flavor = "current_thread")]
async fn persist_failure_barrier_keeps_ledger_when_reply_receiver_is_dropped() {
    let store = Arc::new(V3CodexSampleStore::new(
        true,
        V3_CODEX_SAMPLE_REQUEST_RETENTION,
        false,
    ));
    record_v3_codex_sample_persist_failure(
        &store,
        "req-barrier".to_string(),
        "request.json".to_string(),
        "disk full".to_string(),
    );
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    let (reply, reply_receiver) = tokio::sync::oneshot::channel();
    drop(reply_receiver);
    sender
        .send(V3CodexSamplePersistQueueMessage::Barrier { reply })
        .expect("barrier should be queued");
    drop(sender);

    run_v3_codex_sample_persist_worker(Arc::clone(&store), receiver).await;

    let failures = store.persist_failures();
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].request_id, "req-barrier");
}

#[test]
fn persist_failure_ledger_bounds_records_and_summarizes_overflow() {
    let mut ledger = V3CodexSamplePersistFailureLedger::default();
    for index in 0..(V3_CODEX_SAMPLE_PERSIST_FAILURE_LIMIT + 3) {
        ledger.record(V3CodexSamplePersistFailure {
            request_id: format!("req-{index}"),
            file_name: "request.json".to_string(),
            reason: "disk full".to_string(),
        });
    }

    let failures = ledger.snapshot();
    assert_eq!(failures.len(), V3_CODEX_SAMPLE_PERSIST_FAILURE_LIMIT + 1);
    assert!(failures.last().unwrap().reason.contains("3 additional"));
    assert_eq!(
        ledger.take().len(),
        V3_CODEX_SAMPLE_PERSIST_FAILURE_LIMIT + 1
    );
    assert!(ledger.snapshot().is_empty());
}
