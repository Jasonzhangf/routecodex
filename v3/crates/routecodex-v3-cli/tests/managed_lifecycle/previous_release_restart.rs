use super::*;

pub(super) struct PreviousReleaseRuntime {
    child: Child,
}

impl Drop for PreviousReleaseRuntime {
    fn drop(&mut self) {
        if self.child.try_wait().unwrap().is_none() {
            unsafe { libc::kill(self.child.id() as libc::pid_t, libc::SIGTERM) };
        }
        self.child.wait().unwrap();
    }
}

fn previous_release_binary() -> PathBuf {
    let binary = PathBuf::from(
        std::env::var_os("ROUTECODEX_V3_PREVIOUS_RELEASE_BINARY")
            .expect("provide a pinned real previous-release rccv3 for the one-step migration gate"),
    );
    let output = Command::new(&binary).arg("--version").output().unwrap();
    assert!(output.status.success());
    let version = String::from_utf8_lossy(&output.stdout);
    // CI builds the pinned 4836 source release; the live regression also uses
    // the separately recorded installed 4837 artifact with the old handler.
    assert!(
        version.contains("0.90.4836") || version.contains("0.90.4837"),
        "migration requires the previous handler, not a candidate-first upgrade"
    );
    binary
}

pub(super) fn start_previous_release(
    root: &TempDir,
    state: &Path,
    config: &Path,
    port: u16,
) -> PreviousReleaseRuntime {
    let home = root.path().join("home");
    fs::create_dir(&home).unwrap();
    let old = previous_release_binary();
    let log = fs::File::create(root.path().join("previous-runtime.log")).unwrap();
    let mut runtime = PreviousReleaseRuntime {
        child: managed_test_command(old.to_str().unwrap(), state)
            .args(["start", "--config"])
            .arg(config)
            .env("HOME", &home)
            .env("ROUTECODEX_V3_STATE_DIR", state)
            .env("V3_MANAGED_TEST_KEY", SECRET)
            .stdout(log.try_clone().unwrap())
            .stderr(log)
            .spawn()
            .unwrap(),
    };
    let deadline = Instant::now() + PORT_STATE_TIMEOUT;
    while TcpStream::connect(("127.0.0.1", port)).is_err() {
        assert!(runtime.child.try_wait().unwrap().is_none());
        assert!(Instant::now() < deadline);
        sleep(Duration::from_millis(20));
    }
    runtime
}

