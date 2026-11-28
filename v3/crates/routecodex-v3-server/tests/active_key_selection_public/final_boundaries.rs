//! Real HTTP projection and health settlement on the only eligible recovery trial.
use super::*;
use routecodex_v3_runtime::{
    build_v3_server_03_http_request_raw,
    execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug,
    register_responses_direct_hooks, V3ResponsesDirectRuntimeSharedState,
    V3ResponsesRelayProviderHealthHandle, V3RuntimeRouteSelectionEventSink,
};
use routecodex_v3_target::{
    V3ActiveKeyEpisode, V3ActiveKeyIdentity, V3ActiveKeyScope, V3ActiveKeySelectionState,
};
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug)]
struct Clock(AtomicU64);
impl routecodex_v3_runtime::V3ProviderHealthObservationClock for Clock {
    fn now_epoch_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

async fn cooldown(entry: &Entry) -> Value {
    reqwest::get(format!("{}/_routecodex/health/cooldown-pool", entry.base))
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap()["entries"][0]
        .clone()
}

const NOW: u64 = 1_800_000_000_000;

fn raw_request(
    port: u16,
    endpoint: &str,
    payload: Value,
) -> routecodex_v3_runtime::V3Server03HttpRequestRaw {
    let scope = routecodex_v3_error::V3ProviderFailureSessionScope::new(
        "active_public",
        "active_public",
        "boundary",
    )
    .unwrap()
    .with_transport_handoff_scope("boundary", port, 1)
    .unwrap();
    let mut raw = build_v3_server_03_http_request_raw(
        "active_public".into(),
        scope,
        "boundary".into(),
        "boundary".into(),
        "POST".into(),
        endpoint.into(),
        payload,
    );
    raw.port = Some(port);
    raw.pipeline_id = Some("boundary".into());
    raw
}

async fn selected_direct(
    entry: &Entry,
    health: &V3ResponsesRelayProviderHealthHandle,
    keys: Arc<V3ActiveKeySelectionState>,
    sink: V3RuntimeRouteSelectionEventSink,
) -> routecodex_v3_runtime::V3ResponsesDirectRuntimeOutput {
    let raw = raw_request(
        entry.ports[0],
        "/v1/responses",
        json!({"model":"client","input":"ordinary paragraph ".repeat(2000)}),
    );
    let shared = V3ResponsesDirectRuntimeSharedState::new(health.runtime_health())
        .with_active_keys(Some(keys))
        .with_route_selection_event_sink(Some(sink));
    execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug(
        shared,
        &entry.manifest,
        raw,
        register_responses_direct_hooks(),
        &routecodex_v3_debug::V3DebugRuntime::new(Default::default()).unwrap(),
        NOW,
    )
    .await
}

struct GatedTransport {
    received: std::sync::mpsc::Sender<()>,
    release: tokio::sync::Notify,
}

#[async_trait::async_trait]
impl routecodex_v3_provider_responses::ResponsesTransport for GatedTransport {
    async fn send(
        &self,
        request: routecodex_v3_provider_responses::V3Transport13ResponsesHttpRequest,
    ) -> Result<
        routecodex_v3_provider_responses::V3ProviderResp14Raw,
        routecodex_v3_provider_responses::V3ProviderError,
    > {
        let raw = routecodex_v3_runtime::default_responses_transport()
            .send(request)
            .await?;
        self.received.send(()).unwrap();
        self.release.notified().await;
        Ok(raw)
    }
}

#[derive(Clone, Copy, Debug)]
enum Path {
    ResponsesDirect,
    ChatDirect,
    Relay(&'static str),
}
const OTHER_PATHS: [Path; 5] = [
    Path::ChatDirect,
    Path::Relay("responses"),
    Path::Relay("openai_chat"),
    Path::Relay("gemini"),
    Path::Relay("anthropic"),
];

struct AtValidation {
    keys: Arc<V3ActiveKeySelectionState>,
    scope: V3ActiveKeyScope,
    reads: AtomicU64,
    action: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}
impl std::fmt::Debug for AtValidation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AtValidation")
    }
}
impl routecodex_v3_runtime::V3ProviderHealthObservationClock for AtValidation {
    fn now_epoch_ms(&self) -> u64 {
        // Two configured rows each receive global and session scheduling
        // observations. The seventh read validates the selected occurrence.
        if self.keys.snapshot(&self.scope).is_ok() && self.reads.fetch_add(1, Ordering::SeqCst) == 6
        {
            if let Some(action) = self.action.lock().unwrap().take() {
                action();
            }
        }
        NOW
    }
}

