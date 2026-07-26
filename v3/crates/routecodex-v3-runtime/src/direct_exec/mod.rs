use super::*;

pub(super) async fn execute_v3_responses_direct_runtime_kernel_core_stages<
    T: ResponsesTransport,
>(
    state: V3ResponsesDirectRuntimeCoreState<'_>,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    hook_registry: V3HookRegistry,
    transport: &T,
) -> V3ResponsesDirectRuntimeOutput {
    let mut trace = vec!["V3Config05ManifestPublished", "V3Server03HttpRequestRaw"];
    require_static_hooks(&hook_registry);
    let V3ResponsesDirectRuntimeCoreState {
        continuation_state,
        continuation_scope,
        now_epoch_ms,
        provider_health,
        initial_selected_target,
        initial_expanded,
        initial_plan_trace,
    } = state;

    let mut standardized = build_v3_req_04_standardized_responses_from_v3_server_03(raw);
    trace.push("V3Req04StandardizedResponses");
    if let Some(plan_trace) = initial_plan_trace {
        // Router05..Target09 already ran in the Server-side protocol plan;
        // splice those nodes so the client-visible trace stays identical to
        // the unplanned path without re-entering the Router.
        trace.extend(plan_trace);
    }
    if let Some(key) = crate::hub_v1::find_v3_hub_side_channel_key(&standardized.body) {
        return error_output(
            runtime_source(
                "V3Req04StandardizedResponses",
                format!("RouteCodex side-channel field {key} cannot enter request payload"),
            ),
            trace,
            &hook_registry,
        );
    }
    if let Err(error) = apply_v3_responses_direct_stopless_request_hook(&mut standardized.body) {
        return error_output(
            runtime_source("V3HubReqChatProcess04Governed", error),
            trace,
            &hook_registry,
        );
    }
    let previous_response_id = standardized
        .body
        .get("previous_response_id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let pinned = match (
        &previous_response_id,
        continuation_state,
        continuation_scope.as_ref(),
    ) {
        (Some(response_id), Some(state), Some(scope)) => {
            let locator = match state.store.lock() {
                Ok(store) => store
                    .load_for_req03(response_id, &scope.key, now_epoch_ms)
                    .cloned(),
                Err(error) => {
                    return error_output(
                        runtime_source("V3HubReqContinuation03Classified", error),
                        trace,
                        &hook_registry,
                    )
                }
            };
            match locator {
                Ok(locator) => {
                    trace.push("V3HubReqContinuation03Classified");
                    Some(locator)
                }
                Err(error) => {
                    return error_output(
                        runtime_source("V3HubReqContinuation03Classified", error),
                        trace,
                        &hook_registry,
                    )
                }
            }
        }
        (Some(_), _, _) => {
            return error_output(
                runtime_source(
                    "V3HubReqContinuation03Classified",
                    "continuation state/scope missing",
                ),
                trace,
                &hook_registry,
            )
        }
        _ => None,
    };
    if previous_response_id.is_some() && initial_selected_target.is_some() {
        return error_output(
            runtime_source(
                "V3Execution11ProtocolDecision",
                "direct continuation must be resolved from Req03 owner store, not from a non-continuation preselected target",
            ),
            trace,
            &hook_registry,
        );
    }

    let target = V3TargetInterpreter::default();
    let provider_health =
        provider_health.unwrap_or_else(|| V3ProviderFailureRuntimeHealth::from_manifest(manifest));
    let availability = provider_health.clone();
    let mut pinned_selected = if let Some(locator) = pinned {
        let candidate = match target.resolve_exact_provider_model_auth(
            manifest,
            &locator.pin().provider_id,
            &locator.pin().model_id,
            &locator.pin().auth_handle_id,
        ) {
            Ok(candidate) => candidate,
            Err(error) => {
                return error_output(
                    runtime_source("V3HubReqTarget06Resolved", error),
                    trace,
                    &hook_registry,
                )
            }
        };
        let current_capability_revision = match capability_revision_for_pin(manifest, locator.pin())
        {
            Ok(revision) => revision,
            Err(error) => {
                return error_output(
                    runtime_source("V3HubReqTarget06Resolved", error),
                    trace,
                    &hook_registry,
                )
            }
        };
        if let Err(error) = locator.validate_capability_revision(&current_capability_revision) {
            return error_output(
                runtime_source("V3HubReqTarget06Resolved", error),
                trace,
                &hook_registry,
            );
        }
        if !availability
            .availability(
                &candidate.provider_id,
                Some(&candidate.auth_alias),
                Some(&candidate.model_id),
                now_epoch_ms,
            )
            .available
        {
            return error_output(
                runtime_source("V3HubReqTarget06Resolved", "pinned provider unavailable"),
                trace,
                &hook_registry,
            );
        }
        trace.push("V3HubReqTarget06Resolved");
        let routing_group_id = match continuation_scope.as_ref() {
            Some(scope) => scope.key.routing_group.clone(),
            None => {
                return error_output(
                    runtime_source(
                        "V3HubReqTarget06Resolved",
                        "continuation scope missing after Req03 classification",
                    ),
                    trace,
                    &hook_registry,
                )
            }
        };
        Some(routecodex_v3_target::V3Target10ConcreteProviderSelected {
            route: routecodex_v3_virtual_router::V3Router07OpaqueTargetHitOnce {
                server_id: standardized.protocol_context.server_id.clone(),
                routing_group_id,
                pool_id: "continuation_exact_pin".to_string(),
                target_index: 0,
                target_kind: routecodex_v3_config::V3RouteTargetKind::ProviderModel,
                target_id: None,
                target_plan: Vec::new(),
                request_client_model: None,
                request_capabilities: BTreeSet::new(),
                hit_count: 1,
            },
            candidate,
            unavailable_candidates: Vec::new(),
            attempts: 1,
            default_floor_protected: false,
        })
    } else {
        None
    };
    let initial_selected_target_present = initial_selected_target.is_some();
    let expanded = if let Some(initial_expanded) = initial_expanded {
        // Server-side protocol plan already ran Router05..Target09; reuse its
        // candidate set for in-Target reselection instead of re-entering the
        // Router.
        Some(initial_expanded)
    } else if pinned_selected.is_none() && !initial_selected_target_present {
        let routing_facts = build_v3_router_request_facts_from_v3_req_04(&standardized);
        let router = V3VirtualRouter::process_shared();
        let classified = match router.classify_request_with_facts(
            manifest,
            &standardized.protocol_context.server_id,
            &standardized.protocol_context.endpoint,
            routing_facts,
        ) {
            Ok(value) => value,
            Err(error) => {
                return error_output(
                    runtime_source("V3Router05RequestClassified", error),
                    trace,
                    &hook_registry,
                )
            }
        };
        trace.push("V3Router05RequestClassified");
        let plan = match router.resolve_route_pool_plan(manifest, classified) {
            Ok(value) => value,
            Err(error) => {
                return error_output(
                    runtime_source("V3Router06RoutePoolResolved", error),
                    trace,
                    &hook_registry,
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
                    &hook_registry,
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
                    &hook_registry,
                )
            }
        };
        trace.push("V3Target09CandidateSetExpanded");
        Some(expanded)
    } else {
        None
    };
    let mut failed_candidates = BTreeSet::new();
    let mut same_candidate_retries = BTreeMap::<String, usize>::new();
    let mut retry_selected: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected> = None;
    let mut initial_selected_target = initial_selected_target;
    let mut provider_failure_events = Vec::<V3RuntimeProviderFailureObservation>::new();
    loop {
        let attempt_availability = V3RuntimeAttemptAvailability {
            base: &availability,
            failed_candidates: &failed_candidates,
        };
        let selected = match pinned_selected.take() {
            Some(selected) => selected,
            None => match initial_selected_target.take() {
                Some(selected) => selected,
                None => match retry_selected.take() {
                    Some(selected) => selected,
                    None => match target.select_available(
                        match expanded.as_ref() {
                            Some(expanded) => expanded.clone(),
                            None => {
                                return error_output(
                                    runtime_source(
                                        "V3Target09CandidateSetExpanded",
                                        "routed candidate set missing",
                                    ),
                                    trace,
                                    &hook_registry,
                                )
                            }
                        },
                        &attempt_availability,
                        0,
                    ) {
                        Ok(value) => value,
                        Err(error) => {
                            return error_output(
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
                                &hook_registry,
                            )
                        }
                    },
                },
            },
        };
        if previous_response_id.is_none() {
            trace.push("V3Target10ConcreteProviderSelected");
        }
        let decision = match build_v3_execution_11_protocol_decision_from_v3_target_10(
            selected.clone(),
            "responses",
            &["direct".to_string()],
        ) {
            Ok(decision) => decision,
            Err(source) => {
                trace.push("V3Execution11ProtocolDecision");
                return error_output(source, trace, &hook_registry);
            }
        };
        trace.push("V3Execution11ProtocolDecision");
        if !matches!(
            decision.mode,
            V3Execution11ProtocolDecisionMode::SameProtocolDirect
        ) {
            return error_output(
                runtime_source(
                    "V3Execution11ProtocolDecision",
                    "Responses Direct can only consume same-protocol Responses providers",
                ),
                trace,
                &hook_registry,
            );
        }

        let selected_pin = V3RemoteContinuationPin::new(
            selected.candidate.provider_id.clone(),
            selected.candidate.model_id.clone(),
            selected.candidate.auth_alias.clone(),
        );
        let selected_capability_revision =
            match capability_revision_for_pin(manifest, &selected_pin) {
                Ok(revision) => revision,
                Err(error) => {
                    return error_output(
                        runtime_source("V3HubRespContinuation04Committed", error),
                        trace,
                        &hook_registry,
                    )
                }
            };
        let policy = hook_registry.run_route(selected, &standardized);
        trace.push("V3ResponsesDirect11Policy");

        let wire = match hook_registry.run_request_projection(&policy) {
            Ok(value) => value,
            Err(source) => {
                if let Err(error) = release_terminal_failure_locator(
                    continuation_state,
                    previous_response_id.as_deref(),
                ) {
                    return error_output(
                        runtime_source("V3HubRespContinuation04Committed", error),
                        trace,
                        &hook_registry,
                    );
                }
                if previous_response_id.is_some() {
                    trace.push("V3HubRespContinuation04Committed");
                }
                return error_output(source, trace, &hook_registry);
            }
        };
        trace.push("V3Provider12ResponsesWirePayload");

        let transport_request = match hook_registry.run_provider_transport(wire) {
            Ok(value) => value,
            Err(source) => {
                if let Err(error) = release_terminal_failure_locator(
                    continuation_state,
                    previous_response_id.as_deref(),
                ) {
                    return error_output(
                        runtime_source("V3HubRespContinuation04Committed", error),
                        trace,
                        &hook_registry,
                    );
                }
                if previous_response_id.is_some() {
                    trace.push("V3HubRespContinuation04Committed");
                }
                return error_output(source, trace, &hook_registry);
            }
        };
        trace.push("V3Transport13ResponsesHttpRequest");

        let provider_raw = match transport.send(transport_request).await {
            Ok(raw) => raw,
            Err(error) => {
                let source =
                    build_v3_provider_error_source("V3Transport13ResponsesHttpRequest", error);
                if previous_response_id.is_some() {
                    if let Err(health_error) = record_v3_direct_provider_failure(
                        &provider_health,
                        &policy.target,
                        &source,
                        now_epoch_ms,
                    ) {
                        return error_output(health_error, trace, &hook_registry);
                    }
                    if let Err(release_error) = release_terminal_failure_locator(
                        continuation_state,
                        previous_response_id.as_deref(),
                    ) {
                        return error_output(
                            runtime_source("V3HubRespContinuation04Committed", release_error),
                            trace,
                            &hook_registry,
                        );
                    }
                    trace.push("V3HubRespContinuation04Committed");
                    return error_output(source, trace, &hook_registry);
                }
                let policy_result = match run_v3_direct_provider_failure_policy(
                    &V3DirectProviderFailurePolicyContext {
                        provider_health: &provider_health,
                        hook_registry: &hook_registry,
                        availability: &availability,
                        expanded: expanded.as_ref(),
                        now_epoch_ms,
                    },
                    &policy.target,
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
                    Err(source) => return error_output(source, trace, &hook_registry),
                };
                provider_failure_events.push(policy_result.event.clone());
                match policy_result.decision {
                    V3DirectProviderFailureDecision::Reselect => continue,
                    V3DirectProviderFailureDecision::RetrySame(selected) => {
                        retry_selected = Some(*selected);
                        continue;
                    }
                    V3DirectProviderFailureDecision::Project(projected) => {
                        let observability = build_v3_direct_runtime_observability(
                            &policy.target,
                            "json",
                            Some(policy_result.event.status),
                            "failed",
                            provider_failure_events.clone(),
                        );
                        return projected_error_output_with_observability(
                            *projected,
                            trace,
                            Some(observability),
                        );
                    }
                }
            }
        };
        let provider_status = provider_raw.status();
        trace.push("V3ProviderResp14Raw");

        let mut response_projection =
            match hook_registry.run_response_projection(provider_raw).await {
                Ok(projection) => projection,
                Err(source) => {
                    if !matches!(source.source_kind, V3ErrorSourceKind::ProviderFailure) {
                        if let Err(error) = release_terminal_failure_locator(
                            continuation_state,
                            previous_response_id.as_deref(),
                        ) {
                            return error_output(
                                runtime_source("V3HubRespContinuation04Committed", error),
                                trace,
                                &hook_registry,
                            );
                        }
                        if previous_response_id.is_some() {
                            trace.push("V3HubRespContinuation04Committed");
                        }
                        return error_output(source, trace, &hook_registry);
                    }
                    if previous_response_id.is_some() {
                        if let Err(health_error) = record_v3_direct_provider_failure(
                            &provider_health,
                            &policy.target,
                            &source,
                            now_epoch_ms,
                        ) {
                            return error_output(health_error, trace, &hook_registry);
                        }
                        if should_release_direct_locator_for_provider_failure(&source) {
                            if let Err(error) = release_terminal_failure_locator(
                                continuation_state,
                                previous_response_id.as_deref(),
                            ) {
                                return error_output(
                                    runtime_source("V3HubRespContinuation04Committed", error),
                                    trace,
                                    &hook_registry,
                                );
                            }
                            trace.push("V3HubRespContinuation04Committed");
                        }
                        return error_output(source, trace, &hook_registry);
                    }
                    let policy_result = match run_v3_direct_provider_failure_policy(
                        &V3DirectProviderFailurePolicyContext {
                            provider_health: &provider_health,
                            hook_registry: &hook_registry,
                            availability: &availability,
                            expanded: expanded.as_ref(),
                            now_epoch_ms,
                        },
                        &policy.target,
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
                        Err(source) => return error_output(source, trace, &hook_registry),
                    };
                    provider_failure_events.push(policy_result.event.clone());
                    match policy_result.decision {
                        V3DirectProviderFailureDecision::Reselect => continue,
                        V3DirectProviderFailureDecision::RetrySame(selected) => {
                            retry_selected = Some(*selected);
                            continue;
                        }
                        V3DirectProviderFailureDecision::Project(projected) => {
                            let observability = build_v3_direct_runtime_observability(
                                &policy.target,
                                "json",
                                Some(policy_result.event.status),
                                "failed",
                                provider_failure_events.clone(),
                            );
                            return projected_error_output_with_observability(
                                *projected,
                                trace,
                                Some(observability),
                            );
                        }
                    }
                }
            };
        trace.push("V3DirectResp14ProviderProjectionPrepared");
        if let V3RemoteContinuationObservation::Streaming { state } =
            &response_projection.remote_continuation
        {
            let stream_observation = V3RuntimeStreamObservation::default();
            let body = std::mem::replace(
                &mut response_projection.client_payload.body,
                V3ClientBody::Bytes(Vec::new()),
            );
            response_projection.client_payload.body = match body {
                V3ClientBody::Sse(stream) => {
                    let stream = wrap_direct_sse_provider_event_json_observation_stream(
                        stream,
                        stream_observation.clone(),
                    );
                    V3ClientBody::Sse(stream)
                }
                other => other,
            };
            if let (Some(continuation_state), Some(scope)) =
                (continuation_state, continuation_scope.as_ref())
            {
                let body = std::mem::replace(
                    &mut response_projection.client_payload.body,
                    V3ClientBody::Bytes(Vec::new()),
                );
                response_projection.client_payload.body = match body {
                    V3ClientBody::Sse(stream) => {
                        let policy = V3DirectSseRemoteContinuationPolicy {
                            state: continuation_state.clone(),
                            scope_key: scope.key.clone(),
                            previous_response_id: previous_response_id.clone(),
                            selected_pin: selected_pin.clone(),
                            selected_capability_revision: selected_capability_revision.clone(),
                            now_epoch_ms,
                            committed_pending: false,
                        };
                        V3ClientBody::Sse(wrap_direct_sse_remote_continuation_stream(
                            stream,
                            state.clone(),
                            policy,
                        ))
                    }
                    other => other,
                };
            }
            if let Err(source) =
                record_v3_direct_provider_success(&provider_health, &policy.target, now_epoch_ms)
            {
                return error_output(source, trace, &hook_registry);
            }
            trace.push("V3DirectResp15ClientPayloadReady");
            trace.push("V3Resp15ClientPayload");

            return V3ResponsesDirectRuntimeOutput {
                observability: Some(build_v3_direct_runtime_observability(
                    &policy.target,
                    v3_direct_client_transport_label(&response_projection.client_payload),
                    Some(provider_status),
                    "streaming",
                    provider_failure_events.clone(),
                )),
                stream_observation: Some(stream_observation),
                client_payload: response_projection.client_payload,
                node_trace: trace,
                error_chain: None,
            };
        }
        if let (Some(state), Some(scope)) = (continuation_state, continuation_scope.as_ref()) {
            let pending_response_id = match &response_projection.remote_continuation {
                V3RemoteContinuationObservation::Pending { response_id } => {
                    Some(response_id.clone())
                }
                V3RemoteContinuationObservation::Terminal => None,
                V3RemoteContinuationObservation::Streaming { .. } => unreachable!(
                    "streaming Responses continuation is handled before material lifecycle"
                ),
            };
            let lifecycle_changed = previous_response_id.is_some() || pending_response_id.is_some();
            if lifecycle_changed {
                if let Some(response_id) = pending_response_id {
                    let locator = V3RemoteContinuationLocator::new_direct(
                        response_id,
                        scope.key.clone(),
                        selected_pin,
                        selected_capability_revision,
                        now_epoch_ms,
                        now_epoch_ms + REMOTE_CONTINUATION_TTL_MS,
                    );
                    let input = V3RemoteContinuationCommitInput::locator_only(locator);
                    let mut store = match state.store.lock() {
                        Ok(store) => store,
                        Err(error) => {
                            return error_output(
                                runtime_source("V3HubRespContinuation04Committed", error),
                                trace,
                                &hook_registry,
                            )
                        }
                    };
                    let commit = match previous_response_id.as_deref() {
                        Some(previous_response_id) => {
                            store.rebind_for_resp04(previous_response_id, input)
                        }
                        None => store.commit(input),
                    };
                    if let Err(error) = commit {
                        return error_output(
                            runtime_source("V3HubRespContinuation04Committed", error),
                            trace,
                            &hook_registry,
                        );
                    }
                } else if let Some(previous_response_id) = previous_response_id.as_deref() {
                    let mut store = match state.store.lock() {
                        Ok(store) => store,
                        Err(error) => {
                            return error_output(
                                runtime_source("V3HubRespContinuation04Committed", error),
                                trace,
                                &hook_registry,
                            )
                        }
                    };
                    if !store.release(previous_response_id) {
                        return error_output(
                            runtime_source(
                                "V3HubRespContinuation04Committed",
                                format!(
                                    "terminal locator {previous_response_id} was not present at Resp04 release"
                                ),
                            ),
                            trace,
                            &hook_registry,
                        );
                    }
                }
                trace.push("V3HubRespContinuation04Committed");
            }
        }
        if let Err(source) =
            record_v3_direct_provider_success(&provider_health, &policy.target, now_epoch_ms)
        {
            return error_output(source, trace, &hook_registry);
        }
        trace.push("V3DirectResp15ClientPayloadReady");
        trace.push("V3Resp15ClientPayload");

        return V3ResponsesDirectRuntimeOutput {
            observability: Some(build_v3_direct_runtime_observability(
                &policy.target,
                v3_direct_client_transport_label(&response_projection.client_payload),
                Some(provider_status),
                "completed",
                provider_failure_events.clone(),
            )),
            stream_observation: None,
            client_payload: response_projection.client_payload,
            node_trace: trace,
            error_chain: None,
        };
    }
}
