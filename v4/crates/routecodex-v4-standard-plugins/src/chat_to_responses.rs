use routecodex_v4_cordis_bridge::ExecCtx;
// Independent source lane entry; production wiring remains forbidden here.
// Candidate scope is verified independently from production dispatch.
// Gate input closure is recorded before integration.
// Boundary gate executable is part of the candidate contract.
// The entry preserves Hub request semantics; control signals stay in the carrier.

pub fn chat_to_responses_entry(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    super::request_plugins::chat_to_responses(ctx)
}

pub use super::request_plugins::project_chat_request_to_responses;
