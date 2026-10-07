use super::{V3HubExecutionMode, V3HubProviderWireProtocol, V3HubReqTarget06Resolved};
use crate::operation_runner::{project_canonical_request, AttemptContext, V3RequestContextHandle};
use crate::projection_drop_log::V3ProjectionDropRecord;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqOutbound07ProviderSemantic {
    pub(crate) previous: V3HubReqTarget06Resolved,
    pub(crate) provider_protocol: V3HubProviderWireProtocol,
    standard_payload: Value,
    /// Stage-3 standard-projection drops produced by the single Req07 facade.
    /// They travel as a typed side channel; Provider Compat consumes them and
    /// never rebuilds the standard payload to rediscover what was dropped.
    standard_projection_drops: Vec<V3ProjectionDropRecord>,
    attempt: AttemptContext,
}

/// The single Req07 assembler. It consumes the request's canonical payload plus
/// the same request-local typed resources (original inverse/current
/// associations/history and an explicit attempt identity) and delegates the
/// standard projection to the verified `project_canonical_request` facade.
///
/// The facade returns the provider payload and the typed attempt context
/// separately; the context stays unpublished until the transport attempt
/// actually succeeds.
pub fn build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
    input: V3HubReqTarget06Resolved,
    canonical: &Value,
    request_handle: &V3RequestContextHandle,
    execution_mode: V3HubExecutionMode,
    attempt_id: &str,
    provider_protocol: V3HubProviderWireProtocol,
) -> Result<V3HubReqOutbound07ProviderSemantic, String> {
    let selected = &input.selected_target;
    let pair = request_handle.original_pair()?;
    let current = request_handle.current_field_associations()?;
    let projected = project_canonical_request(
        canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
        execution_mode,
        provider_protocol,
        selected,
        attempt_id,
    )?;
    Ok(V3HubReqOutbound07ProviderSemantic {
        previous: input,
        provider_protocol,
        standard_payload: projected.payload,
        standard_projection_drops: projected.drops,
        attempt: projected.attempt,
    })
}

impl V3HubReqOutbound07ProviderSemantic {
    pub fn standard_payload(&self) -> &Value {
        &self.standard_payload
    }

    /// Read-only alias for the facade-produced standard payload. It is a
    /// projection-free accessor kept for existing fixtures; it never rebuilds
    /// or rebinds control facts.
    pub fn provider_semantic_payload(&self) -> &Value {
        &self.standard_payload
    }

    /// Typed standard-projection drops produced alongside the payload by the
    /// single Req07 facade. Provider Compat forwards these to the request-scope
    /// drop sink; it never rebuilds them from the payload or logs.
    pub(crate) fn standard_projection_drops(&self) -> &[V3ProjectionDropRecord] {
        &self.standard_projection_drops
    }

    /// Typed declaration context for the attempt that produced this payload.
    /// Runtime publishes it only after the attempt actually succeeds.
    pub fn attempt_context(&self) -> &AttemptContext {
        &self.attempt
    }

    pub(crate) fn selected_target(&self) -> &routecodex_v3_target::V3TargetCandidate {
        &self.previous.selected_target
    }
}
