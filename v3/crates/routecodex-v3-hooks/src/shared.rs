//! Per-user daemon ownership and isolated, connection-owned project leases.
use crate::{
    AppServerSocketConfig, ControlHandle, ControlServer, HookCancellation, HookHandlersConfig,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const SHARED_HOOKS_PROTOCOL: &str = "rcc-hooks-registry/v1";
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const IDLE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SharedProjectConfig {
    pub instance_dir: PathBuf,
    pub appserver_sockets: AppServerSocketConfig,
    pub handlers_config: Option<HookHandlersConfig>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
pub enum SharedHooksRequest {
    Health,
    Register(SharedProjectConfig),
    Release,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SharedHooksResponse {
    pub protocol: String,
    pub ok: bool,
    pub daemon_pid: u32,
    pub registration_generation: Option<u64>,
    pub error: Option<String>,
}

impl SharedHooksResponse {
    fn result(result: io::Result<()>) -> Self {
        Self {
            protocol: SHARED_HOOKS_PROTOCOL.into(),
            ok: result.is_ok(),
            daemon_pid: std::process::id(),
            registration_generation: None,
            error: result.err().map(|error| error.to_string()),
        }
    }
    fn check(self) -> io::Result<Self> {
        if self.protocol != SHARED_HOOKS_PROTOCOL || !self.ok {
            return Err(io::Error::other(
                self.error
                    .unwrap_or_else(|| "invalid shared hooks response".into()),
            ));
        }
        Ok(self)
    }
}

pub fn shared_hooks_root() -> io::Result<PathBuf> {
    let home = std::env::var_os("HOME").ok_or_else(|| io::Error::other("HOME is unavailable"))?;
    let config_root = fs::canonicalize(home)?.join(".rcc");
    match fs::canonicalize(&config_root) {
        Ok(root) => Ok(root.join("hooks")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // A dangling configured link is an error; only an absent directory
            // may be created by the shared service.
            match fs::symlink_metadata(&config_root) {
                Err(absent) if absent.kind() == io::ErrorKind::NotFound => {
                    Ok(config_root.join("hooks"))
                }
                _ => Err(error),
            }
        }
        Err(error) => Err(error),
    }
}

pub fn shared_hooks_socket(root: &Path) -> PathBuf {
    root.join("daemon.sock")
}

fn write_json(stream: &mut UnixStream, value: &impl Serialize) -> io::Result<()> {
    serde_json::to_writer(&mut *stream, value)?;
    stream.write_all(b"\n")
}

// A partial JSON line never resets the absolute admission deadline.
fn read_json<T: serde::de::DeserializeOwned>(
    stream: &mut UnixStream,
    deadline: Option<Instant>,
) -> io::Result<T> {
    let mut bytes = Vec::new();
    loop {
        if let Some(deadline) = deadline {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::TimedOut,
                        "hooks registration deadline expired",
                    )
                })?;
            stream.set_read_timeout(Some(remaining))?;
        }
        let mut byte = [0];
        if stream.read(&mut byte)? == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "hooks lease disconnected",
            ));
        }
        if byte[0] == b'\n' {
            return serde_json::from_slice(&bytes).map_err(Into::into);
        }
        bytes.push(byte[0]);
    }
}

fn private_directory(path: &Path) -> io::Result<()> {
    // Creation is atomic; concurrent first clients can both observe absence.
    // An existing entry is accepted only after the same ownership check.
    if let Err(error) = fs::create_dir(path) {
        if error.kind() != io::ErrorKind::AlreadyExists {
            return Err(error);
        }
    }
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir()
        && !metadata.file_type().is_symlink()
        && metadata.uid() == unsafe { libc::geteuid() }
    {
        return Ok(());
    }
    Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        "hooks directory identity is not owned",
    ))
}

fn socket_identity(path: &Path) -> io::Result<(u64, u64)> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_socket() || metadata.uid() != unsafe { libc::geteuid() } {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "hooks socket is not an owned socket",
        ));
    }
    Ok((metadata.dev(), metadata.ino()))
}

fn remove_socket(path: &Path, identity: (u64, u64)) -> io::Result<()> {
    match socket_identity(path) {
        Ok(current) if current == identity => fs::remove_file(path),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => Ok(()),
        Err(error) => Err(error),
    }
}

fn prepare_socket(path: &Path) -> io::Result<()> {
    match socket_identity(path) {
        Ok(identity) => match UnixStream::connect(path) {
            Ok(_) => Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                "hooks socket already has a listener",
            )),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
                ) =>
            {
                remove_socket(path, identity)
            }
            Err(error) => Err(error),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

