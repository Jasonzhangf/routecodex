//! Runtime-owned production request/response pipeline.
//!
//! The binary owns listener and lifecycle adaptation only. Protocol semantics,
//! routing, provider transport, error projection, response framing, and console
//! projection live here behind the typed runtime owner.

use crate::{
    BufferedProviderSseSource, NativeProviderSseSource, ProviderSseSource, ResponseStreamProcessor,
    RuntimeFault, RuntimeLease, SkeletonRuntime, SseTransportDriver, V4RuntimeTimingSummary,
};
use routecodex_v4_base_node::Scope;
use routecodex_v4_config::{RuntimeConfigManifest, RuntimeProductConfig};
use routecodex_v4_error::{DecisionAction, ErrorChain, ExecutionDecision, RetryPolicy};
use routecodex_v4_provider::{
    ProviderTransportError, ProviderTransportPort, ProviderTransportRequest,
    ProviderTransportResult, V4Availability01SessionScoped,
};
use routecodex_v4_router::{
    ProductErrorDecision, ProductErrorExecutionAction, ProductErrorPolicyPort, SelectedTarget,
    TargetSelectionRequest,
};
use routecodex_v4_server::{HttpRequest, HttpResponse};
use routecodex_v4_standard_plugins::diagnostic;
use routecodex_v4_standard_plugins::protocol::provider_response::ProviderSseTerminalDisposition;
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

// HTTP/error projection is owned by `response_error_port`; these re-exports
// preserve the public adapter surface for the listener without retaining a
// second implementation in the production pipeline.
pub use crate::response_error_port::{
    project_http_fault as project_fault, project_provider_http_fault as project_upstream_fault,
};

/// Project a fault that happened before request admission. The runtime owns a
/// short-lived lease for the error skeleton; the listener never projects a
/// route error directly from the payload layer.
pub fn project_fault_unleased(
    runtime: &Arc<Mutex<SkeletonRuntime>>,
    request: &HttpRequest,
    fault: RuntimeFault,
    status: u16,
) -> HttpResponse {
    match runtime.lock() {
        Ok(runtime) => crate::response_error_port::project_http_fault_with_runtime_unleased(
            &runtime, request, fault, status,
        ),
        Err(_) => HttpResponse::error(500, "request runtime lock poisoned"),
    }
}

/// Runtime-owned production dispatch. The listener adapter passes the same
/// immutable runtime/availability state used for admission and epoch leasing.
pub fn dispatch(
    manifest: &RuntimeConfigManifest,
    runtime: &Arc<Mutex<SkeletonRuntime>>,
    availability: &Arc<Mutex<routecodex_v4_provider::V4Availability01SessionScoped>>,
    request: &HttpRequest,
    entry_protocol: &str,
    continuation_owner: &str,
) -> Result<HttpResponse, HttpResponse> {
    dispatch_with_cancellation(
        manifest,
        runtime,
        availability,
        request,
        entry_protocol,
        continuation_owner,
        None,
    )
}

pub fn dispatch_with_cancellation(
    manifest: &RuntimeConfigManifest,
    runtime: &Arc<Mutex<SkeletonRuntime>>,
    availability: &Arc<Mutex<routecodex_v4_provider::V4Availability01SessionScoped>>,
    request: &HttpRequest,
    entry_protocol: &str,
    continuation_owner: &str,
    cancellation: Option<&AtomicBool>,
) -> Result<HttpResponse, HttpResponse> {
    dispatch_with_request_cancellation(
        manifest,
        runtime,
        availability,
        request,
        entry_protocol,
        continuation_owner,
        cancellation,
        None,
        None,
    )
}

pub fn dispatch_with_request_cancellation(
    manifest: &RuntimeConfigManifest,
    runtime: &Arc<Mutex<SkeletonRuntime>>,
    availability: &Arc<Mutex<routecodex_v4_provider::V4Availability01SessionScoped>>,
    request: &HttpRequest,
    entry_protocol: &str,
    continuation_owner: &str,
    cancellation: Option<&AtomicBool>,
    request_cancellation: Option<CancellationToken>,
    provider_runtime: Option<tokio::runtime::Handle>,
) -> Result<HttpResponse, HttpResponse> {
    dispatch_request(
        manifest,
        runtime,
        availability,
        request,
        entry_protocol,
        continuation_owner,
        cancellation,
        request_cancellation,
        provider_runtime,
    )
}

pub fn models_response(manifest: &RuntimeConfigManifest) -> HttpResponse {
    let mut models = if let Some(product) = &manifest.product {
        product
            .providers
            .iter()
            .flat_map(|provider| {
                provider.models.iter().flat_map(|model| {
                    std::iter::once(model.model_id.as_str())
                        .chain(model.aliases.iter().map(String::as_str))
                })
            })
            .collect::<Vec<_>>()
    } else {
        manifest
            .routes
            .iter()
            .flat_map(|route| route.models.iter().map(String::as_str))
            .collect::<Vec<_>>()
    };
    models.sort();
    models.dedup();
    json_response(
        200,
        serde_json::json!({
            "object": "list",
            "data": models.into_iter().map(|model| serde_json::json!({
                "id": model,
                "object": "model",
                "owned_by": "routecodex-v4"
            })).collect::<Vec<_>>()
        }),
    )
}

fn mark_provider_success_for_route(
    availability: &mut V4Availability01SessionScoped,
    port: u16,
    route_group_id: &str,
    session_scope: &str,
    provider_id: &str,
) -> Result<(), String> {
    availability
        .mark_success(
            &port.to_string(),
            route_group_id,
            session_scope,
            provider_id,
        )
        .map_err(|error| error.to_string())
}

fn provider_policy_decision_action(action: ProductErrorExecutionAction) -> DecisionAction {
    match action {
        ProductErrorExecutionAction::RetrySame => DecisionAction::Retry,
        ProductErrorExecutionAction::Reselect => DecisionAction::Reroute,
        ProductErrorExecutionAction::Cooldown => DecisionAction::Cooldown,
        ProductErrorExecutionAction::Terminal => DecisionAction::Terminal,
    }
}

fn provider_policy_action_class(action: ProductErrorExecutionAction) -> &'static str {
    match action {
        ProductErrorExecutionAction::RetrySame => "retry_same",
        ProductErrorExecutionAction::Reselect => "reselect",
        ProductErrorExecutionAction::Cooldown => "cooldown",
        ProductErrorExecutionAction::Terminal => "terminal",
    }
}

fn provider_policy_execution_decision(
    policy: &ProductErrorDecision,
    fault_code: &str,
) -> ExecutionDecision {
    ExecutionDecision {
        decision_id: format!("decision.{}", policy.policy_id),
        action: provider_policy_decision_action(policy.execution_action),
        reason_code: policy
            .reason_code
            .clone()
            .unwrap_or_else(|| fault_code.to_string()),
    }
}

/// Project a provider fault with the router-owned typed execution action.
/// The response/error port remains the fallback for requests without a
/// compiled product policy; policy-matched failures must preserve the typed
/// RetrySame/Reselect distinction in Error05.
fn project_provider_fault_with_typed_policy(
    runtime: &SkeletonRuntime,
    lease: &RuntimeLease,
    request: &HttpRequest,
    fault: RuntimeFault,
    status: u16,
    product: Option<&RuntimeProductConfig>,
    provider_id: &str,
    response_body: &str,
) -> HttpResponse {
    let Some(product) = product else {
        return crate::response_error_port::project_provider_http_fault_with_runtime(
            runtime,
            lease,
            request,
            fault,
            status,
            product,
            provider_id,
            response_body,
        );
    };
    let Some(policy) =
        ProductErrorPolicyPort::evaluate(product, provider_id, status, response_body)
    else {
        return crate::response_error_port::project_provider_http_fault_with_runtime(
            runtime,
            lease,
            request,
            fault,
            status,
            Some(product),
            provider_id,
            response_body,
        );
    };
    if let Err(error) = runtime.execute_error_plan_with_lease(&fault, lease) {
        return HttpResponse::error(
            500,
            format!(
                "error skeleton execution failed for {}: {error}",
                fault.code
            ),
        );
    }
    let decision = provider_policy_execution_decision(&policy, &fault.code);
    let reason_code = decision.reason_code.clone();
    let mut chain = ErrorChain::new(Scope::new(
        &request.request_id,
        "v4-pipeline",
        request.port,
        "",
        "",
    ));
    match crate::project_runtime_fault_with_policy(
        &mut chain,
        fault,
        RetryPolicy {
            policy_id: policy.policy_id,
            provider_scope: provider_id.to_string(),
            matcher: format!("http_status={status}"),
            action_class: provider_policy_action_class(policy.execution_action).to_string(),
            reason_code,
        },
        decision,
    ) {
        Ok(projection) => {
            HttpResponse::error(policy.project_status.unwrap_or(status), projection.message)
        }
        Err(error) => HttpResponse::error(
            500,
            format!("provider error policy projection failed: {error:?}"),
        ),
    }
}