fn assert_previous_release_one_step(path_change: bool) {
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state = root.path().join("state");
    let ports = [free_port(), free_port()];
    let provider = P0Provider::start();
    let config = write_config_with_provider(&root, ports, false, true, Some(provider.port));
    let runtime = start_previous_release(&root, &state, &config, ports[0]);
    let home = root.path().join("home");
    let previous = single_instance_dir(&state);
    let before: Value =
        serde_json::from_slice(&fs::read(previous.join("pid.cache")).unwrap()).unwrap();
    let session = unsafe { libc::getsid(runtime.child.id() as libc::pid_t) };
    let mut connection = TcpStream::connect(("127.0.0.1", ports[0])).unwrap();
    p0_responses_on_connection(&mut connection, ports[0], root.path());
    drop(connection);
    let target_config = if path_change {
        let target = root.path().join("changed.v3.toml");
        fs::copy(&config, &target).unwrap();
        target
    } else {
        write_config_with_provider(&root, ports, false, false, Some(provider.port))
    };
    let output = managed_test_command(env!("CARGO_BIN_EXE_rccv3"), &state)
        .args(["restart", "--config"])
        .arg(&target_config)
        .args(["--timeout-ms", "10000"])
        .env("HOME", &home)
        .env("ROUTECODEX_V3_STATE_DIR", &state)
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "one official restart: {}; runtime={}",
        String::from_utf8_lossy(&output.stderr),
        fs::read_to_string(root.path().join("previous-runtime.log")).unwrap()
    );
    let owners = fs::read_dir(state.join("instances"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|directory| directory.join("pid.cache").exists())
        .collect::<Vec<_>>();
    assert_eq!(owners.len(), 1, "{owners:?}");
    let after: Value =
        serde_json::from_slice(&fs::read(owners[0].join("pid.cache")).unwrap()).unwrap();
    assert_eq!(after["pid"], before["pid"]);
    assert_eq!(after["pid"].as_u64(), Some(u64::from(runtime.child.id())));
    assert_eq!(after["process_start_token"], before["process_start_token"]);
    assert_ne!(after["start_nonce"], before["start_nonce"]);
    assert_ne!(after["instance_id"], before["instance_id"]);
    let controls = fs::read_dir(state.join("instances"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|directory| directory.join("control.json").exists())
        .collect::<Vec<_>>();
    assert_eq!(controls, owners, "one authoritative control owner");
    let control: Value =
        serde_json::from_slice(&fs::read(owners[0].join("control.json")).unwrap()).unwrap();
    assert_eq!(control["instance_id"], after["instance_id"]);
    assert_eq!(control["start_nonce"], after["start_nonce"]);
    assert_eq!(
        unsafe { libc::getsid(runtime.child.id() as libc::pid_t) },
        session
    );
    assert!(!previous.join("control.json").exists());
    assert!(!owners[0].join("previous-release-restart.json").exists());
    for port in ports {
        assert_eq!(http_get_json(port, "/health")["status"], "ok");
    }
    let mut connection = TcpStream::connect(("127.0.0.1", ports[0])).unwrap();
    p0_responses_on_connection(&mut connection, ports[0], root.path());
    eprintln!("previous-release ONE-STEP PASS path_change={path_change} before={before} after={after} state={}", state.display());
}

#[test]
fn previous_release_one_step_content_change() {
    assert_previous_release_one_step(false);
}

#[test]
fn previous_release_one_step_config_path_change() {
    assert_previous_release_one_step(true);
}

#[test]
fn previous_release_transfer_rejects_wrong_stale_and_malformed_identity() {
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state = root.path().join("state");
    let ports = [free_port(), free_port()];
    let provider = P0Provider::start();
    let config = write_config_with_provider(&root, ports, false, true, Some(provider.port));
    let runtime = start_previous_release(&root, &state, &config, ports[0]);
    let owner = single_instance_dir(&state);
    let original = fs::read(owner.join("pid.cache")).unwrap();
    let control = fs::read(owner.join("control.json")).unwrap();
    write_config_with_provider(&root, ports, false, false, Some(provider.port));
    for field in ["instance_id", "start_nonce", "process_start_token"] {
        let mut damaged: Value = serde_json::from_slice(&original).unwrap();
        damaged[field] = Value::String("not-the-owned-identity".into());
        fs::write(owner.join("pid.cache"), damaged.to_string()).unwrap();
        let output = run_with_timeout(
            env!("CARGO_BIN_EXE_rccv3"),
            &state,
            &config,
            "restart",
            2000,
        );
        fs::write(owner.join("pid.cache"), &original).unwrap();
        assert!(!output.status.success(), "must reject {field}");
        assert_eq!(fs::read(owner.join("control.json")).unwrap(), control);
        let mut connection = TcpStream::connect(("127.0.0.1", ports[0])).unwrap();
        p0_responses_on_connection(&mut connection, ports[0], root.path());
    }
    let mut unrelated_pid: Value = serde_json::from_slice(&original).unwrap();
    unrelated_pid["pid"] = Value::from(std::process::id());
    fs::write(owner.join("pid.cache"), unrelated_pid.to_string()).unwrap();
    let output = run_with_timeout(
        env!("CARGO_BIN_EXE_rccv3"),
        &state,
        &config,
        "restart",
        2000,
    );
    fs::write(owner.join("pid.cache"), &original).unwrap();
    assert!(!output.status.success(), "must not signal unrelated PID");
    assert_eq!(fs::read(owner.join("control.json")).unwrap(), control);
    let lifecycle = routecodex_v3_lifecycle::V3ManagedLifecycle::new(&config).unwrap();
    let (target, _) = lifecycle.declaration(env!("CARGO_BIN_EXE_rccv3")).unwrap();
    let target_dir = state.join("instances").join(&target.instance_id);
    fs::create_dir_all(&target_dir).unwrap();
    let conflict = target_dir.join("previous-release-restart.json");
    fs::write(&conflict, "malformed-existing-intent").unwrap();
    let output = run_with_timeout(
        env!("CARGO_BIN_EXE_rccv3"),
        &state,
        &config,
        "restart",
        2000,
    );
    assert!(!output.status.success());
    assert_eq!(
        fs::read_to_string(&conflict).unwrap(),
        "malformed-existing-intent"
    );
    assert_eq!(fs::read(owner.join("control.json")).unwrap(), control);
    let mut connection = TcpStream::connect(("127.0.0.1", ports[0])).unwrap();
    p0_responses_on_connection(&mut connection, ports[0], root.path());
    assert_eq!(
        serde_json::from_slice::<Value>(&original).unwrap()["pid"].as_u64(),
        Some(u64::from(runtime.child.id()))
    );
}

#[test]
fn previous_release_transfer_rejects_listener_drift_and_invalid_auth_before_dispatch() {
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state = root.path().join("state");
    let ports = [free_port(), free_port()];
    let provider = P0Provider::start();
    let config = write_config_with_provider(&root, ports, false, true, Some(provider.port));
    let _runtime = start_previous_release(&root, &state, &config, ports[0]);
    let owner = single_instance_dir(&state);
    let control = fs::read(owner.join("control.json")).unwrap();
    let original = fs::read_to_string(&config).unwrap();
    write_config_with_provider(
        &root,
        [ports[0], free_port()],
        false,
        true,
        Some(provider.port),
    );
    let drift = run_with_timeout(
        env!("CARGO_BIN_EXE_rccv3"),
        &state,
        &config,
        "restart",
        2000,
    );
    assert!(
        !drift.status.success(),
        "unsupported listener drift must reject before exec"
    );
    assert_eq!(fs::read(owner.join("control.json")).unwrap(), control);
    let mut connection = TcpStream::connect(("127.0.0.1", ports[0])).unwrap();
    p0_responses_on_connection(&mut connection, ports[0], root.path());
    fs::write(
        &config,
        original.replace("V3_MANAGED_TEST_KEY", "V3_MIGRATION_MISSING_KEY"),
    )
    .unwrap();
    let auth = managed_test_command(env!("CARGO_BIN_EXE_rccv3"), &state)
        .args(["restart", "--config"])
        .arg(&config)
        .args(["--timeout-ms", "2000"])
        .env("ROUTECODEX_V3_STATE_DIR", &state)
        .env_remove("V3_MIGRATION_MISSING_KEY")
        .output()
        .unwrap();
    assert!(
        !auth.status.success(),
        "invalid target auth must reject before exec"
    );
    assert_eq!(fs::read(owner.join("control.json")).unwrap(), control);
    let mut connection = TcpStream::connect(("127.0.0.1", ports[0])).unwrap();
    p0_responses_on_connection(&mut connection, ports[0], root.path());
}
