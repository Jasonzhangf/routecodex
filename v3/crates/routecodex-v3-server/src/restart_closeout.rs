use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{oneshot, Notify};

#[derive(Debug)]
pub(crate) struct V3FrontTransportCloseoutState {
    request_cycle: Mutex<V3FrontTransportRequestCycle>,
    closed: AtomicBool,
    peer_disconnected: AtomicBool,
    peer_disconnect_notify: Notify,
    transport_wrote: AtomicBool,
    transport_write_notify: Notify,
}

#[derive(Debug, Default)]
struct V3FrontTransportRequestCycle {
    frame: Option<Vec<u8>>,
    request_started: bool,
    response_started: bool,
    terminal_frame_suppressed: bool,
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
        })
    }

    pub(crate) fn take_frame(&self) -> Option<Vec<u8>> {
        self.request_cycle
            .lock()
            .expect("front closeout request cycle lock")
            .frame
            .take()
    }

    pub(crate) fn mark_request_started(&self) {
        let mut request_cycle = self
            .request_cycle
            .lock()
            .expect("front closeout request cycle lock");
        request_cycle.frame = None;
        request_cycle.request_started = true;
        request_cycle.response_started = false;
        self.transport_wrote.store(false, Ordering::Release);
    }

    pub(crate) fn mark_response_started(&self) {
        self.request_cycle
            .lock()
            .expect("front closeout request cycle lock")
            .response_started = true;
    }

    pub(crate) fn set_frame(&self, frame: Vec<u8>) {
        self.request_cycle
            .lock()
            .expect("front closeout request cycle lock")
            .frame = Some(frame);
    }

    pub(crate) fn close_for_exec_replacement(&self) {
        self.closed.store(true, Ordering::Release);
        let mut request_cycle = self
            .request_cycle
            .lock()
            .expect("front closeout request cycle lock");
        if request_cycle.request_started
            && !request_cycle.response_started
            && !request_cycle.terminal_frame_suppressed
        {
            request_cycle.frame = Some(build_v3_restart_closeout_http_error());
        }
    }

    pub(crate) fn abort_without_response(&self) {
        let mut request_cycle = self
            .request_cycle
            .lock()
            .expect("front closeout request cycle lock");
        request_cycle.terminal_frame_suppressed = true;
        request_cycle.frame = None;
        self.closed.store(true, Ordering::Release);
    }

    /// Suppress a pending restart closeout frame for a terminal that owns its own
    /// client-visible boundary.
    ///
    /// The streaming no-response terminal writes the SSE transport break itself, so a
    /// concurrent restart replacement must not also queue the `503` closeout frame.
    /// Unlike `abort_without_response` this leaves the connection open, because Hyper
    /// still has to write the response head before the body fails.
    pub(crate) fn suppress_restart_closeout_frame(&self) {
        let mut request_cycle = self
            .request_cycle
            .lock()
            .expect("front closeout request cycle lock");
        request_cycle.terminal_frame_suppressed = true;
        request_cycle.frame = None;
    }

    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::Release);
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

fn build_v3_restart_closeout_http_error() -> Vec<u8> {
    let body = br#"{"error":{"type":"server_error","code":"server_restart_in_progress","message":"RouteCodex restarted before this request completed","status":503}}"#;
    format!(
        "HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes()
    .into_iter()
    .chain(body.iter().copied())
    .collect()
}
