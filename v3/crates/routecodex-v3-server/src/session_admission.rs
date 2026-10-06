use axum::body::Body;
use axum::http::Response;
use futures_util::{stream, StreamExt};
use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
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
pub(crate) struct V3ServerRequestActivityGate {
    active: AtomicUsize,
    notify: Notify,
}

#[derive(Debug)]
pub(crate) struct V3ServerRequestActivityPermit {
    gate: Arc<V3ServerRequestActivityGate>,
}

impl V3ServerRequestActivityGate {
    pub(crate) fn admit(self: &Arc<Self>) -> V3ServerRequestActivityPermit {
        self.active.fetch_add(1, Ordering::AcqRel);
        V3ServerRequestActivityPermit {
            gate: Arc::clone(self),
        }
    }

    pub(crate) async fn wait_for_quiescence(&self) {
        loop {
            // Register interest before the state check, so a permit that drops
            // between the check and the await cannot be missed.
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.active.load(Ordering::Acquire) == 0 {
                return;
            }
            notified.await;
        }
    }
}

impl Drop for V3ServerRequestActivityPermit {
    fn drop(&mut self) {
        if self.gate.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.gate.notify.notify_waiters();
        }
    }
}

pub(crate) fn hold_response_body_request_activity_permit(
    response: Response<Body>,
    permit: V3ServerRequestActivityPermit,
) -> Response<Body> {
    let (parts, body) = response.into_parts();
    let stream = Box::pin(body.into_data_stream());
    let body = Body::from_stream(stream::unfold(
        (stream, permit),
        |(mut stream, permit)| async move { stream.next().await.map(|item| (item, (stream, permit))) },
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
                V3ResponsesSessionAdmissionOutcome::Admitted(permit) => {
                    return Ok(Some(permit))
                }
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
    async fn request_activity_gate_waits_for_response_body_terminal_or_timeout() {
        let gate = Arc::new(V3ServerRequestActivityGate::default());
        let permit = gate.admit();
        let wait_gate = Arc::clone(&gate);
        let mut waiter = tokio::spawn(async move {
            wait_gate.wait_for_quiescence().await;
        });

        tokio::task::yield_now().await;
        assert!(timeout(Duration::from_millis(25), &mut waiter)
            .await
            .is_err());

        drop(permit);
        timeout(Duration::from_secs(1), waiter)
            .await
            .expect("restart preparation must resume after the response body closes")
            .expect("activity waiter must not panic");
    }
}
