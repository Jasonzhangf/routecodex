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
    wait_for_hooksd_marker(
        &instance,
        &root.path().join("hooks/started"),
        "configured hooks did not start",
    );
    // The marker precedes readiness processing and the atomic socket-identity
    // update. Tests must snapshot or mutate the fully published owner record.
    let deadline = Instant::now() + HOOKS_MARKER_TIMEOUT;
    while hooks_record(&instance)["control_socket_identity"].is_null() {
        assert!(
            Instant::now() < deadline,
            "hooks control socket identity was not published: {}",
            hooks_record(&instance)
        );
        sleep(Duration::from_millis(10));
    }
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
        Self::start_with_text("uncached connection probe".into())
    }

    fn start_with_text(response_text: String) -> Self {
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
                let response_text = response_text.clone();
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
                    let business = request["input"] == "uncached connection probe";
                    let streaming = request["stream"].as_bool().unwrap_or(false);
                    if business { received.send(streaming).unwrap(); }
                    let deadline = Instant::now() + Duration::from_secs(15);
                    while business && !release.load(std::sync::atomic::Ordering::SeqCst) {
                        assert!(Instant::now() < deadline, "held provider not released");
                        sleep(Duration::from_millis(5));
                    }
                    let response = serde_json::json!({
                        "id":"resp_p0_live", "object":"response", "created_at":0,
                        "status":"completed", "model":"wire-test",
                        "output":[{"id":"msg_p0_live","type":"message","role":"assistant",
                            "status":"completed","content":[{"type":"output_text",
                            "text":if business { response_text.as_str() } else { "pong" },"annotations":[]}]}],
                        "usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}
                    });
                    let (content_type, body) = if streaming {
                        let created = serde_json::json!({"type":"response.created","response":{
                            "id":"resp_p0_live","object":"response","status":"in_progress",
                            "created_at":0,"model":"wire-test","output":[]
                        },"sequence_number":0});
                        let mut events = format!("event: response.created\ndata: {created}\n\n");
                        let mut terminal = response.clone();
                        if business && response_text.len() > 1024 * 1024 {
                            // A compact completion follows individually complete output
                            // items. Every SSE frame stays below the declared limit.
                            for (index, chunk) in response_text.as_bytes().chunks(512 * 1024).enumerate() {
                                let item = serde_json::json!({"type":"response.output_item.done","output_index":index,"sequence_number":index+1,"item":{
                                    "id":format!("msg_p0_live_{index}"),"type":"message","role":"assistant","status":"completed",
                                    "content":[{"type":"output_text","text":std::str::from_utf8(chunk).unwrap(),"annotations":[]}]}});
                                events.push_str(&format!("event: response.output_item.done\ndata: {item}\n\n"));
                            }
                            terminal["output"] = serde_json::json!([]);
                        }
                        let completed = serde_json::json!({"type":"response.completed","response":terminal,"sequence_number":events.matches("event: ").count()});
                        events.push_str(&format!("event: response.completed\ndata: {completed}\n\n"));
                        ("text/event-stream", events)
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
        .set_read_timeout(Some(Duration::from_secs(60)))
        .unwrap();
    let body = serde_json::json!({"model":"test", "input":"uncached connection probe", "stream":streaming}).to_string();
    write!(connection, "POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nx-routecodex-workdir: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", root.display(), body.len()).unwrap();
    connection
}

fn spawn_with_hooks_record(
    binary: &str,
    state_root: &Path,
    config: &Path,
    command: &str,
    hooks_record: &Path,
    extra_args: &[&str],
) -> Child {
    let mut process = managed_test_command(binary, state_root);
    process
        .args(["server", command, "--config"])
        .arg(config)
        .env("ROUTECODEX_V3_STATE_DIR", state_root)
        .env(
            "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
            request_counter_file(state_root),
        )
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .env("ROUTECODEX_HOOKS_INSTALL_RECORD", hooks_record)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for argument in extra_args {
        process.arg(argument);
    }
    process.spawn().unwrap()
}

fn wait_for_child_output(mut child: Child, timeout: Duration) -> Output {
    let deadline = Instant::now() + timeout;
    while child.try_wait().unwrap().is_none() {
        assert!(
            Instant::now() < deadline,
            "managed child did not exit in time"
        );
        sleep(Duration::from_millis(20));
    }
    child.wait_with_output().unwrap()
}

fn read_stream_to_end(mut stream: TcpStream) -> std::io::Result<Vec<u8>> {
    stream
        .set_read_timeout(Some(Duration::from_secs(60)))
        .unwrap();
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn decode_backpressure_body(raw: &[u8]) -> Vec<u8> {
    let head_end = raw.windows(4).position(|part| part == b"\r\n\r\n").unwrap() + 4;
    let head = std::str::from_utf8(&raw[..head_end])
        .unwrap()
        .to_ascii_lowercase();
    let mut body = &raw[head_end..];
    if head.contains("transfer-encoding: chunked") {
        let mut decoded = Vec::new();
        loop {
            let end = body
                .windows(2)
                .position(|part| part == b"\r\n")
                .expect("complete chunk size");
            let size = usize::from_str_radix(
                std::str::from_utf8(&body[..end])
                    .unwrap()
                    .split(';')
                    .next()
                    .unwrap(),
                16,
            )
            .unwrap();
            body = &body[end + 2..];
            if size == 0 {
                assert_eq!(body, b"\r\n", "complete HTTP chunk tail");
                return decoded;
            }
            assert!(body.len() >= size + 2, "complete HTTP chunk");
            decoded.extend_from_slice(&body[..size]);
            assert_eq!(&body[size..size + 2], b"\r\n");
            body = &body[size + 2..];
        }
    }
    if let Some(length) = head
        .lines()
        .find_map(|line| line.strip_prefix("content-length:"))
    {
        assert_eq!(body.len(), length.trim().parse::<usize>().unwrap());
    }
    body.to_vec()
}

#[derive(Clone, Copy)]
enum BackpressureEnd {
    Complete,
    Cancel,
    Disconnect,
}

fn read_backpressure_head(response: &mut TcpStream) -> Vec<u8> {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        response.read_exact(&mut byte).unwrap();
        head.push(byte[0]);
    }
    assert!(head.starts_with(b"HTTP/1.1 200"));
    head
}

fn assert_backpressure_content(raw: &[u8], text: &str, streaming: bool) {
    let response = String::from_utf8(decode_backpressure_body(raw)).unwrap();
    if streaming {
        assert_eq!(response.matches("event: response.completed").count(), 1);
        let actual = response
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .map(|data| serde_json::from_str::<Value>(data).unwrap())
            .filter(|event| event["type"] == "response.output_item.done")
            .map(|event| {
                event["item"]["content"][0]["text"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect::<String>();
        assert_eq!(actual.len(), text.len());
        assert!(actual == text, "complete SSE output items and final tail");
    } else {
        let actual: Value = serde_json::from_str(&response).unwrap();
        let actual = actual["output"][0]["content"][0]["text"].as_str().unwrap();
        assert_eq!(actual.len(), text.len());
        assert!(actual == text, "complete JSON output and final tail");
    }
}

fn restart_waits_for_backpressured_response(streaming: bool, end: BackpressureEnd) {
    let _guard = lifecycle_test_guard();
    let root = tempfile::Builder::new()
        .prefix("p0-backpressure-")
        .tempdir_in("/tmp")
        .unwrap();
    let state = root.path().join("state");
    let ports = [free_port(), free_port()];
    let text = format!("{}TAIL_BACKPRESSURE_COMPLETE", "x".repeat(12 * 1024 * 1024));
    let provider = HeldResponsesProvider::start_with_text(text.clone());
    let config = write_config_with_provider(&root, ports, false, false, Some(provider.port));
    let (install, marker) = configure_hooks(&root);
    let process = start_with_hooks(&root, &state, &config, &install);
    let old = active_instance(&state);
    wait_for_hooksd_marker(&old, &marker, "backpressure hooks started");
    let old_cache: Value =
        serde_json::from_slice(&fs::read(old.join("pid.cache")).unwrap()).unwrap();
    let mut response = send_responses(ports[0], root.path(), streaming);
    assert_eq!(
        provider
            .received
            .recv_timeout(Duration::from_secs(5))
            .unwrap(),
        streaming
    );
    provider
        .release
        .store(true, std::sync::atomic::Ordering::SeqCst);
    // Read just the head, then leave a response larger than the TCP buffers unread.
    let mut prefix = read_backpressure_head(&mut response);
    let mut other = if matches!(end, BackpressureEnd::Disconnect) {
        let mut socket = send_responses(ports[0], root.path(), true);
        assert!(provider
            .received
            .recv_timeout(Duration::from_secs(5))
            .unwrap());
        let head = read_backpressure_head(&mut socket);
        Some((socket, head))
    } else {
        None
    };
    let mut restart = spawn_with_hooks_record(
        env!("CARGO_BIN_EXE_rccv3"),
        &state,
        &config,
        "restart",
        &install,
        if matches!(end, BackpressureEnd::Cancel) {
            &["--timeout-ms", "2000"]
        } else {
            &[]
        },
    );
    let queued = if matches!(end, BackpressureEnd::Cancel) {
        sleep(Duration::from_millis(300));
        let socket = send_responses(ports[0], root.path(), false);
        assert!(
            provider
                .received
                .recv_timeout(Duration::from_millis(300))
                .is_err(),
            "dispatch waits during maintenance"
        );
        Some(socket)
    } else {
        None
    };
    sleep(Duration::from_secs(3));
    let premature = restart.try_wait().unwrap();
    if matches!(end, BackpressureEnd::Cancel) {
        assert!(
            premature.is_some_and(|status| !status.success()),
            "operation timeout must reject restart"
        );
        assert!(!wait_for_child_output(restart, Duration::from_secs(10))
            .status
            .success());
        assert!(
            !provider
                .received
                .recv_timeout(Duration::from_secs(5))
                .unwrap(),
            "queued dispatch resumes"
        );
        let after = active_instance(&state);
        let cache: Value =
            serde_json::from_slice(&fs::read(after.join("pid.cache")).unwrap()).unwrap();
        assert_eq!(cache["pid"], process.pid);
        assert_eq!(cache["start_nonce"], old_cache["start_nonce"]);
        assert_eq!(fs::read_to_string(&marker).unwrap().lines().count(), 1);
        prefix.extend(read_stream_to_end(response).unwrap());
        assert_backpressure_content(&prefix, &text, streaming);
        let queued = read_stream_to_end(queued.unwrap()).unwrap();
        assert_backpressure_content(&queued, &text, false);
        restart = spawn_with_hooks_record(
            env!("CARGO_BIN_EXE_rccv3"),
            &state,
            &config,
            "restart",
            &install,
            &[],
        );
    } else {
        assert!(
            premature.is_none(),
            "restart completed with a backpressured response: {premature:?}"
        );
        if matches!(end, BackpressureEnd::Disconnect) {
            drop(response);
            sleep(Duration::from_millis(300));
            assert!(
                restart.try_wait().unwrap().is_none(),
                "other healthy SSE must remain protected after disconnect"
            );
            let (socket, mut head) = other.take().unwrap();
            head.extend(read_stream_to_end(socket).unwrap());
            assert_backpressure_content(&head, &text, true);
        } else {
            prefix.extend(read_stream_to_end(response).unwrap());
            assert_backpressure_content(&prefix, &text, streaming);
        }
    }
    let restart = wait_for_child_output(restart, Duration::from_secs(30));
    assert!(
        restart.status.success(),
        "{}",
        String::from_utf8_lossy(&restart.stderr)
    );
    let current = active_instance(&state);
    let cache: Value =
        serde_json::from_slice(&fs::read(current.join("pid.cache")).unwrap()).unwrap();
    assert_eq!(cache["pid"], process.pid);
    assert_ne!(cache["start_nonce"], old_cache["start_nonce"]);
    wait_hooks_count(&marker, 2);
    for port in ports {
        assert_eq!(http_get_json(port, "/health")["status"], "ok");
    }
    let fresh = read_stream_to_end(send_responses(ports[0], root.path(), false)).unwrap();
    assert_backpressure_content(&fresh, &text, false);
    let stop = run_with_hooks_record(
        env!("CARGO_BIN_EXE_rccv3"),
        &state,
        &config,
        "stop",
        &install,
    );
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
}

#[test]
fn p0_restart_waits_for_backpressured_json_transport() {
    restart_waits_for_backpressured_response(false, BackpressureEnd::Complete);
}

#[test]
fn p0_restart_waits_for_backpressured_sse_transport() {
    restart_waits_for_backpressured_response(true, BackpressureEnd::Complete);
}

#[test]
fn p0_restart_backpressure_json_cancellation_preserves_owner_and_dispatch() {
    restart_waits_for_backpressured_response(false, BackpressureEnd::Cancel);
}

#[test]
fn p0_restart_backpressure_sse_cancellation_preserves_owner_and_dispatch() {
    restart_waits_for_backpressured_response(true, BackpressureEnd::Cancel);
}

#[test]
fn p0_restart_backpressure_disconnect_releases_only_failed_transport() {
    restart_waits_for_backpressured_response(false, BackpressureEnd::Disconnect);
}

#[test]
fn p0_restart_success_with_hooks_drains_inflight_json_and_sse_then_serves_new_requests() {
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
    let json_reader = std::thread::spawn(move || read_stream_to_end(json));
    let sse_reader = std::thread::spawn(move || read_stream_to_end(sse));
    let started = Instant::now();
    let mut restart = spawn_with_hooks_record(
        env!("CARGO_BIN_EXE_rccv3"),
        &state,
        &config_b,
        "restart",
        &install,
        &[],
    );
    // The provider stays healthy and held beyond the retired fixed drain
    // window. A restart that force-cuts healthy client bodies finishes here.
    sleep(Duration::from_secs(6));
    assert!(
        restart.try_wait().unwrap().is_none(),
        "managed restart must wait for healthy in-flight client responses before exec"
    );
    assert!(
        !json_reader.is_finished() && !sse_reader.is_finished(),
        "healthy in-flight client transports must stay live while restart drains"
    );
    provider
        .release
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let json_body = String::from_utf8(json_reader.join().unwrap().unwrap()).unwrap();
    let sse_body = String::from_utf8(sse_reader.join().unwrap().unwrap()).unwrap();
    assert!(
        json_body.starts_with("HTTP/1.1 200") && json_body.contains("resp_p0_live"),
        "held JSON response must complete: {json_body}"
    );
    assert!(
        sse_body.starts_with("HTTP/1.1 200") && sse_body.contains("response.completed"),
        "held SSE response must complete: {sse_body}"
    );
    assert_eq!(
        sse_body.matches("event: response.completed").count(),
        1,
        "held SSE response must carry exactly one completion: {sse_body}"
    );
    let restart = wait_for_child_output(restart, Duration::from_secs(30));
    assert!(
        restart.status.success(),
        "{}",
        String::from_utf8_lossy(&restart.stderr)
    );
    assert!(
        started.elapsed() >= Duration::from_secs(6),
        "restart must complete only after the in-flight bodies drained, took {:?}",
        started.elapsed()
    );
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

#[test]
fn p0_restart_operation_budget_cancels_drain_and_resumes_queued_dispatch() {
    let _guard = lifecycle_test_guard();
    let root = tempfile::Builder::new()
        .prefix("p0-hooks-")
        .tempdir_in("/tmp")
        .unwrap();
    let state = root.path().join("state");
    let ports = [free_port(), free_port()];
    let provider = HeldResponsesProvider::start();
    let config = write_config_with_provider(&root, ports, true, true, Some(provider.port));
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

    let mut held = send_responses(ports[0], root.path(), true);
    assert!(
        provider
            .received
            .recv_timeout(Duration::from_secs(5))
            .unwrap(),
        "the held client must be an in-flight streaming request"
    );
    let restart = spawn_with_hooks_record(
        env!("CARGO_BIN_EXE_rccv3"),
        &state,
        &config,
        "restart",
        &install,
        &["--timeout-ms", "2000"],
    );
    sleep(Duration::from_millis(700));
    let mut queued = send_responses(ports[0], root.path(), false);
    assert!(
        provider
            .received
            .recv_timeout(Duration::from_millis(300))
            .is_err(),
        "new dispatch must wait at the maintenance gate instead of reaching the provider"
    );

    let restart = wait_for_child_output(restart, Duration::from_secs(20));
    assert!(
        !restart.status.success(),
        "the expired restart budget must not report success: {}",
        String::from_utf8_lossy(&restart.stderr)
    );
    assert_eq!(
        provider
            .received
            .recv_timeout(Duration::from_secs(5))
            .expect("cancelled maintenance must resume the queued dispatch"),
        false,
        "the queued JSON request must reach the provider after cancellation"
    );
    provider
        .release
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let held_body = String::from_utf8(read_stream_to_end(held).unwrap()).unwrap();
    let queued_body = String::from_utf8(read_stream_to_end(queued).unwrap()).unwrap();
    assert!(
        held_body.starts_with("HTTP/1.1 200") && held_body.contains("response.completed"),
        "the pending SSE response must complete after restart cancellation: {held_body}"
    );
    assert!(
        queued_body.starts_with("HTTP/1.1 200") && queued_body.contains("resp_p0_live"),
        "the queued response must complete after restart cancellation: {queued_body}"
    );
    let after = active_instance(&state);
    let after_cache: Value =
        serde_json::from_slice(&fs::read(after.join("pid.cache")).unwrap()).unwrap();
    assert_eq!(after_cache["pid"], process.pid);
    assert_eq!(after_cache["start_nonce"], old_cache["start_nonce"]);
    assert_eq!(
        fs::read_to_string(&marker).unwrap().lines().count(),
        1,
        "cancelled restart must retain the original hooks owner"
    );
    assert_eq!(hooks_record(&old), old_record);
    let mut connection = TcpStream::connect(("127.0.0.1", ports[0])).unwrap();
    p0_responses_on_connection(&mut connection, ports[0], root.path());

    let stop = run_with_hooks_record(
        env!("CARGO_BIN_EXE_rccv3"),
        &state,
        &config,
        "stop",
        &install,
    );
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
    old_group.assert_removed();
}
