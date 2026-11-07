//! Supplemental resource witness. Health changes come only from the real
//! Direct consumer's HTTP failures; controller and manager access is read-only.
use super::*;
use crate::{
    build_v3_server_03_http_request_raw_with_purpose_and_scope,
    execute_v3_direct_runtime_kernel_core, V3ChatDirectCodec, V3RequestPurpose,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use serde_json::json;
use std::sync::Arc;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    time::timeout,
};

#[path = "../tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;

struct Peer {
    holder_entered: Semaphore,
    holder_release: Semaphore,
    probe_entered: Semaphore,
    probe_release: Semaphore,
}

async fn serve(mut socket: TcpStream, peer: Arc<Peer>) {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        head.push(socket.read_u8().await.unwrap());
    }
    let head = String::from_utf8(head).unwrap();
    let length: usize = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().unwrap())
        })
        .unwrap();
    assert!(head
        .to_lowercase()
        .contains("authorization: bearer runtime-fairness-fixture"));
    let mut bytes = vec![0; length];
    socket.read_exact(&mut bytes).await.unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    eprintln!("focused fairness actual HTTP: {head} body={body}");
    let marker = body["messages"][0]["content"].as_str().unwrap();
    if marker == "holder" {
        assert_eq!(body["model"], "sibling");
        peer.holder_entered.add_permits(1);
        peer.holder_release.acquire().await.unwrap().forget();
    }
    if marker == "ping; reply pong" {
        assert_eq!(body["model"], "recovery");
        let request_path = head
            .lines()
            .next()
            .and_then(|line| line.split(' ').nth(1))
            .unwrap();
        assert!(request_path.ends_with("/v1/chat/completions"));
        peer.probe_entered.add_permits(1);
        // Cancellation is observable without releasing the remote response.
        let mut byte = [0];
        tokio::select! {
            permit = peer.probe_release.acquire() => permit.unwrap().forget(),
            _ = socket.read(&mut byte) => return,
        }
    }
    let (status, body) = if marker == "genuine failure" && !head.starts_with("POST /fallback/") {
        (
            "403 Forbidden",
            json!({"error":{"message":"real focused failure"}}),
        )
    } else {
        (
            "200 OK",
            json!({"id":"focused-fairness","object":"chat.completion","model":body["model"],"choices":[{"index":0,"message":{"role":"assistant","content":"complete"},"finish_reason":"stop"}]}),
        )
    };
    let body = body.to_string();
    socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}