async fn other_path(
    path: Path,
    entry: &Entry,
    health: &V3ResponsesRelayProviderHealthHandle,
    keys: Arc<V3ActiveKeySelectionState>,
) -> (u16, routecodex_v3_runtime::V3RuntimeObservability) {
    use routecodex_v3_runtime::*;
    let protocol = match path {
        Path::ChatDirect => "openai_chat",
        Path::Relay(protocol) => protocol,
        _ => unreachable!(),
    };
    let (endpoint, payload) = protocol_input(protocol);
    let raw = raw_request(entry.ports[0], endpoint, payload.clone());
    if matches!(path, Path::ChatDirect) {
        let output =
            execute_v3_direct_runtime_kernel_core_with_active_keys::<V3ChatDirectCodec, _>(
                (),
                &entry.manifest,
                raw,
                default_responses_transport(),
                health.runtime_health(),
                NOW,
                false,
                None,
                None,
                Some(keys),
            )
            .await;
        return (output.client_payload.status, output.observability.unwrap());
    }
    let server_id = raw.server_id;
    let failure_session_scope = raw.failure_session_scope;
    let request_id = raw.request_id;
    match protocol {
        "responses" => {
            let output = execute_v3_responses_relay_runtime_with_transport_health(
                &entry.manifest,
                V3ResponsesRelayRuntimeInput {
                    server_id,
                    failure_session_scope,
                    request_id,
                    payload,
                },
                default_responses_transport(),
                health,
            )
            .await
            .unwrap();
            (output.status, output.observability.unwrap())
        }
        "openai_chat" => {
            let output = execute_v3_openai_chat_relay_runtime_with_active_keys(
                &entry.manifest,
                V3OpenAiChatRelayRuntimeInput {
                    server_id,
                    failure_session_scope,
                    request_id,
                    payload,
                },
                health.runtime_health(),
                Some(keys),
            )
            .await
            .unwrap();
            (output.status, output.observability.unwrap())
        }
        "anthropic" => {
            let output = execute_v3_anthropic_relay_runtime_with_active_keys(
                &entry.manifest,
                V3AnthropicRelayRuntimeInput {
                    server_id,
                    failure_session_scope,
                    request_id,
                    payload,
                },
                vec![],
                health.runtime_health(),
                Some(keys),
            )
            .await
            .unwrap();
            (output.status, output.observability.unwrap())
        }
        "gemini" => {
            let output = execute_v3_gemini_relay_runtime_with_active_keys(
                &entry.manifest,
                V3GeminiRelayRuntimeInput {
                    server_id,
                    failure_session_scope,
                    request_id,
                    payload,
                    endpoint_path: endpoint.into(),
                },
                health.runtime_health(),
                Some(keys),
            )
            .await
            .unwrap();
            (output.status, output.observability.unwrap())
        }
        _ => unreachable!(),
    }
}

