use super::*;

type PausedResponse = (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>);

pub(super) struct ActiveProvider {
    pub(super) port: u16,
    pub(super) fail: std::sync::Arc<std::sync::atomic::AtomicBool>,
    failures: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    pub(super) visits: std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    task: Option<JoinHandle<()>>,
    recorder_panicked: bool,
    pause: std::sync::Arc<std::sync::Mutex<Option<PausedResponse>>>,
    wrote_held: std::sync::Arc<std::sync::Mutex<Option<std::sync::mpsc::Sender<()>>>>,
    pending_request: bool,
    producers_ended: bool,
}
impl ActiveProvider {
    pub(super) fn start() -> Self {
        use std::sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc,
        };
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let fail = Arc::new(AtomicBool::new(true));
        let failures = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let worker_calls = calls.clone();
        let visits = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let worker_visits = visits.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let pause = Arc::new(std::sync::Mutex::new(None::<PausedResponse>));
        let worker_pause = pause.clone();
        let wrote_held = Arc::new(std::sync::Mutex::new(None::<std::sync::mpsc::Sender<()>>));
        let written = wrote_held.clone();
        let (worker_fail, worker_failures, worker_stop) =
            (fail.clone(), failures.clone(), stop.clone());
        let task = thread::spawn(move || {
            while !worker_stop.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(v) => v,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(e) => panic!("controlled provider accept: {e}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => continue,
                    Err(error)
                        if line.is_empty()
                            && matches!(
                                error.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) =>
                    {
                        continue
                    }
                    result => {
                        result.unwrap();
                    }
                }
                let mut length = 0;
                loop {
                    line.clear();
                    if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = v.trim().parse().unwrap();
                    }
                }
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                let input: Value = serde_json::from_slice(&bytes).unwrap();
                worker_calls.fetch_add(1, Ordering::SeqCst);
                worker_visits.lock().unwrap().push(input["input"].clone());
                let valid = input["model"] == "wire-test"
                    && matches!(
                        input["input"].as_str(),
                        Some("uncached connection probe" | "fresh after restart")
                    );
                let response_gate = worker_pause.lock().unwrap().take();
                let held = response_gate.is_some();
                if let Some((arrived, resume)) = response_gate {
                    let _ = arrived.send(());
                    let released = resume.recv_timeout(Duration::from_secs(5));
                    if written.lock().unwrap().is_some() {
                        released.expect("fixture response gate must release before the bound");
                    }
                }
                let failing = valid && worker_fail.load(Ordering::SeqCst);
                let (status, body) = if !valid {
                    (
                        400,
                        serde_json::json!({"error":{"message":"unexpected actual wire shape"}}),
                    )
                } else if failing {
                    worker_failures.fetch_add(1, Ordering::SeqCst);
                    (
                        503,
                        serde_json::json!({"error":{"message":"controlled delivery failure","type":"server_error"}}),
                    )
                } else {
                    (
                        200,
                        serde_json::json!({"id":"active-managed","object":"response","status":"completed","model":"wire-test",
                        "output":[{"id":"m","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":input["input"],"annotations":[]}]},
                        {"id":"r","type":"reasoning","summary":[{"type":"summary_text","text":"complete"}]}],
                        "usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}),
                    )
                };
                let body = body.to_string();
                let reply = format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                if let Err(error) = stream.write_all(reply.as_bytes()) {
                    // The old managed process can exit while its response is held.
                    assert!(
                        held && matches!(
                            error.kind(),
                            std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
                        ),
                        "Provider response write: {error}"
                    );
                }
                if held {
                    if let Some(done) = written.lock().unwrap().take() {
                        let _ = done.send(());
                    }
                }
            }
        });
        Self {
            port,
            fail,
            failures,
            calls,
            visits,
            stop,
            task: Some(task),
            recorder_panicked: false,
            pause,
            wrote_held,
            pending_request: false,
            producers_ended: true,
        }
    }
}

const STATUS_PATH: &str = "/_routecodex/selection/active-keys";
const RELEASE_PATH: &str = "/_routecodex/selection/active-keys/release";

fn release_body() -> Value {
    serde_json::json!({"routing_group_id":"default","pool_id":"default","provider_id":"test",
        "interface_id":"default","model_id":"test","auth_alias":"key"})
}

fn business_body() -> Value {
    serde_json::json!({"model":"test","input":"uncached connection probe","stream":false})
}

pub(super) fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

fn managed_control(instance: &Path) -> Value {
    serde_json::from_slice(&fs::read(instance.join("control.json")).unwrap()).unwrap()
}

fn isolated_lifetime_command(
    root: &TempDir,
    state: &Path,
    config: &Path,
    operation: &str,
) -> Output {
    isolated_lifetime_process(root, state, config, operation)
        .output()
        .unwrap()
}

fn isolated_lifetime_process(
    root: &TempDir,
    state: &Path,
    config: &Path,
    operation: &str,
) -> Command {
    let mut command = managed_test_command(env!("CARGO_BIN_EXE_rccv3"), state);
    command
        .args(["server", operation, "--config"])
        .arg(config)
        .env("HOME", root.path().join("home"))
        .env("ROUTECODEX_V3_STATE_DIR", state)
        .env(
            "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
            request_counter_file(state),
        )
        .env("V3_MANAGED_TEST_KEY", SECRET);
    command
}

fn managed_socket(control: &Value) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(control["socket_path"].as_str().unwrap())
}

fn endpoint(bytes: &[u8]) -> Option<std::net::SocketAddr> {
    serde_json::from_slice::<Value>(bytes).ok()?["control_addr"]
        .as_str()?
        .parse()
        .ok()
}

fn keepalive_control(
    stream: &mut BufReader<TcpStream>,
    address: std::net::SocketAddr,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> std::io::Result<u16> {
    let body = body.map(|body| body.to_string()).unwrap_or_default();
    write!(stream.get_mut(), "{method} {path} HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n{body}", body.len())?;
    let mut line = String::new();
    stream.read_line(&mut line)?;
    let status = line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::UnexpectedEof, line.clone()))?;
    let length = loop {
        line.clear();
        if stream.read_line(&mut line)? == 0 || line == "\r\n" {
            break 0;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            let length = value.trim().parse::<usize>().unwrap();
            loop {
                line.clear();
                if stream.read_line(&mut line)? == 0 || line == "\r\n" {
                    break;
                }
            }
            break length;
        }
    };
    stream.read_exact(&mut vec![0; length])?;
    Ok(status)
}

fn namespace_lock(root: &TempDir) -> fs::File {
    let holder = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.path().join(".active-key-control.lock"))
        .unwrap();
    holder.lock().unwrap();
    holder
}

fn managed_lifetime_config(root: &TempDir, bind: &str, provider_port: u16) -> (PathBuf, [u16; 2]) {
    let ports = [free_port(), free_port()];
    assert_ne!(ports[0], ports[1]);
    assert!(ports.iter().all(|p| ![4444, 7777].contains(p)));
    (
        write_active_config(root, bind.parse().unwrap(), ports, provider_port, false),
        ports,
    )
}

fn foreground_phase(op: &std::ffi::OsStr, phase: &str) {
    let Ok(path) = std::env::var("RCC_FIXTURE_GATE_TRACE") else {
        return;
    };
    let elapsed_us = std::env::var("RCC_FIXTURE_GATE_START_US")
        .ok()
        .and_then(|s| s.parse::<u128>().ok())
        .and_then(|start| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_micros()
                .checked_sub(start)
        });
    let write = fs::OpenOptions::new()
        .append(true)
        .open(path)
        .and_then(|mut trace| {
            writeln!(
                trace,
                "pid={} operation={op:?} elapsed_us={elapsed_us:?} phase={phase}",
                std::process::id()
            )
        });
    if let Err(error) = write {
        eprintln!("foreground phase {phase} trace error: {error}");
    }
}

// The private executable in the spawn case enters the same public Lifecycle
// consumer as the CLI. Its permissions can change without touching Cargo's CLI.
#[test]
fn empty_custody_recovery_retries_spawn() {
    if let Some(op) = std::env::var_os("RCC_FIXTURE_LAUNCH_OPERATION") {
        foreground_phase(&op, "exact-test-entry");
        let config = std::env::var_os("RCC_FIXTURE_LAUNCH_CONFIG").unwrap();
        let image = PathBuf::from(std::env::var_os("RCC_FIXTURE_LAUNCH_IMAGE").unwrap());
        let launch_gate = image.with_extension("gate");
        if op == "child" {
            let exists = launch_gate.exists();
            foreground_phase(&op, if exists { "gate-exists" } else { "gate-absent" });
            if exists {
                if std::env::var_os("RCC_FIXTURE_GATE_TRACE").is_some()
                    && std::env::var_os("RCC_FIXTURE_PRIVATE_GATE_HOLD").is_some()
                {
                    foreground_phase(&op, "controlled-hold-before-connect");
                    eprintln!("private fixture held before connect");
                    loop {
                        thread::park();
                    }
                }
                foreground_phase(&op, "pre-connect");
                let mut gate = UnixStream::connect(launch_gate).unwrap();
                foreground_phase(&op, "post-connect");
                gate.write_all(&std::process::id().to_be_bytes()).unwrap();
                foreground_phase(&op, "pid-written");
                gate.read_exact(&mut [0]).unwrap();
            }
        }
        let state = PathBuf::from(std::env::var_os("ROUTECODEX_V3_STATE_DIR").unwrap());
        let lifecycle = routecodex_v3_lifecycle::V3ManagedLifecycle::with_state_root(
            PathBuf::from(config),
            state,
        );
        let result = match op.to_str().unwrap() {
            "child" => runtime().block_on(lifecycle.run_managed_child(&image)),
            "foreground" => {
                let rt = runtime();
                foreground_phase(&op, "runtime-constructed-pre-start-foreground");
                rt.block_on(lifecycle.start_foreground(&image))
            }
            "start" => runtime()
                .block_on(lifecycle.start(&image, Duration::from_secs(4)))
                .map(|_| ()),
            "restart" => runtime()
                .block_on(lifecycle.restart(&image, Duration::from_secs(4)))
                .map(|_| ()),
            "snapshot-restart" => runtime()
                .block_on(
                    lifecycle
                        .with_snapshots_enabled(true)
                        .restart(&image, Duration::from_secs(4)),
                )
                .map(|_| ()),
            "stop" => runtime()
                .block_on(lifecycle.stop(&image, Duration::from_secs(5)))
                .map(|_| ()),
            other => panic!("unknown fixture operation {other}"),
        };
        if let Err(error) = result {
            eprintln!("scoped Lifecycle failure: {error}");
            std::process::exit(1);
        }
        return;
    }
    empty_custody_restart(EmptyRestartCase::Spawn);
}

#[test]
fn stopped_child_exit_recovers_owned_generation() {
    empty_custody_restart(EmptyRestartCase::ChildExit);
}

#[cfg(target_os = "macos")]
#[test]
fn stopped_child_retries_control_unlink() {
    empty_custody_restart(EmptyRestartCase::ControlUnlink);
}

#[cfg(target_os = "macos")]
#[test]
fn stopped_child_retries_cache_unlink() {
    empty_custody_restart(EmptyRestartCase::CacheUnlink);
}

#[test]
fn foreground_exec_refusal_retries_through_formal_restart() {
    empty_custody_restart(EmptyRestartCase::Foreground);
}

#[cfg(target_os = "macos")]
#[test]
fn foreground_owner_survives_competing_public_start() {
    foreground_exit_fixture(None, None);
}

#[cfg(target_os = "macos")]
#[test]
fn failed_starting_retains_generation_through_unlink_fault() {
    foreground_exit_fixture(Some("control.json"), None);
}

#[cfg(target_os = "macos")]
#[test]
fn failed_starting_retains_generation_through_socket_fault() {
    foreground_exit_fixture(Some("socket"), None);
}

#[cfg(target_os = "macos")]
#[test]
fn failed_starting_retains_generation_through_cache_fault() {
    foreground_exit_fixture(Some("pid.cache"), None);
}

#[cfg(target_os = "macos")]
#[test]
fn rejected_restart_plan_settles_at_graceful_stop() {
    for (challenge, recovery) in [
        ("ordinary", "start"),
        ("ordinary", "foreground"),
        ("ordinary", "restart"),
        ("immutable", "restart"),
        ("nonce", "restart"),
        ("instance", "restart"),
        ("target", "restart"),
        ("directory", "restart"),
        ("unreadable", "restart"),
        ("symlink", "restart"),
    ] {
        foreground_exit_fixture(None, Some((challenge, recovery)));
    }
}

#[cfg(target_os = "macos")]
#[test]
fn public_stop_observes_failed_terminal_publication() {
    foreground_exit_fixture(None, Some(("terminal-publication", "restart")));
}

#[cfg(target_os = "macos")]
#[test]
fn replacement_listener_preserves_failed_stop() {
    foreground_exit_fixture(None, Some(("replacement-listener", "restart")));
}

#[cfg(target_os = "macos")]
#[test]
fn fresh_child_rolls_back_incomplete_control_publication() {
    foreground_exit_fixture(Some("control-publication"), None);
}

fn gate_diagnostic_bytes(path: &Path) -> std::io::Result<String> {
    let mut bytes = Vec::new();
    fs::File::open(path)?.take(8193).read_to_end(&mut bytes)?;
    let truncated = bytes.len() > 8192;
    bytes.truncate(8192);
    let mut text = String::from_utf8_lossy(&bytes).replace(SECRET, "[redacted]");
    if text.contains("nonce") {
        text = text
            .lines()
            .map(|line| {
                if line.contains("nonce") {
                    "[nonce-bearing line omitted]"
                } else {
                    line
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    if truncated {
        text.push_str("\n[truncated at 8192 bytes]");
    }
    Ok(text)
}

fn gate_instance_state(state: &Path) -> std::io::Result<Vec<String>> {
    let mut summary = Vec::new();
    for entry in fs::read_dir(state.join("instances"))?.take(4) {
        let entry = entry?;
        let dir = entry.path();
        summary.push(format!("instance={:?}", entry.file_name()));
        if !entry.file_type()?.is_dir() {
            continue;
        }
        for name in [
            "instance.json",
            "status.json",
            "lifecycle.lock",
            "control.json",
            "pid.cache",
            "restart.plan.json",
        ] {
            let path = dir.join(name);
            let kind = fs::symlink_metadata(&path).map(|m| m.file_type());
            summary.push(format!("{name}={kind:?}"));
            if matches!(kind, Ok(t) if t.is_file())
                && matches!(name, "instance.json" | "status.json")
            {
                let value: std::io::Result<Value> = fs::File::open(&path).and_then(|f| {
                    serde_json::from_reader(f.take(16384)).map_err(std::io::Error::other)
                });
                summary.push(format!(
                    "typed={:?}",
                    value.map(|v| (
                        v["state"].as_str().map(str::to_owned),
                        v["listeners"].as_array().map(Vec::len)
                    ))
                ));
            }
        }
    }
    Ok(summary)
}

#[cfg(target_os = "macos")]
fn foreground_exit_fixture(unlink: Option<&str>, plan_case: Option<(&str, &str)>) {
    use std::os::unix::fs::MetadataExt;
    let _guard = lifecycle_test_guard();
    let root = TempDir::new_in("/tmp").unwrap();
    let state = root.path().join("state");
    let mut provider = ActiveProvider::start();
    provider
        .fail
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let ports = [free_port(), free_port()];
    let config = write_config_with_provider(&root, ports, false, true, Some(provider.port));
    let fixture = std::env::current_exe().unwrap();
    let failed_terminal = matches!(
        plan_case,
        Some(("terminal-publication" | "replacement-listener", _))
    );
    let test = "active_key_control_release::empty_custody_recovery_retries_spawn";
    let image = root.path().join("managed-child");
    let quoted = fixture.display().to_string().replace('\'', "'\\''");
    fs::write(&image, format!("#!/bin/sh\nexport RCC_FIXTURE_LAUNCH_OPERATION=child\nif [ -n \"$RCC_FIXTURE_GATE_TRACE\" ]; then printf 'pid=%s operation=child shell_elapsed_s=%s phase=shell-pre-exec\\n' \"$$\" \"$SECONDS\" >> \"$RCC_FIXTURE_GATE_TRACE\"; fi\nexec '{quoted}' --exact {test} --nocapture\n")).unwrap();
    fs::set_permissions(&image, fs::Permissions::from_mode(0o700)).unwrap();
    let command = |op: &str| {
        let mut cmd = managed_test_command(fixture.to_str().unwrap(), &state);
        cmd.args(["--exact", test, "--nocapture"])
            .env("RCC_FIXTURE_LAUNCH_CONFIG", &config)
            .env("RCC_FIXTURE_LAUNCH_IMAGE", &image)
            .env("RCC_FIXTURE_LAUNCH_OPERATION", op)
            .env("TMPDIR", root.path())
            .env("HOME", root.path().join("home"))
            .env("ROUTECODEX_V3_STATE_DIR", &state)
            .env(
                "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
                request_counter_file(&state),
            )
            .env("V3_MANAGED_TEST_KEY", SECRET);
        cmd
    };
    let gate = std::os::unix::net::UnixListener::bind(image.with_extension("gate")).unwrap();
    gate.set_nonblocking(true).unwrap();
    let gate_path = image.with_extension("gate");
    let identity = || fs::symlink_metadata(&gate_path).map(|m| (m.dev(), m.ino(), m.file_type()));
    let gate_identity = identity().unwrap();
    let trace = root.path().join("launch.trace");
    fs::File::create(&trace).unwrap();
    let files = ["foreground.stdout", "foreground.stderr"].map(|name| root.path().join(name));
    let mut launcher = command("foreground");
    launcher.env_remove("RCC_FIXTURE_PRIVATE_GATE_HOLD");
    if unlink == Some("control-publication")
        && std::env::var("RCC_TEST_FOREGROUND_GATE_FAULT").as_deref() == Ok("hold-before-connect")
    {
        launcher.env("RCC_FIXTURE_PRIVATE_GATE_HOLD", "1");
    }
    let mut direct = launcher
        .env("RCC_FIXTURE_GATE_TRACE", &trace)
        .env(
            "RCC_FIXTURE_GATE_START_US",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_micros()
                .to_string(),
        )
        .stdout(fs::File::create(&files[0]).unwrap())
        .stderr(fs::File::create(&files[1]).unwrap())
        .spawn()
        .unwrap();
    let pid = direct.id();
    let started = Instant::now();
    let deadline = started + Duration::from_secs(5);
    let mut child = loop {
        let cause = match gate.accept() {
            Ok((stream, _)) => break stream,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline => {
                match direct.try_wait() {
                    Ok(None) => {
                        thread::yield_now();
                        continue;
                    }
                    Ok(Some(status)) => format!("foreground exited before launch gate: {status}"),
                    Err(error) => format!("foreground launch gate try_wait: {error}"),
                }
            }
            Err(e) => format!("foreground launch gate: {e}"),
        };
        let elapsed = started.elapsed();
        let before = direct.try_wait();
        let gate_at_failure = identity();
        let instances = gate_instance_state(&state);
        let kill = if matches!(before, Ok(Some(_))) {
            Ok(())
        } else {
            direct.kill()
        };
        let until = Instant::now() + Duration::from_secs(2);
        let collected = loop {
            match direct.try_wait() {
                Ok(None) if Instant::now() < until => thread::yield_now(),
                result => break result,
            }
        };
        let reaped = matches!(collected, Ok(Some(_)));
        let phases = gate_diagnostic_bytes(&trace);
        let output = files.each_ref().map(|path| {
            if reaped {
                gate_diagnostic_bytes(path)
            } else {
                Err(std::io::Error::other("child uncollected; output retained"))
            }
        });
        let recorder = provider.finish_quiescent(reaped);
        let endpoints = ports.map(|port| {
            TcpStream::connect(("127.0.0.1", port))
                .map(drop)
                .map_err(|e| e.kind())
        });
        drop(gate);
        let path = root.path().to_owned();
        let scope = if reaped
            && matches!(identity(), Ok(id) if id == gate_identity)
            && recorder.is_ok()
            && endpoints
                .iter()
                .all(|r| *r == Err(std::io::ErrorKind::ConnectionRefused))
            && output.iter().all(Result::is_ok)
            && phases.is_ok()
        {
            root.close()
        } else {
            Err(std::io::Error::other(format!(
                "retained fixture scope {}",
                root.keep().display()
            )))
        };
        panic!("{cause}; elapsed={elapsed:?} direct_pid={pid} try_wait={before:?} gate={gate_at_failure:?} instances={instances:?}\nkill={kill:?} collected={collected:?} trace={phases:?} stdout/stderr={output:?}\nno business issued; provider={} join/refusal={recorder:?} ports={ports:?} endpoints={endpoints:?} root={} close={scope:?} root_absence={:?} gate_absence={:?}", provider.port, path.display(), path.try_exists().map(|v| !v), gate_path.try_exists().map(|v| !v));
    };
    let mut foreground = CapturedChild {
        child: Some(direct),
        stdout: None,
        stderr: None,
        files: Some(files),
    };
    child.set_nonblocking(false).unwrap();
    child
        .set_read_timeout(Some(Duration::from_secs(4)))
        .unwrap();
    let mut bytes = [0; 4];
    child.read_exact(&mut bytes).unwrap();
    assert_eq!(u32::from_be_bytes(bytes), pid);
    eprintln!(
        "foreground gate accepted direct_pid={pid} elapsed={:?} trace_at_accept={:?}",
        started.elapsed(),
        gate_diagnostic_bytes(&trace)
    );
    // PID delivery precedes the child's final phase append. Read the complete
    // normal trace only after collecting that child, before retiring its root.
    let report_final_trace = || {
        eprintln!(
            "foreground gate final direct_pid={pid} trace={:?}",
            gate_diagnostic_bytes(&trace)
        );
    };
    let instance = single_instance_dir(&state);
    if unlink.is_some() || plan_case.is_some() {
        let cache = instance.join("pid.cache");
        let ctl = instance.join("control.json");
        let plan = instance.join("restart.plan.json");
        let status_path = instance.join("status.json");
        let baseline = fs::read(&status_path).unwrap();
        if unlink == Some("control-publication") {
            fs::create_dir(&ctl).unwrap();
            let foreign = ctl.join("fixture");
            fs::write(&foreign, b"preserve").unwrap();
            let inode = fs::metadata(&ctl).unwrap().ino();
            drop(gate);
            fs::remove_file(image.with_extension("gate")).unwrap();
            child.write_all(&[1]).unwrap();
            drop(child);
            assert!(wait_for_child_exit(
                foreground.child.as_mut().unwrap(),
                Duration::from_secs(5)
            ));
            let exited = foreground.finish();
            let error = String::from_utf8_lossy(&exited.stderr);
            let attempted: Value = serde_json::from_slice(
                &fs::read(ctl.with_extension(format!("tmp-{pid}"))).unwrap(),
            )
            .unwrap();
            let socket = managed_socket(&attempted);
            assert_eq!(exited.status.code(), Some(1));
            assert!(error.contains("Is a directory"), "{error}");
            assert!(!attempted["start_nonce"].as_str().unwrap().is_empty());
            assert!(!socket.exists() && !cache.exists());
            assert_eq!(fs::read(&status_path).unwrap(), baseline);
            assert_eq!(fs::metadata(&ctl).unwrap().ino(), inode);
            assert_eq!(fs::read(&foreign).unwrap(), b"preserve");
            let path = root.path().to_owned();
            let upstream = provider.port;
            drop(provider);
            report_final_trace();
            root.close().unwrap();
            assert!(!path.exists());
            assert!(ports
                .into_iter()
                .chain([upstream])
                .all(|p| TcpStream::connect(("127.0.0.1", p)).is_err()));
            eprintln!("incomplete control publication child={pid} exit={} cause={error} terminal unchanged, socket/cache absent, foreign directory preserved; closed root={} ports={ports:?} upstream={upstream}", exited.status, path.display());
            return;
        }
        let wait_running = || {
            let until = Instant::now() + Duration::from_secs(5);
            while serde_json::from_slice::<Value>(&fs::read(&status_path).unwrap()).unwrap()
                ["state"]
                != "running"
            {
                assert!(Instant::now() < until, "Running was not published");
                thread::yield_now();
            }
        };
        let checked_request = |input: &str| {
            let (status, body) = http(
                &runtime(),
                ([127, 0, 0, 1], ports[0]).into(),
                "POST",
                "/v1/responses",
                Some(serde_json::json!({"model":"test","input":input,"stream":false})),
            )
            .unwrap();
            assert_eq!(status, 200);
            assert_eq!(body["id"], "active-managed");
            assert_eq!(body["status"], "completed");
            assert_eq!(body["output"][0]["content"][0]["text"], input);
            if failed_terminal {
                eprintln!(
                    "Provider response HTTP {status} id={} status={} text={input}",
                    body["id"], body["status"]
                );
            }
        };
        let locked = unlink.map(|_| {
            let lock = fs::File::open(instance.join("status.lock")).unwrap();
            lock.lock().unwrap();
            lock
        });
        drop(gate);
        fs::remove_file(image.with_extension("gate")).unwrap();
        child.write_all(&[1]).unwrap();
        drop(child);
        while !ctl.is_file() {
            assert!(Instant::now() < deadline);
            thread::yield_now();
        }
        let control = managed_control(&instance);
        let socket = managed_socket(&control);
        let proof = fs::read(&cache).unwrap();
        let generation: Value = serde_json::from_slice(&proof).unwrap();
        assert_eq!(generation["pid"], pid);
        assert_eq!(generation["start_nonce"], control["start_nonce"]);
        eprintln!("exit fixture root={} pid={pid} socket={} ports={ports:?} upstream={} unlink={unlink:?} plan={plan_case:?}",root.path().display(),socket.display(),provider.port);
        if let Some(leaf) = unlink {
            let flag = ImmutableFixtureFile::new(if leaf == "socket" {
                socket.clone()
            } else {
                instance.join(leaf)
            });
            assert!(wait_for_child_exit(
                foreground.child.as_mut().unwrap(),
                Duration::from_secs(5)
            ));
            let failed = foreground.finish();
            let detail = String::from_utf8_lossy(&failed.stderr);
            eprintln!(
                "child exit={} {detail} cache={} control={} socket={}",
                failed.status,
                cache.exists(),
                ctl.exists(),
                socket.exists()
            );
            assert!(
                !failed.status.success()
                    && detail.contains("status file lock")
                    && detail.contains("Operation not permitted")
            );
            drop(locked);
            assert_eq!(fs::read(&status_path).unwrap(), baseline);
            assert_eq!(fs::read(&cache).unwrap(), proof);
            assert_eq!(ctl.exists(), leaf != "pid.cache");
            assert_eq!(socket.exists(), leaf == "socket");
            for _ in 0..2 {
                let again = command("restart").output().unwrap();
                eprintln!("repeat {}", String::from_utf8_lossy(&again.stderr));
                assert!(
                    !again.status.success()
                        && String::from_utf8_lossy(&again.stderr)
                            .contains("Operation not permitted")
                );
                assert_eq!(fs::read(&cache).unwrap(), proof);
            }
            drop(flag);
        } else if let Some((challenge, _)) = plan_case {
            wait_running();
            let stage_fault = instance
                .join("exec-restart-declaration.json")
                .with_extension(format!("tmp-{pid}"));
            fs::create_dir(&stage_fault).unwrap();
            let rejected = command("snapshot-restart").output().unwrap();
            fs::remove_dir(stage_fault).unwrap();
            let reason = String::from_utf8_lossy(&rejected.stderr);
            assert!(
                !rejected.status.success() && reason.contains("Is a directory"),
                "{reason}"
            );
            assert_eq!(fs::read(&cache).unwrap(), proof);
            assert_eq!(managed_control(&instance), control);
            let authentic = fs::read(&plan).unwrap();
            let mut record: Value = serde_json::from_slice(&authentic).unwrap();
            assert_eq!(record["start_nonce"], control["start_nonce"]);
            assert_eq!(record["snapshots"], true);
            checked_request("uncached connection probe");
            let parked = instance.join("fixture-preserved-plan");
            let mut flag = None;
            match challenge {
                "ordinary" | "terminal-publication" | "replacement-listener" => (),
                "immutable" => flag = Some(ImmutableFixtureFile::new(plan.clone())),
                "directory" | "symlink" => {
                    fs::rename(&plan, &parked).unwrap();
                    if challenge == "directory" {
                        fs::create_dir(&plan).unwrap()
                    } else {
                        std::os::unix::fs::symlink(&parked, &plan).unwrap()
                    }
                }
                "unreadable" => {
                    fs::set_permissions(&plan, fs::Permissions::from_mode(0o000)).unwrap()
                }
                _ => {
                    match challenge {
                        "nonce" => record["start_nonce"] = "different".into(),
                        "instance" => record["instance_id"] = "different".into(),
                        "target" => {
                            record["target_declaration"] = serde_json::from_slice(
                                &fs::read(instance.join("instance.json")).unwrap(),
                            )
                            .unwrap();
                            record["target_declaration"]["config_path"] = "different".into();
                        }
                        _ => unreachable!(),
                    }
                    fs::write(&plan, serde_json::to_vec(&record).unwrap()).unwrap();
                }
            }
            let challenged = fs::symlink_metadata(&plan).unwrap();
            let challenged_bytes = fs::read(&plan).ok();
            let stop_started = Instant::now();
            let mut observer = CapturedChild::new(
                command("stop")
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .unwrap(),
            );
            let terminal_lock = if failed_terminal {
                let lock = fs::File::open(instance.join("status.lock")).unwrap();
                let until = Instant::now() + Duration::from_secs(4);
                loop {
                    let status: Value =
                        serde_json::from_slice(&fs::read(&status_path).unwrap()).unwrap();
                    if status["state"] == "stopping" {
                        break;
                    }
                    assert!(
                        Instant::now() < until,
                        "public Stop did not publish Stopping: {status}"
                    );
                    thread::yield_now();
                }
                lock.lock().unwrap();
                Some(lock)
            } else {
                None
            };
            assert!(wait_for_child_exit(
                foreground.child.as_mut().unwrap(),
                Duration::from_secs(5)
            ));
            let child_exit = foreground.finish();
            let terminal = fs::read(&status_path).unwrap();
            if terminal_lock.is_some() {
                assert!(stop_started.elapsed() < Duration::from_secs(5));
                assert!(observer
                    .child
                    .as_mut()
                    .unwrap()
                    .try_wait()
                    .unwrap()
                    .is_none());
                assert_eq!(fs::read(&plan).unwrap(), authentic);
                assert_eq!(fs::read(&cache).unwrap(), proof);
                assert_eq!(managed_control(&instance), control);
                assert!(socket.exists());
                eprintln!("status lock released after child exit with original generation intact, public observer waiting at {:?}", stop_started.elapsed());
            }
            drop(terminal_lock);
            let stopped = observer.finish();
            eprintln!(
                "stop={} child={} plan={} cache={} detail={}",
                stopped.status,
                child_exit.status,
                plan.exists(),
                cache.exists(),
                String::from_utf8_lossy(&stopped.stderr)
            );
            assert!(ports
                .iter()
                .all(|p| TcpStream::connect(("127.0.0.1", *p)).is_err()));
            if failed_terminal {
                let cause = String::from_utf8_lossy(&child_exit.stderr);
                let observation = String::from_utf8_lossy(&stopped.stderr);
                eprintln!("original child cause={cause} public stop={observation} socket={} control={} cache={}", socket.exists(), ctl.exists(), cache.exists());
                assert_eq!(child_exit.status.code(), Some(1));
                assert!(cause.contains("status file lock"), "{cause}");
                assert_eq!(
                    serde_json::from_slice::<Value>(&terminal).unwrap()["state"],
                    "stopping"
                );
                assert!(
                    !stopped.status.success()
                        && observation.contains("terminal publication incomplete")
                );
                assert_eq!(fs::read(&status_path).unwrap(), terminal);
                assert_eq!(fs::read(&cache).unwrap(), proof);
                assert_eq!(managed_control(&instance), control);
                assert!(socket.exists());
                assert_eq!(fs::read(&plan).unwrap(), authentic);
                if challenge == "replacement-listener" {
                    let control_bytes = fs::read(&ctl).unwrap();
                    let declaration = fs::read(instance.join("instance.json")).unwrap();
                    let inode = fs::symlink_metadata(&socket).unwrap().ino();
                    let mut replacement = spawn_sigterm_resistant_listener(ports[0]);
                    let replacement_pid = replacement.id();
                    let result = command("stop")
                        .env("ROUTECODEX_V3_KILL_TIMEOUT_MS", "800")
                        .output();
                    let released = wait_for_child_exit(&mut replacement, Duration::from_secs(4));
                    if !released {
                        let _ = replacement.kill();
                    }
                    replacement.wait().unwrap();
                    let result = result.unwrap();
                    let reason = String::from_utf8_lossy(&result.stderr);
                    assert!(released && !result.status.success(), "{reason}");
                    assert!(
                        reason.contains("terminal publication incomplete"),
                        "{reason}"
                    );
                    assert_eq!(fs::read(&status_path).unwrap(), terminal);
                    assert_eq!(fs::read(&ctl).unwrap(), control_bytes);
                    assert_eq!(fs::read(&cache).unwrap(), proof);
                    assert_eq!(fs::read(&plan).unwrap(), authentic);
                    assert_eq!(
                        fs::read(instance.join("instance.json")).unwrap(),
                        declaration
                    );
                    assert_eq!(fs::symlink_metadata(&socket).unwrap().ino(), inode);
                    eprintln!(
                        "replacement={replacement_pid} collected, old generation intact: {reason}"
                    );
                }
            } else if challenge == "ordinary" {
                assert!(
                    stopped.status.success()
                        && child_exit.status.success()
                        && !plan.exists()
                        && !cache.exists()
                );
            } else {
                assert!(
                    !stopped.status.success()
                        && String::from_utf8_lossy(&stopped.stderr).contains("cleanup")
                );
                for _ in 0..2 {
                    let again = command("restart").output().unwrap();
                    let reason = String::from_utf8_lossy(&again.stderr);
                    eprintln!("repeat {reason}");
                    assert!(!again.status.success());
                    if challenge == "immutable" {
                        assert!(reason.contains("Operation not permitted"));
                    }
                    assert_eq!(fs::read(&cache).unwrap(), proof);
                    assert_eq!(fs::symlink_metadata(&plan).unwrap().ino(), challenged.ino());
                    assert_eq!(fs::read(&plan).ok(), challenged_bytes);
                }
                match challenge {
                    "immutable" => drop(flag),
                    "directory" | "symlink" => {
                        if challenge == "directory" {
                            fs::remove_dir(&plan).unwrap()
                        } else {
                            fs::remove_file(&plan).unwrap()
                        }
                        fs::rename(parked, &plan).unwrap();
                    }
                    "unreadable" => {
                        fs::set_permissions(&plan, fs::Permissions::from_mode(0o600)).unwrap()
                    }
                    _ => fs::write(&plan, &authentic).unwrap(),
                }
                assert_eq!(fs::read(&plan).unwrap(), authentic);
            }
        }
        let recovery = plan_case.map_or("restart", |(_, op)| op);
        let mut fresh = if recovery == "foreground" {
            Some(CapturedChild::new(
                command(recovery)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .unwrap(),
            ))
        } else {
            let out = command(recovery).output().unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            None
        };
        wait_running();
        let fresh_control = managed_control(&instance);
        assert_ne!(fresh_control["start_nonce"], control["start_nonce"]);
        let fresh_pid = serde_json::from_slice::<Value>(&fs::read(&cache).unwrap()).unwrap()["pid"]
            .as_u64()
            .unwrap();
        checked_request("fresh after restart");
        assert!(command("stop").output().unwrap().status.success());
        if let Some(mut handle) = fresh.take() {
            assert!(wait_for_child_exit(
                handle.child.as_mut().unwrap(),
                Duration::from_secs(5)
            ));
            assert!(handle.finish().status.success());
        }
        assert!(wait_for_explicit_pid_exit(
            fresh_pid,
            Duration::from_secs(5)
        ));
        let upstream = provider.port;
        let visits = provider.visits.clone();
        let expected = if plan_case.is_some() {
            vec!["uncached connection probe", "fresh after restart"]
        } else {
            vec!["fresh after restart"]
        };
        assert_eq!(*visits.lock().unwrap(), expected);
        drop(provider);
        assert_eq!(*visits.lock().unwrap(), expected);
        assert!(ports
            .into_iter()
            .chain([upstream])
            .all(|p| TcpStream::connect(("127.0.0.1", p)).is_err()));
        assert!(
            !socket.exists()
                && !cache.exists()
                && !ctl.exists()
                && !plan.exists()
                && !instance.join("lifecycle.lock").exists()
        );
        let path = root.path().to_owned();
        report_final_trace();
        root.close().unwrap();
        assert!(!path.exists());
        eprintln!("closed root={} original={pid} fresh={fresh_pid} ports={ports:?} upstream={upstream} visits={expected:?}",path.display());
        return;
    }
    let status_lock = fs::File::open(instance.join("status.lock")).unwrap();
    status_lock.lock().unwrap();
    child.write_all(&[1]).unwrap();
    while !instance.join("control.json").exists() {
        assert!(Instant::now() < deadline);
        thread::yield_now();
    }
    // The foreground Child handle is the sole owner. Its guard kills and waits
    // for this exact process on assertion failure, including while stopped.
    assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGSTOP) }, 0);
    let proof = || {
        [
            "instance.json",
            "status.json",
            "pid.cache",
            "control.json",
            "restart.plan.json",
        ]
        .map(|name| match fs::read(instance.join(name)) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => panic!("read {name}: {e}"),
        })
    };
    let before = proof();
    let status: Value = serde_json::from_slice(before[1].as_ref().unwrap()).unwrap();
    let cache: Value = serde_json::from_slice(before[2].as_ref().unwrap()).unwrap();
    assert_eq!(status["state"], "stopped");
    assert_eq!(cache["pid"], pid);
    let control = managed_control(&instance);
    let socket = managed_socket(&control);
    let inode = fs::symlink_metadata(&socket).unwrap().ino();
    // Guard the fixture's live endpoint independently. A regression cannot
    // remove it, and an unlink error cannot satisfy the required refusal.
    let protected = ImmutableFixtureFile::new(socket.clone());
    assert!(!instance.join("lifecycle.lock").try_exists().unwrap());
    assert!(ports
        .iter()
        .all(|p| std::net::TcpListener::bind(("127.0.0.1", *p)).is_ok()));
    let refused = command("start").output().unwrap();
    assert!(
        !refused.status.success()
            && String::from_utf8_lossy(&refused.stderr)
                .contains("refusing to reap an unverified managed generation")
    );
    assert_eq!(proof(), before);
    assert_eq!(fs::symlink_metadata(&socket).unwrap().ino(), inode);
    drop(protected);
    drop(status_lock);
    assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGCONT) }, 0);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let status: Value =
            serde_json::from_slice(&fs::read(instance.join("status.json")).unwrap()).unwrap();
        if status["state"] == "running" {
            break;
        }
        assert!(Instant::now() < deadline);
        thread::yield_now();
    }
    assert_eq!(
        fs::read(instance.join("pid.cache")).unwrap(),
        *before[2].as_ref().unwrap()
    );
    let (status, body) = http(
        &runtime(),
        ([127, 0, 0, 1], ports[0]).into(),
        "POST",
        "/v1/responses",
        Some(serde_json::json!({"model":"test","input":"fresh after restart","stream":false})),
    )
    .unwrap();
    assert_eq!(status, 200);
    assert_eq!(body["id"], "active-managed");
    assert_eq!(body["status"], "completed");
    assert_eq!(
        body["output"][0]["content"][0]["text"],
        "fresh after restart"
    );
    assert!(command("stop").output().unwrap().status.success());
    assert!(wait_for_child_exit(
        foreground.child.as_mut().unwrap(),
        Duration::from_secs(5)
    ));
    assert!(foreground.finish().status.success());
    let visits = provider.visits.clone();
    drop(provider);
    assert_eq!(*visits.lock().unwrap(), ["fresh after restart"]);
    assert!(!socket.try_exists().unwrap());
    assert!(ports
        .iter()
        .all(|p| TcpStream::connect(("127.0.0.1", *p)).is_err()));
    eprintln!("preserved foreground pid={pid} inode={inode} ports={ports:?} root={} original Provider and authenticated stop passed",root.path().display());
    report_final_trace();
    root.close().unwrap();
}

