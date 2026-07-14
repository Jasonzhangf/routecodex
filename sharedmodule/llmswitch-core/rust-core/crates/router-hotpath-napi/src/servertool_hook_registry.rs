use servertool_core::hook_skeleton_contract::{
    ServertoolHookDirection, ServertoolHookRequiredness, ServertoolHookSpec, ServertoolReqHookPhase,
    ServertoolRespHookPhase,
};

pub(crate) const STOPLESS_REQUEST_HOOK_ID: &str = "stop_message_auto";
pub(crate) const STOPLESS_RESPONSE_HOOK_ID: &str = "stop_message_auto";

pub(crate) fn request_hook_specs() -> Vec<ServertoolHookSpec> {
    vec![ServertoolHookSpec {
        id: STOPLESS_REQUEST_HOOK_ID.to_string(),
        direction: ServertoolHookDirection::Request,
        req_phase: Some(ServertoolReqHookPhase::ServertoolReqHook01ResultParsed),
        resp_phase: None,
        requiredness: ServertoolHookRequiredness::Required,
        priority: 10,
        order: 0,
        owner_feature: "hub.servertool_stopless_cli_continuation".to_string(),
        input_node: "ChatProcReqContinuation03CanonicalRestored".to_string(),
        output_node: "ServertoolReqHook01ResultParsed".to_string(),
        effect_kind: "stopless_request_result_governance".to_string(),
        enabled: true,
    }]
}

pub(crate) fn response_hook_specs() -> Vec<ServertoolHookSpec> {
    vec![ServertoolHookSpec {
        id: STOPLESS_RESPONSE_HOOK_ID.to_string(),
        direction: ServertoolHookDirection::Response,
        req_phase: None,
        resp_phase: Some(ServertoolRespHookPhase::ServertoolRespHook01Intercepted),
        requiredness: ServertoolHookRequiredness::Required,
        priority: 10,
        order: 0,
        owner_feature: "hub.servertool_stopless_cli_continuation".to_string(),
        input_node: "HubRespChatProcess03Governed".to_string(),
        output_node: "ServertoolRespHook01Intercepted".to_string(),
        effect_kind: "stopless_response_intercept".to_string(),
        enabled: true,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use servertool_core::hook_skeleton_contract::{
        plan_servertool_hook_schedule, ServertoolHookSchedulerInput,
    };

    #[test]
    fn request_registry_mounts_stopless_after_continuation_restore() {
        let plan = plan_servertool_hook_schedule(ServertoolHookSchedulerInput {
            direction: ServertoolHookDirection::Request,
            req_phase: Some(ServertoolReqHookPhase::ServertoolReqHook01ResultParsed),
            resp_phase: None,
            hooks: request_hook_specs(),
            require_at_least_one_required_hook: true,
        })
        .expect("request hook schedule");

        assert_eq!(plan.projection.hook_ids, vec![STOPLESS_REQUEST_HOOK_ID]);
        assert_eq!(
            plan.projection.input_node,
            "ChatProcReqContinuation03CanonicalRestored"
        );
        assert_eq!(plan.projection.output_node, "ServertoolReqHook01ResultParsed");
    }
}
