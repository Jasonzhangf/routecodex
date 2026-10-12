use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{oneshot, Notify};

use crate::restart_handoff::V3FrontConnectionIdentity;
use routecodex_v3_error::{V3ClientTransportFailure, V3ClientTransportOperation};

/// The real client transport cause the Front observed at the socket boundary.
///
/// It is transport truth owned by the Server: the write / flush / peer EOF /
/// reset / read-error operation plus the raw OS kind and cause. It is the input
/// the Server submits to the typed Error source API; it is never a typed Error
/// decision.
#[derive(Debug, Clone)]
pub(crate) struct V3FrontClientTransportCause {
    pub operation: V3ClientTransportOperation,
    pub io_kind: Option<String>,
    pub os_cause: Option<String>,
}

#[derive(Debug)]
pub(crate) struct V3FrontTransportCloseoutState {
    request_cycle: Mutex<V3FrontTransportRequestCycle>,
    closed: AtomicBool,
    peer_disconnected: AtomicBool,
    peer_disconnect_notify: Notify,
    transport_wrote: AtomicBool,
    transport_write_notify: Notify,
    /// First real client transport cause on this connection, if any.
    client_transport_cause: Mutex<Option<V3FrontClientTransportCause>>,
    /// Once-guard so the corrected client-source Error chain + closeout run
    /// exactly once per connection regardless of which owner observes first.
    client_source_closeout: AtomicBool,
    socket_closed: AtomicBool,
    socket_closed_notify: Notify,
    http_closed: AtomicBool,
    http_closed_notify: Notify,
    request_finalized: AtomicBool,
    abort_requested: AtomicBool,
    abort_notify: Notify,
}

#[derive(Debug, Default)]
struct V3FrontTransportRequestCycle {
    request_started: bool,
    response_started: bool,
    terminal_frame_suppressed: bool,
    restart_deferred: bool,
}

