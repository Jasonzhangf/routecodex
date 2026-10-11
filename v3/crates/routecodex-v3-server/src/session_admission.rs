use axum::body::Body;
use axum::http::Response;
use futures_util::{stream, StreamExt};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct V3ResponsesSessionAdmissionScope {
    pub(crate) endpoint: String,
    pub(crate) session_id: Option<String>,
    pub(crate) conversation_id: Option<String>,
}

#[derive(Debug, Default)]
struct V3ResponsesSessionAdmissionState {
    next_token: u64,
    active: BTreeMap<u64, V3ResponsesSessionAdmissionScope>,
}

#[derive(Debug, Default)]
pub(crate) struct V3ResponsesSessionAdmissionGate {
    state: Arc<Mutex<V3ResponsesSessionAdmissionState>>,
    notify: Arc<Notify>,
}

/// Failure of the admission gate itself, confined to the affected request.
///
/// Admission is a control gate, so it cannot silently pass a request through.
/// It can only fail when it cannot hand out a unique token any more; that
/// failure belongs to the request that asked, not to the listener.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum V3ResponsesSessionAdmissionError {
    TokenSpaceExhausted,
}

impl std::fmt::Display for V3ResponsesSessionAdmissionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TokenSpaceExhausted => formatter.write_str(
                "V3 Responses session admission token space is exhausted for this listener",
            ),
        }
    }
}

impl std::error::Error for V3ResponsesSessionAdmissionError {}

enum V3ResponsesSessionAdmissionOutcome {
    /// The request carries no session identity, so the gate does not apply.
    Ungated,
    /// This request owns the gate for its scope.
    Admitted(V3ResponsesSessionAdmissionPermit),
    /// Another request owns the gate for the same scope.
    Busy,
}

#[derive(Debug)]
pub(crate) struct V3ResponsesSessionAdmissionPermit {
    state: Arc<Mutex<V3ResponsesSessionAdmissionState>>,
    notify: Arc<Notify>,
    token: Option<u64>,
}

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

pub(crate) fn hold_response_body_admission_permit(
    response: Response<Body>,
    permit: V3ResponsesSessionAdmissionPermit,
) -> Response<Body> {
    let (parts, body) = response.into_parts();
    let stream = Box::pin(body.into_data_stream());
    let body = Body::from_stream(stream::unfold(
        (stream, permit),
        |(mut stream, permit)| async move { stream.next().await.map(|item| (item, (stream, permit))) },
    ));
    Response::from_parts(parts, body)
}

impl V3ResponsesSessionAdmissionGate {
    pub(crate) async fn admit(
        &self,
        scope: V3ResponsesSessionAdmissionScope,
    ) -> Result<Option<V3ResponsesSessionAdmissionPermit>, V3ResponsesSessionAdmissionError> {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            match self.try_admit(scope.clone())? {
                V3ResponsesSessionAdmissionOutcome::Ungated => return Ok(None),
                V3ResponsesSessionAdmissionOutcome::Admitted(permit) => return Ok(Some(permit)),
                V3ResponsesSessionAdmissionOutcome::Busy => notified.await,
            }
        }
    }

    fn try_admit(
        &self,
        scope: V3ResponsesSessionAdmissionScope,
    ) -> Result<V3ResponsesSessionAdmissionOutcome, V3ResponsesSessionAdmissionError> {
        if scope.session_id.is_none() && scope.conversation_id.is_none() {
            return Ok(V3ResponsesSessionAdmissionOutcome::Ungated);
        }
        // The guarded state is a pure token map, so a poisoned lock still holds
        // valid state. Recovering it keeps an unrelated panic from turning into
        // a permanent admission failure for every later session on this
        // listener; the reason is reported once instead of on every request.
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => {
                let state = poisoned.into_inner();
                self.state.clear_poison();
                eprintln!(
                    "V3 Responses session admission state lock was poisoned; recovered the admission token map"
                );
                state
            }
        };
        if state.active.values().any(|active| {
            active.endpoint == scope.endpoint
                && (same_present_identity(&active.session_id, &scope.session_id)
                    || same_present_identity(&active.conversation_id, &scope.conversation_id))
        }) {
            return Ok(V3ResponsesSessionAdmissionOutcome::Busy);
        }
        let Some(token) = state.next_token.checked_add(1) else {
            // A panic here would poison the lock for every later request; the
            // failure belongs to this request only.
            return Err(V3ResponsesSessionAdmissionError::TokenSpaceExhausted);
        };
        state.next_token = token;
        state.active.insert(token, scope);
        Ok(V3ResponsesSessionAdmissionOutcome::Admitted(
            V3ResponsesSessionAdmissionPermit {
                state: Arc::clone(&self.state),
                notify: Arc::clone(&self.notify),
                token: Some(token),
            },
        ))
    }
}

