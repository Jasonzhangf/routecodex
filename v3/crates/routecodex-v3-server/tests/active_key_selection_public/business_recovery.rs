//! Real business recovery must compose with active membership and queue holds.
use super::*;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    OnceLock,
};
use tokio::sync::Semaphore;

struct BusinessGate {
    entered: Semaphore,
    released: Semaphore,
}
static GATE: OnceLock<Mutex<Option<Arc<BusinessGate>>>> = OnceLock::new();
struct GateOwner(Arc<BusinessGate>);
impl GateOwner {
    fn new() -> Self {
        let gate = Arc::new(BusinessGate {
            entered: Semaphore::new(0),
            released: Semaphore::new(0),
        });
        assert!(GATE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap()
            .replace(gate.clone())
            .is_none());
        Self(gate)
    }
    async fn entered(&self) {
        tokio::time::timeout(Duration::from_secs(5), self.0.entered.acquire())
            .await
            .expect("actual trial reaches upstream")
            .unwrap()
            .forget();
    }
    fn release(&self) {
        self.0.released.add_permits(1);
    }
}
impl Drop for GateOwner {
    fn drop(&mut self) {
        self.0.released.add_permits(1);
        GATE.get().unwrap().lock().unwrap().take();
    }
}
pub(super) async fn wait_for_business_gate() {
    let gate = GATE
        .get()
        .unwrap()
        .lock()
        .unwrap()
        .clone()
        .expect("explicit fixture gate owner");
    gate.entered.add_permits(1);
    gate.released.acquire().await.unwrap().forget();
}

#[derive(Debug)]
struct Clock(AtomicU64);
impl routecodex_v3_runtime::V3ProviderHealthObservationClock for Clock {
    fn now_epoch_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}
struct Refill;
impl Drop for Refill {
    fn drop(&mut self) {
        routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(None);
    }
}

#[derive(Clone, Copy, Debug)]
enum Path {
    ResponsesDirect,
    ChatDirect,
    ResponsesRelay,
    ChatRelay,
    AnthropicRelay,
}
const PATHS: [Path; 5] = [
    Path::ResponsesDirect,
    Path::ChatDirect,
    Path::ResponsesRelay,
    Path::ChatRelay,
    Path::AnthropicRelay,
];
impl Path {
    async fn entry(self, strategy: &str) -> (Entry, Arc<Clock>) {
        let protocol = match self {
            Self::ChatDirect | Self::ResponsesRelay => "openai_chat",
            _ => "responses",
        };
        let mut entry =
            Entry::start_with_protocol(strategy, 3, "hold", protocol, &["A", "B"]).await;
        entry.handle.take().unwrap().shutdown().await;
        wait_for_listener_close(entry.ports[0]).await;
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
        (entry, clock)
    }
    async fn send(self, base: &str, session: &str) -> Result<String, String> {
        let (endpoint, payload) = match self {
            Self::ResponsesDirect | Self::ResponsesRelay => (
                "/v1/responses",
                json!({"model":"client","input":"recovery composition"}),
            ),
            Self::ChatDirect | Self::ChatRelay => (
                "/v1/chat/completions",
                json!({"model":"client","messages":[{"role":"user","content":"recovery composition"}]}),
            ),
            Self::AnthropicRelay => (
                "/v1/messages",
                json!({"model":"client","max_tokens":32,"messages":[{"role":"user","content":"recovery composition"}]}),
            ),
        };
        let response = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap()
            .post(format!("{base}{endpoint}"))
            .header("x-session-id", session)
            .json(&payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        let body = response.text().await.map_err(|e| e.to_string())?;
        if status != StatusCode::OK {
            return Err(format!("{status}: {body}"));
        }
        Ok(body)
    }
    fn alias(self, body: &str) -> String {
        let value: Value = serde_json::from_str(body).unwrap();
        match self {
            Self::ResponsesDirect | Self::ResponsesRelay => text(body),
            Self::ChatDirect | Self::ChatRelay => value["choices"][0]["message"]["content"]
                .as_str()
                .unwrap()
                .into(),
            Self::AnthropicRelay => value["content"][0]["text"].as_str().unwrap().into(),
        }
    }
}
async fn cooldown(base: &str) -> Option<Value> {
    reqwest::get(format!("{base}/_routecodex/health/cooldown-pool"))
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap()["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| {
            e["provider_id"] == "controlled"
                && e["interface_id"] == "default"
                && e["model_id"] == "wire"
                && e["auth_alias"] == "A"
        })
        .cloned()
}
async fn make_due(entry: &Entry, clock: &Clock) {
    let response=reqwest::Client::new().post(format!("{}/_routecodex/health/cooldown-pool/add",entry.base)).json(&json!({"provider_id":"controlled","interface_id":"default","auth_alias":"A","model_id":"wire","kind":"probe","duration_ms":3600000})).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let health = cooldown(&entry.base).await.expect("manual exact cooldown");
    clock
        .0
        .store(health["until_ms"].as_u64().unwrap(), Ordering::SeqCst);
}

