use axum::body::Body;
use axum::http::Response;
use futures_util::{stream, StreamExt};
use std::collections::BTreeMap;
use std::sync::{atomic::{AtomicUsize, Ordering}, Arc, Mutex};
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
        V3ServerRequestActivityPermit { gate: Arc::clone(self) }
    }

    pub(crate) async fn wait_for_quiescence(&self) {
        loop {
            if self.active.load(Ordering::Acquire) == 0 {
                return;
            }
            self.notify.notified().await;
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
        |(mut stream, permit)| async move {
            stream.next().await.map(|item| (item, (stream, permit)))
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
    ) -> Option<V3ResponsesSessionAdmissionPermit> {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            match self.try_admit(scope.clone()) {
                Ok(permit) => return permit,
                Err(()) => notified.await,
            }
        }
    }

    fn try_admit(
        &self,
        scope: V3ResponsesSessionAdmissionScope,
    ) -> Result<Option<V3ResponsesSessionAdmissionPermit>, ()> {
        if scope.session_id.is_none() && scope.conversation_id.is_none() {
            return Ok(None);
        }
        let mut state = self
            .state
            .lock()
            .expect("V3 Responses session admission state lock is poisoned");
        if state.active.values().any(|active| {
            active.endpoint == scope.endpoint
                && (same_present_identity(&active.session_id, &scope.session_id)
                    || same_present_identity(&active.conversation_id, &scope.conversation_id))
        }) {
            return Err(());
        }
        state.next_token = state
            .next_token
            .checked_add(1)
            .expect("V3 Responses session admission token overflowed");
        let token = state.next_token;
        state.active.insert(token, scope);
        Ok(Some(V3ResponsesSessionAdmissionPermit {
            state: Arc::clone(&self.state),
            notify: Arc::clone(&self.notify),
            token: Some(token),
        }))
    }
}

impl Drop for V3ResponsesSessionAdmissionPermit {
    fn drop(&mut self) {
        let Some(token) = self.token.take() else {
            return;
        };
        self.state
            .lock()
            .expect("V3 Responses session admission state lock is poisoned")
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
            .unwrap();

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
            .expect("same-session waiter must receive a permit");
        drop(session_permit);

        let first = gate
            .admit(scope(
                "/v1/responses",
                Some("session-a"),
                Some("conversation-a"),
            ))
            .await
            .unwrap();
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
            .is_none());
        let _first = first_gate
            .admit(scope("/v1/responses", Some("session-a"), None))
            .await
            .unwrap();
        let different_scope = timeout(
            Duration::from_millis(100),
            first_gate.admit(scope("/v1/responses", Some("session-b"), None)),
        )
        .await
        .expect("different scope on one listener must remain concurrent");
        assert!(different_scope.is_some());
        assert!(second_gate
            .admit(scope("/v1/responses", Some("session-a"), None))
            .await
            .is_some());
    }
}