struct Registry {
    pending: usize,
    projects: BTreeSet<PathBuf>,
    closing: bool,
    idle_since: Instant,
    next_generation: u64,
}

struct Admission {
    registry: Arc<Mutex<Registry>>,
    pending: bool,
    project: Option<PathBuf>,
    cleanup_failed: bool,
    generation: Option<u64>,
    reset_idle: bool,
}

impl Admission {
    fn finish_project(&mut self) -> io::Result<()> {
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| io::Error::other("hooks registry poisoned"))?;
        if !self.cleanup_failed {
            if let Some(project) = self.project.take() {
                registry.projects.remove(&project);
            }
        }
        if self.reset_idle && registry.pending == 0 && registry.projects.is_empty() {
            registry.idle_since = Instant::now();
        }
        Ok(())
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        let mut registry = self.registry.lock().expect("hooks registry poisoned");
        if self.pending {
            registry.pending -= 1;
        }
        if !self.cleanup_failed {
            if let Some(project) = &self.project {
                registry.projects.remove(project);
            }
        }
        if self.reset_idle && registry.pending == 0 && registry.projects.is_empty() {
            registry.idle_since = Instant::now();
        }
    }
}

pub struct SharedHooksDaemon {
    listener: Option<UnixListener>,
    socket: PathBuf,
    identity: (u64, u64),
    _lock: File,
}