impl V3FrontTransportCloseoutState {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            request_cycle: Mutex::new(V3FrontTransportRequestCycle::default()),
            closed: AtomicBool::new(false),
            peer_disconnected: AtomicBool::new(false),
            peer_disconnect_notify: Notify::new(),
            transport_wrote: AtomicBool::new(false),
            transport_write_notify: Notify::new(),
            client_transport_cause: Mutex::new(None),
            client_source_closeout: AtomicBool::new(false),
            socket_closed: AtomicBool::new(false),
            socket_closed_notify: Notify::new(),
            http_closed: AtomicBool::new(false),
            http_closed_notify: Notify::new(),
            request_finalized: AtomicBool::new(false),
            abort_requested: AtomicBool::new(false),
            abort_notify: Notify::new(),
        })
    }

    /// Record the first real client transport cause observed on this connection.
    /// Later observations do not overwrite the first divergence.
    pub(crate) fn record_client_transport_cause(&self, cause: V3FrontClientTransportCause) {
        let mut slot = self
            .client_transport_cause
            .lock()
            .expect("front client transport cause lock");
        if slot.is_none() {
            *slot = Some(cause);
        }
    }

    pub(crate) fn take_client_transport_cause(&self) -> Option<V3FrontClientTransportCause> {
        self.client_transport_cause
            .lock()
            .expect("front client transport cause lock")
            .clone()
    }

    /// Returns `true` for the single caller that must run the corrected
    /// client-source Error chain + closeout.
    pub(crate) fn begin_client_source_closeout(&self) -> bool {
        !self.client_source_closeout.swap(true, Ordering::AcqRel)
    }

    pub(crate) fn mark_request_started(&self) {
        let mut request_cycle = self
            .request_cycle
            .lock()
            .expect("front closeout request cycle lock");
        request_cycle.request_started = true;
        request_cycle.response_started = false;
        request_cycle.restart_deferred = false;
        self.transport_wrote.store(false, Ordering::Release);
    }

    pub(crate) fn mark_response_started(&self) {
        self.request_cycle
            .lock()
            .expect("front closeout request cycle lock")
            .response_started = true;
    }

    /// Close this connection for an exec replacement.
    ///
    /// Returns `false` when the closeout is deferred because a streaming terminal
    /// already owns the client-visible boundary and its response bytes have not
    /// reached the client yet. Closing there signals the biased write-worker close,
    /// which can drop the queued SSE head and turn the transport break back into the
    /// silent zero-byte close it replaces. Only a typed deferred close is retained;
    /// restart must never fabricate a client error response.
    pub(crate) fn close_for_exec_replacement(&self) -> bool {
        let mut request_cycle = self
            .request_cycle
            .lock()
            .expect("front closeout request cycle lock");
        if request_cycle.terminal_frame_suppressed && !self.transport_wrote() {
            request_cycle.restart_deferred = true;
            return false;
        }
        self.closed.store(true, Ordering::Release);
        true
    }

    /// Commit the deferred restart closeout when the streaming terminal's body failed
    /// and its response bytes never reached the client.
    ///
    /// Called from the streaming terminal right before its body fails, so a restart
    /// replacement that raced the transport break closes without an error frame.
    /// Returns `true` when the
    /// closeout must be signalled; response bytes that did reach the client make the
    /// SSE transport break the client boundary and drop the deferred frame.
    pub(crate) fn commit_deferred_restart_closeout(&self) -> bool {
        let mut request_cycle = self
            .request_cycle
            .lock()
            .expect("front closeout request cycle lock");
        if self.transport_wrote() || !request_cycle.restart_deferred {
            request_cycle.restart_deferred = false;
            return false;
        }
        self.closed.store(true, Ordering::Release);
        request_cycle.restart_deferred = false;
        true
    }

    pub(crate) fn transport_wrote(&self) -> bool {
        self.transport_wrote.load(Ordering::Acquire)
    }

    pub(crate) fn abort_without_response(&self) {
        let mut request_cycle = self
            .request_cycle
            .lock()
            .expect("front closeout request cycle lock");
        request_cycle.terminal_frame_suppressed = true;
        self.closed.store(true, Ordering::Release);
        self.abort_requested.store(true, Ordering::Release);
        self.abort_notify.notify_waiters();
    }

    /// Suppress a pending restart closeout frame for a terminal that owns its own
    /// client-visible boundary.
    ///
    /// The streaming no-response terminal owns the incomplete SSE transfer, so a
    /// concurrent restart replacement must not queue another client frame.
    /// Unlike `abort_without_response` this leaves the connection open, because Hyper
    /// still has to write the response head before the body fails.
    ///
    /// Returns `false` when a restart closeout already committed on this connection.
    /// The committed transport close is the client-visible boundary then.
    pub(crate) fn suppress_restart_closeout_frame(&self) -> bool {
        let mut request_cycle = self
            .request_cycle
            .lock()
            .expect("front closeout request cycle lock");
        if self.closed.load(Ordering::Acquire) {
            return false;
        }
        request_cycle.terminal_frame_suppressed = true;
        true
    }

    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::Release);
    }

    pub(crate) fn mark_socket_closed(&self) {
        self.socket_closed.store(true, Ordering::Release);
        self.socket_closed_notify.notify_waiters();
    }

    pub(crate) async fn wait_socket_closed(&self) {
        let notified = self.socket_closed_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if !self.socket_closed.load(Ordering::Acquire) {
            notified.await;
        }
    }

    pub(crate) fn mark_http_closed(&self) {
        self.http_closed.store(true, Ordering::Release);
        self.http_closed_notify.notify_waiters();
    }

    async fn wait_http_closed(&self) {
        let notified = self.http_closed_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if !self.http_closed.load(Ordering::Acquire) {
            notified.await;
        }
    }

    pub(crate) fn is_aborted(&self) -> bool {
        self.abort_requested.load(Ordering::Acquire)
    }

    pub(crate) async fn wait_abort(&self) {
        let notified = self.abort_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if !self.is_aborted() {
            notified.await;
        }
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub(crate) fn is_peer_disconnected(&self) -> bool {
        self.peer_disconnected.load(Ordering::Acquire)
    }

    pub(crate) fn mark_peer_disconnected(&self) {
        if !self.peer_disconnected.swap(true, Ordering::AcqRel) {
            self.peer_disconnect_notify.notify_waiters();
        }
    }

    pub(crate) async fn wait_peer_disconnected(&self) {
        let notified = self.peer_disconnect_notify.notified();
        if !self.peer_disconnected.load(Ordering::Acquire) {
            notified.await;
        }
    }

    /// Record that the Front transport wrote response bytes to the client socket.
    pub(crate) fn mark_transport_wrote(&self) {
        if !self.transport_wrote.swap(true, Ordering::AcqRel) {
            self.transport_write_notify.notify_waiters();
        }
    }

    /// Wait until the Front transport wrote response bytes to the client socket.
    ///
    /// A streaming terminal uses this as its flush boundary: the transfer must not fail
    /// before the response head and its first frame reached the transport, otherwise the
    /// client observes a connection that closes without any bytes, which is the silent
    /// end of stream this terminal must not produce.
    pub(crate) async fn wait_transport_wrote(&self) {
        let notified = self.transport_write_notify.notified();
        tokio::pin!(notified);
        // Register the waiter before re-reading the flag so a write landing between the
        // check and the await cannot be lost.
        notified.as_mut().enable();
        if self.transport_wrote.load(Ordering::Acquire) {
            return;
        }
        notified.await;
    }

    pub(crate) fn signal_socket_close(&self, close_tx: &Mutex<Option<oneshot::Sender<()>>>) {
        let _ = close_tx
            .lock()
            .expect("front socket close lock")
            .take()
            .map(|tx| tx.send(()));
    }
}

