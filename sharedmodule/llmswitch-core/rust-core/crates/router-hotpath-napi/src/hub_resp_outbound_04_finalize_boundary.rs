use serde_json::Value;

use crate::resp_process_stage2_finalize::{finalize_chat_response, FinalizeInput};

pub(crate) fn finalize_hub_resp_outbound_04_client_semantic(input: FinalizeInput) -> Value {
    finalize_chat_response(input)
}
