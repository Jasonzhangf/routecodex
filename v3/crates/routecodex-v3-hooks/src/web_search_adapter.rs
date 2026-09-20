//! Minimal WebSearch execution adapter for the hooks sidecar.
//!
//! The adapter owns only the typed request/result boundary and deadline
//! enforcement. It never calls Router, Target, Provider, or the client frame.

use serde::{Deserialize, Serialize};
use servertool_core::web_search_contract::{
    WebSearchHookOutcome, WebSearchHookRequest, WebSearchResultStatus,
};
use std::io::{ErrorKind, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
pub enum WebSearchAdapterError {
    Unavailable(String),
    Timeout(String),
    MalformedResponse(String),
    InvalidRequest(String),
}

impl std::fmt::Display for WebSearchAdapterError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(reason)
            | Self::Timeout(reason)
            | Self::MalformedResponse(reason)
            | Self::InvalidRequest(reason) => formatter.write_str(reason),
        }
    }
}

impl std::error::Error for WebSearchAdapterError {}

pub trait WebSearchAdapter {
    fn execute(
        &mut self,
        request: &WebSearchHookRequest,
    ) -> Result<WebSearchHookOutcome, WebSearchAdapterError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandWebSearchAdapter {
    command: String,
    args: Vec<String>,
    timeout: Duration,
}

impl CommandWebSearchAdapter {
    pub fn new(command: String, args: Vec<String>, timeout: Duration) -> Self {
        Self {
            command,
            args,
            timeout,
        }
    }

    fn remaining_timeout(
        &self,
        request: &WebSearchHookRequest,
    ) -> Result<Duration, WebSearchAdapterError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| WebSearchAdapterError::Unavailable(error.to_string()))?
            .as_millis() as u64;
        if now >= request.deadline_unix_ms {
            return Err(WebSearchAdapterError::Timeout(
                "web_search request deadline expired before subagent start".to_string(),
            ));
        }
        let remaining_ms = request.deadline_unix_ms - now;
        Ok(self.timeout.min(Duration::from_millis(remaining_ms)))
    }
}

