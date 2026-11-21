//! Real public-entry regression: transport-busy early identities cannot starve a free fifth.
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

static TEST_LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();

impl routecodex_v3_runtime::V3ProviderHealthObservationClock for ObservationClock {
    fn now_epoch_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

async fn pool(client: &reqwest::Client, base: &str) -> Value {
    client
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

fn exact<'a>(pool: &'a Value, id: &str) -> Option<&'a Value> {
    pool["entries"].as_array().unwrap().iter().find(|entry| {
        entry["kind"] == "probe"
            && entry["provider_id"] == id
            && entry["interface_id"] == "default"
            && entry["auth_alias"] == "key"
            && entry["model_id"] == "recovery"
    })
}

async fn fail(port: u16, id: &str, index: usize) {
    // The identity pool is selected by the plain user-turn `thinking` signal
    // plus a disjoint current-turn input-token band, so request `index` carries
    // `index` bands of filler tokens behind the marker message.
    let mut messages = vec![json!({"role":"user","content":"genuine failure"})];
    if index > 0 {
        messages.push(json!({
            "role":"user",
            "content":"pad ".repeat(index * fixture::FAIRNESS_BAND_TOKENS as usize)
        }));
    }
    let response = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .json(&json!({"model":format!("{id}-failure"),"messages":messages,"stream":false}))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body: Value = response.json().await.unwrap();
    assert_eq!(
        status, 200,
        "a genuine first-candidate failure must recover through its declared spare: {body}"
    );
    assert_eq!(
        body,
        fixture::business("recovery"),
        "a genuine first-candidate failure must recover through its declared spare"
    );
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
    let client = reqwest::Client::new();
    timeout(
        Duration::from_secs(2),
        futures_util::future::join_all(
            ids.iter()
                .enumerate()
                .map(|(index, id)| fail(port, id, index)),
        ),
    )
    .await
    .expect("real failures must recover independently");
    let captures = peer.captures.lock().await;
    for index in 0..5 {
        assert_eq!(
            captures
                .iter()
                .filter(|capture| capture["index"] == index
                    && capture["body"]["messages"][0]["content"] == "genuine failure")
                .count(),
            1
        );
    }
    assert_eq!(
        captures
            .iter()
            .filter(|capture| capture["index"] == 5
                && capture["body"]["messages"][0]["content"] == "genuine failure")
            .count(),
        5
    );
    drop(captures);
    // Each identity commits its threshold-one cooldown only after its precool
    // observation completes. Wait for its first failed recovery probe so the
    // probe-lane counter is settled before the four sibling transports start.
    clock.0.store(now + 60_000, Ordering::SeqCst);
    let mut observed = Value::Null;
    let mut settled = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline {
        let probed = peer
            .captures
            .lock()
            .await
            .iter()
            .filter(|capture| capture["body"]["messages"][0]["content"] == "ping; reply pong")
            .count();
        observed = pool(&client, &base).await;
        if probed >= ids.len()
            && ids.iter().all(|id| {
                exact(&observed, id)
                    .is_some_and(|entry| entry["failure_count"].as_u64().unwrap_or(0) >= 1)
            })
        {
            settled = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        settled,
        "every identity's recovery probe must be attempted once while the upstream is failing: {observed}"
    );
    let before = observed;
    eprintln!("fairness genuine-failure cooldown={before}");
    for id in &ids {
        assert!(
            exact(&before, id).is_some(),
            "genuine failure must cool exact model {id}"
        );
    }
    let mut holders = Vec::new();
    for id in &ids[..4] {
        let client = client.clone();
        let base = base.clone();
        let model = format!("{id}.sibling");
        holders.push(tokio::spawn(async move { client.post(format!("{base}/v1/chat/completions")).json(&json!({"model":model,"messages":[{"role":"user","content":"holder"}],"stream":false})).send().await.unwrap().json::<Value>().await.unwrap() }));
    }
    timeout(Duration::from_secs(2), peer.holders_entered.acquire_many(4))
        .await
        .unwrap()
        .unwrap()
        .forget();
    assert!(holders.iter().all(|holder| !holder.is_finished()));
    peer.ready.store(true, Ordering::SeqCst);
    clock.0.store(now + 120_000, Ordering::SeqCst);
    // The request path carries no capacity permit, so the four cooled siblings
    // are admitted on the probe lane itself instead of being denied by a held
    // business transport. Wait until they really occupy the lane.
    timeout(
        Duration::from_secs(15),
        peer.sibling_probes_entered.acquire_many(4),
    )
    .await
    .expect("the four cooled siblings must be probed on their own lane")
    .unwrap()
    .forget();
    let during = pool(&client, &base).await;
    eprintln!(
        "fairness held transports=4 fifth_probe_captured={} cooldown={during}",
        peer.fifth_entered.available_permits() == 0
    );
    // A pending probe must preserve failure count and the original ladder.
    // The public projection hides expired until_ms; it must never introduce a
    // new future deadline or restore a held provider's exact recovery model.
    for id in &ids[..4] {
        let earlier = exact(&before, id).unwrap();
        let current = exact(&during, id).expect("probe-busy identity remains cooled");
        assert_eq!(current["failure_count"], earlier["failure_count"]);
        assert!(current["until_ms"].is_null() || current["until_ms"] == earlier["until_ms"]);
    }
    assert!(!during["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["model_id"] == "sibling"));
    assert!(holders.iter().all(|holder| !holder.is_finished()));
    assert_eq!(peer.holders_release.available_permits(), 0);
    assert_eq!(
        peer.fifth_entered.available_permits(),
        0,
        "the free fifth identity must wait for a probe slot, not for a held transport"
    );
    // Free exactly one lane slot. The next probe must be the free fifth
    // identity: a fixed due prefix may not starve it behind the four siblings.
    peer.sibling_probes_release.add_permits(1);
    let admitted = timeout(Duration::from_secs(15), peer.fifth_entered.acquire()).await;
    if let Ok(permit) = admitted {
        permit.unwrap().forget();
    } else {
        handle.shutdown().await;
        for holder in holders {
            holder.abort();
            let _ = holder.await;
        }
        upstream.abort();
        let _ = upstream.await;
        panic!("fixed due-prefix starved the free fifth identity while four real sibling transports remained held");
    }
    assert_eq!(
        exact(&pool(&client, &base).await, &ids[4]).unwrap()["state"],
        "probing"
    );
    peer.fifth_release.add_permits(1);
    timeout(Duration::from_secs(2), async {
        loop {
            if exact(&pool(&client, &base).await, &ids[4])
                .is_some_and(|entry| entry["state"] == "blocked")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("an early 2xx probe must preserve the one-hour exact-identity cooldown");
    let early_pool = pool(&client, &base).await;
    let early =
        exact(&early_pool, &ids[4]).expect("the fifth identity remains cooled before expiry");
    let deadline = early["until_ms"]
        .as_u64()
        .expect("the fifth identity must expose its committed deadline");
    assert_eq!(deadline, now + 3_600_000);

    // Post-expiry matching-probe recovery is covered by the managed manual
    // public fixture. This fairness case ends after proving that the early
    // successful fifth probe cannot bypass the committed one-hour minimum.
    assert!(holders.iter().all(|holder| !holder.is_finished()));
    assert_eq!(peer.holders_release.available_permits(), 0);
    peer.holders_release.add_permits(4);
    peer.sibling_probes_release.add_permits(4);
    for holder in holders {
        assert_eq!(
            timeout(Duration::from_secs(2), holder)
                .await
                .unwrap()
                .unwrap(),
            fixture::business("sibling")
        );
    }
    handle.shutdown().await;
    upstream.abort();
    let _ = upstream.await;
}
