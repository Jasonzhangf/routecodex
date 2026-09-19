//! Minimal WebSearch execution adapter for the hooks sidecar.
//!
//! The adapter owns only the typed request/result boundary and deadline
//! enforcement. It never calls Router, Target, Provider, or the client frame.

use serde::{Deserialize, Serialize};
use servertool_core::web_search_contract::{WebSearchHookOutcome, WebSearchHookRequest};
use std::io::Write;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, TryRecvError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
        let mut stdin = child.stdin.take().ok_or_else(|| {
            WebSearchAdapterError::Unavailable("web_search subagent stdin unavailable".to_string())
        })?;
        let (write_sender, write_receiver) = mpsc::sync_channel(1);
        let writer = std::thread::spawn(move || {
            let result = stdin.write_all(payload.as_bytes());
            drop(stdin);
            let _ = write_sender.send(result);
        });
        let mut write_result = None;
        let mut child_exited = false;
        loop {
            if write_result.is_none() {
                match write_receiver.try_recv() {
                    Ok(result) => write_result = Some(result),
                    Err(TryRecvError::Empty) => {}
                    Err(TryRecvError::Disconnected) => {
                        terminate_child(&mut child);
                        let _ = writer.join();
                        return Err(WebSearchAdapterError::Unavailable(
                            "web_search subagent stdin writer stopped without a result".to_string(),
                        ));
                    }
                }
            }
            if let Some(Err(error)) = write_result.as_ref() {
                terminate_child(&mut child);
                let _ = writer.join();
                return Err(WebSearchAdapterError::Unavailable(format!(
                    "web_search subagent stdin failed: {error}"
                )));
            }
            if !child_exited {
                match child.try_wait() {
                    Ok(Some(_)) => child_exited = true,
                    Ok(None) => {}
                    Err(error) => {
                        terminate_child(&mut child);
                        let _ = writer.join();
                        return Err(WebSearchAdapterError::Unavailable(format!(
                            "web_search subagent wait failed: {error}"
                        )));
                    }
                }
            }
            if child_exited && write_result.is_some() {
                break;
            }
            if std::time::Instant::now() >= deadline {
                terminate_child(&mut child);
                let _ = writer.join();
                return Err(WebSearchAdapterError::Timeout(
                    "web_search subagent exceeded request deadline".to_string(),
                ));
            }
            match (child_exited, write_result.is_some()) {
                (true, true) => break,
                _ => std::thread::sleep(Duration::from_millis(5)),
            }
        }
        writer.join().map_err(|_| {
            WebSearchAdapterError::Unavailable(
                "web_search subagent stdin writer panicked".to_string(),
            )
        })?;
        if let Some(Err(error)) = write_result {
            return Err(WebSearchAdapterError::Unavailable(format!(
                "web_search subagent stdin failed: {error}"
            )));
        }
        let output = child.wait_with_output().map_err(|error| {
            WebSearchAdapterError::Unavailable(format!(
                "web_search subagent output failed: {error}"
            ))
        })?;
        if !output.status.success() {
            return Err(WebSearchAdapterError::Unavailable(format!(
                "web_search subagent exited {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
            )));
        }
        let outcome: WebSearchHookOutcome =
            serde_json::from_slice(&output.stdout).map_err(|error| {
                WebSearchAdapterError::MalformedResponse(format!(
                    "web_search subagent returned invalid outcome JSON: {error}"
                ))
            })?;
        validate_outcome(&outcome, &request.call_id)?;
        Ok(outcome)
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
        WebSearchHookOutcome::Failed(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use servertool_core::web_search_contract::WebSearchHookScope;

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
                "code": "search_unavailable",
                "message": "controlled failure",
                "retryable": true
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
        assert!(matches!(outcome, WebSearchHookOutcome::Failed(_)));
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
        assert!(matches!(outcome, Err(WebSearchAdapterError::Timeout(_))));
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
        assert!(matches!(outcome, Err(WebSearchAdapterError::Timeout(_))));
        worker.join().unwrap();
    }
}