#[tokio::test]
async fn due_active_head_has_one_business_trial_while_other_requests_use_b() {
    let _home = LOCK.lock().await;
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    let _refill = Refill;
    for path in PATHS {
        let (entry, clock) = path.entry("active_queue").await;
        make_due(&entry, &clock).await;
        let gate = GateOwner::new();
        entry.script("A", &[Outcome::GatedOk]);
        let base = entry.base.clone();
        let first = tokio::spawn(async move { path.send(&base, "trial-owner").await });
        gate.entered().await;
        let during = cooldown(&entry.base).await;
        let second = path.send(&entry.base, "trial-contender").await;
        let during_calls = entry.calls();
        gate.release();
        let first = first.await.unwrap();
        let after = cooldown(&entry.base).await;
        let next = path.send(&entry.base, "trial-recovered").await;
        let calls = entry.calls();
        let queue = entry.queue().await;
        entry.stop().await;
        assert_eq!(during.as_ref().unwrap()["state"], "probing", "{path:?}");
        assert_eq!(path.alias(&second.unwrap()), "B", "{path:?}");
        assert_eq!(during_calls, ["A", "B"], "{path:?}");
        assert_eq!(path.alias(&first.unwrap()), "A", "{path:?}");
        assert!(after.is_none(), "{path:?}: {after:?}");
        assert_eq!(path.alias(&next.unwrap()), "A", "{path:?}");
        assert_eq!(calls, ["A", "B", "A"], "{path:?}");
        assert!(queue["pools"][0]["held"].as_array().unwrap().is_empty());
    }
}

#[tokio::test]
async fn held_active_member_cannot_acquire_trial_and_release_keeps_health() {
    let _home = LOCK.lock().await;
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    let _refill = Refill;
    for path in PATHS {
        let (entry, clock) = path.entry("round_robin").await;
        entry.script("A", &[Outcome::Http(500); 4]);
        let failed = path.send(&entry.base, "hold-A").await;
        make_due(&entry, &clock).await;
        let before = cooldown(&entry.base).await;
        let held = path.send(&entry.base, "held-due").await;
        let held_calls = entry.calls();
        let queue = entry.queue().await;
        let release = entry.release("A").await;
        let released_health = cooldown(&entry.base).await;
        let one = path.send(&entry.base, "tail-B").await;
        let two = path.send(&entry.base, "tail-A-trial").await;
        let after = cooldown(&entry.base).await;
        let calls = entry.calls();
        entry.stop().await;
        assert_eq!(path.alias(&failed.unwrap()), "B", "{path:?}");
        assert_eq!(path.alias(&held.unwrap()), "B", "{path:?}");
        assert_eq!(queue["pools"][0]["held"][0]["auth_alias"], "A");
        assert_eq!(held_calls, ["A", "A", "A", "A", "B", "B"]);
        assert_eq!(release["released"], true);
        assert_eq!(released_health, before, "release must not settle health");
        assert_eq!(path.alias(&one.unwrap()), "B");
        assert_eq!(path.alias(&two.unwrap()), "A");
        assert!(after.is_none(), "{path:?}: {after:?}");
        assert_eq!(calls, ["A", "A", "A", "A", "B", "B", "B", "A"], "{path:?}");
    }
}

#[tokio::test]
async fn failed_owned_trial_defers_without_spending_active_retry_budget() {
    let _home = LOCK.lock().await;
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    let _refill = Refill;
    for path in PATHS {
        let (entry, clock) = path.entry("active_queue").await;
        make_due(&entry, &clock).await;
        entry.script("A", &[Outcome::Http(500)]);
        let first = path.send(&entry.base, "trial-failed").await;
        let health = cooldown(&entry.base).await;
        let next = path.send(&entry.base, "deferred-trial").await;
        let calls = entry.calls();
        let queue = entry.queue().await;
        entry.stop().await;
        assert_eq!(path.alias(&first.unwrap()), "B", "{path:?}");
        assert_eq!(path.alias(&next.unwrap()), "B", "{path:?}");
        assert!(health.is_some(), "failed trial keeps cooldown");
        assert_eq!(calls, ["A", "B", "B"], "{path:?}");
        assert!(
            queue["pools"][0]["held"].as_array().unwrap().is_empty(),
            "one dispatched failure is below fourth threshold"
        );
    }
}
