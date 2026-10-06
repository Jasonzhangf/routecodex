use super::*;
use routecodex_v3_lifecycle::V3ManagedLifecycle;

struct UnrelatedProcess(Child);

impl Drop for UnrelatedProcess {
    fn drop(&mut self) {
        if self.0.try_wait().unwrap().is_none() {
            self.0.kill().unwrap();
        }
        self.0.wait().unwrap();
    }
}

fn assert_occupied_target_rejected(previous_handler: bool, direct_control: bool) {
    let _guard = lifecycle_test_guard();
    let root = tempfile::Builder::new()
        .prefix("p0-hooks-target-")
        .tempdir_in("/tmp")
        .unwrap();
    let state = root.path().join("state");
    let ports = [free_port(), free_port()];
    let provider = P0Provider::start();
    let config = write_config_with_provider(&root, ports, false, true, Some(provider.port));
    let _current = (!previous_handler).then(|| p0_start(&root, &state, &config));
    let _previous = previous_handler.then(|| {
        previous_release_restart::start_previous_release(&root, &state, &config, ports[0])
    });
    let original = single_instance_dir(&state);
    let before: Vec<_> = ["pid.cache", "control.json", "instance.json"]
        .into_iter()
        .map(|name| (name, fs::read(original.join(name)).unwrap()))
        .collect();
    let cache: Value = serde_json::from_slice(&before[0].1).unwrap();
    let control: Value = serde_json::from_slice(&before[1].1).unwrap();
    let mut connection = TcpStream::connect(("127.0.0.1", ports[0])).unwrap();
    p0_responses_on_connection(&mut connection, ports[0], root.path());
    let target_config = root.path().join("target.v3.toml");
    fs::copy(&config, &target_config).unwrap();
    let executable = env!("CARGO_BIN_EXE_rccv3");
    let (declaration, _) = V3ManagedLifecycle::new(&target_config)
        .unwrap()
        .declaration(executable)
        .unwrap();
    let target = original.parent().unwrap().join(&declaration.instance_id);
    fs::create_dir(&target).unwrap();
    let retained = b"{\"instance_id\":\"retained-unrelated-owner\"}\n";
    let association = target.join("hooks-sidecar-cleanup.json");
    fs::write(&association, retained).unwrap();
    let mut unrelated = UnrelatedProcess(Command::new("sleep").arg("120").spawn().unwrap());
    let unrelated_dir = original.parent().unwrap().join("retained-unrelated-owner");
    fs::create_dir(&unrelated_dir).unwrap();
    let unrelated_record = unrelated_dir.join("hooks-sidecar.pid");
    let unrelated_bytes = serde_json::json!({"pid": unrelated.0.id()}).to_string();
    fs::write(&unrelated_record, &unrelated_bytes).unwrap();
    if direct_control {
        fs::write(
            original.join("restart.plan.json"),
            serde_json::json!({
                "schema_version": 1,
                "instance_id": control["instance_id"],
                "start_nonce": control["start_nonce"],
                "executable_path": executable,
                "target_declaration": declaration,
                "snapshots": false,
                "snapshot_direct": false,
                "snapshot_stages": null,
                "sse_dump": false
            })
            .to_string(),
        )
        .unwrap();
        let mut stream = p0_control_stream(&control);
        stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        writeln!(
            stream,
            "{}",
            serde_json::json!({
                "schema_version": 1, "instance_id": control["instance_id"],
                "start_nonce": control["start_nonce"], "operation": "restart", "ports": null
            })
        )
        .unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        let response: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["accepted"], false, "{response}");
        assert!(
            response["message"]
                .as_str()
                .unwrap()
                .contains("target instance already retains unresolved hooks cleanup ownership"),
            "{response}"
        );
    } else {
        let output = managed_test_command(executable, &state)
            .args(["restart", "--config"])
            .arg(&target_config)
            .args(["--timeout-ms", "10000"])
            .env("HOME", root.path().join("home"))
            .env("ROUTECODEX_V3_STATE_DIR", &state)
            .env("V3_MANAGED_TEST_KEY", SECRET)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("target instance already retains unresolved hooks cleanup ownership"),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    p0_responses_on_connection(&mut connection, ports[0], root.path());
    for (name, bytes) in &before {
        assert_eq!(fs::read(original.join(name)).unwrap(), *bytes);
    }
    assert_eq!(fs::read(&association).unwrap(), retained);
    assert_eq!(
        fs::read(&unrelated_record).unwrap(),
        unrelated_bytes.as_bytes()
    );
    assert!(unrelated.0.try_wait().unwrap().is_none());
    assert!(!target.join("control.json").exists());
    assert!(!target.join("pid.cache").exists());
    assert!(!target.join("previous-release-restart.json").exists());
    let mut independent = TcpStream::connect(("127.0.0.1", ports[0])).unwrap();
    p0_responses_on_connection(&mut independent, ports[0], root.path());
    fs::remove_file(&association).unwrap();
    let accepted = managed_test_command(executable, &state)
        .args(["restart", "--config"])
        .arg(&target_config)
        .args(["--timeout-ms", "10000"])
        .env("HOME", root.path().join("home"))
        .env("ROUTECODEX_V3_STATE_DIR", &state)
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .output()
        .unwrap();
    assert!(
        accepted.status.success(),
        "{}",
        String::from_utf8_lossy(&accepted.stderr)
    );
    let after: Value =
        serde_json::from_slice(&fs::read(target.join("pid.cache")).unwrap()).unwrap();
    assert_eq!(after["pid"], cache["pid"]);
    assert_eq!(after["process_start_token"], cache["process_start_token"]);
    assert_ne!(after["start_nonce"], cache["start_nonce"]);
    let mut fresh = TcpStream::connect(("127.0.0.1", ports[0])).unwrap();
    p0_responses_on_connection(&mut fresh, ports[0], root.path());
    assert!(unrelated.0.try_wait().unwrap().is_none());
    assert_eq!(
        fs::read(&unrelated_record).unwrap(),
        unrelated_bytes.as_bytes()
    );
}

#[test]
fn occupied_hooks_target_rejects_current_cli_before_dispatch() {
    assert_occupied_target_rejected(false, false);
}

#[test]
fn occupied_hooks_target_rejects_previous_handler_before_dispatch() {
    assert_occupied_target_rejected(true, false);
}

#[test]
fn occupied_hooks_target_rejects_current_control_before_exec() {
    assert_occupied_target_rejected(false, true);
}
