use super::V3HubRespContinuation04Committed;
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespOutbound05ClientSemantic {
    pub(crate) previous: V3HubRespContinuation04Committed,
    pub(crate) client_payload: Arc<Value>,
}

impl V3HubRespOutbound05ClientSemantic {
    /// 05 节点的 client semantic payload（按入口协议投影后的客户端语义）。
    pub(crate) fn client_payload(&self) -> &Value {
        self.client_payload.as_ref()
    }
}

/// 标准 05 构建器：client_payload 由 resp04 finalized 投影（对 Responses 协议为 identity）。
pub fn build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(
    input: V3HubRespContinuation04Committed,
) -> V3HubRespOutbound05ClientSemantic {
    let client_payload = Arc::new(input.finalized_payload().clone());
    V3HubRespOutbound05ClientSemantic {
        previous: input,
        client_payload,
    }
}

/// 受控 client_payload 注入构建器（仅 crate 内、仅相邻 client projection 使用）。
///
/// 唯一合法输入：resp04 finalized 经相邻 05 入口协议投影（如 Anthropic message/events
/// 投影）后的结果；禁止从 provider raw 或未治理 payload 构造。调用方必须保证
/// `client_payload` 是由 `input.finalized_payload()` 派生的相邻投影产物，
/// 不得绕过 03 治理 / 04 commit。
pub(crate) fn build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04_with_client_payload(
    input: V3HubRespContinuation04Committed,
    client_payload: Value,
) -> V3HubRespOutbound05ClientSemantic {
    V3HubRespOutbound05ClientSemantic {
        previous: input,
        client_payload: Arc::new(client_payload),
    }
}
