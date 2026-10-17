use crate::operation_runner::{
    run_v3_single_node_operator, OperationRunnerError, V3OperationGraph,
};
use crate::route_policy::{
    observe_route_turn, V3RoutePolicyPendingGuard, V3RoutePolicyRuntimeState, V3RoutePolicyScope,
};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error01SourceRaised, V3ErrorSourceKind,
};
use routecodex_v3_virtual_router::{V3Router07OpaqueTargetHitOnce, V3VirtualRouter};
use serde_json::Value;
use std::sync::{Arc, Mutex};

const OPERATOR_NAME: &str = "routecodex.v3.operation.resolve_target";
const OPERATOR_VERSION: &str = "1";
const NODE_ID: &str = "resolve_target";

pub(crate) enum V3ResolveTargetExecutionMode {
    RelayFresh {
        manifest: Arc<V3Config05ManifestPublished>,
        server_id: String,
        entry_kind: String,
        endpoint_path: String,
        requested_model: Option<String>,
        deterministic_sample: u64,
    },
    DirectFresh {
        manifest: Arc<V3Config05ManifestPublished>,
        server_id: String,
        endpoint_path: String,
        entry_protocol: String,
        request_id: String,
        session_id: String,
        conversation_id: String,
        port: String,
        longcontext_threshold_tokens: Option<u64>,
        is_compaction: bool,
        now_epoch_ms: u64,
    },
    CapturedHandoff {
        opaque_hit: V3Router07OpaqueTargetHitOnce,
        route_policy_pending: Option<V3RoutePolicyPendingGuard>,
        route_policy_scope: Option<V3RoutePolicyScope>,
    },
}

pub(crate) struct V3ResolveTargetSideOutput {
    pub(crate) opaque_hit: V3Router07OpaqueTargetHitOnce,
    pub(crate) route_policy_pending: Option<V3RoutePolicyPendingGuard>,
    pub(crate) route_policy_scope: Option<V3RoutePolicyScope>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum V3ResolveTargetOperatorError {
    Typed(V3Error01SourceRaised),
    Runner(OperationRunnerError),
}

impl std::fmt::Display for V3ResolveTargetOperatorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Typed(error) => formatter.write_str(&error.message),
            Self::Runner(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for V3ResolveTargetOperatorError {}

struct ResolveTargetOperator {
    mode: V3ResolveTargetExecutionMode,
    side_output: Arc<Mutex<Option<Result<V3ResolveTargetSideOutput, V3Error01SourceRaised>>>>,
}

impl Operator for ResolveTargetOperator {
    fn name(&self) -> &'static str {
        OPERATOR_NAME
    }

    fn version(&self) -> &'static str {
        OPERATOR_VERSION
    }

    fn input_type(&self) -> ValueType {
        ValueType::Object
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _: &OperatorContext) -> Result<Value, String> {
        let resolved = resolve_target_from_value(&input, &self.mode);
        let mut holder = self
            .side_output
            .lock()
            .map_err(|_| "resolve_target side-output holder is poisoned".to_string())?;
        match resolved {
            Ok(side_output) => {
                *holder = Some(Ok(side_output));
                Ok(input)
            }
            Err(error) => {
                *holder = Some(Err(error.clone()));
                Err(error.message)
            }
        }
    }
}

