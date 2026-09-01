//! V4-only managed lifecycle owner.
//!
//! Lifecycle control uses one exact Unix socket per V4 aggregate instance.
//! Stop and restart never scan ports or processes and never touch V3 state.

use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{IsTerminal, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub const RUNTIME_IDENTITY: &str = "rccv4";

#[derive(Debug, thiserror::Error)]
pub enum LifecycleError {
    #[error("V4 lifecycle requires HOME or RCCV4_STATE_ROOT")]
    HomeMissing,
    #[error("V4 lifecycle I/O failed for {path}: {message}")]
    Io { path: String, message: String },
    #[error("V4 lifecycle record is invalid: {0}")]
    Record(String),
    #[error("V4 managed instance is already declared")]
    AlreadyManaged,
    #[error("V4 managed instance state is stale; explicit repair is required")]
    StaleState,
    #[error("V4 managed instance is not running")]
    NotRunning,
    #[error("V4 managed child exited before control became ready: {0}")]
    ChildExited(String),
    #[error("V4 managed child did not become ready within {0}ms")]
    StartTimeout(u64),
    #[error("V4 managed lifecycle command timed out after {0}ms")]
    CommandTimeout(u64),
    #[error("V4 control protocol failed: {0}")]
    Protocol(String),
    #[error("V4 exec restart failed: {0}")]
    Exec(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V4LifecyclePaths {
    pub state_root: PathBuf,
    pub record_path: PathBuf,
    pub status_path: PathBuf,
    pub control_socket: PathBuf,
    pub manifest_path: PathBuf,
    pub log_path: PathBuf,
}

impl V4LifecyclePaths {
    pub fn resolve() -> Result<Self, LifecycleError> {
        if let Some(root) = std::env::var_os("RCCV4_STATE_ROOT") {
            return Ok(Self::for_state_root(PathBuf::from(root)));
        }
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or(LifecycleError::HomeMissing)?;
        let state_root = home.join(".rcc/state/runtime-lifecycle/v4");
        Ok(Self {
            record_path: state_root.join("instance.json"),
            status_path: state_root.join("status.json"),
            control_socket: state_root.join("control.sock"),
            manifest_path: state_root.join("manifest.compiled.json"),
            log_path: home.join(".rcc/logs/rccv4.log"),
            state_root,
        })
    }

    pub fn for_state_root(state_root: PathBuf) -> Self {
        let log_path = state_root.join("logs/rccv4.log");
        Self {
            record_path: state_root.join("instance.json"),
            status_path: state_root.join("status.json"),
            control_socket: state_root.join("control.sock"),
            manifest_path: state_root.join("manifest.compiled.json"),
            state_root,
            log_path,
        }
    }

    pub fn prepare(&self) -> Result<(), LifecycleError> {
        create_dir(&self.state_root)?;
        let log_parent = self
            .log_path
            .parent()
            .ok_or_else(|| io_error(&self.log_path, "log path has no parent"))?;
        create_dir(log_parent)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedInstanceRecord {
    pub runtime_identity: String,
    pub pid: u32,
    pub generation_nonce: u128,
    pub config_path: String,
    pub manifest_path: String,
    pub manifest_digest: String,
    pub listeners: Vec<String>,
}

impl ManagedInstanceRecord {
    pub fn validate(&self) -> Result<(), LifecycleError> {
        if self.runtime_identity != RUNTIME_IDENTITY
            || self.pid == 0
            || self.generation_nonce == 0
            || self.config_path.is_empty()
            || self.manifest_path.is_empty()
            || self.manifest_digest.is_empty()
            || self.listeners.is_empty()
        {
            return Err(LifecycleError::Record(
                "identity, pid, paths, digest, and listeners are required".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedAction {
    Continue,
    Stop,
    Restart,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManagedStatus {
    pub state: String,
    pub record: Option<ManagedInstanceRecord>,
}

pub struct ManagedControlPlane {
    listener: UnixListener,
    paths: V4LifecyclePaths,
    record: ManagedInstanceRecord,
}

impl ManagedControlPlane {
    pub fn bind(
        paths: V4LifecyclePaths,
        record: ManagedInstanceRecord,
    ) -> Result<Self, LifecycleError> {
        paths.prepare()?;
        record.validate()?;
        if paths.control_socket.exists() || paths.record_path.exists() {
            return Err(LifecycleError::AlreadyManaged);
        }
        let listener = UnixListener::bind(&paths.control_socket)
            .map_err(|error| io_error(&paths.control_socket, error))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| io_error(&paths.control_socket, error))?;
        write_record_atomic(&paths, &record)?;
        write_status_atomic(&paths, "running", Some(&record))?;
        Ok(Self {
            listener,
            paths,
            record,
        })
    }

    pub fn poll(&self) -> Result<ManagedAction, LifecycleError> {
        let (mut stream, _) = match self.listener.accept() {
            Ok(connection) => connection,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                return Ok(ManagedAction::Continue)
            }
            Err(error) => return Err(io_error(&self.paths.control_socket, error)),
        };
        // The listener is nonblocking for the polling loop, but accepted
        // control connections must be blocking: the client half-shuts down
        // its write side before the command is read. On macOS the accepted
        // socket inherits O_NONBLOCK; leaving it set turns a valid restart
        // request into EAGAIN ("Resource temporarily unavailable").
        stream
            .set_nonblocking(false)
            .map_err(|error| io_error(&self.paths.control_socket, error))?;
        let mut request = String::new();
        stream
            .read_to_string(&mut request)
            .map_err(|error| io_error(&self.paths.control_socket, error))?;
        let action = match request.trim() {
            "status" => ManagedAction::Continue,
            "stop" => ManagedAction::Stop,
            "restart" => ManagedAction::Restart,
            other => {
                let response = serde_json::json!({ "ok": false, "error": format!("unknown lifecycle command {other}") });
                write_reply(&mut stream, &response)?;
                return Err(LifecycleError::Protocol(format!(
                    "unknown lifecycle command {other}"
                )));
            }
        };
        let response = serde_json::json!({
            "ok": true,
            "action": match action {
                ManagedAction::Continue => "status",
                ManagedAction::Stop => "stop",
                ManagedAction::Restart => "restart",
            },
            "record": self.record,
        });
        write_reply(&mut stream, &response)?;
        Ok(action)
    }

    pub fn clear_record(&self) -> Result<(), LifecycleError> {
        if self.paths.record_path.exists() {
            fs::remove_file(&self.paths.record_path)
                .map_err(|error| io_error(&self.paths.record_path, error))?;
        }
        // Restart execs the same process immediately after clearing state.
        // Remove the pathname while this owner still controls the listener;
        // otherwise the new image can observe the inherited stale socket and
        // fail its bind before it can publish a fresh record.
        if self.paths.control_socket.exists() {
            fs::remove_file(&self.paths.control_socket)
                .map_err(|error| io_error(&self.paths.control_socket, error))?;
        }
        write_status_atomic(&self.paths, "stopped", None)?;
        Ok(())
    }
}

impl Drop for ManagedControlPlane {
    fn drop(&mut self) {
        if self.paths.control_socket.exists() {
            let _ = fs::remove_file(&self.paths.control_socket);
        }
    }
}

pub fn read_record(
    paths: &V4LifecyclePaths,
) -> Result<Option<ManagedInstanceRecord>, LifecycleError> {
    if !paths.record_path.exists() {
        return Ok(None);
    }
    let bytes =
        fs::read(&paths.record_path).map_err(|error| io_error(&paths.record_path, error))?;
    let record: ManagedInstanceRecord = serde_json::from_slice(&bytes)
        .map_err(|error| LifecycleError::Record(error.to_string()))?;
    record.validate()?;
    Ok(Some(record))
}

pub fn status_managed(paths: &V4LifecyclePaths) -> Result<ManagedStatus, LifecycleError> {
    let record = read_record(paths)?;
    match record {
        None if paths.control_socket.exists() => Err(LifecycleError::StaleState),
        None => Ok(ManagedStatus {
            state: "stopped".to_string(),
            record: None,
        }),
        Some(record) => match request_control(paths, "status") {
            Ok(_) => Ok(ManagedStatus {
                state: "running".to_string(),
                record: Some(record),
            }),
            Err(_) => Ok(ManagedStatus {
                state: "stale".to_string(),
                record: Some(record),
            }),
        },
    }
}

/// Remove only a provably stale V4 instance declaration.  A live process or
/// responsive control socket is never touched; callers must run the normal
/// managed `restart` command after this explicit repair.
pub fn repair_stale(paths: &V4LifecyclePaths) -> Result<(), LifecycleError> {
    let record = read_record(paths)?.ok_or_else(|| {
        if paths.control_socket.exists() {
            LifecycleError::StaleState
        } else {
            LifecycleError::NotRunning
        }
    })?;
    if request_control(paths, "status").is_ok() {
        return Err(LifecycleError::AlreadyManaged);
    }
    let process_alive = unsafe { libc::kill(record.pid as libc::pid_t, 0) == 0 }
        || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH);
    if process_alive {
        return Err(LifecycleError::AlreadyManaged);
    }
    fs::remove_file(&paths.record_path).map_err(|error| io_error(&paths.record_path, error))?;
    if paths.control_socket.exists() {
        fs::remove_file(&paths.control_socket)
            .map_err(|error| io_error(&paths.control_socket, error))?;
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ManagedSpawnOptions {
    pub snap: bool,
    pub snapall: bool,
    pub snap_stages: Option<String>,
    pub debug: bool,
    pub sse_dump: bool,
}

pub fn start_managed(
    paths: &V4LifecyclePaths,
    executable: &Path,
    config_path: &Path,
    manifest_path: &Path,
    options: &ManagedSpawnOptions,
    timeout: Duration,
) -> Result<ManagedInstanceRecord, LifecycleError> {
    paths.prepare()?;
    if paths.record_path.exists() {
        match status_managed(paths)? {
            ManagedStatus {
                state,
                record: Some(_),
            } if state == "running" => {
                // V3 start semantics are a cold managed start: release the
                // exact declared instance, then publish/spawn a fresh child
                // using this invocation's stdout/stderr. In-place exec
                // restart belongs to the explicit `restart` command.
                release_for_foreground(paths, timeout)?;
                // The child removes its control socket immediately after the
                // lifecycle record.  Wait for both declarations to disappear
                // before admitting the replacement, otherwise a fast `start`
                // can report AlreadyManaged while the old PID is exiting.
                wait_until(timeout, || !paths.control_socket.exists())?;
            }
            ManagedStatus {
                state,
                record: Some(_),
            } if state == "stale" => {
                repair_stale(paths)?;
            }
            _ => return Err(LifecycleError::AlreadyManaged),
        }
    }
    if paths.control_socket.exists() {
        return Err(LifecycleError::AlreadyManaged);
    }
    let mut command = Command::new(executable);
    command
        .arg("server")
        .arg("run-managed-child")
        .arg("--manifest")
        .arg(manifest_path)
        .arg("--config")
        .arg(config_path)
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(if std::io::stdout().is_terminal() {
            Stdio::inherit()
        } else {
            Stdio::from(open_log(paths)?)
        })
        .stderr(if std::io::stderr().is_terminal() {
            Stdio::inherit()
        } else {
            Stdio::from(open_log(paths)?)
        });
    // Keep the managed child independent from the invoking shell. The parent
    // command may return immediately in detached mode; a separate process
    // group prevents shell teardown from terminating the listener.
    command.process_group(0);
    append_spawn_options(&mut command, options);
    let mut child = command
        .spawn()
        .map_err(|error| io_error(executable, error))?;
    let record = wait_child_ready(paths, &mut child, timeout)?;
    if std::io::stdout().is_terminal() {
        wait_for_attached_instance(paths)?;
    }
    Ok(record)
}

fn wait_for_attached_instance(paths: &V4LifecyclePaths) -> Result<(), LifecycleError> {
    loop {
        match status_managed(paths) {
            Ok(status) if status.state == "running" => thread::sleep(Duration::from_millis(100)),
            Ok(_) => return Ok(()),
            Err(error) => return Err(error),
        }
    }
}

pub fn request_stop(paths: &V4LifecyclePaths, timeout: Duration) -> Result<(), LifecycleError> {
    if read_record(paths)?.is_none() {
        return Err(LifecycleError::NotRunning);
    }
    request_control(paths, "stop")?;
    wait_until(timeout, || !paths.record_path.exists())
}

/// Release the exact V4 managed instance before a foreground takeover.
///
/// This is deliberately scoped to the lifecycle record's PID; it never scans
/// or signals unrelated processes.  A responsive managed child receives the
/// normal control-plane stop first, then the recorded process is terminated
/// only if its declaration remains after the bounded grace period.
pub fn release_for_foreground(
    paths: &V4LifecyclePaths,
    timeout: Duration,
) -> Result<(), LifecycleError> {
    let Some(record) = read_record(paths)? else {
        return Ok(());
    };
    let _ = request_control(paths, "stop");
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if read_record(paths)?.is_none() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(25));
    }
    if unsafe { libc::kill(record.pid as libc::pid_t, libc::SIGTERM) } == -1 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(io_error(&paths.record_path, error));
        }
    }
    wait_until(timeout, || !paths.record_path.exists())
}

/// Release an unmanaged listener only when the OS identifies one exact rccv4
/// executable on the requested address. Ambiguous or foreign listeners fail
/// closed; no port-wide or broad process termination is attempted.
pub fn release_unmanaged_listener(address: &str, timeout: Duration) -> Result<(), LifecycleError> {
    let Some(port) = address.rsplit(':').next() else {
        return Ok(());
    };
    let output = std::process::Command::new("/usr/sbin/lsof")
        .args(["-nP", "-Fpct", &format!("-iTCP:{port}"), "-sTCP:LISTEN"])
        .output()
        .map_err(|error| io_error(Path::new(address), error))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut pid = None;
    let mut command = None;
    for line in text.lines() {
        if let Some(value) = line.strip_prefix('p') {
            pid = value.parse::<i32>().ok();
        }
        if let Some(value) = line.strip_prefix('c') {
            command = Some(value.to_string());
        }
    }
    if pid.is_none() || command.as_deref() != Some("rccv4") {
        return Ok(());
    }
    let pid = pid.expect("checked above");
    if unsafe { libc::kill(pid, libc::SIGTERM) } == -1 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(io_error(Path::new(address), error));
        }
    }
    wait_until(timeout, || {
        std::process::Command::new("/usr/sbin/lsof")
            .args(["-nP", "-Fp", &format!("-iTCP:{port}"), "-sTCP:LISTEN"])
            .output()
            .map(|result| result.stdout.is_empty())
            .unwrap_or(false)
    })
}

pub fn request_restart(
    paths: &V4LifecyclePaths,
    expected_digest: &str,
    timeout: Duration,
) -> Result<ManagedInstanceRecord, LifecycleError> {
    let before = read_record(paths)?.ok_or(LifecycleError::NotRunning)?;
    request_control(paths, "restart")?;
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(Some(record)) = read_record(paths) {
            if record.pid == before.pid
                && record.generation_nonce != before.generation_nonce
                && record.manifest_digest == expected_digest
                && request_control(paths, "status").is_ok()
            {
                return Ok(record);
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    Err(LifecycleError::CommandTimeout(timeout.as_millis() as u64))
}

pub fn exec_managed_restart(
    executable: &Path,
    config_path: &Path,
    manifest_path: &Path,
    options: &ManagedSpawnOptions,
) -> LifecycleError {
    let mut command = Command::new(executable);
    command
        .arg("server")
        .arg("run-managed-child")
        .arg("--manifest")
        .arg(manifest_path)
        .arg("--config")
        .arg(config_path)
        .current_dir("/");
    append_spawn_options(&mut command, options);
    let error = command.exec();
    LifecycleError::Exec(error.to_string())
}

fn wait_child_ready(
    paths: &V4LifecyclePaths,
    child: &mut Child,
    timeout: Duration,
) -> Result<ManagedInstanceRecord, LifecycleError> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| LifecycleError::ChildExited(error.to_string()))?
        {
            return Err(LifecycleError::ChildExited(status.to_string()));
        }
        if request_control(paths, "status").is_ok() {
            return read_record(paths)?.ok_or_else(|| {
                LifecycleError::Record("control ready without instance record".to_string())
            });
        }
        thread::sleep(Duration::from_millis(25));
    }
    Err(LifecycleError::StartTimeout(timeout.as_millis() as u64))
}

fn open_log(paths: &V4LifecyclePaths) -> Result<File, LifecycleError> {
    let parent = paths
        .log_path
        .parent()
        .ok_or_else(|| io_error(&paths.log_path, "log path has no parent"))?;
    fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.log_path)
        .map_err(|error| io_error(&paths.log_path, error))
}

fn request_control(
    paths: &V4LifecyclePaths,
    command: &str,
) -> Result<serde_json::Value, LifecycleError> {
    let mut stream = UnixStream::connect(&paths.control_socket)
        .map_err(|error| io_error(&paths.control_socket, error))?;
    stream
        .write_all(command.as_bytes())
        .map_err(|error| io_error(&paths.control_socket, error))?;
    stream
        .shutdown(std::net::Shutdown::Write)
        .map_err(|error| io_error(&paths.control_socket, error))?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| io_error(&paths.control_socket, error))?;
    let value: serde_json::Value = serde_json::from_slice(&response)
        .map_err(|error| LifecycleError::Protocol(error.to_string()))?;
    if value.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err(LifecycleError::Protocol(value.to_string()));
    }
    Ok(value)
}

