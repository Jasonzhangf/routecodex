use super::request_port::RequestPortLease;
use crate::{project_runtime_fault, ExecutionBinding, RuntimeFault, RuntimeLease, SkeletonRuntime};
use routecodex_v4_base_node::Scope;
use routecodex_v4_config::RuntimeProductConfig;
use routecodex_v4_error::{project_provider_failure, DecisionAction, ErrorChain, ExecutionDecision, ProviderFailure, RetryPolicy};
use routecodex_v4_router::ProductErrorPolicyPort;
use routecodex_v4_server::{HttpRequest, HttpResponse};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponsePortReceipt {
    pub request_id: String,
    pub binding: ExecutionBinding,
    pub terminal: bool,
}

/// Response and error consumption is terminal only after the request lease
/// proves the same immutable execution binding; no active epoch is reselected
/// and no response payload is used to reconstruct control state.
pub fn consume_response(
    request: &RequestPortLease,
    binding: &ExecutionBinding,
) -> Result<ResponsePortReceipt, RuntimeFault> {
    validate_binding(request, binding, "response")?;
    request.claim_terminal()?;
    Ok(ResponsePortReceipt {
        request_id: request.request_id().to_string(),
        binding: request.binding().clone(),
        terminal: true,
    })
}

pub fn consume_error(
    request: &RequestPortLease,
    binding: &ExecutionBinding,
) -> Result<ResponsePortReceipt, RuntimeFault> {
    validate_binding(request, binding, "error")?;
    request.claim_terminal()?;
    Ok(ResponsePortReceipt {
        request_id: request.request_id().to_string(),
        binding: request.binding().clone(),
        terminal: true,
    })
}

/// HTTP adapter owned by the response/error boundary.  The production
/// pipeline supplies a typed runtime fault; this adapter is the only place
/// that turns the completed error-chain projection into an HTTP response.
pub fn project_http_fault(request: &HttpRequest, fault: RuntimeFault, status: u16) -> HttpResponse {
    let scope = Scope::new(&request.request_id, "v4-pipeline", request.port, "", "");
    let mut chain = ErrorChain::new(scope);
    match project_runtime_fault(&mut chain, fault.clone()) {
        Ok(projection) => HttpResponse::error(status, projection.message),
        Err(error) => HttpResponse::error(
            500,
            format!(
                "error chain projection failed for {}: {error:?}",
                fault.code
            ),
        ),
    }
}

/// Production HTTP projection. The admitted runtime lease must execute the
/// compiled error NodePluginPlan before the error crate projects its typed
/// chain; a missing or incomplete plan is an explicit server error.
pub fn project_http_fault_with_runtime(
    runtime: &SkeletonRuntime,
    lease: &RuntimeLease,
    request: &HttpRequest,
    fault: RuntimeFault,
    status: u16,
) -> HttpResponse {
    if let Err(error) = runtime.execute_error_plan_with_lease(&fault, lease) {
        return HttpResponse::error(
            500,
            format!("error skeleton execution failed for {}: {error}", fault.code),
        );
    }
    project_http_fault(request, fault, status)
}

/// Pre-admission HTTP faults (for example an unknown route) still traverse
/// the compiled error skeleton.  The method owns a short-lived lease and
/// releases it before returning the projected response.
pub fn project_http_fault_with_runtime_unleased(
    runtime: &SkeletonRuntime,
    request: &HttpRequest,
    fault: RuntimeFault,
    status: u16,
) -> HttpResponse {
    let request_id = request.request_id.clone();
    let lease = match runtime.admit_request(&request_id) {
        Ok(lease) => lease,
        Err(error) => {
            return HttpResponse::error(
                500,
                format!("error skeleton admission failed: {error}"),
            )
        }
    };
    project_http_fault_with_runtime(runtime, &lease, request, fault, status)
}

/// Provider HTTP failures are classified by the compiled router policy, then
/// projected through the single six-stage error owner.  The response body is
/// read only by the policy matcher; it never crosses into a normal payload.
pub fn project_provider_http_fault(
    request: &HttpRequest,
    fault: RuntimeFault,
    status: u16,
    product: Option<&RuntimeProductConfig>,
    provider_id: &str,
    response_body: &str,
) -> HttpResponse {
    let Some(product) = product else {
        return project_http_fault(request, fault, status);
    };
    let Some(policy) = ProductErrorPolicyPort::evaluate(product, provider_id, status, response_body)
    else {
        return project_http_fault(request, fault, status);
    };
    let action = if policy.retry {
        DecisionAction::Reroute
    } else if policy.cooldown {
        DecisionAction::Cooldown
    } else {
        DecisionAction::Terminal
    };
    let projection = project_provider_failure(
        Scope::new(&request.request_id, "v4-pipeline", request.port, "", ""),
        ProviderFailure {
            code: fault.code.clone(),
            message: fault.message.clone(),
            node: fault.node_id.clone().unwrap_or_else(|| "unknown".to_string()),
            policy: RetryPolicy {
                policy_id: policy.policy_id.clone(),
                provider_scope: provider_id.to_string(),
                matcher: format!("http_status={status}"),
                action_class: if policy.retry { "retry" } else { "terminal" }.to_string(),
                reason_code: policy
                    .reason_code
                    .clone()
                    .unwrap_or_else(|| fault.code.clone()),
            },
            decision: ExecutionDecision {
                decision_id: format!("decision.{}", policy.policy_id),
                action,
                reason_code: policy
                    .reason_code
                    .clone()
                    .unwrap_or_else(|| fault.code.clone()),
            },
        },
    );
    match projection {
        Ok(value) => HttpResponse::error(policy.project_status.unwrap_or(status), value.message),
        Err(error) => HttpResponse::error(
            500,
            format!("provider error policy projection failed: {error:?}"),
        ),
    }
}

/// Production provider-fault projection with the same mandatory error
/// skeleton execution boundary as ordinary runtime faults.
pub fn project_provider_http_fault_with_runtime(
    runtime: &SkeletonRuntime,
    lease: &RuntimeLease,
    request: &HttpRequest,
    fault: RuntimeFault,
    status: u16,
    product: Option<&RuntimeProductConfig>,
    provider_id: &str,
    response_body: &str,
) -> HttpResponse {
    if let Err(error) = runtime.execute_error_plan_with_lease(&fault, lease) {
        return HttpResponse::error(
            500,
            format!("error skeleton execution failed for {}: {error}", fault.code),
        );
    }
    project_provider_http_fault(request, fault, status, product, provider_id, response_body)
}

fn validate_binding(
    request: &RequestPortLease,
    binding: &ExecutionBinding,
    stage: &str,
) -> Result<(), RuntimeFault> {
    let snapshot = request.lease_snapshot();
    if request.binding() != binding
        || snapshot.plan_epoch != binding.plan_epoch
        || snapshot.manifest_hash != binding.manifest_hash
    {
        return Err(RuntimeFault::new(
            "response_error_epoch_binding",
            format!("{stage} port binding differs from request admission lease"),
        ));
    }
    Ok(())
}
