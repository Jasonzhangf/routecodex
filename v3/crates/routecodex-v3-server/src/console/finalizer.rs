use super::super::*;
use super::*;

pub(crate) struct V3SseConsoleFinalizer {
    pub(crate) context: V3ConsoleEmissionContext,
    pub(crate) status: u16,
    pub(crate) node_trace: Vec<&'static str>,
    pub(crate) observability: V3RuntimeObservability,
    pub(crate) stream_observation: V3RuntimeStreamObservation,
    pub(crate) started_at: Instant,
}

pub(crate) struct V3DirectSseConsoleFinalizer {
    pub(crate) context: V3ConsoleEmissionContext,
    pub(crate) status: u16,
    pub(crate) node_trace: Vec<&'static str>,
    pub(crate) observability: V3RuntimeObservability,
    pub(crate) stream_observation: Option<V3RuntimeStreamObservation>,
    pub(crate) started_at: Instant,
}

const V3_SSE_CLIENT_DISCONNECTED_MESSAGE: &str =
    "client disconnected before provider SSE stream completed";
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum V3SseConsoleStreamTerminal {
    Completed,
    Failed(String),
    Dropped,
}

impl V3SseConsoleFinalizer {
    pub(crate) fn complete(mut self) {
        if let Err(error) = merge_v3_runtime_stream_observation(
            &mut self.observability,
            Some(&self.stream_observation),
        ) {
            self.provider_stream_failed(&error);
            return;
        }
        if let Some(status) = self.observability.response_status.clone() {
            if is_v3_sse_terminal_success_status(&status) {
                self.emit_complete_lines();
                return;
            }
            if is_v3_sse_terminal_failure_status(&status) {
                self.provider_stream_terminal_failed(&status);
                return;
            }
        }
        self.provider_stream_missing_terminal();
    }

    pub(crate) fn emit_complete_lines(self) {
        let elapsed = self.started_at.elapsed();
        emit_v3_stopless_console_line(&self.context, &self.observability);
        emit_v3_request_complete_console_line(
            &self.context,
            self.status,
            &self.node_trace,
            &self.observability,
            elapsed,
        );
        emit_v3_usage_console_line(
            &self.context,
            &self.node_trace,
            &self.observability,
            elapsed,
        );
    }

    pub(crate) fn provider_stream_failed(self, error: &str) {
        self.fail(502, "provider_response_sse_stream", error);
    }

    pub(crate) fn provider_stream_missing_terminal(self) {
        self.provider_stream_failed("provider response SSE stream ended before terminal event");
    }

    pub(crate) fn provider_stream_terminal_failed(self, status: &str) {
        self.fail(
            502,
            "provider_response_sse_terminal_failure",
            &format!("response SSE stream ended with terminal status {status}"),
        );
    }

    pub(crate) fn client_disconnected(self) {
        self.fail(499, "client_disconnect", V3_SSE_CLIENT_DISCONNECTED_MESSAGE);
    }

    pub(crate) fn fail(self, status: u16, code: &str, message: &str) {
        let body = json!({
            "error": {
                "code": code,
                "message": message
            }
        });
        emit_v3_error_console_line_for_context(
            &self.context,
            &self.observability,
            status,
            &V3_ERROR_CHAIN_NODE_IDS,
            Some(&body),
        );
    }
}

impl V3DirectSseConsoleFinalizer {
    pub(crate) fn complete(mut self) {
        if let Err(error) = self.merge_stream_observation() {
            self.provider_stream_failed(&error);
            return;
        }
        if let Some(status) = self.observability.response_status.clone() {
            if is_v3_sse_terminal_success_status(&status) {
                self.emit_complete_lines();
                return;
            }
            if is_v3_sse_terminal_failure_status(&status) {
                self.provider_stream_terminal_failed(&status);
                return;
            }
        }
        self.provider_stream_missing_terminal();
    }

    pub(crate) fn emit_complete_lines(self) {
        let elapsed = self.started_at.elapsed();
        emit_v3_stopless_console_line(&self.context, &self.observability);
        if should_emit_v3_request_complete_console_line(self.status, &self.observability) {
            emit_v3_request_complete_console_line(
                &self.context,
                self.status,
                &self.node_trace,
                &self.observability,
                elapsed,
            );
        }
        emit_v3_usage_console_line(
            &self.context,
            &self.node_trace,
            &self.observability,
            elapsed,
        );
    }

    pub(crate) fn provider_stream_failed(self, error: &str) {
        self.fail(502, "provider_response_sse_stream", error);
    }

    pub(crate) fn provider_stream_missing_terminal(self) {
        self.provider_stream_failed("provider response SSE stream ended before terminal event");
    }

    pub(crate) fn provider_stream_terminal_failed(self, status: &str) {
        self.fail(
            502,
            "provider_response_sse_terminal_failure",
            &format!("response SSE stream ended with terminal status {status}"),
        );
    }

    pub(crate) fn client_disconnected(mut self) {
        if let Err(error) = self.merge_stream_observation() {
            self.provider_stream_failed(&error);
            return;
        }
        if let Some(status) = self.observability.response_status.clone() {
            if is_v3_sse_terminal_success_status(&status) {
                self.complete();
                return;
            }
            if is_v3_sse_terminal_failure_status(&status) {
                self.provider_stream_terminal_failed(&status);
                return;
            }
        }
        self.fail(499, "client_disconnect", V3_SSE_CLIENT_DISCONNECTED_MESSAGE);
    }

    pub(crate) fn merge_stream_observation(&mut self) -> Result<(), String> {
        merge_v3_runtime_stream_observation(
            &mut self.observability,
            self.stream_observation.as_ref(),
        )
    }

    pub(crate) fn fail(self, status: u16, code: &str, message: &str) {
        let body = json!({
            "error": {
                "code": code,
                "message": message
            }
        });
        emit_v3_error_console_line_for_context(
            &self.context,
            &self.observability,
            status,
            &V3_ERROR_CHAIN_NODE_IDS,
            Some(&body),
        );
    }
}

pub(crate) fn merge_v3_runtime_stream_observation(
    observability: &mut V3RuntimeObservability,
    observation: Option<&V3RuntimeStreamObservation>,
) -> Result<(), String> {
    if let Some(observation) = observation {
        let snapshot = observation.snapshot()?;
        if snapshot.response_status.is_some() {
            observability.response_status = snapshot.response_status;
        }
        if snapshot.finish_reason.is_some() {
            observability.finish_reason = snapshot.finish_reason;
        }
        if snapshot.usage.is_some() {
            observability.usage = snapshot.usage;
        }
    }
    Ok(())
}

pub(crate) fn is_v3_sse_terminal_success_status(status: &str) -> bool {
    matches!(status.trim(), "completed" | "requires_action" | "done")
}

pub(crate) fn is_v3_sse_terminal_failure_status(status: &str) -> bool {
    matches!(
        status.trim(),
        "failed" | "incomplete" | "cancelled" | "canceled" | "error"
    )
}
