use routecodex_v3_lifecycle::{V3LifecycleError, V3ManagedLifecycle};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tempfile::TempDir;

const HELPER_MODE_ENV: &str = "S12_OPERATION_LOCK_HELPER_MODE";
const HELPER_CONFIG_ENV: &str = "S12_OPERATION_LOCK_CONFIG";
const HELPER_STATE_ENV: &str = "S12_OPERATION_LOCK_STATE";
const HELPER_SCRIPT_ENV: &str = "S12_OPERATION_LOCK_SCRIPT";
const HELPER_TIMEOUT_MS_ENV: &str = "S12_OPERATION_LOCK_TIMEOUT_MS";
const LOCK_WAIT_TIMEOUT: Duration = Duration::from_secs(10);

static TEST_LOCK: Mutex<()> = Mutex::new(());

struct PublicLockFixture {
    _root: TempDir,
    config: PathBuf,
    state: PathBuf,
    script: PathBuf,
    invocations: PathBuf,
}

impl PublicLockFixture {
    fn new() -> Self {
        let root = TempDir::new().unwrap();
        let config = root.path().join("config.v3.toml");
        let state = root.path().join("state");
        let script = root.path().join("managed-child-helper.sh");
        let invocations = root.path().join("invocations.log");
        let port = free_port_file(root.path());
        fs::write(
            &config,
            format!(
                r#"version = 3
[servers.test]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
[providers.test]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", api_key = "inline-test-key" }}] }}
[providers.test.models.test]
wire_name = "test"
capabilities = ["text"]
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }}]
"#
            ),
        )
        .unwrap();
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$$\" >> \"{}\"\nsleep 30\n",
                invocations.display()
            ),
        )
        .unwrap();
        let mut permissions = fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&script, permissions).unwrap();
        Self {
            _root: root,
            config,
            state,
            script,
            invocations,
        }
    }

    fn instance_dir(&self) -> PathBuf {
        let lifecycle = V3ManagedLifecycle::with_state_root(&self.config, &self.state);
        let (declaration, _) = lifecycle.declaration(&self.script).unwrap();
        self.state.join("instances").join(declaration.instance_id)
    }

    fn lock_path(&self) -> PathBuf {
        self.instance_dir().join("lifecycle.lock")
    }

    fn invocation_count(&self) -> usize {
        fs::read_to_string(&self.invocations)
            .map(|contents| contents.lines().count())
            .unwrap_or(0)
    }

    fn invocation_pid(&self) -> Option<u32> {
        fs::read_to_string(&self.invocations)
            .ok()
            .and_then(|contents| contents.lines().last().map(str::to_owned))
            .and_then(|line| line.parse().ok())
    }

    fn start_holder(&self) -> Child {
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "operation_lock_serializes_public_callers",
                "--nocapture",
            ])
            .env(HELPER_MODE_ENV, "hold")
            .env(HELPER_CONFIG_ENV, &self.config)
            .env(HELPER_STATE_ENV, &self.state)
            .env(HELPER_SCRIPT_ENV, &self.script)
            .env(HELPER_TIMEOUT_MS_ENV, "30000")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    }

    fn wait_for_first_holder(&self) {
        let deadline = Instant::now() + LOCK_WAIT_TIMEOUT;
        while Instant::now() < deadline {
            if self.lock_path().exists() && self.invocation_count() >= 1 {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!(
            "public start holder did not create the lock and spawn its child; lock={} invocations={}",
            self.lock_path().display(),
            self.invocation_count()
        );
    }
}

fn free_port_file(root: &std::path::Path) -> u16 {
    let path = root.join("port");
    fs::write(&path, "0\n").unwrap();
    let mut permissions = fs::metadata(&path).unwrap().permissions();
    permissions.set_mode(0o600);
    fs::set_permissions(&path, permissions).unwrap();
    // The sandbox denies binding even an ephemeral listener in this test
    // process. This helper records the capability failure before the public
    // start path can reach its listener check.
    let output = Command::new("python3")
        .arg("-c")
        .arg("import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1])")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "free-port helper failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .trim()
        .parse()
        .unwrap()
}

fn async_run<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

fn kill_exact_pid(pid: u32) {
    if pid == 0 || pid == std::process::id() {
        return;
    }
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGKILL);
    }
}

