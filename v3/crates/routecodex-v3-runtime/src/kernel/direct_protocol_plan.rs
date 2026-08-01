pub fn plan_v3_responses_protocol_execution_with_provider_health(
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    provider_health: impl Into<V3ProviderFailureRuntimeHealth>,
    now_epoch_ms: u64,
) -> Result<V3ResponsesProtocolExecutionPlan, V3ResponsesProtocolExecutionPlanFailure> {
    let mut trace = vec!["V3Config05ManifestPublished", "V3Server03HttpRequestRaw"];
    let standardized = match build_v3_req_04_standardized_responses_from_v3_server_03(raw) {
        Ok(standardized) => standardized,
        Err(error) => {
            trace.push("V3Req04StandardizedResponses");
            return Err(protocol_plan_failure(
                runtime_source("V3Req04StandardizedResponses", error),
                trace,
            ))
        }
    };
    trace.push("V3Req04StandardizedResponses");
    if standardized.protocol_context.previous_response_id.is_some() {
        return Err(protocol_plan_failure(
            runtime_source(
                "V3HubReqContinuation03Classified",
                "protocol execution plan only handles non-continuation responses requests",
            ),
            trace,
        ));
    }
    let allowed_modes = match manifest
        .servers
        .get(&standardized.protocol_context.server_id)
        .and_then(|server| server.execution.as_ref())
    {
        Some(execution) => execution.allowed_modes.clone(),
        None => {
            return Err(protocol_plan_failure(
                runtime_source(
                    "V3Execution11ProtocolDecision",
                    format!(
                        "server {} lacks execution allowed_modes",
                        standardized.protocol_context.server_id
                    ),
                ),
                trace,
            ))
        }
    };
    let target = V3TargetInterpreter::default();
    let routing_facts = build_v3_router_request_facts_from_v3_req_04(&standardized, manifest);
    let router = V3VirtualRouter::process_shared();
    let classified = match router.classify_request_with_facts(
        manifest,
        &standardized.protocol_context.server_id,
        &standardized.protocol_context.endpoint,
        routing_facts,
    ) {
        Ok(value) => value,
        Err(error) => {
            return Err(protocol_plan_failure(
                runtime_source("V3Router05RequestClassified", error),
                trace,
            ))
        }
    };
    trace.push("V3Router05RequestClassified");
    let plan = match router.resolve_route_pool_plan(manifest, classified) {
        Ok(value) => value,
        Err(error) => {
            return Err(protocol_plan_failure(
                runtime_source("V3Router06RoutePoolResolved", error),
                trace,
            ))
        }
    };
    trace.push("V3Router06RoutePoolResolved");
    let hit = match router.hit_opaque_target_plan_once(plan, 0) {
        Ok(value) => value,
        Err(error) => {
            return Err(protocol_plan_failure(
                runtime_source("V3Router07OpaqueTargetHitOnce", error),
                trace,
            ))
        }
    };
    trace.push("V3Router07OpaqueTargetHitOnce");
    let kind = target.classify_kind(hit);
    trace.push("V3Target08KindClassified");
    let expanded = match target.expand_candidates(manifest, kind, 0) {
        Ok(value) => value,
        Err(error) => {
            return Err(protocol_plan_failure(
                runtime_source("V3Target09CandidateSetExpanded", error),
                trace,
            ))
        }
    };
    trace.push("V3Target09CandidateSetExpanded");
    let provider_health = provider_health.into();
    let availability = provider_health
        .session_bound_availability(&standardized.protocol_context.failure_session_scope);
    let selected = match target.select_available(expanded.clone(), &availability, now_epoch_ms) {
        Ok(value) => value,
        Err(error) => {
            return Err(protocol_plan_failure(
                build_v3_error_01_source_raised(
                    V3ErrorSourceKind::TargetPoolExhausted,
                    "V3Target10ConcreteProviderSelected",
                    "selected_target_exhausted",
                    format!(
                        "{} candidates unavailable",
                        error.attempted_candidates.len()
                    ),
                ),
                trace,
            ))
        }
    };
    trace.push("V3Target10ConcreteProviderSelected");
    let decision = match build_v3_execution_11_protocol_decision_from_v3_target_10(
        selected,
        "responses",
        &allowed_modes,
    ) {
        Ok(decision) => decision,
        Err(source) => {
            trace.push("V3Execution11ProtocolDecision");
            return Err(protocol_plan_failure(source, trace));
        }
    };
    trace.push("V3Execution11ProtocolDecision");
    Ok(V3ResponsesProtocolExecutionPlan {
        decision,
        node_trace: trace,
        expanded,
    })
}