impl SharedHooksDaemon {
    pub fn bind(root: &Path) -> io::Result<Self> {
        private_directory(
            root.parent()
                .ok_or_else(|| io::Error::other("hooks root has no parent"))?,
        )?;
        private_directory(root)?;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(root.join("daemon.lock"))?;
        let metadata = lock.metadata()?;
        if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "hooks lock identity is not owned",
            ));
        }
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                "shared hooks daemon is already running",
            ));
        }
        let socket = shared_hooks_socket(root);
        prepare_socket(&socket)?;
        let listener = UnixListener::bind(&socket)?;
        let identity = socket_identity(&socket)?;
        if let Err(error) = fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)) {
            remove_socket(&socket, identity)?;
            return Err(error);
        }
        listener.set_nonblocking(true)?;
        Ok(Self {
            listener: Some(listener),
            socket,
            identity,
            _lock: lock,
        })
    }

    pub fn serve(mut self) -> io::Result<()> {
        let registry = Arc::new(Mutex::new(Registry {
            pending: 0,
            projects: BTreeSet::new(),
            closing: false,
            idle_since: Instant::now(),
            next_generation: 1,
        }));
        let mut workers: Vec<(UnixStream, std::thread::JoinHandle<()>)> = Vec::new();
        let mut failure = None;
        loop {
            let mut index = 0;
            while index < workers.len() {
                if workers[index].1.is_finished() {
                    let (_, worker) = workers.swap_remove(index);
                    if worker.join().is_err() {
                        failure = Some(io::Error::other("hooks registration worker panicked"));
                        break;
                    }
                } else {
                    index += 1;
                }
            }
            // Admission and idle exit share this lock: no registration can
            // arrive between the last empty check and listener closure.
            let mut state = match registry.lock() {
                Ok(state) => state,
                Err(_) => {
                    failure = Some(io::Error::other("hooks registry poisoned"));
                    break;
                }
            };
            if failure.is_some()
                || (state.pending == 0
                    && state.projects.is_empty()
                    && state.idle_since.elapsed() >= IDLE_TIMEOUT)
            {
                state.closing = true;
                drop(self.listener.take());
                break;
            }
            match self.listener.as_ref().expect("live listener").accept() {
                Ok((mut stream, _)) => {
                    let retained_stream = match stream.try_clone() {
                        Ok(stream) => stream,
                        Err(error) => {
                            failure = Some(error);
                            continue;
                        }
                    };
                    state.pending += 1;
                    let admission = Admission {
                        registry: Arc::clone(&registry),
                        pending: true,
                        project: None,
                        cleanup_failed: false,
                        generation: None,
                        reset_idle: false,
                    };
                    let worker = std::thread::spawn(move || {
                        if let Err(error) = serve_registration(&mut stream, admission) {
                            eprintln!("shared hooks registration failed: {error}");
                        }
                    });
                    workers.push((retained_stream, worker));
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => {
                    failure = Some(error);
                }
            }
            drop(state);
            std::thread::sleep(Duration::from_millis(10));
        }
        if failure.is_some() {
            drop(self.listener.take());
            for (stream, _) in &workers {
                if let Err(error) = stream.shutdown(std::net::Shutdown::Both) {
                    if error.kind() != io::ErrorKind::NotConnected {
                        eprintln!("hooks lease shutdown failed: {error}");
                    }
                }
            }
        }
        for (_, worker) in workers {
            if worker.join().is_err() {
                failure = Some(io::Error::other("hooks registration worker panicked"));
            }
        }
        remove_socket(&self.socket, self.identity)?;
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

impl Drop for SharedHooksDaemon {
    fn drop(&mut self) {
        drop(self.listener.take());
        if let Err(error) = remove_socket(&self.socket, self.identity) {
            eprintln!("shared hooks socket cleanup failed: {error}");
        }
        // The fixed lock inode is never unlinked. Its descriptor drops last.
    }
}

fn serve_registration(stream: &mut UnixStream, mut admission: Admission) -> io::Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT))?;
    let request = read_json(stream, Some(Instant::now() + HANDSHAKE_TIMEOUT));
    let config = match request {
        Ok(SharedHooksRequest::Register(config)) => config,
        Ok(SharedHooksRequest::Health) => {
            return write_json(stream, &SharedHooksResponse::result(Ok(())))
        }
        Ok(SharedHooksRequest::Release) => {
            return write_json(
                stream,
                &SharedHooksResponse::result(Err(io::Error::other("no project is registered"))),
            )
        }
        Err(error) => {
            write_json(stream, &SharedHooksResponse::result(Err(error)))?;
            return Ok(());
        }
    };
    admission.reset_idle = true;
    let setup = (|| -> io::Result<ControlHandle> {
        let directory = fs::canonicalize(&config.instance_dir)?;
        let metadata = fs::symlink_metadata(&config.instance_dir)?;
        if directory != config.instance_dir
            || !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "project directory must be canonical and owned",
            ));
        }
        {
            let mut registry = admission
                .registry
                .lock()
                .map_err(|_| io::Error::other("hooks registry poisoned"))?;
            if registry.closing || !registry.projects.insert(directory.clone()) {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "project is already registered",
                ));
            }
            admission.project = Some(directory.clone());
            admission.generation = Some(registry.next_generation);
            registry.next_generation += 1;
            admission.pending = false;
            registry.pending -= 1;
        }
        let socket = directory.join("hooks-sidecar.sock");
        let state = directory.join("hooks-sidecar-state.json");
        if let Ok(metadata) = fs::symlink_metadata(&state) {
            if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "project state identity is not owned",
                ));
            }
        }
        prepare_socket(&socket)?;
        ControlServer::with_appserver_sockets_handlers_and_state(
            &socket,
            config.appserver_sockets,
            config.handlers_config,
            Some(&state),
        )?
        .serve_in_background()
    })();
    let handle = match setup {
        Ok(handle) => handle,
        Err(error) => {
            write_json(stream, &SharedHooksResponse::result(Err(error)))?;
            return Ok(());
        }
    };
    let mut response = SharedHooksResponse::result(Ok(()));
    response.registration_generation = admission.generation;
    if let Err(error) = write_json(stream, &response) {
        let cleanup = handle.stop();
        admission.cleanup_failed = cleanup.is_err();
        cleanup?;
        return Err(error);
    }
    stream.set_read_timeout(None)?;
    let release = read_json::<SharedHooksRequest>(stream, None);
    let cleanup = handle.stop();
    admission.cleanup_failed = cleanup.is_err();
    // Free the registry reservation before the clean ACK reaches the owner.
    admission.finish_project()?;
    match release {
        Ok(SharedHooksRequest::Release) => {
            write_json(stream, &SharedHooksResponse::result(cleanup))
        }
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => cleanup,
        other => {
            cleanup?;
            write_json(
                stream,
                &SharedHooksResponse::result(Err(io::Error::other(format!(
                    "expected project release: {other:?}"
                )))),
            )
        }
    }
}

/// The owning lifecycle keeps this CLOEXEC connection alive. No child process
/// or PID belongs to an individual project registration.
pub struct SharedProjectLease {
    stream: UnixStream,
    pub daemon_pid: u32,
    pub registration_generation: u64,
}

impl SharedProjectLease {
    pub fn release(mut self) -> io::Result<()> {
        self.stream
            .set_read_timeout(Some(Duration::from_secs(60)))?;
        write_json(&mut self.stream, &SharedHooksRequest::Release)?;
        read_json::<SharedHooksResponse>(
            &mut self.stream,
            Some(Instant::now() + Duration::from_secs(60)),
        )?
        .check()?;
        reap_daemon_children()?;
        Ok(())
    }

    pub fn into_stream(self) -> UnixStream {
        self.stream
    }
}

