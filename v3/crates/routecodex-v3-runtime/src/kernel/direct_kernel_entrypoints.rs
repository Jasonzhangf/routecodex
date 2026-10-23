pub async fn execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug(
    shared_state: V3ResponsesDirectRuntimeSharedState,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    hook_registry: V3HookRegistry,
    debug: &V3DebugRuntime,
    now_epoch_ms: u64,
) -> V3ResponsesDirectRuntimeOutput {
    execute_v3_responses_direct_runtime_kernel_with_refill(
        shared_state,
        manifest,
        raw,
        hook_registry,
        debug,
        now_epoch_ms,
        None,
        None,
        None,
    )
    .await
}
pub async fn execute_v3_responses_direct_runtime_kernel_with_shared_state_default_transport_debug_and_initial_target(
    shared_state: V3ResponsesDirectRuntimeSharedState,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    hook_registry: V3HookRegistry,
    debug: &V3DebugRuntime,
    now_epoch_ms: u64,
    initial_plan: &V3ResponsesProtocolExecutionPlan,
    observability_accumulator: Option<V3RuntimeObservabilityAccumulator>,
    request_execution_control: Option<V3RequestExecutionControl>,
) -> V3ResponsesDirectRuntimeOutput {
    execute_v3_responses_direct_runtime_kernel_with_refill(
        shared_state,
        manifest,
        raw,
        hook_registry,
        debug,
        now_epoch_ms,
        Some(initial_plan),
        observability_accumulator,
        request_execution_control,
    )
    .await
}

