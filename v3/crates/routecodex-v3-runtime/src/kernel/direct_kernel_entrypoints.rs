pub async fn execute_v3_responses_direct_runtime_kernel_with_default_transport_debug_and_continuation(
    state: &V3ResponsesDirectContinuationState,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    continuation_scope: V3ResponsesDirectContinuationScope,
    hook_registry: V3HookRegistry,
    debug: &V3DebugRuntime,
    now_epoch_ms: u64,
) -> V3ResponsesDirectRuntimeOutput {
    let stopless_control = V3ResponsesDirectStoplessControlState::default();
    let stopless_scope = V3ResponsesDirectStoplessControlScope::from(&continuation_scope);
    execute_v3_responses_direct_runtime_kernel_with_transport_debug_core(
        V3ResponsesDirectRuntimeCoreState::with_continuation(
            state,
            continuation_scope,
            now_epoch_ms,
        )
        .with_stopless_control(&stopless_control, stopless_scope),
        manifest,
        raw,
        hook_registry,
        default_responses_transport(),
        debug,
    )
    .await
}
pub async fn execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug(
    shared_state: V3ResponsesDirectRuntimeSharedState<'_>,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    continuation_scope: V3ResponsesDirectContinuationScope,
    hook_registry: V3HookRegistry,
    debug: &V3DebugRuntime,
    now_epoch_ms: u64,
) -> V3ResponsesDirectRuntimeOutput {
    let stopless_scope = V3ResponsesDirectStoplessControlScope::from(&continuation_scope);
    execute_v3_responses_direct_runtime_kernel_with_transport_debug_core(
        V3ResponsesDirectRuntimeCoreState::with_continuation(
            shared_state.continuation_state,
            continuation_scope,
            now_epoch_ms,
        )
        .with_stopless_control(shared_state.stopless_control, stopless_scope)
        .with_provider_health(shared_state.provider_health)
        .with_provider_failure_event_sink(shared_state.provider_failure_event_sink.clone())
        .with_route_selection_event_sink(shared_state.route_selection_event_sink.clone()),
        manifest,
        raw,
        hook_registry,
        default_responses_transport(),
        debug,
    )
    .await
}
pub async fn execute_v3_responses_direct_runtime_kernel_with_shared_state_default_transport_debug_and_initial_target(
    shared_state: V3ResponsesDirectRuntimeSharedState<'_>,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    continuation_scope: V3ResponsesDirectContinuationScope,
    hook_registry: V3HookRegistry,
    debug: &V3DebugRuntime,
    now_epoch_ms: u64,
    initial_plan: &V3ResponsesProtocolExecutionPlan,
    observability_accumulator: Option<V3RuntimeObservabilityAccumulator>,
) -> V3ResponsesDirectRuntimeOutput {
    let stopless_scope = V3ResponsesDirectStoplessControlScope::from(&continuation_scope);
    execute_v3_responses_direct_runtime_kernel_with_transport_debug_core(
        V3ResponsesDirectRuntimeCoreState::with_continuation(
            shared_state.continuation_state,
            continuation_scope,
            now_epoch_ms,
        )
        .with_stopless_control(shared_state.stopless_control, stopless_scope)
        .with_provider_health(shared_state.provider_health)
        .with_provider_failure_event_sink(shared_state.provider_failure_event_sink.clone())
        .with_route_selection_event_sink(shared_state.route_selection_event_sink.clone())
        .with_initial_plan(initial_plan)
        .with_observability_accumulator(observability_accumulator),
        manifest,
        raw,
        hook_registry,
        default_responses_transport(),
        debug,
    )
    .await
}
include!("direct_protocol_plan.rs");
pub async fn execute_v3_responses_direct_runtime_kernel<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    hook_registry: V3HookRegistry,
    transport: &T,
) -> V3ResponsesDirectRuntimeOutput {
    execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::no_continuation(),
        manifest,
        raw,
        hook_registry,
        transport,
    )
    .await
}
pub async fn execute_v3_responses_direct_runtime_kernel_with_continuation<T: ResponsesTransport>(
    state: &V3ResponsesDirectContinuationState,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    scope: V3ResponsesDirectContinuationScope,
    hook_registry: V3HookRegistry,
    transport: &T,
    now_epoch_ms: u64,
) -> V3ResponsesDirectRuntimeOutput {
    let stopless_control = V3ResponsesDirectStoplessControlState::default();
    execute_v3_responses_direct_runtime_kernel_with_continuation_and_stopless_control(
        state,
        &stopless_control,
        manifest,
        raw,
        scope,
        hook_registry,
        transport,
        now_epoch_ms,
    )
    .await
}
pub async fn execute_v3_responses_direct_runtime_kernel_with_continuation_and_stopless_control<
    T: ResponsesTransport,
>(
    state: &V3ResponsesDirectContinuationState,
    stopless_control: &V3ResponsesDirectStoplessControlState,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    scope: V3ResponsesDirectContinuationScope,
    hook_registry: V3HookRegistry,
    transport: &T,
    now_epoch_ms: u64,
) -> V3ResponsesDirectRuntimeOutput {
    let stopless_scope = V3ResponsesDirectStoplessControlScope::from(&scope);
    execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::with_continuation(state, scope, now_epoch_ms)
            .with_stopless_control(stopless_control, stopless_scope),
        manifest,
        raw,
        hook_registry,
        transport,
    )
    .await
}
