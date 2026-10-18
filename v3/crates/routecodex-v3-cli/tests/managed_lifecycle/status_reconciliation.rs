use super::*;

#[test]
fn status_does_not_mask_corrupted_control_with_stale_stopped_record() {
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state_root = root.path().join("state");
    let ports = [free_port(), free_port()];
    let config = write_config(&root, ports);
    let binary = env!("CARGO_BIN_EXE_rccv3");

    let start = run(binary, &state_root, &config, "start");
    assert!(
        start.status.success(),
        "{}",
        String::from_utf8_lossy(&start.stderr)
    );
    for port in ports {
        wait_port(port, true);
    }
    let initial_status = status_json(binary, &state_root, &config);
    assert_eq!(initial_status["state"], "running");
    let instance_id = initial_status["instance_id"].as_str().unwrap().to_string();

    let instance_dir = single_instance_dir(&state_root);
    let pid_cache_raw = fs::read(instance_dir.join("pid.cache")).unwrap();
    let pid_cache: Value = serde_json::from_slice(&pid_cache_raw).unwrap();
    let child_pid = pid_cache["pid"].as_u64().unwrap() as u32;

    // Overwrite status.json with a stale stopped record.
    let stale_status = serde_json::json!({
        "schema_version": 1,
        "instance_id": instance_id,
        "state": "stopped",
        "updated_at_epoch_ms": 1792241460392_u64,
        "detail": "forced scoped listener shutdown after graceful stop timeout"
    });
    fs::write(
        instance_dir.join("status.json"),
        serde_json::to_vec_pretty(&stale_status).unwrap(),
    )
    .unwrap();

    // Corrupt control.json start_nonce while child process is still alive.
    let control_raw = fs::read(instance_dir.join("control.json")).unwrap();
    let mut control: Value = serde_json::from_slice(&control_raw).unwrap();
    control["start_nonce"] = serde_json::json!("corrupted-start-nonce-test");
    fs::write(
        instance_dir.join("control.json"),
        serde_json::to_vec_pretty(&control).unwrap(),
    )
    .unwrap();

    // Query status: unfixed code masks control failure into Ok(Stopped).
    // Fixed code MUST NOT mask control failure as stopped when process/control failed.
    let status_out = run(binary, &state_root, &config, "status");

    // Clean up child process before assertions
    unsafe {
        libc::kill(child_pid as libc::pid_t, libc::SIGTERM);
    }
    for port in ports {
        wait_port(port, false);
    }

    assert!(
        !status_out.status.success(),
        "status must fail when control is corrupted/failing rather than report stale stopped: stdout={}",
        String::from_utf8_lossy(&status_out.stdout)
    );
}

#[test]
fn status_does_not_mask_corrupted_control_across_same_config_digest_drift() {
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state_root = root.path().join("state");
    let ports = [free_port(), free_port()];
    let config = write_config(&root, ports);
    let binary = env!("CARGO_BIN_EXE_rccv3");

    let start = run(binary, &state_root, &config, "start");
    assert!(
        start.status.success(),
        "{}",
        String::from_utf8_lossy(&start.stderr)
    );
    for port in ports {
        wait_port(port, true);
    }
    let initial_status = status_json(binary, &state_root, &config);
    assert_eq!(initial_status["state"], "running");
    let instance_id = initial_status["instance_id"].as_str().unwrap().to_string();

    let instance_dir = state_root.join("instances").join(&instance_id);
    let pid_cache_raw = fs::read(instance_dir.join("pid.cache")).unwrap();
    let pid_cache: Value = serde_json::from_slice(&pid_cache_raw).unwrap();
    let child_pid = pid_cache["pid"].as_u64().unwrap() as u32;

    // Drift the config digest while keeping the exact same config_path and listener set.
    let mut config_content = fs::read_to_string(&config).unwrap();
    config_content.push_str("\n# config digest drift comment\n");
    fs::write(&config, config_content).unwrap();

    // Corrupt old live owner control.json start_nonce while child process is still alive.
    let control_raw = fs::read(instance_dir.join("control.json")).unwrap();
    let mut control: Value = serde_json::from_slice(&control_raw).unwrap();
    control["start_nonce"] = serde_json::json!("corrupted-start-nonce-drift-test");
    fs::write(
        instance_dir.join("control.json"),
        serde_json::to_vec_pretty(&control).unwrap(),
    )
    .unwrap();

    // Query status on drifted config: must NOT mask corrupted control into Ok(Stopped).
    let status_out = run(binary, &state_root, &config, "status");

    // Clean up child process before assertions
    unsafe {
        libc::kill(child_pid as libc::pid_t, libc::SIGTERM);
    }
    for port in ports {
        wait_port(port, false);
    }

    assert!(
        !status_out.status.success(),
        "status on drifted config must fail with error when live owner control is corrupted rather than report stopped: stdout={}",
        String::from_utf8_lossy(&status_out.stdout)
    );
}

