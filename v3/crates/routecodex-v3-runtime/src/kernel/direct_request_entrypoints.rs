// Request-scope entry and guard transfer for the resident Direct kernel.
// Included by kernel.rs; no routing, payload projection, or response decision.

async fn execute_v3_responses_direct_runtime_kernel_core<T: ResponsesTransport + ?Sized>(
    mut state: V3ResponsesDirectRuntimeCoreState,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    hook_registry: V3HookRegistry,
    transport: &T,
) -> V3ResponsesDirectRuntimeOutput {
    let control = match resolve_v3_direct_request_execution_control(
        state.request_execution_control.take(),
        manifest,
        &raw.server_id,
        &raw.request_id,
        "responses",
    ) {
        Ok(control) => control,
        Err(source) => return error_output(source, Vec::new(), &hook_registry),
    };
    let finalizer = match control.take_request_finalizer() {
        Ok(finalizer) => finalizer,
        Err(error) => {
            return error_output(
                runtime_source("V3ExecutionAttemptBudget", error),
                Vec::new(),
                &hook_registry,
            );
        }
    };
    let output = execute_v3_responses_direct_runtime_kernel_core_resident(
        state,
        manifest,
        raw,
        hook_registry,
        transport,
        control,
    )
    .await;
    finish_direct_request_scope(output, finalizer)
}

/// Public Runtime consumer entry that runs the Responses Direct kernel with an
/// already-created request execution control. The caller owns the request
/// identity; the kernel consumes the captured JSON through the REQ02 SDK.
pub async fn execute_v3_responses_direct_runtime_kernel_with_transport_and_request_control<
    T: ResponsesTransport + ?Sized,
>(
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    hook_registry: V3HookRegistry,
    transport: &T,
    request_execution_control: V3RequestExecutionControl,
) -> V3ResponsesDirectRuntimeOutput {
    let finalizer = match request_execution_control.take_request_finalizer() {
        Ok(finalizer) => finalizer,
        Err(error) => {
            return error_output(
                runtime_source("V3ExecutionAttemptBudget", error),
                Vec::new(),
                &hook_registry,
            );
        }
    };
    let output = execute_v3_responses_direct_runtime_kernel_core_resident(
        V3ResponsesDirectRuntimeCoreState::new()
            .with_provider_health(
                V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(manifest),
            ),
        manifest,
        raw,
        hook_registry,
        transport,
        request_execution_control,
    )
    .await;
    finish_direct_request_scope(output, finalizer)
}