async fn execute_v3_responses_direct_runtime_kernel_with_refill(
    shared_state: V3ResponsesDirectRuntimeSharedState,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    hook_registry: V3HookRegistry,
    debug: &V3DebugRuntime,
    now_epoch_ms: u64,
    initial_plan: Option<&V3ResponsesProtocolExecutionPlan>,
    observability_accumulator: Option<V3RuntimeObservabilityAccumulator>,
    request_execution_control: Option<V3RequestExecutionControl>,
) -> V3ResponsesDirectRuntimeOutput {
    let control = match request_execution_control.clone() {
        Some(control) => control,
        None => {
            match crate::nodes::V3RequestExecutionControl::from_manifest(manifest, &raw.server_id) {
                Ok(control) => control,
                Err(error) => {
                    return direct_runtime_helpers_stream::source_failure_output(
                        direct_runtime_helpers_stream::runtime_source(
                            "V3ExecutionAttemptBudget",
                            error.to_string(),
                        ),
                        None,
                        vec![
                            "V3Config05ManifestPublished",
                            "V3Server03HttpRequestRaw",
                            "V3Req04StandardizedResponses",
                        ],
                        &hook_registry,
                    )
                }
            }
        }
    };

    let max_refills = crate::hub_v1::v3_chat_process_refill_max_consecutive();
    let owned_plan = initial_plan.cloned();
    let mut payload = raw.body.clone();
    let mut accumulated_items: Vec<Value> = Vec::new();
    let mut accumulated_usage: Option<crate::hub_v1::V3RuntimeUsageSummary> = None;
    let mut accumulated_attempts: Option<usize> = None;
    let mut delivered_sse_frames: Vec<Vec<u8>> = Vec::new();
    let mut synthesized_output_index: usize = 0;
    let mut rounds = 0usize;

    loop {
        let mut round_raw = raw.clone();
        round_raw.body = payload.clone();

        let plan_for_round = owned_plan.as_ref().map(|plan| {
            let mut plan = plan.clone();
            if rounds > 0 {
                // The original client execution owns the route-policy commit.
                // A refill must not commit the same pending transaction twice.
                plan._route_policy_pending = None;
            }
            plan
        });

        let mut state = V3ResponsesDirectRuntimeCoreState::new()
            .with_now_epoch_ms(now_epoch_ms)
            .with_provider_health(shared_state.provider_health.clone())
            .with_provider_failure_event_sink(shared_state.provider_failure_event_sink.clone())
            .with_route_selection_event_sink(shared_state.route_selection_event_sink.clone())
            .with_client_frame_sink(shared_state.client_frame_sink.clone())
            .with_request_execution_control(Some(control.clone()));
        if rounds == 0 {
            state = state.with_observability_accumulator(observability_accumulator.clone());
        }
        if let Some(plan) = plan_for_round.as_ref() {
            state = state.with_initial_plan(plan);
        }

        let mut output = execute_v3_responses_direct_runtime_kernel_with_transport_debug_core(
            state,
            manifest,
            round_raw,
            hook_registry,
            default_responses_transport(),
            debug,
        )
        .await;

        if let Some(attempts) = output
            .observability
            .as_ref()
            .and_then(|observability| observability.attempts)
        {
            accumulated_attempts = Some(accumulated_attempts.unwrap_or(0).saturating_add(attempts));
        }

        let deliver_immediately = output.error_chain.is_some()
            || output.terminal_disposition.is_some()
            || output.protocol_relay_handoff.is_some();

        // Gather one typed disposition from the single shared policy owner.
        // Direct has no Resp03 stage, so the raw-provider facts come from the
        // JSON snapshot or the buffered raw SSE observation before synthesis.
        let (facts, finalized_response, is_sse) = match &output.client_payload.body {
            V3ClientBody::Json(body) => {
                let response_completed =
                    body.get("status").and_then(Value::as_str).map(str::trim) == Some("completed");
                let has_source_summary = output
                    .provider_response_snapshot
                    .as_ref()
                    .and_then(|snapshot| snapshot.get("body"))
                    .map(|body| crate::hub_v1::has_v3_source_explicit_nonempty_summary(body))
                    .unwrap_or(false);
                (
                    V3ResponsesDirectRefillFacts {
                        tool_calls: crate::hub_v1::collect_v3_governed_response_tool_calls(body),
                        has_source_summary,
                        response_completed,
                    },
                    Some(body.clone()),
                    false,
                )
            }
            V3ClientBody::CommittedSse(_) => {
                let raw = output
                    .stream_observation
                    .as_ref()
                    .and_then(|observation| observation.snapshot().ok())
                    .map(|snapshot| snapshot.provider_raw_sse)
                    .unwrap_or_default();
                let raw_facts =
                    direct_runtime_helpers_stream::inspect_direct_sse_raw_provider(&raw);
                (
                    V3ResponsesDirectRefillFacts {
                        tool_calls: raw_facts.tool_calls,
                        has_source_summary: raw_facts.has_source_summary,
                        response_completed: raw_facts.response_completed,
                    },
                    raw_facts.finalized_response,
                    true,
                )
            }
            _ => (V3ResponsesDirectRefillFacts::default(), None, false),
        };

        let signal = V3ResponsesDirectRefillSignal::default();
        signal.publish(&facts, control.refill_used());
        let disposition = signal
            .take()
            .unwrap_or(crate::hub_v1::V3ChatProcessRefillDisposition::Deliver);

        if !deliver_immediately
            && disposition == crate::hub_v1::V3ChatProcessRefillDisposition::RequestRefill
        {
            if let Some(finalized) = finalized_response.as_ref() {
                if let Ok(next_payload) =
                    crate::hub_v1::build_v3_chat_process_refill_continuation_request(
                        &payload, finalized,
                    )
                {
                    if control.deadline_unix_ms().is_ok() && control.try_admit_refill(max_refills) {
                        control.begin_refill_execution();
                        crate::hub_v1::accumulate_v3_chat_process_refill_usage(
                            &mut accumulated_usage,
                            crate::hub_v1::extract_v3_runtime_usage_summary(finalized),
                        );
                        accumulated_items.extend(
                            crate::hub_v1::collect_v3_chat_process_business_output_items(finalized),
                        );

                        if is_sse {
                            if let V3ClientBody::CommittedSse(stream) = std::mem::replace(
                                &mut output.client_payload.body,
                                V3ClientBody::Bytes(Vec::new()),
                            ) {
                                let chunks = collect_direct_committed_sse(stream).await;
                                let segments =
                                    direct_runtime_helpers_stream::split_direct_sse_committed_chunks(
                                        &chunks,
                                    );
                                append_direct_sse_intermediate_content(
                                    &segments,
                                    finalized,
                                    &mut delivered_sse_frames,
                                    &mut synthesized_output_index,
                                );
                            }
                        }

                        payload = next_payload;
                        rounds += 1;
                        continue;
                    }
                }
            }
        }

        // No further execution: deliver the current real result. Fold the final
        // round into the accumulated chain before writing it back.
        if rounds > 0 {
            if let Some(finalized) = finalized_response.as_ref() {
                crate::hub_v1::accumulate_v3_chat_process_refill_usage(
                    &mut accumulated_usage,
                    crate::hub_v1::extract_v3_runtime_usage_summary(finalized),
                );
            }

            match &output.client_payload.body {
                V3ClientBody::Json(_) => {
                    if let V3ClientBody::Json(mut body) = std::mem::replace(
                        &mut output.client_payload.body,
                        V3ClientBody::Bytes(Vec::new()),
                    ) {
                        crate::hub_v1::merge_v3_chat_process_refill_output_items(
                            &mut body,
                            &accumulated_items,
                        );
                        if let Some(usage) = accumulated_usage.as_ref() {
                            crate::hub_v1::write_v3_chat_process_refill_usage(&mut body, usage);
                        }
                        output.client_payload.body = V3ClientBody::Json(body);
                    }
                }
                V3ClientBody::CommittedSse(_) => {
                    if let V3ClientBody::CommittedSse(stream) = std::mem::replace(
                        &mut output.client_payload.body,
                        V3ClientBody::Bytes(Vec::new()),
                    ) {
                        let chunks = collect_direct_committed_sse(stream).await;
                        let segments =
                            direct_runtime_helpers_stream::split_direct_sse_committed_chunks(
                                &chunks,
                            );
                        for segment in &segments {
                            let is_terminal = segment.value.as_ref().is_some_and(|value| {
                                matches!(
                                    value.get("type").and_then(Value::as_str),
                                    Some(
                                        "response.completed"
                                            | "response.incomplete"
                                            | "response.done"
                                            | "response.failed"
                                    )
                                )
                            });
                            let bytes = if is_terminal {
                                // The terminal response owns the whole
                                // accumulated business list, not just the last
                                // round.
                                direct_runtime_helpers_stream::rewrite_direct_sse_terminal_output_items(
                                    &segment.bytes,
                                    &accumulated_items,
                                    accumulated_usage.as_ref(),
                                )
                            } else {
                                // Prior rounds already occupy indexes
                                // 0..accumulated; do not let this round reuse them.
                                direct_runtime_helpers_stream::shift_direct_sse_output_index(
                                    &segment.bytes,
                                    accumulated_items.len(),
                                )
                            };
                            delivered_sse_frames.push(bytes);
                        }
                        match rebuild_direct_committed_sse(
                            &delivered_sse_frames,
                            control.attempt_budget(),
                        ) {
                            Ok(committed) => {
                                output.client_payload.body = V3ClientBody::CommittedSse(committed);
                            }
                            Err(reason) => {
                                // Assembling the multi-round delivery is the last
                                // local step. A failure here is a real local
                                // failure and must enter the typed Error chain;
                                // it must never ship an empty 200 body as if the
                                // request had succeeded.
                                return direct_runtime_helpers_stream::source_failure_output(
                                    direct_runtime_helpers_stream::runtime_source(
                                        "V3ChatProcessRefillDeliveryAssembly",
                                        reason,
                                    ),
                                    None,
                                    vec![
                                        "V3Config05ManifestPublished",
                                        "V3Server03HttpRequestRaw",
                                        "V3Req04StandardizedResponses",
                                        "V3ChatProcessRefillDeliveryAssembly",
                                    ],
                                    &hook_registry,
                                );
                            }
                        }
                    }
                }
                _ => {}
            }

            if let Some(observability) = output.observability.as_mut() {
                if accumulated_usage.is_some() {
                    observability.usage = accumulated_usage.clone();
                }
                if accumulated_attempts.is_some() {
                    observability.attempts = accumulated_attempts;
                }
            }
        }

        return output;
    }
}

