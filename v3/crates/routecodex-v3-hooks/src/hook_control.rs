//! Typed project-control cancellation for a scoped control server.
//!
//! The shared daemon owns one [`ControlServer`] per registered project. A
//! project that is closing must be able to stop its timer/listener, wake
//! blocking reads, and cancel in-flight handler work without touching any
//! other project and without the daemon being able to signal a project's
//! process group. This module carries that control state as a typed resource:
//! it is never mirrored into business payload.

use std::collections::BTreeMap;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Typed cancellation flag shared by the control server, its listener loop,
/// its timer thread, and any handler already running for this project.
#[derive(Debug, Clone, Default)]
pub struct HookCancellation {
    state: Arc<CancellationState>,
}

#[derive(Debug, Default)]
struct CancellationState {
    cancelled: AtomicBool,
    streams: Mutex<(u64, BTreeMap<u64, UnixStream>)>,
}

pub(crate) struct StreamCancellationRegistration {
    cancellation: HookCancellation,
    id: u64,
}

impl Drop for StreamCancellationRegistration {
    fn drop(&mut self) {
        self.cancellation
            .state
            .streams
            .lock()
            .expect("project stream registry poisoned")
            .1
            .remove(&self.id);
    }
}

impl HookCancellation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.state.cancelled.store(true, Ordering::SeqCst);
        let streams = self
            .state
            .streams
            .lock()
            .expect("project stream registry poisoned");
        for stream in streams.1.values() {
            if let Err(error) = stream.shutdown(std::net::Shutdown::Both) {
                if error.kind() != std::io::ErrorKind::NotConnected {
                    eprintln!("project stream shutdown failed: {error}");
                }
            }
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.state.cancelled.load(Ordering::SeqCst)
    }

    pub(crate) fn track_stream(
        &self,
        stream: &UnixStream,
    ) -> std::io::Result<StreamCancellationRegistration> {
        let mut streams = self
            .state
            .streams
            .lock()
            .map_err(|_| std::io::Error::other("project stream registry poisoned"))?;
        if self.is_cancelled() {
            stream.shutdown(std::net::Shutdown::Both)?;
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "project released",
            ));
        }
        streams.0 += 1;
        let id = streams.0;
        streams.1.insert(id, stream.try_clone()?);
        Ok(StreamCancellationRegistration {
            cancellation: self.clone(),
            id,
        })
    }
}

/// Control handle returned by [`crate::ControlServer::serve_in_background`].
///
/// Explicit release and RAII cleanup stop and join the server's owned threads.
pub struct ControlHandle {
    cancellation: HookCancellation,
    join: Option<std::thread::JoinHandle<std::io::Result<()>>>,
}

impl ControlHandle {
    pub(crate) fn new(
        cancellation: HookCancellation,
        join: std::thread::JoinHandle<std::io::Result<()>>,
    ) -> Self {
        Self {
            cancellation,
            join: Some(join),
        }
    }

    pub fn cancellation(&self) -> HookCancellation {
        self.cancellation.clone()
    }

    /// Signals cancellation, wakes blocking reads, and joins the listener and
    /// timer threads. Returns the server's own exit result.
    pub fn stop(mut self) -> std::io::Result<()> {
        self.finish()
    }

    fn finish(&mut self) -> std::io::Result<()> {
        if self.join.is_none() {
            return Ok(());
        }
        self.cancellation.cancel();
        match self.join.take() {
            Some(join) => join
                .join()
                .unwrap_or_else(|_| Err(std::io::Error::other("control server thread panicked"))),
            None => Ok(()),
        }
    }
}

impl Drop for ControlHandle {
    fn drop(&mut self) {
        if let Err(error) = self.finish() {
            eprintln!("hooks control cleanup failed: {error}");
        }
    }
}

/// Bounded wait used by callers that must not spin on a shared clock.
pub(crate) fn wait_for_cancellation(cancellation: &HookCancellation, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if cancellation.is_cancelled() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    cancellation.is_cancelled()
}

/// Commands are spawned in a dedicated group. Reap the owner and include its
/// descendants; on Darwin an exited group can report EPERM until its zombie
/// leader is reaped. Only a subsequent ESRCH proves that group is gone.
pub(crate) fn terminate_project_command(child: &mut std::process::Child) -> std::io::Result<()> {
    let group = -(child.id() as libc::pid_t);
    if unsafe { libc::kill(group, libc::SIGKILL) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            let exited = child.try_wait()?.is_some();
            let absent = unsafe { libc::kill(group, 0) } == -1
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
            if !exited || !absent {
                return Err(error);
            }
        }
    }
    child.wait()?;
    Ok(())
}
