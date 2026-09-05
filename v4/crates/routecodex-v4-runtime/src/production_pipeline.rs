//! Runtime-owned production request/response pipeline.
//!
//! The binary owns listener and lifecycle adaptation only. Protocol semantics,
//! routing, provider transport, error projection, response framing, and console
//! projection live here behind the typed runtime owner.

use crate::{
    ResponseStreamProcessor, RuntimeFault, SkeletonRuntime, SseTransportDriver,
};
use routecodex_v4_config::RuntimeConfigManifest;
use routecodex_v4_provider::{
    ProviderTransportError, ProviderTransportPort, ProviderTransportRequest,
    ProviderTransportResult, V4Availability01SessionScoped,
};
use routecodex_v4_router::{ProductErrorPolicyPort, TargetSelectionRequest};
use routecodex_v4_server::{HttpRequest, HttpResponse};
use routecodex_v4_standard_plugins::diagnostic;
use serde_json::Value;
use std::io::Write;
use std::sync::{Arc, Mutex};

// HTTP/error projection is owned by `response_error_port`; these re-exports
// preserve the public adapter surface for the listener without retaining a
// second implementation in the production pipeline.
pub use crate::response_error_port::{
    project_http_fault as project_fault,
    project_provider_http_fault as project_upstream_fault,
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
    dispatch_request(
        manifest,
        runtime,
        availability,
        request,
        entry_protocol,
        continuation_owner,
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

fn dispatch_request(
    manifest: &RuntimeConfigManifest,
    runtime: &Arc<Mutex<SkeletonRuntime>>,
    availability: &Arc<Mutex<V4Availability01SessionScoped>>,
    request: &HttpRequest,
    entry_protocol: &str,
    continuation_owner: &str,
) -> Result<HttpResponse, HttpResponse> {
    let started_at = std::time::Instant::now();
    let session_scope = request
        .header("x-rccv4-session-id")
        .unwrap_or(&request.request_id);
    let conversation_scope = request
        .header("x-rccv4-conversation-id")
        .unwrap_or(session_scope);
    let continuation_owner = if entry_protocol == "responses" {
        // V4 retains only provider-owned Direct Responses continuation.
        // Local/relay continuation is retired and must never be inferred from
        // provider profile configuration.
        "direct".to_string()
    } else {
        continuation_owner.to_string()
    };
    let request_id = request.request_id.clone();
    let request_lease = runtime
        .lock()
        .map_err(|_| {
            project_fault(
                request,
                RuntimeFault::new("request_runtime_lock", "request runtime lock poisoned"),
                500,
            )
        })?
        .admit_request(&request_id)
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
    let project_upstream_fault = |
        request: &HttpRequest,
        fault: RuntimeFault,
        status: u16,
        product: Option<&routecodex_v4_config::RuntimeProductConfig>,
        provider_id: &str,
        response_body: &str,
    | -> HttpResponse {
        match runtime.lock() {
            Ok(runtime) => crate::response_error_port::project_provider_http_fault_with_runtime(
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
    let admission = runtime
        .lock()
        .map_err(|_| {
            project_fault(
                request,
                RuntimeFault::new("request_runtime_lock", "request runtime lock poisoned"),
                500,
            )
        })?
        .execute_request_admission_with_lease(
            &request.body,
            entry_protocol,
            &continuation_owner,
            &request_lease,
        )
        .map_err(|fault| project_fault(request, fault, 400))?;
    let model = admission.model.as_str();
    let stream_mode = admission.stream;
    let mut selection_request = TargetSelectionRequest::new(
        request
            .header("x-rccv4-route-group-id")
            .map(str::to_string),
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
    let unavailable_provider_ids = {
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
    let mut target = runtime
        .lock()
        .map_err(|_| {
            project_fault(
                request,
                RuntimeFault::new("request_runtime_lock", "request runtime lock poisoned"),
                500,
            )
        })?
        .execute_target_selection_with_lease(
            &request_lease,
            request.port,
            session_scope,
            conversation_scope,
            &selection_request,
        )
        .map_err(|error| {
        let status = if !unavailable_provider_ids.is_empty()
            && error.code == "target_selection" {
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
    let route_facts = selection_request.to_route_facts_value();
    let target_selection = target.to_control_value(&selection_request.execution_lane);
    let request_report = runtime
        .lock()
        .map_err(|_| {
            project_fault(
                request,
                RuntimeFault::new("request_runtime_lock", "request runtime lock poisoned"),
                500,
            )
        })?
        .execute_request_json_scoped_for_target_with_route_facts_and_lease(
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
    let execute_request_plan = |target: &routecodex_v4_router::SelectedTarget,
                                stream: bool,
                                route_facts: Value,
                                execution_lane: &str|
     -> Result<Value, RuntimeFault> {
        let target_selection = target.to_control_value(execution_lane);
        let report = runtime
            .lock()
            .map_err(|_| RuntimeFault::new("request_runtime_lock", "request runtime lock poisoned"))?
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
    let execute_transport = |target: &routecodex_v4_router::SelectedTarget,
                             wire_body: &Value,
                             stream: bool|
     -> Result<ProviderTransportResult, ProviderTransportError> {
        let request = ProviderTransportRequest::new(
            &target.protocol,
            &target.config_path,
            target.auth_alias.as_deref(),
            &target.wire_model,
            wire_body.clone(),
            stream,
        )?;
        ProviderTransportPort::execute(request)
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
    if stream_mode {
        let mut stream = match execute_transport(&target, &wire_body, true).map_err(|error| {
            project_fault(
                request,
                RuntimeFault::new(error.code.as_str(), error.message)
                    .with_status(error.status.unwrap_or(502)),
                error.status.unwrap_or(502),
            )
        })? {
            ProviderTransportResult::Stream(stream) => stream,
            ProviderTransportResult::Response(_) => {
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
        if stream.status() >= 400 {
            if let Some(product) = manifest.product.as_ref() {
                if let Some(policy) =
                    ProductErrorPolicyPort::evaluate(product, &target.provider_id, stream.status(), "")
                {
                    record_provider_failure(
                        &target.provider_id,
                        policy.cooldown,
                        policy.failure_threshold,
                    )?;
                    if policy.retry {
                        let mut excluded = unavailable_provider_ids.clone();
                        excluded.push(target.provider_id.clone());
                        selection_request.unavailable_provider_ids = excluded;
                        let candidate = runtime
                            .lock()
                            .map_err(|_| {
                                project_fault(
                                    request,
                                    RuntimeFault::new(
                                        "request_runtime_lock",
                                        "request runtime lock poisoned",
                                    ),
                                    500,
                                )
                            })?
                            .execute_target_selection_with_lease(
                                &request_lease,
                                request.port,
                                session_scope,
                                conversation_scope,
                                &selection_request,
                            );
                        if let Ok(candidate) = candidate {
                            let retry_route_facts = selection_request.to_route_facts_value();
                            let retry_body = execute_request_plan(
                                &candidate,
                                true,
                                retry_route_facts,
                                &selection_request.execution_lane,
                            )
                                .map_err(|fault| project_fault(request, fault, 598))?;
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
                                    ProviderTransportResult::Stream(stream) => stream,
                                    ProviderTransportResult::Response(_) => {
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
                        }
                    }
                }
            }
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
                "",
            ));
        }
        if !stream
            .content_type()
            .to_ascii_lowercase()
            .contains("text/event-stream")
        {
            return Err(project_fault(
                request,
                RuntimeFault::new(
                    "provider_sse_content_type",
                    format!(
                        "streaming Responses returned unsupported content type {}",
                        stream.content_type()
                    ),
                ),
                502,
            ));
        }
        let client_status = if (200..300).contains(&status) {
            200
        } else {
            status
        };
        let _ = std::io::stdout().flush();
        let response_processor = ResponseStreamProcessor::new(
            request_lease,
            request_scope,
            request.port,
            entry_protocol,
            &target.protocol,
            &continuation_owner,
            session_scope,
            conversation_scope,
        )
        .map_err(|fault| crate::response_error_port::project_http_fault(request, fault, 599))?;
        let response_stream = SseTransportDriver::new(
            stream,
            Arc::clone(runtime),
            response_processor,
            request.clone(),
            target.provider_id.clone(),
            target.wire_model.clone(),
        );
        return Ok(HttpResponse::streaming(
            client_status,
            "text/event-stream",
            Box::new(response_stream),
        ));
    }
    let mut raw = match execute_transport(&target, &wire_body, false).map_err(|error| {
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
        ProviderTransportResult::Stream(_) => {
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
    let mut reselected = false;
    if manifest.product.is_some() {
        if let Some(policy) = matched_policy.as_ref() {
            record_provider_failure(
                &target.provider_id,
                policy.cooldown,
                policy.failure_threshold,
            )?;
            if policy.retry {
                let mut excluded = unavailable_provider_ids.clone();
                excluded.push(target.provider_id.clone());
                selection_request.unavailable_provider_ids = excluded;
                let candidate = runtime
                    .lock()
                    .map_err(|_| {
                        project_fault(
                            request,
                            RuntimeFault::new(
                                "request_runtime_lock",
                                "request runtime lock poisoned",
                            ),
                            500,
                        )
                    })?
                    .execute_target_selection_with_lease(
                        &request_lease,
                        request.port,
                        session_scope,
                        conversation_scope,
                        &selection_request,
                    );
                if let Ok(candidate) = candidate {
                    let retry_route_facts = selection_request.to_route_facts_value();
                    let retry_body = execute_request_plan(
                        &candidate,
                        false,
                        retry_route_facts,
                        &selection_request.execution_lane,
                    )
                        .map_err(|fault| project_fault(request, fault, 598))?;
                    target = candidate;
                    reselected = true;
                    raw = match execute_transport(&target, &retry_body, false).map_err(|error| {
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
                        ProviderTransportResult::Stream(_) => {
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
            }
        }
    }
    if raw.status >= 400 || (matched_policy.is_some() && !reselected) {
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
    if raw.content_type.to_ascii_lowercase().contains("text/event-stream") {
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
            let report = runtime
                .lock()
                .map_err(|_| {
                    project_fault(
                        request,
                        RuntimeFault::new(
                            "response_runtime_lock",
                            "response runtime lock poisoned",
                        ),
                        500,
                    )
                })?
                .execute_provider_response_scoped_for_target_with_lease(
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
                .map_err(|fault| project_fault(request, fault, 502))?;
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
            Ok(json_response(client_status, projected))
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
    for event in trace {
        if let Some(line) = render_payload_console_event(
            event, request, endpoint, provider, model, stream, status, elapsed,
        ) {
            println!("{line}");
            let _ = std::io::stdout().flush();
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
    let direct_hook = matches!(plugin_id, "v4.hook.direct.request" | "v4.hook.direct.response");
    if !(plugin_id.ends_with("payload_console_render") || direct_hook)
        || kind != "console.payload_ready" {
        return None;
    }
    // TTY diagnostics may prefix the payload summary with ANSI color codes.
    // Normalize only the diagnostic presentation carrier; never touch the
    // business payload or control side-channel.
    let message = message.trim_start_matches(|ch: char| ch == '\u{1b}' || ch == '[' || ch.is_ascii_digit() || ch == ';' || ch == 'm');
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
    use super::mark_provider_success_for_route;
    use routecodex_v4_provider::V4Availability01SessionScoped;

    #[test]
    fn provider_success_clears_only_the_selected_route_group() {
        let mut availability = V4Availability01SessionScoped::new();
        for route_group_id in ["first", "selected"] {
            availability
                .record_failure_for(
                    "5520",
                    Some(route_group_id),
                    "session",
                    "provider",
                    true,
                    1,
                )
                .expect("route-scoped failure records");
        }

        mark_provider_success_for_route(
            &mut availability,
            5520,
            "selected",
            "session",
            "provider",
        )
        .expect("selected route success clears its cooldown");

        assert!(!availability.is_eligible("5520", "first", "session", "provider"));
        assert!(availability.is_eligible("5520", "selected", "session", "provider"));
    }
}
