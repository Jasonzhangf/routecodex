// V3 Direct 统一执行骨架（Jason 2026-08-08：不同协议共用一个大骨架，
// 只有 codec 不同；禁止每个协议独立写一套 runtime）。
//
// 骨架流程（对所有 direct 同协议入口一致）：
//   standardize -> route (Router05..Target09) -> select (Target10)
//   -> decision (SameProtocolDirect / RelayHandoff)
//   -> policy -> wire -> transport -> send -> response projection
//   -> client frame，失败走统一 failure policy 循环。
// 协议差异全部收敛在 `V3DirectProtocolCodec`。

pub async fn execute_v3_direct_runtime_kernel_core<
    C: V3DirectProtocolCodec,
    T: ResponsesTransport + ?Sized + 'static,
>(
    mut control: C::Control,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    transport: &T,
    provider_health: V3ProviderFailureRuntimeHealth,
    now_epoch_ms: u64,
    allow_exhaustion_rescue_probe: bool,
    provider_failure_event_sink: Option<&V3RuntimeProviderFailureEventSink>,
    route_selection_event_sink: Option<&V3RuntimeRouteSelectionEventSink>,
) -> V3ResponsesDirectRuntimeOutput
where
    C: Send + Sync + 'static,
    C::Control: Clone + Send + Sync + 'static,
    C::Standardized: Send + Sync + 'static,
    C::Policy: Send + Sync + 'static,
{
    let request_key_catalog =
        crate::kernel::direct_request_key_hooks::default_v3_direct_request_key_hook_catalog();
    execute_v3_direct_runtime_kernel_core_with_key_catalog::<C, T>(
        control,
        manifest,
        raw,
        transport,
        provider_health,
        now_epoch_ms,
        allow_exhaustion_rescue_probe,
        provider_failure_event_sink,
        route_selection_event_sink,
        &request_key_catalog,
    )
    .await
}

pub async fn execute_v3_direct_runtime_kernel_core_with_key_catalog<
    C: V3DirectProtocolCodec,
    T: ResponsesTransport + ?Sized + 'static,
>(
    mut control: C::Control,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    transport: &T,
    provider_health: V3ProviderFailureRuntimeHealth,
    now_epoch_ms: u64,
    allow_exhaustion_rescue_probe: bool,
    provider_failure_event_sink: Option<&V3RuntimeProviderFailureEventSink>,
    route_selection_event_sink: Option<&V3RuntimeRouteSelectionEventSink>,
    request_key_catalog: &crate::kernel::direct_request_key_hooks::V3DirectRequestKeyHookCatalog,
) -> V3ResponsesDirectRuntimeOutput
where
    C: Send + Sync + 'static,
    C::Control: Clone + Send + Sync + 'static,
    C::Standardized: Send + Sync + 'static,
    C::Policy: Send + Sync + 'static,
{
    execute_v3_direct_runtime_kernel_core_resident::<C, T>(
        control,
        manifest,
        raw,
        transport,
        provider_health,
        now_epoch_ms,
        allow_exhaustion_rescue_probe,
        provider_failure_event_sink,
        route_selection_event_sink,
        request_key_catalog,
    )
    .await
}

async fn execute_v3_direct_runtime_kernel_core_resident<
    C: V3DirectProtocolCodec,
    T: ResponsesTransport + ?Sized + 'static,