/// The once-only corrected client-source Error chain + closeout driver.
///
/// The Server owns the real client transport observation. At the client transport
/// boundary it submits the captured cause and identity to the fixed Error chain
/// (through the Runtime entry), then executes the typed transport intent and
/// records the abort / already-disconnected receipt, drain, attempt cleanup and
/// request finalizer. It never switches, excludes or cools a provider, and it
/// never projects an error / end / status / notification / `[DONE]` frame.
#[derive(Clone, Debug)]
pub(crate) struct V3FrontClientSourceCloseout {
    sink: Option<routecodex_v3_debug::V3DebugRuntime>,
    connection_id: V3FrontConnectionIdentity,
    closeout_state: Arc<V3FrontTransportCloseoutState>,
    trace: Arc<Mutex<Option<routecodex_v3_debug::V3DebugTraceScope>>>,
    request_id: Arc<Mutex<Option<String>>>,
    runtime_task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    close_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

impl V3FrontClientSourceCloseout {
    pub(crate) fn new(
        sink: Option<routecodex_v3_debug::V3DebugRuntime>,
        connection_id: V3FrontConnectionIdentity,
        closeout_state: Arc<V3FrontTransportCloseoutState>,
        close_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    ) -> Self {
        Self {
            sink,
            connection_id,
            closeout_state,
            trace: Arc::new(Mutex::new(None)),
            request_id: Arc::new(Mutex::new(None)),
            runtime_task: Arc::new(Mutex::new(None)),
            close_tx,
        }
    }

    pub(crate) fn set_trace(&self, trace: routecodex_v3_debug::V3DebugTraceScope) {
        *self.trace.lock().expect("front client source trace lock") = Some(trace);
    }

    pub(crate) fn bind_request(&self, request_id: String) {
        *self.request_id.lock().expect("front typed request lock") = Some(request_id);
    }

    pub(crate) fn bind_runtime_task(&self, task: tokio::task::JoinHandle<()>) {
        *self.runtime_task.lock().expect("front runtime task lock") = Some(task);
    }

    /// Test-only detached socket handle. No request or runtime task is bound.
    #[cfg(test)]
    pub(crate) fn detached(
        connection_id: V3FrontConnectionIdentity,
        closeout_state: Arc<V3FrontTransportCloseoutState>,
    ) -> Self {
        Self::new(
            None,
            connection_id,
            closeout_state,
            Arc::new(Mutex::new(None)),
        )
    }

