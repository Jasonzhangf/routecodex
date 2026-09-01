use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{oneshot, Notify};

#[derive(Debug)]
pub(crate) struct V3FrontTransportCloseoutState {
    request_cycle: Mutex<V3FrontTransportRequestCycle>,
    closed: AtomicBool,
    peer_disconnected: AtomicBool,
    peer_disconnect_notify: Notify,
}

#[derive(Debug, Default)]
struct V3FrontTransportRequestCycle {
    frame: Option<Vec<u8>>,
    request_started: bool,
    response_started: bool,
}

impl V3FrontTransportCloseoutState {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            request_cycle: Mutex::new(V3FrontTransportRequestCycle::default()),
            closed: AtomicBool::new(false),
            peer_disconnected: AtomicBool::new(false),
            peer_disconnect_notify: Notify::new(),
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
        if request_cycle.request_started && !request_cycle.response_started {
            request_cycle.frame = Some(build_v3_restart_closeout_http_error());
        }
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
