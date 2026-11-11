use axum::body::Body;
use axum::http::Response;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

#[derive(Debug, Default)]
struct V3ServerRequestActivityState {
    active: usize,
    maintenance: bool,
}

#[derive(Debug, Default)]
pub(crate) struct V3ServerRequestActivityGate {
    state: Mutex<V3ServerRequestActivityState>,
    notify: Notify,
}

#[derive(Debug)]
pub(crate) struct V3ServerRequestActivityPermit {
    gate: Arc<V3ServerRequestActivityGate>,
}

/// Reversible maintenance owner for the aggregate listener set.
///
/// Dropping the guard always restores ordinary dispatch, so a cancelled or
/// failed exec preparation retains the original serving runtime.
#[derive(Debug)]
pub(crate) struct V3ServerMaintenanceGuard {
    gate: Arc<V3ServerRequestActivityGate>,
}

impl V3ServerRequestActivityGate {
    /// Enter business execution, or wait while maintenance owns the gate.
    ///
    /// The maintenance flag and the active count share one lock, so a request
    /// cannot observe a quiescent gate and then enter after drain began.
    pub(crate) async fn admit(self: &Arc<Self>) -> V3ServerRequestActivityPermit {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let admitted = {
                let mut state = self
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if state.maintenance {
                    false
                } else {
                    state.active += 1;
                    true
                }
            };
            if admitted {
                return V3ServerRequestActivityPermit {
                    gate: Arc::clone(self),
                };
            }
            notified.await;
        }
    }

    /// Atomically stop new dispatch and wait for accepted requests to finish.
    ///
    /// The returned guard keeps maintenance active for the caller; dropping it
    /// wakes every waiting dispatch.
    pub(crate) async fn begin_maintenance(self: &Arc<Self>) -> V3ServerMaintenanceGuard {
        let guard = self.pause_dispatch().await;
        guard.wait_for_quiescence().await;
        guard
    }

    /// Pause new dispatch without waiting for accepted business requests.
    /// Existing responses keep their original connection and delivery rights.
    pub(crate) async fn pause_dispatch(self: &Arc<Self>) -> V3ServerMaintenanceGuard {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let acquired = {
                let mut state = self
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if state.maintenance {
                    false
                } else {
                    state.maintenance = true;
                    true
                }
            };
            if acquired {
                break;
            }
            notified.await;
        }
        V3ServerMaintenanceGuard {
            gate: Arc::clone(self),
        }
    }
}

impl V3ServerMaintenanceGuard {
    pub(crate) async fn wait_for_quiescence(&self) {
        loop {
            // Register interest before the state check, so a permit that drops
            // between the check and the await cannot be missed.
            let notified = self.gate.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self
                .gate
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .active
                == 0
            {
                return;
            }
            notified.await;
        }
    }
}

impl Drop for V3ServerRequestActivityPermit {
    fn drop(&mut self) {
        let mut state = self
            .gate
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.active = state.active.saturating_sub(1);
        drop(state);
        self.gate.notify.notify_waiters();
    }
}

impl Drop for V3ServerMaintenanceGuard {
    fn drop(&mut self) {
        let mut state = self
            .gate
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.maintenance = false;
        drop(state);
        self.gate.notify.notify_waiters();
    }
}

