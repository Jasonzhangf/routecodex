use super::V3HubRespContinuation04Committed;
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespOutbound05ClientSemantic {
    pub(crate) previous: V3HubRespContinuation04Committed,
    pub(crate) client_payload: Arc<Value>,
}

pub fn build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(
    input: V3HubRespContinuation04Committed,
) -> V3HubRespOutbound05ClientSemantic {
    let client_payload = Arc::new(input.finalized_payload().clone());
    V3HubRespOutbound05ClientSemantic {
        previous: input,
        client_payload,
    }
}

pub fn build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04_with_client_payload(
    input: V3HubRespContinuation04Committed,
    client_payload: Value,
) -> V3HubRespOutbound05ClientSemantic {
    V3HubRespOutbound05ClientSemantic {
        previous: input,
        client_payload: Arc::new(client_payload),
    }
}
