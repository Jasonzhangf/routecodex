use routecodex_v3_hooks::{register_shared_project, AppServerSocketConfig, SharedProjectConfig};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};
use tempfile::TempDir;

fn wait(label: &str, mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !predicate() {
        assert!(Instant::now() < deadline, "{label} timed out");
        sleep(Duration::from_millis(20));
    }
}

fn exchange(stream: &mut UnixStream, request: Value) -> Value {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    writeln!(stream, "{request}").unwrap();
    let mut line = String::new();
    BufReader::new(stream.try_clone().unwrap())
        .read_line(&mut line)
        .unwrap();
    serde_json::from_str(&line).unwrap()
}

fn control(project: &Path, request: Value) -> Value {
    exchange(
        &mut UnixStream::connect(project.join("hooks-sidecar.sock")).unwrap(),
        request,
    )
}

struct Daemon {
    home: TempDir,
    child: Child,
    socket: PathBuf,
}

impl Daemon {
    fn start() -> Self {
        Self::start_with_config_link(false)
    }

    fn start_with_config_link(link_config: bool) -> Self {
        let home = tempfile::tempdir().unwrap();
        if link_config {
            let target = home.path().join("external-rcc");
            std::fs::create_dir(&target).unwrap();
            std::os::unix::fs::symlink(&target, home.path().join(".rcc")).unwrap();
        }
        let socket = home.path().join(".rcc/hooks/daemon.sock");
        let child = Command::new(env!("CARGO_BIN_EXE_rccv3-hooksd"))
            .arg("--shared-daemon")
            .env("HOME", home.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut daemon = Self {
            home,
            child,
            socket,
        };
        wait("daemon listener", || {
            assert!(
                daemon.child.try_wait().unwrap().is_none(),
                "daemon exited before listening"
            );
            daemon.socket.exists()
        });
        daemon
    }

    fn project(&self, name: &str) -> PathBuf {
        let path = self.home.path().join(name);
        std::fs::create_dir(&path).unwrap();
        std::fs::canonicalize(path).unwrap()
    }

    fn register(&self, path: &Path) -> (UnixStream, Value) {
        let mut lease = UnixStream::connect(&self.socket).unwrap();
        let response = exchange(
            &mut lease,
            json!({"method":"register", "params": {
                "instance_dir": path, "appserver_sockets": {}, "handlers_config": null
            }}),
        );
        (lease, response)
    }

    fn release(&self, lease: &mut UnixStream) {
        let response = exchange(lease, json!({"method":"release"}));
        assert_eq!(response["ok"], true, "{response}");
    }

    fn idle_exit(&mut self) {
        wait("last lease idle exit", || {
            self.child.try_wait().unwrap().is_some()
        });
        assert!(!self.socket.exists());
    }
}

#[test]
fn configured_rcc_symlink_uses_one_canonical_daemon_and_reclaims_project() {
    let mut daemon = Daemon::start_with_config_link(true);
    let project = daemon.project("project");
    let (mut lease, response) = daemon.register(&project);
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["daemon_pid"], daemon.child.id());
    assert!(daemon
        .home
        .path()
        .join("external-rcc/hooks/daemon.sock")
        .exists());
    daemon.release(&mut lease);
    assert!(!project.join("hooks-sidecar.sock").exists());
    daemon.idle_exit();
    assert!(daemon.home.path().join(".rcc").is_symlink());
}

impl Drop for Daemon {
    fn drop(&mut self) {
        match self.child.try_wait() {
            Ok(None) => {
                if let Err(error) = self.child.kill() {
                    eprintln!("test daemon kill failed: {error}");
                }
            }
            Ok(Some(_)) => {}
            Err(error) => eprintln!("test daemon status failed: {error}"),
        }
        if let Err(error) = self.child.wait() {
            eprintln!("test daemon reap failed: {error}");
        }
    }
}