fn dispatch_request(
    manifest: &RuntimeConfigManifest,
    runtime: &Arc<Mutex<SkeletonRuntime>>,
    availability: &Arc<Mutex<V4Availability01SessionScoped>>,
    request: &HttpRequest,
    entry_protocol: &str,
    continuation_owner: &str,
    cancellation: Option<&AtomicBool>,
    request_cancellation: Option<CancellationToken>,
    provider_runtime: Option<tokio::runtime::Handle>,
) -> Result<HttpResponse, HttpResponse> {
    let started_at = std::time::Instant::now();
    let request_timing = V4RuntimeTimingSummary::new();
    request_timing.start_request();
    let session_scope = request
        .header("x-rccv4-session-id")
        .unwrap_or(&request.request_id);
    let conversation_scope = request
        .header("x-rccv4-conversation-id")
        .unwrap_or(session_scope);
    let mut continuation_owner = continuation_owner.to_string();
    let request_id = request.request_id.clone();
    let request_lease = {
        let runtime_guard = runtime.lock().map_err(|_| {
            project_fault(
                request,
                RuntimeFault::new("request_runtime_lock", "request runtime lock poisoned"),
                500,
            )
        })?;
        runtime_guard.admit_request(&request_id)
    }
    .map_err(|fault| project_fault(request, fault, 598))?;
    let project_fault = |request: &HttpRequest, fault: RuntimeFault, status: u16| -> HttpResponse {
        match runtime.lock() {
            Ok(runtime) => crate::response_error_port::project_http_fault_with_runtime(
                &runtime,
                &request_lease,
                request,
                fault,
                status,
            ),
            Err(_) => HttpResponse::error(500, "request runtime lock poisoned"),
        }
    };
    let project_upstream_fault = |request: &HttpRequest,
                                  fault: RuntimeFault,
                                  status: u16,
                                  product: Option<&RuntimeProductConfig>,
                                  provider_id: &str,
                                  response_body: &str|
     -> HttpResponse {
        match runtime.lock() {
            Ok(runtime) => project_provider_fault_with_typed_policy(
                &runtime,
                &request_lease,
                request,
                fault,
                status,
                product,
                provider_id,
                response_body,
            ),
            Err(_) => HttpResponse::error(500, "request runtime lock poisoned"),
        }
    };
    let admission = {
        let runtime_guard = runtime.lock().map_err(|_| {
            project_fault(
                request,
                RuntimeFault::new("request_runtime_lock", "request runtime lock poisoned"),
                500,
            )
        })?;
        runtime_guard.execute_request_admission_with_lease(
            &request.body,
            entry_protocol,
            &continuation_owner,
            &request_lease,
        )
    }
    .map_err(|fault| project_fault(request, fault, 400))?;
    let model = admission.model.as_str();
    let stream_mode = admission.stream;
    let mut selection_request = TargetSelectionRequest::new(
        request.header("x-rccv4-route-group-id").map(str::to_string),
        model,
        entry_protocol,
        if entry_protocol == "responses" {
            "direct"
        } else {
            "relay"
        },
    );
    let product = manifest.product.as_ref().ok_or_else(|| {
        project_fault(
            request,
            RuntimeFault::new(
                "product_route_config_missing",
                "production Cordis routing requires a compiled product route graph",
            ),
            500,
        )
    })?;
    let route_group_id = selection_request
        .resolved_route_group_id(product)
        .map_err(|error| {
            project_fault(
                request,
                RuntimeFault::new("product_route_group", error.to_string()),
                404,
            )
        })?;
    let mut unavailable_provider_ids = {
        let availability_guard = availability.lock().map_err(|_| {
            project_fault(
                request,
                RuntimeFault::new("availability_lock", "provider availability lock poisoned"),
                500,
            )
        })?;
        product
            .providers
            .iter()
            .filter(|provider| {
                !availability_guard.is_eligible(
                    &request.port.to_string(),
                    route_group_id,
                    session_scope,
                    &provider.provider_id,
                )
            })
            .map(|provider| provider.provider_id.clone())
            .collect::<Vec<_>>()
    };
    selection_request.unavailable_provider_ids = unavailable_provider_ids.clone();
    selection_request.has_previous_response_id = admission.has_previous_response_id;
    let mut target = {
        let runtime_guard = runtime.lock().map_err(|_| {
            project_fault(
                request,
                RuntimeFault::new("request_runtime_lock", "request runtime lock poisoned"),
                500,
            )
        })?;
        runtime_guard.execute_target_selection_with_lease(
            &request_lease,
            request.port,
            session_scope,
            conversation_scope,
            &selection_request,
        )
    }
    .map_err(|error| {
        let status = if !unavailable_provider_ids.is_empty() && error.code == "target_selection" {
            503
        } else {
            404
        };
        project_fault(
            request,
            RuntimeFault::new(
                if status == 503 {
                    "provider_pool_exhausted"
                } else {
                    "model_unavailable"
                },
                format!("{} (requested_model={})", error, model),
            ),
            status,
        )
    })?;
    continuation_owner = crate::select_execution_lane(entry_protocol, &target.protocol)
        .map_err(|fault| project_fault(request, fault, 400))?
        .to_string();
    if admission.has_previous_response_id && continuation_owner == "relay" {
        return Err(project_fault(
            request,
            RuntimeFault::new(
                "continuation_unsupported",
                "local or relay continuation is not supported; use provider-owned Direct continuation",
            ),
            400,
        ));
    }
    selection_request.execution_lane = continuation_owner.clone();
    let route_facts = selection_request.to_route_facts_value();
    let target_selection = target.to_control_value(&selection_request.execution_lane);
    let request_report = {
        let runtime_guard = runtime.lock().map_err(|_| {
            project_fault(
                request,
                RuntimeFault::new("request_runtime_lock", "request runtime lock poisoned"),
                500,
            )
        })?;
        runtime_guard.execute_request_json_scoped_for_target_with_route_facts_and_lease(
            &String::from_utf8_lossy(&request.body),
            entry_protocol,
            &target.protocol,
            &target.wire_model,
            stream_mode,
            &request_id,
            request.port,
            session_scope,
            conversation_scope,
            Some(&continuation_owner),
            Some(route_facts),
            Some(target_selection),
            Some(&request_lease),
        )
    }
    .map_err(|fault| project_fault(request, fault, 598))?;
    emit_payload_console_events(
        &request_report.trace,
        request,
        &request.path,
        &target.provider_id,
        &target.wire_model,
        stream_mode,
        None,
        started_at.elapsed(),
    );
    let request_scope = request_report.scope.clone();
    let semantic_body = request_report.provider_wire_value.ok_or_else(|| {
        project_fault(
            request,
            RuntimeFault::new(
                "request_wire_missing",
                "request chain produced no provider wire",
            ),
            598,
        )
    })?;
    let wire_body = semantic_body;
    let execute_request_plan = |target: &SelectedTarget,
                                stream: bool,
                                route_facts: Value,
                                execution_lane: &str|
     -> Result<Value, RuntimeFault> {
        let target_selection = target.to_control_value(execution_lane);
        let report = runtime
            .lock()
            .map_err(|_| {
                RuntimeFault::new("request_runtime_lock", "request runtime lock poisoned")
            })?
            .execute_request_json_scoped_for_target_with_route_facts_and_lease(
                &String::from_utf8_lossy(&request.body),
                entry_protocol,
                &target.protocol,
                &target.wire_model,
                stream,
                &request_id,
                request.port,
                session_scope,
                conversation_scope,
                Some(&continuation_owner),
                Some(route_facts),
                Some(target_selection),
                Some(&request_lease),
            )?;
        report.provider_wire_value.ok_or_else(|| {
            RuntimeFault::new(
                "request_wire_missing",
                "retry request chain produced no provider wire",
            )
        })
    };
    let execute_transport = |target: &SelectedTarget,
                             wire_body: &Value,
                             stream: bool|
     -> Result<ProviderTransportResult, ProviderTransportError> {
        let transport_open_started = std::time::Instant::now();
        let request = ProviderTransportRequest::new(
            &target.protocol,
            &target.config_path,
            target.auth_alias.as_deref(),
            &target.wire_model,
            wire_body.clone(),
            stream,
        )?;
        request_timing
            .begin_external()
            .map_err(|message| ProviderTransportError {
                code: "runtime_timing".to_string(),
                message,
                status: None,
            })?;
        let record_transport_open = || {
            request_timing.state().record_phase(
                "provider_transport_open",
                transport_open_started.elapsed().as_micros(),
            );
        };
        if stream {
            let cancellation = request_cancellation
                .clone()
                .unwrap_or_else(CancellationToken::new);
            let runtime = provider_runtime
                .clone()
                .ok_or_else(|| ProviderTransportError {
                    code: "provider_async_runtime".to_string(),
                    message:
                        "streaming provider transport requires an explicit async runtime handle"
                            .to_string(),
                    status: None,
                });
            let runtime = match runtime {
                Ok(runtime) => runtime,
                Err(error) => {
                    record_transport_open();
                    let _ = request_timing.finish_external();
                    return Err(error);
                }
            };
            return match ProviderTransportPort::execute_streaming(request, cancellation, &runtime) {
                Ok(result) => {
                    record_transport_open();
                    Ok(result)
                }
                Err(error) => {
                    record_transport_open();
                    let _ = request_timing.finish_external();
                    Err(error)
                }
            };
        }
        let result = ProviderTransportPort::execute(request);
        request_timing
            .finish_external()
            .map_err(|message| ProviderTransportError {
                code: "runtime_timing".to_string(),
                message,
                status: None,
            })?;
        result
    };
    let record_provider_failure = |provider_id: &str,
                                   cooldown_policy: bool,
                                   failure_threshold: u64|
     -> Result<(), HttpResponse> {
        let mut guard = availability.lock().map_err(|_| {
            project_fault(
                request,
                RuntimeFault::new("availability_lock", "provider availability lock poisoned"),
                500,
            )
        })?;
        guard
            .record_failure_for(
                &request.port.to_string(),
                Some(route_group_id),
                session_scope,
                provider_id,
                cooldown_policy,
                failure_threshold,
            )
            .map_err(|error| {
                project_fault(
                    request,
                    RuntimeFault::new("availability_record", error.to_string()),
                    500,
                )
            })
    };
    let ensure_client_connected = || -> Result<(), HttpResponse> {
        if cancellation.is_some_and(|token| token.load(Ordering::SeqCst)) {
            Err(project_fault(
                request,
                RuntimeFault::new("client_disconnected", "client disconnected"),
                499,
            ))
        } else {
            Ok(())
        }
    };
    let mut same_candidate_retries = BTreeMap::<String, u64>::new();
    let mut next_attempt = |current: &SelectedTarget,
                            policy: &ProductErrorDecision,
                            _status: u16,
                            response_body: &str,
                            stream: bool|
     -> Result<(SelectedTarget, Value), HttpResponse> {
        let can_retry_same = policy.execution_action == ProductErrorExecutionAction::RetrySame
            && policy.failure_threshold > 1;
        let candidate = if can_retry_same {
            let retries_done = same_candidate_retries
                .get(&current.provider_id)
                .copied()
                .unwrap_or(0);
            if retries_done < policy.failure_threshold.saturating_sub(1) {
                same_candidate_retries
                    .insert(current.provider_id.clone(), retries_done.saturating_add(1));
                current.clone()
            } else {
                if !unavailable_provider_ids
                    .iter()
                    .any(|provider| provider == &current.provider_id)
                {
                    unavailable_provider_ids.push(current.provider_id.clone());
                }
                selection_request.unavailable_provider_ids = unavailable_provider_ids.clone();
                let candidate = {
                    let runtime_guard = runtime.lock().map_err(|_| {
                        project_fault(
                            request,
                            RuntimeFault::new(
                                "request_runtime_lock",
                                "request runtime lock poisoned",
                            ),
                            500,
                        )
                    })?;
                    runtime_guard.execute_target_selection_with_lease(
                        &request_lease,
                        request.port,
                        session_scope,
                        conversation_scope,
                        &selection_request,
                    )
                };
                candidate.map_err(|error| {
                    project_upstream_fault(
                        request,
                        RuntimeFault::new(
                            "provider_pool_exhausted",
                            format!("provider retry reselection failed: {error}"),
                        ),
                        503,
                        manifest.product.as_ref(),
                        &current.provider_id,
                        response_body,
                    )
                })?
            }
        } else {
            // V3 bounds same-candidate retries by max_attempts - 1, but keeps
            // reselection bounded by the captured route candidate pool.
            if !unavailable_provider_ids
                .iter()
                .any(|provider| provider == &current.provider_id)
            {
                unavailable_provider_ids.push(current.provider_id.clone());
            }
            selection_request.unavailable_provider_ids = unavailable_provider_ids.clone();
            let candidate = {
                let runtime_guard = runtime.lock().map_err(|_| {
                    project_fault(
                        request,
                        RuntimeFault::new("request_runtime_lock", "request runtime lock poisoned"),
                        500,
                    )
                })?;
                runtime_guard.execute_target_selection_with_lease(
                    &request_lease,
                    request.port,
                    session_scope,
                    conversation_scope,
                    &selection_request,
                )
            };
            candidate.map_err(|error| {
                project_upstream_fault(
                    request,
                    RuntimeFault::new(
                        "provider_pool_exhausted",
                        format!("provider retry reselection failed: {error}"),
                    ),
                    503,
                    manifest.product.as_ref(),
                    &current.provider_id,
                    response_body,
                )
            })?
        };
        let retry_body = execute_request_plan(
            &candidate,
            stream,
            selection_request.to_route_facts_value(),
            &selection_request.execution_lane,
        )
        .map_err(|fault| project_fault(request, fault, 598))?;
        Ok((candidate, retry_body))
    };
    ensure_client_connected()?;
    if stream_mode {
        let mut stream = match execute_transport(&target, &wire_body, true).map_err(|error| {
            project_fault(
                request,
                RuntimeFault::new(error.code.as_str(), error.message)
                    .with_status(error.status.unwrap_or(502)),
                error.status.unwrap_or(502),
            )
        })? {
            ProviderTransportResult::Stream(_) => {
                let _ = request_timing.finish_external_if_active();
                return Err(project_upstream_fault(
                    request,
                    RuntimeFault::new(
                        "provider_transport_shape",
                        "streaming transport returned blocking response",
                    ),
                    502,
                    manifest.product.as_ref(),
                    &target.provider_id,
                    "",
                ));
            }
            ProviderTransportResult::NativeStream(stream) => NativeProviderSseSource::new(
                stream,
                request_cancellation
                    .clone()
                    .unwrap_or_else(CancellationToken::new),
                match provider_runtime.clone() {
                    Some(runtime) => runtime,
                    None => {
                        let _ = request_timing.finish_external_if_active();
                        return Err(project_upstream_fault(
                            request,
                            RuntimeFault::new(
                                "provider_async_runtime",
                                "streaming provider transport requires an explicit async runtime handle",
                            ),
                            502,
                            manifest.product.as_ref(),
                            &target.provider_id,
                            "",
                        ));
                    }
                },
            ),
            ProviderTransportResult::Response(_) => {
                let _ = request_timing.finish_external_if_active();
                return Err(project_fault(
                    request,
                    RuntimeFault::new(
                        "provider_transport_shape",
                        "stream transport returned non-stream response",
                    ),
                    502,
                ));
            }
        };
        let mut response_body = String::new();
        let mut buffered_provider_body: Option<Vec<u8>> = None;
        loop {
            if stream.status() >= 400 {
                let bytes = match stream.read_error_body() {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        let _ = request_timing.finish_external_if_active();
                        return Err(project_upstream_fault(
                            request,
                            RuntimeFault::new(
                                "provider_response_read",
                                format!("provider error body read failed: {error}"),
                            )
                            .with_status(stream.status()),
                            stream.status(),
                            manifest.product.as_ref(),
                            &target.provider_id,
                            "",
                        ));
                    }
                };
                let _ = request_timing.finish_external();
                response_body = String::from_utf8_lossy(&bytes).into_owned();
                let Some(product) = manifest.product.as_ref() else {
                    break;
                };
                let Some(policy) = ProductErrorPolicyPort::evaluate(
                    product,
                    &target.provider_id,
                    stream.status(),
                    &response_body,
                ) else {
                    break;
                };
                record_provider_failure(
                    &target.provider_id,
                    policy.cooldown,
                    policy.failure_threshold,
                )?;
                if !policy.retry {
                    break;
                }
                if policy.backoff_ms > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(policy.backoff_ms));
                }
                let (candidate, retry_body) =
                    next_attempt(&target, &policy, stream.status(), &response_body, true)?;
                target = candidate;
                stream = match execute_transport(&target, &retry_body, true).map_err(|error| {
                    project_upstream_fault(
                        request,
                        RuntimeFault::new(&error.code, error.message),
                        error.status.unwrap_or(502),
                        manifest.product.as_ref(),
                        &target.provider_id,
                        "",
                    )
                })? {
                    ProviderTransportResult::Stream(_) => {
                        let _ = request_timing.finish_external_if_active();
                        return Err(project_upstream_fault(
                            request,
                            RuntimeFault::new(
                                "provider_transport_shape",
                                "streaming transport returned blocking response",
                            ),
                            502,
                            manifest.product.as_ref(),
                            &target.provider_id,
                            "",
                        ));
                    }
                    ProviderTransportResult::NativeStream(stream) => NativeProviderSseSource::new(
                        stream,
                        request_cancellation
                            .clone()
                            .unwrap_or_else(CancellationToken::new),
                        match provider_runtime.clone() {
                            Some(runtime) => runtime,
                            None => {
                                let _ = request_timing.finish_external_if_active();
                                return Err(project_upstream_fault(
                                    request,
                                    RuntimeFault::new(
                                        "provider_async_runtime",
                                        "streaming provider transport requires an explicit async runtime handle",
                                    ),
                                    502,
                                    manifest.product.as_ref(),
                                    &target.provider_id,
                                    "",
                                ));
                            }
                        },
                    ),
                    ProviderTransportResult::Response(_) => {
                        let _ = request_timing.finish_external_if_active();
                        return Err(project_upstream_fault(
                            request,
                            RuntimeFault::new(
                                "provider_transport_shape",
                                "stream transport returned non-stream response",
                            ),
                            502,
                            manifest.product.as_ref(),
                            &target.provider_id,
                            "",
                        ));
                    }
                };
                continue;
            }

            // A provider attempt is sealed at its protocol terminal before any
            // client frame is committed. This boundary is unconditional; the
            // product error policy only decides what to do after the terminal.
            let (bytes, disposition) = match stream.read_attempt_until_terminal(&target.protocol) {
                Ok(result) => result,
                Err(error) => {
                    let _ = request_timing.finish_external_if_active();
                    return Err(project_upstream_fault(
                        request,
                        RuntimeFault::new(
                            "provider_response_read",
                            format!("provider success body read failed: {error}"),
                        )
                        .with_status(stream.status()),
                        stream.status(),
                        manifest.product.as_ref(),
                        &target.provider_id,
                        "",
                    ));
                }
            };
            response_body = String::from_utf8_lossy(&bytes).into_owned();
            buffered_provider_body = Some(bytes);
            let matched_policy = match &disposition {
                ProviderSseTerminalDisposition::Failed { message } => {
                    manifest.product.as_ref().and_then(|product| {
                        ProductErrorPolicyPort::evaluate_semantic_failure(
                            product,
                            &target.provider_id,
                            &response_body,
                            &format!("provider_response_failed_{message}"),
                        )
                    })
                }
                ProviderSseTerminalDisposition::Completed => {
                    manifest.product.as_ref().and_then(|product| {
                        ProductErrorPolicyPort::evaluate(
                            product,
                            &target.provider_id,
                            stream.status(),
                            &response_body,
                        )
                    })
                }
                ProviderSseTerminalDisposition::Continue => None,
            };
            if matches!(disposition, ProviderSseTerminalDisposition::Failed { .. }) {
                let Some(policy) = matched_policy else {
                    let ProviderSseTerminalDisposition::Failed { message } = &disposition else {
                        unreachable!();
                    };
                    let _ = request_timing.finish_external_if_active();
                    return Err(project_fault(
                        request,
                        RuntimeFault::new("provider_response_failed", message.clone()),
                        599,
                    ));
                };
                record_provider_failure(
                    &target.provider_id,
                    policy.cooldown,
                    policy.failure_threshold,
                )?;
                if !policy.retry {
                    let _ = request_timing.finish_external_if_active();
                    let status = policy
                        .project_status
                        .filter(|status| !(200..300).contains(status))
                        .unwrap_or(599);
                    return Err(project_upstream_fault(
                        request,
                        RuntimeFault::new("provider_response_failed", "provider response failed")
                            .with_status(status),
                        status,
                        manifest.product.as_ref(),
                        &target.provider_id,
                        &response_body,
                    ));
                }
                if policy.backoff_ms > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(policy.backoff_ms));
                }
                let _ = request_timing.finish_external_if_active();
                let (candidate, retry_body) =
                    next_attempt(&target, &policy, stream.status(), &response_body, true)?;
                buffered_provider_body = None;
                response_body.clear();
                target = candidate;
                stream = match execute_transport(&target, &retry_body, true).map_err(|error| {
                    project_upstream_fault(
                        request,
                        RuntimeFault::new(&error.code, error.message),
                        error.status.unwrap_or(502),
                        manifest.product.as_ref(),
                        &target.provider_id,
                        "",
                    )
                })? {
                    ProviderTransportResult::Stream(_) => {
                        let _ = request_timing.finish_external_if_active();
                        return Err(project_upstream_fault(
                            request,
                            RuntimeFault::new(
                                "provider_transport_shape",
                                "streaming transport returned blocking response",
                            ),
                            502,
                            manifest.product.as_ref(),
                            &target.provider_id,
                            "",
                        ));
                    }
                    ProviderTransportResult::NativeStream(stream) => NativeProviderSseSource::new(
                        stream,
                        request_cancellation
                            .clone()
                            .unwrap_or_else(CancellationToken::new),
                        match provider_runtime.clone() {
                            Some(runtime) => runtime,
                            None => {
                                let _ = request_timing.finish_external_if_active();
                                return Err(project_upstream_fault(
                                        request,
                                        RuntimeFault::new(
                                            "provider_async_runtime",
                                            "streaming provider transport requires an explicit async runtime handle",
                                        ),
                                        502,
                                        manifest.product.as_ref(),
                                        &target.provider_id,
                                        "",
                                    ));
                            }
                        },
                    ),
                    ProviderTransportResult::Response(_) => {
                        let _ = request_timing.finish_external_if_active();
                        return Err(project_upstream_fault(
                            request,
                            RuntimeFault::new(
                                "provider_transport_shape",
                                "stream transport returned non-stream response",
                            ),
                            502,
                            manifest.product.as_ref(),
                            &target.provider_id,
                            "",
                        ));
                    }
                };
                continue;
            }
            if disposition == ProviderSseTerminalDisposition::Completed && stream.status() >= 400 {
                let Some(policy) = matched_policy else {
                    unreachable!("provider HTTP error must match the compiled policy");
                };
                record_provider_failure(
                    &target.provider_id,
                    policy.cooldown,
                    policy.failure_threshold,
                )?;
                if !policy.retry {
                    let _ = request_timing.finish_external_if_active();
                    return Err(project_upstream_fault(
                        request,
                        RuntimeFault::new(
                            "provider_http_error",
                            format!("upstream provider returned HTTP {}", stream.status()),
                        )
                        .with_status(stream.status()),
                        stream.status(),
                        manifest.product.as_ref(),
                        &target.provider_id,
                        &response_body,
                    ));
                }
                if policy.backoff_ms > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(policy.backoff_ms));
                }
                let _ = request_timing.finish_external_if_active();
                let (candidate, retry_body) =
                    next_attempt(&target, &policy, stream.status(), &response_body, true)?;
                buffered_provider_body = None;
                response_body.clear();
                target = candidate;
                stream = match execute_transport(&target, &retry_body, true).map_err(|error| {
                    project_upstream_fault(
                        request,
                        RuntimeFault::new(&error.code, error.message),
                        error.status.unwrap_or(502),
                        manifest.product.as_ref(),
                        &target.provider_id,
                        "",
                    )
                })? {
                    ProviderTransportResult::Stream(_) => {
                        let _ = request_timing.finish_external_if_active();
                        return Err(project_upstream_fault(
                            request,
                            RuntimeFault::new(
                                "provider_transport_shape",
                                "streaming transport returned blocking response",
                            ),
                            502,
                            manifest.product.as_ref(),
                            &target.provider_id,
                            "",
                        ));
                    }
                    ProviderTransportResult::NativeStream(stream) => NativeProviderSseSource::new(
                        stream,
                        request_cancellation
                            .clone()
                            .unwrap_or_else(CancellationToken::new),
                        match provider_runtime.clone() {
                            Some(runtime) => runtime,
                            None => {
                                let _ = request_timing.finish_external_if_active();
                                return Err(project_upstream_fault(
                                        request,
                                        RuntimeFault::new(
                                            "provider_async_runtime",
                                            "streaming provider transport requires an explicit async runtime handle",
                                        ),
                                        502,
                                        manifest.product.as_ref(),
                                        &target.provider_id,
                                        "",
                                    ));
                            }
                        },
                    ),
                    ProviderTransportResult::Response(_) => {
                        let _ = request_timing.finish_external_if_active();
                        return Err(project_upstream_fault(
                            request,
                            RuntimeFault::new(
                                "provider_transport_shape",
                                "stream transport returned non-stream response",
                            ),
                            502,
                            manifest.product.as_ref(),
                            &target.provider_id,
                            "",
                        ));
                    }
                };
                continue;
            }
            if disposition == ProviderSseTerminalDisposition::Completed {
                break;
            }
            break;
        }
        let status = stream.status();
        if status >= 400 {
            return Err(project_upstream_fault(
                request,
                RuntimeFault::new(
                    "provider_http_error",
                    format!("upstream provider returned HTTP {status}"),
                )
                .with_status(status),
                status,
                manifest.product.as_ref(),
                &target.provider_id,
                &response_body,
            ));
        }
        let provider_content_type = stream.content_type().to_string();
        if !provider_content_type
            .to_ascii_lowercase()
            .contains("text/event-stream")
        {
            let _ = request_timing.finish_external_if_active();
            return Err(project_fault(
                request,
                RuntimeFault::new(
                    "provider_sse_content_type",
                    format!(
                        "streaming Responses returned unsupported content type {provider_content_type}"
                    ),
                ),
                502,
            ));
        }
        let response_source: Box<dyn ProviderSseSource> =
            if let Some(bytes) = buffered_provider_body.take() {
                Box::new(BufferedProviderSseSource::new(bytes))
            } else {
                Box::new(stream)
            };
        let client_status = if (200..300).contains(&status) {
            200
        } else {
            status
        };
        let _ = std::io::stdout().flush();
        let response_processor = match ResponseStreamProcessor::new(
            request_lease,
            request_scope,
            request.port,
            entry_protocol,
            &target.protocol,
            &continuation_owner,
            session_scope,
            conversation_scope,
        ) {
            Ok(processor) => processor,
            Err(fault) => {
                let _ = request_timing.finish_external_if_active();
                return Err(crate::response_error_port::project_http_fault(
                    request, fault, 599,
                ));
            }
        };
        let response_stream = SseTransportDriver::new(
            response_source,
            Arc::clone(runtime),
            response_processor,
            request.clone(),
            target.provider_id.clone(),
            target.wire_model.clone(),
            request_timing.clone(),
        );
        let mut response = HttpResponse::streaming(
            client_status,
            "text/event-stream",
            Box::new(response_stream),
        );
        response.timing = Some(Arc::new(request_timing));
        return Ok(response);
    }
    let mut raw = match execute_transport(&target, &wire_body, false).map_err(|error| {
        let _ = request_timing.finish_external_if_active();
        project_upstream_fault(
            request,
            RuntimeFault::new(error.code.as_str(), error.message),
            error.status.unwrap_or(502),
            manifest.product.as_ref(),
            &target.provider_id,
            "",
        )
    })? {
        ProviderTransportResult::Response(response) => response,
        ProviderTransportResult::Stream(_) | ProviderTransportResult::NativeStream(_) => {
            return Err(project_upstream_fault(
                request,
                RuntimeFault::new(
                    "provider_transport_shape",
                    "non-stream transport returned stream response",
                ),
                502,
                manifest.product.as_ref(),
                &target.provider_id,
                "",
            ));
        }
    };
    let mut matched_policy = manifest.product.as_ref().and_then(|product| {
        ProductErrorPolicyPort::evaluate(
            product,
            &target.provider_id,
            raw.status,
            &String::from_utf8_lossy(&raw.body),
        )
    });
    while let Some(policy) = matched_policy.as_ref() {
        let Some(product) = manifest.product.as_ref() else {
            break;
        };
        record_provider_failure(
            &target.provider_id,
            policy.cooldown,
            policy.failure_threshold,
        )?;
        if !policy.retry {
            break;
        }
        if policy.backoff_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(policy.backoff_ms));
        }
        let (candidate, retry_body) = next_attempt(
            &target,
            policy,
            raw.status,
            &String::from_utf8_lossy(&raw.body),
            false,
        )?;
        target = candidate;
        raw = match execute_transport(&target, &retry_body, false).map_err(|error| {
            let _ = request_timing.finish_external_if_active();
            project_upstream_fault(
                request,
                RuntimeFault::new(&error.code, error.message),
                error.status.unwrap_or(502),
                manifest.product.as_ref(),
                &target.provider_id,
                "",
            )
        })? {
            ProviderTransportResult::Response(response) => response,
            ProviderTransportResult::Stream(_) | ProviderTransportResult::NativeStream(_) => {
                return Err(project_upstream_fault(
                    request,
                    RuntimeFault::new(
                        "provider_transport_shape",
                        "non-stream transport returned stream response",
                    ),
                    502,
                    manifest.product.as_ref(),
                    &target.provider_id,
                    "",
                ));
            }
        };
        matched_policy = ProductErrorPolicyPort::evaluate(
            product,
            &target.provider_id,
            raw.status,
            &String::from_utf8_lossy(&raw.body),
        );
    }
    if raw.status >= 400 || matched_policy.is_some() {
        return Err(project_upstream_fault(
            request,
            RuntimeFault::new(
                "provider_http_error",
                format!("upstream provider returned HTTP {}", raw.status),
            )
            .with_status(raw.status),
            raw.status,
            manifest.product.as_ref(),
            &target.provider_id,
            String::from_utf8_lossy(&raw.body).as_ref(),
        ));
    }
    if manifest.product.is_some() {
        let mut availability_guard = availability.lock().map_err(|_| {
            project_fault(
                request,
                RuntimeFault::new("availability_lock", "provider availability lock poisoned"),
                500,
            )
        })?;
        let _ = mark_provider_success_for_route(
            &mut availability_guard,
            request.port,
            route_group_id,
            session_scope,
            &target.provider_id,
        );
    }
    if raw
        .content_type
        .to_ascii_lowercase()
        .contains("text/event-stream")
    {
        return Err(project_fault(
            request,
            RuntimeFault::new(
                "provider_sse_unexpected",
                "non-stream Responses transport returned SSE payload",
            ),
            502,
        ));
    }
    // Keep the complete provider response body as the data-plane input. HTTP
    // status/content type were already consumed by the transport/error owner;
    // synthetic `_provider_http_*` members would mix transport control into
    // the response payload and create a second response envelope.
    let provider_raw = String::from_utf8(raw.body).map_err(|error| {
        project_fault(
            request,
            RuntimeFault::new("provider_response_utf8", error.to_string()),
            599,
        )
    })?;
    let report = {
        let runtime_guard = runtime.lock().map_err(|_| {
            project_fault(
                request,
                RuntimeFault::new("response_runtime_lock", "response runtime lock poisoned"),
                500,
            )
        })?;
        runtime_guard.execute_provider_response_scoped_for_target_with_lease(
            &provider_raw,
            &request_id,
            request.port,
            session_scope,
            conversation_scope,
            entry_protocol,
            &target.protocol,
            &continuation_owner,
            Some(&request_lease),
        )
    }
    .map_err(|fault| project_fault(request, fault, 502))?;
    request_timing.finish_runtime().map_err(|message| {
        project_fault(request, RuntimeFault::new("runtime_timing", message), 598)
    })?;
    let frame = report.client_frame.ok_or_else(|| {
        project_fault(
            request,
            RuntimeFault::new(
                "response_frame_missing",
                "response chain produced no client frame",
            ),
            502,
        )
    })?;
    let projected = serde_json::from_str(&frame).map_err(|error| {
        project_fault(
            request,
            RuntimeFault::new("response_frame_invalid", error.to_string()),
            502,
        )
    })?;
    let client_status = if (200..300).contains(&raw.status) {
        200
    } else {
        raw.status
    };
    emit_payload_console_events(
        &report.trace,
        request,
        &request.path,
        &target.provider_id,
        &target.wire_model,
        stream_mode,
        Some(client_status),
        started_at.elapsed(),
    );
    let _ = std::io::stdout().flush();
    let mut response = json_response(client_status, projected);
    response.timing = Some(Arc::new(request_timing));
    Ok(response)
}

