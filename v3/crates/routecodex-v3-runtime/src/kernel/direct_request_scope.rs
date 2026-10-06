use crate::operation_runner::{
    project_canonical_request, AttemptContext, CurrentFieldAssociations, RequestInverseContext,
    RequestInvocationContext,
};
use routecodex_v3_error::{build_v3_error_01_source_raised_internal, V3InternalErrorCode};
use routecodex_v3_target::V3Target10ConcreteProviderSelected;

/// Replace the raw standardized body with the canonical request built from the
/// already-captured client JSON. Planning and projection then read only the
/// canonical request; the raw body is replaced, not kept as a parallel truth.
pub(crate) fn canonical_body_from_captured(
    standardized: &crate::nodes::V3Req04StandardizedResponses,
    control: &crate::nodes::V3RequestExecutionControl,
    request_entry_origin: V3DirectEntryOrigin,
) -> Result<serde_json::Value, V3Error01SourceRaised> {
    build_v3_direct_request_canonical_from_captured(
        control,
        &standardized.request_id,
        standardized.body.clone(),
        request_entry_origin,
    )
}

/// Build the canonical request from the already-captured client JSON through
/// the REQ02 registered SDK entry, then seed the current field associations
/// exactly once on the same request handle. `request_entry_origin` is the
/// explicit entry origin supplied by the caller: ordinary client entry
/// normalizes the raw wire, a Relay->Direct handoff consumes the pair the Relay
/// phase already published on this request scope.
pub(crate) fn build_v3_direct_request_canonical_from_captured(
    control: &crate::nodes::V3RequestExecutionControl,
    request_id: &str,
    raw: serde_json::Value,
    request_entry_origin: V3DirectEntryOrigin,
) -> Result<serde_json::Value, V3Error01SourceRaised> {
    let handle = control.request_context();
    let entry_protocol = match handle.entry_protocol() {
        "responses" => crate::hub_v1::V3HubEntryProtocol::Responses,
        "openai_chat" | "chat" => crate::hub_v1::V3HubEntryProtocol::OpenAiChat,
        "anthropic" => crate::hub_v1::V3HubEntryProtocol::Anthropic,
        "gemini" => crate::hub_v1::V3HubEntryProtocol::Gemini,
        other => {
            return Err(direct_request_view_error(format!(
                "Direct request entry protocol `{other}` is unsupported"
            )))
        }
    };
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        format!("{request_id}:direct-entry"),
        format!("{request_id}:direct-entry-attempt"),
        request_entry_origin.request_origin_kind(),
    );
    let req01 = crate::hub_v1::build_v3_hub_req_inbound_01_client_raw(
        raw,
        entry_protocol,
        crate::hub_v1::V3HubInvocationSource::Client,
        crate::hub_v1::V3HubTransportIntent::Json,
    );
    let normalized = crate::hub_v1::build_v3_hub_req_inbound_02_from_request_invocation(
        req01, &invocation,
    )
    .map_err(direct_request_view_error)?;
    crate::hub_v1::govern_v3_operation_runner_current_request_fields(
        normalized.payload(),
        &invocation,
        &[],
    )
    .map_err(direct_request_view_error)
}

/// The registered Direct request working view: native provider payload plus the
/// real attempt context produced by the single canonical projection owner, and
/// the request-local typed source references (immutable inverse + current field
/// associations) that the actual declaration emitter consumes. Origins are
/// resolved from these references, never from emitted names, schemas, models,
/// or a post-hoc re-search of the produced payload.
pub struct V3DirectRequestProjectionView {
    pub payload: serde_json::Value,
    pub attempt: AttemptContext,
    pub inverse: RequestInverseContext,
    pub current: CurrentFieldAssociations,
}

/// Build the Direct native working view from the current canonical request and
/// the same request-local original pair. The native payload is a separate value
/// from canonical; it is never written back as canonical truth.
pub(crate) fn build_v3_direct_request_projection_view(
    canonical: &serde_json::Value,
    selected: &V3Target10ConcreteProviderSelected,
    invocation: &RequestInvocationContext,
    attempt_id: &str,
) -> Result<V3DirectRequestProjectionView, V3Error01SourceRaised> {
    let handle = invocation.request_handle();
    let pair = handle
        .original_pair()
        .map_err(|error| direct_request_view_error(error))?;
    let current = handle
        .current_field_associations()
        .map_err(|error| direct_request_view_error(error))?;
    let provider_protocol =
        crate::hub_v1::provider_wire_protocol_for_selected_candidate(&selected.candidate)
            .map_err(direct_request_view_error)?;
    let projection = project_canonical_request(
        canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
        crate::hub_v1::V3HubExecutionMode::Direct,
        provider_protocol,
        &selected.candidate,
        attempt_id,
    )
    .map_err(|error| {
        build_v3_error_01_source_raised_internal(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Provider12ResponsesWirePayload",
            "direct_request_view_projection_failed",
            error,
            V3InternalErrorCode::V3Provider12ResponsesWirePayload,
        )
    })?;
    Ok(V3DirectRequestProjectionView {
        payload: projection.payload,
        attempt: projection.attempt,
        inverse: pair.inverse_context.clone(),
        current: current.clone(),
    })
}

fn direct_request_view_error(error: String) -> V3Error01SourceRaised {
    build_v3_error_01_source_raised_internal(
        V3ErrorSourceKind::RuntimeFailure,
        "V3Provider12ResponsesWirePayload",
        "direct_request_view_resolution_failed",
        error,
        V3InternalErrorCode::V3Provider12ResponsesWirePayload,
    )
}

fn finish_direct_request_scope(
    mut output: V3ResponsesDirectRuntimeOutput,
    finalizer: crate::operation_runner::V3RequestFinalizerGuard,
) -> V3ResponsesDirectRuntimeOutput {
    if let Some(handoff) = output.protocol_relay_handoff.as_ref() {
        match handoff
            .request_execution_control
            .restore_request_finalizer_for_handoff(finalizer)
        {
            Ok(()) => return output,
            Err((finalizer, error)) => {
                let mut failure = error_output(
                    runtime_source("V3ExecutionAttemptBudget", error),
                    output.node_trace,
                    &crate::hooks::register_responses_direct_hooks(),
                );
                failure.request_finalizer = Some(finalizer);
                return failure;
            }
        }
    }
    output.client_payload.body = match output.client_payload.body {
        V3ClientBody::CommittedSse(stream) => {
            V3ClientBody::CommittedSse(stream.with_request_finalizer(Some(finalizer)))
        }
        body => {
            output.request_finalizer = Some(finalizer);
            body
        }
    };
    output
}