#[test]
fn projects_share_one_pid_and_isolate_same_named_handlers() {
    let mut daemon = Daemon::start();
    let a = daemon.project("a");
    let b = daemon.project("b");
    let (mut a_lease, a_response) = daemon.register(&a);
    let (mut b_lease, b_response) = daemon.register(&b);
    assert_eq!(a_response["ok"], true, "{a_response}");
    assert_eq!(b_response["ok"], true, "{b_response}");
    assert_eq!(a_response["daemon_pid"], daemon.child.id());
    assert_eq!(a_response["daemon_pid"], b_response["daemon_pid"]);
    assert_ne!(
        a_response["registration_generation"],
        b_response["registration_generation"]
    );
    for (project, strategy) in [
        (&a, json!({"type":"no_op"})),
        (
            &b,
            json!({"type":"command", "command":"/bin/sh", "args":["-c", "printf invalid"]}),
        ),
    ] {
        assert_eq!(
            control(
                project,
                json!({"method":"mount_handler", "params":{
                    "handler_id":"same", "hook_kind":"stop", "strategy":strategy
                }})
            )["ok"],
            true
        );
    }
    let dispatch = json!({"method":"dispatch_hook_event", "params":{
        "event":{"event_name":"Stop", "hook_kind":"stop", "source":null},
        "state":{"status":"idle", "detail":null}
    }});
    assert_eq!(control(&a, dispatch.clone())["ok"], true);
    assert_eq!(control(&b, dispatch)["ok"], false);
    assert!(a.join("hooks-sidecar-state.json").exists());
    assert!(b.join("hooks-sidecar-state.json").exists());
    let (_, duplicate) = daemon.register(&a);
    assert_eq!(duplicate["ok"], false);
    daemon.release(&mut a_lease);
    assert!(!a.join("hooks-sidecar.sock").exists());
    assert!(
        a.join("hooks-sidecar-state.json").exists(),
        "release must preserve state"
    );
    assert_eq!(control(&b, json!({"method":"health"}))["ok"], true);
    assert!(daemon.child.try_wait().unwrap().is_none());
    daemon.release(&mut b_lease);
    daemon.idle_exit();
}

#[test]
fn thirty_release_cycles_do_not_accumulate_project_sockets_or_workers() {
    let mut daemon = Daemon::start();
    let anchor = daemon.project("anchor");
    let (mut anchor_lease, response) = daemon.register(&anchor);
    assert_eq!(response["ok"], true);
    let project = daemon.project("cycle");
    let thread_count = || {
        let output = Command::new("ps")
            .args(["-M", "-p", &daemon.child.id().to_string()])
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap().lines().count()
    };
    let baseline_threads = thread_count();
    for _ in 0..30 {
        let (mut lease, response) = daemon.register(&project);
        assert_eq!(response["ok"], true, "{response}");
        assert_eq!(response["daemon_pid"], daemon.child.id());
        let mut idle_reader = UnixStream::connect(project.join("hooks-sidecar.sock")).unwrap();
        idle_reader
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        daemon.release(&mut lease);
        use std::io::Read;
        assert_eq!(
            idle_reader.read(&mut [0]).unwrap(),
            0,
            "blocked business streams must close"
        );
        assert!(!project.join("hooks-sidecar.sock").exists());
        assert_eq!(control(&anchor, json!({"method":"health"}))["ok"], true);
    }
    wait("all released project workers reclaimed", || {
        thread_count() <= baseline_threads + 1
    });
    daemon.release(&mut anchor_lease);
    daemon.idle_exit();
}

#[test]
fn failed_registration_and_duplicate_daemon_preserve_live_projects() {
    let mut daemon = Daemon::start();
    let project = daemon.project("live");
    let (mut lease, response) = daemon.register(&project);
    assert_eq!(response["ok"], true);
    let duplicate = Command::new(env!("CARGO_BIN_EXE_rccv3-hooksd"))
        .arg("--shared-daemon")
        .env("HOME", daemon.home.path())
        .output()
        .unwrap();
    assert!(!duplicate.status.success());
    assert!(daemon.socket.exists());
    assert_eq!(control(&project, json!({"method":"health"}))["ok"], true);
    let bad = daemon.project("invalid");
    let response = exchange(
        &mut UnixStream::connect(&daemon.socket).unwrap(),
        json!({"method":"register", "params":{
            "instance_dir":bad, "appserver_sockets":{},
            "handlers_config":{"schema_version":9, "handlers":[]}
        }}),
    );
    assert_eq!(response["ok"], false);
    assert!(!bad.join("hooks-sidecar.sock").exists());
    let (mut valid, response) = daemon.register(&bad);
    assert_eq!(
        response["ok"], true,
        "failed setup must release its reservation: {response}"
    );
    daemon.release(&mut valid);
    daemon.release(&mut lease);
    daemon.idle_exit();
}