impl WebSearchAdapter for CommandWebSearchAdapter {
    fn execute(
        &mut self,
        request: &WebSearchHookRequest,
    ) -> Result<WebSearchHookOutcome, WebSearchAdapterError> {
        request
            .validate()
            .map_err(|error| WebSearchAdapterError::InvalidRequest(error.to_string()))?;
        let timeout = self.remaining_timeout(request)?;
        let payload = request_payload(request)?;
        let deadline = std::time::Instant::now() + timeout;
        let mut child = Command::new(&self.command)
            .args(&self.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .map_err(|error| {
                WebSearchAdapterError::Unavailable(format!(
                    "web_search subagent {} failed to spawn: {error}",
                    self.command
                ))
            })?;
        let mut stdin = Some(child.stdin.take().ok_or_else(|| {
            WebSearchAdapterError::Unavailable("web_search subagent stdin unavailable".to_string())
        })?);
        let mut stdout = child.stdout.take().ok_or_else(|| {
            WebSearchAdapterError::Unavailable("web_search subagent stdout unavailable".to_string())
        })?;
        let mut stderr = child.stderr.take().ok_or_else(|| {
            WebSearchAdapterError::Unavailable("web_search subagent stderr unavailable".to_string())
        })?;
        for pipe in [
            stdin.as_ref().expect("stdin is present").as_raw_fd(),
            stdout.as_raw_fd(),
            stderr.as_raw_fd(),
        ] {
            if let Err(error) = set_nonblocking(pipe) {
                terminate_child(&mut child);
                return Err(error);
            }
        }
        let payload = payload.as_bytes();
        let mut payload_offset = 0;
        let mut stdin_open = true;
        let mut stdout_open = true;
        let mut stderr_open = true;
        let mut stdout_bytes = Vec::new();
        let mut stderr_bytes = Vec::new();
        let mut exit_status = None;
        let mut stdin_error = None;
        loop {
            let mut pipe_progress = false;
            if stdin_open && payload_offset < payload.len() {
                match stdin
                    .as_mut()
                    .expect("stdin is present while it is open")
                    .write(&payload[payload_offset..])
                {
                    Ok(0) => {
                        terminate_child(&mut child);
                        return Err(WebSearchAdapterError::Unavailable(
                            "web_search subagent stdin closed before request completed".to_string(),
                        ));
                    }
                    Ok(written) => payload_offset += written,
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                    Err(error) => {
                        stdin_open = false;
                        drop(stdin.take());
                        stdin_error = Some(error);
                    }
                }
            }
            if stdin_open && payload_offset == payload.len() {
                stdin_open = false;
                drop(stdin.take());
            }
            if stdout_open {
                match drain_stdout(&mut stdout, &mut stdout_bytes) {
                    Ok((open, progressed)) => {
                        stdout_open = open;
                        pipe_progress |= progressed;
                    }
                    Err(error) => {
                        terminate_child(&mut child);
                        return Err(error);
                    }
                }
            }
            if stderr_open {
                match drain_stderr(&mut stderr, &mut stderr_bytes) {
                    Ok((open, progressed)) => {
                        stderr_open = open;
                        pipe_progress |= progressed;
                    }
                    Err(error) => {
                        terminate_child(&mut child);
                        return Err(error);
                    }
                }
            }
            if exit_status.is_none() {
                match child.try_wait() {
                    Ok(Some(status)) => exit_status = Some(status),
                    Ok(None) => {}
                    Err(error) => {
                        terminate_child(&mut child);
                        return Err(WebSearchAdapterError::Unavailable(format!(
                            "web_search subagent wait failed: {error}"
                        )));
                    }
                }
            }
            if !stdin_open && exit_status.is_some() && !stdout_open && !stderr_open {
                break;
            }
            if std::time::Instant::now() >= deadline {
                terminate_child(&mut child);
                return Err(WebSearchAdapterError::Timeout(
                    "web_search subagent exceeded request deadline".to_string(),
                ));
            }
            if !pipe_progress {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        if let Some(error) = stdin_error {
            return Err(WebSearchAdapterError::Unavailable(format!(
                "web_search subagent stdin failed: {error}"
            )));
        }
        let status = exit_status.ok_or_else(|| {
            WebSearchAdapterError::Unavailable(
                "web_search subagent exited without a status".to_string(),
            )
        })?;
        if !status.success() {
            return Err(WebSearchAdapterError::Unavailable(format!(
                "web_search subagent exited {}: {}",
                status,
                String::from_utf8_lossy(&stderr_bytes)
            )));
        }
        let outcome: WebSearchHookOutcome =
            serde_json::from_slice(&stdout_bytes).map_err(|error| {
                WebSearchAdapterError::MalformedResponse(format!(
                    "web_search subagent returned invalid outcome JSON: {error}"
                ))
            })?;
        validate_outcome(&outcome, &request.call_id)?;
        Ok(outcome)
    }
}

fn set_nonblocking(file_descriptor: std::os::fd::RawFd) -> Result<(), WebSearchAdapterError> {
    let flags = unsafe { libc::fcntl(file_descriptor, libc::F_GETFL) };
    if flags < 0 {
        return Err(WebSearchAdapterError::Unavailable(format!(
            "web_search subagent pipe flags read failed: {}",
            std::io::Error::last_os_error()
        )));
    }
    let result = unsafe { libc::fcntl(file_descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) };
    if result < 0 {
        return Err(WebSearchAdapterError::Unavailable(format!(
            "web_search subagent pipe nonblocking setup failed: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(())
}

fn drain_stdout(
    stdout: &mut ChildStdout,
    bytes: &mut Vec<u8>,
) -> Result<(bool, bool), WebSearchAdapterError> {
    drain_pipe(stdout, bytes, "stdout")
}

fn drain_stderr(
    stderr: &mut ChildStderr,
    bytes: &mut Vec<u8>,
) -> Result<(bool, bool), WebSearchAdapterError> {
    drain_pipe(stderr, bytes, "stderr")
}

fn drain_pipe(
    pipe: &mut impl Read,
    bytes: &mut Vec<u8>,
    label: &str,
) -> Result<(bool, bool), WebSearchAdapterError> {
    let mut buffer = [0_u8; 64 * 1024];
    let mut progressed = false;
    loop {
        match pipe.read(&mut buffer) {
            Ok(0) => return Ok((false, progressed)),
            Ok(read) => {
                if bytes.len().saturating_add(read) > MAX_OUTPUT_BYTES {
                    return Err(WebSearchAdapterError::MalformedResponse(format!(
                        "web_search subagent {label} exceeded {MAX_OUTPUT_BYTES} byte limit"
                    )));
                }
                bytes.extend_from_slice(&buffer[..read]);
                progressed = true;
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                return Ok((true, progressed));
            }
            Err(error) => {
                return Err(WebSearchAdapterError::Unavailable(format!(
                    "web_search subagent {label} failed: {error}"
                )))
            }
        }
    }
}

fn terminate_child(child: &mut Child) {
    let process_group_id = child.id() as libc::pid_t;
    if process_group_id > 0 {
        unsafe {
            libc::kill(-process_group_id, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn request_payload(request: &WebSearchHookRequest) -> Result<String, WebSearchAdapterError> {
    serde_json::to_string(request).map_err(|error| {
        WebSearchAdapterError::InvalidRequest(format!(
            "web_search request serialization failed: {error}"
        ))
    })
}

fn validate_outcome(
    outcome: &WebSearchHookOutcome,
    expected_call_id: &str,
) -> Result<(), WebSearchAdapterError> {
    match outcome {
        WebSearchHookOutcome::NotApplicable => Err(WebSearchAdapterError::MalformedResponse(
            "web_search subagent returned not_applicable".to_string(),
        )),
        WebSearchHookOutcome::Completed(result) => {
            if result.status != WebSearchResultStatus::Completed {
                return Err(WebSearchAdapterError::MalformedResponse(
                    "web_search subagent returned completed wrapper with non-completed status"
                        .to_string(),
                ));
            }
            result
                .validate()
                .map_err(|error| WebSearchAdapterError::MalformedResponse(error.to_string()))?;
            if result.call_id != expected_call_id {
                return Err(WebSearchAdapterError::MalformedResponse(format!(
                    "web_search subagent returned call_id {} for request call_id {}",
                    result.call_id, expected_call_id
                )));
            }
            Ok(())
        }
        WebSearchHookOutcome::Failed(failure) => {
            failure
                .validate()
                .map_err(|error| WebSearchAdapterError::MalformedResponse(error.to_string()))?;
            if failure.call_id != expected_call_id {
                return Err(WebSearchAdapterError::MalformedResponse(format!(
                    "web_search subagent returned failed call_id {} for request call_id {}",
                    failure.call_id, expected_call_id
                )));
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use servertool_core::web_search_contract::{
        WebSearchError, WebSearchHookScope, WebSearchResult,
    };
    use std::sync::{mpsc, Mutex, OnceLock};

    static OVERSIZED_OUTPUT_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn oversized_output_test_guard() -> std::sync::MutexGuard<'static, ()> {
        OVERSIZED_OUTPUT_TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("oversized output test lock poisoned")
    }

    fn request(deadline_unix_ms: u64) -> WebSearchHookRequest {
        WebSearchHookRequest {
            request_id: "req-1".to_string(),
            call_id: "call-web-search-1".to_string(),
            query: "routecodex".to_string(),
            count: None,
            recency: None,
            content_types: vec!["text".to_string()],
            scope: WebSearchHookScope {
                entry_endpoint: "/v1/responses".to_string(),
                session_id: "session-1".to_string(),
                conversation_id: "conversation-1".to_string(),
                port: 5520,
                routing_group: "default".to_string(),
            },
            deadline_unix_ms,
            policy_id: "metadata-center-local-search".to_string(),
        }
    }

    fn future_deadline() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 60_000
    }

    #[test]
    fn command_adapter_returns_typed_completed_outcome() {
        let response = json!({
            "completed": {
                "callId": "call-web-search-1",
                "status": "completed",
                "content": "typed result",
                "sources": [],
                "metadata": null,
                "error": null
            }
        });
        let mut adapter = CommandWebSearchAdapter::new(
            "/bin/sh".to_string(),
            vec![
                "-c".to_string(),
                format!("cat >/dev/null; printf '%s' '{}'", response),
            ],
            Duration::from_secs(2),
        );
        let outcome = adapter.execute(&request(future_deadline())).unwrap();
        let WebSearchHookOutcome::Completed(result) = outcome else {
            panic!("expected completed outcome");
        };
        assert_eq!(result.call_id, "call-web-search-1");
        assert_eq!(result.content.as_deref(), Some("typed result"));
    }

    #[test]
    fn validate_outcome_rejects_completed_wrapper_with_failed_status() {
        let request = request(future_deadline());
        let outcome = WebSearchHookOutcome::Completed(WebSearchResult {
            call_id: request.call_id.clone(),
            status: WebSearchResultStatus::Failed,
            content: None,
            sources: Vec::new(),
            metadata: None,
            error: Some(WebSearchError {
                code: "search_unavailable".to_string(),
                message: "controlled failure".to_string(),
                retryable: false,
            }),
        });

        assert!(matches!(
            validate_outcome(&outcome, &request.call_id),
            Err(WebSearchAdapterError::MalformedResponse(_))
        ));
    }

    #[test]
    fn command_adapter_rejects_malformed_output() {
        let mut adapter = CommandWebSearchAdapter::new(
            "/bin/sh".to_string(),
            vec!["-c".to_string(), "cat >/dev/null; printf nope".to_string()],
            Duration::from_secs(2),
        );
        assert!(matches!(
            adapter.execute(&request(future_deadline())),
            Err(WebSearchAdapterError::MalformedResponse(_))
        ));
    }

    #[test]
    fn command_adapter_rejects_oversized_stdout() {
        let _guard = oversized_output_test_guard();
        let mut adapter = CommandWebSearchAdapter::new(
            "/bin/sh".to_string(),
            vec![
                "-c".to_string(),
                format!("cat >/dev/null; head -c {} /dev/zero", MAX_OUTPUT_BYTES + 1),
            ],
            Duration::from_secs(2),
        );
        let started = std::time::Instant::now();
        assert!(matches!(
            adapter.execute(&request(future_deadline())),
            Err(WebSearchAdapterError::MalformedResponse(reason))
                if reason.contains("stdout exceeded")
        ));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "oversized stdout must fail before the request deadline"
        );
    }

    #[test]
    fn command_adapter_rejects_oversized_stderr() {
        let _guard = oversized_output_test_guard();
        let mut adapter = CommandWebSearchAdapter::new(
            "/bin/sh".to_string(),
            vec![
                "-c".to_string(),
                format!(
                    "cat >/dev/null; head -c {} /dev/zero >&2",
                    MAX_OUTPUT_BYTES + 1
                ),
            ],
            Duration::from_secs(2),
        );
        let started = std::time::Instant::now();
        assert!(matches!(
            adapter.execute(&request(future_deadline())),
            Err(WebSearchAdapterError::MalformedResponse(reason))
                if reason.contains("stderr exceeded")
        ));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "oversized stderr must fail before the request deadline"
        );
    }

    #[test]
    fn command_adapter_rejects_mismatched_call_id() {
        let response = json!({
            "completed": {
                "callId": "call-other",
                "status": "completed",
                "content": "typed result",
                "sources": [],
                "metadata": null,
                "error": null
            }
        });
        let mut adapter = CommandWebSearchAdapter::new(
            "/bin/sh".to_string(),
            vec![
                "-c".to_string(),
                format!("cat >/dev/null; printf '%s' '{}'", response),
            ],
            Duration::from_secs(2),
        );
        assert!(matches!(
            adapter.execute(&request(future_deadline())),
            Err(WebSearchAdapterError::MalformedResponse(_))
        ));
    }

    #[test]
    fn command_adapter_returns_typed_failure() {
        let response = json!({
            "failed": {
                "callId": "call-web-search-1",
                "error": {
                    "code": "search_unavailable",
                    "message": "controlled failure",
                    "retryable": true
                }
            }
        });
        let mut adapter = CommandWebSearchAdapter::new(
            "/bin/sh".to_string(),
            vec![
                "-c".to_string(),
                format!("cat >/dev/null; printf '%s' '{}'", response),
            ],
            Duration::from_secs(2),
        );
        let outcome = adapter.execute(&request(future_deadline())).unwrap();
        let WebSearchHookOutcome::Failed(failure) = outcome else {
            panic!("expected failed outcome");
        };
        assert_eq!(failure.call_id, "call-web-search-1");
    }

    #[test]
    fn command_adapter_rejects_failed_mismatched_call_id() {
        let response = json!({
            "failed": {
                "callId": "call-other",
                "error": {
                    "code": "search_unavailable",
                    "message": "controlled failure",
                    "retryable": true
                }
            }
        });
        let mut adapter = CommandWebSearchAdapter::new(
            "/bin/sh".to_string(),
            vec![
                "-c".to_string(),
                format!("cat >/dev/null; printf '%s' '{}'", response),
            ],
            Duration::from_secs(2),
        );
        assert!(matches!(
            adapter.execute(&request(future_deadline())),
            Err(WebSearchAdapterError::MalformedResponse(_))
        ));
    }

    #[test]
    fn command_adapter_rejects_failed_empty_error_fields() {
        let response = json!({
            "failed": {
                "callId": "call-web-search-1",
                "error": {
                    "code": "",
                    "message": "",
                    "retryable": false
                }
            }
        });
        let mut adapter = CommandWebSearchAdapter::new(
            "/bin/sh".to_string(),
            vec![
                "-c".to_string(),
                format!("cat >/dev/null; printf '%s' '{}'", response),
            ],
            Duration::from_secs(2),
        );
        assert!(matches!(
            adapter.execute(&request(future_deadline())),
            Err(WebSearchAdapterError::MalformedResponse(_))
        ));
    }

    #[test]
    fn command_adapter_reports_unavailable_subagent() {
        let mut adapter = CommandWebSearchAdapter::new(
            "/definitely/missing/rcc-web-search-subagent".to_string(),
            Vec::new(),
            Duration::from_secs(2),
        );
        assert!(matches!(
            adapter.execute(&request(future_deadline())),
            Err(WebSearchAdapterError::Unavailable(_))
        ));
    }

    #[test]
    fn command_adapter_enforces_expired_request_deadline() {
        let mut adapter = CommandWebSearchAdapter::new(
            "/bin/sh".to_string(),
            vec!["-c".to_string(), "cat >/dev/null".to_string()],
            Duration::from_secs(2),
        );
        assert!(matches!(
            adapter.execute(&request(1)),
            Err(WebSearchAdapterError::Timeout(_))
        ));
    }

    #[test]
    fn command_adapter_times_out_slow_subagent() {
        let mut adapter = CommandWebSearchAdapter::new(
            "/bin/sh".to_string(),
            vec!["-c".to_string(), "cat >/dev/null; sleep 1".to_string()],
            Duration::from_millis(10),
        );
        assert!(matches!(
            adapter.execute(&request(future_deadline())),
            Err(WebSearchAdapterError::Timeout(_))
        ));
    }

    #[test]
    fn command_adapter_times_out_while_writing_to_non_reading_subagent() {
        let mut request = request(future_deadline());
        request.query = "x".repeat(1024 * 1024);
        let mut adapter = CommandWebSearchAdapter::new(
            "/bin/sleep".to_string(),
            vec!["2".to_string()],
            Duration::from_millis(20),
        );
        let (sender, receiver) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _ = sender.send(adapter.execute(&request));
        });
        let outcome = receiver.recv_timeout(Duration::from_secs(3)).expect(
            "web_search adapter must enforce its deadline while the subagent is not reading stdin",
        );
        assert!(
            matches!(outcome, Err(WebSearchAdapterError::Timeout(_))),
            "unexpected non-reading subagent outcome: {outcome:?}"
        );
        worker.join().unwrap();
    }

    #[test]
    fn command_adapter_times_out_when_descendant_keeps_stdin_open() {
        let mut request = request(future_deadline());
        request.query = "x".repeat(1024 * 1024);
        let mut adapter = CommandWebSearchAdapter::new(
            "/bin/sh".to_string(),
            vec!["-c".to_string(), "sleep 2 <&0 & exit 0".to_string()],
            Duration::from_millis(20),
        );
        let (sender, receiver) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _ = sender.send(adapter.execute(&request));
        });
        let outcome = receiver
            .recv_timeout(Duration::from_secs(3))
            .expect("web_search adapter must terminate descendants that keep stdin open");
        assert!(
            matches!(outcome, Err(WebSearchAdapterError::Timeout(_))),
            "unexpected descendant outcome: {outcome:?}"
        );
        worker.join().unwrap();
    }

    #[test]
    fn command_adapter_times_out_when_detached_descendant_keeps_stdin_open() {
        let test_binary = std::env::current_exe().unwrap();
        let mut request = request(future_deadline());
        request.query = "x".repeat(1024 * 1024);
        let mut adapter = CommandWebSearchAdapter::new(
            "/bin/sh".to_string(),
            vec![
                "-c".to_string(),
                format!(
                    "cat >/dev/null; ROUTECODEX_WEB_SEARCH_DETACHED_HELPER=1 '{}' --exact web_search_adapter::tests::detached_descendant_helper --nocapture",
                    test_binary.display()
                ),
            ],
            Duration::from_millis(20),
        );
        let started = std::time::Instant::now();
        let (sender, receiver) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _ = sender.send(adapter.execute(&request));
        });
        let outcome = receiver
            .recv_timeout(Duration::from_secs(3))
            .expect("web_search adapter must return when a detached descendant keeps stdin open");
        assert!(
            matches!(outcome, Err(WebSearchAdapterError::Timeout(_))),
            "unexpected detached descendant outcome: {outcome:?}"
        );
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "deadline return must not wait for the detached descendant"
        );
        worker.join().unwrap();
    }

    #[test]
    fn detached_descendant_helper() {
        if std::env::var_os("ROUTECODEX_WEB_SEARCH_DETACHED_HELPER").is_none() {
            return;
        }
        let session_id = unsafe { libc::setsid() };
        assert!(
            session_id > 0,
            "test helper must detach from the adapter process group"
        );
        std::thread::sleep(Duration::from_secs(2));
    }
}
