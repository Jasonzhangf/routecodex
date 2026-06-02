use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::hub_req_inbound_02_standardized::assert_no_inline_metadata;
use super::hub_resp_inbound_02_parsed::{assert_not_success_error_payload, HubRespInbound02Parsed};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HubRespChatProcess03Governed {
    payload: Value,
}

impl HubRespChatProcess03Governed {
    pub(crate) fn payload(&self) -> &Value {
        &self.payload
    }

    pub(crate) fn into_payload(self) -> Value {
        self.payload
    }
}

pub(crate) fn build_hub_resp_chatprocess_03_from_hub_resp_inbound_02(
    inbound: HubRespInbound02Parsed,
    governed_payload: Value,
) -> Result<HubRespChatProcess03Governed, String> {
    assert_no_inline_metadata(inbound.payload(), "HubRespChatProcess03Governed.source")?;
    assert_not_success_error_payload(inbound.payload(), "HubRespChatProcess03Governed.source")?;
    assert_no_inline_metadata(&governed_payload, "HubRespChatProcess03Governed")?;
    assert_not_success_error_payload(&governed_payload, "HubRespChatProcess03Governed")?;
    Ok(HubRespChatProcess03Governed {
        payload: governed_payload,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub_pipeline_types::parse_hub_resp_inbound_02_from_provider_resp_inbound_01;
    use serde_json::json;

    #[test]
    fn builds_response_chatprocess_from_inbound_only() {
        let payload = json!({"id":"resp_1","output":[{"type":"message"}]});
        let inbound =
            parse_hub_resp_inbound_02_from_provider_resp_inbound_01(payload.clone()).unwrap();
        let governed =
            build_hub_resp_chatprocess_03_from_hub_resp_inbound_02(inbound, payload.clone())
                .unwrap();
        assert_eq!(governed.payload(), &payload);
        assert_eq!(governed.into_payload(), payload);
    }
}
