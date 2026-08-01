use axum::body::Body;
use axum::http::Response;
use futures_util::{stream, StreamExt};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

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
}

#[derive(Debug)]
pub(crate) struct V3ResponsesSessionAdmissionPermit {
    state: Arc<Mutex<V3ResponsesSessionAdmissionState>>,
    token: Option<u64>,
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
    pub(crate) fn try_admit(
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
    }
}

fn same_present_identity(left: &Option<String>, right: &Option<String>) -> bool {
    matches!((left, right), (Some(left), Some(right)) if left == right)
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn same_session_or_conversation_conflicts_until_exact_permit_drop() {
        let gate = V3ResponsesSessionAdmissionGate::default();
        let first = gate
            .try_admit(scope(
                "/v1/responses",
                Some("session-a"),
                Some("conversation-a"),
            ))
            .unwrap()
            .unwrap();

        assert!(gate
            .try_admit(scope(
                "/v1/responses",
                Some("session-a"),
                Some("conversation-b"),
            ))
            .is_err());
        assert!(gate
            .try_admit(scope(
                "/v1/responses",
                Some("session-b"),
                Some("conversation-a"),
            ))
            .is_err());
        assert!(gate
            .try_admit(scope(
                "/v1/responses",
                Some("session-b"),
                Some("conversation-b"),
            ))
            .is_ok());

        drop(first);
        assert!(gate
            .try_admit(scope(
                "/v1/responses",
                Some("session-a"),
                Some("conversation-a"),
            ))
            .is_ok());
    }

    #[test]
    fn missing_scope_and_different_gate_instances_do_not_cross_lock() {
        let first_gate = V3ResponsesSessionAdmissionGate::default();
        let second_gate = V3ResponsesSessionAdmissionGate::default();

        assert!(first_gate
            .try_admit(scope("/v1/responses", None, None))
            .unwrap()
            .is_none());
        let _first = first_gate
            .try_admit(scope("/v1/responses", Some("session-a"), None))
            .unwrap()
            .unwrap();
        assert!(second_gate
            .try_admit(scope("/v1/responses", Some("session-a"), None))
            .is_ok());
    }
}
