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
    T: ResponsesTransport,
>(
    mut control: C::Control,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    transport: &T,
    provider_health: V3ProviderFailureRuntimeHealth,
    now_epoch_ms: u64,
    provider_failure_event_sink: Option<&V3RuntimeProviderFailureEventSink>,
    route_selection_event_sink: Option<&V3RuntimeRouteSelectionEventSink>,
) -> V3ResponsesDirectRuntimeOutput {
    let accumulator = V3RuntimeObservabilityAccumulator::start();
    let runtime_timing = accumulator.timing();
    let mut trace = vec!["V3Config05ManifestPublished", "V3Server03HttpRequestRaw"];
    let mut standardized = match C::build_standardized(raw) {
        Ok(standardized) => standardized,
        Err(error) => {
            trace.push(C::STANDARDIZED_STAGE);
            return error_output(
                runtime_source(C::STANDARDIZED_STAGE, error),
                trace,
                &crate::hooks::register_responses_direct_hooks(),
            );
        }
    };
    trace.push(C::STANDARDIZED_STAGE);
    let direct_failure_session_scope = C::failure_session_scope(&control, &standardized);
    let availability = provider_health.session_bound_availability(&direct_failure_session_scope);
    let target = V3TargetInterpreter::default();
    let routing_facts = C::router_facts(&standardized, manifest);
    let router = V3VirtualRouter::process_shared();
    let classified = match router.classify_request_with_facts(
        manifest,
        C::server_id(&standardized),
        C::endpoint(&standardized),
        routing_facts,
    ) {
        Ok(value) => value,
        Err(error) => {
            return error_output(
                runtime_source("V3Router05RequestClassified", error),
                trace,
                &crate::hooks::register_responses_direct_hooks(),
            )
        }
    };
    trace.push("V3Router05RequestClassified");
    let plan = match router.resolve_route_pool_plan(manifest, classified) {
        Ok(value) => value,
        Err(error) => {
            return error_output(
                crate::shared::v3_route_plan_error_source(
                    "V3Router06RoutePoolResolved",
                    "v3_route_target_runtime_failure",
                    error,
                ),
                trace,
                &crate::hooks::register_responses_direct_hooks(),
            )
        }
    };
    trace.push("V3Router06RoutePoolResolved");
    let hit = match router.hit_opaque_target_plan_once(plan, 0) {
        Ok(value) => value,
        Err(error) => {
            return error_output(
                runtime_source("V3Router07OpaqueTargetHitOnce", error),
                trace,
                &crate::hooks::register_responses_direct_hooks(),
            )
        }
    };
    trace.push("V3Router07OpaqueTargetHitOnce");
    let kind = target.classify_kind(hit);
    trace.push("V3Target08KindClassified");
    let expanded = match target.expand_candidates(manifest, kind, 0) {
        Ok(value) => value,
        Err(error) => {
            return error_output(
                runtime_source("V3Target09CandidateSetExpanded", error),
                trace,
                &crate::hooks::register_responses_direct_hooks(),
            )
        }
    };
    trace.push("V3Target09CandidateSetExpanded");
    let mut failed_candidates = BTreeSet::new();
    let mut same_candidate_retries = BTreeMap::<String, usize>::new();
    let mut retry_selected: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected> = None;
    let mut provider_failure_events = Vec::<V3RuntimeProviderFailureObservation>::new();
    let mut send_attempts = 0usize;
    let mut pending_provider_action_recovery = None;
    let allowed_modes =
        direct_runtime_allowed_execution_modes(manifest, C::server_id(&standardized));
    loop {
        let selected = match retry_selected.take() {
            Some(selected) => selected,
            None => match select_v3_target_with_session_then_global(
                &target,
                expanded.clone(),
                &availability,
                &provider_health,
                &failed_candidates,
                now_epoch_ms,
            ) {
                Ok(value) => value,
                Err(error) => {
                    return error_output(
                        build_v3_error_01_source_raised(
                            V3ErrorSourceKind::TargetPoolExhausted,
                            "V3Target10ConcreteProviderSelected",
                            "selected_target_exhausted",
                            format!("{} candidates unavailable", error.attempted_candidates.len()),
                        ),
                        trace,
                        &crate::hooks::register_responses_direct_hooks(),
                    )
                }
            },
        };
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
                transport_label,
                None,
                "in_progress",
                provider_failure_events.clone(),
                false,
            );
            observability.attempts = Some(total_attempts(&accumulator, send_attempts));
            sink(&observability);
        }
        let decision = match build_v3_execution_11_protocol_decision_from_v3_target_10(
            selected.clone(),
            C::ENTRY_PROTOCOL,
            &allowed_modes,
        ) {
            Ok(decision) => decision,
            Err(source) => {
                trace.push("V3Execution11ProtocolDecision");
                return error_output(
                    source,
                    trace,
                    &crate::hooks::register_responses_direct_hooks(),
                );
            }
        };
        trace.push("V3Execution11ProtocolDecision");
        if !matches!(
            decision.mode,
            V3Execution11ProtocolDecisionMode::SameProtocolDirect
        ) {
            return relay_handoff_output(
                decision.target,
                expanded.clone(),
                failed_candidates.clone(),
                trace,
                provider_failure_events.clone(),
                accumulator.with_additional_attempts(send_attempts),
            );
        }
        let server_id = C::server_id(&standardized).to_string();
        let request_id = C::request_id(&standardized).to_string();
        if let Err(source) = C::prepare_before_send(
            &mut control,
            manifest,
            &server_id,
            &mut standardized,
            &request_id,
            now_epoch_ms,
            &mut trace,
        ) {
            return error_output(
                source,
                trace,
                &crate::hooks::register_responses_direct_hooks(),
            );
        }
        let policy = C::run_route(selected.clone(), &standardized);
        trace.push(C::POLICY_STAGE);
        let wire = match C::run_request_projection(&policy) {
            Ok(value) => value,
            Err(source) => {
                return error_output(
                    source,
                    trace,
                    &crate::hooks::register_responses_direct_hooks(),
                )
            }
        };
        trace.push("V3Provider12ResponsesWirePayload");
        let transport_request = match C::run_provider_transport(wire) {
            Ok(value) => value,
            Err(source) => {
                return error_output(
                    source,
                    trace,
                    &crate::hooks::register_responses_direct_hooks(),
                )
            }
        };
        trace.push("V3Transport13ResponsesHttpRequest");
        let mut provider_action_permit: Option<crate::provider_action_gate::V3ProviderActionPermit> =
            None;
        if let Some(recovery) = pending_provider_action_recovery.take() {
            match provider_health
                .wait_for_error05_recovery(&recovery, &selected)
                .await
            {
                Ok(V3ProviderActionRecoveryTransition::Admitted(mut admission)) => {
                    provider_action_permit = admission.take_permit();
                    trace.push("V3ProviderActionGateAdmission");
                }
                Ok(V3ProviderActionRecoveryTransition::Superseded(ticket)) => {
                    pending_provider_action_recovery = match ticket.recovery_witness() {
                        Ok(witness) => Some(witness),
                        Err(error) => {
                            return error_output(
                                runtime_source("V3ProviderActionGateAdmission", error),
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
                            return error_output(
                                runtime_source("V3ProviderActionGateAdmission", error),
                                trace,
                                &crate::hooks::register_responses_direct_hooks(),
                            )
                        }
                    };
                    retry_selected = Some(selected);
                    trace.push("V3ProviderActionGateTerminalReevaluation");
                    continue;
                }
                Err(error) => {
                    return error_output(
                        runtime_source("V3ProviderActionGateAdmission", error),
                        trace,
                        &crate::hooks::register_responses_direct_hooks(),
                    )
                }
            }
        }
        send_attempts = send_attempts.saturating_add(1);
        if let Err(error) = runtime_timing.start_external() {
            return error_output(
                runtime_source("V3RuntimeTimingExternal", error),
                trace,
                &crate::hooks::register_responses_direct_hooks(),
            );
        }
        let provider_raw = match transport.send(transport_request).await {
            Ok(raw) => raw,
            Err(error) => {
                if let Err(timing_error) = runtime_timing.finish_external() {
                    return error_output(
                        runtime_source("V3RuntimeTimingExternal", timing_error),
                        trace,
                        &crate::hooks::register_responses_direct_hooks(),
                    );
                }
                let source = build_v3_provider_error_source(
                    "V3Transport13ResponsesHttpRequest",
                    error,
                );
                drop(provider_action_permit.take());
                let policy_result = match run_v3_direct_provider_failure_policy(
                    &V3DirectProviderFailurePolicyContext {
                        failure_session_scope: &direct_failure_session_scope,
                        provider_health: &provider_health,
                        run_error: C::run_error,
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
                    Err(source) => {
                        return error_output(
                            source,
                            trace,
                            &crate::hooks::register_responses_direct_hooks(),
                        )
                    }
                };
                if let Some(event) = policy_result.event.clone() {
                    provider_failure_events.push(event.clone());
                    publish_v3_direct_provider_failure_event(
                        provider_failure_event_sink,
                        C::policy_target(&policy),
                        "json",
                        Some(event.status),
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
                            "json",
                            policy_result.event.as_ref().map(|event| event.status),
                            "failed",
                            provider_failure_events.clone(),
                            false,
                        );
                        observability.attempts =
                            Some(total_attempts(&accumulator, send_attempts));
                        let projected =
                            V3ErrorHandlingCenter::project_terminal(policy_result.decision);
                        return projected_error_output_with_observability(
                            projected,
                            trace,
                            Some(observability),
                        );
                    }
                    V3Error05ExecutionAction::ClientDisconnected => {
                        return projected_error_output_with_observability(
                            V3ErrorHandlingCenter::project_terminal(policy_result.decision),
                            trace,
                            None,
                        );
                    }
                    V3Error05ExecutionAction::RejectNonProviderError => {
                        return error_output(
                            runtime_source(
                                "V3Error05ExecutionDecision",
                                "provider failure entered a non-provider Error05 lane",
                            ),
                            trace,
                            &crate::hooks::register_responses_direct_hooks(),
                        )
                    }
                }
            }
        };
        trace.push("V3ProviderResp14Raw");
        if provider_raw.status() >= 400 {
            if let Err(timing_error) = runtime_timing.finish_external() {
                return error_output(
                    runtime_source("V3RuntimeTimingExternal", timing_error),
                    trace,
                    &crate::hooks::register_responses_direct_hooks(),
                );
            }
            let source = build_v3_error_01_source_raised_external(
                V3ErrorSourceKind::ProviderFailure,
                "V3ProviderResp14Raw",
                format!("provider_http_{}", provider_raw.status()),
                format!(
                    "provider {} returned {}",
                    provider_raw.provider_id(),
                    provider_raw.status()
                ),
                V3ExternalErrorLink {
                    kind: V3ExternalErrorKind::Provider,
                    status: Some(provider_raw.status()),
                    code: Some(format!("HTTP_{}", provider_raw.status())),
                    provider_id: Some(provider_raw.provider_id().to_string()),
                    upstream_request_id: None,
                    message: Some(format!("provider returned HTTP {}", provider_raw.status())),
                },
            );
            drop(provider_action_permit.take());
            let policy_result = match run_v3_direct_provider_failure_policy(
                &V3DirectProviderFailurePolicyContext {
                    failure_session_scope: &direct_failure_session_scope,
                    provider_health: &provider_health,
                    run_error: C::run_error,
                    availability: &availability,
                    expanded: Some(&expanded),
                    provider_pinned: false,
                    now_epoch_ms,
                },
                C::policy_target(&policy),
                source,
                provider_raw.status(),
                &mut V3DirectProviderFailurePolicyState {
                    failed_candidates: &mut failed_candidates,
                    same_candidate_retries: &mut same_candidate_retries,
                    trace: &mut trace,
                },
            )
            .await
            {
                Ok(result) => result,
                Err(source) => {
                    return error_output(
                        source,
                        trace,
                        &crate::hooks::register_responses_direct_hooks(),
                    )
                }
            };
            if let Some(event) = policy_result.event.clone() {
                provider_failure_events.push(event.clone());
                publish_v3_direct_provider_failure_event(
                    provider_failure_event_sink,
                    C::policy_target(&policy),
                    "json",
                    Some(event.status),
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
                        "json",
                        Some(provider_raw.status()),
                        "failed",
                        provider_failure_events.clone(),
                        false,
                    );
                    observability.attempts = Some(total_attempts(&accumulator, send_attempts));
                    let projected = V3ErrorHandlingCenter::project_terminal(policy_result.decision);
                    return projected_error_output_with_observability(
                        projected,
                        trace,
                        Some(observability),
                    );
                }
            }
        }
        let provider_status = provider_raw.status();
        let mut response_projection = match C::run_response_projection(provider_raw).await {
            Ok(projection) => projection,
            Err(source) => {
                if let Err(error) = runtime_timing.finish_external() {
                    return error_output(
                        runtime_source("V3RuntimeTimingExternal", error),
                        trace,
                        &crate::hooks::register_responses_direct_hooks(),
                    );
                }
                drop(provider_action_permit.take());
                let policy_result = match run_v3_direct_provider_failure_policy(
                    &V3DirectProviderFailurePolicyContext {
                        failure_session_scope: &direct_failure_session_scope,
                        provider_health: &provider_health,
                        run_error: C::run_error,
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
                    Err(source) => {
                        return error_output(
                            source,
                            trace,
                            &crate::hooks::register_responses_direct_hooks(),
                        )
                    }
                };
                if let Some(event) = policy_result.event.clone() {
                    provider_failure_events.push(event.clone());
                    publish_v3_direct_provider_failure_event(
                        provider_failure_event_sink,
                        C::policy_target(&policy),
                        "json",
                        Some(event.status),
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
                            "json",
                            policy_result.event.as_ref().map(|event| event.status),
                            "failed",
                            provider_failure_events.clone(),
                            false,
                        );
                        observability.attempts =
                            Some(total_attempts(&accumulator, send_attempts));
                        let projected =
                            V3ErrorHandlingCenter::project_terminal(policy_result.decision);
                        return projected_error_output_with_observability(
                            projected,
                            trace,
                            Some(observability),
                        );
                    }
                }
            }
        };
        if let Err(commit_error) = C::commit_after_response(
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
        if provider_status < 400 {
            if let Err(error) = record_v3_direct_provider_success(
                &provider_health,
                &direct_failure_session_scope,
                C::policy_target(&policy),
                now_epoch_ms,
            ) {
                return error_output(
                    error,
                    trace,
                    &crate::hooks::register_responses_direct_hooks(),
                );
            }
        }
        let mut observability = build_v3_direct_runtime_observability(
            C::policy_target(&policy),
            "json",
            Some(provider_status),
            "completed",
            provider_failure_events.clone(),
            false,
        );
        observability.attempts = Some(total_attempts(&accumulator, send_attempts));
        // 成功路径从未结束 external 计时（错误路径才会 finish_external），
        // 这里必须先收口 external，否则 finish_runtime 报 external active。
        let _ = runtime_timing.finish_external();
        if let Ok(summary) = runtime_timing.finish_runtime() {
            observability.timing = Some(summary);
        }
        return V3ResponsesDirectRuntimeOutput {
            client_payload: response_projection.client_payload,
            node_trace: trace,
            error_chain: None,
            observability: Some(observability),
            stream_observation: None,
            protocol_relay_handoff: None,
        };
    }
}
