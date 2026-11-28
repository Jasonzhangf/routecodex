//! Real recovery attempts on four identities cannot starve a fifth identity.
#[path = "support/fa22072_probe_fairness_fixture.rs"]
mod fixture;
#[path = "support/fa22072_test_home.rs"]
mod test_home;

use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use tokio::{
    net::TcpListener,
    time::{timeout, Duration},
};

#[derive(Debug)]
struct ObservationClock(std::sync::atomic::AtomicU64);
impl routecodex_v3_runtime::V3ProviderHealthObservationClock for ObservationClock {
    fn now_epoch_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}
static TEST_LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();

async fn request(port: u16, index: usize, marker: &str) -> Value {
    let mut messages = vec![json!({"role":"user","content":marker})];
    if index > 0 {
        messages.push(json!({"role":"user","content":"pad ".repeat(index * fixture::FAIRNESS_BAND_TOKENS as usize)}));
    }
    let response = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .json(&json!({"model":"client","messages":messages,"stream":false}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = response.json::<Value>().await.unwrap();
    assert_eq!(body, fixture::business("recovery"));
    body
}

async fn pool(base: &str) -> Value {
    reqwest::get(format!("{base}/_routecodex/health/cooldown-pool"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test]
async fn fifth_due_identity_recovers_while_four_sibling_transports_remain_held() {
    let (_home, _lock) = TEST_LOCK.lock().await;
    std::env::set_var("FA22072_FAIRNESS_KEY", "fairness-fixture-key");
    let (peer, upstream_base, upstream) = fixture::peer().await;
    let reserved = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = reserved.local_addr().unwrap().port();
    drop(reserved);
    let (manifest, ids) = fixture::manifest(&upstream_base, port);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let clock = std::sync::Arc::new(ObservationClock(std::sync::atomic::AtomicU64::new(now)));
    let handle = routecodex_v3_server::spawn_v3_server_aggregate_with_health_observation_clock(
        manifest,
        clock.clone(),
    )
    .await
    .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    for index in 0..5 {
        for _ in 0..5 {
            request(port, index, "genuine failure").await;
        }
    }
    let before = pool(&base).await;
    assert_eq!(before["entries"].as_array().unwrap().len(), 5);
    // Advancing the health clock alone must not emit synthetic provider traffic.
    clock.0.store(now + 3_600_000, Ordering::SeqCst);
    peer.ready.store(true, Ordering::SeqCst);
    let captures_before = peer.captures.lock().await.len();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(peer.captures.lock().await.len(), captures_before);

    let mut holders = Vec::new();
    for index in 0..4 {
        holders.push(tokio::spawn(request(port, index, "genuine recovery")));
    }
    timeout(
        Duration::from_secs(3),
        peer.sibling_probes_entered.acquire_many(4),
    )
    .await
    .unwrap()
    .unwrap()
    .forget();
    let fifth = tokio::spawn(request(port, 4, "genuine recovery"));
    timeout(Duration::from_secs(3), peer.fifth_entered.acquire())
        .await
        .expect("a real fifth recovery must not wait for unrelated held trials")
        .unwrap()
        .forget();
    let during = pool(&base).await;
    for id in &ids {
        assert!(during["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["provider_id"] == *id && entry["state"] == "probing"));
    }
    assert!(holders.iter().all(|holder| !holder.is_finished()));
    // A concurrent request uses the spare without duplicating an owned trial.
    request(port, 4, "concurrent request").await;
    assert_eq!(
        peer.captures
            .lock()
            .await
            .iter()
            .filter(|capture| capture["index"] == 4
                && capture["body"]["messages"][0]["content"] == "genuine recovery")
            .count(),
        1
    );
    peer.fifth_release.add_permits(1);
    timeout(Duration::from_secs(3), fifth)
        .await
        .unwrap()
        .unwrap();
    let after = pool(&base).await;
    assert!(!after["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["provider_id"] == ids[4]));
    assert_eq!(after["entries"].as_array().unwrap().len(), 4);
    peer.sibling_probes_release.add_permits(4);
    for holder in holders {
        timeout(Duration::from_secs(3), holder)
            .await
            .unwrap()
            .unwrap();
    }
    assert!(pool(&base).await["entries"].as_array().unwrap().is_empty());
    assert!(peer
        .captures
        .lock()
        .await
        .iter()
        .all(|capture| capture["body"]["messages"][0]["content"] != "ping; reply pong"));
    handle.shutdown().await;
    upstream.abort();
    let _ = upstream.await;
    std::env::remove_var("FA22072_FAIRNESS_KEY");
}
