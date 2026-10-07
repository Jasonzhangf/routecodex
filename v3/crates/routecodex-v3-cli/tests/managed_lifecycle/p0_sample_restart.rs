use super::*;

fn start_sampling(root: &TempDir, state: &Path, config: &Path) -> P0ManagedProcess {
    let home = root.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let output = managed_test_command(env!("CARGO_BIN_EXE_rccv3"), state)
        .args(["server", "start", "--snapall", "--config"])
        .arg(config)
        .env("HOME", home)
        .env("ROUTECODEX_V3_STATE_DIR", state)
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let owner = single_instance_dir(state);
    let cache: Value = serde_json::from_slice(&fs::read(owner.join("pid.cache")).unwrap()).unwrap();
    let pid = cache["pid"].as_u64().unwrap() as u32;
    eprintln!("P0 r3 sampling PID={pid} root={}", root.path().display());
    P0ManagedProcess { pid }
}

fn wait_sample_responses(samples: &Path, expected: usize) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let complete = fs::read_dir(samples)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter(|entry| {
                let path = entry.path().join("response.json");
                fs::read(path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                    .is_some_and(|response| response["id"] == "resp_p0_live")
            })
            .count();
        if complete >= expected {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "complete samples={complete}, expected={expected}"
        );
        sleep(Duration::from_millis(5));
    }
}

#[test]
fn p0_restart_recovers_historical_sample_failure_and_retains_native_rejection_worker() {
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state = root.path().join("state");
    let ports = [free_port(), free_port()];
    let provider = P0Provider::start();
    let config = write_config_with_provider(&root, ports, true, true, Some(provider.port));
    let process = start_sampling(&root, &state, &config);
    let owner = single_instance_dir(&state);
    let control_bytes = fs::read(owner.join("control.json")).unwrap();
    let control: Value = serde_json::from_slice(&control_bytes).unwrap();
    let samples = root
        .path()
        .join("home/.rcc/codex-samples/openai-responses/ports")
        .join(ports[0].to_string());
    fs::create_dir_all(samples.parent().unwrap()).unwrap();
    fs::write(&samples, b"filesystem failure owned by r3 fixture").unwrap();
    let mut connection = TcpStream::connect(("127.0.0.1", ports[0])).unwrap();
    p0_responses_on_connection(&mut connection, ports[0], root.path());
    let log = owner.join("server.log");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if fs::read_to_string(&log)
            .unwrap()
            .contains("codex sample persist failed")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "missing real filesystem failure report: {}",
            fs::read_to_string(&log).unwrap()
        );
        sleep(Duration::from_millis(5));
    }
    fs::remove_file(&samples).unwrap();
    let sample_lock_path = root.path().join("home/.rcc/codex-samples/.retention.lock");
    let sample_lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(sample_lock_path)
        .unwrap();
    sample_lock.lock().unwrap();
    p0_responses_on_connection(&mut connection, ports[0], root.path());
    let replacement_image = root.path().join("rccv3-restart-client");
    fs::copy(env!("CARGO_BIN_EXE_rccv3"), &replacement_image).unwrap();
    fs::set_permissions(&replacement_image, fs::Permissions::from_mode(0o700)).unwrap();
    let replacement_image = fs::canonicalize(replacement_image).unwrap();
    let mut restart = managed_test_command(replacement_image.to_str().unwrap(), &state)
        .args(["restart", "--snapall", "--config"])
        .arg(&config)
        .env("HOME", root.path().join("home"))
        .env("ROUTECODEX_V3_STATE_DIR", &state)
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let restart_client_pid = restart.id();
    let deadline = Instant::now() + PORT_STATE_TIMEOUT;
    loop {
        let plan = fs::read(owner.join("restart.plan.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        if plan.is_some_and(|plan| {
            plan["executable_path"] == replacement_image.to_string_lossy().as_ref()
        }) {
            break;
        }
        if restart.try_wait().unwrap().is_some() {
            let output = restart.wait_with_output().unwrap();
            panic!(
                "real CLI exited before plan: status={} stdout={} stderr={}",
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        assert!(
            Instant::now() < deadline,
            "real CLI did not publish its typed restart plan"
        );
        sleep(Duration::from_millis(1));
    }
    let invalid_image = root.path().join("invalid-sample-replacement");
    fs::write(
        &invalid_image,
        b"#!/nonexistent/e208714-sample-interpreter\n",
    )
    .unwrap();
    fs::set_permissions(&invalid_image, fs::Permissions::from_mode(0o700)).unwrap();
    fs::rename(&invalid_image, &replacement_image).unwrap();
    drop(sample_lock);
    assert!(wait_for_child_exit(&mut restart, Duration::from_secs(5)));
    let output = restart.wait_with_output().unwrap();
    let reply = String::from_utf8_lossy(&output.stderr);
    assert!(
        !output.status.success(),
        "native exec rejection must be returned to actual CLI"
    );
    assert!(
        reply.contains("exec restart rejected; original owner retained"),
        "native exec must run despite diagnostic history: {reply}"
    );
    assert!(
        reply.contains("os error 2"),
        "fixture must exercise actual missing-interpreter exec rejection: {reply}"
    );
    assert_eq!(fs::read(owner.join("control.json")).unwrap(), control_bytes);
    let rejected_cache: Value =
        serde_json::from_slice(&fs::read(owner.join("pid.cache")).unwrap()).unwrap();
    assert_eq!(
        rejected_cache["pid"].as_u64().unwrap(),
        u64::from(process.pid)
    );
    assert_eq!(rejected_cache["start_nonce"], control["start_nonce"]);
    p0_responses_on_connection(&mut connection, ports[0], root.path());
    wait_sample_responses(&samples, 2);
    assert!(!owner.join("front-handoff.json").exists());
    assert!(!owner.join("provider-handoff.json").exists());
    let output = managed_test_command(env!("CARGO_BIN_EXE_rccv3"), &state)
        .args(["restart", "--snapall", "--config"])
        .arg(&config)
        .env("HOME", root.path().join("home"))
        .env("ROUTECODEX_V3_STATE_DIR", &state)
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "official restart failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cache: Value = serde_json::from_slice(&fs::read(owner.join("pid.cache")).unwrap()).unwrap();
    assert_eq!(cache["pid"].as_u64().unwrap(), u64::from(process.pid));
    assert_ne!(cache["start_nonce"], control["start_nonce"]);
    let mut next = TcpStream::connect(("127.0.0.1", ports[0])).unwrap();
    p0_responses_on_connection(&mut next, ports[0], root.path());
    wait_sample_responses(&samples, 3);
    assert!(fs::read_to_string(&log)
        .unwrap()
        .contains("codex sample persist failed"));
    drop(next);
    drop(connection);
    let pid = process.pid;
    drop(process);
    assert!(!owner.join("pid.cache").exists());
    let root_path = root.path().to_path_buf();
    drop(root);
    assert!(!root_path.exists());
    eprintln!(
        "P0 r3 PID={pid} and restart CLI PID={restart_client_pid} exited; owned fixture root removed={}",
        root_path.display()
    );
}