#[test]
fn status_reports_live_owner_across_executable_copy() {
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state_root = root.path().join("state");
    let ports = [free_port(), free_port()];
    let config = write_config(&root, ports);
    let source_binary = env!("CARGO_BIN_EXE_rccv3");
    let release_a = copy_release_binary(source_binary, &root.path().join("release-a"));
    let release_b = copy_release_binary(source_binary, &root.path().join("release-b"));

    let start = run(release_a.to_str().unwrap(), &state_root, &config, "start");
    assert!(
        start.status.success(),
        "{}",
        String::from_utf8_lossy(&start.stderr)
    );
    for port in ports {
        wait_port(port, true);
    }

    let status_b = run(release_b.to_str().unwrap(), &state_root, &config, "status");
    assert!(
        status_b.status.success(),
        "status from copied executable must succeed: {}",
        String::from_utf8_lossy(&status_b.stderr)
    );
    let status_val = last_json(&status_b);
    let stop = run(release_a.to_str().unwrap(), &state_root, &config, "stop");
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
    for port in ports {
        wait_port(port, false);
    }

    assert_eq!(
        status_val["state"], "running",
        "status from copied executable must report live state rather than fabricated stopped"
    );
}

#[test]
fn status_reports_live_owner_across_same_config_digest_drift() {
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state_root = root.path().join("state");
    let ports = [free_port(), free_port()];
    let config = write_config(&root, ports);
    let binary = env!("CARGO_BIN_EXE_rccv3");

    let start = run(binary, &state_root, &config, "start");
    assert!(
        start.status.success(),
        "{}",
        String::from_utf8_lossy(&start.stderr)
    );
    for port in ports {
        wait_port(port, true);
    }
    let initial_status = status_json(binary, &state_root, &config);
    assert_eq!(initial_status["state"], "running");
    let initial_instance_id = initial_status["instance_id"].as_str().unwrap().to_string();

    // Drift the config digest while keeping the exact same config_path and listener set.
    let mut config_content = fs::read_to_string(&config).unwrap();
    config_content.push_str("\n# config digest drift comment\n");
    fs::write(&config, config_content).unwrap();

    let drifted_status = run(binary, &state_root, &config, "status");
    assert!(
        drifted_status.status.success(),
        "status query on drifted config must succeed: {}",
        String::from_utf8_lossy(&drifted_status.stderr)
    );
    let drifted_val = last_json(&drifted_status);

    // Stop using the original running instance
    let stop = run(binary, &state_root, &config, "stop");
    let _ = stop;
    // Also ensure child process is cleaned up
    let instance_dir = state_root.join("instances").join(&initial_instance_id);
    if let Ok(pid_bytes) = fs::read(instance_dir.join("pid.cache")) {
        if let Ok(pid_val) = serde_json::from_slice::<Value>(&pid_bytes) {
            if let Some(pid) = pid_val["pid"].as_u64() {
                unsafe {
                    libc::kill(pid as libc::pid_t, libc::SIGTERM);
                }
            }
        }
    }
    for port in ports {
        wait_port(port, false);
    }

    assert_eq!(
        drifted_val["state"], "running",
        "status on same config path with drifted digest must report live running owner"
    );
    assert_eq!(
        drifted_val["instance_id"], initial_instance_id,
        "status on drifted config must report the live owner's instance_id"
    );
}

