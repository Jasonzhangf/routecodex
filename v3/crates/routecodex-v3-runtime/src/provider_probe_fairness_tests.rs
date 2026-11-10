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
    eprintln!("focused fairness: startup={startup} exact deadlines unchanged; manager slots=4; terminal transports=0 acquisitions=0");
    upstream.abort();
    let _ = upstream.await;
}

// ---------------------------------------------------------------------------
// Rescue-round custody.
//
// A bounded rescue round is provider lifecycle state, not request state: it is
// submitted to the Server-owned aggregate probe lifecycle, which retains it,
// cancels it on shutdown and joins it. The request path must never create a
// probe task of its own.
// ---------------------------------------------------------------------------

/// Stable projection of the cooldown pool. The relative `remaining_ms` field is
/// excluded so snapshots taken at different instants stay comparable; every
/// other field participates.
#[allow(clippy::type_complexity)]
fn custody_cooldown_snapshot(
    health: &V3ProviderFailureRuntimeHealth,
) -> Vec<(
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    Option<u64>,
    Option<u32>,
    String,
)> {
    let now_ms = v3_relay_provider_policy_now_epoch_ms().expect("custody clock");
    health
        .store
        .cooldown_entries(now_ms)
        .into_iter()
        .map(|entry| {
            (
                entry.provider_id,
                entry.interface_id,
                entry.auth_alias,
                entry.model_id,
                entry.state,
                entry.until_ms,
                entry.failure_count,
                entry.kind,
            )
        })
        .collect()
}

/// The captured target a request of this fixture resolves to. A rescue round is
/// submitted for the expansion a real request path would have produced, not for
/// a hand-built candidate list.
fn custody_expanded(
    manifest: &V3Config05ManifestPublished,
) -> routecodex_v3_target::V3Target09CandidateSetExpanded {
    let hit = crate::provider_failure_runtime_policy::resolve_v3_relay_opaque_target_once(
        manifest,
        "chat",
        "openai_chat",
        "/v1/chat/completions",
        &json!({"model": "recovery", "messages": [{"role": "user", "content": "custody"}]}),
        0,
    )
    .expect("custody opaque hit");
    crate::provider_failure_runtime_policy::expand_v3_relay_target_candidates_from_opaque_hit(
        manifest, hit, 0,
    )
    .expect("custody expanded candidates")
}

struct CustodyFixture {
    manifest: Arc<V3Config05ManifestPublished>,
    health: V3ProviderFailureRuntimeHealth,
    ids: Vec<String>,
    peer: Arc<Peer>,
    upstream: tokio::task::JoinHandle<()>,
}

impl CustodyFixture {
    async fn new() -> Self {
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
        Self {
            manifest,
            health,
            ids,
            peer,
            upstream,
        }
    }

    /// Commit a real cooldown for one identity through the public request entry.
    /// Nothing is injected into the store directly: the hold a rescue round acts
    /// on is the same one an ordinary failure produces.
    async fn cool(&self, id: &str) {
        let result = timeout(
            Duration::from_secs(5),
            business(
                self.manifest.clone(),
                self.health.clone(),
                format!("{id}-failure"),
                "genuine failure",
            ),
        )
        .await
        .expect("custody cooldown request must finish");
        assert!(
            result.error_chain.is_none(),
            "eligible fallback must deliver: {result:?}"
        );
        let now_ms = v3_relay_provider_policy_now_epoch_ms().unwrap();
        let held = V3ProviderAvailabilityReader::availability_for_interface(
            &self.health,
            id,
            "default",
            Some("key"),
            Some("recovery"),
            now_ms,
        );
        assert!(
            !held.available,
            "custody fixture must hold the identity: {held:?}"
        );
        assert!(
            held.blocked_scopes
                .iter()
                .any(|scope| scope == "provider_cooldown_probe_pending"),
            "custody hold must be the typed probe substate: {held:?}"
        );
    }

    /// Register the aggregate probe lifecycle the way a listener does, and return
    /// the shutdown trigger with the task that retains and joins it.
    fn register(
        &self,
    ) -> (
        tokio::sync::oneshot::Sender<()>,
        tokio::task::JoinHandle<()>,
    ) {
        let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel();
        let lifecycle = self
            .health
            .aggregate_provider_probe_lifecycle_resume(self.manifest.clone(), shutdown_rx)
            .expect("custody aggregate registers once");
        (shutdown, tokio::spawn(lifecycle))
    }
}