#[test]
fn empty_custody_recovery_retries_log_open() {
    empty_custody_restart(EmptyRestartCase::Log);
}

#[test]
fn empty_custody_preparation_retains_live_owner() {
    empty_custody_restart(EmptyRestartCase::Prepare);
}

#[test]
fn empty_custody_recovery_verifies_independent_proof() {
    empty_custody_restart(EmptyRestartCase::Proof);
}

#[derive(PartialEq, Debug, Clone, Copy)]
enum EmptyRestartCase {
    Prepare,
    Proof,
    Log,
    Spawn,
    Foreground,
    ChildExit,
    #[cfg(target_os = "macos")]
    ControlUnlink,
    #[cfg(target_os = "macos")]
    CacheUnlink,
}

fn empty_custody_restart(case: EmptyRestartCase) {
    use std::sync::atomic::Ordering;
    let _guard = lifecycle_test_guard();
    let root = TempDir::new_in("/tmp").unwrap();
    let state = root.path().join("state");
    let provider = ActiveProvider::start();
    provider.fail.store(false, Ordering::SeqCst);
    let ports = [free_port(), free_port()];
    let config = write_config_with_provider(&root, ports, false, true, Some(provider.port));
    let successor = root.path().join("successor.toml");
    fs::copy(&config, &successor).unwrap();
    let binary = env!("CARGO_BIN_EXE_rccv3");
    let fixture = std::env::current_exe().unwrap();
    let test_name = "active_key_control_release::empty_custody_recovery_retries_spawn";
    let image = root.path().join("managed-child");
    let private_image = !matches!(
        case,
        EmptyRestartCase::Prepare | EmptyRestartCase::Proof | EmptyRestartCase::Log
    );
    if private_image {
        let quoted = fixture.display().to_string().replace('\'', "'\\''");
        fs::write(&image, format!("#!/bin/sh\nexport RCC_FIXTURE_LAUNCH_OPERATION=child RCC_FIXTURE_LAUNCH_IMAGE=\"$0\" RCC_FIXTURE_LAUNCH_CONFIG=\"$4\"\nexec '{quoted}' --exact {test_name} --nocapture\n")).unwrap();
        fs::set_permissions(&image, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let command = |cfg: &Path, op: &str| {
        let mut cmd = if private_image && cfg == successor {
            let mut cmd = managed_test_command(fixture.to_str().unwrap(), &state);
            cmd.args(["--exact", test_name, "--nocapture"])
                .env("RCC_FIXTURE_LAUNCH_CONFIG", cfg)
                .env("RCC_FIXTURE_LAUNCH_IMAGE", &image)
                .env("RCC_FIXTURE_LAUNCH_OPERATION", op);
            cmd
        } else {
            let mut cmd = managed_test_command(binary, &state);
            cmd.args(["server", op, "--config"]).arg(cfg);
            if op == "restart" {
                cmd.args(["--timeout-ms", "4000"]);
            }
            cmd
        };
        cmd.env("HOME", root.path().join("home"))
            .env("TMPDIR", root.path())
            .env("ROUTECODEX_V3_STATE_DIR", &state)
            .env(
                "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
                request_counter_file(&state),
            )
            .env("V3_MANAGED_TEST_KEY", SECRET);
        cmd.output().unwrap()
    };
    let start = command(&config, "start");
    assert!(
        start.status.success(),
        "{}",
        String::from_utf8_lossy(&start.stderr)
    );
    let source = single_instance_dir(&state);
    let origin: Value =
        serde_json::from_slice(&fs::read(source.join("pid.cache")).unwrap()).unwrap();
    let original_pid = origin["pid"].as_u64().unwrap();
    eprintln!(
        "empty custody {case:?} root={} pid={original_pid} upstream={} ports={ports:?}",
        root.path().display(),
        provider.port
    );
    let exe = if private_image {
        &image
    } else {
        Path::new(binary)
    };
    let (target_decl, _) =
        routecodex_v3_lifecycle::V3ManagedLifecycle::with_state_root(&successor, &state)
            .declaration(exe)
            .unwrap();
    let target = state.join("instances").join(&target_decl.instance_id);
    fs::create_dir_all(&target).unwrap();
    let paths_absent = || {
        [&config, &successor].into_iter().all(|cfg| {
            ["a", "b"].iter().all(|id| {
                !routecodex_v3_config::v3_active_key_control_paths(cfg, id)
                    .unwrap()
                    .record
                    .exists()
            })
        })
    };
    assert!(paths_absent());
    let front = target.join("front-handoff.json");
    let primary_error = |output: &Output| String::from_utf8_lossy(&output.stderr).into_owned();
    let business = |input: &str| {
        http(
            &runtime(),
            ([127, 0, 0, 1], ports[0]).into(),
            "POST",
            "/v1/responses",
            Some(serde_json::json!({"model":"test","input":input,"stream":false})),
        )
    };
    let mut evidence;
    if case == EmptyRestartCase::Prepare {
        let fault = front.with_extension(format!("tmp-{original_pid}"));
        fs::create_dir(&fault).unwrap();
        let failure = command(&successor, "restart");
        let same = fs::read(source.join("pid.cache"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            == Some(origin.clone());
        let retained = business("uncached connection probe");
        let clean = !front.exists()
            && !target.join("exec-restart-declaration.json").exists()
            && !source.join("provider-handoff.json").exists()
            && !source.join("front-handoff.json").exists();
        let log = fs::read_to_string(source.join("server.log")).unwrap_or_default();
        eprintln!("preparation pid={original_pid} refused={} retained={retained:?} clean={clean} stage={} source_front={} target_front={} runtime={}", primary_error(&failure), target.join("exec-restart-declaration.json").exists(), source.join("front-handoff.json").is_file(), front.exists(), log.lines().last().unwrap_or_default());
        fs::remove_dir(fault).unwrap();
        evidence = !failure.status.success()
            && primary_error(&failure).contains("Is a directory")
            && same
            && matches!(retained, Ok((200, _)))
            && clean;
    } else {
        let lock = fs::File::create(target.join("status.lock")).unwrap();
        lock.lock().unwrap();
        let (entered, arrival) = std::sync::mpsc::channel();
        let (resume, release) = std::sync::mpsc::channel();
        *provider.pause.lock().unwrap() = Some((entered, release));
        let client = thread::spawn(move || {
            http(
                &runtime(),
                ([127, 0, 0, 1], ports[0]).into(),
                "POST",
                "/v1/responses",
                Some(business_body()),
            )
        });
        arrival.recv_timeout(Duration::from_secs(5)).unwrap();
        let interrupted = command(&successor, "restart");
        let exited = wait_for_explicit_pid_exit(original_pid, Duration::from_secs(6));
        drop(lock);
        let _ = resume.send(());
        let abandoned = client.join().unwrap();
        let typed: Value = serde_json::from_slice(&fs::read(&front).unwrap()).unwrap();
        let cache = source.join("pid.cache");
        let independent: Value = serde_json::from_slice(&fs::read(&cache).unwrap()).unwrap();
        let adoption = !interrupted.status.success()
            && exited
            && abandoned.is_err()
            && typed["declaration"] == serde_json::to_value(&target_decl).unwrap()
            && typed["origin"] == origin
            && independent == origin
            && typed["checkpoints"].is_array()
            && typed["controls"]["records"] == serde_json::json!([])
            && target.join("instance.json").is_file()
            && target.join("provider-handoff.json").is_file()
            && paths_absent();
        let status = target.join("status.json");
        if case == EmptyRestartCase::Proof {
            let front_bytes = fs::read(&front).unwrap();
            let original_status = fs::read(&status).ok();
            let parked = source.join("fixture-original-cache");
            fs::rename(&cache, &parked).unwrap();
            let refuse = || {
                let before = [&cache, &status, &source.join("control.json")]
                    .map(fs::read)
                    .map(Result::ok);
                let rejection = command(&successor, "restart");
                assert!(!rejection.status.success());
                assert_eq!(
                    [&cache, &status, &source.join("control.json")]
                        .map(fs::read)
                        .map(Result::ok),
                    before
                );
                assert_eq!(fs::read(&front).unwrap(), front_bytes);
            };
            refuse();
            let mut wrong = origin.clone();
            wrong["start_nonce"] = serde_json::json!("wrong-fixture-generation");
            fs::write(&cache, serde_json::to_vec(&wrong).unwrap()).unwrap();
            refuse();
            fs::rename(parked, &cache).unwrap();
            let mut foreign: Value =
                serde_json::from_slice(&fs::read(source.join("status.json")).unwrap()).unwrap();
            foreign["instance_id"] = serde_json::json!("unrelated-fixture-instance");
            fs::write(&status, serde_json::to_vec(&foreign).unwrap()).unwrap();
            refuse();
            match original_status {
                Some(bytes) => fs::write(status, bytes).unwrap(),
                None => fs::remove_file(status).unwrap(),
            }
            evidence = adoption;
        } else if private_image
            && !matches!(case, EmptyRestartCase::Spawn | EmptyRestartCase::Foreground)
        {
            let gate_path = image.with_extension("gate");
            let gate = std::os::unix::net::UnixListener::bind(&gate_path).unwrap();
            gate.set_nonblocking(true).unwrap();
            let (pid, baseline, parent, live_refused) = thread::scope(|scope| {
                let parent = scope.spawn(|| command(&successor, "restart"));
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut child = loop {
                    match gate.accept() {
                        Ok((child, _)) => break child,
                        Err(e)
                            if e.kind() == std::io::ErrorKind::WouldBlock
                                && !parent.is_finished()
                                && Instant::now() < deadline =>
                        {
                            thread::yield_now()
                        }
                        Err(e) => panic!("fresh launcher did not reach the child gate: {e}"),
                    }
                };
                child.set_nonblocking(false).unwrap();
                child
                    .set_read_timeout(Some(Duration::from_secs(4)))
                    .unwrap();
                let mut bytes = [0; 4];
                child.read_exact(&mut bytes).unwrap();
                let pid = u32::from_be_bytes(bytes);
                fs::remove_file(&gate_path).unwrap();
                let baseline = fs::read(&status).unwrap();
                let lock = fs::File::open(target.join("status.lock")).unwrap();
                lock.lock().unwrap();
                child.write_all(&[1]).unwrap();
                let deadline = Instant::now() + Duration::from_secs(3);
                while !target.join("control.json").exists() && Instant::now() < deadline {
                    thread::yield_now();
                }
                let cache = fs::read(target.join("pid.cache")).unwrap();
                let record = fs::read(target.join("control.json")).unwrap();
                let owner: Value = serde_json::from_slice(&cache).unwrap();
                let control: Value = serde_json::from_slice(&record).unwrap();
                assert_eq!(owner["pid"], pid);
                assert_eq!(owner["instance_id"], target_decl.instance_id);
                assert_eq!(control["instance_id"], owner["instance_id"]);
                assert_eq!(control["start_nonce"], owner["start_nonce"]);
                assert!(Path::new(control["socket_path"].as_str().unwrap()).exists());
                let refused = command(&successor, "restart");
                let live_refused = !refused.status.success()
                    && fs::read(target.join("pid.cache")).unwrap() == cache
                    && fs::read(target.join("control.json")).unwrap() == record
                    && fs::read(&status).unwrap() == baseline;
                assert_eq!(
                    unsafe { libc::kill(pid.try_into().unwrap(), libc::SIGKILL) },
                    0
                );
                let result = parent.join().unwrap();
                drop(lock);
                (pid, baseline, result, live_refused)
            });
            let early = primary_error(&parent);
            evidence = adoption
                && live_refused
                && !parent.status.success()
                && early.contains(&format!("managed child {pid} exited before readiness"))
                && early.contains("SIGKILL")
                && !target.join("lifecycle.lock").exists()
                && serde_json::from_slice::<Value>(&baseline).unwrap()["state"] == "stopped"
                && fs::read(&status).unwrap() == baseline;
            eprintln!("child={pid} live refusal={live_refused} parent={early} stopped exit evidence={evidence}");
            let proof = [
                "instance.json",
                "pid.cache",
                "control.json",
                "status.json",
                "restart.plan.json",
            ];
            let read_proof = || proof.map(|name| fs::read(target.join(name)).ok());
            let authentic = read_proof();
            let socket = root
                .path()
                .join(format!("routecodex-{}.sock", target_decl.instance_id));
            let refuse = || {
                let before = read_proof();
                let failure = command(&successor, "restart");
                assert!(
                    !failure.status.success(),
                    "unexpected recovery with incomplete proof"
                );
                assert_eq!(read_proof(), before);
                assert!(socket.exists() && !target.join("lifecycle.lock").exists());
            };
            for (index, field) in [
                (1, None),
                (2, None),
                (1, Some("start_nonce")),
                (2, Some("instance_id")),
                (0, Some("config_digest")),
                (1, Some("process_start_token")),
            ] {
                let path = target.join(proof[index]);
                let bytes = authentic[index].as_ref().unwrap();
                if let Some(field) = field {
                    let mut changed: Value = serde_json::from_slice(bytes).unwrap();
                    changed[field] = if field == "process_start_token" {
                        Value::Null
                    } else {
                        Value::from("foreign-generation")
                    };
                    fs::write(&path, serde_json::to_vec(&changed).unwrap()).unwrap();
                } else {
                    fs::remove_file(&path).unwrap();
                }
                refuse();
                fs::write(path, bytes).unwrap();
            }
            let occupied = std::net::TcpListener::bind(("127.0.0.1", ports[0])).unwrap();
            refuse();
            drop(occupied);
            #[cfg(target_os = "macos")]
            if matches!(
                case,
                EmptyRestartCase::ControlUnlink | EmptyRestartCase::CacheUnlink
            ) {
                let control_fault = case == EmptyRestartCase::ControlUnlink;
                let fault = if control_fault {
                    "control.json"
                } else {
                    "pid.cache"
                };
                let immutable = ImmutableFixtureFile::new(target.join(fault));
                for attempt in 1..=2 {
                    let failed = command(&successor, "restart");
                    let cause = primary_error(&failed);
                    let remaining = read_proof();
                    let socket_absent = socket
                        .symlink_metadata()
                        .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound);
                    let control_settled = if control_fault {
                        remaining[2] == authentic[2]
                    } else {
                        target
                            .join("control.json")
                            .symlink_metadata()
                            .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
                    };
                    eprintln!("case={case:?} attempt={attempt} error={cause} socket_absent={socket_absent} cache_retained={} control_as_expected={control_settled}", remaining[1] == authentic[1]);
                    evidence &= !failed.status.success()
                        && cause.contains("Operation not permitted (os error 1)")
                        && socket_absent
                        && control_settled
                        && remaining[0] == authentic[0]
                        && remaining[1] == authentic[1]
                        && remaining[3] == authentic[3];
                }
                if !control_fault {
                    // A remaining cache grants only local cleanup of settled state.
                    let cache_only = read_proof();
                    for leaf in [
                        "control.json",
                        "front-handoff.json",
                        "provider-handoff.json",
                        "exec-restart-declaration.json",
                        "previous-release-restart.json",
                        "restart.plan.json",
                    ] {
                        let path = target.join(leaf);
                        assert!(!path.try_exists().unwrap());
                        fs::write(&path, b"{}").unwrap();
                        let before = read_proof();
                        let rejected = command(&successor, "restart");
                        assert!(!rejected.status.success());
                        assert_eq!(fs::read(&path).unwrap(), b"{}");
                        assert_eq!(read_proof(), before);
                        fs::remove_file(path).unwrap();
                    }
                    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
                    let rejected = command(&successor, "restart");
                    assert!(!rejected.status.success());
                    assert!(socket.try_exists().unwrap());
                    assert_eq!(read_proof(), cache_only);
                    fs::remove_file(&socket).unwrap();
                    drop(listener);
                }
                drop(immutable);
            }
        } else {
            let log_path = target.join("server.log");
            let executable_fault = private_image;
            let foreground = case == EmptyRestartCase::Foreground;
            if executable_fault {
                fs::set_permissions(&image, fs::Permissions::from_mode(0o600)).unwrap();
            } else {
                fs::create_dir(&log_path).unwrap();
            }
            let operation = if foreground { "foreground" } else { "restart" };
            let first = command(&successor, operation);
            let terminal_without_child = || {
                let absent = |path: PathBuf| {
                    path.symlink_metadata()
                        .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
                };
                let state = fs::read(&status)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
                state.is_some_and(|s| {
                    s["instance_id"] == target_decl.instance_id
                        && matches!(s["state"].as_str(), Some("stopped" | "failed"))
                }) && ["pid.cache", "control.json", "lifecycle.lock"]
                    .iter()
                    .all(|name| absent(target.join(name)))
                    && absent(
                        root.path()
                            .join(format!("routecodex-{}.sock", target_decl.instance_id)),
                    )
            };
            let first_terminal = !foreground || terminal_without_child();
            let second = command(&successor, operation);
            let second_terminal = !foreground || terminal_without_child();
            let state: Value = serde_json::from_slice(&fs::read(status).unwrap()).unwrap();
            let cause = if executable_fault {
                "Permission denied"
            } else {
                "Is a directory"
            };
            let clean = !front.exists()
                && !target.join("pid.cache").exists()
                && !target.join("control.json").exists()
                && !target.join("provider-handoff.json").exists();
            eprintln!(
                "case={case:?} first={} repeat={} status={} terminal_cleanup={clean}",
                primary_error(&first),
                primary_error(&second),
                state["state"]
            );
            evidence = adoption
                && clean
                && !first.status.success()
                && !second.status.success()
                && primary_error(&first).contains(cause)
                && primary_error(&second).contains(cause)
                && first_terminal
                && second_terminal
                && (foreground || state["state"] == "stopped")
                && state["instance_id"] == target_decl.instance_id
                && (case != EmptyRestartCase::Spawn || log_path.is_file());
            if executable_fault {
                fs::set_permissions(&image, fs::Permissions::from_mode(0o700)).unwrap();
            } else {
                fs::remove_dir(log_path).unwrap();
            }
        }
    }
    let fresh = command(&successor, "restart");
    let result = business("fresh after restart");
    let absent = paths_absent();
    let fresh_status = fs::read(target.join("status.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let running = fresh_status
        .is_some_and(|s| s["instance_id"] == target_decl.instance_id && s["state"] == "running");
    let current = target.join("pid.cache");
    let new_pid = fs::read(current)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v["pid"].as_u64());
    let stop = command(
        if fresh.status.success() {
            &successor
        } else {
            &config
        },
        "stop",
    );
    let terminated = wait_for_explicit_pid_exit(original_pid, Duration::from_secs(5))
        && new_pid.is_some_and(|pid| wait_for_explicit_pid_exit(pid, Duration::from_secs(5)));
    let proofs_closed = [&source, &target].into_iter().all(|dir| {
        [
            "pid.cache",
            "control.json",
            "provider-handoff.json",
            "front-handoff.json",
            "exec-restart-declaration.json",
            "previous-release-restart.json",
            "lifecycle.lock",
        ]
        .iter()
        .all(|name| !dir.join(name).exists())
    });
    let recorder = provider.visits.clone();
    drop(provider);
    let visits = recorder.lock().unwrap().clone();
    let closed = ports
        .iter()
        .all(|port| TcpStream::connect(("127.0.0.1", *port)).is_err());
    for id in [
        origin["instance_id"].as_str().unwrap(),
        &target_decl.instance_id,
    ] {
        let path = root.path().join(format!("routecodex-{id}.sock"));
        if path.exists() {
            use std::os::unix::fs::MetadataExt;
            let inode = fs::symlink_metadata(&path).unwrap().ino();
            let check = Command::new("/usr/bin/python3").current_dir(root.path()).args(["-c",
                "import errno,socket,sys; s=socket.socket(socket.AF_UNIX); sys.exit(s.connect_ex(sys.argv[1]) != errno.ECONNREFUSED)",
                path.file_name().unwrap().to_str().unwrap()]).status().unwrap();
            let lsof = Command::new("lsof")
                .args(["-t", "--"])
                .arg(&path)
                .output()
                .unwrap();
            assert!(
                check.success()
                    && lsof.status.code() == Some(1)
                    && lsof.stdout.is_empty()
                    && lsof.stderr.is_empty()
            );
            assert_eq!(fs::symlink_metadata(&path).unwrap().ino(), inode);
            fs::remove_file(path).unwrap();
        }
    }
    root.close().unwrap();
    eprintln!(
        "case={case:?} fresh={} business={result:?} visits={visits:?} closed={closed}",
        primary_error(&fresh)
    );
    assert!(
        evidence
            && absent
            && running
            && proofs_closed
            && fresh.status.success()
            && stop.status.success()
            && terminated
            && closed
    );
    let (code, body) = result.unwrap();
    assert_eq!(
        (
            code,
            body["id"].as_str(),
            body["status"].as_str(),
            body["output"][0]["content"][0]["text"].as_str()
        ),
        (
            200,
            Some("active-managed"),
            Some("completed"),
            Some("fresh after restart")
        )
    );
    assert_eq!(visits, ["uncached connection probe", "fresh after restart"]);
}

#[test]
fn managed_release_revokes_accepted_record_only_controls() {
    let _guard = lifecycle_test_guard();
    let mut results = Vec::new();
    for bind in ["127.0.0.1", "0.0.0.0"] {
        let root = TempDir::new().unwrap();
        let state = root.path().join("state");
        let provider = ActiveProvider::start();
        let (config, ports) = managed_lifetime_config(&root, bind, provider.port);
        let process = p0_start(&root, &state, &config);
        let instance = single_instance_dir(&state);
        let control = managed_control(&instance);
        let managed_socket = managed_socket(&control);
        let [a, b] = ports.map(|p| std::net::SocketAddr::from(([127, 0, 0, 1], p)));
        let rt = runtime();
        let held_path = root
            .path()
            .join(format!("active-keys-{bind}_{}.json", a.port()));
        let (pending, resume, dispatched) = if bind == "127.0.0.1" {
            for _ in 0..4 {
                let _ = http(&rt, a, "POST", "/v1/responses", Some(business_body()));
            }
            (None, None, true)
        } else {
            provider
                .fail
                .store(false, std::sync::atomic::Ordering::SeqCst);
            let (send_arrived, arrived) = std::sync::mpsc::channel();
            let (resume, wait_resume) = std::sync::mpsc::channel();
            *provider.pause.lock().unwrap() = Some((send_arrived, wait_resume));
            let pending = thread::spawn(move || {
                http(
                    &runtime(),
                    a,
                    "POST",
                    "/v1/responses",
                    Some(business_body()),
                )
            });
            (
                Some(pending),
                Some(resume),
                arrived.recv_timeout(Duration::from_secs(2)).is_ok(),
            )
        };
        let held_before = fs::read(&held_path).ok();
        let stream = TcpStream::connect(a).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut stream = BufReader::new(stream);
        let before = keepalive_control(&mut stream, a, "GET", STATUS_PATH, None);
        let ack = release(&control, a.port());
        let after = keepalive_control(&mut stream, a, "GET", STATUS_PATH, None);
        let post = keepalive_control(&mut stream, a, "POST", RELEASE_PATH, Some(release_body()));
        let held_unchanged = fs::read(&held_path).ok() == held_before;
        let sibling = http(&rt, b, "GET", STATUS_PATH, None);
        if let Some(resume) = resume {
            let _ = resume.send(());
        }
        let accepted_business = pending.map(|pending| pending.join().unwrap());
        provider
            .fail
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let business = http(&rt, b, "POST", "/v1/responses", Some(business_body()));
        drop(stream);
        let stopped = release(&control, b.port());
        let exited = wait_for_explicit_pid_exit(process.pid.into(), Duration::from_secs(10));
        let records_closed = ["a", "b"].iter().all(|id| {
            let paths = routecodex_v3_config::v3_active_key_control_paths(&config, id).unwrap();
            matches!(paths.read(), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
        });
        let closed = !managed_socket.exists()
            && [a, b]
                .iter()
                .all(|address| TcpStream::connect(address).is_err());
        drop(process);
        drop(provider);
        root.close().unwrap();
        eprintln!("cleanup {bind}: released B={stopped} exited={exited} sockets={closed} records={records_closed}");
        results.push((
            bind,
            before,
            ack,
            after,
            post,
            held_before.is_some(),
            held_unchanged,
            sibling,
            business,
            dispatched,
            accepted_business,
            stopped,
            exited,
            closed,
            records_closed,
        ));
    }
    for (
        bind,
        before,
        ack,
        after,
        post,
        held_present,
        held_unchanged,
        sibling,
        business,
        dispatched,
        accepted_business,
        stopped,
        exited,
        closed,
        records_closed,
    ) in results
    {
        assert!(
            exited && closed && records_closed && stopped["accepted"] == true,
            "{bind} cleanup"
        );
        assert_eq!(before.unwrap(), 200);
        assert_eq!(ack["accepted"], true);
        assert_eq!(sibling.unwrap().0, 200);
        assert_eq!(business.unwrap().0, 200);
        assert!(dispatched);
        if let Some(business) = accepted_business {
            assert_eq!(business.unwrap().0, 200, "already accepted A business");
        } else {
            assert!(
                held_present,
                "real provider failures must persist a hold before release"
            );
        }
        assert!(
            matches!(after, Ok(410)) && matches!(post, Ok(410)) && held_unchanged,
            "{bind}: accepted record-only socket retained controls after ReleasePorts ACK. GET={after:?} POST={post:?} hold unchanged={held_unchanged}"
        );
    }
}

#[test]
fn fatal_exec_recovers_exact_controls() {
    fatal_exec_recovery(false, false);
}

#[test]
fn contended_fatal_exec_recovers_exact_controls() {
    fatal_exec_recovery(true, false);
}

#[test]
fn exited_verified_owner_resolves_foreign_replacement_and_starts_business() {
    fatal_exec_recovery(true, true);
}

fn fatal_exec_recovery(contended: bool, foreign: bool) {
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state = root.path().join("state");
    let provider = ActiveProvider::start();
    let route = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
    route.connect("192.0.2.1:9").unwrap();
    let bind = route.local_addr().unwrap().ip();
    let (config, ports) = managed_lifetime_config(&root, &bind.to_string(), provider.port);
    let process = p0_start(&root, &state, &config);
    let instance = single_instance_dir(&state);
    let socket = managed_socket(&managed_control(&instance));
    let paths = ["a", "b"]
        .map(|id| routecodex_v3_config::v3_active_key_control_paths(&config, id).unwrap());
    let originals = paths.each_ref().map(|path| path.read().unwrap());
    let [a, b] = ports.map(|p| std::net::SocketAddr::new(bind, p));
    let rt = runtime();
    for _ in 0..4 {
        let _ = http(&rt, a, "POST", "/v1/responses", Some(business_body()));
    }
    let held_path = root.path().join(format!(
        "active-keys-{}.json",
        a.to_string().replace(':', "_")
    ));
    let held = fs::read(&held_path).unwrap();
    fs::write(&held_path, b"invalid hold JSON").unwrap();
    let holder = contended.then(|| namespace_lock(&root));
    let failed = isolated_lifetime_command(&root, &state, &config, "restart");
    let failed_status: Value =
        serde_json::from_slice(&fs::read(instance.join("status.json")).unwrap()).unwrap();
    let failed_pid_closed = wait_for_explicit_pid_exit(process.pid.into(), Duration::from_secs(5));
    let failed_sockets_closed = !socket.exists()
        && [a, b]
            .into_iter()
            .chain(originals.iter().filter_map(|record| endpoint(record)))
            .all(|address| TcpStream::connect(address).is_err());
    let retained: Option<Value> = fs::read(instance.join("front-handoff.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    drop(holder);
    sleep(Duration::from_millis(100));
    let before_recovery = paths.each_ref().map(|path| path.read().ok());
    let foreign_bytes = foreign.then(|| {
        let mut replaced: Value = serde_json::from_slice(&originals[0]).unwrap();
        replaced["owner_pid"] = serde_json::json!(std::process::id());
        let bytes = serde_json::to_vec(&replaced).unwrap();
        paths[0]
            .with_write(|tx| {
                tx.remove()?;
                tx.publish(&bytes, || {})
            })
            .unwrap();
        bytes
    });
    fs::write(&held_path, held).unwrap();
    provider
        .fail
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let fresh = isolated_lifetime_command(&root, &state, &config, "start");
    let fresh_cache: Option<Value> = fs::read(instance.join("pid.cache"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let fresh_records = paths.each_ref().map(|path| path.read().ok());
    let running_status = fs::read_to_string(instance.join("status.json")).unwrap();
    let statuses = fresh_records.each_ref().map(|record| {
        record
            .as_deref()
            .and_then(endpoint)
            .map(|address| http(&rt, address, "GET", STATUS_PATH, None))
    });
    let released = fresh_records[0]
        .as_deref()
        .and_then(endpoint)
        .map(|address| http(&rt, address, "POST", RELEASE_PATH, Some(release_body())));
    let business = http(
        &rt,
        if foreign { b } else { a },
        "POST",
        "/v1/responses",
        Some(business_body()),
    );
    let stopped = isolated_lifetime_command(&root, &state, &config, "stop");
    let fresh_pid = fresh_cache.as_ref().and_then(|cache| cache["pid"].as_u64());
    let fresh_pid_closed =
        fresh_pid.is_some_and(|pid| wait_for_explicit_pid_exit(pid, Duration::from_secs(10)));
    let closed = [a, b]
        .into_iter()
        .chain(originals.iter().filter_map(|record| endpoint(record)))
        .chain(
            fresh_records
                .iter()
                .filter_map(|record| endpoint(record.as_deref()?)),
        )
        .all(|address| TcpStream::connect(address).is_err());
    let records_closed = paths
        .iter()
        .all(|path| matches!(path.read(), Err(e) if e.kind() == std::io::ErrorKind::NotFound));
    let socket_removed = !instance.join("control.json").exists() && !socket.exists();
    let final_foreign = paths[0].read().ok();
    drop(process);
    drop(provider);
    root.close().unwrap();
    if let Some(bytes) = foreign_bytes {
        assert!(failed_pid_closed && !failed.status.success() && retained.is_some());
        assert!(
            fresh.status.success(),
            "foreign replacement blocked fresh startup: {}",
            String::from_utf8_lossy(&fresh.stderr)
        );
        assert!(running_status.contains("control conflict"));
        assert_eq!(final_foreign, Some(bytes));
        assert_eq!(business.unwrap().0, 200);
        assert!(matches!(statuses[1], Some(Ok((200, _)))));
        assert!(fresh_pid_closed && closed && socket_removed && stopped.status.success());
        return;
    }
    eprintln!("cleanup fatal contended={contended}: native PID exited={failed_pid_closed} fresh PID exited={fresh_pid_closed} sockets={closed} records={records_closed} control={socket_removed}; original failed status={failed_status}");
    assert!(
        failed_pid_closed
            && failed_sockets_closed
            && fresh_pid_closed
            && closed
            && socket_removed
            && stopped.status.success()
    );
    assert!(!failed.status.success());
    let detail = failed_status["detail"].as_str().unwrap_or_default();
    assert!(
        detail.contains("expected value"),
        "original corrupt hold cause: {failed_status}"
    );
    assert!(
        fresh.status.success(),
        "{}",
        String::from_utf8_lossy(&fresh.stderr)
    );
    assert!(statuses.iter().all(|result| matches!(result, Some(Ok((200, _))))),
        "fresh managed start left predecessor controls orphaned: {statuses:?}, records closed before temp-dir teardown={records_closed}");
    assert!(fresh_records.iter().all(|record| record
        .as_deref()
        .and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok())
        .and_then(|record| record["owner_pid"].as_u64())
        == fresh_pid));
    assert_eq!(released.unwrap().unwrap().1["released"], true);
    assert_eq!(business.unwrap().0, 200);
    assert!(records_closed);
    if contended {
        let retained =
            retained.expect("contended fatal startup must retain a readable front handoff");
        assert_eq!(retained["controls"]["records"].as_array().unwrap().len(), 2);
        assert!(
            detail.contains("timed out"),
            "contended fatal startup must retain exact recovery: {failed_status}"
        );
        assert!(before_recovery
            .iter()
            .zip(&originals)
            .all(|(actual, original)| actual.as_ref() == Some(original)));
    } else {
        assert!(
            before_recovery.iter().all(Option::is_none),
            "uncontended fatal startup retires exact records"
        );
    }
}

#[test]
fn exact_custody_interrupted_exec_recovers_from_predecessor_generation() {
    let _guard = lifecycle_test_guard();
    for changed_dir in [false, true] {
        interrupted_exec_recovery(&_guard, changed_dir, false, "start", None);
    }
}

#[test]
fn interrupted_exec_non_executable_successor_records_rejection_and_closes() {
    let _guard = lifecycle_test_guard();
    observe_interrupted_exec(&_guard, false, false, "start", None, true, None);
}

#[test]
fn exact_custody_published_declaration_recovers_predecessor_control() {
    let _guard = lifecycle_test_guard();
    interrupted_exec_recovery(&_guard, false, true, "start", None);
}

#[test]
fn exact_custody_public_restart_recovers_predecessor_control() {
    let _guard = lifecycle_test_guard();
    interrupted_exec_recovery(&_guard, false, true, "restart", None);
}

#[test]
fn public_restart_staged_same_directory() {
    let _guard = lifecycle_test_guard();
    interrupted_exec_recovery(&_guard, false, false, "restart", None);
}

#[test]
fn public_restart_staged_changed_directory() {
    let _guard = lifecycle_test_guard();
    interrupted_exec_recovery(&_guard, true, false, "restart", None);
}

#[test]
fn public_restart_retired_control_starting() {
    let _guard = lifecycle_test_guard();
    interrupted_exec_recovery(&_guard, false, true, "restart", Some("starting"));
}

#[test]
fn public_restart_retired_control_running() {
    let _guard = lifecycle_test_guard();
    interrupted_exec_recovery(&_guard, false, true, "restart", Some("running"));
}

#[derive(Default)]
struct DirectForeground {
    child: Option<Child>,
    files: Option<[PathBuf; 2]>,
    refuse_collection: bool,
    unpublished_socket: Option<std::io::Result<PathBuf>>,
}

impl DirectForeground {
    fn spawn(
        &mut self,
        root: &TempDir,
        state: &Path,
        config: &Path,
        gated: bool,
    ) -> std::io::Result<()> {
        let paths = ["foreground.stdout", "foreground.stderr"].map(|n| root.path().join(n));
        let stdout = fs::File::create(&paths[0])?;
        let stderr = fs::File::create(&paths[1])?;
        self.files = Some(paths);
        self.child = Some(
            owned_foreground_command(root, state, config, gated)
                .stdout(stdout)
                .stderr(stderr)
                .spawn()?,
        );
        Ok(())
    }

    // A failed acquisition leaves unlink authority unresolved. Record what was
    // present before collection so a disappearing/replaced leaf cannot qualify.
    fn record_missing_owner(
        &mut self,
        state: &Path,
        config: &Path,
        observed: Option<&ExactFixtureSocket>,
        error: &std::io::Error,
    ) {
        self.unpublished_socket.get_or_insert_with(|| {
            if observed.is_some() || error.kind() != std::io::ErrorKind::NotFound {
                return Err(std::io::Error::other(format!(
                    "unresolved socket observation: {error}"
                )));
            }
            let path = direct_socket_path(state, config)?;
            require_absent(&path)?;
            Ok(path)
        });
        eprintln!(
            "direct foreground socket observation before collection: {error}; disposition={:?}",
            self.unpublished_socket
        );
    }

    fn collect_after_missing_owner(
        &mut self,
        state: &Path,
        config: &Path,
        observed: Option<&ExactFixtureSocket>,
        error: &std::io::Error,
    ) -> std::io::Result<()> {
        self.record_missing_owner(state, config, observed, error);
        let collected = self.collect();
        if let Some(files) = &self.files {
            eprintln!(
                "partial foreground collected={collected:?} stdout/stderr={:?}",
                files.each_ref().map(|p| gate_diagnostic_bytes(p))
            );
        }
        collected?;
        self.check_unpublished(state, config)
    }

    fn check_unpublished(&self, state: &Path, config: &Path) -> std::io::Result<()> {
        if let Some(observation) = &self.unpublished_socket {
            let path = observation
                .as_ref()
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            require_absent(path)?;
            let instance = direct_instance(state, config)?;
            for name in ["control.json", "pid.cache"] {
                require_absent(&state.join("instances").join(&instance).join(name))?;
            }
            for id in ["a", "b"] {
                let control = routecodex_v3_config::v3_active_key_control_paths(config, id)
                    .map_err(std::io::Error::other)?;
                require_absent(&control.record)?;
            }
        }
        Ok(())
    }

    fn observe(&mut self, budget: Duration) -> std::io::Result<Option<std::process::ExitStatus>> {
        let child = self
            .child
            .as_mut()
            .ok_or_else(|| std::io::Error::other("no direct child"))?;
        let deadline = Instant::now() + budget;
        while Instant::now() < deadline {
            let status = child.try_wait()?;
            if status.is_some() {
                return Ok(status);
            }
            sleep(Duration::from_millis(50));
        }
        Ok(None)
    }

    fn collect(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        if self.refuse_collection {
            return Err(std::io::Error::other(
                "fixture refused direct child collection",
            ));
        }
        let Some(child) = self.child.as_mut() else {
            return Ok(None);
        };
        if let Some(status) = child.try_wait()? {
            self.child = None;
            return Ok(Some(status));
        }
        let signal = child.kill();
        let observed = self.observe(Duration::from_secs(2));
        if let Ok(Some(status)) = observed {
            signal?;
            self.child = None;
            return Ok(Some(status));
        }
        Err(std::io::Error::other(format!(
            "direct child collection: signal={signal:?} observed={observed:?}"
        )))
    }
}

fn direct_instance(state: &Path, config: &Path) -> std::io::Result<String> {
    routecodex_v3_lifecycle::V3ManagedLifecycle::with_state_root(config, state)
        .declaration(env!("CARGO_BIN_EXE_rccv3"))
        .map(|(decl, _)| decl.instance_id)
        .map_err(std::io::Error::other)
}

fn direct_socket_path(state: &Path, config: &Path) -> std::io::Result<PathBuf> {
    Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../build-control/temp")
        .join(format!(
            "routecodex-{}.sock",
            direct_instance(state, config)?
        )))
}

fn owned_foreground_command(root: &TempDir, state: &Path, config: &Path, gated: bool) -> Command {
    let binary = env!("CARGO_BIN_EXE_rccv3");
    let mut cmd = if gated {
        let mut gate = managed_test_command("/bin/sh", state);
        gate.args([
            "-c",
            "read -r permit && exec \"$@\"",
            "foreground-gate",
            binary,
        ])
        .stdin(std::process::Stdio::piped());
        gate
    } else {
        managed_test_command(binary, state)
    };
    cmd.args(["start", "--config"])
        .arg(config)
        .env("HOME", root.path().join("home"))
        .env("ROUTECODEX_V3_STATE_DIR", state)
        .env(
            "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
            request_counter_file(state),
        )
        .env("V3_MANAGED_TEST_KEY", SECRET);
    cmd
}

fn check_foreground_ready(state: &Path, ports: [u16; 2], old_pid: u32) {
    for port in ports {
        wait_port(port, true);
    }
    let previous = single_instance_dir(state);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let status: Value =
            serde_json::from_slice(&fs::read(previous.join("status.json")).unwrap()).unwrap();
        if status["state"] == "running" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "original foreground child did not reach Running"
        );
        thread::yield_now();
    }
    let published_cache: Value =
        serde_json::from_slice(&fs::read(previous.join("pid.cache")).unwrap()).unwrap();
    assert_eq!(published_cache["pid"], old_pid);
}

fn admit_fixture(
    guard: &MutexGuard<'static, ()>,
    make: impl FnOnce() -> FixtureResources,
) -> ExactFixtureOwner {
    exact_recover(guard).unwrap();
    let owner = ExactFixtureOwner::new(std::sync::Mutex::new(make()));
    let mut slot = RETAINED_EXACT_FIXTURE
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let current = std::sync::Arc::ptr_eq(slot.get_or_insert_with(|| owner.clone()), &owner);
    drop(slot);
    assert!(current, "previous fixture still owns admission");
    owner
}

fn interrupted_exec_recovery(
    guard: &MutexGuard<'static, ()>,
    changed_dir: bool,
    published: bool,
    entry: &str,
    retired_state: Option<&str>,
) {
    observe_interrupted_exec(
        guard,
        changed_dir,
        published,
        entry,
        retired_state,
        false,
        None,
    );
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NativeFault {
    Prepublication,
    Collection,
    LockedStop,
    Observation,
}

#[derive(Default)]
struct InterruptedNative {
    root: Option<TempDir>,
    provider: Option<ActiveProvider>,
    original: Option<(PathBuf, [u16; 2])>,
    target: Option<PathBuf>,
    direct: DirectForeground,
    predecessor: Option<ExactFixtureSocket>,
    controls: Vec<std::net::SocketAddr>,
    // Each successful launch/return has its own actual generation and socket.
    generations: Vec<NativeGeneration>,
    pending_launch: Option<PathBuf>,
    stopped: bool,
    interrupted: bool,
    observation_fault: bool,
    operation_lock: Option<ExactOperationLock>,
    measurement: Option<String>,
    reply: String,
    stop_result: Option<std::process::Output>,
    errors: Vec<String>,
    secondary: Option<ExactPanic>,
}

struct NativeGeneration {
    config: PathBuf,
    witness: ExactStopWitness,
    socket: ExactFixtureSocket,
    pid: u64,
}

impl NativeGeneration {
    fn check_live(&self) -> std::io::Result<()> {
        let current = ExactStopWitness::read(&self.witness.instance)?;
        self.socket.verify_identity()?;
        if self.witness.cache != current.cache
            || self.witness.control != current.control
            || self.witness.declaration != current.declaration
            || self.pid != exact_socket_peer(&self.socket.path)?
            || self.witness.cache["start_nonce"]
                .as_str()
                .is_none_or(str::is_empty)
            || self.witness.cache["start_nonce"] != self.witness.control["start_nonce"]
            || self.witness.declaration["config_path"].as_str()
                != self.config.canonicalize()?.to_str()
        {
            return Err(std::io::Error::other("native current generation disagrees"));
        }
        self.socket.verify_identity()
    }
}

fn record_native_generation(
    generations: &mut Vec<NativeGeneration>,
    controls: &mut Vec<std::net::SocketAddr>,
    config: &Path,
    instance: &Path,
) -> std::io::Result<()> {
    let witness = ExactStopWitness::read(instance)?;
    let pid = witness.cache["pid"]
        .as_u64()
        .ok_or_else(|| std::io::Error::other("missing successor PID"))?;
    let socket = ExactFixtureSocket::capture(managed_socket(&witness.control))?;
    generations.push(NativeGeneration {
        config: config.to_owned(),
        witness,
        pid,
        socket,
    });
    let generation = generations.last_mut().unwrap();
    generation.check_live()?;
    generation.socket.verified = true;
    for id in ["a", "b"] {
        let record = routecodex_v3_config::v3_active_key_control_paths(config, id)
            .map_err(std::io::Error::other)?;
        let address = endpoint(&record.read().map_err(std::io::Error::other)?)
            .ok_or_else(|| std::io::Error::other("missing native control endpoint"))?;
        controls.push(address);
    }
    Ok(())
}

impl InterruptedNative {
    fn cleanup(&mut self) -> Result<(), String> {
        self.close().map_err(|e| e.to_string())
    }

    fn stop_settled_generation(&mut self) -> std::io::Result<()> {
        if let Some(config) = &self.pending_launch {
            return Err(std::io::Error::other(format!(
                "unresolved native launch at {config:?}"
            )));
        }
        if let Some(current) = self
            .generations
            .last()
            .filter(|_| !self.stopped && !self.interrupted && !self.direct.refuse_collection)
        {
            let root = self.root.as_ref().unwrap();
            current.check_live()?;
            let stop = isolated_lifetime_process(
                root,
                &root.path().join("state"),
                &current.config,
                "stop",
            )
            .output()?;
            if !stop.status.success() {
                if exact_stop_locked(&stop) {
                    if let Some(lock) = &self.operation_lock {
                        lock.verify()?;
                    }
                    current.check_live()?;
                    return Err(std::io::Error::other(
                        "ordinary native Stop operation locked",
                    ));
                }
                return Err(std::io::Error::other(format!(
                    "ordinary native Stop failed {}",
                    stop.status
                )));
            }
            self.stopped = true;
        }
        Ok(())
    }

    fn close(&mut self) -> std::io::Result<()> {
        let stop = self.stop_settled_generation();
        let Some(root) = &self.root else {
            self.direct.collect()?;
            return stop;
        };
        let acquisition = (|| -> std::io::Result<()> {
            if let Some(child) = self
                .direct
                .child
                .as_ref()
                .filter(|_| self.predecessor.as_ref().is_none_or(|s| !s.verified))
            {
                let (config, _) = self
                    .original
                    .as_ref()
                    .ok_or_else(|| std::io::Error::other("missing direct child config"))?;
                let state = root.path().join("state");
                if let Err(error) = exact_launch_owner(
                    &state,
                    config,
                    &mut self.predecessor,
                    Some(child.id()),
                    None,
                ) {
                    self.direct.record_missing_owner(
                        &state,
                        config,
                        self.predecessor.as_ref(),
                        &error,
                    );
                }
            }
            Ok(())
        })();
        let collected = self.direct.collect()?;
        if let Some(files) = &self.direct.files {
            let output = files.each_ref().map(|path| gate_diagnostic_bytes(path));
            eprintln!("native collected stdout/stderr={output:?} collected={collected:?}");
            for result in output {
                result?;
            }
        }
        stop?;
        acquisition?;
        if self.interrupted {
            return Err(std::io::Error::other(if self.observation_fault {
                "native observation consumption fault; unresolved lifecycle handoff"
            } else {
                "interrupted predecessor retains unresolved lifecycle handoff"
            }));
        }
        if let Some((config, ports)) = &self.original {
            self.direct
                .check_unpublished(&root.path().join("state"), config)?;
            for addr in self
                .controls
                .iter()
                .copied()
                .chain(ports.map(|port| ([127, 0, 0, 1], port).into()))
            {
                if !matches!(TcpStream::connect(addr), Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused)
                {
                    return Err(std::io::Error::other(format!("expected refusal at {addr}")));
                }
            }
            if !self.generations.is_empty() {
                for path in std::iter::once(config).chain(self.target.iter()) {
                    for id in ["a", "b"] {
                        let record = routecodex_v3_config::v3_active_key_control_paths(path, id)
                            .map_err(std::io::Error::other)?
                            .record;
                        require_absent(&record)?;
                    }
                }
            }
        }
        // A newer generation may reuse the same pathname. Never remove its
        // leaf to make the predecessor identity check succeed by absence.
        for socket in self
            .predecessor
            .iter()
            .chain(self.generations.iter().map(|g| &g.socket))
        {
            match socket.verify_identity() {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                other => other?,
            }
        }
        for gen in &self.generations {
            if !wait_for_explicit_pid_exit(gen.pid, Duration::from_secs(5)) {
                return Err(std::io::Error::other(format!(
                    "native successor {} still present",
                    gen.pid
                )));
            }
            for name in ["control.json", "pid.cache"] {
                require_absent(&gen.witness.instance.join(name))?;
            }
            gen.socket.remove_if_inactive()?;
        }
        if let Some(socket) = &self.predecessor {
            socket.remove_if_inactive()?;
        }
        if let Some(provider) = &mut self.provider {
            provider.producers_ended = true;
            provider.finish_quiescent(true)?;
            if self.direct.unpublished_socket.is_some() {
                eprintln!("pre-publication child collected; socket and control records absent; ports={:?} recorder={} joined and refused", self.original.as_ref().unwrap().1, provider.port);
            }
        }
        exact_remove_root(root)?;
        eprintln!("closed root={}", root.path().display());
        Ok(())
    }
}

#[test]
fn native_prepublication_unwind_collects_adopted_child() {
    use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};
    let guard = lifecycle_test_guard();
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        observe_interrupted_exec(
            &guard,
            false,
            false,
            "start",
            None,
            false,
            Some(NativeFault::Prepublication),
        );
    }))
    .expect_err("pre-publication gate must interrupt the exercise");
    let marker = outcome
        .downcast::<PrepublicationMarker>()
        .unwrap_or_else(|primary| resume_unwind(primary));
    assert!(
        retained_exact(&guard).is_none(),
        "common cleanup retained gated foreground"
    );
    require_absent(&marker.root).unwrap();
    assert!(wait_for_explicit_pid_exit(
        marker.pid.into(),
        Duration::from_secs(2)
    ));
}

#[derive(Debug)]
struct PrepublicationMarker {
    root: PathBuf,
    pid: u32,
}

#[test]
fn native_collection_refusal_retains_rejected_foreground() {
    check_native_retention(NativeFault::Collection);
}

#[test]
fn native_stop_refusal_retains_current_generation() {
    check_native_retention(NativeFault::LockedStop);
}

fn native_json(dir: &Path, name: &str) -> Value {
    serde_json::from_slice(&fs::read(dir.join(name)).unwrap()).unwrap()
}

fn native_image_command(root: &TempDir, config: &Path, op: &str) -> std::process::Output {
    let state = root.path().join("state");
    let image = root.path().join("successor-cli");
    let mut command = managed_test_command(image.to_str().unwrap(), &state);
    if op != "restart" {
        command.arg("server");
    }
    command
        .args([op, "--config"])
        .arg(config)
        .env("HOME", root.path().join("home"))
        .env("ROUTECODEX_V3_STATE_DIR", &state)
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .output()
        .unwrap()
}

#[derive(PartialEq)]
struct NativeObservationFault {
    root: PathBuf,
    original_pid: u64,
    recorder: thread::ThreadId,
    measurement: String,
    reply: String,
    leaves: Vec<Option<Vec<u8>>>,
    output: [String; 2],
}

impl InterruptedNative {
    fn observation_evidence(&self) -> NativeObservationFault {
        let root = self.root.as_ref().unwrap().path();
        let original = &self.generations[0];
        let state = root.join("state");
        let target = self.target.as_ref().unwrap();
        let target_dir = state
            .join("instances")
            .join(direct_instance(&state, target).unwrap());
        let provider = self.provider.as_ref().unwrap();
        let recorder = provider.task.as_ref().unwrap();
        assert!(self.interrupted && !self.stopped && !recorder.is_finished());
        assert!(provider.visits.lock().unwrap().is_empty() && self.secondary.is_none());
        original.socket.verify_identity().unwrap();
        let mut leaves = Vec::new();
        for dir in [&original.witness.instance, &target_dir] {
            for name in [
                "exec-restart-declaration.json",
                "front-handoff.json",
                "provider-handoff.json",
                "control.json",
                "pid.cache",
                "status.json",
                "instance.json",
                "restart.plan.json",
            ] {
                leaves.push(match fs::read(dir.join(name)) {
                    Ok(bytes) => Some(bytes),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                    Err(e) => panic!("reading {dir:?}/{name}: {e}"),
                });
            }
        }
        for id in ["a", "b"] {
            leaves.push(Some(
                routecodex_v3_config::v3_active_key_control_paths(&original.config, id)
                    .unwrap()
                    .read()
                    .unwrap(),
            ));
        }
        NativeObservationFault {
            root: root.to_owned(),
            original_pid: original.pid,
            recorder: recorder.thread().id(),
            measurement: self.measurement.clone().unwrap(),
            reply: self.reply.clone(),
            leaves,
            output: self
                .direct
                .files
                .as_ref()
                .unwrap()
                .each_ref()
                .map(|p| gate_diagnostic_bytes(p).unwrap()),
        }
    }
}

#[test]
fn native_published_handoff_observation_failure_retains_collected_scope() {
    use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};
    let guard = lifecycle_test_guard();
    for changed_dir in [false, true] {
        let primary = catch_unwind(AssertUnwindSafe(|| {
            observe_interrupted_exec(
                &guard,
                changed_dir,
                false,
                "start",
                None,
                false,
                Some(NativeFault::Observation),
            )
        }))
        .expect_err("observation consumption must interrupt exercise")
        .downcast::<NativeObservationFault>()
        .unwrap_or_else(|p| resume_unwind(p));
        let owner = retained_exact(&guard).expect("published handoff retained");
        let verify = || {
            assert!(std::sync::Arc::ptr_eq(
                &owner,
                &retained_exact(&guard).unwrap()
            ));
            let locked = owner.lock().unwrap_or_else(|e| e.into_inner());
            let FixtureResources::InterruptedNative(native) = &*locked else {
                unreachable!()
            };
            assert!(native.direct.child.is_none());
            assert!(
                *primary == native.observation_evidence(),
                "native observation evidence changed"
            );
        };
        verify();
        assert!(wait_for_explicit_pid_exit(
            primary.original_pid,
            Duration::from_secs(2)
        ));
        for reason in [
            "observation consumption fault",
            "retains unresolved lifecycle handoff",
        ] {
            let refusal = exact_recover(&guard).unwrap_err();
            assert!(refusal.contains(reason), "{refusal}");
            verify();
            eprintln!("published observation retained changed_dir={changed_dir} pid={} recorder={:?} reason={refusal} measurement={}", primary.original_pid, primary.recorder, primary.measurement);
            let mut locked = owner.lock().unwrap_or_else(|e| e.into_inner());
            let FixtureResources::InterruptedNative(native) = &mut *locked else {
                unreachable!()
            };
            if native.observation_fault {
                native.observation_fault = false;
            }
        }
        {
            let mut locked = owner.lock().unwrap_or_else(|e| e.into_inner());
            let FixtureResources::InterruptedNative(native) = &mut *locked else {
                unreachable!()
            };
            assert_eq!(native.errors.len(), 3);
            assert!(native.errors[0].contains("observation consumption fault"));
            fs::copy(
                env!("CARGO_BIN_EXE_rccv3"),
                primary.root.join("successor-cli"),
            )
            .unwrap();
            native.recover_business_and_stop("start", None);
            assert!(native.stopped && !native.interrupted);
            assert_eq!(native.measurement.as_ref(), Some(&primary.measurement));
        }
        exact_recover(&guard).unwrap();
        require_absent(&primary.root).unwrap();
        assert!(retained_exact(&guard).is_none());
    }
}

fn check_native_retention(fault: NativeFault) {
    use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};
    let guard = lifecycle_test_guard();
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        observe_interrupted_exec(
            &guard,
            false,
            false,
            "start",
            None,
            fault == NativeFault::Collection,
            Some(fault),
        )
    }));
    let owner = retained_exact(&guard);
    let Some(owner) = owner else {
        if let Err(primary) = outcome {
            resume_unwind(primary);
        }
        panic!("native control failed to retain fixture");
    };
    let observed = catch_unwind(AssertUnwindSafe(|| {
        let snapshot = || {
            let locked = owner.lock().unwrap_or_else(|e| e.into_inner());
            let FixtureResources::InterruptedNative(native) = &*locked else {
                unreachable!()
            };
            let provider = native.provider.as_ref().unwrap();
            let root = native.root.as_ref().unwrap().path();
            let task = provider.task.as_ref().unwrap();
            assert!(root.is_dir() && !task.is_finished() && native.secondary.is_none());
            let (socket, pid) = match fault {
                NativeFault::Prepublication | NativeFault::Observation => unreachable!(),
                NativeFault::Collection => {
                    assert!(native
                        .measurement
                        .as_ref()
                        .is_some_and(|s| s.contains("exited_in_five_seconds=false")
                            && s.contains("observed=Ok(None)")
                            && s.contains("not an executable regular file")));
                    assert!(native
                        .errors
                        .iter()
                        .any(|e| e.contains("refused direct child collection")));
                    assert!(provider.visits.lock().unwrap().is_empty());
                    (
                        native.predecessor.as_ref().unwrap(),
                        u64::from(native.direct.child.as_ref().unwrap().id()),
                    )
                }
                NativeFault::LockedStop => {
                    assert!(exact_stop_locked(native.stop_result.as_ref().unwrap()));
                    native.operation_lock.as_ref().unwrap().verify().unwrap();
                    let current = native.generations.last().unwrap();
                    current.check_live().unwrap();
                    assert_eq!(
                        *provider.visits.lock().unwrap(),
                        vec!["uncached connection probe"]
                    );
                    (&current.socket, current.pid)
                }
            };
            assert!(socket.verified);
            socket.verify_identity().unwrap();
            assert_eq!(exact_socket_peer(&socket.path).unwrap(), pid);
            (
                root.to_owned(),
                pid,
                socket.device,
                socket.inode,
                task.thread().id(),
            )
        };
        let before = snapshot();
        let refusal = exact_recover(&guard).unwrap_err();
        assert!(refusal.contains(match fault {
            NativeFault::Prepublication | NativeFault::Observation => unreachable!(),
            NativeFault::Collection => "refused direct child collection",
            NativeFault::LockedStop => "Stop operation locked",
        }));
        assert!(std::sync::Arc::ptr_eq(
            &owner,
            &retained_exact(&guard).unwrap()
        ));
        assert_eq!(before, snapshot());
        eprintln!("native retained {fault:?}: root={:?} pid={} device={} inode={} recorder={:?}; recovery={refusal}",before.0,before.1,before.2,before.3,before.4);
        before.0
    }));
    {
        let mut locked = owner.lock().unwrap_or_else(|e| e.into_inner());
        let FixtureResources::InterruptedNative(native) = &mut *locked else {
            unreachable!()
        };
        native.direct.refuse_collection = false;
        ExactOperationLock::restore(&mut native.operation_lock).unwrap();
    }
    let recovered = exact_recover(&guard);
    match outcome {
        Err(primary) if primary.downcast_ref::<NativeFault>() == Some(&fault) => (),
        Err(primary) => resume_unwind(primary),
        Ok(()) => panic!("missing native fault"),
    }
    recovered.unwrap();
    require_absent(&observed.unwrap_or_else(|e| resume_unwind(e))).unwrap();
    assert!(retained_exact(&guard).is_none());
}