fn manifest(base: &str, port: u16) -> (V3Config05ManifestPublished, Vec<String>) {
    let ids: Vec<_> = (0..5)
        .map(|index| format!("focused_fairness_{port}_{index}"))
        .collect();
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = hub_v1_fixture::hub_v1_server_execution("chat");
    let mut source = format!(
        r#"version = 3
{declaration}
[servers.chat]
bind = "127.0.0.1"
port = {port}
routing_group = "fairness"
endpoints = ["openai_chat"]
{execution}
"#
    );
    for (index, id) in ids.iter().enumerate() {
        source.push_str(&format!(
            r#"
[providers.{id}]
type = "openai_chat"
base_url = "{base}/{index}/v1"
default_model = "recovery"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "FA22072_RUNTIME_FAIRNESS_KEY" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}
concurrency = {{ max_in_flight = 2, acquire_timeout_ms = 60000, stale_lease_ms = 120000 }}
[providers.{id}.models.recovery]
wire_name = "recovery"
capabilities = ["text"]
[providers.{id}.models.sibling]
wire_name = "sibling"
capabilities = ["text"]
"#
        ));
    }
    let targets = ids.iter().map(|id| format!(r#"{{ kind = "provider_model", provider = "{id}", model = "recovery", key = "key", priority = 1 }}"#)).collect::<Vec<_>>().join(",");
    source.push_str(&format!("\n[route_groups.fairness.pools.default]\nselection = {{ strategy = \"priority\" }}\ntargets = [{targets}]\n"));
    source.push_str(&format!(
        r#"
[providers.fairness_fallback]
type = "openai_chat"
base_url = "{base}/fallback/v1"
default_model = "recovery"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "FA22072_RUNTIME_FAIRNESS_KEY" }}] }}
[providers.fairness_fallback.models.recovery]
wire_name = "recovery"
capabilities = ["text"]
"#
    ));
    // A real failure may establish cooldown only when the captured target has
    // an eligible alternative. Explicit provider pins are terminal and neutral.
    for id in &ids {
        source.push_str(&format!(r#"
[route_groups.fairness.pools.{id}]
selection = {{ strategy = "priority" }}
match = {{ precedence = 20, models = ["{id}-failure"] }}
targets = [{{ kind = "provider_model", provider = "{id}", model = "recovery", key = "key", priority = 10 }}, {{ kind = "provider_model", provider = "fairness_fallback", model = "recovery", key = "key", priority = 1 }}]
"#));
    }
    (
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap(),
        ids,
    )
}

async fn business(
    manifest: Arc<V3Config05ManifestPublished>,
    health: V3ProviderFailureRuntimeHealth,
    model: String,
    marker: &str,
) -> crate::kernel::V3ResponsesDirectRuntimeOutput {
    // Failure probes need a specific primary and a fallback in one pool.
    // Ordinary model aliases no longer select pools, so make that pool the
    // default for this individual fixture request instead.
    let manifest = if let Some(id) = model.strip_suffix("-failure") {
        let mut request_manifest = (*manifest).clone();
        let group = request_manifest.route_groups.get_mut("fairness").unwrap();
        let targets = group.pools[id].targets.clone();
        group.pools.get_mut("default").unwrap().targets = targets;
        Arc::new(request_manifest)
    } else {
        manifest
    };
    let request_id = format!("{model}-{marker}");
    let scope = V3ProviderFailureSessionScope::new("chat", "fairness", &request_id)
        .unwrap()
        .with_transport_handoff_scope(request_id.clone(), manifest.servers["chat"].port, 1)
        .unwrap();
    let raw = build_v3_server_03_http_request_raw_with_purpose_and_scope(
        "chat".into(),
        scope,
        request_id.clone(),
        request_id.clone(),
        "POST".into(),
        "/v1/chat/completions".into(),
        V3RequestPurpose::Conversation,
        Some(manifest.servers["chat"].port),
        Some(request_id),
        json!({"model":model,"messages":[{"role":"user","content":marker}],"stream":false}),
    );
    execute_v3_direct_runtime_kernel_core::<V3ChatDirectCodec, _>(
        (),
        &manifest,
        raw,
        crate::default_responses_transport(),
        health,
        v3_relay_provider_policy_now_epoch_ms().unwrap(),
        None,
        None,
    )
    .await
}

#[tokio::test]
async fn normal_resume_keeps_due_deadlines_and_cancel_releases_four_slot_owner() {
    witness(false).await;
}

#[tokio::test]
async fn startup_keeps_early_sweep_and_cancel_releases_exact_acquisitions() {
    witness(true).await;
}

async fn witness(startup: bool) {
    std::env::set_var("FA22072_RUNTIME_FAIRNESS_KEY", "runtime-fairness-fixture");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (manifest, ids) = manifest(&format!("http://{addr}"), addr.port());
    let manifest = Arc::new(manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let peer = Arc::new(Peer {
        holder_entered: Semaphore::new(0),
        holder_release: Semaphore::new(0),
        probe_entered: Semaphore::new(0),
        probe_release: Semaphore::new(0),
    });
    let peer_server = peer.clone();
    let upstream = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => { let (socket, _) = accepted.unwrap(); connections.spawn(serve(socket, peer_server.clone())); },
                done = connections.join_next(), if !connections.is_empty() => { done.unwrap().unwrap(); },
            }
        }
    });
    // No probe scheduler exists while the real business failures establish
    // their holds. The subsequent qualified observations commit Store cooldown.
    let failing_ids: Vec<_> = ids
        .iter()
        .filter(|id| !startup || *id == &ids[4])
        .cloned()
        .collect();
    for id in &failing_ids {
        let result = timeout(
            Duration::from_secs(2),
            business(
                manifest.clone(),
                health.clone(),
                format!("{id}-failure"),
                "genuine failure",
            ),
        )
        .await
        .unwrap();
        eprintln!("focused genuine failure result={result:?}");
        assert!(
            result.error_chain.is_none(),
            "eligible fallback must deliver: {result:?}"
        );
        let failure = result
            .observability
            .as_ref()
            .expect("focused failure observability")
            .provider_failure_events
            .last()
            .expect("real provider failure event");
        // v31: the ordinary request failure is counted immediately. This
        // fixture declares an explicit threshold-one policy, so the first
        // failure already commits the declared cooldown for the exact
        // identity instead of waiting for a qualified observation.
        assert_eq!(failure.health_state, "cooldown");
        assert_eq!(failure.failure_count, 1);
        assert!(
            failure.cooldown_until_ms.is_some(),
            "the declared threshold-one policy commits on the first failure"
        );
        let held = V3ProviderAvailabilityReader::availability_for_interface(
            &health,
            id,
            "default",
            Some("key"),
            Some("recovery"),
            v3_relay_provider_policy_now_epoch_ms().unwrap(),
        );
        assert!(!held.available, "the exact identity must be held");
        assert!(
            held.blocked_scopes
                .iter()
                .any(|scope| scope == "provider_cooldown_probe_pending"),
            "the hold must be the store's typed cooldown probe substate: {held:?}"
        );
    }
    let precool_now_ms = v3_relay_provider_policy_now_epoch_ms().unwrap();
    crate::provider_failure_runtime_policy::tests::complete_due_precool_failures(
        &health,
        precool_now_ms,
    )
    .await;
    for id in &failing_ids {
        assert!(
            !health
                .store
                .availability_for_interface(
                    id,
                    "default",
                    Some("key"),
                    Some("recovery"),
                    v3_relay_provider_policy_now_epoch_ms().unwrap()
                )
                .available,
            "the qualified negative observation must cool its exact identity"
        );
    }
    let deadlines: Vec<_> = ids
        .iter()
        .map(|id| {
            health
                .store
                .provider_cooldown_probe_next_deadline_ms_for_interface(
                    id,
                    "default",
                    Some("key"),
                    Some("recovery"),
                )
                .unwrap()
        })
        .collect();
    let before = health
        .store
        .cooldown_entries(v3_relay_provider_policy_now_epoch_ms().unwrap());
    let controller = V3AdaptiveConcurrencyController::process_shared();
    let mut holders = Vec::new();
    for id in &ids[..4] {
        holders.push(tokio::spawn(business(
            manifest.clone(),
            health.clone(),
            format!("{id}.sibling"),
            "holder",
        )));
    }
    timeout(Duration::from_secs(2), peer.holder_entered.acquire_many(4))
        .await
        .unwrap()
        .unwrap()
        .forget();
    for id in &ids[..4] {
        // Business holders reach the real transport: the holder gate above
        // proves the send itself. Provider concurrency tracking may observe
        // their in-flight sends, but must never park a holder beyond its
        // declared budget.
        assert!(
            controller
                .snapshot(&format!("{id}:key"))
                .is_none_or(|state| state.in_flight <= state.budget),
            "business holders must never be gated beyond the declared provider budget"
        );
    }
    let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel();
    let lifecycle = if startup {
        Box::pin(
            health
                .aggregate_provider_probe_lifecycle(manifest.clone(), shutdown_rx)
                .unwrap(),
        ) as std::pin::Pin<Box<dyn Future<Output = ()> + Send>>
    } else {
        Box::pin(
            health
                .aggregate_provider_probe_lifecycle_resume(manifest.clone(), shutdown_rx)
                .unwrap(),
        ) as std::pin::Pin<Box<dyn Future<Output = ()> + Send>>
    };
    let owner = health.probe_owner.lock().unwrap().clone().unwrap();
    assert_eq!(owner.capacity.available_permits(), 4);
    let task = tokio::spawn(lifecycle);
    if !startup {
        assert!(
            timeout(Duration::from_millis(300), peer.probe_entered.acquire())
                .await
                .is_err(),
            "normal resume must not sweep future deadlines"
        );
        assert_eq!(owner.capacity.available_permits(), 4);
    }
    let expected_probes: usize = if startup { 1 } else { 4 };
    timeout(
        // The resume scheduler fires each probe at its own cooldown deadline
        // (declared cooldown_ms after the qualified observation). Give the
        // slowest observation enough runway to reach its real due time.
        Duration::from_secs(if startup { 3 } else { 15 }),
        peer.probe_entered.acquire_many(expected_probes as u32),
    )
    .await
    .expect("due identities must receive their real probes")
    .unwrap()
    .forget();
    let now_ms = v3_relay_provider_policy_now_epoch_ms().unwrap();
    assert_eq!(startup, now_ms < *deadlines.iter().flatten().min().unwrap());
    timeout(Duration::from_secs(2), async {
        while owner.capacity.available_permits() != 4 - expected_probes {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let due = health.store.cooldown_entries(now_ms);
    assert_eq!(
        due.iter().filter(|entry| entry.state == "probing").count(),
        expected_probes as usize
    );
    for id in &ids[..4] {
        if !startup {
            let old = before
                .iter()
                .find(|entry| entry.kind == "probe" && entry.provider_id == *id)
                .unwrap();
            let current = due
                .iter()
                .find(|entry| entry.kind == "probe" && entry.provider_id == *id)
                .unwrap();
            assert_eq!(current.failure_count, old.failure_count);
        }
        assert_eq!(
            health
                .store
                .scheduling_projection_for_interface(id, "default", "key", "recovery", 1, 1, now_ms)
                .available,
            startup
        );
        assert!(
            health
                .store
                .scheduling_projection_for_interface(id, "default", "key", "sibling", 1, 1, now_ms)
                .available
        );
    }
    assert!(holders.iter().all(|holder| !holder.is_finished()));
    // Exactly expected_probes probes are in flight: the probe_entered gate
    // above proved that many real probe transports entered the peer, the
    // cooldown entries above carry state "probing" for exactly that many
    // identities, and the owner slot accounting below pins the same count.
    // The adaptive controller can no longer distinguish them from business
    // sends because a probe admission falls back to a business slot whenever
    // the declared budget has room, by design.
    shutdown.send(()).unwrap();
    timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(owner.capacity.available_permits(), 4);
    assert!(owner.sender.is_closed());
    for (index, id) in ids.iter().enumerate() {
        if index < 4 {
            // Holder business sends are still resident by design; the peer
            // has not released them yet and their release is asserted after
            // holder_release below.
            continue;
        }
        if let Some(snapshot) = controller.snapshot(&format!("{id}:key")) {
            assert_eq!(snapshot.in_flight, 0, "probe cancellation must release {id}");
        }
    }
    assert_eq!(peer.probe_release.available_permits(), 0);
    assert!(health
        .store
        .cooldown_entries(now_ms)
        .iter()
        .all(|entry| entry.state != "probing"));
    for (index, id) in ids.iter().enumerate() {
        assert_eq!(
            health
                .store
                .provider_cooldown_probe_next_deadline_ms_for_interface(
                    id,
                    "default",
                    Some("key"),
                    Some("recovery")
                )
                .unwrap(),
            deadlines[index]
        );
    }
    peer.holder_release.add_permits(4);
    for holder in holders {
        assert!(timeout(Duration::from_secs(2), holder)
            .await
            .unwrap()
            .unwrap()
            .error_chain
            .is_none());
    }
    for id in &ids {
        let snapshot = controller.snapshot(&format!("{id}:key"));
        if let Some(snapshot) = snapshot {
            assert_eq!(snapshot.in_flight, 0, "terminal transport must release {id}");
        }
    }
    eprintln!("focused fairness: startup={startup} exact deadlines unchanged; manager slots=4; terminal transports=0 acquisitions=0");
    upstream.abort();
    let _ = upstream.await;
}