#[test]
fn partial_handshake_has_an_absolute_deadline_and_no_owner_idle_is_finite() {
    let mut daemon = Daemon::start();
    let start = Instant::now();
    let mut stream = UnixStream::connect(&daemon.socket).unwrap();
    stream.write_all(b"{").unwrap();
    sleep(Duration::from_secs(3));
    stream.write_all(b" ").unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(4)))
        .unwrap();
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["ok"], false);
    assert!(start.elapsed() < Duration::from_secs(7));
    daemon.idle_exit();
}

#[test]
fn slow_command_is_cancelled_and_drained_on_project_release() {
    let mut daemon = Daemon::start();
    let project = daemon.project("slow");
    let marker = project.join("started");
    let response = exchange(
        &mut UnixStream::connect(&daemon.socket).unwrap(),
        json!({"method":"health"}),
    );
    assert_eq!(response["ok"], true);
    let (mut lease, response) = daemon.register(&project);
    assert_eq!(response["ok"], true);
    assert_eq!(
        control(
            &project,
            json!({"method":"mount_handler", "params":{
                "handler_id":"slow", "hook_kind":"stop", "strategy":{
                    "type":"command", "command":"/bin/sh", "args":["-c", format!("printf '%s' $$ > '{}'; sleep 60", marker.display())]
                }
            }})
        )["ok"],
        true
    );
    let mut business = UnixStream::connect(project.join("hooks-sidecar.sock")).unwrap();
    writeln!(business, "{}", json!({"method":"dispatch_hook_event", "params":{
        "event":{"event_name":"Stop","hook_kind":"stop","source":null},"state":{"status":"idle","detail":null}
    }})).unwrap();
    wait("command start marker", || marker.exists());
    let command_pid: i32 = std::fs::read_to_string(&marker).unwrap().parse().unwrap();
    assert_eq!(
        control(&project, json!({"method":"health"}))["ok"],
        true,
        "a busy handler must not block endpoint health"
    );
    let start = Instant::now();
    daemon.release(&mut lease);
    assert!(start.elapsed() < Duration::from_secs(3));
    assert!(!project.join("hooks-sidecar.sock").exists());
    assert_eq!(
        unsafe { libc::kill(command_pid, 0) },
        -1,
        "command must be reaped before the release ACK"
    );
    daemon.idle_exit();
}

#[test]
#[ignore = "subprocess fixture for the owner SIGKILL test"]
fn owner_process_fixture() {
    let directory =
        std::fs::canonicalize(std::env::var_os("HOOKS_OWNER_PROJECT").unwrap()).unwrap();
    let lease = register_shared_project(
        Path::new(env!("CARGO_BIN_EXE_rccv3-hooksd")),
        SharedProjectConfig {
            instance_dir: directory,
            appserver_sockets: AppServerSocketConfig::default(),
            handlers_config: None,
        },
        Duration::from_secs(10),
    )
    .unwrap();
    println!("LEASE_READY:{}", lease.daemon_pid);
    std::io::stdout().flush().unwrap();
    if std::env::var_os("HOOKS_OWNER_EXEC").is_some() {
        use std::os::unix::process::CommandExt;
        panic!(
            "exec failed: {}",
            Command::new("/bin/sleep").arg("30").exec()
        );
    }
    loop {
        std::hint::black_box(&lease);
        std::thread::park();
    }
}

#[test]
fn sigkill_of_project_owner_reclaims_only_its_registration() {
    let mut daemon = Daemon::start();
    let a = daemon.project("crash");
    let b = daemon.project("survivor");
    let (mut b_lease, response) = daemon.register(&b);
    assert_eq!(response["ok"], true);
    let mut owner = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "owner_process_fixture",
            "--ignored",
            "--nocapture",
        ])
        .env("HOME", daemon.home.path())
        .env("HOOKS_OWNER_PROJECT", &a)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut reader = BufReader::new(owner.stdout.take().unwrap());
    let mut line = String::new();
    loop {
        line.clear();
        assert!(
            reader.read_line(&mut line).unwrap() != 0,
            "owner exited before registration"
        );
        if line.contains("LEASE_READY:") {
            break;
        }
    }
    assert!(a.join("hooks-sidecar.sock").exists());
    owner.kill().unwrap();
    owner.wait().unwrap();
    wait("crashed project socket cleanup", || {
        !a.join("hooks-sidecar.sock").exists()
    });
    assert!(daemon.child.try_wait().unwrap().is_none());
    assert_eq!(control(&b, json!({"method":"health"}))["ok"], true);
    daemon.release(&mut b_lease);
    daemon.idle_exit();
}