fn write_record_atomic(
    paths: &V4LifecyclePaths,
    record: &ManagedInstanceRecord,
) -> Result<(), LifecycleError> {
    let temporary = paths
        .state_root
        .join(format!(".instance.{}.tmp", std::process::id()));
    let mut bytes = serde_json::to_vec_pretty(record)
        .map_err(|error| LifecycleError::Record(error.to_string()))?;
    bytes.push(b'\n');
    fs::write(&temporary, bytes).map_err(|error| io_error(&temporary, error))?;
    fs::rename(&temporary, &paths.record_path).map_err(|error| io_error(&paths.record_path, error))
}

fn write_status_atomic(
    paths: &V4LifecyclePaths,
    state: &str,
    record: Option<&ManagedInstanceRecord>,
) -> Result<(), LifecycleError> {
    let body = serde_json::json!({
        "state": state,
        "record": record,
    });
    let temporary = paths
        .state_root
        .join(format!(".status.{}.tmp", std::process::id()));
    let mut bytes = serde_json::to_vec_pretty(&body)
        .map_err(|error| LifecycleError::Record(error.to_string()))?;
    bytes.push(b'\n');
    fs::write(&temporary, bytes).map_err(|error| io_error(&temporary, error))?;
    fs::rename(&temporary, &paths.status_path).map_err(|error| io_error(&paths.status_path, error))
}