fn require_absent(path: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
        Ok(_) => Err(std::io::Error::other(format!("still present: {path:?}"))),
    }
}

fn observe_interrupted_exec(
    guard: &MutexGuard<'static, ()>,
    changed_dir: bool,
    published: bool,
    entry: &str,
    retired_state: Option<&str>,
    reject_image: bool,
    fault: Option<NativeFault>,
) {
    let owner = admit_fixture(
        guard,
        || FixtureResources::InterruptedNative(Box::default()),
    );
    let mut locked = owner.lock().unwrap_or_else(|e| e.into_inner());
    let FixtureResources::InterruptedNative(native) = &mut *locked else {
        unreachable!()
    };
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        native.exercise(
            changed_dir,
            published,
            entry,
            retired_state,
            reject_image,
            fault,
        )
    }));
    let cleanup = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| native.cleanup()));
    let closed = matches!(cleanup, Ok(Ok(())));
    match cleanup {
        Ok(Ok(())) => clear_closed_exact(guard),
        Ok(Err(error)) => {
            eprintln!("retained native fixture: {error}");
            native.errors.push(error);
        }
        Err(cause) if outcome.is_err() => native.secondary = Some(cause),
        Err(cause) => std::panic::resume_unwind(cause),
    }
    drop(locked);
    if let Err(primary) = outcome {
        std::panic::resume_unwind(primary);
    }
    assert!(closed, "native fixture closure unresolved");
}

