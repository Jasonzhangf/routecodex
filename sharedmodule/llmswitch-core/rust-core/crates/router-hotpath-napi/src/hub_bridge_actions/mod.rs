mod types;
pub use types::*;
mod bindings;
mod bridge_input;
mod history;
mod local_image;
mod metadata;
mod pipeline;
mod reasoning;
mod tool_ids;
pub(crate) mod utils;
pub(crate) use bridge_input::convert_bridge_input_to_chat_messages;
pub(crate) use history::build_bridge_history;
pub(crate) use reasoning::normalize_reasoning_in_chat_payload;

pub use bindings::{
    append_local_image_block_on_latest_user_input_json, apply_bridge_capture_tool_results_json,
    apply_bridge_ensure_system_instruction_json, apply_bridge_ensure_tool_placeholders_json,
    apply_bridge_inject_system_instruction_json, apply_bridge_metadata_action_json,
    apply_bridge_normalize_history_json, apply_bridge_normalize_tool_identifiers_json,
    apply_bridge_reasoning_extract_json, apply_bridge_responses_output_reasoning_json,
    build_bridge_history_json, coerce_bridge_role_json, convert_bridge_input_to_chat_messages_json,
    ensure_bridge_output_fields_json, ensure_messages_array_json, extract_reasoning_segments_json,
    filter_bridge_input_for_upstream_json, map_reasoning_content_to_responses_output_json,
    normalize_bridge_history_seed_json, normalize_bridge_tool_call_ids_json,
    normalize_req_inbound_reasoning_payload_json, normalize_resp_inbound_reasoning_payload_json,
    normalize_reasoning_in_anthropic_payload_json, normalize_reasoning_in_chat_payload_json,
    normalize_reasoning_in_gemini_payload_json, normalize_reasoning_in_openai_payload_json,
    normalize_reasoning_in_responses_payload_json, prepare_responses_request_envelope_json,
    repair_tool_calls_json, resolve_responses_bridge_tools_json,
    resolve_responses_request_bridge_decisions_json, run_bridge_action_pipeline_json,
    serialize_tool_arguments_json, serialize_tool_output_json, validate_tool_arguments_json,
};

const RESPONSES_INSTRUCTIONS_REASONING_FIELD: &str = "__rcc_reasoning_instructions";

#[cfg(test)]
mod tests;
