//! Real public-entry regression: transport-busy early identities cannot starve a free fifth.
#[path = "support/fa22072_probe_fairness_fixture.rs"]
mod fixture;

use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use tokio::{
    net::TcpListener,
    time::{timeout, Duration},
};

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

async fn fail(port: u16, id: &str) {
    let response = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .json(&json!({"model":format!("{id}-failure"),"messages":[{"role":"user","content":"genuine failure"}],"stream":false}))
        .send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        fixture::business("recovery"),
        "a genuine first-candidate failure must recover through its declared spare"
    );
}

#[tokio::test]
async fn fifth_due_identity_recovers_while_four_sibling_transports_remain_held() {
    // The canonical parent runner isolates runtime HOME. No private health or
    // concurrency controller mutation is used by this fixture.
    std::env::set_var("FA22072_FAIRNESS_KEY", "fairness-fixture-key");
    let (peer, upstream_base, upstream) = fixture::peer().await;
    let reserved = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = reserved.local_addr().unwrap().port();
    drop(reserved);
    let (manifest, ids) = fixture::manifest(&upstream_base, port);
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::new();
    // Each failure target declares two distinct identities (the failing
    // `{id}.recovery` and the `fairness_spare` spare), so the mandated
    // multi-identity storm-avoidance hold
    // (`req-20261027-single-identity-recovery`) makes one request spend its
    // flat three seconds before the spare attempt. The budget below only has to
    // exceed that hold; independence and exactly-once counting stay asserted.
    timeout(
        Duration::from_secs(10),
        futures_util::future::join_all(ids.iter().map(|id| fail(port, id))),
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
    let before = pool(&client, &base).await;
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
    let admitted = timeout(Duration::from_secs(15), peer.fifth_entered.acquire()).await;
    let during = pool(&client, &base).await;
    eprintln!(
        "fairness held transports=4 fifth_probe_captured={} cooldown={during}",
        admitted.is_ok()
    );
    // Capacity denial must preserve failure count and the original ladder.
    // The public projection hides expired until_ms; it must never introduce a
    // new future deadline or restore a held provider's exact recovery model.
    for id in &ids[..4] {
        let earlier = exact(&before, id).unwrap();
        let current = exact(&during, id).expect("capacity-busy identity remains cooled");
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
    assert_eq!(exact(&during, &ids[4]).unwrap()["state"], "probing");
    peer.fifth_release.add_permits(1);
    timeout(Duration::from_secs(2), async {
        loop {
            if exact(&pool(&client, &base).await, &ids[4]).is_none() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("actual 2xx restores exact fifth identity");
    let response = client.post(format!("{base}/v1/chat/completions")).json(&json!({"model":format!("{}.recovery", ids[4]),"messages":[{"role":"user","content":"fifth complete"}],"stream":false})).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        fixture::business("recovery")
    );
    assert!(holders.iter().all(|holder| !holder.is_finished()));
    assert_eq!(peer.holders_release.available_permits(), 0);
    let after = pool(&client, &base).await;
    for id in &ids[..4] {
        assert_eq!(
            exact(&after, id).unwrap()["failure_count"],
            exact(&before, id).unwrap()["failure_count"]
        );
    }
    peer.holders_release.add_permits(4);
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
