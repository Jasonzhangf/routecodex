//! Minimal WebSearch execution adapter for the hooks sidecar.
//!
//! The adapter owns only the typed request/result boundary and deadline
//! enforcement. It never calls Router, Target, Provider, or the client frame.

use serde::{Deserialize, Serialize};
use servertool_core::web_search_contract::{WebSearchHookOutcome, WebSearchHookRequest};
use std::io::Write;
use std::process::{Command, Stdio};
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
        let mut child = Command::new(&self.command)
            .args(&self.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
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
        stdin
            .write_all(request_payload(request)?.as_bytes())
            .map_err(|error| {
                WebSearchAdapterError::Unavailable(format!(
                    "web_search subagent stdin failed: {error}"
                ))
            })?;
        drop(stdin);

        let deadline = std::time::Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if std::time::Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(WebSearchAdapterError::Timeout(
                        "web_search subagent exceeded request deadline".to_string(),
                    ));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(5)),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(WebSearchAdapterError::Unavailable(format!(
                        "web_search subagent wait failed: {error}"
                    )));
                }
            }
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
}
