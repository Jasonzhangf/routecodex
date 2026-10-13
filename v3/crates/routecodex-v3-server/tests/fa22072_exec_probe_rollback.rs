//! Public retained-listener witness for reversible aggregate probe ownership.
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    sync::{mpsc, Semaphore},
    time::{timeout, Duration},
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;

fn business_payload() -> Value {
    json!({"id":"rollback-complete","object":"chat.completion","model":"test","choices":[{"index":0,"message":{"role":"assistant","content":"complete retained business payload","tool_calls":[{"id":"paired-call","type":"function","function":{"name":"fixture","arguments":"{invalid arguments preserved"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8},"tail":{"complete":[1,2,3]}})
}

struct Peer {
    captures: mpsc::UnboundedSender<Value>,
    probes: AtomicUsize,
    old_gate: Semaphore,
    old_closed: AtomicBool,
    active: AtomicUsize,
    total: AtomicUsize,
}

async fn upstream(peer: Arc<Peer>, stream: tokio::net::TcpStream) {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    assert!(reader.read_line(&mut line).await.unwrap() > 0);
    assert!(line.starts_with("POST /v1/chat/completions "), "{line}");
    let mut length = None;
    let mut auth = None;
    loop {
        line.clear();
        assert!(reader.read_line(&mut line).await.unwrap() > 0);
        if line == "\r\n" {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            length = Some(value.trim().parse::<usize>().unwrap());
        }
        if let Some(value) = lower.strip_prefix("authorization: bearer ") {
            auth = Some(value.trim().to_owned());
        }
    }
    let mut bytes = vec![0; length.expect("complete HTTP request length")];
    reader.read_exact(&mut bytes).await.unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    let auth = auth.unwrap();
    assert!(auth == "rollback-fixture-secret" || auth == "rollback-spare-secret");
    assert_eq!(body["model"], "test");
    let probe = body.to_string().contains("ping; reply pong")
        || body
            .to_string()
            .contains("Reply exactly OK. Do not call tools.");
    peer.active.fetch_add(1, Ordering::SeqCst);
    peer.total.fetch_add(1, Ordering::SeqCst);
    peer.captures
        .send(json!({"body":body,"probe":probe,"auth_alias":if auth == "rollback-fixture-secret" {"key"} else {"spare"}}))
        .unwrap();
    if probe {
        assert_eq!(
            auth, "rollback-fixture-secret",
            "exact cooled auth identity"
        );
        if peer.probes.fetch_add(1, Ordering::SeqCst) == 0 {
            // Read the exact socket after its complete authenticated request.
            // The remote response gate remains closed for its entire lifetime.
            let mut byte = [0];
            match reader.read(&mut byte).await {
                Ok(0) => eprintln!("FA22072 probe A exact socket EOF"),
                Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {
                    eprintln!(
                        "FA22072 probe A exact socket reset kind={:?} os={:?}: {error}",
                        error.kind(),
                        error.raw_os_error()
                    );
                }
                result => panic!("held probe socket did not close cleanly: {result:?}"),
            }
            peer.old_closed.store(true, Ordering::SeqCst);
            peer.active.fetch_sub(1, Ordering::SeqCst);
            return;
        }
    }
    let response = if probe {
        "actual 2xx probe; no JSON required".to_owned()
    } else {
        business_payload().to_string()
    };
    let wire = format!("HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", if probe {"text/plain"} else {"application/json"}, response.len());
    reader.get_mut().write_all(wire.as_bytes()).await.unwrap();
    reader.get_mut().shutdown().await.unwrap();
    peer.active.fetch_sub(1, Ordering::SeqCst);
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
fn entry<'a>(pool: &'a Value, provider: &str) -> &'a Value {
    identity_entry(pool, provider, "test")
}
fn identity_entry<'a>(pool: &'a Value, provider: &str, model: &str) -> &'a Value {
    pool["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["provider_id"] == provider && v["model_id"] == model && v["kind"] == "probe")
        .expect("exact identity remains visible")
}
async fn business(client: &reqwest::Client, base: &str, model: &str) -> Value {
    let prior = routecodex_v3_runtime::default_provider_transport_handoff_checkpoints();
    let response = client.post(format!("{base}/v1/chat/completions")).json(&json!({"model":model,"messages":[{"role":"user","content":"retained business"}],"stream":false})).send().await.unwrap();
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(
        body["choices"][0]["message"]["content"],
        "complete retained business payload"
    );
    assert_eq!(
        body["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"],
        "{invalid arguments preserved"
    );
    assert_eq!(body["usage"]["total_tokens"], 8);
    assert_eq!(body["id"], "rollback-complete");
    assert_eq!(
        body["choices"][0]["message"]["tool_calls"][0]["id"],
        "paired-call"
    );
    assert_eq!(
        body["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "fixture"
    );
    assert_eq!(body["tail"], json!({"complete":[1,2,3]}));
    assert_eq!(
        body,
        business_payload(),
        "complete response/tool/usage/tail fidelity"
    );
    let completed: Vec<_> = routecodex_v3_runtime::default_provider_transport_handoff_checkpoints()
        .into_iter()
        .filter(|checkpoint| !prior.iter().any(|old| old.key == checkpoint.key))
        .collect();
    eprintln!(
        "FA22072 completed public business model={model} response_id={} checkpoints={}",
        body["id"],
        serde_json::to_string(&completed).unwrap()
    );
    body
}

#[tokio::test]
async fn capacity_receipt_cannot_hide_a_detached_live_socket() {
    // This external socket has no RCC capacity lease. A capacity-only oracle
    // would accept it. The exact peer observer must still report it as live.
    let (tx, mut rx) = mpsc::unbounded_channel();
    let peer = Arc::new(Peer {
        captures: tx,
        probes: AtomicUsize::new(0),
        old_gate: Semaphore::new(0),
        old_closed: AtomicBool::new(false),
        active: AtomicUsize::new(0),
        total: AtomicUsize::new(0),
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut detached = tokio::net::TcpStream::connect(listener.local_addr().unwrap())
        .await
        .unwrap();
    let (socket, _) = listener.accept().await.unwrap();
    let observer = tokio::spawn(upstream(peer.clone(), socket));
    let body = json!({"model":"test", "messages":[{"role":"user","content":"ping; reply pong"}]})
        .to_string();
    detached.write_all(format!("POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer rollback-fixture-secret\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    assert_eq!(rx.recv().await.unwrap()["probe"], true);
    assert_eq!(peer.active.load(Ordering::SeqCst), 1);
    assert!(
        !peer.old_closed.load(Ordering::SeqCst),
        "no-capacity-lease is insufficient while the detached socket is live"
    );
    detached.shutdown().await.unwrap();
    timeout(Duration::from_secs(2), observer)
        .await
        .unwrap()
        .unwrap();
    assert!(peer.old_closed.load(Ordering::SeqCst));
    assert_eq!(peer.active.load(Ordering::SeqCst), 0);
    assert_eq!(peer.old_gate.available_permits(), 0);
}

#[derive(Clone, Copy)]
enum Exit {
    Drop,
    Cancel,
    SampleTimeout,
}

#[tokio::test]
async fn dropped_preparation_restores_due_only_owner() {
    witness(Exit::Drop).await;
}
#[tokio::test]
async fn cancelled_sample_preparation_restores_due_only_owner() {
    witness(Exit::Cancel).await;
}
#[tokio::test]
async fn sample_drain_timeout_restores_due_only_owner() {
    witness(Exit::SampleTimeout).await;
}

async fn witness(exit: Exit) {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let provider = format!("rollback_{}", NEXT.fetch_add(1, Ordering::SeqCst));
    std::env::set_var("FA22072_ROLLBACK_KEY", "rollback-fixture-secret");
    std::env::set_var("FA22072_ROLLBACK_SPARE", "rollback-spare-secret");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let peer = Arc::new(Peer {
        captures: tx,
        probes: AtomicUsize::new(0),
        old_gate: Semaphore::new(0),
        old_closed: AtomicBool::new(false),
        active: AtomicUsize::new(0),
        total: AtomicUsize::new(0),
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_base = format!("http://{}", listener.local_addr().unwrap());
    let accept_peer = peer.clone();
    let upstream_task = tokio::spawn(async move {
        let mut sockets = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                connection = listener.accept() => {
                    let (stream, _) = connection.unwrap();
                    sockets.spawn(upstream(accept_peer.clone(), stream));
                }
                joined = sockets.join_next(), if !sockets.is_empty() => { joined.unwrap().unwrap(); }
            }
        }
    });
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = hub_v1_fixture::hub_v1_server_execution("chat");
    let source = format!(
        r#"
version = 3
{declaration}
[servers.chat]
bind = "127.0.0.1"
port = {port}
routing_group = "rollback"
endpoints = ["openai_chat"]
{execution}
[providers.{provider}]
type = "openai_chat"
base_url = "{upstream_base}/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "FA22072_ROLLBACK_KEY" }}, {{ alias = "spare", env = "FA22072_ROLLBACK_SPARE" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
concurrency = {{ max_in_flight = 1, acquire_timeout_ms = 60000, stale_lease_ms = 120000 }}
[providers.{provider}.models.test]
wire_name = "test"
capabilities = ["text"]
max_context_tokens = 1000000
[providers.{provider}.models.sibling]
wire_name = "test"
capabilities = ["text"]
max_context_tokens = 1000000
[route_groups.rollback.pools.default]
targets = [{{ kind = "provider_model", provider = "{provider}", model = "test", key = "key", priority = 100 }}, {{ kind = "provider_model", provider = "{provider}", model = "sibling", key = "spare", priority = 90 }}]
[debug]
log_console = false
snapshots = true
codex_samples = true
snapshot_direct = true
"#
    );
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let client = reqwest::Client::new();
    let base = format!("http://{}", handle.listeners[0].addr);
    // Startup has already ticked before the public cooldown declaration.
    tokio::time::sleep(Duration::from_millis(100)).await;
    // A completed same-provider business record must not be mistaken for A.
    business(&client, &base, &format!("{provider}.sibling")).await;
    let add = client.post(format!("{base}/_routecodex/health/cooldown-pool/add")).json(&json!({"provider_id":provider,"interface_id":"default","auth_alias":"key","model_id":"test","kind":"probe","duration_ms":5000})).send().await.unwrap();
    assert_eq!(add.status(), 200);
    // The real later-candidate request initiates probe A without waiting for it.
    business(&client, &base, "test").await;
    timeout(Duration::from_secs(2), async {
        loop {
            if rx.recv().await.unwrap()["probe"] == true {
                break;
            }
        }
    })
    .await
    .unwrap();
    eprintln!(
        "FA22072 actual held checkpoints provider={provider}: {}",
        serde_json::to_string(
            &routecodex_v3_runtime::default_provider_transport_handoff_checkpoints()
        )
        .unwrap()
    );
    let before = pool(&client, &base).await;
    assert!(
        !peer.old_closed.load(Ordering::SeqCst),
        "live held A must fail the new socket-release oracle"
    );
    assert!(
        routecodex_v3_runtime::default_provider_transport_handoff_checkpoints()
            .iter()
            .all(|checkpoint| checkpoint.key.request_id
                != format!("provider-global-probe-{provider}")),
        "live held probe has no default broker checkpoint"
    );
    let old = entry(&before, &provider).clone();
    assert_eq!(old["state"], "probing");
    assert_eq!(old["interface_id"], "default");
    assert_eq!(old["auth_alias"], "key");
    assert_eq!(old["model_id"], "test");
    let sample_lock = if matches!(exit, Exit::Cancel | Exit::SampleTimeout) {
        handle.wait_for_codex_sample_persistence().await.unwrap();
        let path = routecodex_v3_debug::resolve_v3_codex_samples_root()
            .unwrap()
            .join(".retention.lock");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .unwrap();
        file.lock().unwrap();
        business(&client, &base, "test").await;
        Some(file)
    } else {
        None
    };
    let add_sibling = client.post(format!("{base}/_routecodex/health/cooldown-pool/add")).json(&json!({"provider_id":provider,"interface_id":"default","auth_alias":"key","model_id":"sibling","kind":"probe","duration_ms":60000})).send().await.unwrap();
    assert_eq!(add_sibling.status(), 200);
    let sibling = identity_entry(&pool(&client, &base).await, &provider, "sibling").clone();
    match exit {
        Exit::Drop => {
            let prep = handle.prepare_exec_attempt().await.unwrap();
            drop(prep);
        }
        Exit::Cancel => {
            let mut preparing = Box::pin(handle.prepare_exec_attempt());
            assert!(timeout(Duration::from_millis(150), &mut preparing)
                .await
                .is_err());
            let during = pool(&client, &base).await;
            assert_ne!(
                entry(&during, &provider)["state"],
                "probing",
                "cancel after actual quiescence"
            );
            drop(preparing);
        }
        Exit::SampleTimeout => {
            let error = handle.prepare_exec_attempt().await.unwrap_err();
            assert!(error.contains("timed out; worker retained"), "{error}");
        }
    }
    drop(sample_lock);
    timeout(Duration::from_secs(2), async {
        loop {
            let after = pool(&client, &base).await;
            if entry(&after, &provider)["state"] != "probing" {
                assert_eq!(entry(&after, &provider)["until_ms"], old["until_ms"]);
                assert_eq!(
                    entry(&after, &provider)["failure_count"],
                    old["failure_count"]
                );
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    eprintln!(
        "FA22072 actual quiesced checkpoints provider={provider}: {}",
        serde_json::to_string(
            &routecodex_v3_runtime::default_provider_transport_handoff_checkpoints()
        )
        .unwrap()
    );
    timeout(Duration::from_secs(2), async {
        while !peer.old_closed.load(Ordering::SeqCst) || peer.active.load(Ordering::SeqCst) != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("joined A must close its exact socket with the remote gate closed");
    // The declared one-slot key budget was held by A. Admission of the exact
    // scheduled B and later key business below proves release independently
    // of socket closure; the spare auth business cannot release A's key slot.
    assert!(
        routecodex_v3_runtime::default_provider_transport_handoff_checkpoints()
            .iter()
            .any(|checkpoint| checkpoint.key.provider_id == provider
                && format!("{:?}", checkpoint.state) == "Terminal"),
        "completed sibling checkpoint remains while A is released"
    );
    assert_eq!(
        peer.old_gate.available_permits(),
        0,
        "remote A gate was never released"
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        peer.probes.load(Ordering::SeqCst),
        1,
        "rollback must not repeat startup's future-due sweep"
    );
    // No recovery business is sent until the scheduled exact successor arrives.
    let scheduled = timeout(Duration::from_secs(8), async {
        loop {
            let capture = rx.recv().await.unwrap();
            if capture["probe"] == true {
                break capture;
            }
        }
    })
    .await;
    if scheduled.is_err() {
        handle.shutdown().await;
        upstream_task.abort();
        let _ = upstream_task.await;
        panic!(
            "retained aggregate lost scheduled exact-identity recovery after preparation rollback"
        );
    }
    let scheduled = scheduled.unwrap();
    assert_eq!(scheduled["body"]["model"], "test");
    eprintln!("FA22072 exact key one-slot release proven by scheduled B admission; A socket closed={} remote_gate={}", peer.old_closed.load(Ordering::SeqCst), peer.old_gate.available_permits());
    assert_eq!(
        scheduled["auth_alias"], "key",
        "one-slot exact-auth successor admitted before business"
    );
    timeout(Duration::from_secs(2), async {
        loop {
            let after = pool(&client, &base).await;
            if !after["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["provider_id"] == provider && v["model_id"] == "test")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let after_recovery = pool(&client, &base).await;
    let retained_sibling = identity_entry(&after_recovery, &provider, "sibling");
    assert_eq!(retained_sibling["until_ms"], sibling["until_ms"]);
    assert_eq!(retained_sibling["failure_count"], sibling["failure_count"]);
    assert_ne!(retained_sibling["state"], "probing");
    business(&client, &base, "test").await;
    let recovery = rx.recv().await.unwrap();
    assert_eq!(recovery["probe"], false);
    assert_eq!(
        recovery["auth_alias"], "key",
        "released one-slot exact-auth business admission"
    );
    for _ in 0..3 {
        drop(handle.prepare_exec_attempt().await.unwrap());
        business(&client, &base, "test").await;
    }
    let late_preparation = handle.prepare_exec_attempt().await.unwrap();
    handle.shutdown().await;
    drop(late_preparation);
    timeout(Duration::from_secs(2), async {
        while peer.active.load(Ordering::SeqCst) != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("terminal shutdown must leave zero owned peer transports");
    let count = peer.probes.load(Ordering::SeqCst);
    let captures = peer.total.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert_eq!(
        peer.probes.load(Ordering::SeqCst),
        count,
        "terminal shutdown must suppress late restoration"
    );
    assert_eq!(count, 2, "one old owner and one due successor only");
    assert_eq!(
        peer.total.load(Ordering::SeqCst),
        captures,
        "no new business or probe captures after terminal shutdown"
    );
    assert_eq!(peer.old_gate.available_permits(), 0);
    upstream_task.abort();
    let _ = upstream_task.await;
}