pub(crate) fn emit_payload_console_events(
    trace: &[String],
    request: &HttpRequest,
    endpoint: &str,
    provider: &str,
    model: &str,
    stream: bool,
    status: Option<u16>,
    elapsed: std::time::Duration,
) {
    let mut stdout = std::io::stdout().lock();
    emit_payload_console_events_to(
        &mut stdout,
        trace,
        request,
        endpoint,
        provider,
        model,
        stream,
        status,
        elapsed,
    );
}

pub(crate) fn emit_payload_console_events_to<W: Write>(
    writer: &mut W,
    trace: &[String],
    request: &HttpRequest,
    endpoint: &str,
    provider: &str,
    model: &str,
    stream: bool,
    status: Option<u16>,
    elapsed: std::time::Duration,
) {
    for event in trace {
        if let Some(line) = render_payload_console_event(
            event, request, endpoint, provider, model, stream, status, elapsed,
        ) {
            let _ = writeln!(writer, "{line}");
            let _ = writer.flush();
        }
    }
}

pub fn render_payload_console_event(
    trace_entry: &str,
    request: &HttpRequest,
    endpoint: &str,
    provider: &str,
    model: &str,
    stream: bool,
    status: Option<u16>,
    elapsed: std::time::Duration,
) -> Option<String> {
    let (plugin_id, rest) = trace_entry.split_once(':')?;
    let (kind, message) = rest.split_once(':')?;
    let direct_hook = matches!(
        plugin_id,
        "v4.hook.direct.request" | "v4.hook.direct.response"
    );
    if !(plugin_id.ends_with("payload_console_render") || direct_hook)
        || kind != "console.payload_ready"
    {
        return None;
    }
    // TTY diagnostics may prefix the payload summary with ANSI color codes.
    // Normalize only the diagnostic presentation carrier; never touch the
    // business payload or control side-channel.
    let message = message.trim_start_matches(|ch: char| {
        ch == '\u{1b}' || ch == '[' || ch.is_ascii_digit() || ch == ';' || ch == 'm'
    });
    if message.starts_with("▶ [req]") {
        let headline = diagnostic::format_request(
            endpoint,
            &request.request_id,
            model,
            &format!("{provider}/{model}"),
        );
        let debug = format!(
            "event=started stream={} chain=req_inbound>req_chatprocess>req_outbound>provider elapsedMs={} transport={}",
            stream,
            elapsed.as_millis(),
            if stream { "sse" } else { "json" }
        );
        Some(format_console_layered(headline, debug))
    } else if message.starts_with("✅ [resp]") {
        // Streaming response nodes emit empty observations before the terminal
        // client frame.  They carry no user-visible information and must not
        // become one console line per chunk; the terminal report below remains
        // the single response summary.
        if message.contains("output_items=0") {
            return None;
        }
        let headline = diagnostic::format_response(
            endpoint,
            &request.request_id,
            status.unwrap_or(200),
            model,
        );
        let details = message
            .split_once("output_items=")
            .map(|(_, rest)| format!("output_items={rest}"))
            .unwrap_or_else(|| "response".to_string());
        let debug = format!(
            "event=completed responseStatus=completed finish_reason=stop provider={} model={} chain=provider>resp_inbound>resp_chatprocess>resp_outbound {} elapsedMs={} transport={}",
            provider,
            model,
            details,
            elapsed.as_millis(),
            if stream { "sse" } else { "json" }
        );
        Some(format_console_layered(headline, debug))
    } else {
        None
    }
}

