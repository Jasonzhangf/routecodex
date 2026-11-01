//! Actual managed control/exec rejection must retain scheduled probe recovery.
use super::*;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc, Arc,
};

const SPARE_SECRET: &str = "managed-rollback-spare-secret";

fn business_response() -> Value {
    serde_json::json!({"id":"resp_p0_live","object":"response","created_at":0,"status":"completed","model":"wire-test","output":[{"id":"msg","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"uncached connection probe","annotations":[]}]},{"id":"fc","type":"function_call","call_id":"paired-call","name":"fixture","arguments":"{invalid arguments preserved","status":"completed"}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2},"tail":{"complete":[1,2,3]}})
}

struct ProbePeer {
    port: u16,
    captures: mpsc::Receiver<Value>,
    probes: Arc<AtomicUsize>,
    active: Arc<AtomicUsize>,
    old_closed: Arc<AtomicBool>,
    total: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    task: Option<std::thread::JoinHandle<()>>,
}

impl ProbePeer {
    fn start() -> Self {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let (tx, captures) = mpsc::channel();
        let probes = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let old_closed = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let total = Arc::new(AtomicUsize::new(0));
        let (worker_probes, worker_active, worker_closed, worker_stop, worker_total) = (
            probes.clone(),
            active.clone(),
            old_closed.clone(),
            stop.clone(),
            total.clone(),
        );
        let task = std::thread::spawn(move || {
            let mut requests = Vec::new();
            while !worker_stop.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("probe peer accept: {error}"),
                };
                let (tx, probes, active, closed, stop, total) = (
                    tx.clone(),
                    worker_probes.clone(),
                    worker_active.clone(),
                    worker_closed.clone(),
                    worker_stop.clone(),
                    worker_total.clone(),
                );
                worker_active.fetch_add(1, Ordering::SeqCst);
                requests.push(std::thread::spawn(move || {
                    stream.set_nonblocking(false).unwrap();
                    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    assert!(line.starts_with("POST /v1/responses "), "{line}");
                    let mut length = None;
                    let mut auth_alias = None;
                    loop {
                        line.clear();
                        assert!(reader.read_line(&mut line).unwrap() > 0, "complete request headers required");
                        if line == "\r\n" { break; }
                        let lower = line.to_ascii_lowercase();
                        if let Some(value) = lower.strip_prefix("content-length:") { length = Some(value.trim().parse::<usize>().unwrap()); }
                        if lower.trim() == format!("authorization: bearer {SECRET}") { auth_alias = Some("key"); }
                        if lower.trim() == format!("authorization: bearer {SPARE_SECRET}") { auth_alias = Some("spare"); }
                    }
                    let auth_alias = auth_alias.expect("exact auth-key transport required");
                    let mut bytes = vec![0; length.unwrap()];
                    reader.read_exact(&mut bytes).unwrap();
                    let body: Value = serde_json::from_slice(&bytes).unwrap();
                    let probe = body.to_string().contains("ping; reply pong") || body.to_string().contains("Reply exactly OK. Do not call tools.");
                    eprintln!("FA22072 peer complete POST /v1/responses auth_alias={auth_alias} probe={probe} content_length={} body={body}", bytes.len());
                    assert_eq!(body["model"], "wire-test");
                    total.fetch_add(1, Ordering::SeqCst);
                    tx.send(serde_json::json!({"probe":probe,"body":body,"auth_alias":auth_alias})).unwrap();
                    if probe { assert_eq!(auth_alias, "key", "probe must use cooled exact key"); }
                    if probe && probes.fetch_add(1, Ordering::SeqCst) == 0 {
                        // Never open a remote response gate. Cancellation must
                        // close the actual socket and release local ownership.
                        stream.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
                        let mut byte = [0];
                        while !stop.load(Ordering::SeqCst) {
                            match stream.read(&mut byte) {
                                Ok(0) | Err(_) if stop.load(Ordering::SeqCst) => break,
                                Ok(0) => { eprintln!("FA22072 managed probe A exact socket EOF"); closed.store(true, Ordering::SeqCst); break; }
                                Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                                Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => { eprintln!("FA22072 managed probe A reset kind={:?} os={:?}: {error}", error.kind(), error.raw_os_error()); closed.store(true, Ordering::SeqCst); break; }
                                Err(error) => panic!("unclassified held probe socket failure: {error}"),
                                Ok(_) => panic!("unexpected bytes on held probe"),
                            }
                        }
                    } else {
                        let response = if probe { "real 2xx probe".to_string() } else {
                            business_response().to_string()
                        };
                        eprintln!("FA22072 peer response probe={probe} status=200 body={response}");
                        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).unwrap();
                    }
                    drop(reader);
                    drop(stream);
                    active.fetch_sub(1, Ordering::SeqCst);
                }));
            }
            for request in requests {
                request.join().unwrap();
            }
        });
        Self {
            port,
            captures,
            probes,
            active,
            old_closed,
            total,
            stop,
            task: Some(task),
        }
    }
    fn next_probe(&self, duration: Duration) {
        let deadline = Instant::now() + duration;
        loop {
            let capture = self.captures.recv_timeout(deadline.saturating_duration_since(Instant::now())).expect("retained managed runtime must issue scheduled authenticated probe before recovery business");
            if capture["probe"] == true {
                assert_eq!(capture["body"]["model"], "wire-test");
                assert_eq!(capture["auth_alias"], "key");
                return;
            }
        }
    }
}
impl Drop for ProbePeer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if self.task.take().unwrap().join().is_err() {
            if std::thread::panicking() {
                eprintln!("managed rollback peer failed during fixture cleanup");
            } else {
                panic!("managed rollback peer failed");
            }
        }
    }
}