// Reapers belong to the process's shared-service client, rather than to one
// project's lease. A project can leave while another still uses that child.
type DaemonReaper = std::thread::JoinHandle<io::Result<std::process::ExitStatus>>;
static DAEMON_REAPERS: std::sync::OnceLock<Mutex<Vec<DaemonReaper>>> = std::sync::OnceLock::new();

fn reap_daemon_children() -> io::Result<()> {
    let mut reapers = DAEMON_REAPERS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .map_err(|_| io::Error::other("hooks child reaper registry poisoned"))?;
    let mut index = 0;
    while index < reapers.len() {
        if reapers[index].is_finished() {
            reapers
                .swap_remove(index)
                .join()
                .map_err(|_| io::Error::other("hooks child reaper panicked"))??;
        } else {
            index += 1;
        }
    }
    Ok(())
}

fn verify_shared_binary(
    binary: &Path,
    deadline: Instant,
    cancellation: &HookCancellation,
) -> io::Result<()> {
    use std::os::unix::process::CommandExt;
    let mut child = Command::new(binary)
        .arg("--once")
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let deadline = deadline.min(Instant::now() + HANDSHAKE_TIMEOUT);
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if cancellation.is_cancelled() || Instant::now() >= deadline {
            crate::hook_control::terminate_project_command(&mut child)?;
            return Err(io::Error::new(
                if cancellation.is_cancelled() {
                    io::ErrorKind::Interrupted
                } else {
                    io::ErrorKind::TimedOut
                },
                "hooks binary capability probe did not exit",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "hooks binary capability probe exited {}",
            output.status
        )));
    }
    let response: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if response["shared_registry_protocol"] != SHARED_HOOKS_PROTOCOL {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "installed hooks binary does not support shared project registration",
        ));
    }
    Ok(())
}

pub fn register_shared_project(
    binary: &Path,
    config: SharedProjectConfig,
    timeout: Duration,
) -> io::Result<SharedProjectLease> {
    register_shared_project_cancelable(binary, config, timeout, &HookCancellation::new())
}

pub fn register_shared_project_cancelable(
    binary: &Path,
    config: SharedProjectConfig,
    timeout: Duration,
    cancellation: &HookCancellation,
) -> io::Result<SharedProjectLease> {
    reap_daemon_children()?;
    let root = shared_hooks_root()?;
    let socket = shared_hooks_socket(&root);
    let deadline = Instant::now() + timeout;
    let mut stream = match UnixStream::connect(&socket) {
        Ok(stream) => stream,
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
            ) =>
        {
            // Reject the former no-client sleeper before launching a daemon.
            // This is an artifact protocol boundary, never a payload filter.
            verify_shared_binary(binary, deadline, cancellation)?;
            private_directory(root.parent().expect("HOME-rooted service"))?;
            private_directory(&root)?;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
            let stderr = OpenOptions::new()
                .create(true)
                .append(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(root.join("daemon.stderr.log"))?;
            use std::os::unix::process::CommandExt;
            let mut child = Command::new(binary)
                .arg("--shared-daemon")
                .process_group(0)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(stderr)
                .spawn()?;
            let reaper = std::thread::spawn(move || child.wait());
            DAEMON_REAPERS
                .get_or_init(|| Mutex::new(Vec::new()))
                .lock()
                .map_err(|_| io::Error::other("hooks child reaper registry poisoned"))?
                .push(reaper);
            loop {
                if cancellation.is_cancelled() {
                    return Err(io::Error::new(
                        io::ErrorKind::Interrupted,
                        "hooks startup cancelled",
                    ));
                }
                match UnixStream::connect(&socket) {
                    Ok(stream) => break stream,
                    Err(error)
                        if matches!(
                            error.kind(),
                            io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
                        ) =>
                    {
                        if Instant::now() >= deadline {
                            return Err(io::Error::new(
                                io::ErrorKind::TimedOut,
                                format!("shared hooks daemon did not become available: {error}"),
                            ));
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        Err(error) => return Err(error),
    };
    let _startup_stream = cancellation.track_stream(&stream)?;
    let flags = unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_GETFD) };
    if flags < 0
        || unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0
    {
        return Err(io::Error::last_os_error());
    }
    stream.set_write_timeout(Some(timeout))?;
    write_json(&mut stream, &SharedHooksRequest::Register(config))?;
    let response = read_json::<SharedHooksResponse>(&mut stream, Some(deadline))?.check()?;
    stream.set_read_timeout(None)?;
    Ok(SharedProjectLease {
        stream,
        daemon_pid: response.daemon_pid,
        registration_generation: response.registration_generation.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "shared hooks registration has no generation",
            )
        })?,
    })
}
