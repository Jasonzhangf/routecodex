//! Request activity and reversible restart maintenance; no session serialization.
use axum::body::Body;
use axum::http::Response;
use futures_util::{stream, StreamExt};
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
        let guard = V3ServerMaintenanceGuard {
            gate: Arc::clone(self),
        };
        guard.wait_for_quiescence().await;
        guard
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

pub(crate) fn hold_response_body_request_activity_permit(
    response: Response<Body>,
    permit: V3ServerRequestActivityPermit,
    front: Option<crate::restart_handoff::V3StableFrontSocket>,
) -> Response<Body> {
    let (parts, body) = response.into_parts();
    let stream = Box::pin(body.into_data_stream());
    let body = Body::from_stream(stream::unfold(
        (stream, permit, front),
        |(mut stream, permit, front)| async move {
            match stream.next().await {
                Some(item) => Some((item, (stream, permit, front))),
                None => {
                    if let Some(front) = front {
                        front.hold_activity_until_flush(permit);
                    }
                    None
                }
            }
        },
    ));
    Response::from_parts(parts, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{timeout, Duration};

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
            .expect("restart preparation must resume after the response body closes")
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