    /// Connection-level hook: run the corrected client-source Error chain and
    /// closeout exactly once, and only for a genuine recorded client transport
    /// failure. A normal connection close records no cause and must never
    /// fabricate a client-source Error chain for a delivered business response.
    pub(crate) fn drive(&self) {
        let Some(cause) = self.closeout_state.take_client_transport_cause() else {
            return;
        };
        self.run(cause);
    }

    /// The committed client SSE channel was dropped before its normal completion:
    /// the client transport broke mid-response. Run the chain even when no
    /// OS-level cause was captured yet (the premature drop is the evidence).
    pub(crate) fn drive_premature_disconnect(&self) {
        let cause = match self.closeout_state.take_client_transport_cause() {
            Some(cause) => cause,
            None => V3FrontClientTransportCause {
                operation: V3ClientTransportOperation::Cancellation,
                io_kind: None,
                os_cause: Some("committed client body dropped before completion".into()),
            },
        };
        self.run(cause);
    }

    pub(crate) fn drive_internal_channel_loss(&self) {
        self.run(V3FrontClientTransportCause {
            operation: V3ClientTransportOperation::InternalChannelLoss,
            io_kind: None,
            os_cause: Some("runtime outcome sender dropped".into()),
        });
    }

    fn run(&self, cause: V3FrontClientTransportCause) {
        if !self.closeout_state.begin_client_source_closeout() {
            return;
        }
        let owner = self.clone();
        tokio::spawn(async move {
            let _ = owner.close_request(cause).await;
        });
    }

    fn record(&self, node: &str, detail: Option<serde_json::Value>) {
        if let (Some(sink), Some(trace)) = (
            &self.sink,
            self.trace.lock().expect("front trace lock").as_ref(),
        ) {
            let _ = sink.record_node_event(trace, node, "executed", detail);
        }
    }

    async fn close_request(
        &self,
        cause: V3FrontClientTransportCause,
    ) -> Option<
        Result<
            routecodex_v3_runtime::operation_runner::V3ClientSourceErrorChainExecution,
            routecodex_v3_runtime::operation_runner::OperationRunnerError,
        >,
    > {
        let request_id = self
            .request_id
            .lock()
            .expect("front typed request lock")
            .clone();
        let execution = request_id.map(|request_id| {
            routecodex_v3_runtime::operation_runner::execute_v3_client_source_error_chain(
                V3ClientTransportFailure {
                    operation: cause.operation,
                    io_kind: cause.io_kind,
                    os_cause: cause.os_cause,
                    connection_id: self.connection_id.0,
                    request_id,
                    attempt_id: None,
                },
            )
        });
        if let Some(Ok(execution)) = &execution {
            for node in execution.completed_node_ids {
                self.record(
                    node,
                    Some(serde_json::json!({"phase":"client_source_error_chain"})),
                );
            }
            self.record(
                "RuntimeTransportOutcome",
                Some(serde_json::json!({
                    "intent": format!("{:?}", execution.transport_outcome.intent),
                    "health_neutral": execution.transport_outcome.health_neutral,
                })),
            );
        }
        // Apply the typed terminal intent to this socket only. Unbound framing
        // failures still close physically, but never claim a request graph ran.
        if let Some(Ok(execution)) = &execution {
            match execution.transport_outcome.intent {
                routecodex_v3_runtime::operation_runner::V3RuntimeTransportIntent::Abort => {
                    self.closeout_state.abort_without_response();
                    self.closeout_state.signal_socket_close(&self.close_tx);
                }
                routecodex_v3_runtime::operation_runner::V3RuntimeTransportIntent::AlreadyDisconnected => {}
            }
        } else {
            // A framing failure with no admitted request, or a truthful SDK
            // execution failure, still cannot leave the socket or task alive.
            self.closeout_state.abort_without_response();
            self.closeout_state.signal_socket_close(&self.close_tx);
            if let Some(Err(error)) = &execution {
                eprintln!("client-source Error execution failed: {error}");
            }
        }
        let task = self
            .runtime_task
            .lock()
            .expect("front runtime task lock")
            .take();
        if let Some(task) = &task {
            task.abort();
        }
        self.closeout_state.wait_socket_closed().await;
        self.closeout_state.wait_http_closed().await;
        let receipt = routecodex_v3_runtime::operation_runner::V3ServerTransportCloseReceipt {
            connection_id: self.connection_id.0,
            already_disconnected: self.closeout_state.is_peer_disconnected(),
        };
        self.record(
            "ServerAbortOrAlreadyDisconnectedReceipt",
            Some(serde_json::json!({"transport":"client", "socket_closed":true})),
        );
        let cleanup =
            routecodex_v3_runtime::operation_runner::drain_v3_client_source_request(receipt, task)
                .await;
        // Join completion guarantees the request future and its resident attempt
        // store have been dropped; no finalizer may run before that drain.
        self.record("drain", None);
        self.record(
            "RuntimeAttemptCleanup",
            Some(serde_json::json!({"task_joined":cleanup.task_joined})),
        );
        self.request_id
            .lock()
            .expect("front typed request lock")
            .take();
        self.closeout_state
            .request_finalized
            .store(true, Ordering::Release);
        self.record("RuntimeRequestFinalizer", None);
        execution
    }
}

pub(crate) fn v3_front_io_cause(
    operation: V3ClientTransportOperation,
    error: &std::io::Error,
) -> V3FrontClientTransportCause {
    let io_kind = Some(format!("{:?}", error.kind()));
    let os_cause = Some(match error.raw_os_error() {
        Some(code) => format!("os_error={code}: {error}"),
        None => error.to_string(),
    });
    V3FrontClientTransportCause {
        operation,
        io_kind,
        os_cause,
    }
}

#[cfg(test)]
mod resource_tests {
    use super::*;