fn format_console_layered(headline: String, debug: String) -> String {
    let color_disabled = std::env::var_os("NO_COLOR").is_some()
        || matches!(std::env::var("FORCE_COLOR").ok().as_deref(), Some("0"));
    if color_disabled {
        format!("{headline}\n\n  {debug}")
    } else {
        format!("{headline}\n\n\x1b[2;90m  {debug}\x1b[0m")
    }
}

pub fn json_response(status: u16, value: serde_json::Value) -> HttpResponse {
    let body = serde_json::to_vec(&value).expect("JSON response value is serializable");
    HttpResponse::json(status, body)
}

#[cfg(test)]
mod tests {
    use super::{
        dispatch, dispatch_with_request_cancellation, emit_payload_console_events_to,
        mark_provider_success_for_route, provider_policy_execution_decision,
    };
    use crate::SkeletonRuntime;
    use routecodex_v4_config::{compile_runtime_config, RuntimeConfigManifest};
    use routecodex_v4_cordis_bridge::{HandleRegistry, PluginHandle};
    use routecodex_v4_error::DecisionAction;
    use routecodex_v4_provider::V4Availability01SessionScoped;
    use routecodex_v4_router::{
        ProductErrorDecision, ProductErrorExecutionAction, ProductErrorPolicyPort,
        ProductErrorRetryMode, TargetSelectionHandle, DIRECT_TARGET_SELECTION_PLUGIN_ID,
        TARGET_SELECTION_PLUGIN_ID,
    };
    use routecodex_v4_server::HttpRequest;
    use routecodex_v4_standard_plugins::StandardHandleRegistry;
    use std::io::{self, Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;

    struct TestHandleRegistry {
        standard: StandardHandleRegistry,
        target_selection: TargetSelectionHandle,
    }

    impl TestHandleRegistry {
        fn new(manifest: &RuntimeConfigManifest) -> Self {
            Self {
                standard: StandardHandleRegistry::new(),
                target_selection: TargetSelectionHandle::new(
                    manifest
                        .product
                        .clone()
                        .expect("test manifest has product config"),
                ),
            }
        }
    }

    impl HandleRegistry for TestHandleRegistry {
        fn get(&self, plugin_id: &str) -> Option<&dyn PluginHandle> {
            if matches!(
                plugin_id,
                TARGET_SELECTION_PLUGIN_ID | DIRECT_TARGET_SELECTION_PLUGIN_ID
            ) {
                Some(&self.target_selection)
            } else {
                self.standard.get(plugin_id)
            }
        }

        fn encode_client_error_sse(
            &self,
            entry_protocol: &str,
            message: &str,
        ) -> Result<Vec<u8>, String> {
            self.standard
                .encode_client_error_sse(entry_protocol, message)
        }
    }

    struct FailingWriter;

    impl Write for FailingWriter {
        fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed console"))
        }

        fn flush(&mut self) -> io::Result<()> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed console"))
        }
    }

    #[test]
    fn console_projection_ignores_closed_stdout() {
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            headers: Vec::new(),
            body: Vec::new(),
            request_id: "closed-console-request".to_string(),
            server_id: "rccv4".to_string(),
            port: 5520,
        };
        let trace = vec![
            "v4.std.diagnostic.request_payload_console_render:console.payload_ready:▶ [req] model=gpt-5.5 stream=true messages=1 tools=0".to_string(),
        ];
        emit_payload_console_events_to(
            &mut FailingWriter,
            &trace,
            &request,
            "/v1/responses",
            "cc-sol",
            "gpt-5.5",
            true,
            None,
            std::time::Duration::from_millis(1),
        );
    }

    #[test]
    fn provider_success_clears_only_the_selected_route_group() {
        let mut availability = V4Availability01SessionScoped::new();
        for route_group_id in ["first", "selected"] {
            availability
                .record_failure_for("5520", Some(route_group_id), "session", "provider", true, 1)
                .expect("route-scoped failure records");
        }

        mark_provider_success_for_route(&mut availability, 5520, "selected", "session", "provider")
            .expect("selected route success clears its cooldown");

        assert!(!availability.is_eligible("5520", "first", "session", "provider"));
        assert!(availability.is_eligible("5520", "selected", "session", "provider"));
    }

    #[test]
    fn provider_policy_execution_decision_preserves_retry_and_reselect_actions() {
        let decision = |action| ProductErrorDecision {
            policy_id: "policy".to_string(),
            retry: true,
            retry_mode: None,
            execution_action: action,
            backoff_ms: 0,
            cooldown: false,
            failure_threshold: 2,
            project_status: None,
            reason_code: Some("provider_failure".to_string()),
        };
        assert_eq!(
            provider_policy_execution_decision(
                &decision(ProductErrorExecutionAction::RetrySame),
                "provider_http_500",
            )
            .action,
            DecisionAction::Retry
        );
        assert_eq!(
            provider_policy_execution_decision(
                &decision(ProductErrorExecutionAction::Reselect),
                "provider_http_503",
            )
            .action,
            DecisionAction::Reroute
        );
    }

    #[test]
    fn admission_failure_projects_without_reentering_runtime_lock() {
        let manifest = runtime_manifest();
        let runtime = runtime_from_manifest(&manifest);
        let runtime = Arc::new(Mutex::new(runtime));
        let availability = Arc::new(Mutex::new(V4Availability01SessionScoped::new()));
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            headers: Vec::new(),
            body: b"{".to_vec(),
            request_id: "admission-lock-red".to_string(),
            server_id: "rccv4".to_string(),
            port: 5520,
        };
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(dispatch(
                &manifest,
                &runtime,
                &availability,
                &request,
                "responses",
                "direct",
            ));
        });

        let response = match receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("admission failure must not deadlock")
        {
            Err(response) => response,
            Ok(response) => panic!("invalid JSON unexpectedly succeeded: {}", response.status),
        };
        assert_eq!(response.status, 400);
    }

    #[test]
    fn successful_production_dispatch_exposes_terminal_timing_projection() {
        let provider = TcpListener::bind("127.0.0.1:0").expect("provider listener");
        let provider_address = provider.local_addr().expect("provider address");
        let provider_thread = std::thread::spawn(move || {
            let (mut stream, _) = provider.accept().expect("provider accepts");
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body =
                br#"{"id":"resp_timing","object":"response","model":"mock-model","output":[]}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            )
            .expect("provider headers");
            stream.write_all(body).expect("provider body");
        });
        let provider_config = std::env::temp_dir().join(format!(
            "v4-provider-timing-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::write(
            &provider_config,
            format!(
                r#"
providerId = "mock"

[provider]
baseURL = "http://{provider_address}"
defaultModel = "mock-model"
type = "responses"
responsesContinuation = "direct"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("provider config");
        let manifest = runtime_manifest_with_provider_config(
            provider_config.to_str().expect("provider config path"),
        );
        let runtime = Arc::new(Mutex::new(runtime_from_manifest(&manifest)));
        let availability = Arc::new(Mutex::new(V4Availability01SessionScoped::new()));
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            headers: Vec::new(),
            body: br#"{"model":"mock-model","input":"hello"}"#.to_vec(),
            request_id: "production-timing".to_string(),
            server_id: "rccv4".to_string(),
            port: 5520,
        };

        let response = match dispatch(
            &manifest,
            &runtime,
            &availability,
            &request,
            "responses",
            "direct",
        ) {
            Ok(response) => response,
            Err(response) => panic!(
                "production dispatch failed with {}: {}",
                response.status,
                String::from_utf8_lossy(&response.body)
            ),
        };
        let timing = response
            .timing
            .as_ref()
            .expect("successful dispatch exposes timing")
            .snapshot()
            .expect("timing is frozen before response returns");
        assert!(timing.external_ms <= timing.internal_ms + timing.external_ms);
        provider_thread.join().expect("provider thread");
        std::fs::remove_file(provider_config).ok();
    }

    #[test]
    fn responses_continuation_dispatches_to_lower_priority_direct_target() {
        let provider = TcpListener::bind("127.0.0.1:0").expect("provider listener");
        let provider_address = provider.local_addr().expect("provider address");
        let provider_thread = std::thread::spawn(move || {
            let (mut stream, _) = provider.accept().expect("provider accepts");
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body = br#"{"id":"resp_continuation","object":"response","model":"mock-model","output":[]}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            )
            .expect("provider headers");
            stream.write_all(body).expect("provider body");
        });
        let provider_config = std::env::temp_dir().join(format!(
            "v4-provider-continuation-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::write(
            &provider_config,
            format!(
                r#"
providerId = "mock"

[provider]
baseURL = "http://{provider_address}"
defaultModel = "mock-model"
type = "responses"
responsesContinuation = "direct"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("provider config");
        let manifest = compile_runtime_config(
            &format!(
                r#"
version = 4

[runtime]
id = "rccv4"

[[listeners]]
id = "primary"
address = "127.0.0.1:5520"

[[providers]]
provider_id = "mock"
config_path = "{}"
protocol = "responses"
wire_model = "mock-model"
priority = 1
entry_models = ["mock-model"]

[[routes]]
id = "default"
models = ["mock-model"]
targets = ["mock"]

[product]
source = "continuation-direct-selection"

[[product.providers]]
provider_id = "mock"
protocol = "responses"
config_path = "{}"

[[product.providers.models]]
model_id = "mock-model"
wire_name = "mock-model"

[[product.providers]]
provider_id = "chat"
protocol = "openai_chat"
config_path = "{}"

[[product.providers.models]]
model_id = "mock-model"
wire_name = "chat-wire"

[[product.route_groups]]
route_group_id = "default"

[[product.route_groups.pools]]
pool_id = "default"
selection = "priority"

[[product.route_groups.pools.targets]]
provider_id = "chat"
model_id = "mock-model"
priority = 100

[[product.route_groups.pools.targets]]
provider_id = "mock"
model_id = "mock-model"
priority = 1
"#,
                provider_config.to_str().expect("provider config path"),
                provider_config.to_str().expect("provider config path"),
                provider_config.to_str().expect("provider config path"),
            ),
            None,
        )
        .expect("continuation selection runtime config compiles");
        let runtime = Arc::new(Mutex::new(runtime_from_manifest(&manifest)));
        let availability = Arc::new(Mutex::new(V4Availability01SessionScoped::new()));
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            headers: Vec::new(),
            body: br#"{"model":"mock-model","input":"hello","previous_response_id":"resp_1"}"#
                .to_vec(),
            request_id: "production-continuation-direct".to_string(),
            server_id: "rccv4".to_string(),
            port: 5520,
        };

        let response = match dispatch(
            &manifest,
            &runtime,
            &availability,
            &request,
            "responses",
            "direct",
        ) {
            Ok(response) => response,
            Err(response) => panic!(
                "continuation dispatch failed with {}: {}",
                response.status,
                String::from_utf8_lossy(&response.body)
            ),
        };
        assert_eq!(response.status, 200);
        provider_thread.join().expect("provider thread");
        std::fs::remove_file(provider_config).ok();
    }

    #[test]
    fn streaming_200_terminal_semantic_policy_projects_error() {
        let provider = TcpListener::bind("127.0.0.1:0").expect("provider listener");
        let provider_address = provider.local_addr().expect("provider address");
        let provider_thread = std::thread::spawn(move || {
            let (mut stream, _) = provider.accept().expect("provider accepts");
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body = concat!(
                "event: response.failed\n",
                "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"Type invalid, should be set\"}}}\n\n"
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            )
            .expect("provider headers");
            stream.write_all(body.as_bytes()).expect("provider body");
        });
        let provider_config = std::env::temp_dir().join(format!(
            "v4-provider-streaming-200-policy-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::write(
            &provider_config,
            format!(
                r#"
providerId = "mock"

[provider]
baseURL = "http://{provider_address}"
defaultModel = "mock-model"
type = "responses"
responsesContinuation = "direct"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("provider config");
        let manifest = runtime_manifest_with_provider_config_and_200_project(
            provider_config.to_str().expect("provider config path"),
        );
        let matched_policy = manifest
            .product
            .as_ref()
            .and_then(|product| {
                ProductErrorPolicyPort::evaluate(
                    product,
                    "mock",
                    200,
                    "Type invalid, should be set",
                )
            })
            .expect("manifest must bind the 200 semantic policy");
        assert_eq!(
            matched_policy.project_status,
            Some(400),
            "200 semantic policy must project configured 400"
        );
        let runtime = Arc::new(Mutex::new(runtime_from_manifest(&manifest)));
        let availability = Arc::new(Mutex::new(V4Availability01SessionScoped::new()));
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            headers: Vec::new(),
            body: br#"{"model":"mock-model","input":"hello","stream":true}"#.to_vec(),
            request_id: "production-streaming-200-policy".to_string(),
            server_id: "rccv4".to_string(),
            port: 5520,
        };

        let provider_runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("provider runtime");
        let response = match dispatch_with_request_cancellation(
            &manifest,
            &runtime,
            &availability,
            &request,
            "responses",
            "direct",
            None,
            None,
            Some(provider_runtime.handle().clone()),
        ) {
            Ok(response) => panic!(
                "200 SSE semantic policy unexpectedly returned success stream {}",
                response.status
            ),
            Err(response) => response,
        };
        assert_eq!(response.status, 400);
        let body = String::from_utf8(response.body).expect("error body is utf8");
        assert!(!body.contains("response.completed"), "{body}");
        provider_thread.join().expect("provider thread");
        std::fs::remove_file(provider_config).ok();
    }

    #[test]
    fn streaming_200_policy_prefetch_preserves_nonmatching_success_timing() {
        let provider = TcpListener::bind("127.0.0.1:0").expect("provider listener");
        let provider_address = provider.local_addr().expect("provider address");
        let provider_thread = std::thread::spawn(move || {
            let (mut stream, _) = provider.accept().expect("provider accepts");
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body = concat!(
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"model\":\"mock-model\",\"output\":[]}}\n\n"
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            )
            .expect("provider headers");
            stream.write_all(body.as_bytes()).expect("provider body");
        });
        let provider_config = std::env::temp_dir().join(format!(
            "v4-provider-streaming-200-nonmatch-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::write(
            &provider_config,
            format!(
                r#"
providerId = "mock"

[provider]
baseURL = "http://{provider_address}"
defaultModel = "mock-model"
type = "responses"
responsesContinuation = "direct"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("provider config");
        let manifest = runtime_manifest_with_provider_config_and_200_project(
            provider_config.to_str().expect("provider config path"),
        );
        let runtime = Arc::new(Mutex::new(runtime_from_manifest(&manifest)));
        let availability = Arc::new(Mutex::new(V4Availability01SessionScoped::new()));
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            headers: Vec::new(),
            body: br#"{"model":"mock-model","input":"hello","stream":true}"#.to_vec(),
            request_id: "production-streaming-200-nonmatch".to_string(),
            server_id: "rccv4".to_string(),
            port: 5520,
        };
        let provider_runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("provider runtime");
        let mut response = match dispatch_with_request_cancellation(
            &manifest,
            &runtime,
            &availability,
            &request,
            "responses",
            "direct",
            None,
            None,
            Some(provider_runtime.handle().clone()),
        ) {
            Ok(response) => response,
            Err(response) => panic!(
                "non-matching 200 policy unexpectedly failed with {}: {}",
                response.status,
                String::from_utf8_lossy(&response.body)
            ),
        };
        assert_eq!(response.status, 200);
        let mut stream = response.stream.take().expect("success response stream");
        let mut chunk = Vec::new();
        assert!(stream.next_chunk(&mut chunk).expect("client SSE chunk"));
        assert!(String::from_utf8_lossy(&chunk).contains("response.completed"));
        assert!(
            response
                .timing
                .as_ref()
                .expect("success response timing")
                .snapshot()
                .is_some(),
            "policy prefetch must leave timing closeout to the transport driver"
        );
        provider_thread.join().expect("provider thread");
        std::fs::remove_file(provider_config).ok();
    }

    #[test]
    fn streaming_semantic_policy_reselect_does_not_reuse_buffered_provider_body() {
        let first_provider = TcpListener::bind("127.0.0.1:0").expect("first provider listener");
        let first_address = first_provider.local_addr().expect("first provider address");
        let first_attempts = Arc::new(AtomicUsize::new(0));
        let first_attempts_by_provider = Arc::clone(&first_attempts);
        let first_thread = std::thread::spawn(move || {
            let (mut stream, _) = first_provider.accept().expect("first provider accepts");
            first_attempts_by_provider.fetch_add(1, Ordering::SeqCst);
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body = concat!(
                "event: response.failed\n",
                "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"Type invalid, should be set\"}}}\n\n"
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            )
            .expect("first provider headers");
            stream
                .write_all(body.as_bytes())
                .expect("first provider body");
        });
        let second_provider = TcpListener::bind("127.0.0.1:0").expect("second provider listener");
        let second_address = second_provider
            .local_addr()
            .expect("second provider address");
        let second_attempts = Arc::new(AtomicUsize::new(0));
        let second_attempts_by_provider = Arc::clone(&second_attempts);
        let second_thread = std::thread::spawn(move || {
            let (mut stream, _) = second_provider.accept().expect("second provider accepts");
            second_attempts_by_provider.fetch_add(1, Ordering::SeqCst);
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body = concat!(
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_retry\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"mock-model\",\"output\":[]}}\n\n"
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            )
            .expect("second provider headers");
            stream
                .write_all(body.as_bytes())
                .expect("second provider body");
        });
        let first_config = std::env::temp_dir().join(format!(
            "v4-provider-semantic-reselect-first-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::write(
            &first_config,
            format!(
                r#"
providerId = "mock"

[provider]
baseURL = "http://{first_address}"
defaultModel = "mock-model"
type = "responses"
responsesContinuation = "direct"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("provider config");
        let second_config = std::env::temp_dir().join(format!(
            "v4-provider-semantic-reselect-second-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::write(
            &second_config,
            format!(
                r#"
providerId = "second"

[provider]
baseURL = "http://{second_address}"
defaultModel = "mock-model"
type = "responses"
responsesContinuation = "direct"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("second provider config");
        let mut manifest = runtime_manifest_with_two_provider_configs(
            first_config.to_str().expect("first provider config path"),
            second_config.to_str().expect("second provider config path"),
        );
        let product = manifest.product.as_mut().expect("product config");
        product.error_policies = vec![routecodex_v4_config::RuntimeProductErrorPolicy {
            policy_id: "first_attempt_semantic_error".to_string(),
            scope_provider_id: Some("mock".to_string()),
            match_status: Some(200),
            match_content_contains_any: vec!["Type invalid, should be set".to_string()],
            reason_code: Some("provider_invalid_field_type".to_string()),
            actions: vec![
                routecodex_v4_config::RuntimeProductPolicyAction {
                    step: "wait_retry".to_string(),
                    retry_mode: Some("retry_same".to_string()),
                    max_attempts: Some(2),
                    backoff_ms: Some(0),
                    scope: None,
                    duration_ms: None,
                    status: None,
                    reason_code: None,
                    public_code: None,
                    message_mode: None,
                    provider_global_failure: None,
                },
                routecodex_v4_config::RuntimeProductPolicyAction {
                    step: "project".to_string(),
                    retry_mode: None,
                    max_attempts: None,
                    backoff_ms: None,
                    scope: None,
                    duration_ms: None,
                    status: Some(503),
                    reason_code: Some("provider_failure".to_string()),
                    public_code: None,
                    message_mode: Some("code_only".to_string()),
                    provider_global_failure: None,
                },
            ],
        }];
        let runtime = Arc::new(Mutex::new(runtime_from_manifest(&manifest)));
        let availability = Arc::new(Mutex::new(V4Availability01SessionScoped::new()));
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            headers: Vec::new(),
            body: br#"{"model":"mock-model","input":"hello","stream":true}"#.to_vec(),
            request_id: "production-stale-buffer".to_string(),
            server_id: "rccv4".to_string(),
            port: 5520,
        };
        let provider_runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("provider runtime");
        let mut response = match dispatch_with_request_cancellation(
            &manifest,
            &runtime,
            &availability,
            &request,
            "responses",
            "direct",
            None,
            None,
            Some(provider_runtime.handle().clone()),
        ) {
            Ok(response) => response,
            Err(response) => panic!(
                "retry dispatch failed with {}: {}",
                response.status,
                String::from_utf8_lossy(&response.body)
            ),
        };
        assert_eq!(response.status, 200);
        let mut stream = response.stream.take().expect("retry success stream");
        let mut chunk = Vec::new();
        assert!(stream
            .next_chunk(&mut chunk)
            .expect("retry client SSE chunk"));
        let body = String::from_utf8_lossy(&chunk);
        assert!(body.contains("resp_retry"), "{body}");
        assert!(!body.contains("resp_failed"), "{body}");
        assert_eq!(
            first_attempts.load(Ordering::SeqCst),
            1,
            "explicit semantic policy retry_same must not reuse the failed provider"
        );
        assert_eq!(
            second_attempts.load(Ordering::SeqCst),
            1,
            "explicit semantic policy retry_same must reselect"
        );
        first_thread.join().expect("first provider thread");
        second_thread.join().expect("second provider thread");
        std::fs::remove_file(first_config).ok();
        std::fs::remove_file(second_config).ok();
    }

    #[test]
    fn streaming_200_policy_seals_at_terminal_before_provider_eof() {
        let provider = TcpListener::bind("127.0.0.1:0").expect("provider listener");
        let provider_address = provider.local_addr().expect("provider address");
        let (close_provider, wait_for_close) = mpsc::channel();
        let provider_thread = std::thread::spawn(move || {
            let (mut stream, _) = provider.accept().expect("provider accepts");
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body = concat!(
                "event: response.failed\n",
                "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"Type invalid, should be set\"}}}\n\n"
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: keep-alive\r\n\r\n{:x}\r\n{}\r\n",
                body.len(),
                body
            )
            .expect("provider headers and terminal chunk");
            stream.flush().expect("provider terminal flush");
            let _ = wait_for_close.recv_timeout(Duration::from_secs(5));
            let _ = stream.write_all(b"0\r\n\r\n");
        });
        let provider_config = std::env::temp_dir().join(format!(
            "v4-provider-streaming-200-terminal-seal-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::write(
            &provider_config,
            format!(
                r#"
providerId = "mock"

[provider]
baseURL = "http://{provider_address}"
defaultModel = "mock-model"
type = "responses"
responsesContinuation = "direct"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("provider config");
        let manifest = runtime_manifest_with_provider_config_and_200_project(
            provider_config.to_str().expect("provider config path"),
        );
        let runtime = Arc::new(Mutex::new(runtime_from_manifest(&manifest)));
        let availability = Arc::new(Mutex::new(V4Availability01SessionScoped::new()));
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            headers: Vec::new(),
            body: br#"{"model":"mock-model","input":"hello","stream":true}"#.to_vec(),
            request_id: "production-streaming-200-terminal-seal".to_string(),
            server_id: "rccv4".to_string(),
            port: 5520,
        };
        let provider_runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("provider runtime");
        let (response_sender, response_receiver) = mpsc::channel();
        let dispatch_thread = std::thread::spawn(move || {
            let result = dispatch_with_request_cancellation(
                &manifest,
                &runtime,
                &availability,
                &request,
                "responses",
                "direct",
                None,
                None,
                Some(provider_runtime.handle().clone()),
            );
            let _ = response_sender.send(result);
        });
        let response = match response_receiver.recv_timeout(Duration::from_secs(2)) {
            Ok(result) => result,
            Err(error) => {
                let _ = close_provider.send(());
                let _ = response_receiver.recv_timeout(Duration::from_secs(2));
                panic!("provider terminal must not wait for TCP EOF: {error}");
            }
        };
        let _ = close_provider.send(());
        dispatch_thread.join().expect("dispatch thread");
        provider_thread.join().expect("provider thread");
        let response = match response {
            Ok(response) => response,
            Err(response) => response,
        };
        assert_eq!(response.status, 400);
        std::fs::remove_file(provider_config).ok();
    }

    #[test]
    fn streaming_policy_prefetch_rejects_attempt_over_bounded_staging() {
        let provider = TcpListener::bind("127.0.0.1:0").expect("provider listener");
        let provider_address = provider.local_addr().expect("provider address");
        let provider_thread = std::thread::spawn(move || {
            let (mut stream, _) = provider.accept().expect("provider accepts");
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: keep-alive\r\n\r\n"
            )
            .expect("provider headers");
            let frame = format!(
                "event: response.output_text.delta\ndata: {{\"type\":\"response.output_text.delta\",\"delta\":\"{}\"}}\n\n",
                "x".repeat(64 * 1024)
            );
            for _ in 0..257 {
                if write!(stream, "{:x}\r\n", frame.len()).is_err()
                    || stream.write_all(frame.as_bytes()).is_err()
                    || stream.write_all(b"\r\n").is_err()
                    || stream.flush().is_err()
                {
                    return;
                }
            }
        });
        let provider_config = std::env::temp_dir().join(format!(
            "v4-provider-streaming-staging-limit-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::write(
            &provider_config,
            format!(
                r#"
providerId = "mock"

[provider]
baseURL = "http://{provider_address}"
defaultModel = "mock-model"
type = "responses"
responsesContinuation = "direct"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("provider config");
        let manifest = runtime_manifest_with_provider_config_and_200_project(
            provider_config.to_str().expect("provider config path"),
        );
        let runtime = Arc::new(Mutex::new(runtime_from_manifest(&manifest)));
        let availability = Arc::new(Mutex::new(V4Availability01SessionScoped::new()));
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            headers: Vec::new(),
            body: br#"{"model":"mock-model","input":"hello","stream":true}"#.to_vec(),
            request_id: "production-streaming-staging-limit".to_string(),
            server_id: "rccv4".to_string(),
            port: 5520,
        };
        let provider_runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("provider runtime");
        let response = match dispatch_with_request_cancellation(
            &manifest,
            &runtime,
            &availability,
            &request,
            "responses",
            "direct",
            None,
            None,
            Some(provider_runtime.handle().clone()),
        ) {
            Ok(response) => panic!(
                "unbounded policy prefetch unexpectedly returned {}",
                response.status
            ),
            Err(response) => response,
        };
        let body = String::from_utf8(response.body).expect("error body is utf8");
        assert!(
            body.contains("provider_response_buffer_limit")
                || body.contains("provider_sse_staging_limit"),
            "{body}"
        );
        provider_thread.join().expect("provider thread");
        std::fs::remove_file(provider_config).ok();
    }

    #[test]
    fn streaming_retry_same_retries_the_same_provider_before_reselecting() {
        let first_provider = TcpListener::bind("127.0.0.1:0").expect("first provider listener");
        let first_address = first_provider.local_addr().expect("first provider address");
        let first_thread = std::thread::spawn(move || {
            let (mut stream, _) = first_provider.accept().expect("first provider accepts");
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body = br#"{"error":{"message":"temporary failure"}}"#;
            write!(
                stream,
                "HTTP/1.1 500 Internal Server Error\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            )
            .expect("first provider headers");
            stream.write_all(body).expect("first provider body");
            let (mut stream, _) = first_provider.accept().expect("first provider retries");
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body = concat!(
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_retry_same\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"mock-model\",\"output\":[]}}\n\n"
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            )
            .expect("first provider retry headers");
            stream
                .write_all(body.as_bytes())
                .expect("first provider retry body");
        });
        let second_provider = TcpListener::bind("127.0.0.1:0").expect("second provider listener");
        let second_address = second_provider
            .local_addr()
            .expect("second provider address");
        let first_config = std::env::temp_dir().join(format!(
            "v4-provider-retry-first-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let second_config = std::env::temp_dir().join(format!(
            "v4-provider-retry-second-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::write(
            &first_config,
            format!(
                r#"
providerId = "first"

[provider]
baseURL = "http://{first_address}"
defaultModel = "mock-model"
type = "responses"
responsesContinuation = "direct"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("first provider config");
        std::fs::write(
            &second_config,
            format!(
                r#"
providerId = "second"

[provider]
baseURL = "http://{second_address}"
defaultModel = "mock-model"
type = "responses"
responsesContinuation = "direct"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("second provider config");
        let manifest = runtime_manifest_with_two_provider_configs(
            first_config.to_str().expect("first provider config path"),
            second_config.to_str().expect("second provider config path"),
        );
        let runtime = Arc::new(Mutex::new(runtime_from_manifest(&manifest)));
        let availability = Arc::new(Mutex::new(V4Availability01SessionScoped::new()));
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            headers: Vec::new(),
            body: br#"{"model":"mock-model","input":"hello","stream":true}"#.to_vec(),
            request_id: "production-retry-same".to_string(),
            server_id: "rccv4".to_string(),
            port: 5520,
        };

        let provider_runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("provider runtime");
        let response = match dispatch_with_request_cancellation(
            &manifest,
            &runtime,
            &availability,
            &request,
            "responses",
            "direct",
            None,
            None,
            Some(provider_runtime.handle().clone()),
        ) {
            Ok(response) => response,
            Err(response) => panic!(
                "production retry dispatch failed with {}: {}",
                response.status,
                String::from_utf8_lossy(&response.body)
            ),
        };
        assert_eq!(response.status, 200);
        first_thread.join().expect("first provider thread");
        second_provider
            .set_nonblocking(true)
            .expect("second provider nonblocking");
        assert!(
            second_provider.accept().is_err(),
            "retry_same success must not call the second provider"
        );
        std::fs::remove_file(first_config).ok();
        std::fs::remove_file(second_config).ok();
    }

    #[test]
    fn streaming_503_reselects_without_consuming_same_candidate_retry() {
        let first_provider = TcpListener::bind("127.0.0.1:0").expect("first provider listener");
        let first_address = first_provider.local_addr().expect("first provider address");
        let first_thread = std::thread::spawn(move || {
            let (mut stream, _) = first_provider.accept().expect("first provider accepts");
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body = br#"{"error":{"message":"overloaded"}}"#;
            write!(
                stream,
                "HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            )
            .expect("first provider headers");
            stream.write_all(body).expect("first provider body");
            first_provider
                .set_nonblocking(true)
                .expect("first provider nonblocking");
            assert!(
                first_provider.accept().is_err(),
                "503 must not retry the same provider"
            );
        });
        let second_provider = TcpListener::bind("127.0.0.1:0").expect("second provider listener");
        let second_address = second_provider
            .local_addr()
            .expect("second provider address");
        let second_thread = std::thread::spawn(move || {
            let (mut stream, _) = second_provider.accept().expect("second provider accepts");
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body = concat!(
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_reselect\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"mock-model\",\"output\":[]}}\n\n"
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            )
            .expect("second provider headers");
            stream
                .write_all(body.as_bytes())
                .expect("second provider body");
        });
        let first_config = std::env::temp_dir().join(format!(
            "v4-provider-503-first-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let second_config = std::env::temp_dir().join(format!(
            "v4-provider-503-second-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::write(
            &first_config,
            format!(
                r#"
providerId = "first"

[provider]
baseURL = "http://{first_address}"
defaultModel = "mock-model"
type = "responses"
responsesContinuation = "direct"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("first provider config");
        std::fs::write(
            &second_config,
            format!(
                r#"
providerId = "second"

[provider]
baseURL = "http://{second_address}"
defaultModel = "mock-model"
type = "responses"
responsesContinuation = "direct"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("second provider config");
        let manifest = runtime_manifest_with_two_provider_configs(
            first_config.to_str().expect("first provider config path"),
            second_config.to_str().expect("second provider config path"),
        );
        let runtime = Arc::new(Mutex::new(runtime_from_manifest(&manifest)));
        let availability = Arc::new(Mutex::new(V4Availability01SessionScoped::new()));
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            headers: Vec::new(),
            body: br#"{"model":"mock-model","input":"hello","stream":true}"#.to_vec(),
            request_id: "production-503-reselect".to_string(),
            server_id: "rccv4".to_string(),
            port: 5520,
        };

        let provider_runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("provider runtime");
        let response = match dispatch_with_request_cancellation(
            &manifest,
            &runtime,
            &availability,
            &request,
            "responses",
            "direct",
            None,
            None,
            Some(provider_runtime.handle().clone()),
        ) {
            Ok(response) => response,
            Err(response) => panic!(
                "503 reselect dispatch failed with {}: {}",
                response.status,
                String::from_utf8_lossy(&response.body)
            ),
        };
        assert_eq!(response.status, 200);
        first_thread.join().expect("first provider thread");
        second_thread.join().expect("second provider thread");
        std::fs::remove_file(first_config).ok();
        std::fs::remove_file(second_config).ok();
    }

    #[test]
    fn streaming_incomplete_reselects_before_client_projection() {
        let provider = TcpListener::bind("127.0.0.1:0").expect("provider listener");
        let provider_address = provider.local_addr().expect("provider address");
        let provider_thread = std::thread::spawn(move || {
            let (mut stream, _) = provider.accept().expect("provider accepts");
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body = concat!(
                "event: response.output_text.delta\n",
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n",
                "event: response.incomplete\n",
                "data: {\"type\":\"response.incomplete\",\"response\":{\"id\":\"resp_incomplete\",\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"},\"usage\":{\"input_tokens\":3,\"output_tokens\":2,\"total_tokens\":5}}}\n\n"
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            )
            .expect("provider headers");
            stream.write_all(body.as_bytes()).expect("provider body");
        });
        let provider_config = std::env::temp_dir().join(format!(
            "v4-provider-incomplete-v3-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::write(
            &provider_config,
            format!(
                r#"
providerId = "mock"

[provider]
baseURL = "http://{provider_address}"
defaultModel = "mock-model"
type = "responses"
responsesContinuation = "direct"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("provider config");
        let second_provider = TcpListener::bind("127.0.0.1:0").expect("second provider listener");
        let second_address = second_provider
            .local_addr()
            .expect("second provider address");
        let second_thread = std::thread::spawn(move || {
            let (mut stream, _) = second_provider.accept().expect("second provider accepts");
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body = concat!(
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_after_incomplete\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"mock-model\",\"output\":[]}}\n\n"
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            )
            .expect("second provider headers");
            stream
                .write_all(body.as_bytes())
                .expect("second provider body");
        });
        let second_config = std::env::temp_dir().join(format!(
            "v4-provider-incomplete-second-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::write(
            &second_config,
            format!(
                r#"
providerId = "second"

[provider]
baseURL = "http://{second_address}"
defaultModel = "mock-model"
type = "responses"
responsesContinuation = "direct"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("second provider config");
        let manifest = runtime_manifest_with_two_provider_configs(
            provider_config.to_str().expect("provider config path"),
            second_config.to_str().expect("second provider config path"),
        );
        let runtime = Arc::new(Mutex::new(runtime_from_manifest(&manifest)));
        let availability = Arc::new(Mutex::new(V4Availability01SessionScoped::new()));
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            headers: Vec::new(),
            body: br#"{"model":"mock-model","input":"hello","stream":true}"#.to_vec(),
            request_id: "production-incomplete-v3".to_string(),
            server_id: "rccv4".to_string(),
            port: 5520,
        };
        let provider_runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("provider runtime");
        let mut response = match dispatch_with_request_cancellation(
            &manifest,
            &runtime,
            &availability,
            &request,
            "responses",
            "direct",
            None,
            None,
            Some(provider_runtime.handle().clone()),
        ) {
            Ok(response) => response,
            Err(response) => panic!(
                "incomplete reselect dispatch failed with {}: {}",
                response.status,
                String::from_utf8_lossy(&response.body)
            ),
        };
        assert_eq!(response.status, 200);
        let mut stream = response.stream.take().expect("incomplete reselect stream");
        let mut chunk = Vec::new();
        assert!(stream
            .next_chunk(&mut chunk)
            .expect("incomplete reselect chunk"));
        let body = String::from_utf8_lossy(&chunk);
        assert!(body.contains("resp_after_incomplete"), "{body}");
        assert!(!body.contains("partial-must-not-commit"), "{body}");
        provider_thread.join().expect("provider thread");
        second_thread.join().expect("second provider thread");
        std::fs::remove_file(provider_config).ok();
        std::fs::remove_file(second_config).ok();
    }

    #[test]
    fn streaming_incomplete_without_product_policy_fails_before_client_projection() {
        let provider = TcpListener::bind("127.0.0.1:0").expect("provider listener");
        let provider_address = provider.local_addr().expect("provider address");
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_by_provider = Arc::clone(&attempts);
        let provider_thread = std::thread::spawn(move || {
            let (mut stream, _) = provider.accept().expect("provider accepts");
            attempts_by_provider.fetch_add(1, Ordering::SeqCst);
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body = concat!(
                "event: response.output_text.delta\n",
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial-must-not-commit\"}\n\n",
                "event: response.incomplete\n",
                "data: {\"type\":\"response.incomplete\",\"response\":{\"id\":\"resp_incomplete\",\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"}}}\n\n"
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            )
            .expect("provider headers");
            stream.write_all(body.as_bytes()).expect("provider body");
        });
        let provider_config = std::env::temp_dir().join(format!(
            "v4-provider-incomplete-no-policy-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::write(
            &provider_config,
            format!(
                r#"
providerId = "mock"

[provider]
baseURL = "http://{provider_address}"
defaultModel = "mock-model"
type = "responses"
responsesContinuation = "direct"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("provider config");
        let manifest = runtime_manifest_with_provider_config(
            provider_config.to_str().expect("provider config path"),
        );
        let runtime = Arc::new(Mutex::new(runtime_from_manifest(&manifest)));
        let availability = Arc::new(Mutex::new(V4Availability01SessionScoped::new()));
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            headers: Vec::new(),
            body: br#"{"model":"mock-model","input":"hello","stream":true}"#.to_vec(),
            request_id: "production-incomplete-no-policy".to_string(),
            server_id: "rccv4".to_string(),
            port: 5520,
        };
        let provider_runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("provider runtime");
        let response = match dispatch_with_request_cancellation(
            &manifest,
            &runtime,
            &availability,
            &request,
            "responses",
            "direct",
            None,
            None,
            Some(provider_runtime.handle().clone()),
        ) {
            Ok(_) => panic!("incomplete provider attempt must not become a success response"),
            Err(response) => response,
        };
        assert_eq!(response.status, 599);
        let body = String::from_utf8_lossy(&response.body);
        assert!(
            body.contains("provider_response_incomplete_max_output_tokens"),
            "incomplete terminal must fail before client projection: {body}"
        );
        assert!(!body.contains("partial-must-not-commit"), "{body}");
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            1,
            "single-provider incomplete exhaustion must not retry itself"
        );
        provider_thread.join().expect("provider thread");
        std::fs::remove_file(provider_config).ok();
    }

    #[test]
    fn streaming_provider_eof_without_terminal_reselects_before_client_projection() {
        let first_provider = TcpListener::bind("127.0.0.1:0").expect("first provider listener");
        let first_address = first_provider.local_addr().expect("first provider address");
        let first_attempts = Arc::new(AtomicUsize::new(0));
        let first_attempts_by_provider = Arc::clone(&first_attempts);
        let first_thread = std::thread::spawn(move || {
            let (mut stream, _) = first_provider.accept().expect("first provider accepts");
            first_attempts_by_provider.fetch_add(1, Ordering::SeqCst);
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body = concat!(
                "event: response.output_text.delta\n",
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial-must-not-commit\"}\n\n"
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            )
            .expect("first provider headers");
            stream
                .write_all(body.as_bytes())
                .expect("first provider body");
        });
        let second_provider = TcpListener::bind("127.0.0.1:0").expect("second provider listener");
        let second_address = second_provider
            .local_addr()
            .expect("second provider address");
        let second_thread = std::thread::spawn(move || {
            let (mut stream, _) = second_provider.accept().expect("second provider accepts");
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body = concat!(
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_success\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"mock-model\",\"output\":[]}}\n\n"
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            )
            .expect("second provider headers");
            stream
                .write_all(body.as_bytes())
                .expect("second provider body");
        });
        let first_config = std::env::temp_dir().join(format!(
            "v4-provider-eof-first-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let second_config = std::env::temp_dir().join(format!(
            "v4-provider-eof-second-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::write(
            &first_config,
            format!(
                r#"
providerId = "first"

[provider]
baseURL = "http://{first_address}"
defaultModel = "mock-model"
type = "responses"
responsesContinuation = "direct"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("first provider config");
        std::fs::write(
            &second_config,
            format!(
                r#"
providerId = "second"

[provider]
baseURL = "http://{second_address}"
defaultModel = "mock-model"
type = "responses"
responsesContinuation = "direct"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("second provider config");
        let manifest = runtime_manifest_with_two_provider_configs(
            first_config.to_str().expect("first provider config path"),
            second_config.to_str().expect("second provider config path"),
        );
        let runtime = Arc::new(Mutex::new(runtime_from_manifest(&manifest)));
        let availability = Arc::new(Mutex::new(V4Availability01SessionScoped::new()));
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            headers: Vec::new(),
            body: br#"{"model":"mock-model","input":"hello","stream":true}"#.to_vec(),
            request_id: "production-eof-reselect".to_string(),
            server_id: "rccv4".to_string(),
            port: 5520,
        };

        let provider_runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("provider runtime");
        let mut response = match dispatch_with_request_cancellation(
            &manifest,
            &runtime,
            &availability,
            &request,
            "responses",
            "direct",
            None,
            None,
            Some(provider_runtime.handle().clone()),
        ) {
            Ok(response) => response,
            Err(response) => panic!(
                "EOF reselect dispatch failed with {}: {}",
                response.status,
                String::from_utf8_lossy(&response.body)
            ),
        };
        assert_eq!(response.status, 200);
        let mut stream = response.stream.take().expect("EOF reselect stream");
        let mut chunk = Vec::new();
        assert!(
            stream.next_chunk(&mut chunk).expect("EOF reselect chunk"),
            "EOF reselect stream must produce a client frame"
        );
        let body = String::from_utf8_lossy(&chunk);
        assert!(
            body.contains("resp_success"),
            "missing success response: {body}; first_attempts={}",
            first_attempts.load(Ordering::SeqCst)
        );
        assert!(!body.contains("partial-must-not-commit"), "{body}");
        assert_eq!(
            first_attempts.load(Ordering::SeqCst),
            1,
            "EOF without terminal must not retry the same provider"
        );
        first_thread.join().expect("first provider thread");
        second_thread.join().expect("second provider thread");
        std::fs::remove_file(first_config).ok();
        std::fs::remove_file(second_config).ok();
    }

    #[test]
    fn streaming_retry_same_max_attempts_one_reselects_without_same_provider_retry() {
        let first_provider = TcpListener::bind("127.0.0.1:0").expect("first provider listener");
        let first_address = first_provider.local_addr().expect("first provider address");
        let first_retry_seen = Arc::new(AtomicBool::new(false));
        let first_retry_seen_by_provider = first_retry_seen.clone();
        let first_thread = std::thread::spawn(move || {
            let (mut stream, _) = first_provider.accept().expect("first provider accepts");
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body = br#"{"error":{"message":"temporary failure"}}"#;
            write!(
                stream,
                "HTTP/1.1 500 Internal Server Error\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            )
            .expect("first provider headers");
            stream.write_all(body).expect("first provider body");

            first_provider
                .set_nonblocking(true)
                .expect("first provider nonblocking");
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while std::time::Instant::now() < deadline {
                match first_provider.accept() {
                    Ok((mut stream, _)) => {
                        first_retry_seen_by_provider.store(true, Ordering::SeqCst);
                        let mut request = [0u8; 8192];
                        let _ = stream.read(&mut request);
                        let body = concat!(
                            "event: response.completed\n",
                            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_wrong_same_retry\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"mock-model\",\"output\":[]}}\n\n"
                        );
                        write!(
                            stream,
                            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                            body.len()
                        )
                        .expect("first provider retry headers");
                        stream
                            .write_all(body.as_bytes())
                            .expect("first provider retry body");
                        return;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                    Err(error) => panic!("first provider accept failed: {error}"),
                }
            }
        });
        let second_provider = TcpListener::bind("127.0.0.1:0").expect("second provider listener");
        let second_address = second_provider
            .local_addr()
            .expect("second provider address");
        let second_thread = std::thread::spawn(move || {
            let (mut stream, _) = second_provider.accept().expect("second provider accepts");
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body = concat!(
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_budget_one_reselect\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"mock-model\",\"output\":[]}}\n\n"
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            )
            .expect("second provider headers");
            stream
                .write_all(body.as_bytes())
                .expect("second provider body");
        });
        let first_config = std::env::temp_dir().join(format!(
            "v4-provider-budget-one-first-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let second_config = std::env::temp_dir().join(format!(
            "v4-provider-budget-one-second-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::write(
            &first_config,
            format!(
                r#"
providerId = "first"

[provider]
baseURL = "http://{first_address}"
defaultModel = "mock-model"
type = "responses"
responsesContinuation = "direct"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("first provider config");
        std::fs::write(
            &second_config,
            format!(
                r#"
providerId = "second"

[provider]
baseURL = "http://{second_address}"
defaultModel = "mock-model"
type = "responses"
responsesContinuation = "direct"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("second provider config");
        let mut manifest = runtime_manifest_with_two_provider_configs(
            first_config.to_str().expect("first provider config path"),
            second_config.to_str().expect("second provider config path"),
        );
        manifest
            .product
            .as_mut()
            .expect("product config")
            .default_error_path[0]
            .max_attempts = Some(1);
        let runtime = Arc::new(Mutex::new(runtime_from_manifest(&manifest)));
        let availability = Arc::new(Mutex::new(V4Availability01SessionScoped::new()));
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            headers: Vec::new(),
            body: br#"{"model":"mock-model","input":"hello","stream":true}"#.to_vec(),
            request_id: "production-budget-one-reselect".to_string(),
            server_id: "rccv4".to_string(),
            port: 5520,
        };

        let provider_runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("provider runtime");
        let response = match dispatch_with_request_cancellation(
            &manifest,
            &runtime,
            &availability,
            &request,
            "responses",
            "direct",
            None,
            None,
            Some(provider_runtime.handle().clone()),
        ) {
            Ok(response) => response,
            Err(response) => panic!(
                "max_attempts=1 reselect dispatch failed with {}: {}",
                response.status,
                String::from_utf8_lossy(&response.body)
            ),
        };
        assert_eq!(response.status, 200);
        first_thread.join().expect("first provider thread");
        second_thread.join().expect("second provider thread");
        assert!(
            !first_retry_seen.load(Ordering::SeqCst),
            "max_attempts=1 must not retry the same provider"
        );
        std::fs::remove_file(first_config).ok();
        std::fs::remove_file(second_config).ok();
    }

    #[test]
    fn streaming_reselect_budget_is_bounded_by_candidate_pool_not_max_attempts() {
        let first_provider = TcpListener::bind("127.0.0.1:0").expect("first provider listener");
        let first_address = first_provider.local_addr().expect("first provider address");
        let first_thread = std::thread::spawn(move || {
            let (mut stream, _) = first_provider.accept().expect("first provider accepts");
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body = br#"{"error":{"message":"first failed"}}"#;
            write!(
                stream,
                "HTTP/1.1 500 Internal Server Error\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            )
            .expect("first provider headers");
            stream.write_all(body).expect("first provider body");
        });
        let second_provider = TcpListener::bind("127.0.0.1:0").expect("second provider listener");
        let second_address = second_provider
            .local_addr()
            .expect("second provider address");
        let second_thread = std::thread::spawn(move || {
            let (mut stream, _) = second_provider.accept().expect("second provider accepts");
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body = br#"{"error":{"message":"second failed"}}"#;
            write!(
                stream,
                "HTTP/1.1 500 Internal Server Error\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            )
            .expect("second provider headers");
            stream.write_all(body).expect("second provider body");
        });
        let first_config = std::env::temp_dir().join(format!(
            "v4-provider-reselect-pool-first-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let second_config = std::env::temp_dir().join(format!(
            "v4-provider-reselect-pool-second-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::write(
            &first_config,
            format!(
                r#"
providerId = "first"

[provider]
baseURL = "http://{first_address}"
defaultModel = "mock-model"
type = "responses"
responsesContinuation = "direct"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("first provider config");
        std::fs::write(
            &second_config,
            format!(
                r#"
providerId = "second"

[provider]
baseURL = "http://{second_address}"
defaultModel = "mock-model"
type = "responses"
responsesContinuation = "direct"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("second provider config");
        let mut manifest = runtime_manifest_with_two_provider_configs(
            first_config.to_str().expect("first provider config path"),
            second_config.to_str().expect("second provider config path"),
        );
        let product = manifest.product.as_mut().expect("product config");
        product.default_error_path[0].retry_mode =
            Some("reselect_before_client_projection".to_string());
        product.default_error_path[0].max_attempts = Some(1);
        product.default_error_path[0].backoff_ms = Some(0);
        product.default_error_path[2].reason_code = Some("provider_failure".to_string());
        let runtime = Arc::new(Mutex::new(runtime_from_manifest(&manifest)));
        let availability = Arc::new(Mutex::new(V4Availability01SessionScoped::new()));
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            headers: Vec::new(),
            body: br#"{"model":"mock-model","input":"hello","stream":true}"#.to_vec(),
            request_id: "production-reselect-pool-budget".to_string(),
            server_id: "rccv4".to_string(),
            port: 5520,
        };

        let provider_runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("provider runtime");
        let response = match dispatch_with_request_cancellation(
            &manifest,
            &runtime,
            &availability,
            &request,
            "responses",
            "direct",
            None,
            None,
            Some(provider_runtime.handle().clone()),
        ) {
            Ok(response) => response,
            Err(response) => response,
        };
        assert_eq!(response.status, 503);
        first_thread.join().expect("first provider thread");
        second_thread.join().expect("second provider thread");
        std::fs::remove_file(first_config).ok();
        std::fs::remove_file(second_config).ok();
    }

    #[test]
    fn streaming_retry_same_exhaustion_terminates_without_an_alternate() {
        let provider = TcpListener::bind("127.0.0.1:0").expect("provider listener");
        let provider_address = provider.local_addr().expect("provider address");
        let provider_thread = std::thread::spawn(move || {
            for attempt in 0..3 {
                let (mut stream, _) = provider.accept().expect("provider accepts");
                let mut request = [0u8; 8192];
                let _ = stream.read(&mut request);
                let body = format!(r#"{{"error":{{"message":"failure {attempt}"}}}}"#);
                write!(
                    stream,
                    "HTTP/1.1 500 Internal Server Error\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                )
                .expect("provider headers");
                stream.write_all(body.as_bytes()).expect("provider body");
            }
        });
        let provider_config = std::env::temp_dir().join(format!(
            "v4-provider-retry-exhaustion-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::write(
            &provider_config,
            format!(
                r#"
providerId = "mock"

[provider]
baseURL = "http://{provider_address}"
defaultModel = "mock-model"
type = "responses"
responsesContinuation = "direct"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("provider config");
        let manifest = runtime_manifest_with_provider_config(
            provider_config.to_str().expect("provider config path"),
        );
        let mut manifest = manifest;
        manifest
            .product
            .as_mut()
            .expect("product config")
            .default_error_path = vec![
            routecodex_v4_config::RuntimeProductPolicyAction {
                step: "wait_retry".to_string(),
                retry_mode: Some("retry_same".to_string()),
                max_attempts: Some(3),
                backoff_ms: Some(0),
                scope: None,
                duration_ms: None,
                provider_global_failure: None,
                status: None,
                reason_code: None,
                public_code: None,
                message_mode: None,
            },
            routecodex_v4_config::RuntimeProductPolicyAction {
                step: "project".to_string(),
                retry_mode: None,
                max_attempts: None,
                backoff_ms: None,
                scope: None,
                duration_ms: None,
                provider_global_failure: None,
                status: Some(503),
                reason_code: Some("provider_failure".to_string()),
                public_code: None,
                message_mode: Some("code_only".to_string()),
            },
        ];
        let runtime = Arc::new(Mutex::new(runtime_from_manifest(&manifest)));
        let availability = Arc::new(Mutex::new(V4Availability01SessionScoped::new()));
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            headers: Vec::new(),
            body: br#"{"model":"mock-model","input":"hello","stream":true}"#.to_vec(),
            request_id: "production-retry-exhaustion".to_string(),
            server_id: "rccv4".to_string(),
            port: 5520,
        };

        let provider_runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("provider runtime");
        let response = match dispatch_with_request_cancellation(
            &manifest,
            &runtime,
            &availability,
            &request,
            "responses",
            "direct",
            None,
            None,
            Some(provider_runtime.handle().clone()),
        ) {
            Ok(response) => response,
            Err(response) => response,
        };
        assert_eq!(response.status, 503);
        provider_thread.join().expect("provider thread");
        std::fs::remove_file(provider_config).ok();
    }

    fn runtime_manifest() -> RuntimeConfigManifest {
        runtime_manifest_with_provider_config("providers/mock.toml")
    }

    fn runtime_manifest_with_two_provider_configs(
        first_config_path: &str,
        second_config_path: &str,
    ) -> RuntimeConfigManifest {
        let manifest = compile_runtime_config(
            &format!(
                r#"
version = 4

[runtime]
id = "rccv4"

[[listeners]]
id = "primary"
address = "127.0.0.1:5520"

[[providers]]
provider_id = "first"
config_path = "{first_config_path}"
protocol = "responses"
wire_model = "mock-model"
priority = 2
entry_models = ["mock-model"]

[[providers]]
provider_id = "second"
config_path = "{second_config_path}"
protocol = "responses"
wire_model = "mock-model"
priority = 1
entry_models = ["mock-model"]

[[routes]]
id = "default"
models = ["mock-model"]
targets = ["first", "second"]

[product]
source = "provider-retry-test"

default_error_path = [
  {{ step = "wait_retry", retry_mode = "retry_same", max_attempts = 3, backoff_ms = 0 }},
  {{ step = "cooldown", scope = "provider_model", duration_ms = 900000 }},
  {{ step = "project", status = 503, reason_code = "provider_failure", message_mode = "code_only" }},
]

[[product.providers]]
provider_id = "first"
protocol = "responses"
config_path = "{first_config_path}"

[[product.providers.models]]
model_id = "mock-model"
wire_name = "mock-model"

[[product.providers]]
provider_id = "second"
protocol = "responses"
config_path = "{second_config_path}"

[[product.providers.models]]
model_id = "mock-model"
wire_name = "mock-model"

[[product.route_groups]]
route_group_id = "default"

[[product.route_groups.pools]]
pool_id = "default"
selection = "priority"

[[product.route_groups.pools.targets]]
provider_id = "first"
model_id = "mock-model"
priority = 2

[[product.route_groups.pools.targets]]
provider_id = "second"
model_id = "mock-model"
priority = 1
"#
            ),
            None,
        )
        .expect("two-provider runtime config compiles");
        manifest.verify().expect("two-provider manifest verifies");
        manifest
    }

    fn runtime_manifest_with_provider_config(config_path: &str) -> RuntimeConfigManifest {
        let manifest = compile_runtime_config(
            &format!(
                r#"
version = 4

[runtime]
id = "rccv4"

[[listeners]]
id = "primary"
address = "127.0.0.1:5520"

[[providers]]
provider_id = "mock"
config_path = "{config_path}"
protocol = "responses"
wire_model = "mock-model"
priority = 1
entry_models = ["mock-model"]

[[routes]]
id = "default"
models = ["mock-model"]
targets = ["mock"]

[product]
source = "admission-lock-test"

[[product.providers]]
provider_id = "mock"
protocol = "responses"
config_path = "{config_path}"

[[product.providers.models]]
model_id = "mock-model"
wire_name = "mock-model"

[[product.route_groups]]
route_group_id = "default"

[[product.route_groups.pools]]
pool_id = "default"
selection = "priority"

[[product.route_groups.pools.targets]]
provider_id = "mock"
model_id = "mock-model"
priority = 1
"#
            ),
            None,
        )
        .expect("test runtime config compiles");
        manifest.verify().expect("test manifest verifies");
        manifest
    }

    fn runtime_manifest_with_provider_config_and_200_project(
        config_path: &str,
    ) -> RuntimeConfigManifest {
        let manifest = compile_runtime_config(
            &format!(
                r#"
version = 4

[runtime]
id = "rccv4"

[[listeners]]
id = "primary"
address = "127.0.0.1:5520"

[[providers]]
provider_id = "mock"
config_path = "{config_path}"
protocol = "responses"
wire_model = "mock-model"
priority = 1
entry_models = ["mock-model"]

[[routes]]
id = "default"
models = ["mock-model"]
targets = ["mock"]

[product]
source = "streaming-200-semantic-policy"

[[product.error_policies]]
policy_id = "mock_invalid_field_type_200"
scope_provider_id = "mock"
match_status = 200
match_content_contains_any = ["Type invalid, should be set"]
reason_code = "provider_invalid_field_type"

[[product.error_policies.actions]]
step = "project"
status = 400
reason_code = "provider_invalid_field_type"
public_code = "provider_invalid_field_type"
message_mode = "code_only"

[[product.providers]]
provider_id = "mock"
protocol = "responses"
config_path = "{config_path}"

[[product.providers.models]]
model_id = "mock-model"
wire_name = "mock-model"

[[product.route_groups]]
route_group_id = "default"

[[product.route_groups.pools]]
pool_id = "default"
selection = "priority"

[[product.route_groups.pools.targets]]
provider_id = "mock"
model_id = "mock-model"
priority = 1
"#
            ),
            None,
        )
        .expect("streaming-200 semantic policy runtime config compiles");
        manifest
            .verify()
            .expect("streaming-200 semantic policy manifest verifies");
        manifest
    }

    fn runtime_from_manifest(manifest: &RuntimeConfigManifest) -> SkeletonRuntime {
        let runtime = SkeletonRuntime::from_compiled_plan_with_registry(
            manifest.execution_epoch.skeleton.clone(),
            Arc::new(TestHandleRegistry::new(manifest)),
        )
        .expect("test runtime loads compiled plan");
        let transaction_id = "admission-lock-red";
        runtime
            .prepare_compiled_execution_epoch(
                transaction_id,
                0,
                routecodex_v4_node_container::ZERO_BASE_MANIFEST_HASH,
                &manifest.execution_epoch.candidate,
                &manifest.execution_epoch.graph_hash,
                &manifest.execution_epoch.manifest_hash,
            )
            .expect("test epoch prepares");
        runtime
            .commit_execution_epoch(transaction_id)
            .expect("test epoch commits");
        runtime
    }
}
