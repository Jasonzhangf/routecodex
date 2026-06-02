use crate::req_process_stage1_tool_governance::{
    apply_req_process_tool_governance, ToolGovernanceInput, ToolGovernanceOutput,
};

pub(crate) fn apply_hub_req_chatprocess_03_tool_governance(
    input: ToolGovernanceInput,
) -> Result<ToolGovernanceOutput, String> {
    apply_req_process_tool_governance(input)
}