impl InterruptedNative {
    fn exercise(
        &mut self,
        changed_dir: bool,
        published: bool,
        entry: &str,
        retired_state: Option<&str>,
        reject_image: bool,
        fault: Option<NativeFault>,
    ) {
        let root = self.root.insert(TempDir::new().unwrap());
        root.disable_cleanup(true);
        let root = &*root;
        let state = root.path().join("state");
        let provider = self.provider.insert(ActiveProvider::start());
        provider
            .fail
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let (config, ports) = managed_lifetime_config(root, "127.0.0.1", provider.port);
        self.original = Some((config.clone(), ports));
        let process = &mut self.direct;
        let gated = fault == Some(NativeFault::Prepublication);
        process.spawn(root, &state, &config, gated).unwrap();
        if gated {
            let child = process.child.as_mut().unwrap();
            assert!(child.stdin.is_some() && child.try_wait().unwrap().is_none());
            require_absent(&direct_socket_path(&state, &config).unwrap()).unwrap();
            eprintln!(
                "pre-publication adopted direct_pid={} root={:?} socket absent",
                child.id(),
                root.path()
            );
            std::panic::panic_any(PrepublicationMarker {
                root: root.path().to_owned(),
                pid: child.id(),
            });
        }
        check_foreground_ready(&state, ports, process.child.as_ref().unwrap().id());
        let old_pid = process.child.as_ref().unwrap().id();
        let previous = single_instance_dir(&state);
        let control = managed_control(&previous);
        let old_socket = managed_socket(&control);
        let socket = self
            .predecessor
            .insert(ExactFixtureSocket::capture(old_socket.clone()).unwrap());
        socket.verify_identity().unwrap();
        assert_eq!(exact_socket_peer(&socket.path).unwrap(), u64::from(old_pid));
        socket.verify_identity().unwrap();
        socket.verified = true;
        record_native_generation(
            &mut self.generations,
            &mut self.controls,
            &config,
            &previous,
        )
        .unwrap();
        assert_eq!(self.generations[0].pid, u64::from(old_pid));
        let target_config = if changed_dir {
            let path = root.path().join("successor.toml");
            fs::copy(&config, &path).unwrap();
            path
        } else {
            config.clone()
        };
        let image = root.path().join("successor-cli");
        self.target = Some(target_config.clone());
        fs::write(&image, "#!/bin/sh\nexit 19\n").unwrap();
        fs::set_permissions(&image, fs::Permissions::from_mode(0o700)).unwrap();
        let (target, _) =
            routecodex_v3_lifecycle::V3ManagedLifecycle::with_state_root(&target_config, &state)
                .declaration(&image)
                .unwrap();
        let target_dir = state.join("instances").join(&target.instance_id);
        if reject_image {
            fs::set_permissions(&image, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let original_front = fs::read(previous.join("front-handoff.json")).unwrap();
        self.interrupted = true;
        // Public restart requests that change only the executable carry the
        // image in executable_path. A rejected request leaves its plan for
        // the original generation's ordinary Stop to settle.
        let plan_target = (!reject_image || changed_dir).then_some(&target);
        fs::write(previous.join("restart.plan.json"),serde_json::to_vec(&serde_json::json!({
            "schema_version":1,"instance_id":control["instance_id"],"start_nonce":control["start_nonce"],
            "executable_path":image,"target_declaration":plan_target,"snapshots":false,"snapshot_direct":false,"snapshot_stages":null,"sse_dump":false
        })).unwrap()).unwrap();
        let mut stream = p0_control_stream(&control);
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        writeln!(stream,"{}",serde_json::json!({"schema_version":1,"instance_id":control["instance_id"],"start_nonce":control["start_nonce"],"operation":"restart"})).unwrap();
        let mut reply = String::new();
        let read_start = Instant::now();
        let eof = BufReader::new(stream).take(8192).read_line(&mut reply);
        let wait_start = Instant::now();
        let observed = process.observe(Duration::from_secs(5));
        let exited = matches!(observed, Ok(Some(_)));
        let elapsed = wait_start.elapsed();
        let exit19 = exited && matches!(observed, Ok(Some(status)) if status.code() == Some(19));
        let response = serde_json::from_str::<Value>(&reply).ok();
        let rejected = response.as_ref().filter(|r| r["accepted"] == false);
        let non_executable = rejected.is_some_and(|r| {
            r["message"]
                .as_str()
                .is_some_and(|m| m.contains("restart executable is not an executable regular file"))
        });
        let reply_class = match (&eof, non_executable, rejected) {
            (Err(_), _, _) => "read error",
            (Ok(0), _, _) => "EOF",
            (_, true, _) => "rejected: restart executable is not an executable regular file",
            (_, _, Some(_)) => "rejected: other cause",
            _ => "other reply",
        };
        self.reply.clone_from(&reply);
        eprintln!("native exit observation changed_dir={changed_dir} published={published} entry={entry} retired={retired_state:?} negative={reject_image} root={:?} state={state:?} config={config:?} target_dir={target_dir:?} direct_pid={old_pid} read={eof:?} read_elapsed={:?} reply={reply_class} wait_start={wait_start:?} wait_elapsed={elapsed:?} exited_in_budget={exited} observed={observed:?} provider_visits={}", root.path(), wait_start.duration_since(read_start), provider.visits.lock().unwrap().len());
        let handoffs = [
            "exec-restart-declaration.json",
            "front-handoff.json",
            "provider-handoff.json",
        ]
        .map(|name| {
            (
                name,
                fs::symlink_metadata(target_dir.join(name))
                    .map(|m| m.file_type())
                    .map_err(|e| e.kind()),
            )
        });
        eprintln!(
            "native artifacts prior/target={:?} target_handoffs={handoffs:?}",
            gate_instance_state(&state)
        );
        self.measurement = Some(format!("exited_in_five_seconds={exited} observed={observed:?} reply={reply_class} elapsed={elapsed:?}"));
        if !exit19 {
            eprintln!("original native failure direct_pid={old_pid} exited_in_five_seconds={exited} expected_exit=19 observed={observed:?}");
            assert!(
                reject_image
                    && matches!(observed, Ok(None))
                    && non_executable
                    && provider.visits.lock().unwrap().is_empty(),
                "original native exit failure: {:?}",
                self.measurement
            );
            self.generations[0].check_live().unwrap();
            assert!(fs::read(previous.join("front-handoff.json")).unwrap() == original_front);
            require_absent(&target_dir.join("exec-restart-declaration.json")).unwrap();
            require_absent(&previous.join("provider-handoff.json")).unwrap();
            if changed_dir {
                require_absent(&target_dir.join("front-handoff.json")).unwrap();
                require_absent(&target_dir.join("provider-handoff.json")).unwrap();
            }
            self.interrupted = false;
            if fault == Some(NativeFault::Collection) {
                process.refuse_collection = true;
                std::panic::panic_any(NativeFault::Collection);
            }
            return;
        }
        assert!(!reject_image, "non-executable image unexpectedly exited 19");
        let output = process
            .files
            .as_ref()
            .unwrap()
            .each_ref()
            .map(|path| gate_diagnostic_bytes(path));
        eprintln!("native collected stdout/stderr={output:?}");
        if fault == Some(NativeFault::Observation) {
            assert!(matches!(eof, Ok(0)));
            assert_eq!(
                native_json(&target_dir, "exec-restart-declaration.json"),
                serde_json::to_value(&target).unwrap()
            );
            let front = native_json(&target_dir, "front-handoff.json");
            assert!(front["declaration"] == serde_json::to_value(&target).unwrap());
            assert!(front["origin"] == self.generations[0].witness.cache);
            let _checkpoint = native_json(&previous, "provider-handoff.json");
            self.observation_fault = true;
            std::panic::panic_any(self.observation_evidence());
        }
        assert_eq!(process.collect().unwrap().unwrap().code(), Some(19));
        assert!(wait_for_explicit_pid_exit(
            old_pid.into(),
            Duration::from_secs(5)
        ));
        let cached = target_dir.join("pid.cache").exists();
        let staged = target_dir.join("exec-restart-declaration.json").is_file()
            && target_dir.join("front-handoff.json").is_file();
        let prior_front = fs::read(target_dir.join("front-handoff.json")).unwrap();
        let predecessor_cache = previous.join("pid.cache");
        if published {
            // Materialize the two durable adoption writes after the real exec
            // exit. The predecessor's actual socket, control and leaves remain.
            let mut successor: Value =
                serde_json::from_slice(&fs::read(&predecessor_cache).unwrap()).unwrap();
            successor["retained_control"] = serde_json::json!({
                "target": target, "instance_id": successor["instance_id"],
                "start_nonce": successor["start_nonce"],
                "started_at_epoch_ms": successor["started_at_epoch_ms"]
            });
            successor["start_nonce"] = serde_json::json!("fixture-adopted-generation");
            fs::write(&predecessor_cache, serde_json::to_vec(&successor).unwrap()).unwrap();
            fs::rename(
                target_dir.join("exec-restart-declaration.json"),
                target_dir.join("instance.json"),
            )
            .unwrap();
        }
        let cache_bytes = fs::read(&predecessor_cache).unwrap();
        let original_paths = ["a", "b"]
            .map(|id| routecodex_v3_config::v3_active_key_control_paths(&config, id).unwrap());
        let original_bytes = original_paths.each_ref().map(|path| path.read().unwrap());
        fs::copy(env!("CARGO_BIN_EXE_rccv3"), &image).unwrap();
        let invoke = |op| native_image_command(root, &target_config, op);
        // Rotate the independent cache evidence while leaving the authentic
        // artifact in place. Both mismatches must stop before Server disposal.
        let mut rejected = Vec::new();
        let predecessor_control = previous.join("control.json");
        if let Some(state) = retired_state {
            socket.remove_if_inactive().unwrap();
            fs::remove_file(&predecessor_control).unwrap();
            let path = target_dir.join("status.json");
            let mut status: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            status["state"] = serde_json::json!(state);
            fs::write(path, serde_json::to_vec(&status).unwrap()).unwrap();
        }
        let original_control = fs::read(&predecessor_control).ok();
        let status_path = target_dir.join("status.json");
        let initial_status = fs::read(&status_path).ok();
        for field in [Some("start_nonce"), Some("instance_id"), None] {
            let mut other: Value = serde_json::from_slice(&cache_bytes).unwrap();
            if let Some(field) = field {
                let evidence = if published {
                    &mut other["retained_control"]
                } else {
                    &mut other
                };
                evidence[field] = serde_json::json!("different-managed-generation");
                fs::write(&predecessor_cache, serde_json::to_vec(&other).unwrap()).unwrap();
            } else {
                fs::remove_file(&predecessor_cache).unwrap();
            }
            let proof = fs::read(&predecessor_cache).ok();
            let attempt = invoke(entry);
            let preserved = original_paths
                .iter()
                .zip(&original_bytes)
                .all(|(path, bytes)| path.read().ok().as_ref() == Some(bytes))
                && fs::read(target_dir.join("front-handoff.json"))
                    .ok()
                    .as_ref()
                    == Some(&prior_front);
            rejected.push(
                !attempt.status.success()
                    && preserved
                    && ports
                        .iter()
                        .all(|p| TcpStream::connect(("127.0.0.1", *p)).is_err())
                    && fs::read(&predecessor_control).ok() == original_control
                    && fs::read(&predecessor_cache).ok() == proof
                    && fs::read(&status_path).ok() == initial_status,
            );
        }
        fs::write(&predecessor_cache, &cache_bytes).unwrap();
        let mut status_preserved = true;
        if entry == "restart" {
            let mut foreign =
                serde_json::from_slice::<Value>(&fs::read(previous.join("status.json")).unwrap())
                    .unwrap();
            foreign["instance_id"] = serde_json::json!("another-instance");
            let bytes = serde_json::to_vec(&foreign).unwrap();
            fs::write(&status_path, &bytes).unwrap();
            let refused = invoke(entry);
            status_preserved = !refused.status.success()
                && fs::read(&status_path).ok().as_ref() == Some(&bytes)
                && fs::read(&predecessor_control).ok() == original_control
                && fs::read(&predecessor_cache).ok().as_ref() == Some(&cache_bytes)
                && fs::read(target_dir.join("front-handoff.json"))
                    .ok()
                    .as_ref()
                    == Some(&prior_front)
                && original_paths
                    .iter()
                    .zip(&original_bytes)
                    .all(|(path, bytes)| path.read().ok().as_ref() == Some(bytes));
            match &initial_status {
                Some(bytes) => fs::write(&status_path, bytes).unwrap(),
                None => fs::remove_file(&status_path).unwrap(),
            }
        }
        let return_to_original = changed_dir && entry == "restart";
        let foreign_preserved = if (published && retired_state.is_none()) || return_to_original {
            let path = previous.join("control.json");
            let predecessor_front = previous.join("front-handoff.json");
            let front_bytes = fs::read(&predecessor_front).unwrap();
            let original = fs::read(&path).unwrap();
            let mut foreign = control.clone();
            foreign["start_nonce"] = serde_json::json!("unrelated-control");
            let bytes = serde_json::to_vec(&foreign).unwrap();
            fs::write(&path, &bytes).unwrap();
            let refused = invoke(entry);
            let preserved = !refused.status.success()
                && old_socket.exists()
                && !front_bytes.is_empty()
                && fs::read(&predecessor_front).ok().as_ref() == Some(&front_bytes)
                && fs::read(&predecessor_cache).ok().as_ref() == Some(&cache_bytes)
                && fs::read(&path).ok().as_ref() == Some(&bytes)
                && fs::read(target_dir.join("front-handoff.json"))
                    .ok()
                    .as_ref()
                    == Some(&prior_front)
                && original_paths
                    .iter()
                    .zip(&original_bytes)
                    .all(|(p, b)| p.read().ok().as_ref() == Some(b));
            fs::write(path, original).unwrap();
            preserved
        } else {
            true
        };
        let pending_preserved = if return_to_original {
            let provider_file = previous.join("provider-handoff.json");
            let saved = previous.join("fixture-saved-provider");
            fs::rename(&provider_file, &saved).unwrap();
            fs::create_dir(&provider_file).unwrap();
            let pending = invoke(entry);
            let retained = !pending.status.success()
                && provider_file.is_dir()
                && fs::read(target_dir.join("front-handoff.json"))
                    .ok()
                    .as_ref()
                    == Some(&prior_front)
                && fs::read(&predecessor_cache).ok().as_ref() == Some(&cache_bytes)
                && fs::read(&predecessor_control).ok() == original_control;
            fs::remove_dir(&provider_file).unwrap();
            fs::rename(saved, provider_file).unwrap();
            retained
        } else {
            true
        };
        assert!(matches!(eof, Ok(0)) && staged && exited,
            "changed_dir={changed_dir} eof={eof:?} staged={staged} exited={exited} reply={reply_class}");
        assert_eq!(changed_dir, previous != target_dir);
        assert!(
            foreign_preserved,
            "foreign control and exact custody must survive refusal"
        );
        assert_ne!(cached, changed_dir);
        assert_eq!(
            rejected, [true; 3],
            "different managed generation lost custody"
        );
        assert!(
            status_preserved,
            "foreign target status must retain exact custody"
        );
        assert!(
            pending_preserved,
            "abandoned provider handoff lost recovery authority"
        );
        assert!(
            !prior_front.is_empty()
                && !cache_bytes.is_empty()
                && original_bytes.iter().all(|b| !b.is_empty())
        );
        self.recover_business_and_stop(entry, fault);
    }

    fn recover_business_and_stop(&mut self, entry: &str, fault: Option<NativeFault>) {
        let root = self.root.as_ref().unwrap();
        let state = root.path().join("state");
        let (config, ports) = self.original.as_ref().unwrap();
        let target_config = self.target.as_ref().unwrap();
        let previous = self.generations[0].witness.instance.clone();
        let old_pid = self.generations[0].pid;
        let old_socket = &self.predecessor.as_ref().unwrap().path;
        let target_dir = state
            .join("instances")
            .join(direct_instance(&state, target_config).unwrap());
        let changed_dir = previous != target_dir;
        let return_to_original = changed_dir && entry == "restart";
        let original_paths = ["a", "b"]
            .map(|id| routecodex_v3_config::v3_active_key_control_paths(config, id).unwrap());
        let provider = self.provider.as_mut().unwrap();
        assert!(provider.visits.lock().unwrap().is_empty());
        let invoke = |op| native_image_command(root, target_config, op);
        self.pending_launch = Some(target_config.clone());
        let start = invoke(entry);
        assert!(
            start.status.success(),
            "public {entry}: {}",
            String::from_utf8_lossy(&start.stderr)
        );
        record_native_generation(
            &mut self.generations,
            &mut self.controls,
            target_config,
            &target_dir,
        )
        .unwrap();
        self.pending_launch = None;
        let fresh = self.generations.last().unwrap();
        assert_ne!(fresh.pid, old_pid);
        let front = native_json(&target_dir, "front-handoff.json");
        assert!(
            front["origin"] == fresh.witness.cache
                && front["declaration"] == fresh.witness.declaration
        );
        for dir in [&previous, &target_dir] {
            for name in [
                "exec-restart-declaration.json",
                "provider-handoff.json",
                "restart.plan.json",
            ] {
                require_absent(&dir.join(name)).unwrap();
            }
        }
        if changed_dir {
            for name in ["pid.cache", "control.json", "front-handoff.json"] {
                require_absent(&previous.join(name)).unwrap();
            }
            assert_eq!(native_json(&previous, "status.json")["state"], "stopped");
        }
        self.interrupted = false;
        let rt = runtime();
        let addr = ([127, 0, 0, 1], ports[0]).into();
        provider.pending_request = true;
        let business = http(&rt, addr, "POST", "/v1/responses", Some(business_body()));
        let controls = ports.iter().all(|port| {
            http(
                &rt,
                ([127, 0, 0, 1], *port).into(),
                "GET",
                STATUS_PATH,
                None,
            )
            .is_ok_and(|(code, _)| code == 200)
        });
        let fresh_pid = fs::read(target_dir.join("pid.cache"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|c| c["pid"].as_u64());
        let return_restart = return_to_original.then(|| {
            self.pending_launch = Some(config.clone());
            isolated_lifetime_command(root, &state, config, "restart")
        });
        let returned = return_restart
            .as_ref()
            .is_some_and(|result| result.status.success());
        if returned {
            record_native_generation(&mut self.generations, &mut self.controls, config, &previous)
                .unwrap();
            self.pending_launch = None;
        }
        let return_controls = returned
            && original_paths.iter().all(|path| {
                path.read()
                    .ok()
                    .and_then(|bytes| endpoint(&bytes))
                    .is_some_and(|addr| {
                        http(&rt, addr, "GET", STATUS_PATH, None).is_ok_and(|(code, _)| code == 200)
                    })
            });
        let return_business =
            returned.then(|| http(&rt, addr, "POST", "/v1/responses", Some(business_body())));
        if fault == Some(NativeFault::LockedStop) {
            let (code, body) = business.as_ref().unwrap();
            assert_eq!(*code, 200);
            assert_eq!(body["status"], "completed");
            assert_eq!(
                body["output"][0]["content"][0]["text"],
                "uncached connection probe"
            );
            assert!(controls);
            let current = self.generations.last().unwrap();
            current.check_live().unwrap();
            self.operation_lock =
                Some(ExactOperationLock::acquire(&current.witness.instance).unwrap());
        }
        let stop = self.stop_result.insert(if returned {
            isolated_lifetime_command(root, &state, config, "stop")
        } else {
            invoke("stop")
        });
        self.stopped = stop.status.success();
        if fault == Some(NativeFault::LockedStop) {
            assert!(exact_stop_locked(stop));
            std::panic::panic_any(NativeFault::LockedStop);
        }
        let fresh_exited =
            fresh_pid.is_some_and(|pid| wait_for_explicit_pid_exit(pid, Duration::from_secs(5)));
        let sockets_closed = !old_socket.exists()
            && ports
                .iter()
                .all(|p| TcpStream::connect(("127.0.0.1", *p)).is_err());
        let leaves_closed = [config, target_config].into_iter().all(|path| {
            ["a", "b"].iter().all(|id| {
                !routecodex_v3_config::v3_active_key_control_paths(path, id)
                    .unwrap()
                    .record
                    .exists()
            })
        });
        eprintln!("interrupted fixture state={state:?} old_pid={old_pid} exit=19 fresh_pid={fresh_pid:?} ports={ports:?} fresh_exited={fresh_exited} sockets_closed={sockets_closed} leaves_closed={leaves_closed}");
        drop(rt);
        if let Some(result) = return_restart {
            assert!(
                result.status.success(),
                "return restart: {}",
                String::from_utf8_lossy(&result.stderr)
            );
            assert!(return_controls);
            let (code, body) = return_business.unwrap().unwrap();
            assert_eq!(code, 200);
            assert_eq!(body["id"], "active-managed");
            assert_eq!(body["status"], "completed");
            assert_eq!(
                body["output"][0]["content"][0]["text"],
                "uncached connection probe"
            );
        }
        assert_eq!(
            *provider.visits.lock().unwrap(),
            vec!["uncached connection probe"; if returned { 2 } else { 1 }]
        );
        assert!(
        stop.status.success() && fresh_exited && sockets_closed && leaves_closed,
        "changed_dir={changed_dir}, sockets_closed={sockets_closed}, leaves_closed={leaves_closed}"
    );
        assert!(controls);
        let (code, body) = business.unwrap();
        assert_eq!(code, 200);
        assert_eq!(body["id"], "active-managed");
        assert_eq!(body["status"], "completed");
        assert_eq!(
            body["output"][0]["content"][0]["text"],
            "uncached connection probe"
        );
    }
}

#[test]
fn exact_custody_status_lock_failed_adoption_recovers_controls() {
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state = root.path().join("state");
    let provider = ActiveProvider::start();
    let (config, ports) = managed_lifetime_config(&root, "127.0.0.1", provider.port);
    let process = p0_start(&root, &state, &config);
    let instance = single_instance_dir(&state);
    let old_control = managed_control(&instance);
    let socket = managed_socket(&old_control);
    let lock = fs::File::open(instance.join("status.lock")).unwrap();
    lock.lock().unwrap();
    let failed = managed_test_command(env!("CARGO_BIN_EXE_rccv3"), &state)
        .args(["server", "restart", "--timeout-ms", "2500", "--config"])
        .arg(&config)
        .env("HOME", root.path().join("home"))
        .env("ROUTECODEX_V3_STATE_DIR", &state)
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .output()
        .unwrap();
    let exited = wait_for_explicit_pid_exit(process.pid.into(), Duration::from_secs(5));
    let status: Value =
        serde_json::from_slice(&fs::read(instance.join("status.json")).unwrap()).unwrap();
    let cache: Value =
        serde_json::from_slice(&fs::read(instance.join("pid.cache")).unwrap()).unwrap();
    let post_publication = cache["retained_control"]["start_nonce"] == old_control["start_nonce"]
        && cache["start_nonce"] != old_control["start_nonce"]
        && !instance.join("exec-restart-declaration.json").exists()
        && status["state"] == "running";
    let failure_log = fs::read_to_string(instance.join("server.log")).unwrap();
    let lock_failure = failure_log.lines().any(|line| {
        line.contains("managed startup failure status write failed after")
            && line.matches("status file lock").count() == 2
    });
    drop(lock);
    let paths = ["a", "b"]
        .map(|id| routecodex_v3_config::v3_active_key_control_paths(&config, id).unwrap());
    let front_path = instance.join("front-handoff.json");
    let cache_path = instance.join("pid.cache");
    let cache_bytes = fs::read(&cache_path).unwrap();
    let front = fs::read(&front_path).ok();
    let controls = paths.each_ref().map(|path| path.read().ok());
    let control_bytes = fs::read(instance.join("control.json")).ok();
    let mut unrelated = cache.clone();
    unrelated["retained_control"]["start_nonce"] = serde_json::json!("different-generation");
    let unrelated = serde_json::to_vec(&unrelated).unwrap();
    fs::write(&cache_path, &unrelated).unwrap();
    let refused = isolated_lifetime_command(&root, &state, &config, "restart");
    let preserved = !refused.status.success()
        && front.as_ref().is_some_and(|bytes| !bytes.is_empty())
        && fs::read(&front_path).ok() == front
        && fs::read(instance.join("control.json")).ok() == control_bytes
        && fs::read(&cache_path).ok().as_ref() == Some(&unrelated)
        && paths.each_ref().map(|path| path.read().ok()) == controls;
    fs::write(&cache_path, cache_bytes).unwrap();
    let fresh = isolated_lifetime_command(&root, &state, &config, "restart");
    let rt = runtime();
    let usable = paths.iter().all(|p| {
        p.read()
            .ok()
            .and_then(|b| endpoint(&b))
            .is_some_and(|addr| matches!(http(&rt, addr, "GET", STATUS_PATH, None), Ok((200, _))))
    });
    let fresh_pid = fs::read(instance.join("pid.cache"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|c| c["pid"].as_u64());
    let stop = isolated_lifetime_command(&root, &state, &config, "stop");
    let closed = fresh_pid
        .is_some_and(|pid| wait_for_explicit_pid_exit(pid, Duration::from_secs(5)))
        && !socket.exists()
        && paths.iter().all(|p| !p.record.exists())
        && ports
            .iter()
            .all(|p| TcpStream::connect(("127.0.0.1", *p)).is_err());
    if exited && socket.exists() {
        fs::remove_file(&socket).unwrap();
    }
    eprintln!("status-lock fixture state={state:?} old_pid={} fresh_pid={fresh_pid:?} ports={ports:?} old_exited={exited} closed={closed}",process.pid);
    drop(process);
    drop(rt);
    drop(provider);
    root.close().unwrap();
    assert!(
        !failed.status.success() && exited && post_publication && lock_failure,
        "{status} {}",
        String::from_utf8_lossy(&failed.stderr)
    );
    assert!(
        fresh.status.success(),
        "{}",
        String::from_utf8_lossy(&fresh.stderr)
    );
    assert!(preserved && usable && stop.status.success() && closed);
}

#[test]
fn exact_custody_forced_stop_recovers_controls() {
    exact_forced_stop_fixture(false);
}

#[test]
fn exact_forced_stop_refuses_changed_control() {
    exact_forced_stop_fixture(true);
}

struct ExactFixtureSocket {
    path: PathBuf,
    device: u64,
    inode: u64,
    verified: bool,
}

fn exact_socket_peer(path: &Path) -> std::io::Result<u64> {
    let peer = Command::new("/usr/bin/python3")
        .current_dir(path.parent().unwrap())
        .args([
            "-c",
            r#"
import socket, struct, sys
with socket.socket(socket.AF_UNIX) as stream:
    stream.settimeout(1)
    stream.connect(sys.argv[1])
    if sys.platform == "darwin":
        print(stream.getsockopt(0, 2))  # SOL_LOCAL, LOCAL_PEERPID
    else:
        print(struct.unpack("3i", stream.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[0])
"#,
        ])
        .arg(path.file_name().unwrap())
        .output()?;
    String::from_utf8_lossy(&peer.stdout)
        .trim()
        .parse::<u32>()
        .ok()
        .filter(|pid| peer.status.success() && *pid > 1)
        .map(u64::from)
        .ok_or_else(|| std::io::Error::other(format!("socket peer {path:?}: {peer:?}")))
}

struct ExactOperationLock {
    path: PathBuf,
    file: fs::File,
}

impl ExactOperationLock {
    fn restore(slot: &mut Option<Self>) -> std::io::Result<()> {
        if let Some(lock) = slot {
            lock.verify()?;
            fs::remove_file(&lock.path)?;
            slot.take();
        }
        Ok(())
    }
    fn acquire(instance: &Path) -> std::io::Result<Self> {
        use std::os::unix::fs::OpenOptionsExt;
        let path = instance.join("lifecycle.lock");
        let file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&path)?;
        Ok(Self { path, file })
    }

    fn verify(&self) -> std::io::Result<()> {
        use std::os::unix::fs::MetadataExt;
        let own = self.file.metadata()?;
        let current = fs::symlink_metadata(&self.path)?;
        if own.is_file()
            && current.is_file()
            && (own.dev(), own.ino()) == (current.dev(), current.ino())
        {
            Ok(())
        } else {
            Err(std::io::Error::other("operation lock replaced"))
        }
    }
}

struct ExactStopWitness {
    instance: PathBuf,
    declaration: Value,
    control: Value,
    cache: Value,
}

impl ExactStopWitness {
    fn read(instance: &Path) -> std::io::Result<Self> {
        let read = |name| -> std::io::Result<Value> {
            Ok(serde_json::from_slice(&fs::read(instance.join(name))?)?)
        };
        Ok(Self {
            instance: instance.to_owned(),
            declaration: read("instance.json")?,
            control: read("control.json")?,
            cache: read("pid.cache")?,
        })
    }

    fn verify(
        &self,
        socket: &ExactFixtureSocket,
        pid: u64,
        config: &Path,
        generation: &str,
    ) -> std::io::Result<()> {
        let current = Self::read(&self.instance)?;
        let id = self.instance.file_name().and_then(|s| s.to_str());
        socket.verify_identity()?;
        if socket.verified
            && exact_child_generation(pid, config)? == generation
            && self.declaration == current.declaration
            && self.control == current.control
            && self.cache == current.cache
            && id.is_some()
            && [&self.declaration, &self.control, &self.cache]
                .iter()
                .all(|r| r["schema_version"] == 1 && r["instance_id"].as_str() == id)
            && self.declaration["config_path"].as_str() == config.canonicalize()?.to_str()
            && self.cache["pid"].as_u64() == Some(pid)
            && self.control["start_nonce"]
                .as_str()
                .is_some_and(|n| !n.is_empty())
            && self.control["start_nonce"] == self.cache["start_nonce"]
            && managed_socket(&self.control).canonicalize()? == socket.path.canonicalize()?
        {
            Ok(())
        } else {
            Err(std::io::Error::other(
                "current exact Stop witness disagrees",
            ))
        }
    }
}

fn exact_child_generation(pid: u64, config: &Path) -> std::io::Result<String> {
    let out = Command::new("/bin/ps")
        .args(["-ww", "-p", &pid.to_string(), "-o", "lstart=,command="])
        .output()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let config = config.canonicalize()?;
    let program = Path::new(env!("CARGO_BIN_EXE_rccv3")).canonicalize()?;
    if out.status.success()
        && text
            .split_whitespace()
            .collect::<Vec<_>>()
            .windows(5)
            .any(|args| {
                args[1..4] == ["server", "run-managed-child", "--config"]
                    && Path::new(args[0]).canonicalize().as_ref().ok() == Some(&program)
                    && Path::new(args[4]).canonicalize().as_ref().ok() == Some(&config)
            })
    {
        Ok(text.trim().to_owned())
    } else {
        Err(std::io::Error::other(format!(
            "unexpected PID {pid} command {text:?} for {program:?} {config:?}"
        )))
    }
}

impl ExactFixtureSocket {
    fn capture(path: PathBuf) -> std::io::Result<Self> {
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.file_type().is_socket() {
            return Err(std::io::Error::other(format!(
                "expected socket at {path:?}"
            )));
        }
        Ok(Self {
            path,
            device: metadata.dev(),
            inode: metadata.ino(),
            verified: false,
        })
    }

    fn verify_identity(&self) -> std::io::Result<()> {
        let current = Self::capture(self.path.clone())?;
        if (current.device, current.inode) != (self.device, self.inode) {
            return Err(std::io::Error::other(format!(
                "socket replaced at {:?}",
                self.path
            )));
        }
        Ok(())
    }

    fn remove_if_inactive(&self) -> std::io::Result<()> {
        use std::io::{Error, ErrorKind};
        if !self.verified {
            return Err(Error::other(format!(
                "unverified socket {:?} device={} inode={}",
                self.path, self.device, self.inode
            )));
        }
        match self.verify_identity() {
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            other => other?,
        }
        // The worktree's absolute path can exceed sockaddr_un.sun_path.
        let refusal = Command::new("/usr/bin/python3")
            .current_dir(self.path.parent().unwrap())
            .args(["-c", "import errno,socket,sys; s=socket.socket(socket.AF_UNIX); sys.exit(s.connect_ex(sys.argv[1]) != errno.ECONNREFUSED)"])
            .arg(self.path.file_name().unwrap())
            .status()?;
        let users = Command::new("lsof")
            .args(["-t", "--"])
            .arg(&self.path)
            .output()?;
        if !refusal.success()
            || users.status.code() != Some(1)
            || !users.stdout.is_empty()
            || !users.stderr.is_empty()
        {
            return Err(Error::other(format!(
                "cannot confirm inactive socket {:?}: connect check {refusal}, lsof {users:?}",
                self.path
            )));
        }
        self.verify_identity()?;
        fs::remove_file(&self.path)?;
        eprintln!("inactive fixture socket removed: {:?} device={} inode={} relative ECONNREFUSED and empty lsof/1", self.path, self.device, self.inode);
        match fs::symlink_metadata(&self.path) {
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            other => Err(Error::other(format!(
                "socket removal {:?}: {other:?}",
                self.path
            ))),
        }
    }
}

// Resolve only this run's single instance. Keep the peer and inode together
// so a subsequent read or child collection cannot erase socket custody.
fn exact_launch_owner(
    state: &Path,
    config: &Path,
    bound: &mut Option<ExactFixtureSocket>,
    foreground: Option<u32>,
    fault: Option<ExactCleanupFault>,
) -> std::io::Result<(u64, Option<String>)> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut observe = || {
        let directory = if fault == Some(ExactCleanupFault::OriginalMetadata) {
            "unavailable-reader"
        } else {
            "instances"
        };
        let mut instances = fs::read_dir(state.join(directory))?;
        let instance = instances.next().transpose()?.ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "no fixture instance")
        })?;
        if instances.next().is_some() || !instance.file_type()?.is_dir() {
            return Err(std::io::Error::other("ambiguous fixture instance"));
        }
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../build-control/temp")
            .join(format!(
                "routecodex-{}.sock",
                instance.file_name().to_string_lossy()
            ));
        let socket = match bound {
            None => bound.insert(ExactFixtureSocket::capture(path.clone())?),
            Some(socket) if socket.path == path => {
                socket.verify_identity()?;
                socket
            }
            Some(socket) => {
                return Err(std::io::Error::other(format!(
                    "fixture path changed from {:?} to {path:?}",
                    socket.path
                )))
            }
        };
        let unavailable = state.join("unavailable-peer.sock");
        let peer_path = if matches!(
            fault,
            Some(
                ExactCleanupFault::DetachedOriginalPeer
                    | ExactCleanupFault::FreshPeer
                    | ExactCleanupFault::FirstForegroundPeer
                    | ExactCleanupFault::HeldFreshReader
            )
        ) {
            &unavailable
        } else {
            &path
        };
        let pid = exact_socket_peer(peer_path)?;
        let generation = match foreground {
            Some(expected) if u64::from(expected) == pid => None,
            Some(expected) => {
                return Err(std::io::Error::other(format!(
                    "expected child {expected}, socket peer {pid}"
                )))
            }
            None => Some(exact_child_generation(pid, config)?),
        };
        socket.verify_identity()?;
        socket.verified = true;
        Ok((pid, generation))
    };
    loop {
        match observe() {
            Err(error)
                if fault == Some(ExactCleanupFault::FirstForegroundPeer)
                    && error.to_string().contains("unavailable-peer.sock") =>
            {
                return Err(error)
            }
            Err(_) if Instant::now() < deadline => sleep(Duration::from_millis(50)),
            observed => return observed,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExactCleanupFault {
    PostAdoption,
    PendingLocked,
    CollectedOriginal,
    MissingFreshCache,
    OriginalMetadata,
    DetachedOriginalPeer,
    MeasuredStopSpawn,
    FreshPeer,
    HeldFreshReader,
    FirstForegroundPeer,
}

#[test]
fn exact_cleanup_after_first_peer_error_and_collection() {
    exact_forced_stop_run(true, Some(ExactCleanupFault::FirstForegroundPeer));
}

#[test]
fn exact_post_adoption_unwind_retains_foreground() {
    use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};
    let guard = lifecycle_test_guard();
    let marker = ExactCleanupFault::PostAdoption;
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        exact_run_admitted(&guard, true, Some(marker))
    }));
    let Some(owner) = retained_exact(&guard) else {
        if let Err(primary) = outcome {
            resume_unwind(primary);
        }
        panic!("missing retained foreground");
    };
    let observed = catch_unwind(AssertUnwindSafe(|| {
        let snapshot = || {
            with_retained_exact(&guard, |v| {
                let r = &v.resources;
                assert!(
                    v.secondary.is_none()
                        && v.errors
                            .iter()
                            .any(|e| e.contains("refused direct child collection"))
                );
                assert!(r.original_socket.is_none());
                let root = r.root.as_ref().unwrap().path();
                assert!(root.is_dir());
                (
                    root.to_owned(),
                    r.foreground.as_ref().unwrap().child.as_ref().unwrap().id(),
                )
            })
        };
        let prior = snapshot();
        assert!(exact_recover(&guard)
            .unwrap_err()
            .contains("refused direct child collection"));
        assert!(std::sync::Arc::ptr_eq(
            &owner,
            &retained_exact(&guard).unwrap()
        ));
        assert_eq!(prior, snapshot());
        eprintln!(
            "post-adoption marker retained root={:?} direct_pid={}",
            prior.0, prior.1
        );
        prior.0
    }));
    let ready = catch_unwind(AssertUnwindSafe(|| {
        with_retained_exact(&guard, |v| {
            let r = &mut v.resources;
            let direct = r.foreground.as_mut().unwrap();
            direct.refuse_collection = false;
            let pid = direct.child.as_ref().unwrap().id();
            let state = r.root.as_ref().unwrap().path().join("state");
            check_foreground_ready(&state, r.config_ports.as_ref().unwrap().1, pid);
            exact_launch_owner(
                &state,
                &r.config_ports.as_ref().unwrap().0,
                &mut r.original_socket,
                Some(pid),
                None,
            )
            .unwrap();
            r.child_pids.push(pid.into());
        })
    }));
    let recovered = exact_recover(&guard);
    match outcome {
        Err(primary) if primary.downcast_ref::<ExactCleanupFault>() == Some(&marker) => (),
        Err(primary) => resume_unwind(primary),
        Ok(()) => panic!("missing post-adoption marker"),
    }
    recovered.unwrap();
    ready.unwrap_or_else(|cause| resume_unwind(cause));
    require_absent(&observed.unwrap_or_else(|e| resume_unwind(e))).unwrap();
    assert!(retained_exact(&guard).is_none());
}

