use crate::req_process_stage2_route_select::{
    apply_route_selection, RouteSelectionApplyInput, RouteSelectionApplyOutput,
};

pub(crate) fn apply_vr_route_04_selection(
    input: RouteSelectionApplyInput,
) -> Result<RouteSelectionApplyOutput, String> {
    apply_route_selection(input)
}