fn resolve_target_from_value(
    input: &Value,
    mode: &V3ResolveTargetExecutionMode,
) -> Result<V3ResolveTargetSideOutput, V3Error01SourceRaised> {
    match mode {
        V3ResolveTargetExecutionMode::RelayFresh {
            manifest,
            server_id,
            entry_kind,
            endpoint_path,
            requested_model,
            deterministic_sample,
        } => {
            let routing_view = routing_view_with_requested_model(input, requested_model.as_deref());
            let opaque_hit =
                crate::provider_failure_runtime_policy::resolve_v3_relay_opaque_target_once(
                    manifest,
                    server_id,
                    entry_kind,
                    endpoint_path,
                    routing_view.as_ref(),
                    *deterministic_sample,
                )?;
            Ok(V3ResolveTargetSideOutput {
                opaque_hit,
                route_policy_pending: None,
                route_policy_scope: None,
            })
        }
        V3ResolveTargetExecutionMode::DirectFresh {
            manifest,
            server_id,
            endpoint_path,
            entry_protocol,
            request_id,
            session_id,
            conversation_id,
            port,
            longcontext_threshold_tokens,
            is_compaction,
            now_epoch_ms,
        } => {
            let facts = crate::build_v3_router_request_facts_for_resolve_target(
                input,
                entry_protocol,
                endpoint_path,
                *longcontext_threshold_tokens,
                *is_compaction,
                manifest,
            );
            let router = V3VirtualRouter::process_shared();
            let classified = router
                .classify_request_with_facts(manifest, server_id, endpoint_path, facts)
                .map_err(|error| {
                    build_v3_error_01_source_raised(
                        V3ErrorSourceKind::RuntimeFailure,
                        "V3Router05RequestClassified",
                        "v3_route_target_runtime_failure",
                        error.to_string(),
                    )
                })?;
            let route_policy_scope = V3RoutePolicyScope::without_conversation(
                server_id,
                &classified.routing_group_id,
                session_id,
                port,
            )
            .with_conversation(conversation_id);
            let observation =
                observe_route_turn(input, &classified.facts.route_classification.route_name);
            let (classified, route_policy_pending) = V3RoutePolicyRuntimeState::process_shared()
                .evaluate_request(
                    manifest,
                    classified,
                    route_policy_scope.clone(),
                    request_id,
                    observation,
                    *now_epoch_ms,
                )
                .map_err(|error| {
                    build_v3_error_01_source_raised(
                        V3ErrorSourceKind::RuntimeFailure,
                        "V3Router05RequestClassified",
                        "v3_route_target_runtime_failure",
                        error,
                    )
                })?;
            let plan = router
                .resolve_route_pool_plan(manifest, classified)
                .map_err(|error| {
                    crate::shared::v3_route_plan_error_source(
                        "V3Router06RoutePoolResolved",
                        "v3_route_target_runtime_failure",
                        error,
                    )
                })?;
            let opaque_hit = router
                .hit_opaque_target_plan_once(plan, 0)
                .map_err(|error| {
                    build_v3_error_01_source_raised(
                        V3ErrorSourceKind::RuntimeFailure,
                        "V3Router07OpaqueTargetHitOnce",
                        "v3_route_target_runtime_failure",
                        error.to_string(),
                    )
                })?;
            Ok(V3ResolveTargetSideOutput {
                opaque_hit,
                route_policy_pending: Some(route_policy_pending),
                route_policy_scope: Some(route_policy_scope),
            })
        }
        V3ResolveTargetExecutionMode::CapturedHandoff {
            opaque_hit,
            route_policy_pending,
            route_policy_scope,
        } => Ok(V3ResolveTargetSideOutput {
            opaque_hit: opaque_hit.clone(),
            route_policy_pending: route_policy_pending.clone(),
            route_policy_scope: route_policy_scope.clone(),
        }),
    }
}

fn routing_view_with_requested_model<'a>(
    input: &'a Value,
    requested_model: Option<&str>,
) -> std::borrow::Cow<'a, Value> {
    let Some(requested_model) = requested_model else {
        return std::borrow::Cow::Borrowed(input);
    };
    if input.get("model").is_some() {
        return std::borrow::Cow::Borrowed(input);
    }
    let mut routing_view = input.clone();
    routing_view["model"] = Value::String(requested_model.to_string());
    std::borrow::Cow::Owned(routing_view)
}

pub(crate) fn run_v3_resolve_target_operator(
    canonical_request: Value,
    mode: V3ResolveTargetExecutionMode,
) -> Result<(Value, V3ResolveTargetSideOutput), V3ResolveTargetOperatorError> {
    let side_output = Arc::new(Mutex::new(None));
    let operator = ResolveTargetOperator {
        mode,
        side_output: Arc::clone(&side_output),
    };
    let runner_result = run_v3_single_node_operator(
        V3OperationGraph::Request,
        NODE_ID,
        canonical_request,
        operator,
    );
    let typed_output = side_output
        .lock()
        .map_err(|_| {
            V3ResolveTargetOperatorError::Runner(OperationRunnerError::new(
                "resolve_target side-output holder is poisoned",
            ))
        })?
        .take();
    match (runner_result, typed_output) {
        (_, Some(Err(error))) => Err(V3ResolveTargetOperatorError::Typed(error)),
        (Err(error), _) => Err(V3ResolveTargetOperatorError::Runner(error)),
        (Ok(payload), Some(Ok(side_output))) => Ok((payload, side_output)),
        (Ok(_), None) => Err(V3ResolveTargetOperatorError::Runner(
            OperationRunnerError::new("resolve_target completed without typed side output"),
        )),
    }
}

#[cfg(test)]
mod tests;
