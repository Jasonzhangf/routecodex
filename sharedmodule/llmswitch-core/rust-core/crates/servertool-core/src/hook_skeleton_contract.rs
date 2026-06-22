// feature_id: hub.servertool_rust_only_closeout
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ServertoolHookDirection {
    Request,
    Response,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ServertoolReqHookPhase {
    ServertoolReqHook01ResultParsed,
    ServertoolReqHook02TextRewritten,
    ServertoolReqHook03ToolInjected,
    ServertoolReqHook04RequestFinalized,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ServertoolRespHookPhase {
    ServertoolRespHook01Intercepted,
    ServertoolRespHook02SchemaValidated,
    ServertoolRespHook03HookResponseInjected,
    ServertoolRespHook04FollowupPlanned,
    ServertoolRespHook05ReenterDispatched,
    ServertoolRespHook06ProjectionFinalized,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ServertoolHookRequiredness {
    Required,
    Optional,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolHookSpec {
    pub id: String,
    pub direction: ServertoolHookDirection,
    #[serde(default)]
    pub req_phase: Option<ServertoolReqHookPhase>,
    #[serde(default)]
    pub resp_phase: Option<ServertoolRespHookPhase>,
    pub requiredness: ServertoolHookRequiredness,
    pub priority: i32,
    pub order: i32,
    #[serde(rename = "ownerFeatureId", alias = "owner_feature_id")]
    pub owner_feature: String,
    pub input_node: String,
    pub output_node: String,
    pub effect_kind: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolHookSchedulerInput {
    pub direction: ServertoolHookDirection,
    #[serde(default)]
    pub req_phase: Option<ServertoolReqHookPhase>,
    #[serde(default)]
    pub resp_phase: Option<ServertoolRespHookPhase>,
    pub hooks: Vec<ServertoolHookSpec>,
    #[serde(default)]
    pub require_at_least_one_required_hook: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolHookEvent {
    pub hook_id: String,
    pub status: String,
    pub effect_kind: String,
    pub requiredness: ServertoolHookRequiredness,
    pub no_op: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolHookProjection {
    pub direction: ServertoolHookDirection,
    pub phase: String,
    pub input_node: String,
    pub output_node: String,
    pub hook_ids: Vec<String>,
    pub effect_kinds: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolHookEffectPlan {
    pub events: Vec<ServertoolHookEvent>,
    pub projection: ServertoolHookProjection,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServertoolHookSkeletonError {
    MissingField(&'static str),
    InvalidField(&'static str),
    DuplicateHookId(String),
    MissingRequiredHookForPhase,
    UnsupportedPhase(&'static str),
    HookConflict(&'static str),
}

impl std::fmt::Display for ServertoolHookSkeletonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServertoolHookSkeletonError::MissingField(field) => {
                write!(f, "SERVERTOOL_HOOK_SKELETON_MISSING_FIELD: {field}")
            }
            ServertoolHookSkeletonError::InvalidField(field) => {
                write!(f, "SERVERTOOL_HOOK_SKELETON_INVALID_FIELD: {field}")
            }
            ServertoolHookSkeletonError::DuplicateHookId(id) => {
                write!(f, "SERVERTOOL_HOOK_SKELETON_DUPLICATE_HOOK_ID: {id}")
            }
            ServertoolHookSkeletonError::MissingRequiredHookForPhase => {
                write!(
                    f,
                    "SERVERTOOL_HOOK_SKELETON_MISSING_REQUIRED_HOOK_FOR_PHASE"
                )
            }
            ServertoolHookSkeletonError::UnsupportedPhase(reason) => {
                write!(f, "SERVERTOOL_HOOK_SKELETON_UNSUPPORTED_PHASE: {reason}")
            }
            ServertoolHookSkeletonError::HookConflict(reason) => {
                write!(f, "SERVERTOOL_HOOK_SKELETON_CONFLICT: {reason}")
            }
        }
    }
}

impl std::error::Error for ServertoolHookSkeletonError {}

pub fn validate_servertool_hook_spec(
    spec: &ServertoolHookSpec,
) -> Result<ServertoolHookProjection, ServertoolHookSkeletonError> {
    let id = spec.id.trim();
    if id.is_empty() {
        return Err(ServertoolHookSkeletonError::MissingField("id"));
    }
    if spec.owner_feature.trim().is_empty() {
        return Err(ServertoolHookSkeletonError::MissingField("ownerFeatureId"));
    }
    if spec.effect_kind.trim().is_empty() {
        return Err(ServertoolHookSkeletonError::MissingField("effectKind"));
    }

    let (phase, expected_input, expected_output) = resolve_phase_contract(spec)?;
    if spec.input_node != expected_input {
        return Err(ServertoolHookSkeletonError::InvalidField("inputNode"));
    }
    if spec.output_node != expected_output {
        return Err(ServertoolHookSkeletonError::InvalidField("outputNode"));
    }

    Ok(ServertoolHookProjection {
        direction: spec.direction.clone(),
        phase: phase.to_string(),
        input_node: spec.input_node.clone(),
        output_node: spec.output_node.clone(),
        hook_ids: vec![spec.id.clone()],
        effect_kinds: vec![spec.effect_kind.clone()],
    })
}

pub fn plan_servertool_hook_schedule(
    input: ServertoolHookSchedulerInput,
) -> Result<ServertoolHookEffectPlan, ServertoolHookSkeletonError> {
    let expected_phase = resolve_requested_phase(&input.direction, &input.req_phase, &input.resp_phase)?;
    let mut matched: Vec<ServertoolHookSpec> = input
        .hooks
        .into_iter()
        .filter(|hook| match (&input.direction, &hook.direction) {
            (ServertoolHookDirection::Request, ServertoolHookDirection::Request) => {
                hook.req_phase.as_ref() == input.req_phase.as_ref()
            }
            (ServertoolHookDirection::Response, ServertoolHookDirection::Response) => {
                hook.resp_phase.as_ref() == input.resp_phase.as_ref()
            }
            _ => false,
        })
        .collect();

    matched.sort_by(|left, right| {
        left.priority
            .cmp(&right.priority)
            .then(left.order.cmp(&right.order))
            .then(left.id.cmp(&right.id))
    });

    let mut events = Vec::with_capacity(matched.len());
    let mut active_hook_ids = Vec::new();
    let mut active_effect_kinds = Vec::new();
    let mut expected_input_node: Option<String> = None;
    let mut expected_output_node: Option<String> = None;
    let mut saw_required = false;

    for hook in matched {
        let projection = validate_servertool_hook_spec(&hook)?;
        if projection.phase != expected_phase {
            return Err(ServertoolHookSkeletonError::UnsupportedPhase("phase mismatch"));
        }
        if events.iter().any(|event: &ServertoolHookEvent| event.hook_id == hook.id) {
            return Err(ServertoolHookSkeletonError::DuplicateHookId(hook.id));
        }
        if hook.requiredness == ServertoolHookRequiredness::Required {
            saw_required = true;
        }
        if !hook.enabled {
            if hook.requiredness == ServertoolHookRequiredness::Required {
                return Err(ServertoolHookSkeletonError::InvalidField("enabled"));
            }
            events.push(ServertoolHookEvent {
                hook_id: hook.id,
                status: "skipped_optional".to_string(),
                effect_kind: hook.effect_kind,
                requiredness: hook.requiredness,
                no_op: true,
            });
            continue;
        }
        if active_effect_kinds.iter().any(|kind| kind == &hook.effect_kind) {
            return Err(ServertoolHookSkeletonError::HookConflict("duplicate effectKind"));
        }
        match &expected_input_node {
            Some(value) if value != &projection.input_node => {
                return Err(ServertoolHookSkeletonError::HookConflict("inputNode"));
            }
            None => expected_input_node = Some(projection.input_node.clone()),
            _ => {}
        }
        match &expected_output_node {
            Some(value) if value != &projection.output_node => {
                return Err(ServertoolHookSkeletonError::HookConflict("outputNode"));
            }
            None => expected_output_node = Some(projection.output_node.clone()),
            _ => {}
        }
        active_hook_ids.push(hook.id.clone());
        active_effect_kinds.push(hook.effect_kind.clone());
        events.push(ServertoolHookEvent {
            hook_id: hook.id,
            status: "scheduled".to_string(),
            effect_kind: hook.effect_kind,
            requiredness: hook.requiredness,
            no_op: false,
        });
    }

    if input.require_at_least_one_required_hook && !saw_required {
        return Err(ServertoolHookSkeletonError::MissingRequiredHookForPhase);
    }

    let (fallback_input, fallback_output) =
        expected_nodes_for_phase(&input.direction, &input.req_phase, &input.resp_phase)?;

    Ok(ServertoolHookEffectPlan {
        events,
        projection: ServertoolHookProjection {
            direction: input.direction,
            phase: expected_phase,
            input_node: expected_input_node.unwrap_or_else(|| fallback_input.to_string()),
            output_node: expected_output_node.unwrap_or_else(|| fallback_output.to_string()),
            hook_ids: active_hook_ids,
            effect_kinds: active_effect_kinds,
        },
    })
}

fn resolve_requested_phase(
    direction: &ServertoolHookDirection,
    req_phase: &Option<ServertoolReqHookPhase>,
    resp_phase: &Option<ServertoolRespHookPhase>,
) -> Result<String, ServertoolHookSkeletonError> {
    match direction {
        ServertoolHookDirection::Request => {
            if resp_phase.is_some() {
                return Err(ServertoolHookSkeletonError::UnsupportedPhase(
                    "request direction cannot use respPhase",
                ));
            }
            let phase = req_phase
                .as_ref()
                .ok_or(ServertoolHookSkeletonError::MissingField("reqPhase"))?;
            Ok(req_phase_name(phase).to_string())
        }
        ServertoolHookDirection::Response => {
            if req_phase.is_some() {
                return Err(ServertoolHookSkeletonError::UnsupportedPhase(
                    "response direction cannot use reqPhase",
                ));
            }
            let phase = resp_phase
                .as_ref()
                .ok_or(ServertoolHookSkeletonError::MissingField("respPhase"))?;
            Ok(resp_phase_name(phase).to_string())
        }
    }
}

fn resolve_phase_contract(
    spec: &ServertoolHookSpec,
) -> Result<(&'static str, &'static str, &'static str), ServertoolHookSkeletonError> {
    match spec.direction {
        ServertoolHookDirection::Request => {
            if spec.resp_phase.is_some() {
                return Err(ServertoolHookSkeletonError::UnsupportedPhase(
                    "request direction cannot use respPhase",
                ));
            }
            let phase = spec
                .req_phase
                .as_ref()
                .ok_or(ServertoolHookSkeletonError::MissingField("reqPhase"))?;
            let (input_node, output_node) = expected_nodes_for_req_phase(phase);
            Ok((req_phase_name(phase), input_node, output_node))
        }
        ServertoolHookDirection::Response => {
            if spec.req_phase.is_some() {
                return Err(ServertoolHookSkeletonError::UnsupportedPhase(
                    "response direction cannot use reqPhase",
                ));
            }
            let phase = spec
                .resp_phase
                .as_ref()
                .ok_or(ServertoolHookSkeletonError::MissingField("respPhase"))?;
            let (input_node, output_node) = expected_nodes_for_resp_phase(phase);
            Ok((resp_phase_name(phase), input_node, output_node))
        }
    }
}

fn expected_nodes_for_phase(
    direction: &ServertoolHookDirection,
    req_phase: &Option<ServertoolReqHookPhase>,
    resp_phase: &Option<ServertoolRespHookPhase>,
) -> Result<(&'static str, &'static str), ServertoolHookSkeletonError> {
    match direction {
        ServertoolHookDirection::Request => {
            let phase = req_phase
                .as_ref()
                .ok_or(ServertoolHookSkeletonError::MissingField("reqPhase"))?;
            Ok(expected_nodes_for_req_phase(phase))
        }
        ServertoolHookDirection::Response => {
            let phase = resp_phase
                .as_ref()
                .ok_or(ServertoolHookSkeletonError::MissingField("respPhase"))?;
            Ok(expected_nodes_for_resp_phase(phase))
        }
    }
}

fn expected_nodes_for_req_phase(
    phase: &ServertoolReqHookPhase,
) -> (&'static str, &'static str) {
    match phase {
        ServertoolReqHookPhase::ServertoolReqHook01ResultParsed => (
            "HubReqInbound02Standardized",
            "ServertoolReqHook01ResultParsed",
        ),
        ServertoolReqHookPhase::ServertoolReqHook02TextRewritten => (
            "ServertoolReqHook01ResultParsed",
            "ServertoolReqHook02TextRewritten",
        ),
        ServertoolReqHookPhase::ServertoolReqHook03ToolInjected => (
            "ServertoolReqHook02TextRewritten",
            "ServertoolReqHook03ToolInjected",
        ),
        ServertoolReqHookPhase::ServertoolReqHook04RequestFinalized => (
            "ServertoolReqHook03ToolInjected",
            "ServertoolReqHook04RequestFinalized",
        ),
    }
}

fn expected_nodes_for_resp_phase(
    phase: &ServertoolRespHookPhase,
) -> (&'static str, &'static str) {
    match phase {
        ServertoolRespHookPhase::ServertoolRespHook01Intercepted => (
            "HubRespChatProcess03Governed",
            "ServertoolRespHook01Intercepted",
        ),
        ServertoolRespHookPhase::ServertoolRespHook02SchemaValidated => (
            "ServertoolRespHook01Intercepted",
            "ServertoolRespHook02SchemaValidated",
        ),
        ServertoolRespHookPhase::ServertoolRespHook03HookResponseInjected => (
            "ServertoolRespHook02SchemaValidated",
            "ServertoolRespHook03HookResponseInjected",
        ),
        ServertoolRespHookPhase::ServertoolRespHook04FollowupPlanned => (
            "ServertoolRespHook03HookResponseInjected",
            "ServertoolRespHook04FollowupPlanned",
        ),
        ServertoolRespHookPhase::ServertoolRespHook05ReenterDispatched => (
            "ServertoolRespHook04FollowupPlanned",
            "ServertoolRespHook05ReenterDispatched",
        ),
        ServertoolRespHookPhase::ServertoolRespHook06ProjectionFinalized => (
            "ServertoolRespHook05ReenterDispatched",
            "ServertoolRespHook06ProjectionFinalized",
        ),
    }
}

fn req_phase_name(phase: &ServertoolReqHookPhase) -> &'static str {
    match phase {
        ServertoolReqHookPhase::ServertoolReqHook01ResultParsed => {
            "ServertoolReqHook01ResultParsed"
        }
        ServertoolReqHookPhase::ServertoolReqHook02TextRewritten => {
            "ServertoolReqHook02TextRewritten"
        }
        ServertoolReqHookPhase::ServertoolReqHook03ToolInjected => {
            "ServertoolReqHook03ToolInjected"
        }
        ServertoolReqHookPhase::ServertoolReqHook04RequestFinalized => {
            "ServertoolReqHook04RequestFinalized"
        }
    }
}

fn resp_phase_name(phase: &ServertoolRespHookPhase) -> &'static str {
    match phase {
        ServertoolRespHookPhase::ServertoolRespHook01Intercepted => {
            "ServertoolRespHook01Intercepted"
        }
        ServertoolRespHookPhase::ServertoolRespHook02SchemaValidated => {
            "ServertoolRespHook02SchemaValidated"
        }
        ServertoolRespHookPhase::ServertoolRespHook03HookResponseInjected => {
            "ServertoolRespHook03HookResponseInjected"
        }
        ServertoolRespHookPhase::ServertoolRespHook04FollowupPlanned => {
            "ServertoolRespHook04FollowupPlanned"
        }
        ServertoolRespHookPhase::ServertoolRespHook05ReenterDispatched => {
            "ServertoolRespHook05ReenterDispatched"
        }
        ServertoolRespHookPhase::ServertoolRespHook06ProjectionFinalized => {
            "ServertoolRespHook06ProjectionFinalized"
        }
    }
}

fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req_hook(
        id: &str,
        priority: i32,
        order: i32,
        requiredness: ServertoolHookRequiredness,
        enabled: bool,
        effect_kind: &str,
    ) -> ServertoolHookSpec {
        ServertoolHookSpec {
            id: id.to_string(),
            direction: ServertoolHookDirection::Request,
            req_phase: Some(ServertoolReqHookPhase::ServertoolReqHook03ToolInjected),
            resp_phase: None,
            requiredness,
            priority,
            order,
            owner_feature: "binding pending".to_string(),
            input_node: "ServertoolReqHook02TextRewritten".to_string(),
            output_node: "ServertoolReqHook03ToolInjected".to_string(),
            effect_kind: effect_kind.to_string(),
            enabled,
        }
    }

    #[test]
    fn validates_adjacent_nodes_for_phase() {
        let spec = req_hook(
            "inject.required",
            20,
            2,
            ServertoolHookRequiredness::Required,
            true,
            "tool_inject",
        );
        let projection = validate_servertool_hook_spec(&spec).expect("projection");
        assert_eq!(projection.phase, "ServertoolReqHook03ToolInjected");
        assert_eq!(projection.input_node, "ServertoolReqHook02TextRewritten");
        assert_eq!(projection.output_node, "ServertoolReqHook03ToolInjected");
    }

    #[test]
    fn rejects_invalid_adjacent_nodes() {
        let mut spec = req_hook(
            "inject.required",
            20,
            2,
            ServertoolHookRequiredness::Required,
            true,
            "tool_inject",
        );
        spec.output_node = "HubReqChatProcess03Governed".to_string();
        let err = validate_servertool_hook_spec(&spec).expect_err("must fail");
        assert_eq!(
            err.to_string(),
            "SERVERTOOL_HOOK_SKELETON_INVALID_FIELD: outputNode"
        );
    }

    #[test]
    fn schedules_hooks_by_priority_order_then_id() {
        let plan = plan_servertool_hook_schedule(ServertoolHookSchedulerInput {
            direction: ServertoolHookDirection::Request,
            req_phase: Some(ServertoolReqHookPhase::ServertoolReqHook03ToolInjected),
            resp_phase: None,
            hooks: vec![
                req_hook(
                    "z.third",
                    20,
                    2,
                    ServertoolHookRequiredness::Optional,
                    true,
                    "tool_inject_optional",
                ),
                req_hook(
                    "a.first",
                    10,
                    2,
                    ServertoolHookRequiredness::Required,
                    true,
                    "tool_inject_required",
                ),
                req_hook(
                    "b.second",
                    10,
                    2,
                    ServertoolHookRequiredness::Optional,
                    true,
                    "tool_inject_secondary",
                ),
            ],
            require_at_least_one_required_hook: true,
        })
        .expect("plan");
        assert_eq!(
            plan.projection.hook_ids,
            vec!["a.first", "b.second", "z.third"]
        );
        assert_eq!(
            plan.projection.effect_kinds,
            vec![
                "tool_inject_required",
                "tool_inject_secondary",
                "tool_inject_optional"
            ]
        );
    }

    #[test]
    fn emits_noop_event_for_skipped_optional_hook() {
        let plan = plan_servertool_hook_schedule(ServertoolHookSchedulerInput {
            direction: ServertoolHookDirection::Request,
            req_phase: Some(ServertoolReqHookPhase::ServertoolReqHook03ToolInjected),
            resp_phase: None,
            hooks: vec![req_hook(
                "inject.optional",
                10,
                1,
                ServertoolHookRequiredness::Optional,
                false,
                "tool_inject_optional",
            )],
            require_at_least_one_required_hook: false,
        })
        .expect("plan");
        assert_eq!(plan.events.len(), 1);
        assert_eq!(plan.events[0].status, "skipped_optional");
        assert!(plan.events[0].no_op);
        assert!(plan.projection.hook_ids.is_empty());
    }

    #[test]
    fn fails_when_required_hook_is_missing_for_phase() {
        let err = plan_servertool_hook_schedule(ServertoolHookSchedulerInput {
            direction: ServertoolHookDirection::Request,
            req_phase: Some(ServertoolReqHookPhase::ServertoolReqHook03ToolInjected),
            resp_phase: None,
            hooks: vec![req_hook(
                "inject.optional",
                10,
                1,
                ServertoolHookRequiredness::Optional,
                true,
                "tool_inject_optional",
            )],
            require_at_least_one_required_hook: true,
        })
        .expect_err("must fail");
        assert_eq!(
            err.to_string(),
            "SERVERTOOL_HOOK_SKELETON_MISSING_REQUIRED_HOOK_FOR_PHASE"
        );
    }

    #[test]
    fn fails_on_duplicate_hook_id() {
        let err = plan_servertool_hook_schedule(ServertoolHookSchedulerInput {
            direction: ServertoolHookDirection::Request,
            req_phase: Some(ServertoolReqHookPhase::ServertoolReqHook03ToolInjected),
            resp_phase: None,
            hooks: vec![
                req_hook(
                    "inject.same",
                    10,
                    1,
                    ServertoolHookRequiredness::Required,
                    true,
                    "tool_inject_required",
                ),
                req_hook(
                    "inject.same",
                    11,
                    1,
                    ServertoolHookRequiredness::Optional,
                    true,
                    "tool_inject_optional",
                ),
            ],
            require_at_least_one_required_hook: true,
        })
        .expect_err("must fail");
        assert_eq!(
            err.to_string(),
            "SERVERTOOL_HOOK_SKELETON_DUPLICATE_HOOK_ID: inject.same"
        );
    }

    #[test]
    fn fails_on_conflicting_effect_merge() {
        let err = plan_servertool_hook_schedule(ServertoolHookSchedulerInput {
            direction: ServertoolHookDirection::Request,
            req_phase: Some(ServertoolReqHookPhase::ServertoolReqHook03ToolInjected),
            resp_phase: None,
            hooks: vec![
                req_hook(
                    "inject.required",
                    10,
                    1,
                    ServertoolHookRequiredness::Required,
                    true,
                    "tool_inject",
                ),
                req_hook(
                    "inject.conflict",
                    11,
                    1,
                    ServertoolHookRequiredness::Optional,
                    true,
                    "tool_inject",
                ),
            ],
            require_at_least_one_required_hook: true,
        })
        .expect_err("must fail");
        assert_eq!(
            err.to_string(),
            "SERVERTOOL_HOOK_SKELETON_CONFLICT: duplicate effectKind"
        );
    }
}
