use super::{V3HubRespOutbound05ClientSemantic, V3HubTransportIntent};

#[derive(Debug, Clone, PartialEq)]
pub struct V3ServerRespOutbound06ClientFrame {
    pub(crate) previous: V3HubRespOutbound05ClientSemantic,
}

pub fn build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(
    input: V3HubRespOutbound05ClientSemantic,
) -> V3ServerRespOutbound06ClientFrame {
    V3ServerRespOutbound06ClientFrame { previous: input }
}

impl V3ServerRespOutbound06ClientFrame {
    pub fn response_exit_node(&self) -> &'static str {
        "V3ServerRespOutbound06ClientFrame"
    }

    pub fn transport_intent(&self) -> V3HubTransportIntent {
        self.previous
            .previous
            .previous
            .previous
            .provider_raw()
            .transport_intent
    }
}
