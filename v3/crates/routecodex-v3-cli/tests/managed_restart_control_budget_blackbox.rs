//! Public-entry control-budget regressions using an external typed Unix peer.
//! The peer exercises CLI protocol behavior; it does not claim a native server upgrade.
//! Run: CARGO_NET_OFFLINE=true cargo test --release --locked --manifest-path
//! v3/Cargo.toml -p routecodex-v3-cli --test managed_restart_control_budget_blackbox -- --nocapture

use routecodex_v3_lifecycle::{
    V3ManagedControlRecord, V3ManagedLifecycle, V3ManagedPidCache, V3ManagedRunState,
    V3ManagedStatusRecord,
};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tempfile::TempDir;

const REFUSAL: &str =
    "exec preparation refused: fixture checkpoint unavailable; original owner retained";

struct ControlPeer {
    root: TempDir,
    config: PathBuf,
    state: PathBuf,
    stop: Arc<AtomicBool>,
    first_request_at: Arc<Mutex<Option<Instant>>>,
    task: Option<JoinHandle<()>>,
}

impl ControlPeer {
    fn start(
        restart_delay: Duration,
        accepted: bool,
        refresh_nonce: bool,
        status_delay: Duration,
    ) -> Self {
        // Keep the Unix socket below platform sockaddr_un length limits.
        let root = tempfile::Builder::new()
            .prefix("rcc-budget-")
            .tempdir_in("/tmp")
            .unwrap();
        let config = root.path().join("config.v3.toml");
        let state = root.path().join("state");
        fs::create_dir(root.path().join("home")).unwrap();
        // This external management peer owns no model listener. The declared
        // port is only part of its typed identity; native listeners are tested separately.
        let port = 45499;
        fs::write(&config, format!(r#"version = 3
[servers.test]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
[providers.test]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_RESTART_BUDGET_TEST_KEY" }}] }}
[providers.test.models.test]
wire_name = "test"
capabilities = ["text"]
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }}]
"#)).unwrap();
        let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
        let (declaration, _) = lifecycle.declaration(env!("CARGO_BIN_EXE_rccv3")).unwrap();
        let owner = state.join("instances").join(&declaration.instance_id);
        fs::create_dir_all(&owner).unwrap();
        let socket = root.path().join("control.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut cache = V3ManagedPidCache {
            schema_version: 1,
            instance_id: declaration.instance_id.clone(),
            pid: std::process::id(),
            start_nonce: "external-peer-original".into(),
            started_at_epoch_ms: 1,
            process_start_token: None,
        };
        let control = V3ManagedControlRecord {
            schema_version: 1,
            instance_id: declaration.instance_id.clone(),
            socket_path: socket.to_str().unwrap().into(),
            start_nonce: cache.start_nonce.clone(),
        };
        let status = V3ManagedStatusRecord {
            schema_version: 1,
            instance_id: declaration.instance_id.clone(),
            state: V3ManagedRunState::Running,
            updated_at_epoch_ms: 1,
            detail: None,
        };
        for (file, value) in [
            ("instance.json", serde_json::to_value(&declaration).unwrap()),
            ("pid.cache", serde_json::to_value(&cache).unwrap()),
            ("control.json", serde_json::to_value(&control).unwrap()),
            ("status.json", serde_json::to_value(&status).unwrap()),
        ] {
            fs::write(owner.join(file), serde_json::to_vec(&value).unwrap()).unwrap();
        }
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let first_request_at = Arc::new(Mutex::new(None));
        let worker_first_request_at = first_request_at.clone();
        let task = thread::spawn(move || {
            while !worker_stop.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("external control peer accept failed: {error}"),
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut line = String::new();
                BufReader::new(stream.try_clone().unwrap())
                    .read_line(&mut line)
                    .unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                assert_eq!(request["schema_version"], 1);
                assert_eq!(request["instance_id"], declaration.instance_id);
                assert!(
                    request["start_nonce"] == cache.start_nonce,
                    "control nonce mismatch"
                );
                let restart = request["operation"] == "restart";
                assert!(restart || request["operation"] == "status");
                worker_first_request_at
                    .lock()
                    .unwrap()
                    .get_or_insert_with(Instant::now);
                let delay = if restart { restart_delay } else { status_delay };
                let until = Instant::now() + delay;
                while Instant::now() < until && !worker_stop.load(Ordering::SeqCst) {
                    thread::sleep(Duration::from_millis(5));
                }
                if worker_stop.load(Ordering::SeqCst) {
                    break;
                }
                if restart && accepted {
                    if refresh_nonce {
                        cache.start_nonce = "external-peer-replacement".into();
                        let mut control = control.clone();
                        control.start_nonce = cache.start_nonce.clone();
                        fs::write(owner.join("pid.cache"), serde_json::to_vec(&cache).unwrap())
                            .unwrap();
                        fs::write(
                            owner.join("control.json"),
                            serde_json::to_vec(&control).unwrap(),
                        )
                        .unwrap();
                    }
                }
                let response = json!({
                    "schema_version": 1, "instance_id": declaration.instance_id,
                    "accepted": !restart || accepted,
                    "state": if restart && accepted { "starting" } else { "running" },
                    "message": if restart && !accepted { REFUSAL } else { "identity verified" },
                });
                // A timed-out CLI may have closed this external transport.
                if let Err(error) = writeln!(stream, "{response}") {
                    assert!(matches!(
                        error.kind(),
                        std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
                    ));
                }
            }
        });
        Self {
            root,
            config,
            state,
            stop,
            first_request_at,
            task: Some(task),
        }
    }

    fn cli(&self, command: &str, budget_ms: Option<u64>) -> (Output, Duration) {
        let mut cli = Command::new(env!("CARGO_BIN_EXE_rccv3"));
        cli.arg(command)
            .arg("-c")
            .arg(&self.config)
            .env("HOME", self.root.path().join("home"))
            .env("ROUTECODEX_V3_STATE_DIR", &self.state)
            .env("V3_RESTART_BUDGET_TEST_KEY", "isolated-control-peer-key");
        if let Some(budget_ms) = budget_ms {
            cli.arg("--timeout-ms").arg(budget_ms.to_string());
        }
        let started = Instant::now();
        let output = cli.output().unwrap();
        let finished = Instant::now();
        // CLI bootstrap/config authoring precedes the control exchange. Measure
        // the peer-observable budget, and retain total process time separately.
        let first_request_at = self
            .first_request_at
            .lock()
            .unwrap()
            .expect("real CLI must reach the external control peer");
        eprintln!(
            "{command} setup={:?} total={:?}",
            first_request_at.duration_since(started),
            finished.duration_since(started)
        );
        (output, finished.duration_since(first_request_at))
    }
}