fn protocol_plan_failure(
    source: V3Error01SourceRaised,
    node_trace: Vec<&'static str>,
) -> V3ResponsesProtocolExecutionPlanFailure {
    V3ResponsesProtocolExecutionPlanFailure { source, node_trace }
}

async fn execute_v3_responses_direct_runtime_kernel_with_transport_debug_core<
    T: ResponsesTransport,
>(
    state: V3ResponsesDirectRuntimeCoreState<'_>,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    hook_registry: V3HookRegistry,
    transport: &T,
    debug: &V3DebugRuntime,
) -> V3ResponsesDirectRuntimeOutput {
    let scope = match debug.start_trace(&raw.server_id, &raw.request_id, &raw.execution_id) {
        Ok(scope) => scope,
        Err(error) => {
            return debug_error_output("V3Debug01TraceContextStarted", error, &hook_registry)
        }
    };
    if let Err(error) = debug.capture_raw_request(&scope, raw.body.clone()) {
        return debug_error_output("V3Debug02RawRequestCaptured", error, &hook_registry);
    }

    let output = execute_v3_responses_direct_runtime_kernel_core(
        state,
        manifest,
        raw,
        hook_registry,
        transport,
    )
    .await;

    for node_id in &output.node_trace {
        if let Err(error) = debug.record_node_event(
            &scope,
            *node_id,
            "executed",
            output
                .error_chain
                .as_ref()
                .map(|chain| json!({"error_chain": chain})),
        ) {
            return debug_error_output("V3Debug01NodeEventRegistered", error, &hook_registry);
        }
    }
    if let Err(error) =
        debug.capture_raw_response(&scope, client_payload_debug_value(&output.client_payload))
    {
        return debug_error_output("V3Debug03RawResponseCaptured", error, &hook_registry);
    }
    output
}

#[derive(Debug)]
struct V3DryRunNoNetworkTransport {
    response_payload: Value,
    captured_provider_request: Arc<Mutex<Option<Value>>>,
}

#[async_trait]
impl ResponsesTransport for V3DryRunNoNetworkTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        if let Ok(mut captured) = self.captured_provider_request.lock() {
            *captured = Some(request.redacted_provider_request_projection());
        }
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&self.response_payload).map_err(|error| {
                V3ProviderError::ResponseBody {
                    request_id: request.request_id().to_string(),
                    provider_id: request.provider_id().to_string(),
                    reason: error.to_string(),
                }
            })?,
        ))
    }
}

pub async fn execute_v3_responses_direct_dry_run_runtime(
    fixture: V3DryRunFixture,
    manifest: &V3Config05ManifestPublished,
    debug: &V3DebugRuntime,
) -> crate::V3FoundationRuntimeOutput {
    execute_v3_responses_direct_dry_run_runtime_inner(fixture, manifest, debug, None).await
}

pub async fn execute_v3_responses_direct_dry_run_runtime_with_initial_target(
    fixture: V3DryRunFixture,
    manifest: &V3Config05ManifestPublished,
    debug: &V3DebugRuntime,
    initial_plan: &V3ResponsesProtocolExecutionPlan,
) -> crate::V3FoundationRuntimeOutput {
    execute_v3_responses_direct_dry_run_runtime_inner(fixture, manifest, debug, Some(initial_plan))
        .await
}

