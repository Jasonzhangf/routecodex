use crate::resp_process_stage1_tool_governance_blocks::orchestrator::{
    govern_response, ToolGovernanceInput, ToolGovernanceOutput,
};

pub(crate) fn govern_hub_resp_chatprocess_03_response(
    input: ToolGovernanceInput,
) -> Result<ToolGovernanceOutput, String> {
    govern_response(input)
}