#[test]
fn blocked_native_handshake_is_cancelled_before_project_cleanup_ack() {
    let mut daemon = Daemon::start();
    let project = daemon.project("native");
    let native_socket = daemon.home.path().join("native.sock");
    let listener = std::os::unix::net::UnixListener::bind(&native_socket).unwrap();
    let (accepted_tx, accepted_rx) = std::sync::mpsc::channel();
    let peer = std::thread::spawn(move || {
        use std::io::Read;
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        accepted_tx.send(()).unwrap();
        // Read the upgrade request but never send a response. Project release
        // must interrupt the client's native read and close this connection.
        loop {
            if stream.read(&mut [0; 4096]).unwrap() == 0 {
                break;
            }
        }
    });
    let mut lease = UnixStream::connect(&daemon.socket).unwrap();
    assert_eq!(
        exchange(
            &mut lease,
            json!({"method":"register", "params":{
                "instance_dir":project, "appserver_sockets":{"default":native_socket}, "handlers_config":null
            }})
        )["ok"],
        true
    );
    let mut business = UnixStream::connect(project.join("hooks-sidecar.sock")).unwrap();
    writeln!(business, "{}", json!({"method":"session_status", "params":{"target":{
        "namespace":"codex_tui", "appserver_id":"native", "scope_id":"default", "session_id":"thread", "thread_id":"thread"
    }}})).unwrap();
    accepted_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let start = Instant::now();
    daemon.release(&mut lease);
    assert!(start.elapsed() < Duration::from_secs(3));
    peer.join().unwrap();
    assert!(!project.join("hooks-sidecar.sock").exists());
    daemon.idle_exit();
}

#[test]
fn blocked_web_search_child_is_cancelled_and_reaped_before_release_ack() {
    let mut daemon = Daemon::start();
    let project = daemon.project("search");
    let marker = project.join("search-pid");
    let mut lease = UnixStream::connect(&daemon.socket).unwrap();
    assert_eq!(
        exchange(
            &mut lease,
            json!({"method":"register", "params":{
                "instance_dir":project, "appserver_sockets":{}, "handlers_config":{
                    "schema_version":1, "handlers":[], "web_search_adapter":{
                        "command":"/bin/sh", "args":["-c", format!("printf '%s' $$ > '{}'; sleep 60", marker.display())], "timeout_ms":60000
                    }
                }
            }})
        )["ok"],
        true
    );
    let mut business = UnixStream::connect(project.join("hooks-sidecar.sock")).unwrap();
    let deadline = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 60000;
    writeln!(business, "{}", json!({"method":"execute_web_search", "params":{"request":{
        "requestId":"request", "callId":"call", "query":"routecodex", "count":3,
        "recency":null, "contentTypes":["text"], "deadlineUnixMs":deadline, "policyId":"local",
        "scope":{"entryEndpoint":"/v1/responses", "sessionId":"s", "conversationId":"c", "port":5520,"routingGroup":"default"}
    }}})).unwrap();
    wait("web search child", || marker.exists());
    let pid: i32 = std::fs::read_to_string(&marker).unwrap().parse().unwrap();
    let start = Instant::now();
    daemon.release(&mut lease);
    assert!(start.elapsed() < Duration::from_secs(3));
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    assert!(!project.join("hooks-sidecar.sock").exists());
    daemon.idle_exit();
}

#[test]
fn foreign_project_socket_and_symlink_state_are_preserved_and_registration_fails() {
    let mut daemon = Daemon::start();
    let project = daemon.project("foreign");
    let foreign =
        std::os::unix::net::UnixListener::bind(project.join("hooks-sidecar.sock")).unwrap();
    let (_, response) = daemon.register(&project);
    assert_eq!(response["ok"], false);
    assert!(project.join("hooks-sidecar.sock").exists());
    drop(foreign);
    std::fs::remove_file(project.join("hooks-sidecar.sock")).unwrap();
    let target = daemon.home.path().join("foreign-state");
    std::fs::write(&target, "untouched").unwrap();
    std::os::unix::fs::symlink(&target, project.join("hooks-sidecar-state.json")).unwrap();
    let (_, response) = daemon.register(&project);
    assert_eq!(response["ok"], false);
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "untouched");
    assert!(!project.join("hooks-sidecar.sock").exists());
    daemon.idle_exit();
}