async fn execute_v3_responses_direct_dry_run_runtime_inner(
    fixture: V3DryRunFixture,
    manifest: &V3Config05ManifestPublished,
    debug: &V3DebugRuntime,
    initial_plan: Option<&V3ResponsesProtocolExecutionPlan>,
) -> crate::V3FoundationRuntimeOutput {
    if let Err(error) = debug.register_dry_run_fixture(fixture.clone()) {
        return crate::project_v3_debug_failure("V3DryRunFixtureRegistered", error);
    }
    if let Err(error) = debug.build_dry_run_execution_plan(&fixture.fixture_id) {
        return crate::project_v3_debug_failure("V3DryRunExecutionPlanned", error);
    }
    let request_id = format!("dry-run-{}", fixture.fixture_id);
    let execution_id = format!("dry-run-exec-{}", fixture.fixture_id);
    let scope = match debug.start_trace(&fixture.server_id, &request_id, &execution_id) {
        Ok(scope) => scope,
        Err(error) => {
            return crate::project_v3_debug_failure("V3Debug01TraceContextStarted", error)
        }
    };
    let session_id = match debug.start_snapshot_session(&scope, "dry-run") {
        Ok(session_id) => session_id,
        Err(error) => return crate::project_v3_debug_failure("V3SnapshotSessionStarted", error),
    };
    let captured_provider_request = Arc::new(Mutex::new(None));
    let transport = V3DryRunNoNetworkTransport {
        response_payload: fixture.response_payload.clone(),
        captured_provider_request: Arc::clone(&captured_provider_request),
    };
    let core_state = match initial_plan {
        Some(plan) => V3ResponsesDirectRuntimeCoreState::no_continuation().with_initial_plan(plan),
        None => V3ResponsesDirectRuntimeCoreState::no_continuation(),
    }
    .with_provider_health_neutral();
    let mut output = execute_v3_responses_direct_runtime_kernel_with_transport_debug_core(
        core_state,
        manifest,
        V3Server03HttpRequestRaw {
            server_id: fixture.server_id.clone(),
            failure_session_scope: V3ProviderFailureSessionScope::new(
                &fixture.server_id,
                manifest
                    .servers
                    .get(&fixture.server_id)
                    .map(|server| server.routing_group.as_str())
                    .unwrap_or("dry-run"),
                "dry-run",
            )
            .expect("dry-run failure session scope"),
            request_id,
            execution_id,
            method: fixture.method.clone(),
            path: fixture.path.clone(),
            body: fixture.request_payload.clone(),
        },
        crate::register_responses_direct_hooks(),
        &transport,
        debug,
    )
    .await;
    if let Some(index) = output
        .node_trace
        .iter()
        .position(|node| *node == "V3Transport13ResponsesHttpRequest")
    {
        output
            .node_trace
            .insert(index + 1, "V3DryRunNoNetworkTerminalEffect");
    }
    output.node_trace.push("V3Server16HttpFrame");
    for node_id in ["V3DryRunNoNetworkTerminalEffect", "V3Server16HttpFrame"] {
        if let Err(error) = debug.record_node_event(
            &scope,
            node_id,
            "dry_run",
            Some(json!({"terminal_effect": "no_network_send"})),
        ) {
            let _ = debug.release_snapshot_session(&scope, &session_id);
            return crate::project_v3_debug_failure("V3Debug01NodeEventRegistered", error);
        }
    }
    for node_id in &output.node_trace {
        if let Err(error) = debug.record_snapshot(
            &scope,
            &session_id,
            *node_id,
            json!({"node_id": node_id, "dry_run": true}),
        ) {
            let _ = debug.release_snapshot_session(&scope, &session_id);
            return crate::project_v3_debug_failure("V3SnapshotNodeCaptured", error);
        }
    }
    let transient_snapshots = match debug.snapshots() {
        Ok(snapshots) => snapshots
            .into_iter()
            .filter(|snapshot| snapshot.session_id == session_id)
            .collect::<Vec<_>>(),
        Err(error) => {
            let _ = debug.release_snapshot_session(&scope, &session_id);
            return crate::project_v3_debug_failure("V3SnapshotProjectionRead", error);
        }
    };
    if let Err(error) = debug.release_snapshot_session(&scope, &session_id) {
        return crate::project_v3_debug_failure("V3SnapshotSessionReleased", error);
    }
    let response_payload = json!({
        "object": "routecodex.provider_request_dry_run_terminal",
        "terminal_effect": "no_network_send",
        "provider_network_send": false,
        "continuation": {
            "owner": "none",
            "continuable": false
        },
        "message": "routecodex provider-request dry-run stopped before provider send"
    });
    let provider_request = captured_provider_request
        .lock()
        .ok()
        .and_then(|captured| captured.clone())
        .map(|request| debug.redact_projection(request))
        .unwrap_or_else(|| json!(null));
    let dry_run_status = if provider_request.is_null() {
        output.client_payload.status
    } else {
        200
    };
    crate::V3FoundationRuntimeOutput {
        status: dry_run_status,
        body: json!({
            "object": "routecodex.pipeline_dry_run",
            "kind": "provider_request",
            "dryRun": true,
            "evidence": {
                "stoppedBeforeProviderSend": true,
                "providerNetworkSend": false,
                "stoppedBeforeNetworkSend": true,
                "providerRequestCaptured": !provider_request.is_null()
            },
            "providerRequest": provider_request,
            "dry_run": {
                "fixture_id": fixture.fixture_id,
                "server_id": fixture.server_id,
                "method": fixture.method,
                "path": fixture.path,
                "terminal_effect": "no_network_send",
                "provider_pipeline_executed": true,
                "provider_network_send": false,
                "stopped_before_network_send": true,
                "stopped_before_provider_send": true,
                "provider_request": provider_request,
                "node_ids": output.node_trace,
                "snapshots": transient_snapshots,
                "response_payload": debug.redact_projection(response_payload)
            }
        }),
        debug_node: "V3DryRunNoNetworkTerminalEffect",
        error_node: output
            .error_chain
            .as_ref()
            .map_or("none", |_| "V3Error06ClientProjected"),
        error_chain: output.error_chain.unwrap_or_default(),
        node_trace: output.node_trace,
        stopped_before_provider_send: true,
    }
}
