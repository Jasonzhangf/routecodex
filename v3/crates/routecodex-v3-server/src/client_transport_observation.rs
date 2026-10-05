//! Read-only Front diagnostics. No observation is a transport or routing decision.
use crate::restart_handoff::V3FrontConnectionIdentity;
use routecodex_v3_debug::{V3DebugRuntime, V3DebugTraceScope};
use serde_json::json;
use std::sync::{Arc, Mutex};

pub(crate) fn start_v3_client_trace(
    state: &crate::V3ListenerState,
    connection: Option<V3FrontConnectionIdentity>,
    request_id: &str,
    session: String,
) -> Result<(String, V3DebugTraceScope), routecodex_v3_debug::V3DebugError> {
    let execution_id = state.debug.next_execution_id(&state.server.id);
    let trace = state
        .debug
        .start_trace(&state.server.id, request_id, &execution_id)?;
    if let Some(socket) =
        connection.and_then(|identity| state.front_transport_broker.front_socket(identity))
    {
        socket.observe_request_trace(trace.clone(), session);
    }
    Ok((execution_id, trace))
}

#[derive(Clone, Debug, Default)]
pub(crate) struct V3ClientResponseObservation {
    request_sequence: u64,
    endpoint: Option<String>,
    prepared_status: Option<u16>,
    trace: Option<V3DebugTraceScope>,
    session: Option<String>,
}

#[derive(Debug)]
pub(crate) struct V3ClientTransportObservation {
    sink: Option<V3DebugRuntime>,
    console: bool,
    connection: V3FrontConnectionIdentity,
    port: u16,
    response: Mutex<V3ClientResponseObservation>,
    written_bytes: Mutex<u64>,
}

impl V3ClientTransportObservation {
    pub(crate) fn new(
        sink: Option<V3DebugRuntime>,
        console: bool,
        connection: V3FrontConnectionIdentity,
        port: u16,
    ) -> Arc<Self> {
        let observer = Arc::new(Self {
            sink,
            console,
            connection,
            port,
            response: Mutex::new(V3ClientResponseObservation::default()),
            written_bytes: Mutex::new(0),
        });
        observer.emit("socket_accepted", &observer.current(), None, None);
        observer
    }

    pub(crate) fn admitted(&self, endpoint: String) {
        let mut response = self.response.lock().expect("client observation lock");
        *response = V3ClientResponseObservation {
            request_sequence: response.request_sequence + 1,
            endpoint: Some(endpoint),
            ..Default::default()
        };
        let observation = response.clone();
        drop(response);
        self.emit("request_admitted", &observation, None, None);
    }

    pub(crate) fn bind_trace(&self, trace: V3DebugTraceScope, session: String) {
        let mut response = self.response.lock().expect("client observation lock");
        response.trace = Some(trace);
        response.session = Some(session);
        let observation = response.clone();
        drop(response);
        self.emit("request_identified", &observation, None, None);
    }

    pub(crate) fn prepared(&self, status: u16, discarded: bool) {
        let mut response = self.response.lock().expect("client observation lock");
        response.prepared_status = Some(status);
        let observation = response.clone();
        drop(response);
        self.emit(
            if discarded {
                "response_discarded"
            } else {
                "response_prepared"
            },
            &observation,
            None,
            None,
        );
    }

    pub(crate) fn current(&self) -> V3ClientResponseObservation {
        self.response
            .lock()
            .expect("client observation lock")
            .clone()
    }

    pub(crate) fn wrote(&self, response: &V3ClientResponseObservation, bytes: usize) {
        *self
            .written_bytes
            .lock()
            .expect("client byte observation lock") += bytes as u64;
        self.emit("socket_write", response, Some(bytes), None);
    }

    pub(crate) fn emit(
        &self,
        stage: &str,
        response: &V3ClientResponseObservation,
        bytes: Option<usize>,
        error: Option<String>,
    ) {
        let Some(sink) = &self.sink else { return };
        let line = json!({
            "event": "client_transport",
            "timestamp_epoch_ms": super::restart_handoff::v3_front_epoch_ms(),
            "stage": stage,
            "port": self.port,
            "connection_id": self.connection.0,
            "request_sequence": response.request_sequence,
            "endpoint": response.endpoint,
            "prepared_status": response.prepared_status,
            "request_id": response.trace.as_ref().map(|trace| &trace.request_id),
            "execution_id": response.trace.as_ref().map(|trace| &trace.execution_id),
            "server_id": response.trace.as_ref().map(|trace| &trace.server_id),
            "session": response.session,
            "written_bytes": bytes,
            "connection_written_bytes": *self.written_bytes.lock().expect("client byte observation lock"),
            "error": error,
        }).to_string();
        if self.console {
            eprintln!("{line}");
        }
        if let Err(error) = sink.append_human_console_line(&line) {
            eprintln!("V3 client transport observation sink failed: {error}");
        }
    }
}