/// Hold the request activity permit until the client body reaches its transport
/// terminal.
///
/// The permit must outlive the response body: Hyper can still hold written frames
/// that the Front write worker has not flushed to the client socket, and a restart
/// or maintenance closeout may not treat the request as quiescent before those
/// bytes arrive. The hand-off therefore runs at the body's own terminal, which is
/// `Some(item)`-then-`None` on a normal drain *and* the body drop path: an aborted
/// or cancelled request task drops this stream without ever polling it to `None`,
/// so an `unfold` that only handed the permit over on `None` leaked the terminal
/// hand-off and released the permit early.
///
/// The body terminal itself stays deterministic in both directions. Hyper owns the
/// HTTP/1 framing tail: it writes the terminating chunk only after the body reports
/// `None`, so a normal drain ends the client transfer with a valid terminal. A body
/// dropped mid-stream can never fabricate that terminal (a fabricated `0\r\n\r\n`
/// would turn an incomplete transfer into a fake success); it ends as the truthful
/// transport break that the client observes as an incomplete chunked body.
pub(crate) fn hold_response_body_request_activity_permit(
    response: Response<Body>,
    permit: V3ServerRequestActivityPermit,
    front: Option<crate::restart_handoff::V3StableFrontSocket>,
) -> Response<Body> {
    let (parts, body) = response.into_parts();
    // The activity permit keeps body and front-flush custody: the data stream is
    // taken from the body first, wrapped as the held stream next, and the permit
    // is handed to the Front flush boundary by the wrapper's single terminal
    // hand-off (`hold_activity_until_flush(permit)`).
    let stream = Box::pin(body.into_data_stream());
    let body = Body::from_stream(V3HeldResponseBodyStream {
        stream,
        permit: Some(permit),
        front,
    });
    Response::from_parts(parts, body)
}

/// Client response body that owns one request activity permit.
struct V3HeldResponseBodyStream {
    stream: std::pin::Pin<Box<axum::body::BodyDataStream>>,
    permit: Option<V3ServerRequestActivityPermit>,
    front: Option<crate::restart_handoff::V3StableFrontSocket>,
}

impl V3HeldResponseBodyStream {
    /// Hand the activity permit to the Front flush boundary exactly once.
    fn hand_off_permit(&mut self) {
        if let (Some(permit), Some(front)) = (self.permit.take(), self.front.take()) {
            front.hold_activity_until_flush(permit);
        }
    }
}

impl futures_util::Stream for V3HeldResponseBodyStream {
    type Item = Result<axum::body::Bytes, axum::Error>;

    fn poll_next(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        let this = self.get_mut();
        let polled = this.stream.as_mut().poll_next(cx);
        if matches!(polled, std::task::Poll::Ready(None)) {
            this.hand_off_permit();
        }
        polled
    }
}

