use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

fn unique_socket_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "rccv3-hooksd-parent-exit-{}-{}.sock",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn wait_for_exit(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return true;
        }
        sleep(Duration::from_millis(50));
    }
    false
}

#[test]
fn hooksd_exits_after_recorded_parent_is_gone() {
    let socket = unique_socket_path();
    let state_file = socket.with_extension("state.json");
    let expected_parent = std::process::id() as libc::pid_t + 1;
    let mut child = Command::new(env!("CARGO_BIN_EXE_rccv3-hooksd"))
        .arg("--socket")
        .arg(&socket)
        .arg("--state-file")
        .arg(&state_file)
        .env("ROUTECODEX_HOOKSD_PARENT_PID", expected_parent.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let pid = child.id();

    assert!(
        wait_for_exit(&mut child, Duration::from_secs(5)),
        "rccv3-hooksd PID {pid} must exit after its recorded parent PID {expected_parent} is gone"
    );
    let _ = child.wait();
    let _ = fs::remove_file(socket);
    let _ = fs::remove_file(state_file);
}