impl Drop for V3ResponsesSessionAdmissionPermit {
    fn drop(&mut self) {
        let Some(token) = self.token.take() else {
            return;
        };
        // Drop runs while a panic may be unwinding, so it must never panic: a
        // poisoned lock is recovered instead of expected.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .active
            .remove(&token);
        self.notify.notify_waiters();
    }
}

fn same_present_identity(left: &Option<String>, right: &Option<String>) -> bool {
    matches!((left, right), (Some(left), Some(right)) if left == right)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{timeout, Duration};

    fn scope(
        endpoint: &str,
        session_id: Option<&str>,
        conversation_id: Option<&str>,
    ) -> V3ResponsesSessionAdmissionScope {
        V3ResponsesSessionAdmissionScope {
            endpoint: endpoint.to_string(),
            session_id: session_id.map(str::to_string),
            conversation_id: conversation_id.map(str::to_string),
        }
    }

    #[tokio::test]
    async fn same_session_or_conversation_waits_until_exact_permit_drop() {
        let gate = Arc::new(V3ResponsesSessionAdmissionGate::default());
        let first = gate
            .admit(scope(
                "/v1/responses",
                Some("session-a"),
                Some("conversation-a"),
            ))
            .await
            .expect("admission must stay available")
            .expect("first session must receive a permit");

        let session_wait_gate = Arc::clone(&gate);
        let mut session_waiter = tokio::spawn(async move {
            session_wait_gate
                .admit(scope(
                    "/v1/responses",
                    Some("session-a"),
                    Some("conversation-b"),
                ))
                .await
        });
        tokio::task::yield_now().await;
        assert!(timeout(Duration::from_millis(25), &mut session_waiter)
            .await
            .is_err());

        drop(first);
        let session_permit = timeout(Duration::from_secs(1), session_waiter)
            .await
            .expect("same-session waiter must resume after exact permit release")
            .expect("same-session waiter task must not panic")
            .expect("admission must stay available")
            .expect("same-session waiter must receive a permit");
        drop(session_permit);

        let first = gate
            .admit(scope(
                "/v1/responses",
                Some("session-a"),
                Some("conversation-a"),
            ))
            .await
            .expect("admission must stay available")
            .expect("session must be re-admitted after exact permit release");
        let conversation_wait_gate = Arc::clone(&gate);
        let mut conversation_waiter = tokio::spawn(async move {
            conversation_wait_gate
                .admit(scope(
                    "/v1/responses",
                    Some("session-b"),
                    Some("conversation-a"),
                ))
                .await
        });
        tokio::task::yield_now().await;
        assert!(timeout(Duration::from_millis(25), &mut conversation_waiter)
            .await
            .is_err());

        drop(first);
        timeout(Duration::from_secs(1), conversation_waiter)
            .await
            .expect("same-conversation waiter must resume after exact permit release")
            .expect("same-conversation waiter task must not panic")
            .expect("same-conversation waiter must receive a permit");
    }

    #[tokio::test]
    async fn missing_scope_and_different_scopes_or_gate_instances_do_not_cross_lock() {
        let first_gate = Arc::new(V3ResponsesSessionAdmissionGate::default());
        let second_gate = V3ResponsesSessionAdmissionGate::default();

        assert!(first_gate
            .admit(scope("/v1/responses", None, None))
            .await
            .expect("admission must stay available")
            .is_none());
        let _first = first_gate
            .admit(scope("/v1/responses", Some("session-a"), None))
            .await
            .expect("admission must stay available")
            .expect("first session must receive a permit");
        let different_scope = timeout(
            Duration::from_millis(100),
            first_gate.admit(scope("/v1/responses", Some("session-b"), None)),
        )
        .await
        .expect("different scope on one listener must remain concurrent")
        .expect("admission must stay available");
        assert!(different_scope.is_some());
        assert!(second_gate
            .admit(scope("/v1/responses", Some("session-a"), None))
            .await
            .expect("admission must stay available")
            .is_some());
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
