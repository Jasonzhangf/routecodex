use std::fs;
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn root(name: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "rccv4-{name}-{}-{}",
        std::process::id(),
        std::thread::current().name().unwrap_or("test")
    ));
    fs::create_dir_all(&path).expect("temp root");
    path
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("ephemeral bind")
        .local_addr()
        .expect("address")
        .port()
}

fn initialize(test_root: &std::path::Path, port: u16) -> std::path::PathBuf {
    let config = test_root.join("config.v4.toml");
    let output = Command::new(env!("CARGO_BIN_EXE_rccv4"))
        .args([
            "init",
            "-c",
            config.to_str().expect("config path"),
            "--provider",
            "test-provider",
            "--base-url",
            "https://example.invalid/v1",
            "--model",
            "test-model",
            "--api-key",
            "test-only-key",
            "--port",
            &port.to_string(),
        ])
        .output()
        .expect("init command");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    config
}

fn status_pid(output: &[u8]) -> u32 {
    let text = String::from_utf8_lossy(output);
    text.split_whitespace()
        .find_map(|part| {
            part.strip_prefix("pid=")
                .and_then(|value| value.parse().ok())
        })
        .expect("managed status must include pid")
}

fn instance_pid(state_root: &std::path::Path) -> u32 {
    let record: serde_json::Value =
        serde_json::from_slice(&fs::read(state_root.join("instance.json")).expect("instance"))
            .expect("instance JSON");
    record["pid"].as_u64().expect("instance pid") as u32
}

fn start_cordis_fixture(
    state_root: &std::path::Path,
) -> (std::process::Child, std::path::PathBuf, std::path::PathBuf) {
    fs::create_dir_all(state_root).expect("Cordis state root");
    let socket = state_root.join("cordis.sock");
    let manifest = state_root.join("manifest.compiled.json");
    let stderr_path = state_root.join("cordis.stderr");
    let stderr = fs::File::create(&stderr_path).expect("Cordis stderr");
    let child = Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../cordis/routecodex-v4-cordis-host/tests/resources/daemon-child.mjs"
        ))
        .args([
            state_root.to_str().expect("state root"),
            socket.to_str().expect("socket"),
            "manifest",
            manifest.to_str().expect("manifest"),
        ])
        .stderr(stderr)
        .spawn()
        .expect("Cordis daemon fixture");
    (child, socket, stderr_path)
}