fn with_retained_exact<T>(
    guard: &MutexGuard<'static, ()>,
    inspect: impl FnOnce(&mut RetainedExactFixture) -> T,
) -> T {
    let owner = retained_exact(guard).expect("expected the retained exact fixture");
    let mut value = owner.lock().unwrap_or_else(|e| e.into_inner());
    match &mut *value {
        FixtureResources::Exact(exact) => inspect(exact),
        FixtureResources::InterruptedNative(_) => panic!("expected exact fixture"),
    }
}

#[test]
fn exact_cleanup_unwind_retains_pending_request_until_owned_lock_recovery() {
    use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};
    use std::sync::atomic::Ordering;
    let guard = lifecycle_test_guard();
    let marker = ExactCleanupFault::PendingLocked;
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        exact_run_admitted(&guard, false, Some(marker))
    }));
    let observed = catch_unwind(AssertUnwindSafe(|| {
        assert_eq!(
            outcome.as_ref().err().and_then(|e| e.downcast_ref()),
            Some(&marker)
        );
        let original_owner = retained_exact(&guard).unwrap();
        let identity = with_retained_exact(&guard, |v| {
            assert!(v.secondary.is_none());
            assert!(v
                .errors
                .iter()
                .any(|e| e.contains("public Stop operation locked")
                    && e.contains("quiescence unproved")));
            let r = &mut v.resources;
            let p = r.provider.as_ref().unwrap();
            let task = p.task.as_ref().unwrap();
            assert!(
                !task.is_finished()
                    && !p.stop.load(Ordering::SeqCst)
                    && p.pending_request
                    && p.producers_ended
            );
            let lock = r.operation_lock.as_ref().unwrap();
            lock.verify().unwrap();
            let pid = r.fresh_pid.unwrap();
            let socket = r.fresh_socket.as_ref().unwrap();
            r.witness
                .as_ref()
                .unwrap()
                .verify(
                    socket,
                    pid,
                    &r.config_ports.as_ref().unwrap().0,
                    r.fresh_generation.as_deref().unwrap(),
                )
                .unwrap();
            assert_eq!(exact_socket_peer(&socket.path).unwrap(), pid);
            let wrote = r.wrote.as_ref().unwrap();
            assert!(matches!(
                wrote.try_recv(),
                Err(std::sync::mpsc::TryRecvError::Empty)
            ));
            r.gate.take().unwrap().send(()).unwrap();
            wrote.recv_timeout(Duration::from_secs(2)).unwrap();
            eprintln!("common Stop and retirement refused; retained recorder {:?}, peer={pid}; held handler continued through response write after client timeout", task.thread().id());
            (
                task.thread().id(),
                r.root.as_ref().unwrap().path().to_owned(),
                pid,
                socket.inode,
                p.visits.clone(),
            )
        });
        let refused = exact_recover(&guard).unwrap_err();
        assert!(std::sync::Arc::ptr_eq(
            &original_owner,
            &retained_exact(&guard).unwrap()
        ));
        assert!(
            refused.contains("public Stop operation locked")
                && refused.contains("quiescence unproved")
        );
        with_retained_exact(&guard, |v| {
            let r = &v.resources;
            let p = r.provider.as_ref().unwrap();
            assert_eq!(p.task.as_ref().unwrap().thread().id(), identity.0);
            assert_eq!(r.root.as_ref().unwrap().path(), identity.1);
            assert_eq!(r.fresh_pid, Some(identity.2));
            assert_eq!(r.fresh_socket.as_ref().unwrap().inode, identity.3);
            assert!(!p.stop.load(Ordering::SeqCst));
            r.operation_lock.as_ref().unwrap().verify().unwrap();
        });
        (identity.1, identity.4)
    }));
    let occupied = RETAINED_EXACT_FIXTURE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some();
    if occupied {
        with_retained_exact(&guard, |v| {
            let r = &mut v.resources;
            if let Some(gate) = r.gate.take() {
                let _ = gate.send(());
            }
            ExactOperationLock::restore(&mut r.operation_lock).unwrap();
        });
    }
    let recovered = exact_recover(&guard);
    if let Err(cause) = outcome {
        if cause.downcast_ref::<ExactCleanupFault>() != Some(&marker) {
            resume_unwind(cause);
        }
    } else {
        panic!("common unwind did not propagate pending-lock marker");
    }
    recovered.unwrap();
    let (root, visits) = observed.unwrap_or_else(|cause| resume_unwind(cause));
    assert_eq!(*visits.lock().unwrap(), vec!["uncached connection probe"]);
    assert!(
        matches!(fs::symlink_metadata(root), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
    );
    let empty = RETAINED_EXACT_FIXTURE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_none();
    assert!(empty);
}