impl Drop for V3HeldResponseBodyStream {
    fn drop(&mut self) {
        // Cancelled/aborted request task: the stream is dropped before its `None`
        // terminal, and the permit still has to reach the flush boundary.
        self.hand_off_permit();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;
    use tokio::time::{timeout, Duration};

    #[tokio::test]
    async fn response_body_drop_releases_the_held_activity_permit() {
        let gate = Arc::new(V3ServerRequestActivityGate::default());
        let permit = gate.admit().await;
        assert_eq!(gate.state.lock().unwrap().active, 1);
        let body = Body::from_stream(futures_util::stream::pending::<
            Result<axum::body::Bytes, std::io::Error>,
        >());
        let mut data =
            hold_response_body_request_activity_permit(Response::new(body), permit, None)
                .into_body()
                .into_data_stream();
        assert!(
            timeout(Duration::from_millis(25), data.next())
                .await
                .is_err(),
            "a pending client body must keep the request activity permit"
        );
        // A cancelled/aborted request task drops the body before its `None`
        // terminal; the permit must still be released exactly there instead of
        // leaking into the listener's maintenance drain.
        drop(data);
        assert_eq!(
            gate.state.lock().unwrap().active,
            0,
            "dropping the client body mid-stream must release the held activity permit"
        );
    }

    #[tokio::test]
    async fn request_activity_gate_pause_does_not_drain_active_permit() {
        let gate = Arc::new(V3ServerRequestActivityGate::default());
        let _active = gate.admit().await;
        let pause = timeout(Duration::from_secs(1), gate.pause_dispatch())
            .await
            .expect("restart pause must not wait for an active request");
        let mut queued = Box::pin(gate.admit());
        assert!(timeout(Duration::from_millis(25), &mut queued)
            .await
            .is_err());
        drop(pause);
        timeout(Duration::from_secs(1), queued)
            .await
            .expect("cancelled pause must restore admission with the old request still active");
    }

    #[tokio::test]
    async fn request_activity_gate_maintenance_waits_for_active_permit() {
        let gate = Arc::new(V3ServerRequestActivityGate::default());
        let permit = gate.admit().await;
        let maintenance_gate = Arc::clone(&gate);
        let mut maintenance =
            tokio::spawn(async move { maintenance_gate.begin_maintenance().await });

        tokio::task::yield_now().await;
        assert!(timeout(Duration::from_millis(25), &mut maintenance)
            .await
            .is_err());

        drop(permit);
        timeout(Duration::from_secs(1), maintenance)
            .await
            .expect("graceful maintenance must resume after the response body closes")
            .expect("activity waiter must not panic");
    }

    #[tokio::test]
    async fn request_activity_gate_blocks_new_admission_until_maintenance_drops() {
        let gate = Arc::new(V3ServerRequestActivityGate::default());
        let maintenance = gate.begin_maintenance().await;
        let admission_gate = Arc::clone(&gate);
        let mut waiter = tokio::spawn(async move { admission_gate.admit().await });

        tokio::task::yield_now().await;
        assert!(timeout(Duration::from_millis(25), &mut waiter)
            .await
            .is_err());

        drop(maintenance);
        timeout(Duration::from_secs(1), waiter)
            .await
            .expect("cancelled maintenance must resume queued dispatch")
            .expect("admission waiter must not panic");
    }

    #[tokio::test]
    async fn request_activity_gate_cancelled_maintenance_restores_admission() {
        let gate = Arc::new(V3ServerRequestActivityGate::default());
        let permit = gate.admit().await;
        let maintenance_gate = Arc::clone(&gate);
        let maintenance = tokio::spawn(async move { maintenance_gate.begin_maintenance().await });

        tokio::task::yield_now().await;
        maintenance.abort();
        assert!(maintenance.await.unwrap_err().is_cancelled());
        drop(permit);

        let resumed = timeout(Duration::from_secs(1), gate.admit())
            .await
            .expect("cancelled maintenance must release the gate");
        drop(resumed);
    }

    #[tokio::test]
    async fn request_activity_gate_cancelled_drain_resumes_queued_admission_while_active() {
        let gate = Arc::new(V3ServerRequestActivityGate::default());
        let active = gate.admit().await;
        let mut drain = Box::pin(gate.begin_maintenance());
        assert!(timeout(Duration::from_millis(25), &mut drain)
            .await
            .is_err());
        let mut queued = Box::pin(gate.admit());
        assert!(timeout(Duration::from_millis(25), &mut queued)
            .await
            .is_err());
        drop(drain);
        let resumed = timeout(Duration::from_secs(1), queued).await.unwrap();
        assert_eq!(gate.state.lock().unwrap().active, 2);
        drop(active);
        drop(resumed);
        let maintenance = gate.begin_maintenance().await;
        assert_eq!(gate.state.lock().unwrap().active, 0);
        drop(maintenance);
    }

    #[tokio::test]
    async fn request_activity_gate_serializes_maintenance_owners() {
        let gate = Arc::new(V3ServerRequestActivityGate::default());
        let first = gate.begin_maintenance().await;
        let mut second = Box::pin(gate.begin_maintenance());
        assert!(timeout(Duration::from_millis(25), &mut second)
            .await
            .is_err());
        drop(first);
        let second = timeout(Duration::from_secs(1), second).await.unwrap();
        let mut queued = Box::pin(gate.admit());
        assert!(timeout(Duration::from_millis(25), &mut queued)
            .await
            .is_err());
        drop(second);
        drop(timeout(Duration::from_secs(1), queued).await.unwrap());
    }
}