>(
    mut control: C::Control,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    transport: &T,
    provider_health: V3ProviderFailureRuntimeHealth,
    now_epoch_ms: u64,
    allow_exhaustion_rescue_probe: bool,
    provider_failure_event_sink: Option<&V3RuntimeProviderFailureEventSink>,
    route_selection_event_sink: Option<&V3RuntimeRouteSelectionEventSink>,
    request_key_catalog: &crate::kernel::direct_request_key_hooks::V3DirectRequestKeyHookCatalog,
) -> V3ResponsesDirectRuntimeOutput
where
    C: Send + Sync + 'static,
    C::Control: Clone + Send + Sync + 'static,
    C::Standardized: Send + Sync + 'static,
    C::Policy: Send + Sync + 'static,
{
    let accumulator = V3RuntimeObservabilityAccumulator::start();
    let runtime_timing = accumulator.timing();
    let mut trace = vec!["V3Config05ManifestPublished", "V3Server03HttpRequestRaw"];
    // stage-3 丢弃记录要写「客户端原始值」，必须在 codec 标准化之前取句柄：
    // `standardized` 之后还会被 before-send prepare 改写。
    let client_original_body = std::sync::Arc::new(raw.body.clone());
    let mut standardized = match C::build_standardized(raw) {
        Ok(standardized) => standardized,
        Err(error) => {
            trace.push(C::STANDARDIZED_STAGE);
            return direct_runtime_helpers_stream::source_failure_output(
                runtime_source(C::STANDARDIZED_STAGE, error),
                None,
                trace,
                &crate::hooks::register_responses_direct_hooks(),
            );
        }
    };
    trace.push(C::STANDARDIZED_STAGE);
    let request_execution_control = match crate::nodes::V3RequestExecutionControl::from_manifest(
        manifest,
        C::server_id(&standardized),
    ) {
        Ok(control) => control,
        Err(error) => {
            return direct_runtime_helpers_stream::source_failure_output(
                runtime_source("V3ExecutionAttemptBudget", error),
                None,
                trace,
                &crate::hooks::register_responses_direct_hooks(),
            )
        }
    };
    let attempt_budget = request_execution_control.attempt_budget();
    let direct_failure_session_scope = C::failure_session_scope(&control, &standardized);
    let availability = provider_health.session_bound_availability(&direct_failure_session_scope);
    let resolved = crate::operation_runner::run_v3_resolve_target_operator(
        C::body(&standardized).clone(),
        crate::operation_runner::V3ResolveTargetExecutionMode::DirectFresh {
            manifest: std::sync::Arc::new(manifest.clone()),
            server_id: C::server_id(&standardized).to_string(),
            endpoint_path: C::endpoint(&standardized).to_string(),
            entry_protocol: C::ENTRY_PROTOCOL.to_string(),
            request_id: C::request_id(&standardized).to_string(),
            session_id: direct_failure_session_scope.session_id().to_string(),
            conversation_id: direct_failure_session_scope.session_id().to_string(),
            port: C::server_id(&standardized).to_string(),
            longcontext_threshold_tokens: crate::configured_v3_longcontext_threshold_tokens(
                manifest,
                C::server_id(&standardized),
            ),
            is_compaction: C::endpoint(&standardized)
                .trim_end_matches('/')
                .ends_with("/responses/compact"),
            now_epoch_ms,
        },
    );
    let (resolved_request, resolved_target) = match resolved {
        Ok(value) => value,
        Err(crate::operation_runner::V3ResolveTargetOperatorError::Typed(source)) => {
            return error_output(
                source,
                trace,
                &crate::hooks::register_responses_direct_hooks(),
            );
        }
        Err(crate::operation_runner::V3ResolveTargetOperatorError::OperatorFault(fault)) => {
            return direct_runtime_helpers_stream::operator_fault_output(
                fault,
                trace,
                &crate::hooks::register_responses_direct_hooks(),
            );
        }
        Err(crate::operation_runner::V3ResolveTargetOperatorError::Runner(error)) => {
            return direct_runtime_helpers_stream::source_failure_output(
                runtime_source("V3Router07OpaqueTargetHitOnce", error),
                None,
                trace,
                &crate::hooks::register_responses_direct_hooks(),
            );
        }
    };
    *C::body_mut(&mut standardized) = resolved_request;
    let route_policy_pending = resolved_target.route_policy_pending;
    let route_policy_scope = resolved_target.route_policy_scope;
    let route_policy_group_id = resolved_target.opaque_hit.routing_group_id.clone();
    trace.extend([
        "V3Router05RequestClassified",
        "V3Router06RoutePoolResolved",
        "V3Router07OpaqueTargetHitOnce",
    ]);
    let mut target_source =
        crate::operation_runner::plan_execution::V3PlanExecutionTargetSource::OpaqueHit(
            resolved_target.opaque_hit,
        );
    let mut failed_candidates = BTreeSet::new();
    let mut same_candidate_retries = BTreeMap::<String, usize>::new();
    let mut retry_selected: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected> = None;
    let mut provider_failure_events = Vec::<V3RuntimeProviderFailureObservation>::new();
    let mut last_external_http = None::<V3ExternalHttpWitness>;
    let mut send_attempts = 0usize;
    let mut pending_provider_action_recovery = None;
    let mut provider_request_snapshot = None;
    let mut provider_response_snapshot = None;
    let mut provider_action_permit: Option<crate::provider_action_gate::V3ProviderActionPermit> =
        None;
    let mut provider_action_permit_target: Option<routecodex_v3_target::V3TargetCandidate> = None;
    let allowed_modes =
        direct_runtime_allowed_execution_modes(manifest, C::server_id(&standardized));
    loop {
        let expands_target = matches!(
            target_source,
            crate::operation_runner::plan_execution::V3PlanExecutionTargetSource::OpaqueHit(_)
        );
        let (planned_request, plan) = match crate::operation_runner::plan_execution::run_v3_plan_execution_operator_with_probes(
            C::body(&standardized).clone(),
            manifest,
            target_source.clone(),
            &direct_failure_session_scope,
            &provider_health,
            &failed_candidates,
            now_epoch_ms,
            0,
            allow_exhaustion_rescue_probe,
            retry_selected.take(),
            crate::operation_runner::plan_execution::V3PlanExecutionModePolicy::DirectEntry {
                entry_protocol: C::HUB_ENTRY_PROTOCOL,
                allowed_modes: allowed_modes.clone(),
            },
        )
        .await
        {
            Ok(value) => value,
            Err(crate::operation_runner::plan_execution::V3PlanExecutionStop::Failed(source)) => {
                return error_output(
                    source,
                    trace,
                    &crate::hooks::register_responses_direct_hooks(),
                );
            }
            Err(crate::operation_runner::plan_execution::V3PlanExecutionStop::OperatorFault(fault)) => {
                return direct_runtime_helpers_stream::operator_fault_output(
                    fault,
                    trace,
                    &crate::hooks::register_responses_direct_hooks(),
                );
            }
            Err(crate::operation_runner::plan_execution::V3PlanExecutionStop::Exhausted { exhaustion: error, .. }) => {
                // 可观测性：exhausted 时带全部候选明细（provider:alias:model:
                // 原因），否则 console 只有 "N candidates unavailable" 无法诊断
                // 哪个候选因何被冷却/排除。
                let detail = if error.attempted_candidates.is_empty() {
                    "no candidates".to_string()
                } else {
                    error.attempted_candidates.join(", ")
                };
                let exhausted_observability = V3RuntimeObservability {
                    entry_protocol: C::ENTRY_PROTOCOL.to_string(),
                    routing_group_id: Some(error.route.routing_group_id.clone()),
                    pool_id: Some(error.route.pool_id.clone()),
                    provider_status: None,
                    response_status: Some("error".to_string()),
                    unavailable_candidates: error.attempted_candidates.clone(),
                    ..V3RuntimeObservability::default()
                };
                return direct_runtime_helpers_stream::target_exhausted_output_with_observability(
                    crate::shared::direct_plain_error(
                        V3ErrorSourceKind::TargetPoolExhausted,
                        "V3Target10ConcreteProviderSelected",
                        "selected_target_exhausted",
                        format!(
                            "{} candidates unavailable: {detail}",
                            error.attempted_candidates.len()
                        ),
                    ),
                    last_external_http,
                    trace,
                    &crate::hooks::register_responses_direct_hooks(),
                    Some(exhausted_observability),
                );
            }
        };
        *C::body_mut(&mut standardized) = planned_request;
        failed_candidates.extend(plan.request_local_excluded_candidates);
        let expanded = plan.expanded;
        target_source =
            crate::operation_runner::plan_execution::V3PlanExecutionTargetSource::Expanded(
                expanded.clone(),
            );
        let selected = plan.selected;
        let mut selected_admission = Some(plan.admission);
        let decision = plan.protocol_decision;
        if expands_target {
            trace.extend(["V3Target08KindClassified", "V3Target09CandidateSetExpanded"]);
        }
        if provider_action_permit_target
            .as_ref()
            .is_some_and(|target| {
                target.provider_id != selected.candidate.provider_id
                    || target.auth_alias != selected.candidate.auth_alias
                    || target.model_id != selected.candidate.model_id
            })
        {
            drop(provider_action_permit.take());
            provider_action_permit_target = None;
        }
        attempt_budget.set_transport_attempt_limit(selected.candidate_count);
        trace.push("V3Target10ConcreteProviderSelected");
        if let Some(sink) = route_selection_event_sink.as_ref() {
            let transport_label = if C::body(&standardized)
                .get("stream")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
            {
                "sse"
            } else {
                "json"
            };
            let mut observability = build_v3_direct_runtime_observability(
                &selected,
                C::ENTRY_PROTOCOL,
                transport_label,
                None,
                "in_progress",
                provider_failure_events.clone(),
            );
            observability.attempts = Some(total_attempts(&accumulator, send_attempts));
            sink(&observability);
        }
        trace.push("V3Execution11ProtocolDecision");
        if !matches!(
            decision.mode,
            V3Execution11ProtocolDecisionMode::SameProtocolDirect
        ) {
            return relay_handoff_output(
                decision.target,
                expanded.clone(),
                failed_candidates.clone(),
                route_policy_pending.clone(),
                route_policy_scope.clone(),
                trace,
                provider_failure_events.clone(),
                accumulator.with_additional_attempts(send_attempts),
                request_execution_control,
            );
        }
        let server_id = C::server_id(&standardized).to_string();
        let request_id = C::request_id(&standardized).to_string();
        let tool_thinking_enabled = match C::prepare_before_send(
            &mut control,
            manifest,
            &server_id,
            &mut standardized,
            &request_id,
            now_epoch_ms,
            &mut trace,
        ) {
            Ok(enabled) => enabled,
            Err(failure) => {
                return direct_runtime_helpers_stream::source_failure_output(
                    failure,
                    last_external_http.clone(),
                    trace,
                    &crate::hooks::register_responses_direct_hooks(),
                )
            }
        };
        let policy = C::run_route(selected.clone(), &standardized);
        trace.push(C::POLICY_STAGE);
        // stage-3 丢弃上下文：请求身份 + 入口端口 + 客户端原始 payload 句柄 +
        // 独立丢弃日志路径。客户端原始 payload 在此保留为 Arc 句柄向下传递，
        // 使 stage 3 只看到 canonical payload 时仍能记录 source_value。
        let projection_drop_context = crate::projection_drop_log::V3ProjectionDropContext::new(
            C::request_id(&standardized).to_string(),
            manifest
                .servers
                .get(C::server_id(&standardized))
                .map(|server| server.port.to_string())
                .unwrap_or_default(),
            manifest.debug.projection_drop_log_file.clone(),
            client_original_body.clone(),
        );
        let wire =
            match C::run_request_projection(&policy, request_key_catalog, &projection_drop_context)
            {
                Ok(value) => value,
                Err(source) => {
                    return direct_runtime_helpers_stream::source_failure_output(
                        source,
                        last_external_http.clone(),
                        trace,
                        &crate::hooks::register_responses_direct_hooks(),
                    )
                }
            };
        trace.push("V3Provider12ResponsesWirePayload");
        // 客户端声明的响应 transport intent（wire 构建后即固定）。provider 契约
        // 可能强制上游走 SSE（如 OpenCode Zen 免费层），但客户端响应格式仍由
        // 该 intent 决定：JSON 客户端必须拿到缓冲后的 JSON，而不是泄漏的 SSE。
        let client_response_wants_json = wire.stream_intent()
            == routecodex_v3_provider_responses::V3ResponsesStreamIntent::Json;
        // 只有声明了“上游必须 SSE”的 provider 契约（如 OpenCode Zen 免费层）才会把
        // JSON 客户端的上游请求强制成 SSE，因此也只有该契约下的 JSON 客户端需要把
        // 上游 SSE 折叠回 JSON。其他 provider 保持既有直通行为不变。
        let provider_requires_upstream_sse =
            crate::hub_v1::v3_provider_profile_requires_upstream_sse(
                wire.target().compatibility_profile.as_deref(),
            );
        let custom_tool_function_binding = wire.custom_tool_function_binding().cloned();
        let namespace_identities = wire.namespace_identities().clone();
        let transport_request = match C::run_provider_transport(wire) {
            Ok(value) => value,
            Err(source) => {
                return direct_runtime_helpers_stream::source_failure_output(
                    source,
                    last_external_http.clone(),
                    trace,
                    &crate::hooks::register_responses_direct_hooks(),
                )
            }
        };
        let provider_protocol =
            match crate::hub_v1::provider_wire_protocol_for_selected_candidate(&selected.candidate)
            {
                Ok(protocol) => protocol,
                Err(error) => {
                    return direct_runtime_helpers_stream::source_failure_output(
                        runtime_source("V3Transport13ResponsesHttpRequest", error),
                        last_external_http.clone(),
                        trace,
                        &crate::hooks::register_responses_direct_hooks(),
                    )
                }
            };
        let transport_request = match crate::hub_v1::bind_v3_selected_business_auth_kind(
            manifest,
            &selected.candidate,
            provider_protocol,
            transport_request,
        ) {
            Ok(request) => request,
            Err(error) => {
                return direct_runtime_helpers_stream::source_failure_output(
                    runtime_source("V3Transport13ResponsesHttpRequest", error),
                    last_external_http.clone(),
                    trace,
                    &crate::hooks::register_responses_direct_hooks(),
                )
            }
        };
        let handoff_scope = match C::provider_transport_handoff_scope(&standardized) {
            Ok(scope) => scope,
            Err(error) => {
                return direct_runtime_helpers_stream::source_failure_output(
                    runtime_source("V3Transport13ResponsesHttpRequest", error),
                    last_external_http.clone(),
                    trace,
                    &crate::hooks::register_responses_direct_hooks(),
                )
            }
        };
        let transport_request = match transport_request.with_handoff_scope(handoff_scope) {
            Ok(request) => request,
            Err(error) => {
                return direct_runtime_helpers_stream::source_failure_output(
                    runtime_source("V3Transport13ResponsesHttpRequest", error),
                    last_external_http.clone(),
                    trace,
                    &crate::hooks::register_responses_direct_hooks(),
                )
            }
        };
        trace.push("V3Transport13ResponsesHttpRequest");
        provider_request_snapshot = Some(transport_request.provider_request_projection());
        if pending_provider_action_recovery.is_some() {
            drop(selected_admission.take());
        }
        if let Some(recovery) = pending_provider_action_recovery.take() {
            match provider_health
                .wait_for_error05_recovery(&recovery, &selected)
                .await
            {
                Ok(V3ProviderActionRecoveryTransition::Admitted(mut admission)) => {
                    provider_action_permit = admission.take_permit();
                    provider_action_permit_target = Some(selected.candidate.clone());
                    selected_admission = match admit_v3_selected_target_after_recovery(&selected) {
                        V3AdmitAfterRecovery::Admitted(admission) => Some(admission),
                        V3AdmitAfterRecovery::Busy => {
                            failed_candidates
                                .insert(v3_relay_provider_candidate_key(&selected.candidate));
                            drop(provider_action_permit.take());
                            provider_action_permit_target = None;
                            continue;
                        }
                        V3AdmitAfterRecovery::Failed(reason) => {
                            return direct_runtime_helpers_stream::source_failure_output(
                                runtime_source("V3Target10ConcreteProviderSelected", reason),
                                last_external_http.clone(),
                                trace,
                                &crate::hooks::register_responses_direct_hooks(),
                            )
                        }
                    };
                    trace.push("V3ProviderActionGateAdmission");
                }
                Ok(V3ProviderActionRecoveryTransition::Superseded(ticket)) => {
                    pending_provider_action_recovery = match ticket.recovery_witness() {
                        Ok(witness) => Some(witness),
                        Err(error) => {
                            return direct_runtime_helpers_stream::source_failure_output(
                                runtime_source("V3ProviderActionGateAdmission", error),
                                last_external_http.clone(),
                                trace,
                                &crate::hooks::register_responses_direct_hooks(),
                            )
                        }
                    };
                    retry_selected = Some(selected);
                    trace.push("V3ProviderActionGateTerminalReevaluation");
                    continue;
                }
                Ok(V3ProviderActionRecoveryTransition::ReleasedBySuccess(ticket)) => {
                    pending_provider_action_recovery = match ticket.recovery_witness() {
                        Ok(witness) => Some(witness),
                        Err(error) => {
                            return direct_runtime_helpers_stream::source_failure_output(
                                runtime_source("V3ProviderActionGateAdmission", error),
                                last_external_http.clone(),
                                trace,
                                &crate::hooks::register_responses_direct_hooks(),
                            )
                        }
                    };
                    retry_selected = Some(selected);
                    trace.push("V3ProviderActionGateTerminalReevaluation");
                    continue;
                }
                Ok(V3ProviderActionRecoveryTransition::Consumed(_)) => {
                    pending_provider_action_recovery = None;
                    retry_selected = Some(selected);
                    trace.push("V3ProviderActionGateConsumedReevaluation");
                    continue;
                }
                Err(error) => {
                    return direct_runtime_helpers_stream::source_failure_output(
                        runtime_source("V3ProviderActionGateAdmission", error),
                        last_external_http.clone(),
                        trace,
                        &crate::hooks::register_responses_direct_hooks(),
                    )
                }
            }
        }
        send_attempts = match attempt_budget.admit_transport_attempt() {
            Ok(attempts) => attempts,
            Err(error) => {
                if let Err(release_error) = C::release_after_error(
                    &control,
                    manifest,
                    C::server_id(&standardized),
                    &standardized,
                    C::request_id(&standardized),
                    &mut trace,
                ) {
                    return error_output(
                        release_error,
                        trace,
                        &crate::hooks::register_responses_direct_hooks(),
                    );
                }
                return direct_runtime_helpers_stream::source_failure_output(
                    direct_runtime_helpers_stream::direct_attempt_budget_error_source(error),
                    last_external_http.clone(),
                    trace,
                    &crate::hooks::register_responses_direct_hooks(),
                );
            }
        };
        if let Err(error) = runtime_timing.start_external() {
            return direct_runtime_helpers_stream::source_failure_output(
                runtime_source("V3RuntimeTimingExternal", error),
                last_external_http.clone(),
                trace,
                &crate::hooks::register_responses_direct_hooks(),
            );
        }
        let transport_request = match selected_admission.take() {
            Some(admission) => {
                transport_request.with_pre_acquired_admission(admission.into_lease())
            }
            None => transport_request,
        };
        let provider_raw = match transport.send(transport_request).await {
            Ok(raw) => raw,
            Err(V3ProviderError::ConcurrencyBusy { .. }) => {
                if let Err(error) = runtime_timing.finish_external() {
                    return direct_runtime_helpers_stream::source_failure_output(
                        runtime_source("V3RuntimeTimingExternal", error),
                        last_external_http.clone(),
                        trace,
                        &crate::hooks::register_responses_direct_hooks(),
                    );
                }
                failed_candidates.insert(v3_relay_provider_candidate_key(&selected.candidate));
                drop(provider_action_permit.take());
                provider_action_permit_target = None;
                continue;
            }
            Err(error) => {
                let failed_attempt_evidence =
                    crate::hub_v1::build_v3_runtime_provider_failed_attempt_evidence_from_error(
                        total_attempts(&accumulator, send_attempts),
                        provider_request_snapshot.clone(),
                        &error,
                    );
                if let Some(witness) =
                    crate::hub_v1::external_http_witness_from_provider_error(&error)
                {
                    last_external_http = Some(witness);
                }
                if let Err(timing_error) = runtime_timing.finish_external() {
                    return direct_runtime_helpers_stream::source_failure_output(
                        runtime_source("V3RuntimeTimingExternal", timing_error),
                        last_external_http.clone(),
                        trace,
                        &crate::hooks::register_responses_direct_hooks(),
                    );
                }
                let source = match build_v3_provider_error_source(
                    "V3Transport13ResponsesHttpRequest",
                    error,
                ) {
                    Ok(source) => source,
                    Err(fault) => {
                        let mut observability = build_v3_direct_runtime_observability(
                            C::policy_target(&policy),
                            C::ENTRY_PROTOCOL,
                            if C::body(&standardized)
                                .get("stream")
                                .and_then(serde_json::Value::as_bool)
                                .unwrap_or(false)
                            {
                                "sse"
                            } else {
                                "json"
                            },
                            None,
                            "failed",
                            provider_failure_events.clone(),
                        );
                        observability.attempts = Some(total_attempts(&accumulator, send_attempts));
                        return direct_runtime_helpers_stream::source_failure_output_with_observability_and_snapshots(
                                Err(fault),
                                last_external_http,
                                trace,
                                &crate::hooks::register_responses_direct_hooks(),
                                Some(observability),
                                provider_request_snapshot,
                                None,
                            );
                    }
                };
                if source.source_kind != V3ErrorSourceKind::ProviderFailure {
                    drop(provider_action_permit.take());
                    return error_output(
                        source,
                        trace,
                        &crate::hooks::register_responses_direct_hooks(),
                    );
                }
                drop(provider_action_permit.take());
                let policy_result = match run_v3_direct_provider_failure_policy(
                    &V3DirectProviderFailurePolicyContext {
                        failure_session_scope: &direct_failure_session_scope,
                        provider_health: &provider_health,
                        availability: &availability,
                        expanded: Some(&expanded),
                        provider_pinned: false,
                        now_epoch_ms,
                    },
                    C::policy_target(&policy),
                    source,
                    502,
                    &mut V3DirectProviderFailurePolicyState {
                        failed_candidates: &mut failed_candidates,
                        same_candidate_retries: &mut same_candidate_retries,
                        trace: &mut trace,
                    },
                )
                .await
                {
                    Ok(result) => result,
                    Err(failure) => {
                        return direct_runtime_helpers_stream::policy_failure_output_with_observability(
                            failure,
                            last_external_http,
                            trace,
                            None,
                        )
                    }
                };
                if let Some(event) = policy_result.event.clone() {
                    let mut event = event;
                    event.failed_attempt_evidence = failed_attempt_evidence;
                    provider_failure_events.push(event.clone());
                    publish_v3_direct_provider_failure_event(
                        provider_failure_event_sink,
                        C::policy_target(&policy),
                        C::ENTRY_PROTOCOL,
                        "json",
                        event.external_error_status,
                        &provider_failure_events,
                        &event,
                        total_attempts(&accumulator, send_attempts),
                    );
                }
                match &policy_result.decision.action {
                    V3Error05ExecutionAction::WaitThenReselect { recovery } => {
                        if policy_result.retryable_transient {
                            // 瞬态失败切走：request-local witness 不经过
                            // provider action gate（无 lane 可等），立即重选。
                            continue;
                        }
                        pending_provider_action_recovery = Some(recovery.clone());
                        continue;
                    }
                    V3Error05ExecutionAction::WaitThenRetrySame { recovery } => {
                        retry_selected = policy_result.retry_selected.map(|selected| *selected);
                        if policy_result.retryable_transient {
                            // 瞬态失败重试同一 provider：不经过 provider action
                            // gate（无 lane 可等），立即重发。
                            continue;
                        }
                        pending_provider_action_recovery = Some(recovery.clone());
                        continue;
                    }
                    V3Error05ExecutionAction::ProjectTerminal => {
                        if let Err(release_error) = C::release_after_error(
                            &control,
                            manifest,
                            C::server_id(&standardized),
                            &standardized,
                            C::request_id(&standardized),
                            &mut trace,
                        ) {
                            return error_output(
                                release_error,
                                trace,
                                &crate::hooks::register_responses_direct_hooks(),
                            );
                        }
                        let mut observability = build_v3_direct_runtime_observability(
                            C::policy_target(&policy),
                            C::ENTRY_PROTOCOL,
                            "json",
                            policy_result.event.as_ref().map(|event| event.status),
                            "failed",
                            provider_failure_events.clone(),
                        );
                        observability.attempts = Some(total_attempts(&accumulator, send_attempts));
                        return direct_runtime_helpers_stream::provider_terminal_output(
                            policy_result.decision,
                            last_external_http,
                            trace,
                            Some(observability),
                            provider_request_snapshot,
                            provider_response_snapshot,
                        );
                    }
                    V3Error05ExecutionAction::ClientDisconnected => {
                        return direct_runtime_helpers_stream::client_disconnect_terminal_output(
                            policy_result.decision,
                            trace,
                            None,
                        );
                    }
                    V3Error05ExecutionAction::RejectNonProviderError => {
                        return direct_runtime_helpers_stream::source_failure_output(
                            runtime_source(
                                "V3Error05ExecutionDecision",
                                "provider failure entered a non-provider Error05 lane",
                            ),
                            last_external_http.clone(),
                            trace,
                            &crate::hooks::register_responses_direct_hooks(),
                        )
                    }
                }
            }
        };
        trace.push("V3ProviderResp14Raw");
        // The upstream answered: from this instant its head is real evidence,
        // whatever the body turns out to be. Recorded before the body is
        // interpreted so a stream whose payload never decodes is never reported
        // as if no response had arrived. A branch below that can read a body
        // replaces this with the fuller witness.
        last_external_http = Some(crate::hub_v1::external_http_witness_head(&provider_raw));
        if let Some(body) = provider_raw.json_body() {
            provider_response_snapshot = Some(json!({
                "status": provider_raw.status(),
                "providerId": provider_raw.provider_id(),
                "bodyKind": "json",
                "body": serde_json::from_slice::<serde_json::Value>(body)
                    .unwrap_or_else(|_| json!({"rawBody": String::from_utf8_lossy(body)})),
            }));
        }
        if provider_raw.status() >= 400 {
            let provider_status = provider_raw.status();
            let provider_name = provider_raw.provider_id().to_string();
            let response_headers = provider_raw
                .headers()
                .iter()
                .map(|header| (header.name.clone(), header.value.clone()))
                .collect();
            let response_body = provider_raw.into_body_bytes().await.ok();
            if let Some(body) = response_body.as_ref() {
                // Retained regardless of client-projection eligibility (bug
                // `705d624`): an upstream 502 is still a real upstream
                // response and its status and body must survive as evidence.
                last_external_http = Some(V3ExternalHttpWitness::new(
                    provider_status,
                    response_headers,
                    body.clone(),
                ));
            }
            let provider_detail = response_body.and_then(|body| {
                serde_json::from_slice::<serde_json::Value>(&body)
                    .ok()
                    .and_then(|value| {
                        value
                            .pointer("/error/message")
                            .or_else(|| value.pointer("/message"))
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string)
                    })
                    .or_else(|| {
                        String::from_utf8(body)
                            .ok()
                            .filter(|text| !text.trim().is_empty())
                            .map(|text| text.chars().take(512).collect())
                    })
            });
            if let Err(timing_error) = runtime_timing.finish_external() {
                return direct_runtime_helpers_stream::source_failure_output(
                    runtime_source("V3RuntimeTimingExternal", timing_error),
                    last_external_http.clone(),
                    trace,
                    &crate::hooks::register_responses_direct_hooks(),
                );
            }
            let source = build_v3_error_01_source_raised_external(
                V3ErrorSourceKind::ProviderFailure,
                "V3ProviderResp14Raw",
                format!("provider_http_{provider_status}"),
                provider_detail.as_deref().map_or_else(
                    || format!("provider {provider_name} returned {provider_status}"),
                    |detail| {
                        format!("provider {provider_name} returned {provider_status}: {detail}")
                    },
                ),
                V3ExternalErrorLink {
                    kind: V3ExternalErrorKind::Provider,
                    status: Some(provider_status),
                    code: Some(format!("HTTP_{provider_status}")),
                    provider_id: Some(provider_name),
                    upstream_request_id: None,
                    message: Some(provider_detail.as_deref().map_or_else(
                        || format!("provider returned HTTP {provider_status}"),
                        |detail| format!("provider returned HTTP {provider_status}: {detail}"),
                    )),
                },
            );
            drop(provider_action_permit.take());
            let policy_result = match run_v3_direct_provider_failure_policy(
                &V3DirectProviderFailurePolicyContext {
                    failure_session_scope: &direct_failure_session_scope,
                    provider_health: &provider_health,
                    availability: &availability,
                    expanded: Some(&expanded),
                    provider_pinned: false,
                    now_epoch_ms,
                },
                C::policy_target(&policy),
                source,
                provider_status,
                &mut V3DirectProviderFailurePolicyState {
                    failed_candidates: &mut failed_candidates,
                    same_candidate_retries: &mut same_candidate_retries,
                    trace: &mut trace,
                },
            )
            .await
            {
                Ok(result) => result,
                Err(failure) => {
                    return direct_runtime_helpers_stream::policy_failure_output_with_observability(
                        failure,
                        last_external_http,
                        trace,
                        None,
                    )
                }
            };
            if let Some(event) = policy_result.event.clone() {
                provider_failure_events.push(event.clone());
                publish_v3_direct_provider_failure_event(
                    provider_failure_event_sink,
                    C::policy_target(&policy),
                    C::ENTRY_PROTOCOL,
                    "json",
                    event.external_error_status,
                    &provider_failure_events,
                    &event,
                    total_attempts(&accumulator, send_attempts),
                );
            }
            match &policy_result.decision.action {
                V3Error05ExecutionAction::WaitThenReselect { recovery } => {
                    if policy_result.retryable_transient {
                        // 瞬态失败切走：request-local witness 不经过
                        // provider action gate（无 lane 可等），立即重选。
                        continue;
                    }
                    pending_provider_action_recovery = Some(recovery.clone());
                    continue;
                }
                V3Error05ExecutionAction::WaitThenRetrySame { recovery } => {
                    retry_selected = policy_result.retry_selected.map(|selected| *selected);
                    if policy_result.retryable_transient {
                        // 瞬态失败重试同一 provider：不经过 provider action
                        // gate（无 lane 可等），立即重发。
                        continue;
                    }
                    pending_provider_action_recovery = Some(recovery.clone());
                    continue;
                }
                _ => {
                    if let Err(release_error) = C::release_after_error(
                        &control,
                        manifest,
                        C::server_id(&standardized),
                        &standardized,
                        C::request_id(&standardized),
                        &mut trace,
                    ) {
                        return error_output(
                            release_error,
                            trace,
                            &crate::hooks::register_responses_direct_hooks(),
                        );
                    }
                    let mut observability = build_v3_direct_runtime_observability(
                        C::policy_target(&policy),
                        C::ENTRY_PROTOCOL,
                        "json",
                        Some(provider_status),
                        "failed",
                        provider_failure_events.clone(),
                    );
                    observability.attempts = Some(total_attempts(&accumulator, send_attempts));
                    return direct_runtime_helpers_stream::provider_terminal_output(
                        policy_result.decision,
                        last_external_http,
                        trace,
                        Some(observability),
                        provider_request_snapshot,
                        provider_response_snapshot,
                    );
                }
            }
        }
        let provider_status = provider_raw.status();
        let response_projection_context =
            match crate::kernel::v3_direct_protocol_codec::build_direct_response_compat_context(
                C::policy_target(&policy),
                namespace_identities,
                tool_thinking_enabled,
                crate::hub_v1::v3_toolreason_client_projection_enabled_for_server(
                    manifest,
                    C::server_id(&standardized),
                ),
                direct_failure_session_scope.session_id(),
                C::tool_thinking_turn_context(&standardized).clone(),
                custom_tool_function_binding.clone(),
            ) {
                Ok(context) => context,
                Err(error) => {
                    return direct_runtime_helpers_stream::source_failure_output(
                        runtime_source("V3DirectResp14ProviderCompat", error),
                        last_external_http.clone(),
                        trace,
                        &crate::hooks::register_responses_direct_hooks(),
                    )
                }
            };
        let response_projection_context =
            response_projection_context.with_runtime_timing(runtime_timing.clone());
        let direct_namespace_tool_identities = response_projection_context
            .namespace_tool_identities
            .clone();
        let mut response_projection = match C::run_response_projection(
            provider_raw,
            response_projection_context,
        )
        .await
        {
            Ok(projection) => projection,
            Err(Err(fault)) => {
                return direct_runtime_helpers_stream::source_failure_output_with_observability_and_snapshots(
                    Err(fault),
                    last_external_http.clone(),
                    trace,
                    &crate::hooks::register_responses_direct_hooks(),
                    None,
                    provider_request_snapshot,
                    provider_response_snapshot,
                );
            }
            Err(Ok(source)) => {
                if let Err(error) = runtime_timing.finish_external() {
                    return direct_runtime_helpers_stream::source_failure_output_with_observability_and_snapshots(
                        runtime_source("V3RuntimeTimingExternal", error),
                        last_external_http.clone(),
                        trace,
                        &crate::hooks::register_responses_direct_hooks(),
                        None,
                        provider_request_snapshot,
                        provider_response_snapshot,
                    );
                }
                if !matches!(
                    source.source_kind,
                    routecodex_v3_error::V3ErrorSourceKind::ProviderFailure
                ) {
                    return direct_runtime_helpers_stream::source_failure_output_with_observability_and_snapshots(
                        Ok(source),
                        last_external_http.clone(),
                        trace,
                        &crate::hooks::register_responses_direct_hooks(),
                        None,
                        provider_request_snapshot,
                        provider_response_snapshot,
                    );
                }
                drop(provider_action_permit.take());
                let policy_result = match run_v3_direct_provider_failure_policy(
                        &V3DirectProviderFailurePolicyContext {
                            failure_session_scope: &direct_failure_session_scope,
                            provider_health: &provider_health,
                            availability: &availability,
                            expanded: Some(&expanded),
                            provider_pinned: false,
                            now_epoch_ms,
                        },
                        C::policy_target(&policy),
                        source,
                        502,
                        &mut V3DirectProviderFailurePolicyState {
                            failed_candidates: &mut failed_candidates,
                            same_candidate_retries: &mut same_candidate_retries,
                            trace: &mut trace,
                        },
                    )
                    .await
                    {
                        Ok(result) => result,
                        Err(failure) => {
                            return direct_runtime_helpers_stream::policy_failure_output_with_observability(
                                failure,
                                last_external_http,
                                trace,
                                None,
                            )
                        }
                    };
                if let Some(event) = policy_result.event.clone() {
                    provider_failure_events.push(event.clone());
                    publish_v3_direct_provider_failure_event(
                        provider_failure_event_sink,
                        C::policy_target(&policy),
                        C::ENTRY_PROTOCOL,
                        "json",
                        event.external_error_status,
                        &provider_failure_events,
                        &event,
                        total_attempts(&accumulator, send_attempts),
                    );
                }
                match &policy_result.decision.action {
                    V3Error05ExecutionAction::WaitThenReselect { recovery } => {
                        pending_provider_action_recovery = Some(recovery.clone());
                        continue;
                    }
                    V3Error05ExecutionAction::WaitThenRetrySame { recovery } => {
                        retry_selected = policy_result.retry_selected.map(|selected| *selected);
                        pending_provider_action_recovery = Some(recovery.clone());
                        continue;
                    }
                    _ => {
                        if let Err(release_error) = C::release_after_error(
                            &control,
                            manifest,
                            C::server_id(&standardized),
                            &standardized,
                            C::request_id(&standardized),
                            &mut trace,
                        ) {
                            return error_output(
                                release_error,
                                trace,
                                &crate::hooks::register_responses_direct_hooks(),
                            );
                        }
                        let mut observability = build_v3_direct_runtime_observability(
                            C::policy_target(&policy),
                            C::ENTRY_PROTOCOL,
                            "json",
                            policy_result.event.as_ref().map(|event| event.status),
                            "failed",
                            provider_failure_events.clone(),
                        );
                        observability.attempts = Some(total_attempts(&accumulator, send_attempts));
                        return direct_runtime_helpers_stream::provider_terminal_output(
                            policy_result.decision,
                            last_external_http,
                            trace,
                            Some(observability),
                            provider_request_snapshot,
                            provider_response_snapshot,
                        );
                    }
                }
            }
        };
        let attempt_body = std::mem::replace(
            &mut response_projection.attempt_payload.body,
            V3ProviderAttemptBody::Bytes(Vec::new()),
        );
        let committed_client_sse = matches!(&attempt_body, V3ProviderAttemptBody::Sse(_));
        let mut collapsed_sse_to_json = false;
        let (client_body, attempt_success_receipt) = match attempt_body {
            V3ProviderAttemptBody::Sse(stream) => {
                let target_observation =
                    bind_direct_sse_stream_observation(&mut response_projection.stream_observation);
                let projected = crate::kernel::wrap_direct_sse_provider_event_json_observation_stream_with_compat_hook(
                    stream,
                    target_observation.clone(),
                    runtime_timing.clone(),
                    false,
                    true,
                    response_projection.compat_plan.provider_protocol,
                    response_projection.compat_plan.has_block(
                        crate::direct_response_hooks::V3DirectResponseCompatBlock::DeepseekConsoleGoResponseShape,
                    ),
                    response_projection.compat_plan.has_block(
                        crate::direct_response_hooks::V3DirectResponseCompatBlock::ThinkingTags,
                    ) && response_projection.compat_plan.provider_protocol
                        == V3HubProviderWireProtocol::Responses,
                    response_projection
                        .compat_plan
                        .has_block(
                            crate::direct_response_hooks::V3DirectResponseCompatBlock::ProviderResponseCompat,
                        )
                        .then(|| {
                            response_projection
                                .compat_plan
                                .provider_response_compat_profile()
                        })
                        .flatten()
                        .map(ToOwned::to_owned),
                    response_projection
                        .compat_plan
                        .custom_tool_function_binding
                        .clone(),
                    crate::hooks::register_responses_direct_hooks().direct_sse_typed_hooks(),
                    tool_thinking_enabled,
                    crate::hub_v1::v3_toolreason_client_projection_enabled_for_server(
                        manifest,
                        C::server_id(&standardized),
                    ),
                    Some(direct_failure_session_scope.session_id().to_owned()),
                    Some(C::request_id(&standardized).to_owned()),
                    Some(C::policy_target(&policy).candidate.model_id.clone()),
                    true,
                    direct_namespace_tool_identities,
                );
                let committed = match crate::kernel::direct_runtime_helpers_stream::collect_direct_sse_attempt_after_terminal_with_memory(
                    projected,
                    response_projection.compat_plan.provider_protocol,
                    attempt_budget.clone(),
                    Some(manifest),
                    Some(C::request_id(&standardized)),
                )
                .await
                {
                    Ok(committed) => committed,
                    Err(Err(fault)) => {
                        if let Err(error) = runtime_timing.finish_external_if_active() {
                            return direct_runtime_helpers_stream::source_failure_output(
                                runtime_source("V3RuntimeTimingExternal", error),
                                last_external_http.clone(),
                                trace,
                                &crate::hooks::register_responses_direct_hooks(),
                            );
                        }
                        drop(provider_action_permit.take());
                        return direct_runtime_helpers_stream::source_failure_output(
                            Err(fault),
                            last_external_http.clone(),
                            trace,
                            &crate::hooks::register_responses_direct_hooks(),
                        );
                    }
                    Err(Ok(source))
                        if source.source_kind != V3ErrorSourceKind::ProviderFailure =>
                    {
                        if let Err(error) = runtime_timing.finish_external_if_active() {
                            return direct_runtime_helpers_stream::source_failure_output(
                                runtime_source("V3RuntimeTimingExternal", error),
                                last_external_http.clone(),
                                trace,
                                &crate::hooks::register_responses_direct_hooks(),
                            );
                        }
                        drop(provider_action_permit.take());
                        return direct_runtime_helpers_stream::source_failure_output(
                            Ok(source),
                            last_external_http.clone(),
                            trace,
                            &crate::hooks::register_responses_direct_hooks(),
                        );
                    }
                    Err(Ok(source)) => {
                        if let Err(error) = runtime_timing.finish_external_if_active() {
                            return direct_runtime_helpers_stream::source_failure_output(
                                runtime_source("V3RuntimeTimingExternal", error),
                                last_external_http.clone(),
                                trace,
                                &crate::hooks::register_responses_direct_hooks(),
                            );
                        }
                        drop(provider_action_permit.take());
                        let mut policy_result = match run_v3_direct_provider_failure_policy(
                            &V3DirectProviderFailurePolicyContext {
                                failure_session_scope: &direct_failure_session_scope,
                                provider_health: &provider_health,
                                availability: &availability,
                                expanded: Some(&expanded),
                                provider_pinned: false,
                                now_epoch_ms,
                            },
                            C::policy_target(&policy),
                            source,
                            502,
                            &mut V3DirectProviderFailurePolicyState {
                                failed_candidates: &mut failed_candidates,
                                same_candidate_retries: &mut same_candidate_retries,
                                trace: &mut trace,
                            },
                        )
                        .await
                        {
                            Ok(result) => result,
                            Err(failure) => {
                                return direct_runtime_helpers_stream::policy_failure_output_with_observability(
                                    failure,
                                    last_external_http,
                                    trace,
                                    None,
                                )
                            }
                        };
                        if let Err(failure) =
                            policy_result.exhaust_if_residence_expired(&attempt_budget)
                        {
                            return direct_runtime_helpers_stream::policy_failure_output_with_observability(
                                failure,
                                last_external_http,
                                trace,
                                None,
                            );
                        }
                        if let Some(event) = policy_result.event.clone() {
                            provider_failure_events.push(event.clone());
                            publish_v3_direct_provider_failure_event(
                                provider_failure_event_sink,
                                C::policy_target(&policy),
                                C::ENTRY_PROTOCOL,
                                "sse",
                                event.external_error_status,
                                &provider_failure_events,
                                &event,
                                total_attempts(&accumulator, send_attempts),
                            );
                        }
                        let decision = policy_result.decision;
                        match &decision.action {
                            V3Error05ExecutionAction::WaitThenReselect { recovery } => {
                                if !policy_result.retryable_transient {
                                    pending_provider_action_recovery = Some(recovery.clone());
                                }
                                continue;
                            }
                            V3Error05ExecutionAction::WaitThenRetrySame { recovery } => {
                                retry_selected =
                                    policy_result.retry_selected.map(|selected| *selected);
                                if !policy_result.retryable_transient {
                                    pending_provider_action_recovery = Some(recovery.clone());
                                }
                                continue;
                            }
                            _ => {
                                if let Err(release_error) = C::release_after_error(
                                    &control,
                                    manifest,
                                    C::server_id(&standardized),
                                    &standardized,
                                    C::request_id(&standardized),
                                    &mut trace,
                                ) {
                                    return error_output(
                                        release_error,
                                        trace,
                                        &crate::hooks::register_responses_direct_hooks(),
                                    );
                                }
                                let mut observability = build_v3_direct_runtime_observability(
                                    C::policy_target(&policy),
                                    C::ENTRY_PROTOCOL,
                                    "sse",
                                    policy_result.event.as_ref().map(|event| event.status),
                                    "failed",
                provider_failure_events.clone(),
                                );
                                observability.attempts =
                                    Some(total_attempts(&accumulator, send_attempts));
                                return direct_runtime_helpers_stream::provider_terminal_output(
                                    decision,
                                    last_external_http,
                                    trace,
                                    Some(observability),
                                    provider_request_snapshot,
                                    provider_response_snapshot,
                                );
                            }
                        }
                    }
                };
                drop(provider_action_permit.take());
                // 客户端要 JSON，但声明契约强制了上游 SSE：按客户端 intent 缓冲成
                // JSON，不把 SSE 泄漏给非流式客户端。仅 Chat 入口使用 Chat chunk reducer。
                if client_response_wants_json
                    && provider_requires_upstream_sse
                    && C::ENTRY_PROTOCOL == "openai_chat"
                {
                    let completion =
                        match direct_client_sse_collapse::collapse_direct_client_sse_to_json(
                            committed,
                        )
                        .await
                        {
                            Ok(completion) => completion,
                            Err(source) => {
                                return error_output(
                                    source,
                                    trace,
                                    &crate::hooks::register_responses_direct_hooks(),
                                )
                            }
                        };
                    collapsed_sse_to_json = true;
                    (
                        V3ClientBody::Json(completion),
                        V3AttemptSuccessReceipt::from_buffered_terminal_attempt(),
                    )
                } else {
                    let receipt = V3AttemptSuccessReceipt::from_sealed_sse_attempt(&committed);
                    (V3ClientBody::CommittedSse(committed), receipt)
                }
            }
            V3ProviderAttemptBody::Json(body) => (
                V3ClientBody::Json(body),
                V3AttemptSuccessReceipt::from_buffered_terminal_attempt(),
            ),
            V3ProviderAttemptBody::Bytes(body) => (
                V3ClientBody::Bytes(body),
                V3AttemptSuccessReceipt::from_buffered_terminal_attempt(),
            ),
        };
        let mut client_headers = std::mem::take(&mut response_projection.attempt_payload.headers);
        if collapsed_sse_to_json {
            // 上游 SSE 已被缓冲成 JSON，客户端帧必须按 JSON 投影，不能沿用
            // provider 的 text/event-stream content-type。
            client_headers.insert("content-type".to_string(), "application/json".to_string());
        }
        let client_payload = V3Resp15ClientPayload {
            status: response_projection.attempt_payload.status,
            headers: client_headers,
            body: client_body,
        };
        if let Err(commit_error) = C::commit_after_response(
            &attempt_success_receipt,
            &control,
            manifest,
            C::server_id(&standardized),
            &standardized,
            C::request_id(&standardized),
            &mut trace,
        ) {
            return error_output(
                commit_error,
                trace,
                &crate::hooks::register_responses_direct_hooks(),
            );
        }
        let policies =
            match crate::route_policy::compile_route_policies(manifest, &route_policy_group_id) {
                Ok(policies) => policies,
                Err(error) => {
                    return direct_runtime_helpers_stream::source_failure_output(
                        runtime_source("V3Router06RoutePoolResolved", error),
                        last_external_http.clone(),
                        trace,
                        &crate::hooks::register_responses_direct_hooks(),
                    )
                }
            };
        if let Err(error) = route_policy_pending
            .as_ref()
            .map(|pending| pending.commit(&policies, now_epoch_ms))
            .transpose()
        {
            return direct_runtime_helpers_stream::source_failure_output(
                runtime_source("V3Router06RoutePoolResolved", error),
                last_external_http.clone(),
                trace,
                &crate::hooks::register_responses_direct_hooks(),
            );
        }
        if provider_status < 400 {
            if let Err(error) = record_v3_direct_provider_success(
                &attempt_success_receipt,
                &provider_health,
                &direct_failure_session_scope,
                C::policy_target(&policy),
                now_epoch_ms,
            ) {
                return direct_runtime_helpers_stream::source_failure_output(
                    error,
                    last_external_http.clone(),
                    trace,
                    &crate::hooks::register_responses_direct_hooks(),
                );
            }
        }
        let mut observability = build_v3_direct_runtime_observability(
            C::policy_target(&policy),
            C::ENTRY_PROTOCOL,
            v3_direct_client_transport_label(&client_payload),
            Some(provider_status),
            "completed",
            provider_failure_events.clone(),
        );
        observability.attempts = Some(total_attempts(&accumulator, send_attempts));
        if committed_client_sse {
            observability.timing = match response_projection.stream_observation.as_ref() {
                Some(observation) => match observation.snapshot() {
                    Ok(snapshot) => snapshot.timing,
                    Err(error) => {
                        return direct_runtime_helpers_stream::source_failure_output(
                            runtime_source("V3RuntimeTimingObservation", error),
                            last_external_http.clone(),
                            trace,
                            &crate::hooks::register_responses_direct_hooks(),
                        )
                    }
                },
                None => None,
            };
        } else {
            let _ = runtime_timing.finish_external();
            if let Ok(summary) = runtime_timing.finish_runtime() {
                observability.timing = Some(summary);
            }
        }
        return V3ResponsesDirectRuntimeOutput {
            client_payload,
            terminal_disposition: None,
            diagnostic_source: None,
            diagnostic_cause: None,
            provider_request_snapshot,
            provider_response_snapshot,
            node_trace: trace,
            error_chain: None,
            observability: Some(observability),
            stream_observation: response_projection.stream_observation,
            protocol_relay_handoff: None,
        };
    }
}

pub(crate) fn bind_direct_sse_stream_observation(
    observation: &mut Option<V3RuntimeStreamObservation>,
) -> V3RuntimeStreamObservation {
    let bound = observation.clone().unwrap_or_default();
    *observation = Some(bound.clone());
    bound
}
