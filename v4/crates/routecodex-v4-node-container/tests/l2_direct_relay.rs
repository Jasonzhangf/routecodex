use std::sync::Arc;

use routecodex_v4_node_container::direct_relay::{
    DirectRelayContainer, DirectRelayError, DirectRelayInformation, DirectRequestHook,
    DirectResponseHook, ProtocolId, SharedPayload,
};
use serde_json::json;

struct RequestModelHook;

impl DirectRequestHook for RequestModelHook {
    fn apply(&self, payload: SharedPayload) -> Result<SharedPayload, DirectRelayError> {
        let mut next = (*payload).clone();
        next["model"] = json!("provider-model");
        Ok(Arc::new(next))
    }
}

struct ResponseModelHook;

impl DirectResponseHook for ResponseModelHook {
    fn apply(&self, payload: SharedPayload) -> Result<SharedPayload, DirectRelayError> {
        let mut next = (*payload).clone();
        next["model"] = json!("client-model");
        Ok(Arc::new(next))
    }
}

#[test]
fn direct_container_runs_direction_specific_hooks_with_shared_payload() {
    let info = DirectRelayInformation::direct(
        ProtocolId::new("openai-responses").unwrap(),
        ProtocolId::new("openai-responses").unwrap(),
    )
    .unwrap();
    let container = DirectRelayContainer::new(
        vec![Arc::new(RequestModelHook)],
        vec![Arc::new(ResponseModelHook)],
    );
    let original = Arc::new(json!({"model":"client-model","input":"hello"}));

    let provider = container.execute_request(&info, Arc::clone(&original)).unwrap();
    let client = container.execute_response(&info, provider).unwrap();

    assert_eq!(original["model"], "client-model");
    assert_eq!(client["model"], "client-model");
    assert_eq!(client["input"], "hello");
}

#[test]
fn direct_container_fails_fast_on_protocol_mismatch() {
    assert_eq!(
        DirectRelayInformation::direct(
            ProtocolId::new("openai-responses").unwrap(),
            ProtocolId::new("openai-chat").unwrap(),
        ),
        Err(DirectRelayError::ProtocolMismatch)
    );
}
