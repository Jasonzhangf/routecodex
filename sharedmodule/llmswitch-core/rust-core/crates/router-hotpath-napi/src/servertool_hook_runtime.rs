use serde_json::Value;
use servertool_core::hook_skeleton_contract::{
    plan_servertool_hook_schedule, ServertoolHookDirection, ServertoolHookSchedulerInput,
    ServertoolRespHookPhase,
};

use crate::hub_pipeline_lib::errors::{HubPipelineError, HubPipelineResult};
use crate::servertool_hook_registry::{
    request_hook_specs, response_hook_specs, STOPLESS_RESPONSE_HOOK_ID,
};
use crate::servertool_stopless_hook::{run_stopless_response_hook, ServertoolHookOutput};

pub(crate) fn run_servertool_response_hooks(
    chatprocess_payload: &Value,
    metadata_center_snapshot: &Value,
    request_id: &str,
) -> HubPipelineResult<Option<ServertoolHookOutput>> {
    let schedule = plan_servertool_hook_schedule(ServertoolHookSchedulerInput {
        direction: ServertoolHookDirection::Response,
        req_phase: None,
        resp_phase: Some(ServertoolRespHookPhase::ServertoolRespHook01Intercepted),
        hooks: response_hook_specs(),
        require_at_least_one_required_hook: true,
    })
    .map_err(|error| {
        HubPipelineError::new(
            "hub_pipeline_servertool_resp_hook_schedule_failed",
            error.to_string(),
        )
    })?;

    for hook_id in schedule.projection.hook_ids {
        if hook_id == STOPLESS_RESPONSE_HOOK_ID {
            if let Some(output) =
                run_stopless_response_hook(chatprocess_payload, metadata_center_snapshot, request_id)?
            {
                return Ok(Some(output));
            }
        }
    }
    Ok(None)
}

pub(crate) fn run_servertool_request_hooks<F>(mut dispatch: F) -> HubPipelineResult<()>
where
    F: FnMut(&str) -> HubPipelineResult<()>,
{
    let schedule = plan_servertool_hook_schedule(ServertoolHookSchedulerInput {
        direction: ServertoolHookDirection::Request,
        req_phase: Some(
            servertool_core::hook_skeleton_contract::ServertoolReqHookPhase::ServertoolReqHook01ResultParsed,
        ),
        resp_phase: None,
        hooks: request_hook_specs(),
        require_at_least_one_required_hook: true,
    })
    .map_err(|error| {
        HubPipelineError::new(
            "hub_pipeline_servertool_req_hook_schedule_failed",
            error.to_string(),
        )
    })?;

    for hook_id in schedule.projection.hook_ids {
        dispatch(hook_id.as_str())?;
    }
    Ok(())
}
