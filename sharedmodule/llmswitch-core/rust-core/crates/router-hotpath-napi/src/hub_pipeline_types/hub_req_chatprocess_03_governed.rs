use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::hub_req_inbound_02_standardized::{
    assert_no_inline_metadata, HubReqInbound02Standardized,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HubReqChatProcess03Governed {
    payload: Value,
}

impl HubReqChatProcess03Governed {
    pub(crate) fn payload(&self) -> &Value {
        &self.payload
    }

    pub(crate) fn into_payload(self) -> Value {
        self.payload
    }
}

pub(crate) fn build_hub_req_chatprocess_03_from_hub_req_inbound_02(
    inbound: HubReqInbound02Standardized,
) -> Result<HubReqChatProcess03Governed, String> {
    let payload = inbound.into_payload();
    assert_no_inline_metadata(&payload, "HubReqChatProcess03Governed")?;
    Ok(HubReqChatProcess03Governed { payload })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub_pipeline_types::build_hub_req_inbound_02_from_payload;
    use serde_json::json;

    #[test]
    fn builds_chatprocess_request_from_inbound_only() {
        let payload = json!({"model":"m","messages":[{"role":"user","content":"hi"}]});
        let inbound = build_hub_req_inbound_02_from_payload(payload.clone()).unwrap();
        let governed = build_hub_req_chatprocess_03_from_hub_req_inbound_02(inbound).unwrap();
        assert_eq!(governed.payload(), &payload);
        assert_eq!(governed.into_payload(), payload);
    }
}
