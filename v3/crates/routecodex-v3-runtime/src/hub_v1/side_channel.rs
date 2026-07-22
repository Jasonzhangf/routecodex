use routecodex_v3_provider_responses::find_v3_routecodex_control_payload_key;
use serde_json::Value;

pub(crate) fn find_v3_hub_side_channel_key(value: &Value) -> Option<&'static str> {
    find_v3_routecodex_control_payload_key(value)
}
