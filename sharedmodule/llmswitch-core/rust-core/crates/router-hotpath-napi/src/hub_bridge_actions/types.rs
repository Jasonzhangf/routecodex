use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizeBridgeToolCallIdsInput {
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default)]
    pub raw_request: Option<Value>,
    #[serde(default)]
    pub captured_tool_results: Option<Vec<Value>>,
    #[serde(default)]
    pub id_prefix: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizeBridgeToolCallIdsOutput {
    pub messages: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_request: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captured_tool_results: Option<Vec<Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBridgeNormalizeToolIdentifiersInput {
    #[serde(default)]
    pub stage: String,
    #[serde(default)]
    pub protocol: Option<String>,
    #[serde(default)]
    pub module_type: Option<String>,
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default)]
    pub raw_request: Option<Value>,
    #[serde(default)]
    pub captured_tool_results: Option<Vec<Value>>,
    #[serde(default)]
    pub id_prefix: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildBridgeHistoryInput {
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default)]
    pub tools: Option<Vec<Value>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildBridgeHistoryOutput {
    pub input: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub combined_system_instruction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_user_instruction: Option<String>,
    #[serde(default)]
    pub original_system_messages: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResponsesBridgeToolsInput {
    #[serde(default)]
    pub original_tools: Option<Vec<Value>>,
    #[serde(default)]
    pub chat_tools: Option<Vec<Value>>,
    #[serde(default)]
    pub has_server_side_web_search: Option<bool>,
    #[serde(default)]
    pub passthrough_keys: Option<Vec<String>>,
    #[serde(default)]
    pub request: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResponsesBridgeToolsOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_tools: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResponsesRequestBridgeDecisionsInput {
    #[serde(default)]
    pub context: Option<Value>,
    #[serde(default)]
    pub request_metadata: Option<Value>,
    #[serde(default)]
    pub envelope_metadata: Option<Value>,
    #[serde(default)]
    pub bridge_metadata: Option<Value>,
    #[serde(default)]
    pub extra_bridge_history: Option<Value>,
    #[serde(default)]
    pub request_semantics: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResponsesRequestBridgeDecisionsOutput {
    pub force_web_search: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_seed: Option<BuildBridgeHistoryOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_response_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterBridgeInputForUpstreamInput {
    #[serde(default)]
    pub input: Vec<Value>,
    #[serde(default)]
    pub allow_tool_call_id: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterBridgeInputForUpstreamOutput {
    pub input: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareResponsesRequestEnvelopeInput {
    #[serde(default)]
    pub request: Value,
    #[serde(default)]
    pub context_system_instruction: Option<Value>,
    #[serde(default)]
    pub extra_system_instruction: Option<Value>,
    #[serde(default)]
    pub metadata_system_instruction: Option<Value>,
    #[serde(default)]
    pub combined_system_instruction: Option<Value>,
    #[serde(default)]
    pub reasoning_instruction_segments: Option<Value>,
    #[serde(default)]
    pub context_parameters: Option<Value>,
    #[serde(default)]
    pub chat_parameters: Option<Value>,
    #[serde(default)]
    pub metadata_parameters: Option<Value>,
    #[serde(default)]
    pub context_stream: Option<Value>,
    #[serde(default)]
    pub metadata_stream: Option<Value>,
    #[serde(default)]
    pub chat_stream: Option<Value>,
    #[serde(default)]
    pub chat_parameters_stream: Option<Value>,
    #[serde(default)]
    pub context_include: Option<Value>,
    #[serde(default)]
    pub metadata_include: Option<Value>,
    #[serde(default)]
    pub context_store: Option<Value>,
    #[serde(default)]
    pub metadata_store: Option<Value>,
    #[serde(default)]
    pub strip_host_fields: Option<bool>,
    #[serde(default)]
    pub context_tool_choice: Option<Value>,
    #[serde(default)]
    pub metadata_tool_choice: Option<Value>,
    #[serde(default)]
    pub context_parallel_tool_calls: Option<Value>,
    #[serde(default)]
    pub metadata_parallel_tool_calls: Option<Value>,
    #[serde(default)]
    pub context_response_format: Option<Value>,
    #[serde(default)]
    pub metadata_response_format: Option<Value>,
    #[serde(default)]
    pub context_service_tier: Option<Value>,
    #[serde(default)]
    pub metadata_service_tier: Option<Value>,
    #[serde(default)]
    pub context_truncation: Option<Value>,
    #[serde(default)]
    pub metadata_truncation: Option<Value>,
    #[serde(default)]
    pub context_metadata: Option<Value>,
    #[serde(default)]
    pub metadata_metadata: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareResponsesRequestEnvelopeOutput {
    pub request: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendLocalImageBlockOnLatestUserInputInput {
    #[serde(default)]
    pub messages: Vec<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendLocalImageBlockOnLatestUserInputOutput {
    pub messages: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBridgeNormalizeHistoryInput {
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default)]
    pub tools: Option<Vec<Value>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBridgeNormalizeHistoryOutput {
    pub messages: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bridge_history: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBridgeCaptureToolResultsInput {
    #[serde(default)]
    pub stage: String,
    #[serde(default)]
    pub captured_tool_results: Option<Vec<Value>>,
    #[serde(default)]
    pub raw_request: Option<Value>,
    #[serde(default)]
    pub raw_response: Option<Value>,
    #[serde(default)]
    pub metadata: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBridgeCaptureToolResultsOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captured_tool_results: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBridgeEnsureToolPlaceholdersInput {
    #[serde(default)]
    pub stage: String,
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default)]
    pub captured_tool_results: Option<Vec<Value>>,
    #[serde(default)]
    pub raw_request: Option<Value>,
    #[serde(default)]
    pub raw_response: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBridgeEnsureToolPlaceholdersOutput {
    pub messages: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_outputs: Option<Vec<Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInputToChatInput {
    #[serde(default)]
    pub input: Vec<Value>,
    #[serde(default)]
    pub tools: Option<Vec<Value>>,
    #[serde(default)]
    pub tool_result_fallback_text: Option<String>,
    #[serde(default)]
    pub normalize_function_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInputToChatOutput {
    pub messages: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractReasoningSegmentsInput {
    pub source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractReasoningSegmentsOutput {
    pub text: String,
    pub segments: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateToolArgumentsInput {
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub args: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateToolArgumentsOutput {
    pub repaired: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairToolCallInput {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub arguments: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureBridgeOutputFieldsInput {
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default)]
    pub tool_fallback: Option<String>,
    #[serde(default)]
    pub assistant_fallback: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureBridgeOutputFieldsOutput {
    pub messages: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBridgeReasoningExtractInput {
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default)]
    pub drop_from_content: Option<bool>,
    #[serde(default)]
    pub id_prefix_base: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBridgeReasoningExtractOutput {
    pub messages: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBridgeResponsesOutputReasoningInput {
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default)]
    pub raw_response: Option<Value>,
    #[serde(default)]
    pub id_prefix: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBridgeResponsesOutputReasoningOutput {
    pub messages: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeActionDescriptor {
    pub name: String,
    #[serde(default)]
    pub options: Option<Map<String, Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeActionStateSeed {
    #[serde(default)]
    pub messages: Option<Vec<Value>>,
    #[serde(default)]
    pub required_action: Option<Value>,
    #[serde(default)]
    pub captured_tool_results: Option<Vec<Value>>,
    #[serde(default)]
    pub raw_request: Option<Value>,
    #[serde(default)]
    pub raw_response: Option<Value>,
    #[serde(default)]
    pub metadata: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeActionState {
    pub messages: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_action: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captured_tool_results: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_request: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_response: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeActionPipelineInput {
    #[serde(default)]
    pub stage: String,
    #[serde(default)]
    pub actions: Option<Vec<BridgeActionDescriptor>>,
    #[serde(default)]
    pub protocol: Option<String>,
    #[serde(default)]
    pub module_type: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    pub state: BridgeActionState,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBridgeInjectSystemInstructionInput {
    #[serde(default)]
    pub stage: String,
    #[serde(default)]
    pub options: Option<Value>,
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default)]
    pub raw_request: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBridgeInjectSystemInstructionOutput {
    pub messages: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBridgeEnsureSystemInstructionInput {
    #[serde(default)]
    pub stage: String,
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default)]
    pub metadata: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBridgeEnsureSystemInstructionOutput {
    pub messages: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBridgeMetadataActionInput {
    #[serde(default)]
    pub action_name: String,
    #[serde(default)]
    pub stage: String,
    #[serde(default)]
    pub options: Option<Value>,
    #[serde(default)]
    pub raw_request: Option<Value>,
    #[serde(default)]
    pub raw_response: Option<Value>,
    #[serde(default)]
    pub metadata: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBridgeMetadataActionOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_request: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_response: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}