#[test]
fn simultaneous_clients_launch_one_daemon_and_exec_does_not_inherit_the_lease() {
    let home = tempfile::tempdir().unwrap();
    let a = home.path().join("a");
    let b = home.path().join("b");
    std::fs::create_dir(&a).unwrap();
    std::fs::create_dir(&b).unwrap();
    let launch = |project: &Path, exec: bool| {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "owner_process_fixture",
                "--ignored",
                "--nocapture",
            ])
            .env("HOME", home.path())
            .env("HOOKS_OWNER_PROJECT", project)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        if exec {
            command.env("HOOKS_OWNER_EXEC", "1");
        }
        command.spawn().unwrap()
    };
    let mut owner_a = launch(&a, true);
    let mut owner_b = launch(&b, false);
    let ready_pid = |owner: &mut Child| {
        let mut reader = BufReader::new(owner.stdout.take().unwrap());
        loop {
            let mut line = String::new();
            assert_ne!(reader.read_line(&mut line).unwrap(), 0);
            if let Some(pid) = line.trim().strip_prefix("LEASE_READY:") {
                return pid.parse::<u32>().unwrap();
            }
        }
    };
    let pid = ready_pid(&mut owner_a);
    assert_eq!(pid, ready_pid(&mut owner_b));
    wait("CLOEXEC project cleanup", || {
        !a.join("hooks-sidecar.sock").exists()
    });
    assert!(
        owner_a.try_wait().unwrap().is_none(),
        "new executable is still alive"
    );
    assert_eq!(control(&b, json!({"method":"health"}))["ok"], true);
    owner_a.kill().unwrap();
    owner_a.wait().unwrap();
    owner_b.kill().unwrap();
    owner_b.wait().unwrap();
    wait("last crashed owner project cleanup", || {
        !b.join("hooks-sidecar.sock").exists()
    });
    wait(
        "shared orphan daemon bounded exit",
        || unsafe { libc::kill(pid as i32, 0) } == -1,
    );
    assert!(!home.path().join(".rcc/hooks/daemon.sock").exists());
}

#[test]
fn same_schedule_and_persisted_intent_identifiers_remain_project_local() {
    let mut daemon = Daemon::start();
    let a = daemon.project("state-a");
    let b = daemon.project("state-b");
    let target = json!({"namespace":"codex_tui", "appserver_id":"native", "scope_id":"default", "session_id":"s", "thread_id":"s"});
    for (project, body) in [(&a, "A"), (&b, "B")] {
        std::fs::write(project.join("hooks-sidecar-state.json"), json!({
            "schema_version":1, "intents":{"same":{
                "intent":{"intent_id":"same", "source":target, "target":target, "body":body, "send_mode":"working_allowed"},
                "phase":"failed", "error":format!("previous {body} failure")
            }}
        }).to_string()).unwrap();
    }
    let (mut a_lease, response) = daemon.register(&a);
    assert_eq!(response["ok"], true);
    let (mut b_lease, response) = daemon.register(&b);
    assert_eq!(response["ok"], true);
    for (project, body) in [(&a, "A"), (&b, "B")] {
        assert_eq!(
            control(
                project,
                json!({"method":"intent_evidence", "params":{"intent_id":"same"}})
            )["result"]["intent"]["intent"]["body"],
            body
        );
        assert_eq!(
            control(
                project,
                json!({"method":"schedule_upsert", "params":{"schedule":{
                    "id":"same", "at_iso8601":"2099-01-01T00:00:00Z", "registrant":target, "body":body, "send_mode":"idle_only"
                }}})
            )["ok"],
            true
        );
    }
    assert_eq!(
        control(
            &a,
            json!({"method":"schedule_remove", "params":{"schedule_id":"same"}})
        )["ok"],
        true
    );
    let a_state: Value =
        serde_json::from_slice(&std::fs::read(a.join("hooks-sidecar-state.json")).unwrap())
            .unwrap();
    let b_state: Value =
        serde_json::from_slice(&std::fs::read(b.join("hooks-sidecar-state.json")).unwrap())
            .unwrap();
    assert!(a_state["schedules"].as_object().unwrap().is_empty());
    assert_eq!(b_state["schedules"]["same"]["body"], "B");
    daemon.release(&mut a_lease);
    assert_eq!(
        control(
            &b,
            json!({"method":"intent_evidence", "params":{"intent_id":"same"}})
        )["result"]["intent"]["intent"]["body"],
        "B"
    );
    daemon.release(&mut b_lease);
    daemon.idle_exit();
}