    struct RequestResource(Arc<AtomicBool>);
    impl Drop for RequestResource {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }

    #[tokio::test]
    async fn closeout_without_debug_waits_for_socket_and_runtime_resource_release() {
        let state = V3FrontTransportCloseoutState::new();
        let (tx, rx) = oneshot::channel();
        let closeout = V3FrontClientSourceCloseout::new(
            None,
            V3FrontConnectionIdentity(41),
            Arc::clone(&state),
            Arc::new(Mutex::new(Some(tx))),
        );
        closeout.bind_request("owned-request".into());
        let released = Arc::new(AtomicBool::new(false));
        let resource = RequestResource(Arc::clone(&released));
        let (started_tx, started_rx) = oneshot::channel();
        closeout.bind_runtime_task(tokio::spawn(async move {
            let _resource = resource;
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
        }));
        started_rx.await.unwrap();
        let driver = closeout.clone();
        let completion = tokio::spawn(async move {
            driver
                .close_request(V3FrontClientTransportCause {
                    operation: V3ClientTransportOperation::Cancellation,
                    io_kind: None,
                    os_cause: Some("owned body cancelled".into()),
                })
                .await
        });
        rx.await.unwrap();
        assert!(
            !state.request_finalized.load(Ordering::Acquire),
            "socket receipt is still absent"
        );
        state.mark_socket_closed();
        tokio::task::yield_now().await;
        assert!(
            !state.request_finalized.load(Ordering::Acquire),
            "HTTP read half is still live"
        );
        state.mark_http_closed();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !state.request_finalized.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(
            released.load(Ordering::Acquire),
            "runtime future resource survived finalizer"
        );
        assert!(closeout.runtime_task.lock().unwrap().is_none());
        assert!(closeout.request_id.lock().unwrap().is_none());
        let execution = completion.await.unwrap().unwrap().unwrap();
        assert_eq!(execution.transport_outcome.request_id, "owned-request");
        assert_eq!(execution.completed_node_ids.len(), 6);
        assert!(execution.transport_outcome.health_neutral);
    }
}