impl Drop for ControlPeer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let result = self.task.take().unwrap().join();
        if !thread::panicking() {
            result.unwrap();
        }
    }
}

#[test]
fn restart_preserves_delayed_peer_rejection_within_declared_budget() {
    let peer = ControlPeer::start(Duration::from_millis(2500), false, false, Duration::ZERO);
    let (output, elapsed) = peer.cli("restart", Some(5000));
    let stderr = String::from_utf8_lossy(&output.stderr);
    eprintln!(
        "delayed rejection elapsed={elapsed:?} exit={} stderr={stderr}",
        output.status
    );
    assert!(!output.status.success());
    assert!(
        stderr.contains(REFUSAL),
        "real rejection was replaced: {stderr}"
    );
    assert!(!stderr.contains("timed out"));
}

#[test]
fn restart_accepts_delayed_ack_only_after_exact_replacement_observed() {
    let peer = ControlPeer::start(Duration::from_millis(2500), true, true, Duration::ZERO);
    let (output, elapsed) = peer.cli("restart", Some(5000));
    eprintln!(
        "external peer replacement elapsed={elapsed:?} exit={}",
        output.status
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let json_start = stdout.find('{').expect("CLI must return status JSON");
    let status: Value = serde_json::from_str(&stdout[json_start..]).unwrap();
    assert_eq!(status["state"], "running");
}

#[test]
fn restart_short_declared_budget_expires_during_control_exchange() {
    let peer = ControlPeer::start(Duration::from_millis(1500), false, false, Duration::ZERO);
    let (output, elapsed) = peer.cli("restart", Some(500));
    let stderr = String::from_utf8_lossy(&output.stderr);
    eprintln!(
        "short budget elapsed={elapsed:?} exit={} stderr={stderr}",
        output.status
    );
    assert!(!output.status.success());
    assert!(stderr.contains("timed out"), "{stderr}");
    assert!(elapsed >= Duration::from_millis(450));
    assert!(elapsed < Duration::from_millis(1250), "{elapsed:?}");
}

#[test]
fn restart_ack_and_replacement_wait_share_one_declared_budget() {
    let peer = ControlPeer::start(
        Duration::from_millis(750),
        true,
        false,
        Duration::from_millis(2000),
    );
    let (output, elapsed) = peer.cli("restart", Some(1200));
    let stderr = String::from_utf8_lossy(&output.stderr);
    eprintln!(
        "shared budget elapsed={elapsed:?} exit={} stderr={stderr}",
        output.status
    );
    assert!(
        !output.status.success(),
        "ACK without replacement is not completion"
    );
    assert!(stderr.contains("timed out"), "{stderr}");
    assert!(elapsed >= Duration::from_millis(1100));
    assert!(
        elapsed < Duration::from_millis(1750),
        "budget reset or Status overrun: {elapsed:?}"
    );
}

#[test]
fn status_retains_cheap_control_budget() {
    // Status has no CLI operation timeout; it must retain the existing 2s budget.
    let peer = ControlPeer::start(Duration::ZERO, false, false, Duration::from_millis(3000));
    let (output, elapsed) = peer.cli("status", None);
    let stderr = String::from_utf8_lossy(&output.stderr);
    eprintln!(
        "ordinary Status elapsed={elapsed:?} exit={} stderr={stderr}",
        output.status
    );
    assert!(!output.status.success());
    assert!(stderr.contains("timed out"), "{stderr}");
    assert!(elapsed >= Duration::from_millis(1900));
    assert!(elapsed < Duration::from_millis(2750), "{elapsed:?}");
}
