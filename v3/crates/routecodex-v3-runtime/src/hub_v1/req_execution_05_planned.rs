use super::{V3HubExecutionMode, V3HubReqChatProcess04Governed};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqExecution05Planned {
    pub(crate) previous: V3HubReqChatProcess04Governed,
    pub(crate) execution: V3HubExecutionMode,
}

impl V3HubReqExecution05Planned {
    /// 治理后的 Chat canonical payload（转发自 Req04）。
    pub(crate) fn governed_payload(&self) -> &Value {
        self.previous.governed_payload()
    }
}

pub fn build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
    input: V3HubReqChatProcess04Governed,
    execution: V3HubExecutionMode,
) -> V3HubReqExecution05Planned {
    V3HubReqExecution05Planned {
        previous: input,
        execution,
    }
}