#[test]
fn exact_cleanup_preserves_live_and_replaced_socket() {
    use std::os::unix::net::UnixListener;
    let root = TempDir::new().unwrap();
    let path = root.path().join("listener");
    let child = Command::new("/usr/bin/python3").current_dir(root.path())
        .args(["-c", "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind('listener'); s.listen(); sys.stdin.buffer.read(1)"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut listener = CapturedChild::new(child);
    let pid = listener.child.as_ref().unwrap().id();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !path.exists() && Instant::now() < deadline {
        sleep(Duration::from_millis(10));
    }
    let mut observed = ExactFixtureSocket::capture(path.clone()).unwrap();
    assert!(observed.remove_if_inactive().is_err());
    assert_eq!(exact_socket_peer(&path).unwrap(), u64::from(pid));
    observed.verify_identity().unwrap();
    observed.verified = true;
    assert!(observed.remove_if_inactive().is_err());
    observed.verify_identity().unwrap();
    let replacement = root.path().join("replacement");
    let other = UnixListener::bind(&replacement).unwrap();
    fs::rename(&replacement, &path).unwrap();
    let retained = ExactFixtureSocket::capture(path.clone()).unwrap();
    assert_eq!(
        exact_socket_peer(&path).unwrap(),
        u64::from(std::process::id())
    );
    drop(listener.child.as_mut().unwrap().stdin.take());
    assert!(listener.finish().status.success());
    drop(other);
    assert!(observed.remove_if_inactive().is_err());
    assert!(retained.remove_if_inactive().is_err());
    retained.verify_identity().unwrap();
    root.close().unwrap();
}

#[test]
fn exact_cleanup_joins_held_provider_work() {
    use std::sync::{atomic::Ordering, mpsc};
    let mut provider = ActiveProvider::start();
    let port = provider.port;
    provider.fail.store(false, Ordering::SeqCst);
    let (entered, accepted) = mpsc::channel();
    let (resume, release) = mpsc::channel();
    *provider.pause.lock().unwrap() = Some((entered, release));
    thread::scope(|scope| {
        let client = scope.spawn(move || {
            http(
                &runtime(),
                ([127, 0, 0, 1], port).into(),
                "POST",
                "/v1/responses",
                Some(serde_json::json!({"model":"wire-test","input":"fresh after restart"})),
            )
        });
        accepted.recv_timeout(Duration::from_secs(5)).unwrap();
        provider.pending_request = true;
        let unresolved = provider.finish_quiescent(false);
        // The only direct POST was accepted. It cannot issue any further work.
        provider.pending_request = false;
        assert!(unresolved.is_err());
        assert!(!provider.stop.load(Ordering::SeqCst));
        assert!(provider.task.as_ref().is_some_and(|t| !t.is_finished()));
        // The sole direct client's request has already reached this handler.
        // No managed generation can dispatch another attempt in this control.
        let stop = provider.stop.clone();
        let recorder = scope.spawn(|| provider.retire(false));
        let deadline = Instant::now() + Duration::from_secs(2);
        while !stop.load(Ordering::SeqCst) && Instant::now() < deadline {
            thread::yield_now();
        }
        let held = stop.load(Ordering::SeqCst) && !recorder.is_finished() && !client.is_finished();
        resume.send(()).unwrap();
        let (status, body) = client.join().unwrap().unwrap();
        recorder.join().unwrap().unwrap();
        assert!(held);
        assert_eq!(status, 200);
        assert_eq!(
            body["output"][0]["content"][0]["text"],
            "fresh after restart"
        );
    });
    assert_eq!(
        *provider.visits.lock().unwrap(),
        vec!["fresh after restart"]
    );
    assert!(
        matches!(TcpStream::connect(("127.0.0.1", port)), Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused)
    );
}

#[test]
fn exact_cleanup_after_unresolved_prebusiness_fresh_reader() {
    exact_forced_stop_run(false, Some(ExactCleanupFault::HeldFreshReader));
}

#[test]
fn exact_cleanup_after_original_metadata_error() {
    exact_forced_stop_run(true, Some(ExactCleanupFault::OriginalMetadata));
}

#[test]
fn exact_cleanup_after_detached_original_peer_error() {
    exact_forced_stop_run(false, Some(ExactCleanupFault::DetachedOriginalPeer));
}

#[test]
fn exact_cleanup_after_stopped_original_spawn_error() {
    exact_forced_stop_run(false, Some(ExactCleanupFault::MeasuredStopSpawn));
}

#[test]
fn exact_cleanup_after_detached_fresh_peer_error() {
    exact_forced_stop_run(false, Some(ExactCleanupFault::FreshPeer));
}

#[test]
fn exact_cleanup_after_original_exit() {
    exact_forced_stop_run(true, Some(ExactCleanupFault::CollectedOriginal));
}

#[test]
fn exact_cleanup_after_missing_fresh_cache() {
    exact_forced_stop_run(false, Some(ExactCleanupFault::MissingFreshCache));
}

fn exact_forced_stop_fixture(challenge: bool) {
    exact_forced_stop_run(challenge, None);
}

fn exact_forced_stop_run(challenge: bool, fault: Option<ExactCleanupFault>) {
    let _guard = lifecycle_test_guard();
    exact_run_admitted(&_guard, challenge, fault);
}

type ExactPanic = Box<dyn std::any::Any + Send>;

#[derive(Default)]
struct ExactFixtureResources {
    root: Option<TempDir>,
    provider: Option<ActiveProvider>,
    config_ports: Option<(PathBuf, [u16; 2])>,
    original_socket: Option<ExactFixtureSocket>,
    original_pending: bool,
    foreground: Option<DirectForeground>,
    original_generation: Option<String>,
    paused: Option<u32>,
    fresh_socket: Option<ExactFixtureSocket>,
    fresh_pid: Option<u64>,
    fresh_generation: Option<String>,
    recovery_witness: Option<(u64, String)>,
    operation_lock: Option<ExactOperationLock>,
    gate: Option<std::sync::mpsc::Sender<()>>,
    wrote: Option<std::sync::mpsc::Receiver<()>>,
    witness: Option<ExactStopWitness>,
    missing_cache: Option<(PathBuf, PathBuf)>,
    dead_control_fault: Option<(PathBuf, Vec<u8>)>,
    launch_pending: bool,
    child_pids: Vec<u64>,
    controls: Vec<std::net::SocketAddr>,
}

#[derive(Default)]
struct RetainedExactFixture {
    resources: ExactFixtureResources,
    errors: Vec<String>,
    secondary: Option<ExactPanic>,
    fault: Option<ExactCleanupFault>,
}

enum FixtureResources {
    Exact(Box<RetainedExactFixture>),
    InterruptedNative(Box<InterruptedNative>),
}
type ExactFixtureOwner = std::sync::Arc<std::sync::Mutex<FixtureResources>>;
static RETAINED_EXACT_FIXTURE: std::sync::Mutex<Option<ExactFixtureOwner>> =
    std::sync::Mutex::new(None);

fn retained_exact(_guard: &MutexGuard<'static, ()>) -> Option<ExactFixtureOwner> {
    RETAINED_EXACT_FIXTURE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

fn clear_closed_exact(_guard: &MutexGuard<'static, ()>) {
    let closed = RETAINED_EXACT_FIXTURE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    drop(closed);
}

fn exact_recover(guard: &MutexGuard<'static, ()>) -> Result<(), String> {
    if let Some(owner) = retained_exact(guard) {
        let mut value = owner.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *value {
            FixtureResources::Exact(r) => r.cleanup().inspect_err(|e| r.errors.push(e.clone()))?,
            FixtureResources::InterruptedNative(r) => {
                r.cleanup().inspect_err(|e| r.errors.push(e.clone()))?
            }
        }
        clear_closed_exact(guard);
    }
    Ok(())
}

fn exact_run_admitted(
    guard: &MutexGuard<'static, ()>,
    challenge: bool,
    fault: Option<ExactCleanupFault>,
) {
    let owner = admit_fixture(guard, || {
        FixtureResources::Exact(Box::new(RetainedExactFixture {
            fault,
            ..Default::default()
        }))
    });
    let mut locked = owner.lock().unwrap_or_else(|e| e.into_inner());
    let FixtureResources::Exact(value) = &mut *locked else {
        unreachable!()
    };
    let resources = &mut value.resources;
    let outcome =
        thread::scope(|scope| scope.spawn(|| resources.exercise(challenge, fault)).join());
    let visits = value.resources.provider.as_ref().map(|p| p.visits.clone());
    if let Some(provider) = value.resources.provider.as_mut() {
        provider.producers_ended = true;
    }
    let cleanup = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| value.cleanup()));
    let closed = matches!(cleanup, Ok(Ok(())));
    match cleanup {
        Ok(Ok(())) => {
            clear_closed_exact(guard);
        }
        Ok(Err(error)) => {
            value.errors.push(error.clone());
            eprintln!("retaining exact fixture: {error}");
        }
        Err(cause) if outcome.is_err() => value.secondary = Some(cause),
        Err(cause) => std::panic::resume_unwind(cause),
    }
    drop(locked);
    match outcome {
        Err(cause)
            if closed
                && fault.is_some()
                && cause.downcast_ref::<ExactCleanupFault>() == fault.as_ref() => {}
        Err(cause) => std::panic::resume_unwind(cause),
        Ok(()) => assert!(
            closed && fault.is_none(),
            "incomplete exact fixture or missing unwind {fault:?}"
        ),
    }
    let visits = visits.unwrap();
    let inputs = visits.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(*inputs, exact_expected_inputs(fault, challenge));
}

impl ExactFixtureResources {
    fn exercise(&mut self, challenge: bool, fault: Option<ExactCleanupFault>) {
        let root = self.root.insert(TempDir::new().unwrap());
        // Only verified fixture closure removes this directory.
        root.disable_cleanup(true);
        let state = root.path().join("state");
        let provider = self.provider.insert(ActiveProvider::start());
        provider.producers_ended = false;
        let (config, ports) =
            self.config_ports
                .insert(managed_lifetime_config(root, "127.0.0.1", provider.port));
        let config = config.as_path();
        let ports = *ports;
        let child_pids = &mut self.child_pids;
        let controls = &mut self.controls;
        let original_socket = &mut self.original_socket;
        let fresh_socket = &mut self.fresh_socket;
        let foreground = &mut self.foreground;
        use std::os::unix::{
            fs::{FileTypeExt, MetadataExt},
            process::ExitStatusExt,
        };
        if challenge {
            let direct = foreground.insert(DirectForeground::default());
            direct.refuse_collection = fault == Some(ExactCleanupFault::PostAdoption);
            direct.spawn(root, &state, config, false).unwrap();
            self.original_pending = true;
            if direct.refuse_collection {
                std::panic::panic_any(ExactCleanupFault::PostAdoption);
            }
        } else {
            self.original_pending = true;
            let start = isolated_lifetime_command(root, &state, config, "start");
            assert!(start.status.success(), "original start: {start:?}");
        }
        let direct_pid = foreground
            .as_ref()
            .map(|owner| owner.child.as_ref().unwrap().id());
        child_pids.extend(direct_pid.map(u64::from));
        let initial_fault = fault.filter(|f| {
            matches!(
                f,
                ExactCleanupFault::OriginalMetadata
                    | ExactCleanupFault::DetachedOriginalPeer
                    | ExactCleanupFault::FirstForegroundPeer
            )
        });
        let observation =
            exact_launch_owner(&state, config, original_socket, direct_pid, initial_fault);
        if let Some(marker) = initial_fault {
            let error = observation
                .as_ref()
                .expect_err("expected initial acquisition failure");
            match marker {
                ExactCleanupFault::OriginalMetadata => {
                    assert_eq!(error.kind(), std::io::ErrorKind::NotFound)
                }
                _ => assert!(
                    error.to_string().contains("unavailable-peer.sock"),
                    "{error}"
                ),
            }
            eprintln!("initial original acquisition: {error}");
            if marker == ExactCleanupFault::FirstForegroundPeer {
                let observed = original_socket.as_ref().unwrap();
                assert!(!observed.verified);
                let identity = (observed.device, observed.inode);
                let child = foreground.as_mut().unwrap().child.as_mut().unwrap();
                assert!(child.try_wait().unwrap().is_none());
                let (peer, _) =
                    exact_launch_owner(&state, config, original_socket, Some(child.id()), None)
                        .unwrap();
                let verified = original_socket.as_ref().unwrap();
                assert!(verified.verified && (verified.device, verified.inode) == identity);
                assert_eq!(
                    foreground
                        .as_mut()
                        .unwrap()
                        .collect()
                        .unwrap()
                        .unwrap()
                        .signal(),
                    Some(libc::SIGKILL)
                );
                assert!(wait_for_explicit_pid_exit(peer, Duration::from_secs(4)));
                verified.verify_identity().unwrap();
                eprintln!("retained first observation {:?} device={} inode={}; verified canonical peer {peer} before SIGKILL collection and ESRCH",verified.path, verified.device, verified.inode);
            }
            std::panic::panic_any(marker);
        }
        let (pid, generation) = observation.unwrap();
        self.original_generation = generation;
        if direct_pid.is_none() {
            child_pids.push(pid);
        }
        let old_pid = u32::try_from(pid).unwrap();
        if challenge {
            check_foreground_ready(&state, ports, old_pid);
        }
        let instance = single_instance_dir(&state);
        let socket = managed_socket(&managed_control(&instance));
        let canonical = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../build-control/temp")
            .join(format!(
                "routecodex-{}.sock",
                instance.file_name().unwrap().to_str().unwrap()
            ));
        assert_eq!(socket, canonical);
        let cache: Value =
            serde_json::from_slice(&fs::read(instance.join("pid.cache")).unwrap()).unwrap();
        assert_eq!(cache["pid"], old_pid);
        let captured = original_socket.as_ref().unwrap();
        assert_eq!(captured.path, canonical);
        eprintln!(
            "exact original pid={old_pid} socket={:?} device={} inode={}",
            captured.path, captured.device, captured.inode
        );
        let paths = ["a", "b"]
            .map(|id| routecodex_v3_config::v3_active_key_control_paths(config, id).unwrap());
        let path = instance.join("control.json");
        let authentic = fs::read(&path).unwrap();
        if fault == Some(ExactCleanupFault::CollectedOriginal) {
            assert_eq!(
                foreground
                    .as_mut()
                    .unwrap()
                    .collect()
                    .unwrap()
                    .unwrap()
                    .signal(),
                Some(libc::SIGKILL)
            );
            assert!(wait_for_explicit_pid_exit(
                old_pid.into(),
                Duration::from_secs(4)
            ));
            assert!(socket.symlink_metadata().unwrap().file_type().is_socket());
            self.original_pending = false;
            std::panic::panic_any(ExactCleanupFault::CollectedOriginal);
        }
        let mut replacement = if challenge {
            provider
                .fail
                .store(false, std::sync::atomic::Ordering::SeqCst);
            provider.pending_request = true;
            let (code, response) = http(
                &runtime(),
                ([127, 0, 0, 1], ports[0]).into(),
                "POST",
                "/v1/responses",
                Some(business_body()),
            )
            .unwrap();
            provider.pending_request = false;
            assert_eq!(code, 200);
            assert_eq!(
                response["output"][0]["content"][0]["text"],
                "uncached connection probe"
            );
            assert_eq!(
                release(&managed_control(&instance), ports[1])["accepted"],
                true
            );
            // Keep the listener bound until the parent finishes the dead-generation check.
            let script = r#"
const [port, owner] = process.argv.slice(1);
const listener = require('node:net').createServer(s => s.end());
let killed = false;
let acknowledged = false;
process.stdin.once('data', ack => {
    if (!killed || ack.toString() !== 'release') process.exit(2);
    acknowledged = true;
    listener.close();
});
process.stdin.once('end', () => { if (!acknowledged) process.exit(3); });
process.once('SIGTERM', () => {
    process.kill(Number(owner), 'SIGKILL');
    killed = true;
    console.log(JSON.stringify({ helper: process.pid, original: Number(owner) }));
});
listener.listen(Number(port), '127.0.0.1');
"#;
            let mut child = Command::new("node")
                .args(["-e", script])
                .arg(ports[1].to_string())
                .arg(old_pid.to_string())
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let mut stdout = BufReader::new(child.stdout.take().unwrap());
            let mut stderr = child.stderr.take().unwrap();
            let (sent, received) = std::sync::mpsc::channel();
            let child = CapturedChild {
                child: Some(child),
                files: None,
                stdout: Some(std::thread::spawn(move || {
                    let mut line = String::new();
                    let result = stdout.read_line(&mut line).map(|_| line.clone());
                    let _ = sent.send(result);
                    let mut bytes = line.into_bytes();
                    stdout.read_to_end(&mut bytes).unwrap();
                    bytes
                })),
                stderr: Some(std::thread::spawn(move || {
                    let mut bytes = Vec::new();
                    stderr.read_to_end(&mut bytes).unwrap();
                    bytes
                })),
            };
            wait_port(ports[1], true);
            Some((child, received))
        } else {
            None
        };
        let published = paths.each_ref().map(|p| match p.read() {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && challenge => None,
            Err(error) => panic!("read published control: {error}"),
        });
        assert!(published[0].is_some());
        let cache = fs::read(instance.join("pid.cache")).unwrap();
        let artifact = fs::read(instance.join("front-handoff.json")).unwrap();
        let invoke = |op| isolated_lifetime_command(root, &state, config, op);
        assert_eq!(
            unsafe { libc::kill(old_pid as libc::pid_t, libc::SIGSTOP) },
            0
        );
        self.paused = Some(old_pid);
        let forced = if let Some((mut listener, killed)) = replacement.take() {
            let other_pid = listener.child.as_ref().unwrap().id();
            child_pids.push(u64::from(other_pid));
            // Lifecycle dispatches scoped PIDs in ascending order. The helper's
            // TERM handler runs only after the witnessed owner received TERM.
            assert!(old_pid < other_pid);
            let status = fs::read(instance.join("status.json")).unwrap();
            let declaration = fs::read(instance.join("instance.json")).unwrap();
            let plan_path = instance.join("restart.plan.json");
            let plan = fs::read(&plan_path).ok();
            let inode = fs::symlink_metadata(&socket).unwrap().ino();
            let stop_started = Instant::now();
            let mut stop = CapturedChild::new(
                isolated_lifetime_process(root, &state, config, "stop")
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .unwrap(),
            );
            let stop_pid = stop.child.as_ref().unwrap().id();
            child_pids.push(u64::from(stop_pid));
            let helper = listener.child.as_mut().unwrap();
            let mut gate = helper.stdin.take().unwrap();
            // Public Stop first performs control exchanges and native PID discovery.
            // Start exit observation only after the helper actually sent SIGKILL.
            let deadline = stop_started + Duration::from_secs(10);
            let acknowledgement = loop {
                assert!(
                    Instant::now() < deadline,
                    "helper SIGKILL acknowledgement timed out"
                );
                assert!(
                    helper.try_wait().unwrap().is_none(),
                    "helper exited before SIGKILL acknowledgement"
                );
                assert!(
                    stop.child.as_mut().unwrap().try_wait().unwrap().is_none(),
                    "public Stop exited before SIGKILL acknowledgement"
                );
                match killed.recv_timeout(Duration::from_millis(50)) {
                    Ok(line) => break line.expect("helper acknowledgement read"),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(error) => panic!("helper SIGKILL acknowledgement: {error}"),
                }
            };
            assert_eq!(
                serde_json::from_str::<Value>(&acknowledgement).unwrap(),
                serde_json::json!({"helper": other_pid, "original": old_pid})
            );
            let owner = foreground.as_mut().unwrap();
            let signal = owner
                .observe(Duration::from_secs(5))
                .expect("original child exit observation")
                .and_then(|status| status.signal());
            let gone = signal == Some(libc::SIGKILL)
                && wait_for_explicit_pid_exit(old_pid.into(), Duration::from_secs(4));
            let bound = listener
                .child
                .as_mut()
                .unwrap()
                .try_wait()
                .unwrap()
                .is_none()
                && TcpStream::connect(("127.0.0.1", ports[1])).is_ok();
            let running = stop.child.as_mut().unwrap().try_wait().unwrap().is_none();
            if !running {
                let output = stop.finish();
                panic!("public Stop exited before barrier: original={signal:?} absent={gone} helper_bound={bound} status={} stderr={}", output.status, String::from_utf8_lossy(&output.stderr));
            }
            assert!(
                gone && bound && running,
                "original={signal:?} absent={gone} helper_bound={bound} stop_running={running}"
            );
            self.paused = None;
            self.original_pending = false;
            assert_eq!(fs::read(&path).unwrap(), authentic);
            let mut challenged: Value = serde_json::from_slice(&authentic).unwrap();
            challenged["start_nonce"] = serde_json::json!("challenged");
            let bytes = serde_json::to_vec(&challenged).unwrap();
            assert_ne!(authentic, bytes);
            self.dead_control_fault = Some((path.clone(), authentic.clone()));
            fs::write(&path, &bytes).unwrap();
            assert_eq!(fs::read(&path).unwrap(), bytes);
            let acknowledged = gate.write_all(b"release").is_ok();
            eprintln!("exact exit barrier state={state:?} ports={ports:?} original_pid={old_pid} helper_pid={other_pid} stop_pid={stop_pid} original_signal={signal:?} pid_absent={gone} helper_bound={bound} stop_running={running} release_ack={acknowledged}");
            drop(gate);
            let collected =
                wait_for_child_exit(listener.child.as_mut().unwrap(), Duration::from_secs(2));
            if !collected {
                listener.child.as_mut().unwrap().kill().unwrap();
            }
            let output = listener.finish();
            assert!(wait_for_child_exit(
                stop.child.as_mut().unwrap(),
                Duration::from_secs(5)
            ));
            let refused = stop.finish();
            let reason = String::from_utf8_lossy(&refused.stderr);
            let preserved = fs::read(&path).unwrap() == bytes
                && fs::read(instance.join("status.json")).ok() == Some(status)
                && fs::read(instance.join("pid.cache")).ok().as_ref() == Some(&cache)
                && fs::read(instance.join("front-handoff.json")).ok().as_ref() == Some(&artifact)
                && fs::read(instance.join("instance.json")).unwrap() == declaration
                && fs::read(&plan_path).ok() == plan
                && fs::symlink_metadata(&socket).unwrap().ino() == inode
                && paths.each_ref().map(|p| p.read().ok()) == published;
            let correlated = reason.trim_end().ends_with(&format!(
            "managed stop terminal publication incomplete; signals already delivered: Terminate PID {old_pid}, Terminate PID {other_pid}"
        ));
            assert!(
                !refused.status.success()
                    && preserved
                    && correlated
                    && acknowledged
                    && collected
                    && output.status.success()
                    && ports
                        .iter()
                        .all(|p| TcpStream::connect(("127.0.0.1", *p)).is_err()),
                "release_ack={acknowledged}, helper_status={}, stop: {reason}",
                output.status
            );
            fs::write(&path, authentic).unwrap();
            self.dead_control_fault = None;
            eprintln!("exact post-exit refusal: original child {old_pid} collected, helper {other_pid} collected, both ports free, whole status and exact proof retained: {reason}");
            None
        } else {
            let mut command = isolated_lifetime_process(root, &state, config, "stop");
            if fault == Some(ExactCleanupFault::MeasuredStopSpawn) {
                command.current_dir(state.join("unavailable-stop-cwd"));
                let error = command.output().unwrap_err();
                assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
                eprintln!("measured Stop spawn for stopped original {old_pid}: {error}");
                std::panic::panic_any(ExactCleanupFault::MeasuredStopSpawn);
            }
            let result = command.output().unwrap();
            assert!(result.status.success(), "measured Stop: {result:?}");
            Some(result)
        };
        let exited = wait_for_explicit_pid_exit(old_pid.into(), Duration::from_secs(4));
        assert!(exited, "original PID {old_pid} remains");
        self.paused = None;
        self.original_pending = false;
        let persisted: Value =
            serde_json::from_slice(&fs::read(instance.join("status.json")).unwrap()).unwrap();
        let retained = fs::read(instance.join("pid.cache")).ok().as_ref() == Some(&cache)
            && fs::read(instance.join("front-handoff.json")).ok().as_ref() == Some(&artifact)
            && paths
                .iter()
                .zip(&published)
                .all(|(p, b)| &p.read().ok() == b);
        provider
            .fail
            .store(false, std::sync::atomic::Ordering::SeqCst);
        self.launch_pending = true;
        let fresh = invoke(if challenge || fault.is_some() {
            "restart"
        } else {
            "start"
        });
        assert!(fresh.status.success(), "formal launch: {fresh:?}");
        let record: routecodex_v3_lifecycle::V3ManagedStatusRecord =
            serde_json::from_value(last_json(&fresh)).unwrap();
        assert_eq!(
            Some(record.instance_id.as_ref()),
            instance.file_name().and_then(|s| s.to_str())
        );
        assert_eq!(
            record.state,
            routecodex_v3_lifecycle::V3ManagedRunState::Running
        );
        let observation = exact_launch_owner(
            &state,
            config,
            fresh_socket,
            None,
            fault.filter(|f| {
                matches!(
                    f,
                    ExactCleanupFault::FreshPeer | ExactCleanupFault::HeldFreshReader
                )
            }),
        );
        if let Some(marker @ (ExactCleanupFault::FreshPeer | ExactCleanupFault::HeldFreshReader)) =
            fault
        {
            let error = observation.as_ref().expect_err("expected fresh peer error");
            assert!(
                error.to_string().contains("unavailable-peer.sock"),
                "{error}"
            );
            eprintln!("initial fresh peer: {error}");
            if marker == ExactCleanupFault::HeldFreshReader {
                let socket = fresh_socket.as_ref().unwrap();
                socket.verify_identity().unwrap();
                let pid = exact_socket_peer(&socket.path).unwrap();
                let generation = exact_child_generation(pid, config).unwrap();
                socket.verify_identity().unwrap();
                self.recovery_witness = Some((pid, generation));
            }
            std::panic::panic_any(marker);
        }
        let (pid, generation) = observation.unwrap();
        self.fresh_pid = Some(pid);
        self.fresh_generation = generation;
        let fresh_pid = self.fresh_pid;
        let fresh_generation = &self.fresh_generation;
        eprintln!("exact fresh owner state={state:?} socket={socket:?} pid={fresh_pid:?} generation={fresh_generation:?} device={} inode={}",fresh_socket.as_ref().unwrap().device,fresh_socket.as_ref().unwrap().inode);
        let rt = runtime();
        if let Some(marker @ ExactCleanupFault::PendingLocked) = fault {
            self.witness = Some(ExactStopWitness::read(&instance).unwrap());
            for path in &paths {
                controls.push(endpoint(&path.read().unwrap()).unwrap());
            }
            self.witness
                .as_ref()
                .unwrap()
                .verify(
                    fresh_socket.as_ref().unwrap(),
                    pid,
                    config,
                    fresh_generation.as_deref().unwrap(),
                )
                .unwrap();
            let (arrive, arrived) = std::sync::mpsc::channel();
            let (resume, release) = std::sync::mpsc::channel();
            let (done, wrote) = std::sync::mpsc::channel();
            self.gate = Some(resume);
            self.wrote = Some(wrote);
            *provider.wrote_held.lock().unwrap() = Some(done);
            *provider.pause.lock().unwrap() = Some((arrive, release));
            provider.pending_request = true;
            let result = thread::scope(|scope| {
                let client = scope.spawn(|| {
                    rt.block_on(async {
                        reqwest::Client::builder()
                            .no_proxy()
                            .timeout(Duration::from_secs(1))
                            .build()
                            .unwrap()
                            .post(format!("http://127.0.0.1:{}/v1/responses", ports[0]))
                            .json(&business_body())
                            .send()
                            .await
                    })
                });
                arrived.recv_timeout(Duration::from_secs(3)).unwrap();
                client.join().unwrap()
            });
            assert!(
                result.is_err_and(|e| e.is_timeout()),
                "expected client timeout during accepted held request"
            );
            self.operation_lock = Some(ExactOperationLock::acquire(&instance).unwrap());
            let refused = invoke("stop");
            assert!(
                exact_stop_locked(&refused),
                "expected manager Stop lock refusal"
            );
            eprintln!(
                "exact first public Stop refused before closure, peer={pid}, fault={marker:?}"
            );
            std::panic::panic_any(marker);
        }
        provider.pending_request = true;
        let business = http(
            &rt,
            ([127, 0, 0, 1], ports[0]).into(),
            "POST",
            "/v1/responses",
            Some(if challenge {
                serde_json::json!({"model":"test","input":"fresh after restart","stream":false})
            } else {
                business_body()
            }),
        );
        if business.is_ok() {
            provider.pending_request = false;
        }
        let usable = fresh.status.success()
            && paths.iter().all(|p| {
                let addr = endpoint(&p.read().unwrap()).unwrap();
                controls.push(addr);
                matches!(http(&rt, addr, "GET", STATUS_PATH, None), Ok((200, _)))
            });
        let cache_path = instance.join("pid.cache");
        if fault == Some(ExactCleanupFault::MissingFreshCache) {
            let (code, body) = business.as_ref().unwrap();
            assert_eq!(*code, 200);
            assert_eq!(body["id"], "active-managed");
            assert_eq!(body["status"], "completed");
            assert_eq!(
                body["output"][0]["content"][0]["text"],
                "uncached connection probe"
            );
            assert!(usable);
            let held = instance.join("fixture-held-fresh-cache");
            fs::rename(&cache_path, &held).unwrap();
            self.missing_cache = Some((held, cache_path.clone()));
            assert_eq!(
                fs::read(&cache_path).unwrap_err().kind(),
                std::io::ErrorKind::NotFound
            );
            std::panic::panic_any(ExactCleanupFault::MissingFreshCache);
        }
        let cache: Value = serde_json::from_slice(&fs::read(&cache_path).unwrap()).unwrap();
        assert_eq!(fresh_pid, cache["pid"].as_u64());
        let stop = invoke("stop");
        let closed = fresh_pid
            .is_some_and(|pid| wait_for_explicit_pid_exit(pid, Duration::from_secs(5)))
            && !socket.exists()
            && paths.iter().all(|p| !p.record.exists())
            && ports
                .iter()
                .all(|p| TcpStream::connect(("127.0.0.1", *p)).is_err());
        drop(rt);
        let expected = if challenge {
            "fresh after restart"
        } else {
            "uncached connection probe"
        };
        eprintln!("forced fixture state={state:?} old_pid={old_pid} fresh_pid={fresh_pid:?} ports={ports:?} old_exited={exited} closed={closed}");
        assert!(exited);
        assert!(
            retained && fresh.status.success(),
            "retained={retained}, fresh: {}",
            String::from_utf8_lossy(&fresh.stderr)
        );
        assert!(usable && stop.status.success() && closed);
        let (code, body) = business.unwrap();
        assert_eq!(code, 200);
        assert_eq!(body["id"], "active-managed");
        assert_eq!(body["status"], "completed");
        assert_eq!(body["output"][0]["content"][0]["text"], expected);
        if let Some(forced) = forced {
            assert!(
                forced.status.success(),
                "{}",
                String::from_utf8_lossy(&forced.stderr)
            );
            assert_eq!(persisted["state"], "stopped");
            assert_eq!(last_json(&forced)["detail"], persisted["detail"]);
            assert!(
                persisted["detail"]
                    .as_str()
                    .unwrap()
                    .contains("pending active-key control cleanup"),
                "{persisted}"
            );
        }
        assert!(!last_json(&stop)["detail"]
            .as_str()
            .unwrap_or_default()
            .contains("pending active-key control cleanup"));
        self.launch_pending = false;
    }
}

impl RetainedExactFixture {
    fn cleanup(&mut self) -> Result<(), String> {
        let fault = self.fault;
        let r = &mut self.resources;
        let Some(root) = r.root.as_ref() else {
            return Ok(());
        };
        let state = root.path().join("state");
        if r.config_ports.is_none() {
            if let Some(provider) = r.provider.as_mut() {
                provider
                    .finish_quiescent(false)
                    .map_err(|e| e.to_string())?;
            }
            return exact_remove_root(root).map_err(|e| e.to_string());
        }
        let (config, ports) = r.config_ports.as_ref().unwrap();
        let ports = *ports;
        let provider = r.provider.as_mut().unwrap();
        let child_pids = &mut r.child_pids;
        let controls = &r.controls;
        let original_pending = r.original_pending;
        let launch_pending = r.launch_pending;
        let business_pending = provider.pending_request;
        let recovery_witness = &r.recovery_witness;
        let foreground = &mut r.foreground;
        if let Some(owner) = foreground.as_mut().filter(|owner| owner.refuse_collection) {
            return owner.collect().map(|_| ()).map_err(|e| e.to_string());
        }
        let paused = r.paused;
        let mut fresh_pid = r.fresh_pid;
        let mut errors = Vec::new();
        if let Some((path, authentic)) = &r.dead_control_fault {
            fs::write(path, authentic)
                .map_err(|e| format!("restore dead fixture control {path:?}: {e}"))?;
            r.dead_control_fault = None;
        }
        if let Some((held, path)) = &r.missing_cache {
            use std::os::unix::fs::MetadataExt;
            if let Err(e) = fs::hard_link(held, path) {
                let source = fs::symlink_metadata(held).map_err(|e| e.to_string())?;
                let dest = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
                if e.kind() != std::io::ErrorKind::AlreadyExists
                    || !dest.is_file()
                    || (source.dev(), source.ino()) != (dest.dev(), dest.ino())
                {
                    return Err(format!("restore fixture cache {path:?}: {e}"));
                }
            }
            fs::remove_file(held).map_err(|e| e.to_string())?;
            r.missing_cache = None;
        }
        if original_pending || launch_pending {
            let expected_pid = if original_pending {
                child_pids.first().copied()
            } else {
                fresh_pid
            };
            let (bound, generation) = if original_pending {
                (&mut r.original_socket, &r.original_generation)
            } else {
                (&mut r.fresh_socket, &r.fresh_generation)
            };
            let mut resolve = |reader_fault| -> std::io::Result<()> {
                // A collected, previously bound generation needs only the final
                // inode, process and endpoint checks, including on barrier failure.
                if original_pending {
                    if let Some(owner) = foreground
                        .as_mut()
                        .filter(|owner| owner.unpublished_socket.is_some())
                    {
                        owner.collect()?;
                        return owner.check_unpublished(&state, config);
                    }
                }
                if let (Some(expected), Some(_)) =
                    (expected_pid, bound.as_ref().filter(|s| s.verified))
                {
                    if unsafe { libc::kill(expected as libc::pid_t, 0) } == -1
                        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                    {
                        return Ok(());
                    }
                }
                if let Some(stopped) = paused {
                    let same_child = foreground
                        .as_mut()
                        .and_then(|owner| owner.child.as_mut())
                        .is_some_and(|child| {
                            child.id() == stopped && matches!(child.try_wait(), Ok(None))
                        });
                    let same_detached = if let Some(expected) = generation {
                        exact_child_generation(stopped.into(), config)? == *expected
                    } else {
                        false
                    };
                    if !same_child && !same_detached {
                        return Err(std::io::Error::other(format!(
                            "cannot verify stopped original {stopped}"
                        )));
                    }
                    if unsafe { libc::kill(stopped as libc::pid_t, libc::SIGCONT) } != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    eprintln!("resumed fixture-stopped original {stopped}");
                }
                let (pid, observed) = match exact_launch_owner(
                    &state,
                    config,
                    bound,
                    foreground
                        .as_ref()
                        .and_then(|owner| owner.child.as_ref())
                        .map(Child::id)
                        .filter(|_| original_pending),
                    reader_fault,
                ) {
                    Ok(owner) => owner,
                    Err(error) => {
                        if original_pending
                            && !launch_pending
                            && !business_pending
                            && !bound.as_ref().is_some_and(|s| s.verified)
                        {
                            if let Some(owner) =
                                foreground.as_mut().filter(|owner| owner.child.is_some())
                            {
                                let pid = owner.child.as_ref().unwrap().id().into();
                                if !child_pids.contains(&pid) {
                                    child_pids.push(pid);
                                }
                                return owner.collect_after_missing_owner(
                                    &state,
                                    config,
                                    bound.as_ref(),
                                    &error,
                                );
                            }
                        }
                        // SIGCONT can deliver the measured Stop's pending TERM.
                        // Collect the direct child before rechecking its PID.
                        if let Some(child) =
                            foreground.as_mut().and_then(|owner| owner.child.as_mut())
                        {
                            child.try_wait()?;
                        }
                        let retired = expected_pid.zip(bound.as_ref().filter(|s| s.verified)).is_some_and(|(pid, socket)| {
                        (unsafe { libc::kill(pid as libc::pid_t, 0) } == -1)
                            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                            && matches!(fs::symlink_metadata(&socket.path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
                    });
                        if retired {
                            eprintln!("pending peer read: {error}; previously bound generation exited and socket retired");
                            return Ok(());
                        }
                        return Err(error);
                    }
                };
                let socket = bound.as_ref().unwrap();
                if expected_pid.is_some_and(|p| p != pid)
                    || generation
                        .as_ref()
                        .is_some_and(|g| observed.as_ref() != Some(g))
                    || recovery_witness.as_ref().is_some_and(|(expected, token)| {
                        *expected != pid || observed.as_ref() != Some(token)
                    })
                {
                    return Err(std::io::Error::other(format!(
                        "fixture generation changed at {:?}, peer={pid}",
                        socket.path
                    )));
                }
                eprintln!("pending fixture original={original_pending} peer={pid} socket={:?} device={} inode={} generation={observed:?}",socket.path,socket.device,socket.inode);
                if !child_pids.contains(&pid) {
                    child_pids.push(pid);
                }
                if launch_pending {
                    fresh_pid = Some(pid);
                    r.fresh_pid = Some(pid);
                }
                if let Some(witness) = &r.witness {
                    witness.verify(socket, pid, config, observed.as_deref().unwrap_or_default())?;
                }
                let stop = isolated_lifetime_process(root, &state, config, "stop").output()?;
                if !stop.status.success() {
                    if exact_stop_locked(&stop) {
                        if let (Some(witness), Some(lock)) = (&r.witness, &r.operation_lock) {
                            lock.verify()?;
                            witness.verify(
                                socket,
                                pid,
                                config,
                                observed.as_deref().unwrap_or_default(),
                            )?;
                            return Err(std::io::Error::other(format!(
                                "public Stop operation locked; verified live peer {pid}"
                            )));
                        }
                    }
                    return Err(std::io::Error::other(format!(
                        "fixture Stop pid={pid}: {stop:?}"
                    )));
                }
                Ok(())
            };
            let held_reader = fault
                .filter(|f| *f == ExactCleanupFault::HeldFreshReader && recovery_witness.is_some());
            let mut result = resolve(held_reader);
            if held_reader.is_some() {
                let unavailable = result
                    .as_ref()
                    .is_err_and(|e| e.to_string().contains("unavailable-peer.sock"));
                let live = TcpStream::connect(("127.0.0.1", ports[0])).is_ok();
                if !unavailable || !live || !root.path().is_dir() || business_pending {
                    errors.push(format!(
                    "pre-business disposition: {result:?}, live={live}, pending={business_pending}"
                ));
                } else if let Err(error) = provider.finish_quiescent(false) {
                    errors.push(error.to_string());
                } else if !provider.visits.lock().is_ok_and(|v| v.is_empty()) {
                    errors.push("unexpected pre-business Provider visit".into());
                } else {
                    eprintln!("pre-business root {:?} retained with live listener {}; idle recorder {} joined and refused, visits=[]; restore only reader fault: {result:?}", root.path(), ports[0], provider.port);
                }
                result = resolve(None);
            }
            if let Err(error) = result {
                let custody = bound
                    .as_ref()
                    .map(|s| (&s.path, s.device, s.inode, s.verified));
                errors.push(format!("pending launch original={original_pending} fresh={launch_pending} state={state:?} observed(path,device,inode,verified)={custody:?}: {error}"));
            }
        }
        if !errors.is_empty() {
            if business_pending {
                if let Err(refused) = provider.finish_quiescent(false) {
                    errors.push(refused.to_string());
                }
            }
            return Err(errors.join("; "));
        }
        if let Some(owner) = foreground {
            owner.collect().map_err(|e| e.to_string())?;
        }
        if let Some(pid) = fresh_pid {
            if !child_pids.contains(&pid) {
                child_pids.push(pid);
            }
        }
        for pid in child_pids.iter() {
            if !wait_for_explicit_pid_exit(*pid, Duration::from_secs(5)) {
                errors.push(format!("fixture pid {pid} still present"));
            }
        }
        let generation_closed = !child_pids.is_empty()
            && errors.is_empty()
            && (fresh_pid.is_some() || original_pending);
        if let Some(socket) = r
            .fresh_socket
            .as_ref()
            .or(r.original_socket.as_ref())
            .filter(|_| errors.is_empty())
        {
            if let Err(error) = socket.remove_if_inactive() {
                errors.push(error.to_string());
            }
        }
        for addr in controls
            .iter()
            .copied()
            .chain(ports.map(|port| ([127, 0, 0, 1], port).into()))
        {
            if !matches!(TcpStream::connect(addr), Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused)
            {
                errors.push(format!("missing endpoint refusal at {addr}"));
            }
        }
        if let Some(pid) = fresh_pid {
            for id in ["a", "b"] {
                match routecodex_v3_config::v3_active_key_control_paths(config, id) {
                    Ok(path) => {
                        let absent = matches!(fs::symlink_metadata(&path.record), Err(error) if error.kind() == std::io::ErrorKind::NotFound);
                        if !absent {
                            errors.push(format!(
                                "fresh pid {pid} still has record {:?}",
                                path.record
                            ));
                        }
                    }
                    Err(error) => errors.push(format!("fresh pid {pid} record for {id}: {error}")),
                }
            }
        }
        let visits = provider.visits.clone();
        if let Some(witness) = &r.witness {
            let instance = &witness.instance;
            for name in ["control.json", "pid.cache"] {
                if !matches!(fs::symlink_metadata(instance.join(name)), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
                {
                    errors.push(format!("unsettled managed record {name}"));
                }
            }
            let status: Value = serde_json::from_slice(
                &fs::read(instance.join("status.json")).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            if status["state"] != "stopped"
                || status["instance_id"] != witness.declaration["instance_id"]
            {
                errors.push("managed terminal status disagrees".into());
            }
        }
        let recorder_port = provider.port;
        if let Err(error) = provider.finish_quiescent(generation_closed) {
            errors.push(error.to_string());
        }
        let root_path = root.path().to_owned();
        if !matches!(TcpStream::connect(("127.0.0.1", recorder_port)), Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused)
        {
            errors.push(format!("missing recorder refusal on port {recorder_port}"));
        }
        if errors.is_empty() {
            ExactOperationLock::restore(&mut r.operation_lock).map_err(|e| e.to_string())?;
            if let Err(error) = exact_remove_root(root) {
                errors.push(format!("fixture root {root_path:?}: {error}"));
            }
            if !matches!(fs::symlink_metadata(&root_path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
            {
                errors.push(format!("fixture root still present {root_path:?}"));
            }
        } else {
            errors.push(format!(
                "retained fixture cleanup responsibility at {:?}",
                root.path()
            ));
        }
        let inputs = visits.lock().unwrap_or_else(|error| error.into_inner());
        eprintln!("exact teardown fault={fault:?} root={root_path:?} pids={child_pids:?} ports={ports:?} controls={controls:?} recorder={recorder_port} visits={inputs:?} cleanup={errors:?}");
        if !errors.is_empty() {
            return Err(errors.join("; "));
        }
        Ok(())
    }
}

fn exact_expected_inputs(fault: Option<ExactCleanupFault>, challenge: bool) -> Vec<&'static str> {
    match (fault, challenge) {
        (
            Some(
                ExactCleanupFault::CollectedOriginal
                | ExactCleanupFault::OriginalMetadata
                | ExactCleanupFault::DetachedOriginalPeer
                | ExactCleanupFault::FreshPeer
                | ExactCleanupFault::HeldFreshReader
                | ExactCleanupFault::FirstForegroundPeer
                | ExactCleanupFault::MeasuredStopSpawn,
            ),
            _,
        ) => vec![],
        (_, true) => vec!["uncached connection probe", "fresh after restart"],
        (_, false) => vec!["uncached connection probe"],
    }
}

fn exact_remove_root(root: &TempDir) -> std::io::Result<()> {
    match fs::remove_dir_all(root.path()) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    match fs::symlink_metadata(root.path()) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => Err(std::io::Error::other(format!(
            "root disposition {:?}: {result:?}",
            root.path()
        ))),
    }
}

fn exact_stop_locked(output: &std::process::Output) -> bool {
    !output.status.success()
        && String::from_utf8_lossy(&output.stderr)
            .contains("managed lifecycle operation is already locked for stop")
}

#[test]
fn aggregate_absent_locked_constructor() {
    aggregate_absent_locked(false, false);
}

#[test]
fn aggregate_absent_locked_changed_directory() {
    aggregate_absent_locked(true, false);
}

#[test]
fn aggregate_absent_changed_directory_transfer_retry() {
    aggregate_absent_locked(true, true);
}

#[cfg(target_os = "macos")]
#[test]
fn interrupted_predecessor_control_unlink() {
    interrupted_unlink(false);
}

#[cfg(target_os = "macos")]
struct ImmutableFixtureFile(PathBuf);

#[cfg(target_os = "macos")]
impl ImmutableFixtureFile {
    fn new(path: PathBuf) -> Self {
        assert!(Command::new("chflags")
            .arg("uchg")
            .arg(&path)
            .status()
            .unwrap()
            .success());
        Self(path)
    }
}

#[cfg(target_os = "macos")]
impl Drop for ImmutableFixtureFile {
    fn drop(&mut self) {
        assert!(Command::new("chflags")
            .arg("nouchg")
            .arg(&self.0)
            .status()
            .unwrap()
            .success());
    }
}

#[cfg(target_os = "macos")]
pub(super) fn interrupted_unlink(legacy: bool) {
    use std::sync::atomic::Ordering;
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state = root.path().join("state");
    let provider = ActiveProvider::start();
    provider.fail.store(false, Ordering::SeqCst);
    let (config, ports) = if legacy {
        let ports = [free_port(), free_port()];
        (
            write_config_with_provider(&root, ports, false, true, Some(provider.port)),
            ports,
        )
    } else {
        managed_lifetime_config(&root, "127.0.0.1", provider.port)
    };
    let mut old = legacy.then(|| {
        super::previous_release_restart::start_previous_release(&root, &state, &config, ports[0])
    });
    let process = (!legacy).then(|| p0_start(&root, &state, &config));
    let previous = single_instance_dir(&state);
    let target_config = root.path().join("successor.toml");
    fs::copy(&config, &target_config).unwrap();
    let binary = env!("CARGO_BIN_EXE_rccv3");
    let (decl, _) =
        routecodex_v3_lifecycle::V3ManagedLifecycle::with_state_root(&target_config, &state)
            .declaration(Path::new(binary))
            .unwrap();
    let target = state.join("instances").join(&decl.instance_id);
    fs::create_dir_all(&target).unwrap();
    let lock = fs::File::create(target.join("status.lock")).unwrap();
    lock.lock().unwrap();
    let (entered, arrival) = std::sync::mpsc::channel();
    let (resume, release) = std::sync::mpsc::channel();
    *provider.pause.lock().unwrap() = Some((entered, release));
    let client = thread::spawn(move || {
        http(
            &runtime(),
            ([127, 0, 0, 1], ports[0]).into(),
            "POST",
            "/v1/responses",
            Some(business_body()),
        )
    });
    arrival.recv_timeout(Duration::from_secs(5)).unwrap();
    let child = managed_test_command(binary, &state)
        .args(["restart", "--config"])
        .arg(&target_config)
        .env("HOME", root.path().join("home"))
        .env("ROUTECODEX_V3_STATE_DIR", &state)
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + PORT_STATE_TIMEOUT;
    let barrier = if legacy {
        target.join("previous-release-restart.json")
    } else {
        target.join("instance.json")
    };
    while !barrier.is_file() {
        assert!(
            Instant::now() < deadline,
            "restart never reached {barrier:?}"
        );
        sleep(Duration::from_millis(2));
    }
    let fault = if legacy {
        target.join("previous-release-restart.json")
    } else {
        previous.join("control.json")
    };
    let immutable = ImmutableFixtureFile::new(fault);
    lock.unlock().unwrap();
    drop(lock);
    let failed = child.wait_with_output().unwrap();
    let _ = resume.send(());
    let abandoned = client.join().unwrap();
    if let Some(runtime) = old.as_mut() {
        let deadline = Instant::now() + PORT_STATE_TIMEOUT;
        while runtime.child.try_wait().unwrap().is_none() {
            assert!(
                Instant::now() < deadline,
                "previous-release process did not exit"
            );
            sleep(Duration::from_millis(10));
        }
    }
    let adoption_locations = target.join("front-handoff.json").is_file()
        && target.join("provider-handoff.json").is_file();
    assert!(!previous.join("provider-handoff.json").exists());
    let run = |config: &Path, op| isolated_lifetime_command(&root, &state, config, op);
    let refused = run(&target_config, "restart");
    let retained = target.join("front-handoff.json").is_file();
    if legacy {
        let evidence = [
            "previous-release-restart.json",
            "front-handoff.json",
            "provider-handoff.json",
            "pid.cache",
        ];
        let before = evidence.map(|name| fs::read(target.join(name)).unwrap());
        for args in [&["server", "start"][..], &["start"][..]] {
            let mut attempt = managed_test_command(binary, &state)
                .args(args)
                .arg("--config")
                .arg(&target_config)
                .env("HOME", root.path().join("home"))
                .env("ROUTECODEX_V3_STATE_DIR", &state)
                .env("V3_MANAGED_TEST_KEY", SECRET)
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let deadline = Instant::now() + PORT_STATE_TIMEOUT;
            while attempt.try_wait().unwrap().is_none() {
                if Instant::now() >= deadline {
                    attempt.kill().unwrap();
                    attempt.wait().unwrap();
                    panic!("{args:?} failed to refuse interrupted adoption");
                }
                sleep(Duration::from_millis(10));
            }
            let output = attempt.wait_with_output().unwrap();
            assert!(
                !output.status.success()
                    && String::from_utf8_lossy(&output.stderr).contains("Operation not permitted")
            );
            assert_eq!(
                evidence.map(|name| fs::read(target.join(name)).unwrap()),
                before
            );
        }
    }
    let log = fs::read_to_string(if legacy {
        root.path().join("previous-runtime.log")
    } else {
        previous.join("server.log")
    })
    .unwrap();
    drop(immutable);
    let fresh = run(&target_config, "restart");
    let check = |config: &Path| {
        let rt = runtime();
        if !legacy {
            for id in ["a", "b"] {
                let bytes = routecodex_v3_config::v3_active_key_control_paths(config, id)
                    .unwrap()
                    .read()
                    .unwrap();
                assert_eq!(
                    http(&rt, endpoint(&bytes).unwrap(), "GET", STATUS_PATH, None)
                        .unwrap()
                        .0,
                    200
                );
            }
        }
        let (code, body) = http(
            &rt,
            ([127, 0, 0, 1], ports[0]).into(),
            "POST",
            "/v1/responses",
            Some(business_body()),
        )
        .unwrap();
        assert_eq!(
            (
                code,
                body["id"].as_str(),
                body["status"].as_str(),
                body["output"][0]["content"][0]["text"].as_str()
            ),
            (
                200,
                Some("active-managed"),
                Some("completed"),
                Some("uncached connection probe")
            )
        );
    };
    let mut current = &target_config;
    let mut back = false;
    let mut forward = false;
    if fresh.status.success() {
        check(current);
        if !legacy {
            back = run(&config, "restart").status.success();
            if back {
                current = &config;
                check(current);
                forward = run(&target_config, "restart").status.success();
                if forward {
                    current = &target_config;
                    check(current);
                }
            }
        }
        assert!(run(current, "stop").status.success());
    }
    let calls = provider.calls.load(Ordering::SeqCst);
    drop((old, process, provider));
    let closed = ports
        .iter()
        .all(|port| TcpStream::connect(("127.0.0.1", *port)).is_err());
    root.close().unwrap();
    eprintln!("legacy={legacy} retained={retained} back={back} forward={forward} calls={calls} adoption={log} refusal={} fresh={}",String::from_utf8_lossy(&refused.stderr), String::from_utf8_lossy(&fresh.stderr));
    assert!(
        closed
            && adoption_locations
            && abandoned.is_err()
            && !failed.status.success()
            && log.contains("Operation not permitted")
    );
    assert!(
        !refused.status.success()
            && String::from_utf8_lossy(&refused.stderr).contains("Operation not permitted")
    );
    assert!(retained && fresh.status.success() && (legacy || (back && forward)));
    assert_eq!(calls, if legacy { 2 } else { 4 });
}

fn aggregate_absent_locked(changed_dir: bool, changed_transfer: bool) {
    use std::os::unix::fs::OpenOptionsExt;
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state = root.path().join("state");
    let provider = ActiveProvider::start();
    provider
        .fail
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let (config, ports) = managed_lifetime_config(&root, "127.0.0.1", provider.port);
    let process = p0_start(&root, &state, &config);
    let previous = single_instance_dir(&state);
    let old_control = managed_control(&previous);
    let old_socket = managed_socket(&old_control);
    let previous_cache = fs::read(previous.join("pid.cache")).unwrap();
    let previous_control = fs::read(previous.join("control.json")).unwrap();
    let target_config = if changed_dir {
        let path = root.path().join("successor.toml");
        fs::copy(&config, &path).unwrap();
        path
    } else {
        config.clone()
    };
    let binary = env!("CARGO_BIN_EXE_rccv3");
    let (decl, _) =
        routecodex_v3_lifecycle::V3ManagedLifecycle::with_state_root(&target_config, &state)
            .declaration(Path::new(binary))
            .unwrap();
    let target = state.join("instances").join(&decl.instance_id);
    fs::create_dir_all(&target).unwrap();
    let hold = root
        .path()
        .join(format!("active-keys-127.0.0.1_{}.json", ports[0]));
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(target.join("status.lock"))
        .unwrap();
    if changed_dir {
        lock.lock().unwrap();
    } else {
        assert!(Command::new("mkfifo")
            .arg(&hold)
            .status()
            .unwrap()
            .success());
    }
    let restart = || {
        let mut command = managed_test_command(binary, &state);
        command
            .args(["restart", "--config"])
            .arg(&target_config)
            .env("HOME", root.path().join("home"))
            .env("ROUTECODEX_V3_STATE_DIR", &state)
            .env("V3_MANAGED_TEST_KEY", SECRET);
        command
    };
    let abandoned = (changed_dir && !changed_transfer).then(|| {
        let (entered, arrival) = std::sync::mpsc::channel();
        let (resume, release) = std::sync::mpsc::channel();
        *provider.pause.lock().unwrap() = Some((entered, release));
        let addr = ([127, 0, 0, 1], ports[0]).into();
        let client = thread::spawn(move || {
            http(
                &runtime(),
                addr,
                "POST",
                "/v1/responses",
                Some(business_body()),
            )
        });
        arrival.recv_timeout(Duration::from_secs(5)).unwrap();
        (
            client,
            resume,
            provider.calls.load(std::sync::atomic::Ordering::SeqCst),
        )
    });
    let child = restart()
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let status = target.join("status.json");
    let control = target.join("control.json");
    let front = target.join("front-handoff.json");
    let cache = target.join("pid.cache");
    let deadline = Instant::now() + Duration::from_secs(10);
    let writer = if changed_dir {
        while !target.join("instance.json").exists() && Instant::now() < deadline {
            sleep(Duration::from_millis(2));
        }
        None
    } else {
        let writer = loop {
            match fs::OpenOptions::new()
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(&hold)
            {
                Ok(writer) => break writer,
                Err(_) if Instant::now() < deadline => sleep(Duration::from_millis(5)),
                Err(error) => panic!("constructor FIFO: {error}"),
            }
        };
        lock.lock().unwrap();
        Some(writer)
    };
    let original_status = fs::read(&status).ok();
    let original_control = fs::read(&control).ok();
    let original_cache = fs::read(&cache).unwrap();
    let original_front = fs::read(&front).unwrap();
    let published: Value = serde_json::from_slice(&original_cache).unwrap();
    let interrupted = abandoned.map(|(client, resume, observed)| {
        let _ = resume.send(());
        (client.join().unwrap(), observed)
    });
    let transfer = target.join("previous-release-restart.json");
    let saved_transfer = root.path().join("authentic-transfer");
    let mut foreign_transfer = Vec::new();
    if changed_transfer {
        fs::rename(&transfer, &saved_transfer).unwrap();
        let mut value: Value = serde_json::from_slice(&fs::read(&saved_transfer).unwrap()).unwrap();
        value["pid"]["start_nonce"] = serde_json::json!("foreign-transfer");
        foreign_transfer = serde_json::to_vec(&value).unwrap();
        fs::write(&transfer, &foreign_transfer).unwrap();
        lock.unlock().unwrap();
    }
    if let Some(mut writer) = writer {
        writer.write_all(b"invalid hold JSON").unwrap();
    }
    let exited = wait_for_explicit_pid_exit(process.pid.into(), Duration::from_secs(8));
    let failed = child.wait_with_output().unwrap();
    let log = fs::read_to_string(previous.join("server.log")).unwrap();
    let cause = if changed_transfer {
        log.contains("current exec transfer changed")
    } else {
        log.lines().any(|line| {
            line.contains("status write failed after")
                && line.contains("status file lock")
                && if changed_dir {
                    line.matches("status file lock").count() == 2
                } else {
                    line.contains("expected value")
                }
        })
    };
    let retained = fs::read(&front).ok().as_ref() == Some(&original_front)
        && fs::read(&cache).ok().as_ref() == Some(&original_cache)
        && fs::read(&control).ok() == original_control
        && (!changed_dir
            || (fs::read(previous.join("pid.cache")).ok().as_ref() == Some(&previous_cache)
                && fs::read(previous.join("control.json")).ok().as_ref()
                    == Some(&previous_control)));
    let recovery_status = fs::read(&status).ok();
    let status_unchanged = if changed_transfer {
        recovery_status.as_ref().is_some_and(|bytes| {
            serde_json::from_slice::<Value>(bytes).unwrap()["state"] == "failed"
        })
    } else {
        recovery_status == original_status
    };
    if changed_dir {
        let checkpoint = target.join("provider-handoff.json");
        assert!(checkpoint.is_file() && !previous.join("provider-handoff.json").exists());
        fs::write(checkpoint, b"{").unwrap();
    }
    drop(lock);
    if !changed_dir {
        fs::remove_file(&hold).unwrap();
    }
    let paths = ["a", "b"]
        .map(|id| routecodex_v3_config::v3_active_key_control_paths(&target_config, id).unwrap());
    let prior_paths = ["a", "b"]
        .map(|id| routecodex_v3_config::v3_active_key_control_paths(&config, id).unwrap());
    let records = prior_paths.each_ref().map(|p| p.read().ok());
    let target_records = paths.each_ref().map(|p| p.read().ok());
    let predecessor_locked = if changed_dir {
        let lock_path = previous.join("lifecycle.lock");
        let lock = fs::File::create_new(&lock_path).unwrap();
        let prior_front = fs::read(previous.join("front-handoff.json")).ok();
        let denied = restart().output().unwrap();
        let preserved = !denied.status.success()
            && String::from_utf8_lossy(&denied.stderr).contains("recover-control")
            && fs::read(previous.join("pid.cache")).ok().as_ref() == Some(&previous_cache)
            && fs::read(previous.join("control.json")).ok().as_ref() == Some(&previous_control)
            && fs::read(previous.join("front-handoff.json")).ok() == prior_front
            && fs::read(&cache).ok().as_ref() == Some(&original_cache)
            && fs::read(&front).ok().as_ref() == Some(&original_front)
            && fs::read(&control).ok() == original_control
            && paths.each_ref().map(|p| p.read().ok()) == target_records
            && prior_paths.each_ref().map(|p| p.read().ok()) == records;
        drop(lock);
        fs::remove_file(lock_path).unwrap();
        preserved
    } else {
        true
    };
    let mut refused = false;
    let transfer_preserved = if changed_transfer {
        let intact = fs::read(&transfer).ok().as_ref() == Some(&foreign_transfer);
        let denied = retained && !restart().output().unwrap().status.success();
        let preserved = fs::read(&front).ok().as_ref() == Some(&original_front)
            && fs::read(previous.join("pid.cache")).ok().as_ref() == Some(&previous_cache)
            && fs::read(previous.join("control.json")).ok().as_ref() == Some(&previous_control)
            && fs::read(&transfer).ok().as_ref() == Some(&foreign_transfer);
        fs::rename(saved_transfer, &transfer).unwrap();
        #[cfg(target_os = "macos")]
        let unlink_refused = {
            let authentic = fs::read(&transfer).unwrap();
            assert!(Command::new("chflags")
                .arg("uchg")
                .arg(&transfer)
                .status()
                .unwrap()
                .success());
            let pending = restart().output().unwrap();
            let result = !pending.status.success()
                && String::from_utf8_lossy(&pending.stderr).contains("Operation not permitted")
                && fs::read(&transfer).ok().as_ref() == Some(&authentic)
                && fs::read(&front).ok().as_ref() == Some(&original_front)
                && fs::read(previous.join("pid.cache")).ok().as_ref() == Some(&previous_cache)
                && fs::read(previous.join("control.json")).ok().as_ref() == Some(&previous_control);
            assert!(Command::new("chflags")
                .arg("nouchg")
                .arg(&transfer)
                .status()
                .unwrap()
                .success());
            result
        };
        #[cfg(not(target_os = "macos"))]
        let unlink_refused = true;
        intact && denied && preserved && unlink_refused
    } else {
        true
    };
    if retained {
        let proof = previous.join("pid.cache");
        let authentic = fs::read(&proof).unwrap();
        let control_path = previous.join("control.json");
        let authentic_control = fs::read(&control_path).unwrap();
        let prior_front = fs::read(previous.join("front-handoff.json")).ok();
        refused = true;
        for invalid_control in [false, true] {
            if invalid_control && !changed_dir {
                continue;
            }
            let saved_control = root.path().join("authentic-control.json");
            if invalid_control {
                let mut value: Value = serde_json::from_slice(&authentic_control).unwrap();
                value["start_nonce"] = serde_json::json!("other-control-generation");
                fs::rename(&control_path, &saved_control).unwrap();
                fs::write(&control_path, serde_json::to_vec(&value).unwrap()).unwrap();
            }
            let prior_control = fs::read(&control_path).ok();
            // Keep both original managed files intact during candidate-only
            // defensive checks, including simultaneous invalid records.
            let saved = root.path().join("authentic-pid.cache");
            fs::rename(&proof, &saved).unwrap();
            refused &= [Some("start_nonce"), Some("instance_id"), None]
                .into_iter()
                .all(|field| {
                    if let Some(field) = field {
                        let mut value: Value = serde_json::from_slice(&authentic).unwrap();
                        let identity = if changed_dir {
                            &mut value
                        } else {
                            &mut value["retained_control"]
                        };
                        identity[field] = serde_json::json!("other-generation");
                        fs::write(&proof, serde_json::to_vec(&value).unwrap()).unwrap();
                    } else {
                        fs::remove_file(&proof).unwrap();
                    }
                    let tested = fs::read(&proof).ok();
                    let denied = restart().output().unwrap();
                    let preserved = !denied.status.success()
                        && fs::read(&proof).ok() == tested
                        && fs::read(previous.join("control.json")).ok() == prior_control
                        && fs::read(&control).ok() == original_control
                        && fs::read(&status).ok() == recovery_status
                        && fs::read(&front).ok().as_ref() == Some(&original_front)
                        && fs::read(previous.join("front-handoff.json")).ok() == prior_front
                        && (!changed_dir
                            || fs::read(&cache).ok().as_ref() == Some(&original_cache))
                        && paths.each_ref().map(|p| p.read().ok()) == target_records
                        && prior_paths.each_ref().map(|p| p.read().ok()) == records;
                    preserved
                });
            fs::rename(saved, &proof).unwrap();
            if invalid_control {
                fs::remove_file(&control_path).unwrap();
                fs::rename(saved_control, &control_path).unwrap();
            }
        }
    }
    let unknown_preserved = if changed_dir && !changed_transfer {
        let checkpoint = target.join("provider-handoff.json");
        let saved = root.path().join("relocated-checkpoint");
        fs::rename(&checkpoint, &saved).unwrap();
        fs::create_dir(&checkpoint).unwrap();
        let denied = restart().output().unwrap();
        let preserved = !denied.status.success()
            && String::from_utf8_lossy(&denied.stderr).contains("not a regular file")
            && checkpoint.is_dir()
            && fs::read(&front).ok().as_ref() == Some(&original_front)
            && fs::read(&cache).ok().as_ref() == Some(&original_cache)
            && fs::read(previous.join("pid.cache")).ok().as_ref() == Some(&previous_cache)
            && fs::read(previous.join("control.json")).ok().as_ref() == Some(&previous_control);
        fs::remove_dir(&checkpoint).unwrap();
        fs::rename(saved, checkpoint).unwrap();
        preserved
    } else {
        true
    };
    let fresh = restart().output().unwrap();
    let rt = runtime();
    let usable = fresh.status.success()
        && paths.iter().all(|p| {
            p.read()
                .ok()
                .and_then(|b| endpoint(&b))
                .is_some_and(|addr| {
                    matches!(http(&rt, addr, "GET", STATUS_PATH, None), Ok((200, _)))
                })
        });
    let business = usable.then(|| {
        http(
            &rt,
            ([127, 0, 0, 1], ports[0]).into(),
            "POST",
            "/v1/responses",
            Some(business_body()),
        )
    });
    let fresh_pid = fs::read(&cache)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|c| c["pid"].as_u64());
    let returned = changed_transfer
        && usable
        && isolated_lifetime_command(&root, &state, &config, "restart")
            .status
            .success();
    let return_controls = returned
        && prior_paths.iter().all(|p| {
            p.read()
                .ok()
                .and_then(|b| endpoint(&b))
                .is_some_and(|addr| {
                    matches!(http(&rt, addr, "GET", STATUS_PATH, None), Ok((200, _)))
                })
        });
    let return_business = returned.then(|| {
        http(
            &rt,
            ([127, 0, 0, 1], ports[0]).into(),
            "POST",
            "/v1/responses",
            Some(business_body()),
        )
    });
    let back_to_target = returned && restart().output().unwrap().status.success();
    let stop_config = if returned && !back_to_target {
        &config
    } else {
        &target_config
    };
    let stop = isolated_lifetime_command(&root, &state, stop_config, "stop");
    let final_calls = provider.calls.load(std::sync::atomic::Ordering::SeqCst);
    let stopped =
        fresh_pid.is_none_or(|pid| wait_for_explicit_pid_exit(pid, Duration::from_secs(6)));
    let closed = !old_socket.exists()
        && paths.iter().chain(&prior_paths).all(|p| !p.record.exists())
        && ports
            .iter()
            .all(|p| TcpStream::connect(("127.0.0.1", *p)).is_err());
    if exited && stopped && old_socket.exists() {
        fs::remove_file(&old_socket).unwrap();
    }
    drop(process);
    drop(rt);
    drop(provider);
    root.close().unwrap();
    eprintln!("aggregate absent changed_dir={changed_dir} state={state:?} exited={exited} cause={cause} retained={retained} refused={refused} recovered_pid={fresh_pid:?} stopped={stopped} closed={closed}");
    assert!(
        exited && cause && status_unchanged && !failed.status.success(),
        "{log}"
    );
    assert_eq!(
        published["retained_control"]["start_nonce"],
        old_control["start_nonce"]
    );
    assert_eq!(original_control.is_none(), changed_dir);
    assert_eq!(target != previous, changed_dir);
    assert!(records.iter().all(|record| record.is_some() == changed_dir));
    if let Some((interrupted, observed)) = interrupted {
        assert!(
            interrupted.is_err(),
            "abandoned request completed: {interrupted:?}"
        );
        assert_eq!(
            final_calls,
            observed + 1,
            "only fresh business reaches Provider"
        );
    }
    if !changed_dir {
        assert_eq!(
            serde_json::from_slice::<Value>(&original_status.unwrap()).unwrap()["state"],
            "starting"
        );
    }
    assert!(
        retained && fresh.status.success(),
        "retained={retained}, formal restart: {}",
        String::from_utf8_lossy(&fresh.stderr)
    );
    assert!(
        predecessor_locked
            && unknown_preserved
            && refused
            && usable
            && stop.status.success()
            && stopped
            && closed
    );
    if changed_transfer {
        assert!(transfer_preserved && return_controls && back_to_target);
        let (code, body) = return_business.unwrap().unwrap();
        assert_eq!(code, 200);
        assert_eq!(body["id"], "active-managed");
        assert_eq!(body["status"], "completed");
        assert_eq!(
            body["output"][0]["content"][0]["text"],
            "uncached connection probe"
        );
    }
    let (code, body) = business.unwrap().unwrap();
    assert_eq!(code, 200);
    assert_eq!(body["id"], "active-managed");
    assert_eq!(body["status"], "completed");
    assert_eq!(
        body["output"][0]["content"][0]["text"],
        "uncached connection probe"
    );
}

#[test]
fn published_outcome_locked_provider_restore() {
    published_outcome(false, true);
}

#[test]
fn published_outcome_unlocked_provider_restore() {
    published_outcome(false, false);
}

#[test]
fn published_outcome_locked_readiness() {
    published_outcome(true, true);
}

fn published_outcome(valid_restore: bool, lock_status: bool) {
    use std::os::unix::fs::OpenOptionsExt;
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state = root.path().join("state");
    let provider = ActiveProvider::start();
    provider
        .fail
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let (config, ports) = managed_lifetime_config(&root, "127.0.0.1", provider.port);
    let process = p0_start(&root, &state, &config);
    let instance = single_instance_dir(&state);
    let predecessor = managed_control(&instance);
    let socket = managed_socket(&predecessor);
    let fifo = root.path().join("restore.fifo");
    assert!(Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap()
        .success());
    // Keep publication behind namespace acquisition while substituting the
    // fixture FIFO for this native restart's real checkpoint file.
    let namespace = namespace_lock(&root);
    let control = p0_control_stream(&predecessor);
    writeln!(
        &control,
        "{}",
        serde_json::json!({"schema_version":1,
        "instance_id":predecessor["instance_id"], "start_nonce":predecessor["start_nonce"],
        "operation":"restart"})
    )
    .unwrap();
    let handoff = instance.join("provider-handoff.json");
    let deadline = Instant::now() + Duration::from_secs(6);
    while !handoff.is_file() && Instant::now() < deadline {
        sleep(Duration::from_millis(2));
    }
    let restore = fs::read(&handoff).unwrap();
    fs::rename(&fifo, &handoff).unwrap();
    drop(namespace);
    let mut writer = loop {
        match fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&handoff)
        {
            Ok(file) => break file,
            Err(_) if Instant::now() < deadline => sleep(Duration::from_millis(5)),
            Err(error) => panic!("successor did not open its restore FIFO: {error}"),
        }
    };
    drop(control);
    let paths = ["a", "b"]
        .map(|id| routecodex_v3_config::v3_active_key_control_paths(&config, id).unwrap());
    let rt = runtime();
    let controls_work = || {
        paths.iter().all(|p| {
            p.read()
                .ok()
                .and_then(|b| endpoint(&b))
                .is_some_and(|addr| {
                    matches!(http(&rt, addr, "GET", STATUS_PATH, None), Ok((200, _)))
                })
        })
    };
    let published = controls_work();
    let endpoints = paths
        .each_ref()
        .map(|p| endpoint(&p.read().unwrap()).unwrap());
    let status_path = instance.join("status.json");
    let status = fs::read(&status_path).unwrap();
    let cache_path = instance.join("pid.cache");
    let front_path = instance.join("front-handoff.json");
    let cache = fs::read(&cache_path).unwrap();
    let front = fs::read(&front_path).unwrap();
    let control_bytes = fs::read(instance.join("control.json")).unwrap();
    let status_lock = fs::File::open(instance.join("status.lock")).unwrap();
    if lock_status {
        status_lock.lock().unwrap();
    }
    if valid_restore {
        writer.write_all(&restore).unwrap();
    } else {
        // Keep the same malformed regular checkpoint on disk for fresh recovery.
        fs::remove_file(&handoff).unwrap();
        fs::write(&handoff, b"{").unwrap();
        writer.write_all(b"{").unwrap();
    }
    drop(writer);
    let exited = wait_for_explicit_pid_exit(process.pid.into(), Duration::from_secs(6));
    let log = fs::read_to_string(instance.join("server.log")).unwrap();
    let locked_status = fs::read(&status_path).unwrap();
    let failed_control = fs::read(instance.join("control.json")).ok();
    let retained = fs::read(&front_path).as_ref().ok() == Some(&front)
        && fs::read(&cache_path).as_ref().ok() == Some(&cache);
    let released = paths.iter().all(|p| !p.record.exists())
        && endpoints
            .iter()
            .all(|addr| TcpStream::connect(addr).is_err())
        && ports
            .iter()
            .all(|p| TcpStream::connect(("127.0.0.1", *p)).is_err());
    drop(status_lock);
    drop(process);
    let mut preserved = false;
    if retained {
        let provider_checkpoint = fs::read(&handoff).ok();
        let mut wrong: Value = serde_json::from_slice(&cache).unwrap();
        wrong["retained_control"]["start_nonce"] = serde_json::json!("fixture-other-generation");
        let wrong = serde_json::to_vec(&wrong).unwrap();
        fs::write(&cache_path, &wrong).unwrap();
        let refused = isolated_lifetime_command(&root, &state, &config, "restart");
        preserved = !refused.status.success()
            && fs::read(&front_path).ok().as_ref() == Some(&front)
            && fs::read(&cache_path).ok().as_ref() == Some(&wrong)
            && fs::read(instance.join("control.json")).ok() == failed_control
            && fs::read(&status_path).ok().as_ref() == Some(&locked_status)
            && fs::read(&handoff).ok() == provider_checkpoint
            && paths.iter().all(|p| !p.record.exists());
        fs::write(&cache_path, &cache).unwrap();
    }
    let fresh = isolated_lifetime_command(&root, &state, &config, "restart");
    let usable = fresh.status.success() && controls_work();
    let business = usable.then(|| {
        http(
            &rt,
            ([127, 0, 0, 1], ports[0]).into(),
            "POST",
            "/v1/responses",
            Some(business_body()),
        )
    });
    let fresh_pid = fs::read(&cache_path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|c| c["pid"].as_u64());
    let stop = isolated_lifetime_command(&root, &state, &config, "stop");
    let closed = fresh_pid
        .is_none_or(|pid| wait_for_explicit_pid_exit(pid, Duration::from_secs(6)))
        && ports
            .iter()
            .all(|p| TcpStream::connect(("127.0.0.1", *p)).is_err())
        && paths.iter().all(|p| !p.record.exists())
        && !socket.exists();
    drop(rt);
    drop(provider);
    root.close().unwrap();
    eprintln!("post-publication fixture {state:?}: successor exited={exited}, controls released={released}, retained={retained}, refused wrong proof={preserved}, recovered PID={fresh_pid:?}, closed={closed}");
    assert!(closed);
    assert!(published && exited && released);
    assert_eq!(
        serde_json::from_slice::<Value>(&status).unwrap()["state"],
        "starting"
    );
    if lock_status {
        assert_eq!(failed_control.as_ref(), Some(&control_bytes));
        assert_eq!(locked_status, status);
        assert!(
            log.lines()
                .any(|line| line.contains("status write failed after")
                    && if valid_restore {
                        line.matches("status file lock").count() == 2
                    } else {
                        line.contains("state JSON failed") && line.contains("status file lock")
                    }),
            "{log}"
        );
    } else {
        let failed: Value = serde_json::from_slice(&locked_status).unwrap();
        assert_eq!(failed["state"], "failed");
        assert!(failed["detail"]
            .as_str()
            .unwrap()
            .contains("state JSON failed"));
    }
    assert!(
        retained && fresh.status.success(),
        "retained={retained}, formal restart: {}",
        String::from_utf8_lossy(&fresh.stderr)
    );
    assert!(preserved && usable && stop.status.success());
    let (code, body) = business.unwrap().unwrap();
    assert_eq!(code, 200);
    assert_eq!(body["id"], "active-managed");
    assert_eq!(body["status"], "completed");
    assert_eq!(
        body["output"][0]["content"][0]["text"],
        "uncached connection probe"
    );
}

#[test]
fn exact_custody_child_exits_with_sample_lock_and_failed_artifact_reduction() {
    use std::os::unix::fs::OpenOptionsExt;
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state = root.path().join("state");
    let home = root.path().join("home");
    let provider = ActiveProvider::start();
    provider
        .fail
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let (config, ports) = managed_lifetime_config(&root, "127.0.0.1", provider.port);
    let binary = env!("CARGO_BIN_EXE_rccv3");
    let (declaration, _) =
        routecodex_v3_lifecycle::V3ManagedLifecycle::with_state_root(&config, &state)
            .declaration(binary)
            .unwrap();
    let instance = state.join("instances").join(&declaration.instance_id);
    fs::create_dir_all(&instance).unwrap();
    fs::write(
        instance.join("instance.json"),
        serde_json::to_vec(&declaration).unwrap(),
    )
    .unwrap();
    let handoff = instance.join("provider-handoff.json");
    assert!(Command::new("mkfifo")
        .arg(&handoff)
        .status()
        .unwrap()
        .success());
    let samples = home.join(".rcc/codex-samples");
    fs::create_dir_all(&samples).unwrap();
    let lock_path = samples.join(".retention.lock");
    let sample_lock = fs::File::create(&lock_path).unwrap();
    let mut child = managed_test_command(binary, &state)
        .args(["server", "run-managed-child", "--snapall", "--config"])
        .arg(&config)
        .env("HOME", &home)
        .env("ROUTECODEX_V3_STATE_DIR", &state)
        .env(
            "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
            request_counter_file(&state),
        )
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut writer = loop {
        match fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&handoff)
        {
            Ok(writer) => break writer,
            Err(error) => {
                if child.try_wait().unwrap().is_some() || Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("child did not reach provider restore: {error}");
                }
                sleep(Duration::from_millis(10));
            }
        }
    };
    let paths = ["a", "b"]
        .map(|id| routecodex_v3_config::v3_active_key_control_paths(&config, id).unwrap());
    let prior = fs::read(instance.join("front-handoff.json")).unwrap();
    sample_lock.lock().unwrap();
    let authority = fs::read(instance.join("pid.cache")).unwrap();
    let child_socket = managed_socket(&managed_control(&instance));
    let records = paths.each_ref().map(|p| p.read().unwrap());
    let rt = runtime();
    let addr = ([127, 0, 0, 1], ports[0]).into();
    let accepted = http(&rt, addr, "POST", "/v1/responses", Some(business_body()));
    // The child has the queue's real retention file open while our distinct
    // process owns its exclusive lock. No sample can complete this write.
    let stall_deadline = Instant::now() + Duration::from_secs(3);
    let stalled = loop {
        let output = Command::new("lsof")
            .args(["-a", "-p", &child.id().to_string()])
            .arg(&lock_path)
            .output()
            .unwrap();
        if output.status.success() {
            break true;
        }
        if Instant::now() >= stall_deadline {
            break false;
        }
        sleep(Duration::from_millis(20));
    };
    let namespace = namespace_lock(&root);
    let temp = instance.join(format!("front-handoff.tmp-{}", child.id()));
    fs::create_dir(&temp).unwrap();
    // A directory at the destination rejects the real Running status rename.
    // Take the status writer lock afterwards so Failed can publish normally.
    let status_temp = instance.join(format!("status.tmp-{}", child.id()));
    let status_path = instance.join("status.json");
    let starting = instance.join("fixture-starting-status");
    fs::rename(&status_path, &starting).unwrap();
    fs::create_dir(&status_path).unwrap();
    writer.write_all(b"[]").unwrap();
    drop(writer);
    let ready_deadline = Instant::now() + Duration::from_secs(4);
    let ready_bytes = loop {
        let bytes = fs::read(&status_temp).unwrap_or_default();
        if bytes.contains(&b'\n') || Instant::now() >= ready_deadline {
            break bytes;
        }
        sleep(Duration::from_millis(5));
    };
    let status_lock = fs::File::open(instance.join("status.lock")).unwrap();
    status_lock.lock().unwrap();
    fs::remove_dir(&status_path).unwrap();
    fs::rename(starting, &status_path).unwrap();
    drop(status_lock);
    let bounded = wait_for_child_exit(&mut child, Duration::from_secs(6));
    let status: Value =
        serde_json::from_slice(&fs::read(instance.join("status.json")).unwrap_or_default())
            .unwrap_or(Value::Null);
    let retained = fs::read(instance.join("front-handoff.json")).ok();
    let generation = fs::read(instance.join("pid.cache")).ok();
    drop(sample_lock);
    drop(namespace);
    if !bounded {
        child.kill().unwrap();
    }
    let code = child.wait().unwrap();
    let unchanged = paths
        .iter()
        .zip(&records)
        .all(|(p, b)| p.read().ok().as_ref() == Some(b));
    if handoff.exists() {
        fs::remove_file(handoff).unwrap();
    }
    fs::remove_dir(temp).unwrap();
    let fresh = isolated_lifetime_command(&root, &state, &config, "start");
    let fresh_control = http(&rt, addr, "GET", STATUS_PATH, None);
    let business = http(&rt, addr, "POST", "/v1/responses", Some(business_body()));
    let fresh_pid = fs::read(instance.join("pid.cache"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|c| c["pid"].as_u64());
    let stop = isolated_lifetime_command(&root, &state, &config, "stop");
    let exited =
        fresh_pid.is_some_and(|pid| wait_for_explicit_pid_exit(pid, Duration::from_secs(8)));
    let closed = ports
        .iter()
        .all(|p| TcpStream::connect(("127.0.0.1", *p)).is_err())
        && paths.iter().all(|p| !p.record.exists())
        && !child_socket.exists();
    if child_socket.exists() && (fresh_pid.is_none() || exited) {
        fs::remove_file(child_socket).unwrap();
    }
    drop(provider);
    root.close().unwrap();
    assert_eq!(accepted.unwrap().0, 200);
    assert_eq!(
        serde_json::from_slice::<Value>(&ready_bytes).unwrap()["state"],
        "running"
    );
    assert!(
        stalled && bounded && !code.success(),
        "sample stalled={stalled}, exited before unlock={bounded}, status={status}"
    );
    assert_eq!(status["state"], "failed");
    let detail = status["detail"].as_str().unwrap();
    assert!(
        detail.contains("managed lifecycle IO failed")
            && detail.contains("persistence shutdown timed out")
            && detail.contains("disposition write failed"),
        "{detail}"
    );
    assert!(unchanged && retained == Some(prior) && generation == Some(authority));
    assert!(fresh.status.success() && stop.status.success() && exited && closed);
    assert_eq!(fresh_control.unwrap().0, 200);
    assert_eq!(business.unwrap().0, 200);
}

#[test]
fn exact_custody_terminal_contention_recovers_successor_and_preserves_foreign_leaf() {
    let _guard = lifecycle_test_guard();
    for fail_reduction in [false, true] {
        let root = TempDir::new().unwrap();
        let state = root.path().join("state");
        let provider = ActiveProvider::start();
        provider
            .fail
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let (config, ports) = managed_lifetime_config(&root, "127.0.0.1", provider.port);
        let process = p0_start(&root, &state, &config);
        let instance = single_instance_dir(&state);
        let load = |file: &str| -> Option<Value> {
            serde_json::from_slice(&fs::read(instance.join(file)).ok()?).ok()
        };
        let old = load("pid.cache").unwrap();
        let invoke = |op| isolated_lifetime_command(&root, &state, &config, op);
        let restart = invoke("restart");
        let successor = load("pid.cache").unwrap();
        let paths = ["a", "b"]
            .map(|id| routecodex_v3_config::v3_active_key_control_paths(&config, id).unwrap());
        let published = paths.each_ref().map(|p| p.read().unwrap());
        let rt = runtime();
        let usable = published.iter().all(|b| {
            matches!(
                http(&rt, endpoint(b).unwrap(), "GET", STATUS_PATH, None),
                Ok((200, _))
            )
        });
        let holder = namespace_lock(&root);
        let prior = fs::read(instance.join("front-handoff.json")).ok();
        let reduction_temp = instance.join(format!("front-handoff.tmp-{}", process.pid));
        if fail_reduction {
            fs::create_dir(&reduction_temp).unwrap();
        }
        let stop = invoke("stop");
        let exited = wait_for_explicit_pid_exit(process.pid.into(), Duration::from_secs(8));
        let retained = load("front-handoff.json");
        let authority = load("pid.cache");
        let stopped_detail =
            load("status.json").and_then(|s| s["detail"].as_str().map(str::to_owned));
        let after_close = fs::read(instance.join("front-handoff.json")).ok();
        if fail_reduction {
            fs::remove_dir(reduction_temp).unwrap();
        }
        drop(holder);
        let unchanged = paths
            .iter()
            .zip(&published)
            .all(|(p, b)| p.read().ok().as_ref() == Some(b));
        let mut replacement: Value = serde_json::from_slice(&published[0]).unwrap();
        replacement["owner_pid"] = serde_json::json!(std::process::id());
        let foreign = serde_json::to_vec(&replacement).unwrap();
        paths[0]
            .with_write(|tx| {
                tx.remove()?;
                tx.publish(&foreign, || {})
            })
            .unwrap();
        let fresh = invoke("start");
        let fresh_cache = load("pid.cache");
        let status = load("status.json");
        let business_addr = ([127, 0, 0, 1], ports[0]).into();
        let business = http(
            &rt,
            business_addr,
            "POST",
            "/v1/responses",
            Some(business_body()),
        );
        let fresh_b = paths[1].read().ok();
        let final_stop = invoke("stop");
        let fresh_exited = fresh_cache
            .as_ref()
            .and_then(|c| c["pid"].as_u64())
            .is_some_and(|pid| wait_for_explicit_pid_exit(pid, Duration::from_secs(8)));
        let preserved = paths[0].read().ok().as_ref() == Some(&foreign);
        let cleared = !paths[1].record.exists() && !instance.join("front-handoff.json").exists();
        let sockets_closed = ports
            .iter()
            .all(|p| TcpStream::connect(("127.0.0.1", *p)).is_err());
        drop(process);
        drop(provider);
        root.close().unwrap();
        assert!(restart.status.success() && usable && stop.status.success() && exited && unchanged);
        assert_eq!(old["pid"], successor["pid"]);
        assert_eq!(old["process_start_token"], successor["process_start_token"]);
        assert_ne!(old["start_nonce"], successor["start_nonce"]);
        assert_eq!(
            authority.as_ref(),
            Some(&successor),
            "exited successor lost generation evidence"
        );
        if fail_reduction {
            assert_eq!(after_close, prior);
            assert!(stopped_detail
                .unwrap_or_default()
                .contains("disposition write failed"));
        }
        assert_eq!(
            retained.unwrap()["controls"]["records"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(
            fresh.status.success(),
            "{}",
            String::from_utf8_lossy(&fresh.stderr)
        );
        assert!(status.unwrap()["detail"]
            .as_str()
            .unwrap_or_default()
            .contains("control conflict"));
        assert!(
            preserved && cleared && sockets_closed && final_stop.status.success() && fresh_exited
        );
        assert_eq!(business.unwrap().0, 200);
        assert_eq!(
            serde_json::from_slice::<Value>(&fresh_b.unwrap()).unwrap()["owner_pid"],
            fresh_cache.unwrap()["pid"]
        );
    }
}

#[test]
fn removed_port_retries_exact_retained_cleanup() {
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state = root.path().join("state");
    let provider = P0Provider::start();
    let (config, ports) = managed_lifetime_config(&root, "127.0.0.1", provider.port);
    let process = p0_start(&root, &state, &config);
    let previous_instance = single_instance_dir(&state);
    let previous_control = managed_control(&previous_instance);
    let [a, b] = ports.map(|p| std::net::SocketAddr::from(([127, 0, 0, 1], p)));
    let path_a = routecodex_v3_config::v3_active_key_control_paths(&config, "a").unwrap();
    let path_b = routecodex_v3_config::v3_active_key_control_paths(&config, "b").unwrap();
    let old_a = path_a.read().unwrap();
    let original = fs::read_to_string(&config).unwrap();
    let start = original.find("[servers.a]").unwrap();
    let end = original.find("[servers.b]").unwrap();
    let execution_start = original.find("[servers.a.execution]").unwrap();
    let execution_end = original.find("[servers.b.execution]").unwrap();
    fs::write(
        &config,
        format!(
            "{}{}{}",
            &original[..start],
            &original[end..execution_start],
            &original[execution_end..]
        ),
    )
    .unwrap();
    let holder = namespace_lock(&root);
    // The CLI's previous-release adapter requires an identical listener set.
    // The authenticated same-generation control plan supports a declaration change.
    let binary = env!("CARGO_BIN_EXE_rccv3");
    let (declaration, _) =
        routecodex_v3_lifecycle::V3ManagedLifecycle::with_state_root(&config, &state)
            .declaration(binary)
            .unwrap();
    fs::write(
        previous_instance.join("restart.plan.json"),
        serde_json::to_vec(&serde_json::json!({
            "schema_version":1, "instance_id":previous_control["instance_id"],
            "start_nonce":previous_control["start_nonce"], "executable_path":binary,
            "target_declaration":declaration, "snapshots":false, "snapshot_direct":false,
            "snapshot_stages":null, "sse_dump":false
        }))
        .unwrap(),
    )
    .unwrap();
    let current_instance = state.join("instances").join(&declaration.instance_id);
    let mut stream = p0_control_stream(&previous_control);
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    writeln!(
        stream,
        "{}",
        serde_json::json!({"schema_version":1,
        "instance_id":previous_control["instance_id"],"start_nonce":previous_control["start_nonce"],
        "operation":"restart"})
    )
    .unwrap();
    let mut exec_reply = String::new();
    let exec_closed = BufReader::new(stream).read_line(&mut exec_reply);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !current_instance.join("control.json").exists() && Instant::now() < deadline {
        sleep(Duration::from_millis(20));
    }
    if !current_instance.join("control.json").exists() {
        drop(holder);
        drop(process);
        drop(provider);
        root.close().unwrap();
        panic!("native declaration change did not publish the successor control: {exec_closed:?} {exec_reply}");
    }
    let control = managed_control(&current_instance);
    let child_ready = status_json(binary, &state, &config);
    let retained_front = fs::read(current_instance.join("front-handoff.json"));
    let rt = runtime();
    let live_b = http(&rt, b, "POST", "/v1/responses", Some(business_body()));
    drop(holder);
    let retained = path_a.read().ok();
    let foreign = free_port();
    let rejected = release_set(&control, &[b.port(), foreign]);
    let retried = release(&control, a.port());
    let a_record_absent = path_a
        .read()
        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound);
    let b_after = http(&rt, b, "POST", "/v1/responses", Some(business_body()));
    let control_b = http(&rt, b, "GET", STATUS_PATH, None);
    let stop = release(&control, b.port());
    let exited = wait_for_explicit_pid_exit(process.pid.into(), Duration::from_secs(2));
    let records_closed = [&path_a, &path_b]
        .iter()
        .all(|path| matches!(path.read(), Err(e) if e.kind() == std::io::ErrorKind::NotFound));
    let sockets_closed = [a, b]
        .iter()
        .all(|address| TcpStream::connect(address).is_err())
        && !managed_socket(&previous_control).exists()
        && !managed_socket(&control).exists();
    let custody_closed = !current_instance.join("front-handoff.json").exists();
    drop(process);
    drop(provider);
    root.close().unwrap();
    eprintln!("cleanup removed port: normal exit={exited} sockets={sockets_closed} records={records_closed}; remaining PID cleaned by fixture guard");
    assert!(
        matches!(exec_closed, Ok(0)) && child_ready["state"] == "running",
        "{exec_reply} {child_ready}"
    );
    assert_eq!(live_b.unwrap().0, 200);
    assert_eq!(retained.as_ref(), Some(&old_a));
    assert!(
        retained_front.is_ok(),
        "contention must preserve exact startup custody"
    );
    assert_eq!(rejected["accepted"], false);
    assert_eq!(b_after.unwrap().0, 200);
    assert_eq!(control_b.unwrap().0, 200);
    assert_eq!(
        retried["accepted"], true,
        "removed port exact retained owner was rejected: {retried}"
    );
    assert!(a_record_absent);
    assert!(
        exited && records_closed && sockets_closed && custody_closed && stop["accepted"] == true
    );
}
impl ActiveProvider {
    fn finish_quiescent(&mut self, generation_closed: bool) -> std::io::Result<()> {
        self.retire(generation_closed)?;
        match TcpStream::connect(("127.0.0.1", self.port)) {
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => Ok(()),
            result => Err(std::io::Error::other(format!(
                "expected recorder refusal on {}: {result:?}",
                self.port
            ))),
        }
    }

    fn retire(&mut self, generation_closed: bool) -> std::io::Result<()> {
        if self.recorder_panicked {
            return Err(std::io::Error::other(
                "controlled Provider recorder panicked",
            ));
        }
        if self.task.is_none() {
            return Ok(());
        }
        if !self.producers_ended || (self.pending_request && !generation_closed) {
            return Err(std::io::Error::other(format!(
                "issued request unresolved after exact cleanup; recorder quiescence unproved at {}",
                self.port
            )));
        }
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if self.task.take().is_some_and(|task| task.join().is_err()) {
            self.recorder_panicked = true;
            return Err(std::io::Error::other(
                "controlled Provider recorder panicked",
            ));
        }
        Ok(())
    }
}

impl Drop for ActiveProvider {
    fn drop(&mut self) {
        if self.retire(false).is_err() && !std::thread::panicking() {
            panic!("controlled active Provider failed");
        }
    }
}

fn release(control: &Value, port: u16) -> Value {
    release_set(control, &[port])
}

fn release_set(control: &Value, ports: &[u16]) -> Value {
    let mut stream = p0_control_stream(control);
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    writeln!(
        stream,
        "{}",
        serde_json::json!({"schema_version":1,"instance_id":control["instance_id"],
        "start_nonce":control["start_nonce"],"operation":"release_ports","ports":ports})
    )
    .unwrap();
    stream.shutdown(std::net::Shutdown::Write).unwrap();
    let mut body = String::new();
    BufReader::new(stream).read_line(&mut body).unwrap();
    serde_json::from_str(&body).unwrap()
}

pub(super) fn http(
    runtime: &tokio::runtime::Runtime,
    address: std::net::SocketAddr,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<(u16, Value), String> {
    runtime.block_on(async {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let mut request =
            client.request(method.parse().unwrap(), format!("http://{address}{path}"));
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let body = response.json().await.map_err(|e| e.to_string())?;
        Ok((status, body))
    })
}

fn write_active_config(
    root: &TempDir,
    bind: std::net::IpAddr,
    ports: [u16; 2],
    provider_port: u16,
    admin: bool,
) -> PathBuf {
    let config = root.path().join("managed-active-control.v3.toml");
    let admin = if admin {
        format!(
            "[admin_webui]\nenabled=true\nbind=\"127.0.0.1\"\nport={}\n",
            free_port()
        )
    } else {
        String::new()
    };
    fs::write(
        &config,
        format!(
            r#"version=3
{HUB_V1_TEST_DECLARATION}
{admin}
[features]
responses_direct=true
[servers.a]
bind="{bind}"
port={}
routing_group="default"
[servers.b]
bind="{bind}"
port={}
routing_group="default"
{HUB_V1_TEST_SERVER_EXECUTION}
[providers.test]
type="responses"
base_url="http://127.0.0.1:{}/v1"
default_model="test"
auth={{type="api_key",entries=[{{alias="key",env="V3_MANAGED_TEST_KEY"}}]}}
[providers.test.models.test]
wire_name="wire-test"
capabilities=["text"]
supports_streaming=true
[route_groups.default.pools.default]
selection={{strategy="active_queue"}}
active_keys={{members=[{{provider="test",alias="key"}}],retries=3,on_failure="hold"}}
targets=[{{kind="provider_model",provider="test",model="test",key="key",priority=1}}]
"#,
            ports[0], ports[1], provider_port
        ),
    )
    .unwrap();
    config
}

#[test]
fn managed_release_reports_control_timeout_and_retries_only_the_selected_owner() {
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state = root.path().join("state");
    let provider = P0Provider::start();
    let route = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
    route.connect("192.0.2.1:9").unwrap();
    let bind = route.local_addr().unwrap().ip();
    assert!(!bind.is_loopback() && !bind.is_unspecified());
    let a = std::net::TcpListener::bind((bind, 0)).unwrap();
    let b = std::net::TcpListener::bind((bind, 0)).unwrap();
    let ports = [
        a.local_addr().unwrap().port(),
        b.local_addr().unwrap().port(),
    ];
    drop(a);
    drop(b);
    assert!(!ports.iter().any(|p| [4444, 7777].contains(p)));
    let config = write_active_config(&root, bind, ports, provider.port, true);
    let process = p0_start(&root, &state, &config);
    let owner = single_instance_dir(&state);
    let control: Value =
        serde_json::from_slice(&fs::read(owner.join("control.json")).unwrap()).unwrap();
    let selected = routecodex_v3_config::v3_active_key_control_paths(&config, "a").unwrap();
    let peer = routecodex_v3_config::v3_active_key_control_paths(&config, "b").unwrap();
    let selected_record: Value = serde_json::from_slice(&selected.read().unwrap()).unwrap();
    let peer_bytes = peer.read().unwrap();
    let peer_record: Value = serde_json::from_slice(&peer_bytes).unwrap();
    let selected_control: std::net::SocketAddr = selected_record["control_addr"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let peer_control: std::net::SocketAddr = peer_record["control_addr"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let holder = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.path().join(".active-key-control.lock"))
        .unwrap();
    holder.lock().unwrap();
    let failed = release(&control, ports[0]);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let peer_business = http(
        &runtime,
        std::net::SocketAddr::new(bind, ports[1]),
        "POST",
        "/v1/responses",
        Some(
            serde_json::json!({"model":"test","input":"uncached connection probe","stream":false}),
        ),
    );
    let peer_status = http(
        &runtime,
        peer_control,
        "GET",
        "/_routecodex/selection/active-keys",
        None,
    );
    drop(holder);
    let pending_record = selected.read();
    let retried = release(&control, ports[0]);
    let selected_removed =
        matches!(selected.read(),Err(e) if e.kind()==std::io::ErrorKind::NotFound);
    let old_control_closed = TcpStream::connect(selected_control).is_err();
    let peer_after = peer.read();
    let peer_release = http(
        &runtime,
        peer_control,
        "POST",
        "/_routecodex/selection/active-keys/release",
        Some(
            serde_json::json!({"routing_group_id":"default","pool_id":"default","provider_id":"test",
            "interface_id":"default","model_id":"test","auth_alias":"key"}),
        ),
    );
    let stopped = run(env!("CARGO_BIN_EXE_rccv3"), &state, &config, "stop");
    let pid_closed = wait_for_explicit_pid_exit(process.pid.into(), Duration::from_secs(10));
    let all_closed = [
        std::net::SocketAddr::new(bind, ports[0]),
        std::net::SocketAddr::new(bind, ports[1]),
        selected_control,
        peer_control,
    ]
    .into_iter()
    .all(|address| TcpStream::connect(address).is_err());
    let records_closed = matches!(selected.read(),Err(e) if e.kind()==std::io::ErrorKind::NotFound)
        && matches!(peer.read(),Err(e) if e.kind()==std::io::ErrorKind::NotFound);
    drop(process);
    assert!(
        stopped.status.success() && pid_closed && all_closed && records_closed,
        "managed fixture must release exact owned processes, sockets and records"
    );
    assert_eq!(
        failed["accepted"], false,
        "cleanup timeout must not acknowledge complete release"
    );
    assert!(
        pending_record.is_ok(),
        "failed cleanup stays explicitly owned for retry"
    );
    assert_eq!(
        peer_business.unwrap().0,
        200,
        "peer business must progress during control contention"
    );
    assert_eq!(peer_status.unwrap().0, 200, "peer control stays live");
    assert_eq!(
        retried["accepted"], true,
        "same requested port must retry its retained owner"
    );
    assert!(selected_removed && old_control_closed);
    assert_eq!(
        peer_after.unwrap(),
        peer_bytes,
        "partial release must preserve the peer owner"
    );
    assert_eq!(
        peer_release.unwrap().0,
        200,
        "peer exact release remains usable"
    );
}

#[test]
fn actual_managed_restart_replaces_active_control_records() {
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state = root.path().join("state");
    let provider = ActiveProvider::start();
    let route = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
    route.connect("192.0.2.1:9").unwrap();
    let bind = route.local_addr().unwrap().ip();
    let a = std::net::TcpListener::bind((bind, 0)).unwrap();
    let b = std::net::TcpListener::bind((bind, 0)).unwrap();
    let ports = [
        a.local_addr().unwrap().port(),
        b.local_addr().unwrap().port(),
    ];
    drop(a);
    drop(b);
    assert!(!ports.iter().any(|p| [4444, 7777].contains(p)));
    let config = write_active_config(&root, bind, ports, provider.port, true);
    let process = p0_start(&root, &state, &config);
    let paths = [
        routecodex_v3_config::v3_active_key_control_paths(&config, "a").unwrap(),
        routecodex_v3_config::v3_active_key_control_paths(&config, "b").unwrap(),
    ];
    let original: Vec<Vec<u8>> = paths.iter().map(|p| p.read().unwrap()).collect();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let initial: Value = serde_json::from_slice(&original[0]).unwrap();
    let initial_control = initial["control_addr"].as_str().unwrap().parse().unwrap();
    for _ in 0..4 {
        let _ = http(
            &runtime,
            std::net::SocketAddr::new(bind, ports[0]),
            "POST",
            "/v1/responses",
            Some(
                serde_json::json!({"model":"test","input":"uncached connection probe","stream":false}),
            ),
        );
    }
    let held_before = http(
        &runtime,
        initial_control,
        "GET",
        "/_routecodex/selection/active-keys",
        None,
    );
    provider
        .fail
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let restarted = run(env!("CARGO_BIN_EXE_rccv3"), &state, &config, "restart");
    let current: Vec<_> = paths.iter().map(|p| p.read()).collect();
    let controls: Vec<_> = current
        .iter()
        .map(|r| {
            r.as_ref()
                .ok()
                .and_then(|b| serde_json::from_slice::<Value>(b).ok())
                .and_then(|r| {
                    r["control_addr"]
                        .as_str()
                        .and_then(|s| s.parse::<std::net::SocketAddr>().ok())
                })
        })
        .collect();
    let statuses: Vec<_> = controls
        .iter()
        .map(|address| {
            address.map(|a| {
                http(
                    &runtime,
                    a,
                    "GET",
                    "/_routecodex/selection/active-keys",
                    None,
                )
            })
        })
        .collect();
    let released=controls[0].map(|address|http(&runtime,address,"POST","/_routecodex/selection/active-keys/release",
        Some(serde_json::json!({"routing_group_id":"default","pool_id":"default","provider_id":"test",
            "interface_id":"default","model_id":"test","auth_alias":"key"}))));
    let business = http(
        &runtime,
        std::net::SocketAddr::new(bind, ports[0]),
        "POST",
        "/v1/responses",
        Some(
            serde_json::json!({"model":"test","input":"uncached connection probe","stream":false}),
        ),
    );
    let stopped = run(env!("CARGO_BIN_EXE_rccv3"), &state, &config, "stop");
    let pid_closed = wait_for_explicit_pid_exit(process.pid.into(), Duration::from_secs(10));
    let residual: Vec<_> = paths.iter().map(|p| p.read().ok()).collect();
    // Preserve actual residual evidence, then recover only these exact fixture-owned bytes.
    for (index, bytes) in residual.iter().enumerate() {
        if let Some(expected) = bytes {
            paths[index]
                .with_write(|tx| {
                    assert_eq!(
                        tx.read()?,
                        *expected,
                        "fixture recovery must compare complete bytes"
                    );
                    tx.remove()?;
                    tx.prune_empty()
                })
                .unwrap();
        }
    }
    let all_closed = ports
        .iter()
        .all(|p| TcpStream::connect((bind, *p)).is_err())
        && controls
            .iter()
            .flatten()
            .all(|a| TcpStream::connect(a).is_err());
    let records_absent = paths
        .iter()
        .all(|p| matches!(p.read(),Err(e) if e.kind()==std::io::ErrorKind::NotFound));
    drop(process);
    assert!(
        stopped.status.success() && pid_closed && all_closed && records_absent,
        "all managed fixture resources must close before assertions"
    );
    assert!(
        restarted.status.success(),
        "{}",
        String::from_utf8_lossy(&restarted.stderr)
    );
    assert!(
        statuses.iter().all(|s| matches!(s, Some(Ok((200, _))))),
        "actual exec left stale control records: {statuses:?}"
    );
    assert_eq!(
        held_before.unwrap().1["pools"][0]["held"][0]["auth_alias"],
        "key"
    );
    assert_eq!(
        statuses[0].as_ref().unwrap().as_ref().unwrap().1["pools"][0]["held"][0]["auth_alias"],
        "key",
        "actual restart must preserve the hold"
    );
    assert_eq!(
        statuses[1].as_ref().unwrap().as_ref().unwrap().1["pools"][0]["held"],
        serde_json::json!([]),
        "peer listener must retain independent selection state"
    );
    assert_eq!(released.unwrap().unwrap().1["released"], true);
    assert_eq!(
        business.unwrap().0,
        200,
        "actual release after restart must restore business dispatch"
    );
    assert!(provider.failures.load(std::sync::atomic::Ordering::SeqCst) >= 4);
    assert!(
        residual.iter().all(Option::is_none),
        "managed stop must not leave stale predecessor records"
    );
}

#[test]
fn managed_active_controls_receive_declared_config_without_admin() {
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state = root.path().join("state");
    let provider = P0Provider::start();
    let route = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
    route.connect("192.0.2.1:9").unwrap();
    let bind = route.local_addr().unwrap().ip();
    let a = std::net::TcpListener::bind((bind, 0)).unwrap();
    let b = std::net::TcpListener::bind((bind, 0)).unwrap();
    let ports = [
        a.local_addr().unwrap().port(),
        b.local_addr().unwrap().port(),
    ];
    drop(a);
    drop(b);
    assert!(!ports.iter().any(|p| [4444, 7777].contains(p)));
    let config = write_active_config(&root, bind, ports, provider.port, false);
    let process = p0_start(&root, &state, &config);
    let paths = [
        routecodex_v3_config::v3_active_key_control_paths(&config, "a").unwrap(),
        routecodex_v3_config::v3_active_key_control_paths(&config, "b").unwrap(),
    ];
    let records: Vec<_> = paths.iter().map(|p| p.read()).collect();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let business = http(
        &runtime,
        std::net::SocketAddr::new(bind, ports[1]),
        "POST",
        "/v1/responses",
        Some(
            serde_json::json!({"model":"test","input":"uncached connection probe","stream":false}),
        ),
    );
    let stopped = run(env!("CARGO_BIN_EXE_rccv3"), &state, &config, "stop");
    let pid_closed = wait_for_explicit_pid_exit(process.pid.into(), Duration::from_secs(10));
    let all_closed = ports
        .iter()
        .all(|p| TcpStream::connect((bind, *p)).is_err());
    let records_closed = paths
        .iter()
        .all(|p| matches!(p.read(),Err(e) if e.kind()==std::io::ErrorKind::NotFound));
    drop(process);
    assert!(
        stopped.status.success() && pid_closed && all_closed && records_closed,
        "managed fixture must close before assertions"
    );
    assert_eq!(business.unwrap().0, 200);
    assert!(
        records.iter().all(Result::is_ok),
        "active controls need the declared canonical config independently of Admin: {records:?}"
    );
}

#[test]
fn cancelled_managed_exec_retains_original_active_controls_and_business() {
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state = root.path().join("state");
    let provider = P0Provider::start();
    let route = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
    route.connect("192.0.2.1:9").unwrap();
    let bind = route.local_addr().unwrap().ip();
    let a = std::net::TcpListener::bind((bind, 0)).unwrap();
    let b = std::net::TcpListener::bind((bind, 0)).unwrap();
    let ports = [
        a.local_addr().unwrap().port(),
        b.local_addr().unwrap().port(),
    ];
    drop(a);
    drop(b);
    assert!(!ports.iter().any(|p| [4444, 7777].contains(p)));
    let config = write_active_config(&root, bind, ports, provider.port, true);
    let process = p0_start(&root, &state, &config);
    let instance = single_instance_dir(&state);
    let control: Value =
        serde_json::from_slice(&fs::read(instance.join("control.json")).unwrap()).unwrap();
    let front_before =
        fs::read(instance.join("front-handoff.json")).map_err(|error| error.to_string());
    let paths = [
        routecodex_v3_config::v3_active_key_control_paths(&config, "a").unwrap(),
        routecodex_v3_config::v3_active_key_control_paths(&config, "b").unwrap(),
    ];
    let before: Vec<_> = paths.iter().map(|p| p.read().unwrap()).collect();
    let endpoint: Value = serde_json::from_slice(&before[0]).unwrap();
    let address: std::net::SocketAddr = endpoint["control_addr"].as_str().unwrap().parse().unwrap();
    let mut stream = p0_control_stream(&control);
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    writeln!(stream,"{}",serde_json::json!({"schema_version":1,"instance_id":control["instance_id"],"start_nonce":control["start_nonce"],"operation":"restart"})).unwrap();
    stream.shutdown(std::net::Shutdown::Write).unwrap();
    let mut body = String::new();
    let rejection = BufReader::new(stream)
        .read_line(&mut body)
        .map_err(|e| e.to_string())
        .and_then(|_| serde_json::from_str::<Value>(&body).map_err(|e| e.to_string()));
    let after: Vec<_> = paths.iter().map(|p| p.read().ok()).collect();
    let front_after =
        fs::read(instance.join("front-handoff.json")).map_err(|error| error.to_string());
    let current: Value =
        serde_json::from_slice(&fs::read(instance.join("control.json")).unwrap()).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let status = http(
        &runtime,
        address,
        "GET",
        "/_routecodex/selection/active-keys",
        None,
    );
    let release = http(
        &runtime,
        address,
        "POST",
        "/_routecodex/selection/active-keys/release",
        Some(
            serde_json::json!({"routing_group_id":"default","pool_id":"default","provider_id":"test","interface_id":"default","model_id":"test","auth_alias":"key"}),
        ),
    );
    let business = http(
        &runtime,
        std::net::SocketAddr::new(bind, ports[0]),
        "POST",
        "/v1/responses",
        Some(
            serde_json::json!({"model":"test","input":"uncached connection probe","stream":false}),
        ),
    );
    let artifacts_clear = !instance.join("exec-restart-declaration.json").exists()
        && !instance.join("provider-handoff.json").exists();
    let stopped = run(env!("CARGO_BIN_EXE_rccv3"), &state, &config, "stop");
    let pid_closed = wait_for_explicit_pid_exit(process.pid.into(), Duration::from_secs(10));
    let sockets_closed = ports
        .iter()
        .all(|p| TcpStream::connect((bind, *p)).is_err())
        && TcpStream::connect(address).is_err();
    let records_closed = paths
        .iter()
        .all(|p| matches!(p.read(),Err(e) if e.kind()==std::io::ErrorKind::NotFound));
    drop(process);
    assert!(
        stopped.status.success() && pid_closed && sockets_closed && records_closed,
        "all cancelled-exec fixture resources must close"
    );
    assert_eq!(rejection.unwrap()["accepted"], false);
    assert!(
        current["start_nonce"] == control["start_nonce"],
        "cancelled exec must retain original managed identity"
    );
    assert!(
        after
            .iter()
            .zip(&before)
            .all(|(now, old)| now.as_ref() == Some(old)),
        "cancelled exec must preserve exact original records"
    );
    assert_eq!(status.unwrap().0, 200);
    assert_eq!(release.unwrap().0, 200);
    assert!(
        front_before.is_ok(),
        "live controls must have durable cleanup authority before cancelled preparation"
    );
    assert_eq!(
        front_after, front_before,
        "cancelled exec must preserve the existing exact custody artifact"
    );
    assert_eq!(
        business.unwrap().0,
        200,
        "business must resume after cancelled preparation"
    );
    assert!(
        artifacts_clear,
        "cancelled restart must clean only its attempt artifacts"
    );
}

#[test]
fn contended_successor_reports_unavailable_controls_and_retains_exact_recovery() {
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state = root.path().join("state");
    let provider = P0Provider::start();
    let route = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
    route.connect("192.0.2.1:9").unwrap();
    let bind = route.local_addr().unwrap().ip();
    let a = std::net::TcpListener::bind((bind, 0)).unwrap();
    let b = std::net::TcpListener::bind((bind, 0)).unwrap();
    let ports = [
        a.local_addr().unwrap().port(),
        b.local_addr().unwrap().port(),
    ];
    drop(a);
    drop(b);
    assert!(!ports.iter().any(|p| [4444, 7777].contains(p)));
    let config = write_active_config(&root, bind, ports, provider.port, true);
    let process = p0_start(&root, &state, &config);
    let paths = [
        routecodex_v3_config::v3_active_key_control_paths(&config, "a").unwrap(),
        routecodex_v3_config::v3_active_key_control_paths(&config, "b").unwrap(),
    ];
    let original: Vec<_> = paths.iter().map(|p| p.read().unwrap()).collect();
    let holder = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.path().join(".active-key-control.lock"))
        .unwrap();
    holder.lock().unwrap();
    let first = run(env!("CARGO_BIN_EXE_rccv3"), &state, &config, "restart");
    let unavailable = status_json(env!("CARGO_BIN_EXE_rccv3"), &state, &config);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let business = http(
        &runtime,
        std::net::SocketAddr::new(bind, ports[0]),
        "POST",
        "/v1/responses",
        Some(
            serde_json::json!({"model":"test","input":"uncached connection probe","stream":false}),
        ),
    );
    drop(holder);
    let after_expiry: Vec<_> = paths.iter().map(|p| p.read().ok()).collect();
    let recovered = run(env!("CARGO_BIN_EXE_rccv3"), &state, &config, "restart");
    let fresh: Vec<_> = paths
        .iter()
        .map(|p| {
            p.read()
                .ok()
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                .and_then(|v| {
                    v["control_addr"]
                        .as_str()
                        .and_then(|a| a.parse::<std::net::SocketAddr>().ok())
                })
        })
        .collect();
    let statuses: Vec<_> = fresh
        .iter()
        .map(|address| {
            address.map(|a| {
                http(
                    &runtime,
                    a,
                    "GET",
                    "/_routecodex/selection/active-keys",
                    None,
                )
            })
        })
        .collect();
    let stopped = run(env!("CARGO_BIN_EXE_rccv3"), &state, &config, "stop");
    let pid_closed = wait_for_explicit_pid_exit(process.pid.into(), Duration::from_secs(10));
    let sockets_closed = ports
        .iter()
        .all(|p| TcpStream::connect((bind, *p)).is_err())
        && fresh
            .iter()
            .flatten()
            .all(|a| TcpStream::connect(a).is_err());
    let records_closed = paths
        .iter()
        .all(|p| matches!(p.read(),Err(e) if e.kind()==std::io::ErrorKind::NotFound));
    drop(process);
    assert!(
        stopped.status.success() && pid_closed && sockets_closed && records_closed,
        "contended-successor fixture must close"
    );
    assert!(
        first.status.success(),
        "business startup remains available despite control acquisition expiry"
    );
    let detail = unavailable["detail"].as_str().unwrap_or_default();
    assert!(
        detail.contains("active-key control") && detail.contains("timed out"),
        "managed status must retain explicit control acquisition failure: {detail}"
    );
    assert_eq!(business.unwrap().0, 200);
    assert!(
        after_expiry
            .iter()
            .zip(&original)
            .all(|(now, old)| now.as_ref() == Some(old)),
        "expired successor must not mutate inherited records later"
    );
    assert!(recovered.status.success());
    assert!(
        statuses.iter().all(|s| matches!(s, Some(Ok((200, _))))),
        "later explicit restart must complete inherited exact ownership: {statuses:?}"
    );
}

#[test]
fn final_port_cleanup_failure_keeps_managed_retry_until_exact_cleanup_completes() {
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state = root.path().join("state");
    let provider = P0Provider::start();
    let route = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
    route.connect("192.0.2.1:9").unwrap();
    let bind = route.local_addr().unwrap().ip();
    let a = std::net::TcpListener::bind((bind, 0)).unwrap();
    let b = std::net::TcpListener::bind((bind, 0)).unwrap();
    let ports = [
        a.local_addr().unwrap().port(),
        b.local_addr().unwrap().port(),
    ];
    drop(a);
    drop(b);
    assert!(!ports.iter().any(|p| [4444, 7777].contains(p)));
    let config = write_active_config(&root, bind, ports, provider.port, false);
    let process = p0_start(&root, &state, &config);
    let instance = single_instance_dir(&state);
    let control: Value =
        serde_json::from_slice(&fs::read(instance.join("control.json")).unwrap()).unwrap();
    let paths = [
        routecodex_v3_config::v3_active_key_control_paths(&config, "a").unwrap(),
        routecodex_v3_config::v3_active_key_control_paths(&config, "b").unwrap(),
    ];
    let original: Vec<_> = paths.iter().map(|p| p.read().unwrap()).collect();
    let controls: Vec<std::net::SocketAddr> = original
        .iter()
        .map(|b| {
            serde_json::from_slice::<Value>(b).unwrap()["control_addr"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap()
        })
        .collect();
    let holder = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.path().join(".active-key-control.lock"))
        .unwrap();
    holder.lock().unwrap();
    let failed = release_set(&control, &ports);
    let still_owned = instance.join("control.json").exists();
    drop(holder);
    let pending: Vec<_> = paths.iter().map(|p| p.read().ok()).collect();
    let retried = release_set(&control, &ports);
    let pid_closed = wait_for_explicit_pid_exit(process.pid.into(), Duration::from_secs(10));
    let sockets_closed = ports
        .iter()
        .all(|p| TcpStream::connect((bind, *p)).is_err())
        && controls.iter().all(|a| TcpStream::connect(a).is_err());
    let records_closed = paths
        .iter()
        .all(|p| matches!(p.read(),Err(e) if e.kind()==std::io::ErrorKind::NotFound));
    drop(process);
    assert!(
        pid_closed && sockets_closed && records_closed,
        "final-listener fixture must close after acknowledged cleanup"
    );
    assert_eq!(failed["accepted"], false);
    assert!(
        still_owned,
        "failed final cleanup must retain the managed control loop for retry"
    );
    assert!(
        pending
            .iter()
            .zip(&original)
            .all(|(p, o)| p.as_ref() == Some(o)),
        "all exact stopped owners remain pending"
    );
    assert_eq!(retried["accepted"], true);
}
