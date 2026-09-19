//! Mounted hook handler framework.
//!
//! The sidecar never owns business policy. It exposes two handler strategies:
//! a no-op placeholder for wiring tests and a command handler that calls a
//! user-owned executable on the JSON event/state boundary.

use crate::*;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::process::{Command, Stdio};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HookHandlersConfig {
    pub schema_version: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_search_adapter: Option<WebSearchAdapterConfig>,
    pub handlers: Vec<HookHandlerConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WebSearchAdapterConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HookHandlerConfig {
    pub handler_id: String,
    pub hook_kind: String,
    pub strategy: HookHandlerStrategy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HookHandlerStrategy {
    NoOp,
    Command { command: String, args: Vec<String> },
}

#[derive(Debug, Error)]
pub enum HookConfigError {
    #[error("hooks handlers config io failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("hooks handlers config JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported hooks handlers config schema version: {0}")]
    UnsupportedSchema(u16),
    #[error("invalid web_search adapter config: {0}")]
    InvalidWebSearchAdapter(String),
}

pub fn mount_handlers_from_config<T: AppServerTransport>(
    core: &mut HooksSidecarCore<T>,
    config: &HookHandlersConfig,
) -> Result<(), HookConfigError> {
    if config.schema_version != 1 {
        return Err(HookConfigError::UnsupportedSchema(config.schema_version));
    }
    if let Some(adapter) = &config.web_search_adapter {
        if adapter.command.trim().is_empty() || adapter.timeout_ms == 0 {
            return Err(HookConfigError::InvalidWebSearchAdapter(
                "command and timeout_ms must be non-empty".to_string(),
            ));
        }
        core.mount_web_search_adapter(CommandWebSearchAdapter::new(
            adapter.command.clone(),
            adapter.args.clone(),
            std::time::Duration::from_millis(adapter.timeout_ms),
        ));
    }
    for handler in &config.handlers {
        mount_configured_handler(core, handler);
    }
    Ok(())
}

pub fn mount_configured_handler<T: AppServerTransport>(
    core: &mut HooksSidecarCore<T>,
    config: &HookHandlerConfig,
) {
    core.mount_handler_config(config.clone());
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandHookHandler {
    command: String,
    args: Vec<String>,
}

impl CommandHookHandler {
    pub fn new(command: String, args: Vec<String>) -> Self {
        Self { command, args }
    }
}

impl HookHandler for CommandHookHandler {
    fn handle(
        &self,
        event: &HookEvent,
        state: &HookState,
    ) -> Result<HookDecision, HookRegistryError> {
        let input = serde_json::json!({
            "event": event,
            "state": state,
        });
        let mut child = Command::new(&self.command)
            .args(&self.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                HookRegistryError::HandlerError(format!(
                    "hook command {} failed to spawn: {error}",
                    self.command
                ))
            })?;
        let mut stdin = child.stdin.take().ok_or_else(|| {
            HookRegistryError::HandlerError(format!(
                "hook command {} stdin unavailable",
                self.command
            ))
        })?;
        let stdin_write_error = match stdin.write_all(input.to_string().as_bytes()) {
            Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => None,
            Err(error) => Some(error),
            Ok(()) => None,
        };
        drop(stdin);
        let output = child.wait_with_output().map_err(|error| {
            HookRegistryError::HandlerError(format!(
                "hook command {} wait failed: {error}",
                self.command
            ))
        })?;
        if !output.status.success() {
            return Err(HookRegistryError::HandlerError(format!(
                "hook command {} exited {}: {}",
                self.command,
                output.status,
                String::from_utf8_lossy(&output.stderr)
            )));
        }
        if let Some(error) = stdin_write_error {
            return Err(HookRegistryError::HandlerError(format!(
                "hook command {} stdin write failed: {error}",
                self.command
            )));
        }
        serde_json::from_slice(&output.stdout).map_err(|error| {
            HookRegistryError::HandlerError(format!(
                "hook command {} returned invalid decision JSON: {error}",
                self.command
            ))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct AcceptingTransport;

    impl AppServerTransport for AcceptingTransport {
        fn session_status(
            &mut self,
            _target: &SessionTarget,
        ) -> Result<SessionStatus, AppServerError> {
            Ok(SessionStatus {
                state: SessionState::Idle,
                input_active: false,
            })
        }

        fn send_message(
            &mut self,
            intent: &MessageIntent,
        ) -> Result<DeliveryEvidenceRecord, AppServerError> {
            Ok(DeliveryEvidenceRecord {
                intent_id: intent.intent_id.clone(),
                message_id: format!("receipt:{}", intent.intent_id),
                state: DeliveryState::Accepted,
                cursor: None,
                read_item_id: None,
                start_error: None,
            })
        }

        fn delivery_evidence(
            &mut self,
            intent: &MessageIntent,
            _baseline: &[String],
        ) -> Result<DeliveryEvidenceRecord, AppServerError> {
            Ok(DeliveryEvidenceRecord {
                intent_id: intent.intent_id.clone(),
                message_id: format!("receipt:{}", intent.intent_id),
                state: DeliveryState::Accepted,
                cursor: None,
                read_item_id: None,
                start_error: None,
            })
        }
    }

    #[test]
    fn handlers_config_mounts_noop_handler_only_when_declared() {
        let mut core = HooksSidecarCore::new(DisabledTransport);
        let config = HookHandlersConfig {
            schema_version: 1,
            web_search_adapter: None,
            handlers: vec![HookHandlerConfig {
                handler_id: "stopless-handler".to_string(),
                hook_kind: "stop".to_string(),
                strategy: HookHandlerStrategy::NoOp,
            }],
        };
        mount_handlers_from_config(&mut core, &config).unwrap();
        let outcome = core
            .dispatch_hook_event(
                &HookEvent {
                    event_name: "Stop".to_string(),
                    hook_kind: "stop".to_string(),
                    source: None,
                },
                &HookState {
                    status: "idle".to_string(),
                    detail: None,
                },
            )
            .unwrap();
        assert_eq!(outcome, DispatchOutcome::NoOp);
    }

    #[test]
    fn command_handler_accepts_noop_decision_json() {
        let handler = CommandHookHandler::new(
            "/bin/sh".to_string(),
            vec!["-c".to_string(), "printf '{\"no_op\":null}'".to_string()],
        );
        let decision = handler
            .handle(
                &HookEvent {
                    event_name: "Stop".to_string(),
                    hook_kind: "stop".to_string(),
                    source: None,
                },
                &HookState {
                    status: "idle".to_string(),
                    detail: None,
                },
            )
            .unwrap();
        assert_eq!(decision, HookDecision::NoOp);
    }

    #[test]
    fn command_handler_preserves_nonzero_exit_as_handler_error() {
        let handler = CommandHookHandler::new(
            "/bin/sh".to_string(),
            vec!["-c".to_string(), "echo bad >&2; exit 7".to_string()],
        );
        let error = handler
            .handle(
                &HookEvent {
                    event_name: "Stop".to_string(),
                    hook_kind: "stop".to_string(),
                    source: None,
                },
                &HookState {
                    status: "idle".to_string(),
                    detail: None,
                },
            )
            .unwrap_err();
        assert!(format!("{error}").contains("exited"));
        assert!(format!("{error}").contains("bad"));
    }

    #[test]
    fn stopless_example_is_an_external_mounted_handler_only() {
        let config: HookHandlersConfig =
            serde_json::from_str(include_str!("../examples/stopless-mounted-handler.json"))
                .unwrap();
        let mut core = HooksSidecarCore::new(AcceptingTransport);
        mount_handlers_from_config(&mut core, &config).unwrap();
        let decision = core
            .dispatch_hook_event(
                &HookEvent {
                    event_name: "Stop".to_string(),
                    hook_kind: "stop".to_string(),
                    source: None,
                },
                &HookState {
                    status: "idle".to_string(),
                    detail: None,
                },
            )
            .unwrap();
        match decision {
            DispatchOutcome::Sent(evidence) => {
                assert_eq!(evidence.state, DeliveryState::Accepted);
            }
            other => panic!("expected the mounted Stopless example to send, got {other:?}"),
        }
    }
}
