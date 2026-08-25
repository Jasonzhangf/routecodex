use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug)]
pub(crate) struct V3FrontTransportCloseoutState {
    frame: Mutex<Option<Vec<u8>>>,
    closed: AtomicBool,
    request_started: AtomicBool,
    response_started: AtomicBool,
}

impl V3FrontTransportCloseoutState {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            frame: Mutex::new(None),
            closed: AtomicBool::new(false),
            request_started: AtomicBool::new(false),
            response_started: AtomicBool::new(false),
        })
    }

    pub(crate) fn take_frame(&self) -> Option<Vec<u8>> {
        self.frame.lock().expect("front closeout frame lock").take()
    }

    pub(crate) fn mark_request_started(&self) {
        self.request_started.store(true, Ordering::Release);
    }

    pub(crate) fn mark_response_started(&self) {
        self.response_started.store(true, Ordering::Release);
    }

    pub(crate) fn set_frame(&self, frame: Vec<u8>) {
        *self.frame.lock().expect("front closeout frame lock") = Some(frame);
    }

    pub(crate) fn close_for_exec_replacement(&self) {
        self.closed.store(true, Ordering::Release);
        if self.request_started.load(Ordering::Acquire)
            && !self.response_started.load(Ordering::Acquire)
        {
            self.set_frame(build_v3_restart_closeout_http_error());
        }
    }

    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::Release);
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
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