fn add_cooldown(port: u16, model: &str, duration_ms: u64) {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let response = reqwest::Client::new().post(format!("http://127.0.0.1:{port}/_routecodex/health/cooldown-pool/add")).json(&serde_json::json!({"provider_id":"rollback","interface_id":"default","auth_alias":"key","model_id":model,"kind":"probe","duration_ms":duration_ms})).send().await.unwrap();
        assert_eq!(response.status(),200);
    });
}
fn cooled(pool: &Value, model: &str) -> Value {
    pool["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| {
            entry["provider_id"] == "rollback"
                && entry["model_id"] == model
                && entry["kind"] == "probe"
        })
        .unwrap()
        .clone()
}
fn wait_until(predicate: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while !predicate() {
        assert!(
            Instant::now() < deadline,
            "managed rollback ownership was not released"
        );
        sleep(Duration::from_millis(5));
    }
}

#[test]
fn managed_control_rejection_restores_due_only_probe_owner() {
    witness(false);
}
#[test]
fn managed_native_exec_error_restores_due_only_probe_owner() {
    witness(true);
}

fn witness(native_exec: bool) {
    let _guard = lifecycle_test_guard();
    std::env::set_var("FA22072_CLI_SPARE_KEY", SPARE_SECRET);
    let root = TempDir::new().unwrap();
    let state = root.path().join("state");
    let ports = [free_port(), free_port()];
    let peer = ProbePeer::start();
    let config = root.path().join("config.v3.toml");
    fs::write(&config,format!(r#"version = 3
{HUB_V1_TEST_DECLARATION}
[features]
responses_direct = true
[debug]
log_console = true
snapshots = false
[servers.a]
bind = "127.0.0.1"
port = {}
routing_group = "default"
endpoints = ["responses", "openai_chat"]
[servers.b]
bind = "127.0.0.1"
port = {}
routing_group = "default"
endpoints = ["responses", "openai_chat"]
{HUB_V1_TEST_SERVER_EXECUTION}
[providers.rollback]
type = "responses"
base_url = "http://127.0.0.1:{}/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_MANAGED_TEST_KEY" }}, {{ alias = "spare", env = "FA22072_CLI_SPARE_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
concurrency = {{ max_in_flight = 1, acquire_timeout_ms = 60000, stale_lease_ms = 120000 }}
[providers.rollback.models.test]
wire_name = "wire-test"
capabilities = ["text"]
[providers.rollback.models.sibling]
wire_name = "wire-test"
capabilities = ["text"]
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "rollback", model = "test", key = "key", priority = 100 }}, {{ kind = "provider_model", provider = "rollback", model = "sibling", key = "spare", priority = 90 }}]
"#,ports[0],ports[1],peer.port)).unwrap();
    let process = p0_start(&root, &state, &config);
    let owner = single_instance_dir(&state);
    let control_bytes = fs::read(owner.join("control.json")).unwrap();
    let control: Value = serde_json::from_slice(&control_bytes).unwrap();
    sleep(Duration::from_millis(100));
    rollback_business(ports[0], root.path(), &state, "auto");
    eprintln!("FA22072 healthy pre-cooldown success control completed");
    add_cooldown(ports[0], "test", 5000);
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let response = reqwest::Client::new().post(format!("http://127.0.0.1:{}/v1/chat/completions", ports[0]))
            .json(&serde_json::json!({"model":"auto","messages":[{"role":"user","content":"uncached connection probe"}],"stream":false}))
            .timeout(Duration::from_secs(5)).send().await.unwrap();
        assert_eq!(response.status(), 200);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["choices"][0]["message"]["content"], "uncached connection probe");
    });
    eprintln!(
        "FA22072 after cooled business pool={}",
        http_get_json(ports[0], "/_routecodex/health/cooldown-pool")
    );
    peer.next_probe(Duration::from_secs(2));
    let before = cooled(
        &http_get_json(ports[0], "/_routecodex/health/cooldown-pool"),
        "test",
    );
    assert_eq!(before["state"], "probing");
    assert_eq!(before["interface_id"], "default");
    assert_eq!(before["auth_alias"], "key");
    assert!(!peer.old_closed.load(Ordering::SeqCst));
    assert_eq!(
        peer.active.load(Ordering::SeqCst),
        1,
        "only complete held exact-key probe A owns peer transport"
    );
    add_cooldown(ports[0], "sibling", 60000);
    let sibling = cooled(
        &http_get_json(ports[0], "/_routecodex/health/cooldown-pool"),
        "sibling",
    );
    let invalid = root.path().join("invalid-exec");
    fs::write(&invalid, b"#!/nonexistent/fa22072-probe-interpreter\n").unwrap();
    fs::set_permissions(&invalid, fs::Permissions::from_mode(0o700)).unwrap();
    let blocker = owner.join("front-handoff.json");
    if !native_exec {
        fs::create_dir(&blocker).unwrap();
    }
    fs::write(owner.join("restart.plan.json"),serde_json::to_vec(&serde_json::json!({"schema_version":1,"instance_id":control["instance_id"],"start_nonce":control["start_nonce"],"executable_path":invalid,"target_declaration":null,"snapshots":false,"snapshot_direct":false,"snapshot_stages":null,"sse_dump":false})).unwrap()).unwrap();
    let mut stream = p0_control_stream(&control);
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .unwrap();
    writeln!(stream,"{}",serde_json::json!({"schema_version":1,"instance_id":control["instance_id"],"start_nonce":control["start_nonce"],"operation":"restart","ports":null})).unwrap();
    let mut response = String::new();
    BufReader::new(stream).read_line(&mut response).unwrap();
    let response: Value = serde_json::from_str(&response).unwrap();
    eprintln!("FA22072 actual managed restart native_exec={native_exec} response={response}");
    assert_eq!(response["accepted"], false, "{response}");
    let message = response["message"].as_str().unwrap();
    if native_exec {
        assert!(
            message.contains("exec restart rejected; original owner retained")
                && message.contains("os error 2"),
            "{message}"
        );
    } else {
        assert!(
            message.contains("restart handoff already exists"),
            "{message}"
        );
        fs::remove_dir(&blocker).unwrap();
    }
    wait_until(|| {
        peer.old_closed.load(Ordering::SeqCst) && peer.active.load(Ordering::SeqCst) == 0
    });
    let after = cooled(
        &http_get_json(ports[0], "/_routecodex/health/cooldown-pool"),
        "test",
    );
    assert_ne!(after["state"], "probing");
    assert_eq!(after["until_ms"], before["until_ms"]);
    assert_eq!(after["failure_count"], before["failure_count"]);
    for port in ports {
        assert_eq!(http_get_json(port, "/health")["status"], "ok");
    }
    sleep(Duration::from_millis(300));
    assert_eq!(
        peer.probes.load(Ordering::SeqCst),
        1,
        "rollback must preserve future due time"
    );
    peer.next_probe(Duration::from_secs(8));
    eprintln!("FA22072 scheduled exact-key B admitted after A EOF with declared one-slot capacity; no recovery business yet");
    wait_until(|| {
        !http_get_json(ports[0], "/_routecodex/health/cooldown-pool")["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["provider_id"] == "rollback" && entry["model_id"] == "test")
    });
    let after = cooled(
        &http_get_json(ports[0], "/_routecodex/health/cooldown-pool"),
        "sibling",
    );
    assert_eq!(after["until_ms"], sibling["until_ms"]);
    assert_eq!(after["failure_count"], sibling["failure_count"]);
    rollback_business(ports[0], root.path(), &state, "auto");
    let recovery = peer.captures.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(recovery["probe"], false);
    assert_eq!(
        recovery["auth_alias"], "key",
        "released exact-auth business admission"
    );
    assert_eq!(fs::read(owner.join("control.json")).unwrap(), control_bytes);
    let cache: Value = serde_json::from_slice(&fs::read(owner.join("pid.cache")).unwrap()).unwrap();
    assert_eq!(cache["pid"].as_u64().unwrap(), u64::from(process.pid));
    assert_eq!(cache["start_nonce"], control["start_nonce"]);
    assert!(!owner.join("front-handoff.json").exists());
    assert!(!owner.join("provider-handoff.json").exists());
    drop(process);
    wait_until(|| peer.active.load(Ordering::SeqCst) == 0);
    let count = peer.probes.load(Ordering::SeqCst);
    let captures = peer.total.load(Ordering::SeqCst);
    sleep(Duration::from_millis(1100));
    assert_eq!(count, 2);
    assert_eq!(
        peer.probes.load(Ordering::SeqCst),
        count,
        "terminal managed shutdown must suppress captures"
    );
    assert_eq!(
        peer.total.load(Ordering::SeqCst),
        captures,
        "no captures after terminal cleanup"
    );
}

fn rollback_business(port: u16, workdir: &Path, state: &Path, model: &str) {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let response = reqwest::Client::new()
                .post(format!("http://127.0.0.1:{port}/v1/responses"))
                .header("x-routecodex-workdir", workdir.display().to_string())
                .json(&serde_json::json!({"model":model,"input":"uncached connection probe","stream":false}))
                .timeout(Duration::from_secs(5)).send().await.unwrap();
            assert_eq!(response.status(), 200);
            let response: Value = response.json().await.unwrap();
            assert_eq!(response["id"], "resp_p0_live");
            assert_eq!(response["status"], "completed");
            assert_eq!(response["output"][0]["content"][0]["text"], "uncached connection probe");
            assert_eq!(response, business_response(), "complete response/tool/usage/tail fidelity");
        });
    }));
    if let Err(error) = outcome {
        eprintln!(
            "FA22072 first-business typed/runtime evidence: {}",
            state_root_diagnostics(state)
        );
        std::panic::resume_unwind(error);
    }
}