#[test]
fn status_does_not_adopt_foreign_config_with_same_ports() {
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state_root = root.path().join("state");
    let shared_port = free_port();
    let inactive_port_a = free_port();
    let inactive_port_b = free_port();

    let config_a = write_config_with_server_b_enabled(
        &root,
        "config-a.v3.toml",
        [shared_port, inactive_port_a],
        false,
    );
    let config_b = write_config_with_server_b_enabled(
        &root,
        "config-b.v3.toml",
        [shared_port, inactive_port_b],
        false,
    );
    let binary = env!("CARGO_BIN_EXE_rccv3");

    // Start config_b
    let start_b = run(binary, &state_root, &config_b, "start");
    assert!(
        start_b.status.success(),
        "{}",
        String::from_utf8_lossy(&start_b.stderr)
    );
    wait_port(shared_port, true);

    // Check status of config_a: config_a has NEVER started, but shares port with config_b
    let status_a = run(binary, &state_root, &config_a, "status");
    assert!(
        status_a.status.success(),
        "{}",
        String::from_utf8_lossy(&status_a.stderr)
    );
    let status_a_val = last_json(&status_a);

    let stop_b = run(binary, &state_root, &config_b, "stop");
    assert!(
        stop_b.status.success(),
        "{}",
        String::from_utf8_lossy(&stop_b.stderr)
    );
    wait_port(shared_port, false);

    assert_eq!(
        status_a_val["state"], "stopped",
        "status for unstarted config_a must be stopped and must NOT adopt foreign config_b"
    );
}

#[test]
fn status_skips_confirmed_dead_candidate_and_reports_later_live_candidate() {
    let _guard = lifecycle_test_guard();
    let root = TempDir::new().unwrap();
    let state_root = root.path().join("state");
    let ports = [free_port(), free_port()];
    let config = write_config(&root, ports);
    let binary = env!("CARGO_BIN_EXE_rccv3");

    // 1. Start candidate A
    let start_a = run(binary, &state_root, &config, "start");
    assert!(
        start_a.status.success(),
        "{}",
        String::from_utf8_lossy(&start_a.stderr)
    );
    for port in ports {
        wait_port(port, true);
    }
    let status_a = status_json(binary, &state_root, &config);
    let instance_a = status_a["instance_id"].as_str().unwrap().to_string();

    // Stop candidate A cleanly so it is confirmed dead
    let stop_a = run(binary, &state_root, &config, "stop");
    assert!(
        stop_a.status.success(),
        "{}",
        String::from_utf8_lossy(&stop_a.stderr)
    );
    for port in ports {
        wait_port(port, false);
    }

    // 2. Drift config to candidate B
    let mut config_content = fs::read_to_string(&config).unwrap();
    config_content.push_str("\n# candidate B drift comment\n");
    fs::write(&config, &config_content).unwrap();

    let start_b = run(binary, &state_root, &config, "start");
    assert!(
        start_b.status.success(),
        "{}",
        String::from_utf8_lossy(&start_b.stderr)
    );
    for port in ports {
        wait_port(port, true);
    }
    let status_b = status_json(binary, &state_root, &config);
    let instance_b = status_b["instance_id"].as_str().unwrap().to_string();
    assert_ne!(instance_a, instance_b);

    // 3. Drift config to candidate C (unstarted)
    config_content.push_str("# candidate C drift comment\n");
    fs::write(&config, config_content).unwrap();

    // Query status on candidate C:
    // Candidate A is dead, Candidate B is live.
    // Status must skip candidate A and return candidate B!
    let status_c = run(binary, &state_root, &config, "status");
    assert!(
        status_c.status.success(),
        "{}",
        String::from_utf8_lossy(&status_c.stderr)
    );
    let status_c_val = last_json(&status_c);

    // Clean up candidate B
    let instance_dir_b = state_root.join("instances").join(&instance_b);
    if let Ok(pid_bytes) = fs::read(instance_dir_b.join("pid.cache")) {
        if let Ok(pid_val) = serde_json::from_slice::<Value>(&pid_bytes) {
            if let Some(pid) = pid_val["pid"].as_u64() {
                unsafe {
                    libc::kill(pid as libc::pid_t, libc::SIGTERM);
                }
            }
        }
    }
    for port in ports {
        wait_port(port, false);
    }

    assert_eq!(
        status_c_val["state"], "running",
        "status must report running state from live candidate B, skipping dead candidate A"
    );
    assert_eq!(
        status_c_val["instance_id"], instance_b,
        "status must report live candidate B instance_id"
    );
}