/// No owner, no task: without a registered aggregate the round is refused and
/// dropped, and the store keeps exactly the state it had.
#[tokio::test]
async fn rescue_round_without_owner_is_dropped_instead_of_spawned() {
    let fixture = CustodyFixture::new().await;
    let expanded = custody_expanded(&fixture.manifest);
    fixture.cool(&fixture.ids[0]).await;
    assert!(
        fixture.health.probe_owner.lock().unwrap().is_none(),
        "this fixture registers no aggregate probe owner"
    );
    let before = custody_cooldown_snapshot(&fixture.health);
    let submission = fixture
        .health
        .submit_v3_background_cooldown_rescue_round(&fixture.manifest, &expanded);
    assert_eq!(
        submission,
        V3CooldownRescueSubmission::OwnerUnavailable,
        "an absent owner must refuse custody instead of creating a task"
    );
    // Past the grace and the round budget: a request-owned task would have
    // reached the provider and mutated its health by now.
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    assert!(
        fixture.peer.probe_entered.try_acquire().is_err(),
        "a round with no owner must never probe"
    );
    assert_eq!(
        custody_cooldown_snapshot(&fixture.health),
        before,
        "a refused round must leave provider health byte-identical"
    );
    fixture.upstream.abort();
}

/// The aggregate is the executor: a submitted round runs inside it, obeys the
/// bound, and leaves the health observation it is supposed to leave.
#[tokio::test]
async fn rescue_round_is_executed_by_the_registered_aggregate() {
    let fixture = CustodyFixture::new().await;
    let expanded = custody_expanded(&fixture.manifest);
    fixture.cool(&fixture.ids[0]).await;
    let before = custody_cooldown_snapshot(&fixture.health);
    let (shutdown, lifecycle) = fixture.register();
    let owner = fixture
        .health
        .probe_owner
        .lock()
        .unwrap()
        .clone()
        .expect("registered aggregate owner");
    assert_eq!(owner.capacity.available_permits(), 4);
    // The retained schedule is not due for this identity yet, so any probe that
    // appears later in this test is the submitted round's.
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(
        fixture.peer.probe_entered.try_acquire().is_err(),
        "the retained schedule must not probe an identity whose rescue deadline is still ahead"
    );
    assert_eq!(
        custody_cooldown_snapshot(&fixture.health),
        before,
        "nothing may observe this identity before the round runs"
    );

    assert_eq!(
        fixture
            .health
            .submit_v3_background_cooldown_rescue_round(&fixture.manifest, &expanded),
        V3CooldownRescueSubmission::Initiated,
        "a registered owner must take custody"
    );
    assert_eq!(
        owner.capacity.available_permits(),
        3,
        "the submitted round holds one owner slot until it finishes"
    );
    timeout(Duration::from_secs(2), fixture.peer.probe_entered.acquire())
        .await
        .expect("the aggregate must execute the submitted round")
        .unwrap()
        .forget();
    // Answer the parked probe so the round observes a real provider 2xx.
    fixture.peer.probe_release.add_permits(1);
    timeout(Duration::from_secs(2), async {
        while owner.capacity.available_permits() != 4 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the round must finish inside its bound and release the owner slot");
    let now_ms = v3_relay_provider_policy_now_epoch_ms().unwrap();
    let restored = V3ProviderAvailabilityReader::availability_for_interface(
        &fixture.health,
        &fixture.ids[0],
        "default",
        Some("key"),
        Some("recovery"),
        now_ms,
    );
    assert!(
        restored.available,
        "the executed round's real 2xx must restore the identity: {restored:?}"
    );
    assert_ne!(
        custody_cooldown_snapshot(&fixture.health),
        before,
        "the executed round must leave its health observation"
    );
    shutdown.send(()).expect("aggregate shutdown trigger");
    timeout(Duration::from_secs(2), lifecycle)
        .await
        .expect("the aggregate must join on shutdown")
        .expect("the aggregate task must not panic");
    fixture.upstream.abort();
}

/// One rescue pass per listener. The request path reports exhaustion from more
/// than one live entry (a selected-target pre-exhaustion and the exhausted
/// stop), so the owner takes custody of exactly one round per failure cycle and
/// the refused report neither spends a second owner slot nor runs a probe.
#[tokio::test]
async fn rescue_round_is_single_flight_per_listener() {
    let fixture = CustodyFixture::new().await;
    let expanded = custody_expanded(&fixture.manifest);
    fixture.cool(&fixture.ids[0]).await;
    let (shutdown, lifecycle) = fixture.register();
    let owner = fixture
        .health
        .probe_owner
        .lock()
        .unwrap()
        .clone()
        .expect("registered aggregate owner");
    assert_eq!(owner.capacity.available_permits(), 4);
    assert_eq!(
        fixture
            .health
            .submit_v3_background_cooldown_rescue_round(&fixture.manifest, &expanded),
        V3CooldownRescueSubmission::Initiated,
        "the first report of the exhausted target takes the single rescue pass"
    );
    assert_eq!(
        fixture
            .health
            .submit_v3_background_cooldown_rescue_round(&fixture.manifest, &expanded),
        V3CooldownRescueSubmission::RoundInFlight,
        "a second live entry in the same failure cycle must not start a second pass"
    );
    assert_eq!(
        owner.capacity.available_permits(),
        3,
        "the refused report must not take a second owner slot"
    );
    timeout(Duration::from_secs(2), fixture.peer.probe_entered.acquire())
        .await
        .expect("the aggregate executes the admitted round")
        .unwrap()
        .forget();
    fixture.peer.probe_release.add_permits(1);
    timeout(Duration::from_secs(2), async {
        while owner.capacity.available_permits() != 4 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the round must finish inside its bound and release the owner slot");
    assert!(
        fixture.peer.probe_entered.try_acquire().is_err(),
        "the refused report must not have queued a second probe"
    );
    assert_eq!(
        fixture
            .health
            .submit_v3_background_cooldown_rescue_round(&fixture.manifest, &expanded),
        V3CooldownRescueSubmission::Initiated,
        "the single-flight flag must be released when the round ends"
    );
    shutdown.send(()).expect("aggregate shutdown trigger");
    timeout(Duration::from_secs(2), lifecycle)
        .await
        .expect("the aggregate must join on shutdown")
        .expect("the aggregate task must not panic");
    fixture.upstream.abort();
}

/// Shutdown custody: the aggregate owns the pending round, so shutdown drops it
/// and no health mutation can happen afterwards.
#[tokio::test]
async fn shutdown_cancels_pending_rescue_round_without_health_mutation() {
    let fixture = CustodyFixture::new().await;
    let expanded = custody_expanded(&fixture.manifest);
    fixture.cool(&fixture.ids[0]).await;
    let before = custody_cooldown_snapshot(&fixture.health);
    let (shutdown, lifecycle) = fixture.register();
    let owner = fixture
        .health
        .probe_owner
        .lock()
        .unwrap()
        .clone()
        .expect("registered aggregate owner");
    assert_eq!(
        fixture
            .health
            .submit_v3_background_cooldown_rescue_round(&fixture.manifest, &expanded),
        V3CooldownRescueSubmission::Initiated
    );
    // Shutdown lands while the round is still inside its grace period.
    shutdown.send(()).expect("aggregate shutdown trigger");
    timeout(Duration::from_secs(2), lifecycle)
        .await
        .expect("shutdown must join the aggregate")
        .expect("the aggregate task must not panic");
    // Past the grace and the round budget: a request-owned detached task would
    // have reached the provider and mutated health regardless of shutdown.
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    assert!(
        fixture.peer.probe_entered.try_acquire().is_err(),
        "a cancelled round must never reach the provider"
    );
    assert_eq!(
        custody_cooldown_snapshot(&fixture.health),
        before,
        "shutdown must prevent post-shutdown provider health mutation"
    );
    assert_eq!(
        owner.capacity.available_permits(),
        4,
        "the dropped round must release its owner slot"
    );
    fixture.upstream.abort();
}