#[test]
fn help_version_config_and_servertool_are_cwd_independent() {
    let test_root = root("surface");
    let config = initialize(&test_root, free_port());
    for args in [vec!["--version"], vec!["--help"]] {
        let output = Command::new(env!("CARGO_BIN_EXE_rccv4"))
            .current_dir("/tmp")
            .args(args)
            .output()
            .expect("surface command");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let check = Command::new(env!("CARGO_BIN_EXE_rccv4"))
        .current_dir("/tmp")
        .args(["config", "check", "-c", config.to_str().expect("config")])
        .output()
        .expect("config check");
    assert!(
        check.status.success(),
        "{}",
        String::from_utf8_lossy(&check.stderr)
    );
    let tool = Command::new(env!("CARGO_BIN_EXE_rccv4"))
        .current_dir("/tmp")
        .args([
            "servertool",
            "run",
            "web_search",
            "--input-json",
            "{\"query\":\"RouteCodex\"}",
            "--flow",
            "flow-1",
            "--session-id",
            "session-1",
            "--request-id",
            "request-1",
        ])
        .output()
        .expect("servertool");
    assert!(
        tool.status.success(),
        "{}",
        String::from_utf8_lossy(&tool.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&tool.stdout).expect("tool JSON");
    assert_eq!(value["toolName"], "web_search");
    assert!(value.get("routeHint").is_none());
    assert!(value.get("flowId").is_none());
    assert!(value.get("sessionId").is_none());
    assert!(value.get("requestId").is_none());
}

#[test]
fn managed_start_status_restart_stop_uses_v4_state_root() {
    let test_root = root("lifecycle");
    let state_root = std::path::PathBuf::from("/tmp").join(format!(
        "rccv4-state-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let port = free_port();
    let config = initialize(&test_root, port);
    let preflight = Command::new(env!("CARGO_BIN_EXE_rccv4"))
        .current_dir("/tmp")
        .env("RCCV4_STATE_ROOT", &state_root)
        .env(
            "RCCV4_CORDIS_HOST_SOCKET",
            state_root.join("missing-admission.sock"),
        )
        .args(["start", "-c", config.to_str().expect("config")])
        .output()
        .expect("manifest preflight");
    assert!(
        !preflight.status.success(),
        "preflight must fail without Cordis admission"
    );
    assert!(
        state_root.join("manifest.compiled.json").exists(),
        "preflight must publish the compiled manifest"
    );
    assert!(
        !state_root.join("instance.json").exists(),
        "failed admission must not declare a managed instance"
    );
    let (mut cordis, socket, cordis_stderr) = start_cordis_fixture(&state_root);
    let cordis_deadline = Instant::now() + Duration::from_secs(3);
    while !socket.exists() && Instant::now() < cordis_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(socket.exists(), "Cordis daemon fixture socket not ready");
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_rccv4"))
            .current_dir("/tmp")
            .env("RCCV4_STATE_ROOT", &state_root)
            .env("RCCV4_CORDIS_HOST_SOCKET", &socket)
            .args(args)
            .output()
            .expect("lifecycle command")
    };
    let start = run(&["start", "-c", config.to_str().expect("config"), "--snap"]);
    assert!(
        start.status.success(),
        "{}\ncordis={}\nruntime={}",
        String::from_utf8_lossy(&start.stderr),
        fs::read_to_string(cordis_stderr).unwrap_or_default(),
        fs::read_to_string(state_root.join("logs/rccv4.log")).unwrap_or_default()
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && TcpStream::connect(("127.0.0.1", port)).is_err() {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        TcpStream::connect(("127.0.0.1", port)).is_ok(),
        "listener not ready"
    );
    let status_deadline = Instant::now() + Duration::from_secs(3);
    let first_pid: u32 = loop {
        let status = run(&["status", "-c", config.to_str().expect("config")]);
        let text = String::from_utf8_lossy(&status.stdout);
        if let Some(pid) = text.split_whitespace().find_map(|part| {
            part.strip_prefix("pid=")
                .and_then(|value| value.parse().ok())
        }) {
            break pid;
        }
        assert!(
            Instant::now() < status_deadline,
            "managed status did not become ready"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    // A dead/rejecting Cordis owner must not release the currently healthy
    // managed child just because `start` was asked to replace it.
    cordis.kill().expect("stop Cordis owner");
    cordis.wait().expect("wait Cordis owner");
    if socket.exists() {
        fs::remove_file(&socket).expect("remove stopped Cordis socket");
    }
    let refused = run(&["start", "-c", config.to_str().expect("config"), "--snap"]);
    assert!(
        !refused.status.success(),
        "start must fail closed without Cordis"
    );
    let preserved_pid =
        status_pid(&run(&["status", "-c", config.to_str().expect("config")]).stdout);
    assert_eq!(
        first_pid, preserved_pid,
        "failed admission must preserve old PID"
    );
    let refused_restart = run(&["restart", "-c", config.to_str().expect("config")]);
    assert!(
        !refused_restart.status.success(),
        "restart must fail closed without Cordis"
    );
    let preserved_after_restart =
        status_pid(&run(&["status", "-c", config.to_str().expect("config")]).stdout);
    assert_eq!(
        first_pid, preserved_after_restart,
        "failed restart must preserve old PID"
    );

    let (mut cordis, socket, _cordis_stderr) = start_cordis_fixture(&state_root);
    let cordis_deadline = Instant::now() + Duration::from_secs(3);
    while !socket.exists() && Instant::now() < cordis_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        socket.exists(),
        "replacement Cordis daemon socket not ready"
    );
    let takeover = run(&["start", "-c", config.to_str().expect("config"), "--snap"]);
    assert!(
        takeover.status.success(),
        "{}",
        String::from_utf8_lossy(&takeover.stderr)
    );
    assert!(String::from_utf8_lossy(&takeover.stdout).contains("state=running"));
    let second_pid = status_pid(&run(&["status", "-c", config.to_str().expect("config")]).stdout);
    assert_ne!(
        first_pid, second_pid,
        "start must cold-start a fresh managed child"
    );
    let status = run(&["status", "-c", config.to_str().expect("config")]);
    assert!(status.status.success());
    assert!(String::from_utf8_lossy(&status.stdout).contains("state=running"));
    let restart = run(&["restart", "-c", config.to_str().expect("config")]);
    assert!(
        restart.status.success(),
        "{}",
        String::from_utf8_lossy(&restart.stderr)
    );
    let stop = run(&["stop", "-c", config.to_str().expect("config")]);
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
    assert!(!state_root.join("instance.json").exists());
    let _ = cordis.kill();
    let _ = cordis.wait();
}

#[test]
fn restart_cold_starts_when_no_managed_instance_exists() {
    let test_root = root("cold-restart");
    let state_root = std::path::PathBuf::from("/tmp").join(format!(
        "rccv4-cold-restart-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let port = free_port();
    let config = initialize(&test_root, port);
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_rccv4"))
            .current_dir("/tmp")
            .env("RCCV4_STATE_ROOT", &state_root)
            .env(
                "RCCV4_CORDIS_HOST_SOCKET",
                state_root.join("missing-admission.sock"),
            )
            .args(args)
            .output()
            .expect("lifecycle command")
    };
    let restart = run(&["restart", "-c", config.to_str().expect("config")]);
    assert!(!restart.status.success());
    assert!(
        String::from_utf8_lossy(&restart.stderr).contains("Cordis admission")
            || fs::read_to_string(state_root.join("logs/rccv4.log"))
                .unwrap_or_default()
                .contains("Cordis admission")
    );
}

#[test]
fn failed_admission_reaps_owned_cordis_host() {
    let test_root = root("failed-admission-reap");
    let state_root = std::path::PathBuf::from("/tmp").join(format!(
        "rccv4-reap-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let config = initialize(&test_root, free_port());
    let runner = test_root.join("rejecting-cordis.mjs");
    let ready_file = test_root.join("cordis.ready");
    let pid_file = test_root.join("cordis.pid");
    fs::write(
        &runner,
        r#"import fs from 'node:fs';
import net from 'node:net';
const [, , , socketPath] = process.argv;
fs.writeFileSync(process.env.RCCV4_TEST_PID_FILE, String(process.pid));
try { fs.unlinkSync(socketPath); } catch {}
const server = net.createServer((socket) => {
  socket.once('data', () => {
    socket.end('{"ok":false,"message":"test rejection"}\n');
  });
});
server.listen(socketPath, () => fs.writeFileSync(process.env.RCCV4_TEST_READY_FILE, 'ready'));
setInterval(() => {}, 1000);
"#,
    )
    .expect("rejecting runner");
    let output = Command::new(env!("CARGO_BIN_EXE_rccv4"))
        .current_dir("/tmp")
        .env("RCCV4_STATE_ROOT", &state_root)
        .env("RCCV4_CORDIS_HOST_RUNNER", &runner)
        .env("RCCV4_TEST_READY_FILE", &ready_file)
        .env("RCCV4_TEST_PID_FILE", &pid_file)
        .env_remove("RCCV4_CORDIS_HOST_SOCKET")
        .args(["start", "-c", config.to_str().expect("config")])
        .output()
        .expect("failed admission start");
    assert!(
        !output.status.success(),
        "rejected admission must fail closed"
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("Cordis admission handshake rejected"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        ready_file.exists(),
        "fixture must have reached listening state"
    );
    let pid = fs::read_to_string(&pid_file)
        .expect("runner pid")
        .trim()
        .to_string();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut alive = true;
    while Instant::now() < deadline {
        let ps = Command::new("/bin/ps")
            .args(["-p", &pid, "-o", "pid="])
            .stdout(Stdio::piped())
            .output()
            .expect("ps liveness probe");
        alive = String::from_utf8_lossy(&ps.stdout).trim() == pid;
        if !alive {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !alive,
        "failed admission must reap owned Cordis host pid={pid}"
    );
    assert!(
        !state_root.join("cordis.sock").exists(),
        "failed admission must remove owned socket"
    );
}

#[test]
fn failed_managed_start_reaps_owned_cordis_host() {
    let test_root = root("failed-managed-start-reap");
    let state_root = std::path::PathBuf::from("/tmp").join(format!(
        "rccv4-start-reap-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let config = initialize(&test_root, free_port());
    let runner = test_root.join("admitting-cordis.mjs");
    let ready_file = test_root.join("cordis.ready");
    let pid_file = test_root.join("cordis.pid");
    fs::write(
        &runner,
        r#"import fs from 'node:fs';
import net from 'node:net';
const [, , , socketPath, manifestPath] = process.argv;
fs.writeFileSync(process.env.RCCV4_TEST_PID_FILE, String(process.pid));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const graphHash = manifest.execution_epoch.graph_hash;
const manifestHash = manifest.execution_epoch.manifest_hash;
const epochId = manifest.execution_epoch.candidate.epoch_id;
const server = net.createServer((socket) => {
  let input = '';
  socket.on('data', (chunk) => {
    input += chunk;
    if (!input.includes('\n')) return;
    const request = JSON.parse(input.slice(0, input.indexOf('\n')));
    if (request.op === 'handshake') {
      socket.end(`${JSON.stringify({ ok: true, snapshot: { generation: 1 } })}\n`);
    } else {
      socket.end(`${JSON.stringify({
        ok: true,
        admission: {
          active_epoch: { graph_hash: graphHash, manifest_hash: manifestHash, epoch_id: epochId },
        },
      })}\n`, () => {
        server.close();
        process.exit(0);
      });
    }
  });
});
server.listen(socketPath, () => fs.writeFileSync(process.env.RCCV4_TEST_READY_FILE, 'ready'));
setInterval(() => {}, 1000);
"#,
    )
    .expect("admitting runner");
    let output = Command::new(env!("CARGO_BIN_EXE_rccv4"))
        .current_dir("/tmp")
        .env("RCCV4_STATE_ROOT", &state_root)
        .env("RCCV4_CORDIS_HOST_RUNNER", &runner)
        .env("RCCV4_TEST_READY_FILE", &ready_file)
        .env("RCCV4_TEST_PID_FILE", &pid_file)
        .env_remove("RCCV4_CORDIS_HOST_SOCKET")
        .args(["start", "-c", config.to_str().expect("config")])
        .output()
        .expect("failed managed start");
    assert!(
        !output.status.success(),
        "runner exit must fail managed start"
    );
    assert!(
        ready_file.exists(),
        "fixture must have reached listening state"
    );
    let pid = fs::read_to_string(&pid_file)
        .expect("runner pid")
        .trim()
        .to_string();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut alive = true;
    while Instant::now() < deadline {
        let ps = Command::new("/bin/ps")
            .args(["-p", &pid, "-o", "pid="])
            .stdout(Stdio::piped())
            .output()
            .expect("ps liveness probe");
        alive = String::from_utf8_lossy(&ps.stdout).trim() == pid;
        if !alive {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !alive,
        "failed managed start must reap owned Cordis host pid={pid}"
    );
    assert!(
        !state_root.join("cordis.sock").exists(),
        "failed managed start must remove owned socket"
    );
}
#[test]
fn successful_start_hands_cordis_ownership_to_managed_child() {
    let test_root = root("cordis-handoff");
    let state_root = std::path::PathBuf::from("/tmp").join(format!(
        "rccv4-handoff-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let config = initialize(&test_root, free_port());
    let runner = test_root.join("handoff-cordis.mjs");
    let ready_file = test_root.join("cordis.ready");
    let pid_file = test_root.join("cordis.pid");
    fs::write(
        &runner,
        r#"import fs from 'node:fs';
import net from 'node:net';
const [, , , socketPath, manifestPath] = process.argv;
fs.writeFileSync(process.env.RCCV4_TEST_PID_FILE, String(process.pid));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const graphHash = manifest.execution_epoch.graph_hash;
const manifestHash = manifest.execution_epoch.manifest_hash;
const epochId = manifest.execution_epoch.candidate.epoch_id;
const server = net.createServer((socket) => {
  let input = '';
  socket.on('data', (chunk) => {
    input += chunk;
    if (!input.includes('\n')) return;
    const request = JSON.parse(input.slice(0, input.indexOf('\n')));
    if (request.op === 'handshake') {
      socket.end(`${JSON.stringify({ ok: true, snapshot: { generation: 1 } })}\n`);
    } else {
      socket.end(`${JSON.stringify({
        ok: true,
        admission: {
          active_epoch: { graph_hash: graphHash, manifest_hash: manifestHash, epoch_id: epochId },
        },
      })}\n`);
    }
  });
});
server.listen(socketPath, () => fs.writeFileSync(process.env.RCCV4_TEST_READY_FILE, 'ready'));
setInterval(() => {}, 1000);
"#,
    )
    .expect("handoff runner");
    let output = Command::new(env!("CARGO_BIN_EXE_rccv4"))
        .current_dir("/tmp")
        .env("RCCV4_STATE_ROOT", &state_root)
        .env("RCCV4_CORDIS_HOST_RUNNER", &runner)
        .env("RCCV4_TEST_READY_FILE", &ready_file)
        .env("RCCV4_TEST_PID_FILE", &pid_file)
        .env_remove("RCCV4_CORDIS_HOST_SOCKET")
        .args(["start", "-c", config.to_str().expect("config")])
        .output()
        .expect("handoff start");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let restart = Command::new(env!("CARGO_BIN_EXE_rccv4"))
        .current_dir("/tmp")
        .env("RCCV4_STATE_ROOT", &state_root)
        .env("RCCV4_CORDIS_HOST_RUNNER", &runner)
        .args(["restart", "-c", config.to_str().expect("config")])
        .output()
        .expect("handoff restart");
    assert!(
        restart.status.success(),
        "{}",
        String::from_utf8_lossy(&restart.stderr)
    );
    let stop = Command::new(env!("CARGO_BIN_EXE_rccv4"))
        .current_dir("/tmp")
        .env("RCCV4_STATE_ROOT", &state_root)
        .env("RCCV4_CORDIS_HOST_RUNNER", &runner)
        .args(["stop", "-c", config.to_str().expect("config")])
        .output()
        .expect("handoff stop");
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
    let pid = fs::read_to_string(&pid_file)
        .expect("runner pid")
        .trim()
        .to_string();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut alive = true;
    while Instant::now() < deadline {
        let ps = Command::new("/bin/ps")
            .args(["-p", &pid, "-o", "pid="])
            .stdout(Stdio::piped())
            .output()
            .expect("ps liveness probe");
        alive = String::from_utf8_lossy(&ps.stdout).trim() == pid;
        if !alive {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !alive,
        "managed stop must terminate the handed-off Cordis host pid={pid}"
    );
    assert!(
        !state_root.join("cordis.sock").exists(),
        "managed stop must remove the handed-off Cordis socket"
    );
}

#[test]
fn cold_start_takeover_replaces_lifecycle_owned_cordis_host() {
    let test_root = root("cordis-takeover");
    let state_root = std::path::PathBuf::from("/tmp").join(format!(
        "rccv4-takeover-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let port = free_port();
    let config = initialize(&test_root, port);
    let runner = test_root.join("takeover-cordis.mjs");
    let pid_log = test_root.join("cordis.pids");
    fs::write(
        &runner,
        r#"import fs from 'node:fs';
import net from 'node:net';
const [, , , socketPath, manifestPath] = process.argv;
fs.appendFileSync(process.env.RCCV4_TEST_PID_LOG, `${process.pid}\n`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const graphHash = manifest.execution_epoch.graph_hash;
const manifestHash = manifest.execution_epoch.manifest_hash;
const epochId = manifest.execution_epoch.candidate.epoch_id;
const server = net.createServer((socket) => {
  let input = '';
  socket.on('data', (chunk) => {
    input += chunk;
    if (!input.includes('\n')) return;
    const request = JSON.parse(input.slice(0, input.indexOf('\n')));
    if (request.op === 'handshake') {
      socket.end(`${JSON.stringify({ ok: true, snapshot: { generation: 1 } })}\n`);
    } else {
      socket.end(`${JSON.stringify({
        ok: true,
        admission: {
          active_epoch: { graph_hash: graphHash, manifest_hash: manifestHash, epoch_id: epochId },
        },
      })}\n`);
    }
  });
});
server.listen(socketPath);
setInterval(() => {}, 1000);
"#,
    )
    .expect("takeover runner");
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_rccv4"))
            .current_dir("/tmp")
            .env("RCCV4_STATE_ROOT", &state_root)
            .env("RCCV4_CORDIS_HOST_RUNNER", &runner)
            .env("RCCV4_TEST_PID_LOG", &pid_log)
            .env_remove("RCCV4_CORDIS_HOST_SOCKET")
            .args(args)
            .output()
            .expect("takeover lifecycle command")
    };
    let first = run(&["start", "-c", config.to_str().expect("config")]);
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let first_pid = status_pid(&run(&["status", "-c", config.to_str().expect("config")]).stdout);
    let first_host_pids = fs::read_to_string(&pid_log)
        .expect("first Cordis pid log")
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>();
    assert_eq!(
        first_host_pids.len(),
        2,
        "launcher admission and managed child must own separate hosts"
    );
    let socket = state_root.join("cordis.sock");
    assert!(
        UnixStream::connect(&socket).is_ok(),
        "managed child Cordis socket must be live"
    );

    let takeover = run(&["start", "-c", config.to_str().expect("config")]);
    assert!(
        takeover.status.success(),
        "{}",
        String::from_utf8_lossy(&takeover.stderr)
    );
    let second_pid = status_pid(&run(&["status", "-c", config.to_str().expect("config")]).stdout);
    assert_ne!(first_pid, second_pid, "cold start must replace the child");
    let takeover_host_pids = fs::read_to_string(&pid_log)
        .expect("takeover Cordis pid log")
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>();
    assert_ne!(
        takeover_host_pids.last().expect("replacement host"),
        first_host_pids.last().expect("first managed host"),
        "replacement child must own a fresh Cordis host"
    );
    assert!(
        UnixStream::connect(&socket).is_ok(),
        "replacement Cordis socket must remain live"
    );

    let stop = run(&["stop", "-c", config.to_str().expect("config")]);
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
    assert!(
        !socket.exists(),
        "managed stop must remove the replacement Cordis socket"
    );
}

#[test]
fn cold_start_preserves_healthy_instance_when_owned_cordis_preflight_fails() {
    let test_root = root("cordis-preflight-preserve");
    let state_root = std::path::PathBuf::from("/tmp").join(format!(
        "rccv4-preflight-preserve-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let port = free_port();
    let config = initialize(&test_root, port);
    let runner = test_root.join("preflight-cordis.mjs");
    fs::write(
        &runner,
        r#"import fs from 'node:fs';
import net from 'node:net';
const [, , , socketPath, manifestPath] = process.argv;
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const graphHash = manifest.execution_epoch.graph_hash;
const manifestHash = manifest.execution_epoch.manifest_hash;
const epochId = manifest.execution_epoch.candidate.epoch_id;
const server = net.createServer((socket) => {
  let input = '';
  socket.on('data', (chunk) => {
    input += chunk;
    if (!input.includes('\n')) return;
    const request = JSON.parse(input.slice(0, input.indexOf('\n')));
    if (request.op === 'handshake') {
      socket.end(`${JSON.stringify({ ok: true, snapshot: { generation: 1 } })}\n`);
    } else {
      socket.end(`${JSON.stringify({
        ok: true,
        admission: {
          active_epoch: { graph_hash: graphHash, manifest_hash: manifestHash, epoch_id: epochId },
        },
      })}\n`);
    }
  });
});
server.listen(socketPath);
setInterval(() => {}, 1000);
"#,
    )
    .expect("preflight runner");
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_rccv4"))
            .current_dir("/tmp")
            .env("RCCV4_STATE_ROOT", &state_root)
            .env("RCCV4_CORDIS_HOST_RUNNER", &runner)
            .env_remove("RCCV4_CORDIS_HOST_SOCKET")
            .args(args)
            .output()
            .expect("preflight lifecycle command")
    };
    let first = run(&["start", "-c", config.to_str().expect("config")]);
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let first_pid = status_pid(&run(&["status", "-c", config.to_str().expect("config")]).stdout);
    let broken_runner = test_root.join("rejecting-cordis.mjs");
    fs::write(
        &broken_runner,
        r#"import net from 'node:net';
const socketPath = process.argv[3];
const server = net.createServer((socket) => socket.end('{"ok":false,"message":"preflight rejection"}\n'));
server.listen(socketPath);
setInterval(() => {}, 1000);
"#,
    )
    .expect("rejecting runner");
    let refused = Command::new(env!("CARGO_BIN_EXE_rccv4"))
        .current_dir("/tmp")
        .env("RCCV4_STATE_ROOT", &state_root)
        .env("RCCV4_CORDIS_HOST_RUNNER", &broken_runner)
        .env_remove("RCCV4_CORDIS_HOST_SOCKET")
        .args(["start", "-c", config.to_str().expect("config")])
        .output()
        .expect("failed replacement start");
    assert!(
        !refused.status.success(),
        "rejecting replacement Cordis host must fail closed"
    );
    let preserved_pid =
        status_pid(&run(&["status", "-c", config.to_str().expect("config")]).stdout);
    assert_eq!(
        first_pid, preserved_pid,
        "failed owned-Cordis replacement must preserve the healthy managed PID"
    );
    assert!(
        TcpStream::connect(("127.0.0.1", port)).is_ok(),
        "failed owned-Cordis replacement must preserve the listener"
    );
    let stop = run(&["stop", "-c", config.to_str().expect("config")]);
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
}

#[test]
fn cold_start_preserves_healthy_instance_when_external_cordis_admission_fails() {
    let test_root = root("cordis-external-preflight-preserve");
    let state_root = std::path::PathBuf::from("/tmp").join(format!(
        "rccv4-external-preflight-preserve-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let port = free_port();
    let config = initialize(&test_root, port);
    let runner = test_root.join("external-preflight-cordis.mjs");
    fs::write(
        &runner,
        r#"import fs from 'node:fs';
import net from 'node:net';
const [, , , socketPath, manifestPath] = process.argv;
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const graphHash = manifest.execution_epoch.graph_hash;
const manifestHash = manifest.execution_epoch.manifest_hash;
const epochId = manifest.execution_epoch.candidate.epoch_id;
const server = net.createServer((socket) => {
  let input = '';
  socket.on('data', (chunk) => {
    input += chunk;
    if (!input.includes('\n')) return;
    const request = JSON.parse(input.slice(0, input.indexOf('\n')));
    if (request.op === 'handshake') {
      socket.end(`${JSON.stringify({ ok: true, snapshot: { generation: 1 } })}\n`);
    } else {
      socket.end(`${JSON.stringify({
        ok: true,
        admission: {
          active_epoch: { graph_hash: graphHash, manifest_hash: manifestHash, epoch_id: epochId },
        },
      })}\n`);
    }
  });
});
server.listen(socketPath);
setInterval(() => {}, 1000);
"#,
    )
    .expect("external preflight runner");
    let managed = Command::new(env!("CARGO_BIN_EXE_rccv4"))
        .current_dir("/tmp")
        .env("RCCV4_STATE_ROOT", &state_root)
        .env("RCCV4_CORDIS_HOST_RUNNER", &runner)
        .env_remove("RCCV4_CORDIS_HOST_SOCKET")
        .args(["start", "-c", config.to_str().expect("config")])
        .output()
        .expect("managed start");
    assert!(
        managed.status.success(),
        "{}",
        String::from_utf8_lossy(&managed.stderr)
    );
    let first_pid = status_pid(
        &Command::new(env!("CARGO_BIN_EXE_rccv4"))
            .current_dir("/tmp")
            .env("RCCV4_STATE_ROOT", &state_root)
            .env("RCCV4_CORDIS_HOST_RUNNER", &runner)
            .env_remove("RCCV4_CORDIS_HOST_SOCKET")
            .args(["status", "-c", config.to_str().expect("config")])
            .output()
            .expect("managed status")
            .stdout,
    );
    let rejecting_socket = std::path::PathBuf::from("/tmp").join(format!(
        "rccv4-reject-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let rejecting_runner = test_root.join("rejecting-external.mjs");
    fs::write(
        &rejecting_runner,
        r#"import net from 'node:net';
const socketPath = process.argv[3];
const server = net.createServer((socket) => socket.end('{"ok":false,"message":"external rejection"}\n'));
server.listen(socketPath);
setInterval(() => {}, 1000);
"#,
    )
    .expect("rejecting external runner");
    let mut rejecting = Command::new("node")
        .arg(&rejecting_runner)
        .arg(&state_root)
        .arg(&rejecting_socket)
        .arg(state_root.join("manifest.compiled.json"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("rejecting external host");
    let deadline = Instant::now() + Duration::from_secs(3);
    while !rejecting_socket.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        rejecting_socket.exists(),
        "rejecting external socket must become ready"
    );
    let refused = Command::new(env!("CARGO_BIN_EXE_rccv4"))
        .current_dir("/tmp")
        .env("RCCV4_STATE_ROOT", &state_root)
        .env("RCCV4_CORDIS_HOST_SOCKET", &rejecting_socket)
        .env("RCCV4_CORDIS_HOST_RUNNER", &runner)
        .args(["start", "-c", config.to_str().expect("config")])
        .output()
        .expect("failed external replacement start");
    assert!(
        !refused.status.success(),
        "rejecting external Cordis admission must fail closed"
    );
    let preserved_pid = status_pid(
        &Command::new(env!("CARGO_BIN_EXE_rccv4"))
            .current_dir("/tmp")
            .env("RCCV4_STATE_ROOT", &state_root)
            .env("RCCV4_CORDIS_HOST_RUNNER", &runner)
            .env_remove("RCCV4_CORDIS_HOST_SOCKET")
            .args(["status", "-c", config.to_str().expect("config")])
            .output()
            .expect("preserved status")
            .stdout,
    );
    assert_eq!(
        first_pid, preserved_pid,
        "failed external Cordis admission must preserve the healthy managed PID"
    );
    assert!(
        TcpStream::connect(("127.0.0.1", port)).is_ok(),
        "failed external Cordis admission must preserve the listener"
    );
    let stop = Command::new(env!("CARGO_BIN_EXE_rccv4"))
        .current_dir("/tmp")
        .env("RCCV4_STATE_ROOT", &state_root)
        .env("RCCV4_CORDIS_HOST_RUNNER", &runner)
        .env_remove("RCCV4_CORDIS_HOST_SOCKET")
        .args(["stop", "-c", config.to_str().expect("config")])
        .output()
        .expect("stop preserved instance");
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
    let _ = rejecting.kill();
    let _ = rejecting.wait();
}

#[test]
fn cold_start_refuses_connectable_socket_without_lifecycle_witness() {
    let test_root = root("cordis-unwitnessed");
    let state_root = std::path::PathBuf::from("/tmp").join(format!(
        "rccv4-unwitnessed-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    fs::create_dir_all(&state_root).expect("state root");
    let socket = state_root.join("cordis.sock");
    let runner = test_root.join("unwitnessed-cordis.mjs");
    let manifest = state_root.join("manifest.compiled.json");
    let stderr = fs::File::create(test_root.join("unwitnessed.stderr")).expect("stderr");
    fs::write(
        &runner,
        r#"import net from 'node:net';
const socketPath = process.argv[3];
const server = net.createServer((socket) => socket.end('{"ok":false}\n'));
server.listen(socketPath);
setInterval(() => {}, 1000);
"#,
    )
    .expect("runner");
    let child = Command::new("node")
        .arg(&runner)
        .arg(&state_root)
        .arg(&socket)
        .arg(&manifest)
        .stderr(stderr)
        .spawn()
        .expect("connectable socket fixture");
    let deadline = Instant::now() + Duration::from_secs(3);
    while !socket.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(socket.exists(), "fixture socket must be connectable");

    let config = initialize(&test_root, free_port());
    let output = Command::new(env!("CARGO_BIN_EXE_rccv4"))
        .current_dir("/tmp")
        .env("RCCV4_STATE_ROOT", &state_root)
        .env("RCCV4_CORDIS_HOST_RUNNER", &runner)
        .env_remove("RCCV4_CORDIS_HOST_SOCKET")
        .args(["start", "-c", config.to_str().expect("config")])
        .output()
        .expect("unwitnessed start");
    assert!(
        !output.status.success(),
        "connectable socket without lifecycle witness must fail closed"
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("already in use"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(UnixStream::connect(&socket).is_ok());
    assert!(!state_root.join("instance.json").exists());
    let mut child = child;
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn cold_start_adopts_matching_lifecycle_owned_cordis_socket() {
    let test_root = root("cordis-adopt-owned");
    let state_root = std::path::PathBuf::from("/tmp").join(format!(
        "rccv4-adopt-owned-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let port = free_port();
    let config = initialize(&test_root, port);
    let manifest = state_root.join("manifest.compiled.json");
    let runner = test_root.join("adopt-owned-cordis.mjs");
    let pid_file = test_root.join("adopt-owned.pid");
    let ready_file = test_root.join("adopt-owned.ready");

    let compile_only = Command::new(env!("CARGO_BIN_EXE_rccv4"))
        .current_dir("/tmp")
        .env("RCCV4_STATE_ROOT", &state_root)
        .env(
            "RCCV4_CORDIS_HOST_SOCKET",
            state_root.join("missing-admission.sock"),
        )
        .args(["start", "-c", config.to_str().expect("config")])
        .output()
        .expect("manifest compile");
    assert!(
        !compile_only.status.success(),
        "missing admission must not start a managed instance"
    );
    assert!(
        manifest.exists(),
        "failed admission must still publish the compiled manifest"
    );

    fs::write(
        &runner,
        r#"import fs from 'node:fs';
import net from 'node:net';
const [, , , socketPath, manifestPath] = process.argv;
fs.writeFileSync(process.env.RCCV4_TEST_PID_FILE, String(process.pid));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const graphHash = manifest.execution_epoch.graph_hash;
const manifestHash = manifest.execution_epoch.manifest_hash;
const epochId = manifest.execution_epoch.candidate.epoch_id;
const server = net.createServer((socket) => {
  let input = '';
  socket.on('data', (chunk) => {
    input += chunk;
    if (!input.includes('\n')) return;
    const request = JSON.parse(input.slice(0, input.indexOf('\n')));
    if (request.op === 'handshake') {
      socket.end(`${JSON.stringify({ ok: true, snapshot: { generation: 1 } })}\n`);
    } else {
      socket.end(`${JSON.stringify({
        ok: true,
        admission: {
          active_epoch: { graph_hash: graphHash, manifest_hash: manifestHash, epoch_id: epochId },
        },
      })}\n`);
    }
  });
});
server.listen(socketPath, () => fs.writeFileSync(process.env.RCCV4_TEST_READY_FILE, 'ready'));
setInterval(() => {}, 1000);
"#,
    )
    .expect("adopt-owned runner");

    let socket = state_root.join("cordis.sock");
    let stderr = fs::File::create(test_root.join("adopt-owned.stderr")).expect("stderr");
    let mut child = Command::new("node")
        .arg(&runner)
        .args([
            state_root.to_str().expect("state root"),
            socket.to_str().expect("socket"),
            manifest.to_str().expect("manifest"),
        ])
        .env("RCCV4_TEST_PID_FILE", &pid_file)
        .env("RCCV4_TEST_READY_FILE", &ready_file)
        .stderr(stderr)
        .spawn()
        .expect("lifecycle-owned socket fixture");
    let deadline = Instant::now() + Duration::from_secs(3);
    while !socket.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(socket.exists(), "fixture socket must become ready");
    let cordis_pid = fs::read_to_string(&pid_file)
        .expect("fixture pid")
        .trim()
        .parse::<u32>()
        .expect("Cordis pid");
    let metadata = fs::symlink_metadata(&socket).expect("socket metadata");
    let record = serde_json::json!({
        "runtime_identity": "rccv4",
        "pid": std::process::id(),
        "generation_nonce": 1,
        "cordis_socket_identity": {
            "pid": cordis_pid,
            "start_time": routecodex_v4_lifecycle::process_start_time(cordis_pid).expect("Cordis start time"),
            "device": metadata.dev(),
            "inode": metadata.ino(),
        },
        "config_path": config.to_str().expect("config path"),
        "manifest_path": manifest.to_str().expect("manifest path"),
        "manifest_digest": "test-only",
        "listeners": [format!("127.0.0.1:{port}")],
    });
    fs::write(
        state_root.join("instance.json"),
        serde_json::to_vec(&record).expect("record"),
    )
    .expect("lifecycle record");

    let adopted = Command::new(env!("CARGO_BIN_EXE_rccv4"))
        .current_dir("/tmp")
        .env("RCCV4_STATE_ROOT", &state_root)
        .env("RCCV4_CORDIS_HOST_RUNNER", &runner)
        .env_remove("RCCV4_CORDIS_HOST_SOCKET")
        .args(["start", "-c", config.to_str().expect("config")])
        .output()
        .expect("adopt owned socket");
    let stderr = String::from_utf8_lossy(&adopted.stderr);
    assert!(
        !adopted.status.success(),
        "unresponsive live stale record must still block managed start: {stderr}"
    );
    assert!(
        !stderr.contains("already in use"),
        "lifecycle-owned socket must be adopted before failing on stale record: {stderr}"
    );
    assert!(
        stderr.contains("already declared"),
        "failure must come from the live stale record, not socket admission: {stderr}"
    );
    assert!(
        UnixStream::connect(&socket).is_ok(),
        "adopted socket must remain live"
    );
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn cold_start_recovers_surviving_lifecycle_owned_cordis_host() {
    let test_root = root("cordis-stale-recovery");
    let state_root = std::path::PathBuf::from("/tmp").join(format!(
        "rccv4-stale-recovery-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let config = initialize(&test_root, free_port());
    let runner = test_root.join("stale-recovery-cordis.mjs");
    let pid_log = test_root.join("cordis.pids");
    fs::write(
        &runner,
        r#"import fs from 'node:fs';
import net from 'node:net';
const [, , , socketPath, manifestPath] = process.argv;
fs.appendFileSync(process.env.RCCV4_TEST_PID_LOG, `${process.pid}\n`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const graphHash = manifest.execution_epoch.graph_hash;
const manifestHash = manifest.execution_epoch.manifest_hash;
const epochId = manifest.execution_epoch.candidate.epoch_id;
const server = net.createServer((socket) => {
  let input = '';
  socket.on('data', (chunk) => {
    input += chunk;
    if (!input.includes('\n')) return;
    const request = JSON.parse(input.slice(0, input.indexOf('\n')));
    if (request.op === 'handshake') {
      socket.end(`${JSON.stringify({ ok: true, snapshot: { generation: 1 } })}\n`);
    } else {
      socket.end(`${JSON.stringify({
        ok: true,
        admission: {
          active_epoch: { graph_hash: graphHash, manifest_hash: manifestHash, epoch_id: epochId },
        },
      })}\n`);
    }
  });
});
server.listen(socketPath);
setInterval(() => {}, 1000);
"#,
    )
    .expect("stale recovery runner");
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_rccv4"))
            .current_dir("/tmp")
            .env("RCCV4_STATE_ROOT", &state_root)
            .env("RCCV4_CORDIS_HOST_RUNNER", &runner)
            .env("RCCV4_TEST_PID_LOG", &pid_log)
            .env_remove("RCCV4_CORDIS_HOST_SOCKET")
            .args(args)
            .output()
            .expect("stale recovery lifecycle command")
    };
    let first = run(&["start", "-c", config.to_str().expect("config")]);
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let first_managed_pid = instance_pid(&state_root);
    let first_host_pid = fs::read_to_string(&pid_log)
        .expect("host pid log")
        .lines()
        .last()
        .expect("first host pid")
        .to_string();
    let kill = Command::new("/bin/kill")
        .args(["-KILL", &first_managed_pid.to_string()])
        .status()
        .expect("kill managed child");
    assert!(kill.success(), "managed child must be killable");
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        let alive = Command::new("/bin/ps")
            .args(["-p", &first_managed_pid.to_string(), "-o", "pid="])
            .output()
            .expect("ps managed child");
        if String::from_utf8_lossy(&alive.stdout).trim().is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(UnixStream::connect(state_root.join("cordis.sock")).is_ok());

    let recovery = run(&["start", "-c", config.to_str().expect("config")]);
    assert!(
        recovery.status.success(),
        "{}",
        String::from_utf8_lossy(&recovery.stderr)
    );
    let second_managed_pid = instance_pid(&state_root);
    assert_ne!(first_managed_pid, second_managed_pid);
    let host_pids = fs::read_to_string(&pid_log)
        .expect("host pid log")
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>();
    assert_ne!(
        host_pids.last().expect("replacement host"),
        &first_host_pid,
        "stale Cordis host must be replaced"
    );
    assert!(UnixStream::connect(state_root.join("cordis.sock")).is_ok());
    let stop = run(&["stop", "-c", config.to_str().expect("config")]);
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
}
