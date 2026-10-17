//! Real public-entry regression: held business transports cannot occupy probe capacity.
#[path = "support/fa22072_probe_fairness_fixture.rs"]
mod fixture;

use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
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
    let body = json!({"model":format!("{id}.recovery"),"messages":[{"role":"user","content":"genuine failure"}],"stream":false}).to_string();
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    socket.write_all(format!("POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    if let Err(error) = socket.read_to_end(&mut bytes).await {
        assert!(matches!(
            error.kind(),
            std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::UnexpectedEof
        ));
    }
    assert!(
        bytes.is_empty(),
        "genuine provider failure must close without client status/body: {bytes:?}"
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
    timeout(
        Duration::from_secs(2),
        futures_util::future::join_all(ids.iter().map(|id| fail(port, id))),
    )
    .await
    .expect("real failures must terminate independently");
    let initial = pool(&client, &base).await;
    for id in &ids {
        assert!(
            exact(&initial, id).is_none(),
            "a pinned last candidate must not cool: {initial}"
        );
        let response = client.post(format!("{base}/_routecodex/health/cooldown-pool/add"))
            .json(&json!({"provider_id":id,"interface_id":"default","auth_alias":"key","model_id":"recovery","kind":"probe","duration_ms":60000}))
            .send().await.unwrap();
        assert_eq!(response.status(), 200);
    }
    let before = pool(&client, &base).await;
    eprintln!("fairness explicit-control cooldown={before}");
    for id in &ids {
        assert!(
            exact(&before, id).is_some(),
            "manual control must seed the exact recovery identity {id}"
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
    for id in &ids {
        let response = client.post(format!("{base}/_routecodex/health/cooldown-pool/probe"))
            .json(&json!({"provider_id":id,"interface_id":"default","auth_alias":"key","model_id":"recovery"}))
            .send().await.unwrap();
        assert_eq!(response.status(), 200);
    }
    let admitted = timeout(Duration::from_secs(15), peer.fifth_entered.acquire()).await;
    let during = timeout(Duration::from_secs(2), async {
        loop {
            let current = pool(&client, &base).await;
            if ids[..4].iter().all(|id| exact(&current, id).is_none()) {
                break current;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("all four probes must progress independently of held business transports");
    eprintln!(
        "fairness held transports=4 fifth_probe_captured={} cooldown={during}",
        admitted.is_ok()
    );
    // Real 2xx probes restore recovery identities while sibling business is held.
    for id in &ids[..4] {
        assert!(exact(&during, id).is_none());
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
        panic!("held business transports prevented the fifth recovery probe");
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
    for id in &ids {
        assert!(exact(&after, id).is_none());
    }
    let captures = peer.captures.lock().await;
    for index in 0..5 {
        assert!(captures.iter().any(|capture| capture["index"] == index
            && capture["authorization"] == "Bearer fairness-fixture-key"
            && capture["body"]["model"] == "recovery"
            && capture["body"]["messages"][0]["content"] == "ping; reply pong"));
    }
    drop(captures);
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