fn write_reply(stream: &mut UnixStream, value: &serde_json::Value) -> Result<(), LifecycleError> {
    let bytes =
        serde_json::to_vec(value).map_err(|error| LifecycleError::Protocol(error.to_string()))?;
    stream
        .write_all(&bytes)
        .map_err(|error| LifecycleError::Protocol(error.to_string()))
}

fn append_spawn_options(command: &mut Command, options: &ManagedSpawnOptions) {
    if options.snap {
        command.arg("--snap");
    }
    if options.snapall {
        command.arg("--snapall");
    }
    if let Some(stages) = &options.snap_stages {
        command.arg("--snap-stages").arg(stages);
    }
    if options.debug {
        command.arg("--debug");
    }
    if options.sse_dump {
        command.arg("--sse-dump");
    }
}

fn wait_until(timeout: Duration, condition: impl Fn() -> bool) -> Result<(), LifecycleError> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if condition() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(25));
    }
    Err(LifecycleError::CommandTimeout(timeout.as_millis() as u64))
}

fn create_dir(path: &Path) -> Result<(), LifecycleError> {
    fs::create_dir_all(path).map_err(|error| io_error(path, error))
}

fn io_error(path: &Path, error: impl std::fmt::Display) -> LifecycleError {
    LifecycleError::Io {
        path: path.display().to_string(),
        message: error.to_string(),
    }
}
