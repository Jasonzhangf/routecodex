use super::*;

struct OwnedHooksGroup {
    process_group_id: i32,
}

impl Drop for OwnedHooksGroup {
    fn drop(&mut self) {
        if self.process_group_id > 0 {
            unsafe { libc::kill(-self.process_group_id, libc::SIGKILL) };
        }
    }
}

impl OwnedHooksGroup {
    fn assert_removed(&mut self) {
        assert_ne!(unsafe { libc::kill(-self.process_group_id, 0) }, 0);
        eprintln!("P0 hooks group removed={}", self.process_group_id);
        self.process_group_id = 0;
    }
}

fn active_instance(state: &Path) -> PathBuf {
    let owners = fs::read_dir(state.join("instances"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|directory| directory.join("pid.cache").exists())
        .collect::<Vec<_>>();
    assert_eq!(owners.len(), 1, "{owners:?}");
    owners[0].clone()
}

fn configure_hooks(root: &TempDir) -> (PathBuf, PathBuf) {
    let install_root = root.path().join("hooks");
    let bin_directory = install_root.join("bin");
    fs::create_dir_all(&bin_directory).unwrap();
    let marker = install_root.join("started");
    let daemon = bin_directory.join("rccv3-hooksd");
    fs::write(&daemon, format!(r#"#!/usr/bin/env python3
import json, os, socket, sys
path = sys.argv[sys.argv.index('--socket') + 1]
server = socket.socket(socket.AF_UNIX)
server.bind(path)
server.listen()
with open({:?}, 'a') as marker:
    marker.write(str(os.getpid()) + '\n')
print(json.dumps({{"protocol":"rcc-hooks-sidecar/v1","ready":True}}), flush=True)
while True:
    connection, _ = server.accept()
    with connection:
        request = connection.makefile('rb').readline()
        connection.sendall((json.dumps({{"protocol":"rcc-hooks-sidecar/v1","ok":True,"result":{{"status":"ok"}}}}) + '\n').encode())
"#, marker.to_str().unwrap())).unwrap();
    fs::set_permissions(&daemon, fs::Permissions::from_mode(0o755)).unwrap();
    let record = install_root.join("install.json");
    fs::write(
        &record,
        serde_json::json!({
            "supervisor_enabled": true, "bin_directory": bin_directory,
            "install_root": install_root
        })
        .to_string(),
    )
    .unwrap();
    (record, marker)
}

fn start_with_hooks(
    root: &TempDir,
    state: &Path,
    config: &Path,
    record: &Path,
) -> P0ManagedProcess {
    let output = run_with_hooks_record(env!("CARGO_BIN_EXE_rccv3"), state, config, "start", record);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let instance = active_instance(state);
    let cache: Value =
        serde_json::from_slice(&fs::read(instance.join("pid.cache")).unwrap()).unwrap();
    let process = P0ManagedProcess {
        pid: cache["pid"].as_u64().unwrap() as u32,
    };
    eprintln!(
        "P0 configured hooks PID={} root={}",
        process.pid,
        root.path().display()
    );
    process
}

fn hooks_record(instance: &Path) -> Value {
    serde_json::from_slice(&fs::read(instance.join("hooks-sidecar.pid")).unwrap()).unwrap()
}

fn wait_hooks_count(marker: &Path, expected: usize) {
    let deadline = Instant::now() + HOOKS_MARKER_TIMEOUT;
    loop {
        let count = fs::read_to_string(marker)
            .unwrap_or_default()
            .lines()
            .count();
        if count == expected {
            return;
        }
        assert!(
            count < expected && Instant::now() < deadline,
            "hooks launches {count}, expected {expected}"
        );
        sleep(Duration::from_millis(10));
    }
}

#[test]
fn p0_restart_pending_hooks_cleanup_survives_declaration_changes() {
    let _guard = lifecycle_test_guard();
    let root = tempfile::Builder::new()
        .prefix("p0-hooks-")
        .tempdir_in("/tmp")
        .unwrap();
    let state = root.path().join("state");
    let ports = [free_port(), free_port()];
    let provider = P0Provider::start();
    let config_a = write_config_with_provider(&root, ports, true, true, Some(provider.port));
    let config_b = root.path().join("config-b.toml");
    let config_c = root.path().join("config-c.toml");
    fs::copy(&config_a, &config_b).unwrap();
    fs::copy(&config_a, &config_c).unwrap();
    let (install, marker) = configure_hooks(&root);
    let _process = start_with_hooks(&root, &state, &config_a, &install);
    let old = active_instance(&state);
    wait_for_hooksd_marker(&old, &marker, "configured hooks did not start");
    let original = hooks_record(&old);
    let mut group = OwnedHooksGroup {
        process_group_id: original["process_group_id"].as_i64().unwrap() as i32,
    };
    eprintln!(
        "P0 owned old hooks group={} record={original}",
        group.process_group_id
    );
    let mut rejected = original.clone();
    rejected["leader_start_token"] = "identity-rejected-by-public-record".into();
    fs::write(old.join("hooks-sidecar.pid"), rejected.to_string()).unwrap();
    for config in [&config_b, &config_b, &config_c] {
        let restart = run_with_hooks_record(
            env!("CARGO_BIN_EXE_rccv3"),
            &state,
            config,
            "restart",
            &install,
        );
        assert!(
            restart.status.success(),
            "{}",
            String::from_utf8_lossy(&restart.stderr)
        );
        let current = active_instance(&state);
        let _unexpected_group = current.join("hooks-sidecar.pid").exists().then(|| {
            let record = hooks_record(&current);
            let process_group_id = record["process_group_id"].as_i64().unwrap() as i32;
            eprintln!("P0 owned unexpected hooks group={process_group_id}");
            OwnedHooksGroup { process_group_id }
        });
        let status = run_with_hooks_record(
            env!("CARGO_BIN_EXE_rccv3"),
            &state,
            config,
            "status",
            &install,
        );
        eprintln!(
            "restart status: {}",
            String::from_utf8_lossy(&status.stdout)
        );
        let mut connection = TcpStream::connect(("127.0.0.1", ports[0])).unwrap();
        p0_responses_on_connection(&mut connection, ports[0], root.path());
        assert_eq!(unsafe { libc::kill(-group.process_group_id, 0) }, 0);
        assert_eq!(hooks_record(&old), rejected);
        assert_eq!(
            fs::read_to_string(&marker).unwrap().lines().count(),
            1,
            "replacement hooks started while old cleanup unresolved"
        );
        assert!(last_json(&status)["detail"]
            .as_str()
            .unwrap_or_default()
            .contains("cleanup"));
        let pending: Value =
            serde_json::from_slice(&fs::read(current.join("hooks-sidecar-cleanup.json")).unwrap())
                .unwrap();
        assert_eq!(
            pending["instance_id"],
            old.file_name().unwrap().to_str().unwrap()
        );
    }
    fs::write(old.join("hooks-sidecar.pid"), original.to_string()).unwrap();
    let restart = run_with_hooks_record(
        env!("CARGO_BIN_EXE_rccv3"),
        &state,
        &config_a,
        "restart",
        &install,
    );
    assert!(
        restart.status.success(),
        "{}",
        String::from_utf8_lossy(&restart.stderr)
    );
    wait_hooks_count(&marker, 2);
    let current = active_instance(&state);
    assert!(!current.join("hooks-sidecar-cleanup.json").exists());
    let replacement = hooks_record(&current);
    let mut replacement_group = OwnedHooksGroup {
        process_group_id: replacement["process_group_id"].as_i64().unwrap() as i32,
    };
    eprintln!(
        "P0 replacement hooks group={}",
        replacement_group.process_group_id
    );
    assert_ne!(replacement_group.process_group_id, group.process_group_id);
    group.assert_removed();
    let mut connection = TcpStream::connect(("127.0.0.1", ports[0])).unwrap();
    p0_responses_on_connection(&mut connection, ports[0], root.path());
    let stop = run_with_hooks_record(
        env!("CARGO_BIN_EXE_rccv3"),
        &state,
        &config_a,
        "stop",
        &install,
    );
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
    replacement_group.assert_removed();
}

struct HeldResponsesProvider {
    port: u16,
    received: std::sync::mpsc::Receiver<bool>,
    release: std::sync::Arc<std::sync::atomic::AtomicBool>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    task: Option<std::thread::JoinHandle<()>>,
}

impl HeldResponsesProvider {
    fn start() -> Self {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let (received_tx, received) = std::sync::mpsc::channel();
        let release = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let worker_release = release.clone();
        let worker_stop = stop.clone();
        let task = std::thread::spawn(move || {
            let mut requests = Vec::new();
            while !worker_stop.load(std::sync::atomic::Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("held provider accept: {error}"),
                };
                let release = worker_release.clone();
                let received = received_tx.clone();
                requests.push(std::thread::spawn(move || {
                    stream.set_nonblocking(false).unwrap();
                    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    assert!(line.starts_with("POST /v1/responses "), "{line}");
                    let mut length = None;
                    loop {
                        line.clear();
                        assert!(reader.read_line(&mut line).unwrap() > 0);
                        if line == "\r\n" { break; }
                        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                            length = Some(value.trim().parse::<usize>().unwrap());
                        }
                    }
                    let mut body = vec![0; length.unwrap()];
                    reader.read_exact(&mut body).unwrap();
                    let request: Value = serde_json::from_slice(&body).unwrap();
                    assert_eq!(request["model"], "wire-test");
                    assert_eq!(request["input"], "uncached connection probe");
                    let streaming = request["stream"].as_bool().unwrap_or(false);
                    received.send(streaming).unwrap();
                    let deadline = Instant::now() + Duration::from_secs(15);
                    while !release.load(std::sync::atomic::Ordering::SeqCst) {
                        assert!(Instant::now() < deadline, "held provider not released");
                        sleep(Duration::from_millis(5));
                    }
                    let response = serde_json::json!({
                        "id":"resp_p0_live", "object":"response", "created_at":0,
                        "status":"completed", "model":"wire-test",
                        "output":[{"id":"msg_p0_live","type":"message","role":"assistant",
                            "status":"completed","content":[{"type":"output_text",
                            "text":"uncached connection probe","annotations":[]}]}],
                        "usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}
                    });
                    let (content_type, body) = if streaming {
                        let created = serde_json::json!({"type":"response.created","response":{
                            "id":"resp_p0_live","object":"response","status":"in_progress",
                            "created_at":0,"model":"wire-test","output":[]
                        },"sequence_number":0});
                        let completed = serde_json::json!({"type":"response.completed","response":response,"sequence_number":1});
                        ("text/event-stream", format!("event: response.created\ndata: {created}\n\nevent: response.completed\ndata: {completed}\n\n"))
                    } else {
                        ("application/json", response.to_string())
                    };
                    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                }));
            }
            for request in requests {
                request.join().unwrap();
            }
        });
        Self {
            port,
            received,
            release,
            stop,
            task: Some(task),
        }
    }
}

impl Drop for HeldResponsesProvider {
    fn drop(&mut self) {
        self.release
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(task) = self.task.take() {
            let result = task.join();
            if !std::thread::panicking() {
                result.unwrap();
            }
        }
    }
}

fn send_responses(port: u16, root: &Path, streaming: bool) -> TcpStream {
    let mut connection = TcpStream::connect(("127.0.0.1", port)).unwrap();
    connection
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let body = serde_json::json!({"model":"test", "input":"uncached connection probe", "stream":streaming}).to_string();
    write!(connection, "POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nx-routecodex-workdir: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", root.display(), body.len()).unwrap();
    connection
}

#[test]
fn p0_restart_success_with_hooks_closes_inflight_json_and_sse_then_serves_new_requests() {
    let _guard = lifecycle_test_guard();
    let root = tempfile::Builder::new()
        .prefix("p0-hooks-")
        .tempdir_in("/tmp")
        .unwrap();
    let state = root.path().join("state");
    let ports = [free_port(), free_port()];
    let provider = HeldResponsesProvider::start();
    let config = write_config_with_provider(&root, ports, true, true, Some(provider.port));
    let config_b = root.path().join("config-b.toml");
    fs::copy(&config, &config_b).unwrap();
    let (install, marker) = configure_hooks(&root);
    let process = start_with_hooks(&root, &state, &config, &install);
    let old = active_instance(&state);
    wait_for_hooksd_marker(&old, &marker, "configured hooks did not start");
    let old_cache: Value =
        serde_json::from_slice(&fs::read(old.join("pid.cache")).unwrap()).unwrap();
    let old_record = hooks_record(&old);
    let mut old_group = OwnedHooksGroup {
        process_group_id: old_record["process_group_id"].as_i64().unwrap() as i32,
    };
    eprintln!(
        "P0 successful exec old hooks group={}",
        old_group.process_group_id
    );
    let mut json = send_responses(ports[0], root.path(), false);
    let mut sse = send_responses(ports[0], root.path(), true);
    let mut received = [
        provider
            .received
            .recv_timeout(Duration::from_secs(5))
            .unwrap(),
        provider
            .received
            .recv_timeout(Duration::from_secs(5))
            .unwrap(),
    ];
    received.sort();
    assert_eq!(
        received,
        [false, true],
        "both actual provider requests must be in flight"
    );
    let started = Instant::now();
    let restart = run_with_hooks_record(
        env!("CARGO_BIN_EXE_rccv3"),
        &state,
        &config_b,
        "restart",
        &install,
    );
    assert!(
        restart.status.success(),
        "{}",
        String::from_utf8_lossy(&restart.stderr)
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    wait_hooks_count(&marker, 2);
    let current = active_instance(&state);
    let new_cache: Value =
        serde_json::from_slice(&fs::read(current.join("pid.cache")).unwrap()).unwrap();
    assert_eq!(new_cache["pid"], process.pid);
    assert_ne!(new_cache["start_nonce"], old_cache["start_nonce"]);
    let replacement = hooks_record(&current);
    let mut new_group = OwnedHooksGroup {
        process_group_id: replacement["process_group_id"].as_i64().unwrap() as i32,
    };
    eprintln!(
        "P0 successful exec replacement hooks group={}",
        new_group.process_group_id
    );
    assert_ne!(new_group.process_group_id, old_group.process_group_id);
    old_group.assert_removed();
    assert!(!old.join("hooks-sidecar.pid").exists());
    assert!(!current.join("hooks-sidecar-cleanup.json").exists());
    for connection in [&mut json, &mut sse] {
        let mut bytes = Vec::new();
        let result = connection.read_to_end(&mut bytes);
        assert!(
            result.is_ok()
                || result
                    .as_ref()
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::ConnectionReset),
            "old accepted socket must close, not transfer: {result:?}"
        );
        let response = String::from_utf8_lossy(&bytes);
        assert!(
            !response.contains("resp_p0_live"),
            "old request fabricated completion: {response}"
        );
        assert!(!response.contains("response.failed") && !response.contains("event: error"));
    }
    provider
        .release
        .store(true, std::sync::atomic::Ordering::SeqCst);
    for port in ports {
        assert_eq!(http_get_json(port, "/health")["status"], "ok");
    }
    let mut connection = TcpStream::connect(("127.0.0.1", ports[0])).unwrap();
    p0_responses_on_connection(&mut connection, ports[0], root.path());
    let mut streaming = send_responses(ports[0], root.path(), true);
    let mut complete = String::new();
    streaming.read_to_string(&mut complete).unwrap();
    assert!(complete.starts_with("HTTP/1.1 200"), "{complete}");
    assert!(
        complete.contains("response.completed") && complete.contains("resp_p0_live"),
        "{complete}"
    );
    let stopped = Instant::now();
    let stop = run_with_hooks_record(
        env!("CARGO_BIN_EXE_rccv3"),
        &state,
        &config_b,
        "stop",
        &install,
    );
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
    assert!(stopped.elapsed() < Duration::from_secs(5));
    new_group.assert_removed();
    assert!(!current.join("hooks-sidecar.pid").exists());
    assert!(!current.join("hooks-sidecar.sock").exists());
}
