use super::V3HubReqInbound02Normalized;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqChatProcess04Governed {
    pub(crate) previous: V3HubReqInbound02Normalized,
}

impl V3HubReqChatProcess04Governed {
    /// 治理后的 Chat canonical payload（Req04 治理原地修改 Req02 payload）。
    pub(crate) fn governed_payload(&self) -> &Value {
        self.previous.payload()
    }
}

pub fn build_v3_hub_req_chat_process_04_from_v3_hub_req_inbound_02(
    input: V3HubReqInbound02Normalized,
) -> V3HubReqChatProcess04Governed {
    V3HubReqChatProcess04Governed { previous: input }
}