fn kill_owned_process_group(pid: u32) {
    if pid == 0 || pid == std::process::id() {
        return;
    }
    unsafe {
        libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
        libc::kill(pid as libc::pid_t, libc::SIGKILL);
    }
}

fn wait_for_process_group_exit(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        // A timed-out public start drops its Child handle on the S12 baseline.
        // Reap only this fixture's exact direct child after the final group signal.
        // Orphaned fixture children belong to the OS reaper (ECHILD).
        let reaped = unsafe { libc::waitpid(pid as libc::pid_t, std::ptr::null_mut(), libc::WNOHANG) };
        if reaped == pid as libc::pid_t {
            return;
        }
        if unsafe { libc::kill(pid as libc::pid_t, 0) } == -1 {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("owned helper process {pid} did not exit");
}

fn helper_main() {
    let config = PathBuf::from(std::env::var_os(HELPER_CONFIG_ENV).unwrap());
    let state = PathBuf::from(std::env::var_os(HELPER_STATE_ENV).unwrap());
    let script = PathBuf::from(std::env::var_os(HELPER_SCRIPT_ENV).unwrap());
    let timeout_ms = std::env::var(HELPER_TIMEOUT_MS_ENV)
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
    let _ = async_run(lifecycle.start(&script, Duration::from_millis(timeout_ms)));
}

fn assert_operation_locked(error: V3LifecycleError) {
    assert!(
        matches!(error, V3LifecycleError::OperationLocked(_)),
        "second public start must report OperationLocked, got {error}"
    );
}

#[test]
fn operation_lock_serializes_public_callers() {
    let _guard = TEST_LOCK.lock().unwrap();
    if std::env::var_os(HELPER_MODE_ENV).is_some() {
        helper_main();
        return;
    }

    let fixture = PublicLockFixture::new();
    let mut holder = fixture.start_holder();
    fixture.wait_for_first_holder();
    let holder_pid = holder.id();
    let holder_child_pid = fixture.invocation_pid().unwrap();

    let lifecycle = V3ManagedLifecycle::with_state_root(&fixture.config, &fixture.state);
    let second = async_run(lifecycle.start(&fixture.script, Duration::from_millis(500)));
    assert_operation_locked(
        second.expect_err("second public start must not enter the critical section"),
    );

    kill_owned_process_group(holder_child_pid);
    kill_exact_pid(holder_pid);
    let _ = holder.wait();
    wait_for_process_group_exit(holder_child_pid);
}

#[test]
fn operation_lock_recovers_after_owner_sigkill() {
    let _guard = TEST_LOCK.lock().unwrap();
    if std::env::var_os(HELPER_MODE_ENV).is_some() {
        helper_main();
        return;
    }

    let fixture = PublicLockFixture::new();
    let mut holder = fixture.start_holder();
    fixture.wait_for_first_holder();
    let holder_pid = holder.id();
    let holder_child_pid = fixture.invocation_pid().unwrap();
    assert_eq!(fixture.invocation_count(), 1);

    kill_exact_pid(holder_pid);
    let _ = holder.wait();
    kill_owned_process_group(holder_child_pid);
    wait_for_process_group_exit(holder_child_pid);

    let lifecycle = V3ManagedLifecycle::with_state_root(&fixture.config, &fixture.state);
    let next = async_run(lifecycle.start(&fixture.script, Duration::from_millis(500)));
    assert!(
        fixture.invocation_count() >= 2,
        "next public start did not reach child spawn after the lock owner was SIGKILLed"
    );
    let next_child_pid = fixture.invocation_pid().unwrap();
    kill_owned_process_group(next_child_pid);
    wait_for_process_group_exit(next_child_pid);

    assert!(
        !matches!(next, Err(V3LifecycleError::OperationLocked(_))),
        "next public start must acquire the operation lock after the owner dies"
    );
}