async fn contended_trial(path: Path) {
    use routecodex_v3_error::*;
    use routecodex_v3_runtime::{
        execute_v3_responses_relay_runtime_with_transport_health, V3ResponsesRelayRuntimeInput,
    };
    let _home = LOCK.lock().await;
    let mut entry = Entry::start("active_queue", 3, "hold", matches!(path, Path::ChatDirect)).await;
    if matches!(path, Path::Relay(_)) {
        entry
            .manifest
            .servers
            .get_mut("active_public")
            .unwrap()
            .execution
            .as_mut()
            .unwrap()
            .allowed_modes = vec!["relay".into()];
    }
    let health =
        V3ResponsesRelayProviderHealthHandle::from_manifest_without_persistence(&entry.manifest)
            .with_observation_clock(Arc::new(Clock(AtomicU64::new(NOW))));
    let store = health.store();
    store
        .record_provider_key_success("controlled", "A", "wire", NOW - 5000)
        .unwrap();
    store
        .record_provider_cooldown_failure(
            "controlled",
            Some("A"),
            Some("wire"),
            "trial",
            NOW - 3_600_001,
            3_600_000,
        )
        .unwrap();
    // NotProviderHealth is Provider's side-effect-free projection branch.
    let observation = build_v3_provider_failure_action_from_v3_error_02(
        &build_v3_error_02_classified_from_v3_error_01(build_v3_error_01_source_raised(
            V3ErrorSourceKind::ClientDisconnect,
            "V3Server03HttpRequestRaw",
            "client_disconnect",
            "test observer",
        )),
    );
    assert_eq!(
        observation.recovery,
        V3ProviderRecoveryKind::NotProviderHealth
    );
    let projection = || {
        store
            .record_provider_failure_action_for_interface(
                "controlled",
                "default",
                "A",
                "wire",
                &observation,
                NOW,
            )
            .unwrap()
    };
    let before = projection();
    let keys = Arc::new(V3ActiveKeySelectionState::default());
    let mut owner_manifest = entry.manifest.clone();
    owner_manifest
        .servers
        .get_mut("active_public")
        .unwrap()
        .execution
        .as_mut()
        .unwrap()
        .allowed_modes = vec!["relay".into()];
    let owner_health = health.clone().with_active_keys(Some(keys.clone()));
    let (received, held) = std::sync::mpsc::channel();
    let transport = Arc::new(GatedTransport {
        received,
        release: tokio::sync::Notify::new(),
    });
    let owner_transport = transport.clone();
    let (start, ready) = tokio::sync::oneshot::channel();
    let owner = tokio::spawn(async move {
        ready.await.unwrap();
        let input = V3ResponsesRelayRuntimeInput {
            server_id: "active_public".into(),
            failure_session_scope: V3ProviderFailureSessionScope::new(
                "active_public",
                "active_public",
                "trial-owner",
            )
            .unwrap(),
            request_id: "trial-owner".into(),
            payload: json!({"model":"client","input":"real trial"}),
        };
        execute_v3_responses_relay_runtime_with_transport_health(
            &owner_manifest,
            input,
            &*owner_transport,
            &owner_health,
        )
        .await
        .unwrap()
    });
    let start = Mutex::new(Some(start));
    let held = Mutex::new(held);
    let gate = move || {
        start.lock().unwrap().take().unwrap().send(()).unwrap();
        held.lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(10))
            .expect("owned A trial at real upstream");
    };
    // Query the original minimum before expiry so the deadline is visible.
    let entries = store.cooldown_entries(NOW - 2000);
    let (status, observability) = if matches!(path, Path::ResponsesDirect) {
        let result = selected_direct(
            &entry,
            &health,
            keys,
            Arc::new(move |ob| {
                if ob.auth_alias.as_deref() == Some("A") {
                    gate();
                }
            }),
        )
        .await;
        (result.client_payload.status, result.observability.unwrap())
    } else {
        let clock = Arc::new(AtValidation {
            keys: keys.clone(),
            scope: V3ActiveKeyScope {
                listener_id: "active_public".into(),
                routing_group_id: "active_public".into(),
                pool_id: "default".into(),
            },
            reads: AtomicU64::new(0),
            action: Mutex::new(Some(Box::new(gate))),
        });
        let subject = health
            .clone()
            .with_active_keys(Some(keys.clone()))
            .with_observation_clock(clock.clone());
        let result = other_path(path, &entry, &subject, keys).await;
        assert!(
            clock.action.lock().unwrap().is_none(),
            "{path:?} missed the gated choice"
        );
        result
    };
    let during = projection();
    let remaining = store.cooldown_entries(NOW - 2000);
    transport.release.notify_one();
    let accepted = owner.await.unwrap();
    let calls = entry.calls();
    entry.stop().await;
    assert_eq!(status, 200);
    assert!(observability.provider_failure_events.is_empty());
    assert_eq!(observability.auth_alias.as_deref(), Some("B"));
    assert_eq!(calls, ["A", "B"]);
    assert_eq!(accepted.status, 200);
    assert_eq!(
        accepted.observability.unwrap().auth_alias.as_deref(),
        Some("A")
    );
    assert!(store.cooldown_entries(NOW + 1).is_empty());
    assert_eq!(remaining[0].state, "probing");
    assert_eq!(entries[0].until_ms, Some(NOW - 1));
    assert_eq!(remaining[0].failure_count, entries[0].failure_count);
    assert_eq!(remaining[0].until_ms, entries[0].until_ms);
    assert_eq!(
        (
            during.score_milli,
            during.score_generation,
            during.success_streak,
            during.failure_streak
        ),
        (
            before.score_milli,
            before.score_generation,
            before.success_streak,
            before.failure_streak
        )
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsent_direct_contender_cannot_change_owned_trial() {
    contended_trial(Path::ResponsesDirect).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn contended_trial_is_health_neutral_in_each_dispatch_loop() {
    for path in OTHER_PATHS {
        contended_trial(path).await;
    }
}

#[tokio::test]
async fn fresh_choice_invalidated_during_validation_uses_b_in_each_dispatch_loop() {
    let _home = LOCK.lock().await;
    for path in OTHER_PATHS {
        let mut entry =
            Entry::start("active_queue", 3, "hold", matches!(path, Path::ChatDirect)).await;
        if matches!(path, Path::Relay(_)) {
            entry
                .manifest
                .servers
                .get_mut("active_public")
                .unwrap()
                .execution
                .as_mut()
                .unwrap()
                .allowed_modes = vec!["relay".into()];
        }
        let scope = V3ActiveKeyScope {
            listener_id: "active_public".into(),
            routing_group_id: "active_public".into(),
            pool_id: "default".into(),
        };
        let keys = Arc::new(V3ActiveKeySelectionState::default());
        let target = keys.clone();
        let pool = scope.clone();
        let hold = move || {
            let identity = V3ActiveKeyIdentity {
                provider_id: "controlled".into(),
                interface_id: "default".into(),
                model_id: "wire".into(),
                auth_alias: "A".into(),
            };
            let witness = target
                .choose(&pool, &BTreeSet::from([identity]), &BTreeSet::new(), None)
                .unwrap()
                .unwrap();
            let mut sibling = V3ActiveKeyEpisode::new(witness);
            for n in 1..=4 {
                sibling.begin_attempt().unwrap();
                assert_eq!(
                    target
                        .record_delivery_failure(&mut sibling)
                        .unwrap()
                        .transitioned,
                    n == 4
                );
            }
        };
        let clock = Arc::new(AtValidation {
            keys: keys.clone(),
            scope,
            reads: AtomicU64::new(0),
            action: Mutex::new(Some(Box::new(hold))),
        });
        let health = V3ResponsesRelayProviderHealthHandle::from_manifest_without_persistence(
            &entry.manifest,
        )
        .with_active_keys(Some(keys.clone()))
        .with_observation_clock(clock.clone());
        let (status, observability) = other_path(path, &entry, &health, keys).await;
        let calls = entry.calls();
        entry.stop().await;
        assert!(clock.action.lock().unwrap().is_none());
        assert_eq!(calls, ["B"], "{path:?}");
        assert_eq!(status, 200);
        assert_eq!(observability.auth_alias.as_deref(), Some("B"));
        assert!(observability.provider_failure_events.is_empty());
    }
}

async fn fresh_hold(default_alias: &str, close_window: bool) {
    let _home = LOCK.lock().await;
    let pools = format!(
        r#"
[route_groups.active_public.pools.primary]
selection={{strategy="active_queue"}}
active_keys={{members=[{{provider="controlled",alias="A"}}],retries=3,on_failure="hold"}}
match={{precedence=10,required_capabilities=["thinking"],min_input_tokens=1000}}
targets=[{{kind="provider_model",provider="controlled",model="wire",key="A",priority=1}}]
[route_groups.active_public.pools.default]
selection={{strategy="priority"}}
targets=[{{kind="provider_model",provider="controlled",model="wire",key="{default_alias}",priority=1}}]
"#
    );
    let mut entry = Entry::start_with_protocol_and_pools(
        "active_queue",
        3,
        "hold",
        "responses",
        &["A"],
        Some(&pools),
    )
    .await;
    let clock = Arc::new(Clock(AtomicU64::new(NOW)));
    if close_window {
        let hour = (NOW / 3_600_000) % 24;
        entry.manifest.providers.get_mut("controlled").unwrap().models.get_mut("wire").unwrap().availability=
            Some(serde_json::from_value(json!({"timezone":"UTC","periods":[{"start":format!("{:02}:00",(hour+23)%24),"end":format!("{:02}:00",(hour+2)%24)}]})).unwrap());
    }
    let health =
        V3ResponsesRelayProviderHealthHandle::from_manifest_without_persistence(&entry.manifest)
            .with_observation_clock(clock.clone());
    let keys = Arc::new(V3ActiveKeySelectionState::default());
    let target = keys.clone();
    let choices = Arc::new(Mutex::new(Vec::new()));
    let observed = choices.clone();
    let sink = Arc::new(move |ob: &routecodex_v3_runtime::V3RuntimeObservability| {
        let mut choices = observed.lock().unwrap();
        choices.push(ob.auth_alias.clone().unwrap());
        if choices.len() == 1 {
            if close_window {
                clock.0.store(NOW + 12 * 3_600_000, Ordering::SeqCst);
            }
            let scope = V3ActiveKeyScope {
                listener_id: "active_public".into(),
                routing_group_id: "active_public".into(),
                pool_id: "primary".into(),
            };
            let identity = V3ActiveKeyIdentity {
                provider_id: "controlled".into(),
                interface_id: "default".into(),
                model_id: "wire".into(),
                auth_alias: "A".into(),
            };
            let witness = target
                .choose(&scope, &BTreeSet::from([identity]), &BTreeSet::new(), None)
                .unwrap()
                .unwrap();
            let mut episode = V3ActiveKeyEpisode::new(witness);
            for i in 1..=4 {
                episode.begin_attempt().unwrap();
                assert_eq!(
                    target
                        .record_delivery_failure(&mut episode)
                        .unwrap()
                        .transitioned,
                    i == 4
                );
            }
        }
    });
    let status = selected_direct(&entry, &health, keys, sink).await;
    let calls = entry.calls();
    entry.stop().await;
    if close_window {
        assert!(
            calls.is_empty(),
            "closed occurrence reached upstream: {calls:?}"
        );
        assert_eq!(*choices.lock().unwrap(), ["A"]);
        return;
    }
    assert_eq!(calls, [default_alias]);
    assert_eq!(*choices.lock().unwrap(), ["A", default_alias]);
    assert_eq!(status.client_payload.status, 200);
}

#[tokio::test]
async fn fresh_unsent_hold_preserves_legacy_default_occurrence() {
    fresh_hold("A", false).await;
}
#[tokio::test]
async fn fresh_unsent_hold_reaches_b() {
    fresh_hold("B", false).await;
}
#[tokio::test]
async fn unsent_reselection_uses_current_window() {
    fresh_hold("B", true).await;
}

#[tokio::test]
async fn stale_failed_tail_retry_excludes_a_across_declarations_and_sends_b() {
    use routecodex_v3_runtime::*;
    let _home = LOCK.lock().await;
    let pools = r#"
[route_groups.active_public.pools.primary]
selection={strategy="active_queue"}
active_keys={members=[{provider="controlled",alias="A"}],retries=3,on_failure="tail"}
match={precedence=10,required_capabilities=["thinking"],min_input_tokens=1000}
targets=[{kind="provider_model",provider="controlled",model="wire",key="A",priority=3}]
[route_groups.active_public.pools.default]
selection={strategy="priority"}
targets=[{kind="provider_model",provider="controlled",model="wire",key="A",priority=2},{kind="provider_model",provider="controlled",model="wire",key="B",priority=1}]
"#;
    let entry = Entry::start_with_protocol_and_pools(
        "active_queue",
        3,
        "tail",
        "responses",
        &["A"],
        Some(pools),
    )
    .await;
    entry.script("A", &[Outcome::Http(503)]);
    let keys = Arc::new(V3ActiveKeySelectionState::default());
    let scope = V3ActiveKeyScope {
        listener_id: "active_public".into(),
        routing_group_id: "active_public".into(),
        pool_id: "primary".into(),
    };
    let identity = V3ActiveKeyIdentity {
        provider_id: "controlled".into(),
        interface_id: "default".into(),
        model_id: "wire".into(),
        auth_alias: "A".into(),
    };
    // The route callback seeds two independent deliveries. The subject will
    // supply the third, then its failure callback releases the fourth.
    let pending = Arc::new(Mutex::new(None));
    let planned = pending.clone();
    let states = keys.clone();
    let selection: V3RuntimeRouteSelectionEventSink = Arc::new(move |ob| {
        if ob.auth_alias.as_deref() == Some("A") {
            let witness = states
                .choose(
                    &scope,
                    &BTreeSet::from([identity.clone()]),
                    &BTreeSet::new(),
                    None,
                )
                .unwrap()
                .unwrap();
            let mut sibling = V3ActiveKeyEpisode::new(witness);
            for expected in 1..=2 {
                sibling.begin_attempt().unwrap();
                assert_eq!(
                    states
                        .record_delivery_failure(&mut sibling)
                        .unwrap()
                        .consecutive_failures,
                    expected
                );
            }
            sibling.begin_attempt().unwrap();
            *planned.lock().unwrap() = Some(sibling);
        }
    });
    let states = keys.clone();
    let transitioned = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed = transitioned.clone();
    let failure: V3RuntimeProviderFailureEventSink = Arc::new(move |_, _| {
        let mut sibling = pending
            .lock()
            .unwrap()
            .take()
            .expect("fourth delivery ready");
        let feedback = states.record_delivery_failure(&mut sibling).unwrap();
        assert!(feedback.applied && feedback.transitioned && feedback.consecutive_failures == 4);
        observed.store(true, Ordering::SeqCst);
    });
    let health =
        V3ResponsesRelayProviderHealthHandle::from_manifest_without_persistence(&entry.manifest);
    let shared = V3ResponsesDirectRuntimeSharedState::new(health.runtime_health())
        .with_active_keys(Some(keys))
        .with_provider_failure_event_sink(Some(failure))
        .with_route_selection_event_sink(Some(selection));
    let raw = raw_request(
        entry.ports[0],
        "/v1/responses",
        json!({"model":"client","input":"ordinary paragraph ".repeat(2000)}),
    );
    let result =
        execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug(
            shared,
            &entry.manifest,
            raw,
            register_responses_direct_hooks(),
            &routecodex_v3_debug::V3DebugRuntime::new(Default::default()).unwrap(),
            NOW,
        )
        .await;
    let calls = entry.calls();
    entry.stop().await;
    assert!(transitioned.load(Ordering::SeqCst));
    assert_eq!(calls, ["A", "B"]);
    assert_eq!(result.client_payload.status, 200);
}

#[derive(Clone, Copy, Debug)]
enum Successor {
    Held,
    Truncated,
    MissingAuth,
}

fn handoff_manifest(
    entry: &Entry,
    relay_first: bool,
    successor: Successor,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let (first, last) = if relay_first {
        ("openai_chat", "responses")
    } else {
        ("responses", "openai_chat")
    };
    let source = format!(
        r#"
version = 3
{declaration}
[servers.active_public]
bind="127.0.0.1"
port={port}
routing_group="active_public"
endpoints=["responses"]
{execution}
[providers.first]
type="{first}"
base_url="http://127.0.0.1:{upstream}/v1"
default_model="wire"
auth={{type="api_key",entries=[{{alias="A",env="ACTIVE_PUBLIC_A"}}]}}
[providers.first.models.wire]
wire_name="wire"
capabilities=["text","tools"]
[providers.last]
type="{last}"
base_url="http://127.0.0.1:{upstream}/v1"
default_model="wire"
auth={{type="api_key",entries=[{{alias="B",env="{env_b}"}}]}}
[providers.last.models.wire]
wire_name="wire"
capabilities=["text","tools"]
[route_groups.active_public.pools.default]
selection={{strategy="active_queue"}}
active_keys={{members=[{{provider="first",alias="A"}},{{provider="last",alias="B"}}],retries=0,on_failure="hold"}}
targets=[{{kind="provider_model",provider="first",model="wire",key="A",priority=2}},{{kind="provider_model",provider="last",model="wire",key="B",priority=1}}]
"#,
        declaration = hub_v1_fixture::hub_v1_test_declaration(),
        execution = hub_v1_fixture::hub_v1_server_execution("active_public"),
        port = entry.ports[0],
        upstream = entry.ports[1],
        env_b = if matches!(successor, Successor::MissingAuth) {
            "FINAL_BOUNDARY_ABSENT_KEY_B"
        } else {
            "ACTIVE_PUBLIC_B"
        }
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn hold_successor(
    keys: &V3ActiveKeySelectionState,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
) {
    let witness = selected.active_selection.as_ref().unwrap();
    for n in 1..=4 {
        let mut sibling = V3ActiveKeyEpisode::new(witness.clone());
        sibling.begin_attempt().unwrap();
        assert_eq!(
            keys.record_delivery_failure(&mut sibling)
                .unwrap()
                .transitioned,
            n == 4
        );
    }
    assert!(keys
        .snapshot(&witness.scope)
        .unwrap()
        .held
        .contains(&witness.identity));
}

#[derive(Debug)]
struct HoldChosen {
    keys: Arc<V3ActiveKeySelectionState>,
    selected: Mutex<Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>>,
}
impl routecodex_v3_runtime::V3ProviderHealthObservationClock for HoldChosen {
    fn now_epoch_ms(&self) -> u64 {
        if let Some(selected) = self.selected.lock().unwrap().take() {
            hold_successor(&self.keys, &selected);
        }
        NOW
    }
}

#[tokio::test]
async fn post_choice_hold_reselects_b_before_dispatch_planning_returns() {
    use routecodex_v3_runtime::*;
    let _home = LOCK.lock().await;
    let entry = Entry::start("active_queue", 3, "hold", false).await;
    let keys = Arc::new(V3ActiveKeySelectionState::default());
    let clock = Arc::new(HoldChosen {
        keys: keys.clone(),
        selected: Mutex::new(None),
    });
    let health =
        V3ResponsesRelayProviderHealthHandle::from_manifest_without_persistence(&entry.manifest)
            .with_observation_clock(clock.clone());
    let raw = raw_request(
        entry.ports[0],
        "/v1/responses",
        json!({"model":"client","input":"select"}),
    );
    let (plan, control) = plan_v3_responses_protocol_execution_with_recovery(
        &entry.manifest,
        raw.clone(),
        health.runtime_health(),
        NOW,
        None,
        Some(keys.clone()),
    )
    .await
    .unwrap();
    let chosen = plan.decision.target.clone();
    assert_eq!(chosen.candidate.auth_alias, "A");
    *clock.selected.lock().unwrap() = Some(chosen);
    let choices = Arc::new(Mutex::new(Vec::new()));
    let seen = choices.clone();
    let shared = V3ResponsesDirectRuntimeSharedState::new(health.runtime_health())
        .with_active_keys(Some(keys))
        .with_route_selection_event_sink(Some(Arc::new(move |ob| {
            seen.lock().unwrap().push(ob.auth_alias.clone().unwrap())
        })));
    let output=execute_v3_responses_direct_runtime_kernel_with_shared_state_default_transport_debug_and_initial_target(
        shared,&entry.manifest,raw,register_responses_direct_hooks(),&routecodex_v3_debug::V3DebugRuntime::new(Default::default()).unwrap(),
        NOW,&plan,None,Some(control)).await;
    let calls = entry.calls();
    entry.stop().await;
    assert!(clock.selected.lock().unwrap().is_none());
    assert_eq!(*choices.lock().unwrap(), ["B"]);
    assert_eq!(calls, ["B"]);
    assert_eq!(output.client_payload.status, 200);
    assert!(output
        .observability
        .unwrap()
        .provider_failure_events
        .is_empty());
}

async fn handoff(relay_first: bool, successor: Successor) {
    use routecodex_v3_error::V3ProviderTerminalDisposition;
    use routecodex_v3_runtime::*;
    let _home = LOCK.lock().await;
    let entry = Entry::start("active_queue", 0, "hold", false).await;
    let manifest = handoff_manifest(&entry, relay_first, successor);
    let keys = Arc::new(V3ActiveKeySelectionState::default());
    let health = V3ResponsesRelayProviderHealthHandle::from_manifest_without_persistence(&manifest)
        .with_active_keys(Some(keys.clone()));
    let shared = || {
        V3ResponsesDirectRuntimeSharedState::new(health.runtime_health())
            .with_active_keys(Some(keys.clone()))
    };
    let debug = routecodex_v3_debug::V3DebugRuntime::new(Default::default()).unwrap();
    let mut raw = raw_request(
        entry.ports[0],
        "/v1/responses",
        json!({"model":"client","input":"handoff"}),
    );
    let input = V3ResponsesRelayRuntimeInput {
        server_id: raw.server_id.clone(),
        failure_session_scope: raw.failure_session_scope.clone(),
        request_id: raw.request_id.clone(),
        payload: raw.body.clone(),
    };
    entry.script("A", &[Outcome::Http(503)]);
    entry.script("B", &[Outcome::Truncated]);
    let (terminal, source) = if relay_first {
        let first = execute_v3_responses_relay_runtime_with_transport_health(
            &manifest,
            input,
            default_responses_transport(),
            &health,
        )
        .await
        .unwrap();
        let handoff = first
            .protocol_direct_handoff
            .expect("Relay selected the Direct successor");
        assert_eq!(handoff.plan.decision.target.candidate.auth_alias, "B");
        if matches!(successor, Successor::Held) {
            hold_successor(&keys, &handoff.plan.decision.target);
        }
        raw.body = handoff.request_payload;
        let last = execute_v3_responses_direct_runtime_kernel_with_shared_state_default_transport_debug_and_initial_target(
            shared(),&manifest,raw,register_responses_direct_hooks(),&debug,NOW,&handoff.plan,
            Some(handoff.observability_accumulator),Some(handoff.request_execution_control)).await;
        (last.terminal_disposition, last.diagnostic_source)
    } else {
        let first = execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug(
            shared(),&manifest,raw,register_responses_direct_hooks(),&debug,NOW).await;
        let handoff = first
            .protocol_relay_handoff
            .expect("Direct selected the Relay successor");
        assert_eq!(handoff.target.candidate.auth_alias, "B");
        if matches!(successor, Successor::Held) {
            hold_successor(&keys, &handoff.target);
        }
        let seeds = handoff.relay_runtime_seeds();
        let last = execute_v3_responses_relay_runtime_with_default_transport_health(
            &manifest,
            input,
            &health,
            V3ResponsesRelayProviderSnapshotCapture::new(false, false),
            None,
            None,
            Some(handoff.target),
            Some(handoff.expanded),
            handoff.request_local_excluded_candidates,
            seeds,
        )
        .await
        .unwrap();
        (last.terminal_disposition, last.diagnostic_source)
    };
    let calls = entry.calls();
    entry.stop().await;
    match successor {
        Successor::Held => {
            assert_eq!(calls, ["A"]);
            let Some(V3ProviderTerminalDisposition::ExternalHttp(witness)) = terminal else {
                panic!("unqualified actual A after handoff: {terminal:?}, {source:?}");
            };
            assert_eq!(witness.status(), 503);
            assert!(witness
                .headers()
                .iter()
                .any(|(k, v)| k == "content-type" && v == b"application/json"));
            assert_eq!(witness.body(),json!({"error":{"message":"ordinary controlled upstream failure alias=A status=503","type":"server_error"}}).to_string().as_bytes());
        }
        Successor::Truncated => {
            assert_eq!(calls, ["A", "B"]);
            assert!(
                matches!(
                    terminal,
                    Some(
                        V3ProviderTerminalDisposition::NoResponse
                            | V3ProviderTerminalDisposition::ExternalHttp(_)
                    )
                ),
                "{terminal:?}"
            );
        }
        Successor::MissingAuth => {
            assert_eq!(calls, ["A"]);
            assert!(!matches!(
                terminal,
                Some(V3ProviderTerminalDisposition::ExternalHttp(_))
            ));
            let source = source.expect("independent preparation failure must retain a typed cause");
            assert_eq!(
                source.source_kind,
                routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure
            );
            assert_eq!(source.source_stage, "V3Transport13ResponsesHttpRequest");
            assert_eq!(source.code, "provider_local_runtime_error");
            assert!(
                source.message.contains("last auth handle B has no secret"),
                "{source:?}"
            );
            assert!(source.external_error.is_none());
        }
    }
}

#[tokio::test]
async fn relay_direct_handoff_preserves_actual_http() {
    handoff(true, Successor::Held).await;
}
#[tokio::test]
async fn direct_relay_handoff_preserves_actual_http() {
    handoff(false, Successor::Held).await;
}
#[tokio::test]
async fn later_actual_handoff_truncation_replaces_http() {
    handoff(true, Successor::Truncated).await;
    handoff(false, Successor::Truncated).await;
}
#[tokio::test]
async fn later_actual_handoff_truncation_breaks_the_client_transport() {
    let _home = LOCK.lock().await;
    for relay_first in [false, true] {
        let mut entry = Entry::start("active_queue", 0, "hold", false).await;
        entry.handle.take().unwrap().shutdown().await;
        wait_for_listener_close(entry.ports[0]).await;
        entry.manifest = handoff_manifest(&entry, relay_first, Successor::Truncated);
        entry.handle = Some(
            spawn_v3_server_aggregate(entry.manifest.clone())
                .await
                .unwrap(),
        );
        entry.script("A", &[Outcome::Http(503)]);
        entry.script("B", &[Outcome::Truncated]);
        let client = entry.send("actual-truncation", json!("handoff")).await;
        let calls = entry.calls();
        entry.stop().await;
        assert_eq!(calls, ["A", "B"]);
        let error = client.expect_err("actual B truncation must break the client transport");
        assert!(
            !error.is_timeout() && (error.is_request() || error.is_body() || error.is_decode()),
            "{error:?}"
        );
    }
}
#[tokio::test]
async fn independent_local_failure_never_borrows_http() {
    handoff(true, Successor::MissingAuth).await;
}

fn select_direct_entry(entry: &mut Entry, protocol: &str) {
    if matches!(protocol, "anthropic" | "gemini") {
        let binding = entry
            .manifest
            .hub_v1
            .as_mut()
            .unwrap()
            .entry_protocol_bindings
            .iter_mut()
            .find(|binding| binding.entry_protocol == protocol)
            .unwrap();
        binding.execution_mode = routecodex_v3_config::V3EntryProtocolExecutionMode::Direct;
        binding.runtime_owner_symbol = Some(format!("execute_v3_{protocol}_direct_server_outcome"));
        binding.runtime_owner_path = Some("v3/crates/routecodex-v3-server/src/executors.rs".into());
    }
}

async fn final_trial(provider: &'static str, endpoint: &str, payload: Value) {
    let _home = LOCK.lock().await;
    let mut entry = Entry::start_with_protocol("active_queue", 3, "hold", provider, &["A"]).await;
    entry.handle.take().unwrap().shutdown().await;
    wait_for_listener_close(entry.ports[0]).await;
    if endpoint == protocol_input(provider).0 {
        select_direct_entry(&mut entry, provider);
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let clock = Arc::new(Clock(AtomicU64::new(now)));
    entry.handle = Some(
        routecodex_v3_server::spawn_v3_server_aggregate_with_health_observation_clock(
            entry.manifest.clone(),
            clock.clone(),
        )
        .await
        .unwrap(),
    );
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();
    client.post(format!("{}/_routecodex/health/cooldown-pool/add", entry.base))
        .json(&json!({"provider_id":"controlled","interface_id":"default","auth_alias":"A","model_id":"wire","kind":"probe","duration_ms":3600000}))
        .send().await.unwrap().error_for_status().unwrap();
    let before = cooldown(&entry).await;
    clock
        .0
        .store(before["until_ms"].as_u64().unwrap(), Ordering::SeqCst);
    entry.script("A", &[Outcome::Http(500)]);
    let response = client
        .post(format!("{}{endpoint}", entry.base))
        .header("x-session-id", "only-trial")
        .json(&payload)
        .send()
        .await;
    let after = cooldown(&entry).await;
    let calls = entry.calls();
    let mut held = Vec::new();
    for index in 2..=4 {
        held.push(
            entry.queue().await["pools"][0]["held"]
                .as_array()
                .unwrap()
                .len(),
        );
        entry.script("A", &[Outcome::Http(500)]);
        client
            .post(format!("{}{endpoint}", entry.base))
            .header("x-session-id", format!("independent-{index}"))
            .json(&payload)
            .send()
            .await
            .expect_err("sole candidate HTTP 500 must break transport cleanly");
    }
    let final_queue = entry.queue().await;
    let all_calls = entry.calls();
    let ports = entry.ports;
    entry.stop().await;
    for port in ports {
        drop(
            tokio::net::TcpListener::bind(("127.0.0.1", port))
                .await
                .unwrap(),
        );
    }
    assert_eq!(
        calls,
        ["A"],
        "{provider} {endpoint} repeated the only trial"
    );
    assert_eq!(all_calls, ["A"; 4]);
    assert_eq!(held, [0; 3]);
    assert_eq!(final_queue["pools"][0]["held"][0]["auth_alias"], "A");
    for field in ["until_ms", "failure_count", "kind", "reason"] {
        assert_eq!(after[field], before[field], "{field}");
    }
    response
        .expect_err("final only failed trial must break transport without client error projection");
}

#[tokio::test]
async fn final_only_failed_direct_trial_ends_active_episode() {
    final_trial(
        "responses",
        "/v1/responses",
        json!({"model":"client","input":"trial"}),
    )
    .await;
}

#[tokio::test]
async fn final_only_failed_relay_trial_ends_active_episode() {
    final_trial(
        "openai_chat",
        "/v1/responses",
        json!({"model":"client","input":"trial"}),
    )
    .await;
}

fn protocol_input(protocol: &str) -> (&'static str, Value) {
    match protocol {
        "responses" => ("/v1/responses", json!({"model":"client","input":"trial"})),
        "openai_chat" => (
            "/v1/chat/completions",
            json!({"model":"client","messages":[{"role":"user","content":"trial"}]}),
        ),
        "anthropic" => (
            "/v1/messages",
            json!({"model":"client","max_tokens":32,"messages":[{"role":"user","content":"trial"}]}),
        ),
        "gemini" => (
            "/v1beta/models/client:generateContent",
            json!({"contents":[{"role":"user","parts":[{"text":"trial"}]}]}),
        ),
        _ => unreachable!(),
    }
}

#[tokio::test]
async fn final_only_failed_trial_protocol_codecs() {
    for protocol in ["openai_chat", "anthropic", "gemini"] {
        let (path, body) = protocol_input(protocol);
        final_trial(protocol, path, body.clone()).await;
        final_trial("responses", path, body).await;
    }
}

struct WindowClock {
    upstream: Arc<Upstream>,
    open: u64,
    observations: AtomicU64,
    close_at: u64,
}
impl std::fmt::Debug for WindowClock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WindowClock")
    }
}
impl routecodex_v3_runtime::V3ProviderHealthObservationClock for WindowClock {
    fn now_epoch_ms(&self) -> u64 {
        if !self.upstream.script.lock().unwrap().calls.is_empty() {
            let n = self.observations.fetch_add(1, Ordering::SeqCst) + 1;
            if n >= self.close_at {
                return self.open + 12 * 3_600_000;
            }
        }
        self.open
    }
}

async fn server_skipped_retry(protocol: &'static str) {
    let _home = LOCK.lock().await;
    let mut entry = Entry::start_with_protocol("active_queue", 3, "hold", protocol, &["A"]).await;
    entry.handle.take().unwrap().shutdown().await;
    wait_for_listener_close(entry.ports[0]).await;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let hour = (now / 3_600_000) % 24;
    let availability=serde_json::from_value(json!({"timezone":"UTC","periods":[{"start":format!("{:02}:00",(hour+23)%24),"end":format!("{:02}:00",(hour+2)%24)}]})).unwrap();
    entry
        .manifest
        .providers
        .get_mut("controlled")
        .unwrap()
        .models
        .get_mut("wire")
        .unwrap()
        .availability = Some(availability);
    // The first six post-response observations cover failure settlement and the
    // active retry decision. The next selection observes the closed model window.
    select_direct_entry(&mut entry, protocol);
    let clock = Arc::new(WindowClock {
        upstream: entry.state.clone(),
        open: now,
        observations: AtomicU64::new(0),
        close_at: 7,
    });
    entry.handle = Some(
        routecodex_v3_server::spawn_v3_server_aggregate_with_health_observation_clock(
            entry.manifest.clone(),
            clock.clone(),
        )
        .await
        .unwrap(),
    );
    entry.script("A", &[Outcome::Http(503)]);
    let (path, body) = protocol_input(protocol);
    let response = reqwest::Client::new()
        .post(format!("{}{path}", entry.base))
        .header("x-session-id", "window")
        .json(&body)
        .send()
        .await;
    let calls = entry.calls();
    entry.stop().await;
    assert_eq!(calls, ["A"], "{protocol}");
    assert!(clock.observations.load(Ordering::SeqCst) >= clock.close_at);
    response
        .expect_err("single-candidate 503 after skipped retry must terminate transport cleanly");
}
#[tokio::test]
async fn direct_skipped_retry_projects_exact_http_through_server() {
    for protocol in ["responses", "openai_chat", "anthropic", "gemini"] {
        server_skipped_retry(protocol).await;
    }
}
