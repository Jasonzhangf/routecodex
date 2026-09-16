use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Notify;

#[tokio::test]
async fn completed_probe_updates_health_before_slower_probe_finishes() {
    let manifest = global_pool_alive_manifest("probe_completion_order");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    for provider_id in ["first", "second"] {
        for now_ms in 1..=3 {
            health
                .store
                .record_provider_cooldown_failure(
                    provider_id,
                    Some("key1"),
                    Some("gpt-test"),
                    "pending provider probe",
                    now_ms,
                    1,
                )
                .expect("provider cooldown setup");
        }
    }
    let fast_done = Arc::new(Notify::new());
    let release_slow = Arc::new(Notify::new());
    let running = {
        let health = health.clone();
        let fast_done = fast_done.clone();
        let release_slow = release_slow.clone();
        tokio::spawn(async move {
            health
                .run_due_provider_health_probes(u64::MAX, false, move |provider_id, _, _| {
                    let fast_done = fast_done.clone();
                    let release_slow = release_slow.clone();
                    async move {
                        if provider_id == "first" {
                            fast_done.notify_one();
                            Ok(())
                        } else {
                            release_slow.notified().await;
                            Ok(())
                        }
                    }
                })
                .await
        })
    };
    fast_done.notified().await;
    assert!(
        health
            .store
            .availability_for_session(
                &test_provider_failure_scope(
                    "probe_completion_order",
                    "probe_completion_order",
                    "session",
                )
                .expect("probe completion scope"),
                "first",
                Some("key1"),
                Some("gpt-test"),
                0,
            )
            .available,
        "a completed probe must clear its provider cooldown before slower probes finish"
    );
    release_slow.notify_one();
    running
        .await
        .expect("probe runner task must join")
        .expect("probe runner must complete");
}

#[tokio::test]
async fn failed_probe_backoff_starts_at_probe_completion_time() {
    let manifest = global_pool_alive_manifest("probe_completion_time");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    for now_ms in 1..=3 {
        health
            .store
            .record_provider_cooldown_failure(
                "first",
                Some("key1"),
                Some("gpt-test"),
                "pending provider probe",
                now_ms,
                1,
            )
            .expect("provider cooldown setup");
    }
    let completion_ms = Arc::new(AtomicU64::new(0));
    let completion_marker = completion_ms.clone();
    let started_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("test clock must follow Unix epoch")
        .as_millis() as u64;
    health
        .run_due_provider_health_probes(started_ms, false, move |_, _, _| {
            let completion_marker = completion_marker.clone();
            async move {
                tokio::time::sleep(Duration::from_millis(1_500)).await;
                let finished_ms = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("test clock must follow Unix epoch")
                    .as_millis() as u64;
                completion_marker.store(finished_ms, Ordering::Relaxed);
                Err("controlled probe failure".to_string())
            }
        })
        .await
        .expect_err("controlled probe failure must remain observable");
    let finished_ms = completion_ms.load(Ordering::Relaxed);
    assert!(
        finished_ms > started_ms + 1_000,
        "probe must have a measurable duration"
    );
    assert!(
        health
            .store
            .provider_cooldown_probe_keys_due(finished_ms + 29_000)
            .expect("probe schedule projection")
            .is_empty(),
        "failure backoff must start after probe completion, not batch start"
    );
}