async fn collect_direct_committed_sse(
    mut stream: crate::nodes::V3CommittedClientSseStream,
) -> Vec<Vec<u8>> {
    let mut chunks = Vec::new();
    while let Some(chunk) = stream.next().await {
        chunks.push(chunk);
    }
    chunks
}

fn append_direct_sse_intermediate_content(
    segments: &[direct_runtime_helpers_stream::V3DirectSseFrameSegment],
    finalized: &Value,
    delivered: &mut Vec<Vec<u8>>,
    next_output_index: &mut usize,
) {
    // `next_output_index` is the number of business items already accumulated
    // from earlier rounds. Offset this round's frames so two rounds cannot both
    // claim the same `output_index`.
    let offset = *next_output_index;
    let mut kept = 0usize;
    for segment in segments {
        let is_content = segment.value.as_ref().is_some_and(|value| {
            let Some(event_type) = value.get("type").and_then(Value::as_str) else {
                return false;
            };
            event_type.starts_with("response.output_item.")
                || event_type.starts_with("response.content_part.")
                || event_type == "response.output_text.delta"
        });
        if is_content {
            delivered.push(direct_runtime_helpers_stream::shift_direct_sse_output_index(
                &segment.bytes,
                offset,
            ));
            kept += 1;
        }
    }

    let item_count = crate::hub_v1::collect_v3_chat_process_business_output_items(finalized).len();

    // A provider that streamed only a terminal event still owns real business
    // content. Surface it as output_item events so the client sees one stream
    // with all rounds' text instead of losing the intermediate round.
    if kept == 0 {
        for item in crate::hub_v1::collect_v3_chat_process_business_output_items(finalized) {
            if let Some(frame) =
                direct_runtime_helpers_stream::build_direct_sse_output_item_done_frame(
                    *next_output_index,
                    &item,
                )
            {
                delivered.push(frame);
                *next_output_index += 1;
            }
        }
    } else {
        *next_output_index = offset + item_count;
    }
}

fn rebuild_direct_committed_sse(
    frames: &[Vec<u8>],
    budget: crate::nodes::V3AttemptBudget,
) -> Result<crate::nodes::V3CommittedClientSseStream, String> {
    let mut builder = crate::nodes::V3CommittedClientSseBuilder::with_budget(budget)
        .map_err(|error| format!("failed to open the delivered SSE builder: {error:?}"))?;
    for frame in frames {
        builder
            .push(frame.clone())
            .map_err(|error| format!("failed to append a delivered SSE frame: {error:?}"))?;
    }
    builder
        .mark_last_frame_as_terminal()
        .map_err(|error| format!("failed to mark the delivered SSE terminal: {error:?}"))?;
    builder
        .seal_after_validated_terminal()
        .map_err(|error| format!("failed to seal the delivered SSE stream: {error:?}"))
}

include!("direct_protocol_plan.rs");
pub async fn execute_v3_responses_direct_runtime_kernel<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    hook_registry: V3HookRegistry,
    transport: &T,
) -> V3ResponsesDirectRuntimeOutput {
    execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::new().with_provider_health(
            V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(manifest),
        ),
        manifest,
        raw,
        hook_registry,
        transport,
    )
    .await
}
