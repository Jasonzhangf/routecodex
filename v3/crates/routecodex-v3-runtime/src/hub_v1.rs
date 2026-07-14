use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum V3HubEntryProtocol {
    Responses,
    Anthropic,
    Gemini,
    OpenAiChat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubContinuationOwnership {
    New,
    RemoteProviderOwned,
    RouteCodexLocalOwned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubExecutionMode {
    Direct,
    Relay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubProviderWireProtocol {
    Responses,
    Anthropic,
    Gemini,
    OpenAiChat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubTargetResolution {
    Routed,
    Pinned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubInvocationSource {
    Client,
    ServertoolFollowup,
    DryRun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubTransportIntent {
    Json,
    Sse,
}

#[derive(Debug, Clone, PartialEq)]
struct V3HubOpaquePayload(Value);

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqInbound01ClientRaw {
    payload: V3HubOpaquePayload,
    entry_protocol: V3HubEntryProtocol,
    invocation_source: V3HubInvocationSource,
    transport_intent: V3HubTransportIntent,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqInbound02Normalized {
    previous: V3HubReqInbound01ClientRaw,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqContinuation03Classified {
    previous: V3HubReqInbound02Normalized,
    continuation: V3HubContinuationOwnership,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqChatProcess04Governed {
    previous: V3HubReqContinuation03Classified,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqExecution05Planned {
    previous: V3HubReqChatProcess04Governed,
    execution: V3HubExecutionMode,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqTarget06Resolved {
    previous: V3HubReqExecution05Planned,
    target_resolution: V3HubTargetResolution,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqOutbound07ProviderSemantic {
    previous: V3HubReqTarget06Resolved,
    provider_protocol: V3HubProviderWireProtocol,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3ProviderReqOutbound08WirePayload {
    previous: V3HubReqOutbound07ProviderSemantic,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3ProviderReqOutbound09TransportRequest {
    previous: V3ProviderReqOutbound08WirePayload,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3ProviderRespInbound01Raw {
    payload: V3HubOpaquePayload,
    entry_protocol: V3HubEntryProtocol,
    provider_protocol: V3HubProviderWireProtocol,
    continuation: V3HubContinuationOwnership,
    execution: V3HubExecutionMode,
    invocation_source: V3HubInvocationSource,
    transport_intent: V3HubTransportIntent,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespInbound02Normalized {
    previous: V3ProviderRespInbound01Raw,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespChatProcess03Governed {
    previous: V3HubRespInbound02Normalized,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubContinuationCommit {
    None,
    RemoteBinding,
    LocalContext,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespContinuation04Committed {
    previous: V3HubRespChatProcess03Governed,
    action: V3HubContinuationCommit,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespOutbound05ClientSemantic {
    previous: V3HubRespContinuation04Committed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3ServerRespOutbound06ClientFrame {
    previous: V3HubRespOutbound05ClientSemantic,
}

pub fn build_v3_hub_req_inbound_01_client_raw(
    payload: Value,
    entry_protocol: V3HubEntryProtocol,
    invocation_source: V3HubInvocationSource,
    transport_intent: V3HubTransportIntent,
) -> V3HubReqInbound01ClientRaw {
    V3HubReqInbound01ClientRaw {
        payload: V3HubOpaquePayload(payload),
        entry_protocol,
        invocation_source,
        transport_intent,
    }
}

pub fn build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(
    input: V3HubReqInbound01ClientRaw,
) -> V3HubReqInbound02Normalized {
    V3HubReqInbound02Normalized { previous: input }
}

pub fn build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02(
    input: V3HubReqInbound02Normalized,
    continuation: V3HubContinuationOwnership,
) -> V3HubReqContinuation03Classified {
    V3HubReqContinuation03Classified {
        previous: input,
        continuation,
    }
}

pub fn build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03(
    input: V3HubReqContinuation03Classified,
) -> V3HubReqChatProcess04Governed {
    V3HubReqChatProcess04Governed { previous: input }
}

pub fn build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
    input: V3HubReqChatProcess04Governed,
    execution: V3HubExecutionMode,
) -> V3HubReqExecution05Planned {
    V3HubReqExecution05Planned {
        previous: input,
        execution,
    }
}

pub fn build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
    input: V3HubReqExecution05Planned,
    target_resolution: V3HubTargetResolution,
) -> V3HubReqTarget06Resolved {
    V3HubReqTarget06Resolved {
        previous: input,
        target_resolution,
    }
}

pub fn build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
    input: V3HubReqTarget06Resolved,
    provider_protocol: V3HubProviderWireProtocol,
) -> V3HubReqOutbound07ProviderSemantic {
    V3HubReqOutbound07ProviderSemantic {
        previous: input,
        provider_protocol,
    }
}

pub fn build_v3_provider_req_outbound_08_from_v3_hub_req_outbound_07(
    input: V3HubReqOutbound07ProviderSemantic,
) -> V3ProviderReqOutbound08WirePayload {
    V3ProviderReqOutbound08WirePayload { previous: input }
}

pub fn build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(
    input: V3ProviderReqOutbound08WirePayload,
) -> V3ProviderReqOutbound09TransportRequest {
    V3ProviderReqOutbound09TransportRequest { previous: input }
}

pub fn build_v3_provider_resp_inbound_01_raw(
    payload: Value,
    entry_protocol: V3HubEntryProtocol,
    provider_protocol: V3HubProviderWireProtocol,
    continuation: V3HubContinuationOwnership,
    execution: V3HubExecutionMode,
    invocation_source: V3HubInvocationSource,
    transport_intent: V3HubTransportIntent,
) -> V3ProviderRespInbound01Raw {
    V3ProviderRespInbound01Raw {
        payload: V3HubOpaquePayload(payload),
        entry_protocol,
        provider_protocol,
        continuation,
        execution,
        invocation_source,
        transport_intent,
    }
}

pub fn build_v3_hub_resp_inbound_02_from_v3_provider_resp_inbound_01(
    input: V3ProviderRespInbound01Raw,
) -> V3HubRespInbound02Normalized {
    V3HubRespInbound02Normalized { previous: input }
}

pub fn build_v3_hub_resp_chat_process_03_from_v3_hub_resp_inbound_02(
    input: V3HubRespInbound02Normalized,
) -> V3HubRespChatProcess03Governed {
    V3HubRespChatProcess03Governed { previous: input }
}

pub fn build_v3_hub_resp_continuation_04_from_v3_hub_resp_chat_process_03(
    input: V3HubRespChatProcess03Governed,
    action: V3HubContinuationCommit,
) -> V3HubRespContinuation04Committed {
    V3HubRespContinuation04Committed {
        previous: input,
        action,
    }
}

pub fn build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(
    input: V3HubRespContinuation04Committed,
) -> V3HubRespOutbound05ClientSemantic {
    V3HubRespOutbound05ClientSemantic { previous: input }
}

pub fn build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(
    input: V3HubRespOutbound05ClientSemantic,
) -> V3ServerRespOutbound06ClientFrame {
    V3ServerRespOutbound06ClientFrame { previous: input }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum V3HubHookSlot {
    ReqInboundNormalize,
    ReqContinuationClassify,
    ReqChatProcess,
    ReqExecutionPlan,
    ReqTargetResolve,
    ReqProviderSemantic,
    ProviderWireBuild,
    ProviderTransport,
    RespInboundNormalize,
    RespChatProcess,
    RespContinuationCommit,
    RespClientProject,
    ServerFrame,
}

impl V3HubHookSlot {
    pub const ALL: [Self; 13] = [
        Self::ReqInboundNormalize,
        Self::ReqContinuationClassify,
        Self::ReqChatProcess,
        Self::ReqExecutionPlan,
        Self::ReqTargetResolve,
        Self::ReqProviderSemantic,
        Self::ProviderWireBuild,
        Self::ProviderTransport,
        Self::RespInboundNormalize,
        Self::RespChatProcess,
        Self::RespContinuationCommit,
        Self::RespClientProject,
        Self::ServerFrame,
    ];
}

pub const V3_HUB_V1_HOOK_SLOT_COUNT: usize = V3HubHookSlot::ALL.len();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubHookImplementation {
    NotImplemented,
}

#[derive(Debug, Clone, Copy)]
pub struct V3HubHookDeclaration {
    pub hook_id: &'static str,
    pub slot: V3HubHookSlot,
    pub input_node: &'static str,
    pub output_node: &'static str,
    implementation: V3HubHookImplementation,
    callback: fn() -> Result<(), V3HubHookError>,
}

impl PartialEq for V3HubHookDeclaration {
    fn eq(&self, other: &Self) -> bool {
        self.hook_id == other.hook_id
            && self.slot == other.slot
            && self.input_node == other.input_node
            && self.output_node == other.output_node
            && self.implementation == other.implementation
    }
}

impl Eq for V3HubHookDeclaration {}

impl V3HubHookDeclaration {
    pub fn implementation(&self) -> V3HubHookImplementation {
        self.implementation
    }

    pub fn invoke(&self) -> Result<(), V3HubHookError> {
        (self.callback)()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("hub_v1 hook is not implemented: {hook_id}")]
pub struct V3HubHookError {
    pub hook_id: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum V3HubStartupError {
    #[error("missing hook for slot {slot:?}")]
    MissingHook { slot: V3HubHookSlot },
    #[error("duplicate hook for slot {slot:?}")]
    DuplicateHook { slot: V3HubHookSlot },
    #[error("unknown hook {hook_id}")]
    UnknownHook { hook_id: &'static str },
    #[error("hook {hook_id} is incompatible with slot {slot:?}")]
    IncompatibleHook {
        hook_id: &'static str,
        slot: V3HubHookSlot,
    },
    #[error("configured Hub v1 manifest is invalid: {reason}")]
    ConfiguredManifest { reason: String },
}

fn not_implemented_req_inbound_normalize() -> Result<(), V3HubHookError> {
    Err(V3HubHookError {
        hook_id: "hub_v1.req_inbound_normalize.not_implemented",
    })
}
fn not_implemented_req_continuation_classify() -> Result<(), V3HubHookError> {
    Err(V3HubHookError {
        hook_id: "hub_v1.req_continuation_classify.not_implemented",
    })
}
fn not_implemented_req_chat_process() -> Result<(), V3HubHookError> {
    Err(V3HubHookError {
        hook_id: "hub_v1.req_chat_process.not_implemented",
    })
}
fn not_implemented_req_execution_plan() -> Result<(), V3HubHookError> {
    Err(V3HubHookError {
        hook_id: "hub_v1.req_execution_plan.not_implemented",
    })
}
fn not_implemented_req_target_resolve() -> Result<(), V3HubHookError> {
    Err(V3HubHookError {
        hook_id: "hub_v1.req_target_resolve.not_implemented",
    })
}
fn not_implemented_req_provider_semantic() -> Result<(), V3HubHookError> {
    Err(V3HubHookError {
        hook_id: "hub_v1.req_provider_semantic.not_implemented",
    })
}
fn not_implemented_provider_wire_build() -> Result<(), V3HubHookError> {
    Err(V3HubHookError {
        hook_id: "hub_v1.provider_wire_build.not_implemented",
    })
}
fn not_implemented_provider_transport() -> Result<(), V3HubHookError> {
    Err(V3HubHookError {
        hook_id: "hub_v1.provider_transport.not_implemented",
    })
}
fn not_implemented_resp_inbound_normalize() -> Result<(), V3HubHookError> {
    Err(V3HubHookError {
        hook_id: "hub_v1.resp_inbound_normalize.not_implemented",
    })
}
fn not_implemented_resp_chat_process() -> Result<(), V3HubHookError> {
    Err(V3HubHookError {
        hook_id: "hub_v1.resp_chat_process.not_implemented",
    })
}
fn not_implemented_resp_continuation_commit() -> Result<(), V3HubHookError> {
    Err(V3HubHookError {
        hook_id: "hub_v1.resp_continuation_commit.not_implemented",
    })
}
fn not_implemented_resp_client_project() -> Result<(), V3HubHookError> {
    Err(V3HubHookError {
        hook_id: "hub_v1.resp_client_project.not_implemented",
    })
}
fn not_implemented_server_frame() -> Result<(), V3HubHookError> {
    Err(V3HubHookError {
        hook_id: "hub_v1.server_frame.not_implemented",
    })
}

static V3_HUB_V1_STATIC_HOOKS: [V3HubHookDeclaration; V3_HUB_V1_HOOK_SLOT_COUNT] = [
    hook(
        "hub_v1.req_inbound_normalize.not_implemented",
        V3HubHookSlot::ReqInboundNormalize,
        not_implemented_req_inbound_normalize,
    ),
    hook(
        "hub_v1.req_continuation_classify.not_implemented",
        V3HubHookSlot::ReqContinuationClassify,
        not_implemented_req_continuation_classify,
    ),
    hook(
        "hub_v1.req_chat_process.not_implemented",
        V3HubHookSlot::ReqChatProcess,
        not_implemented_req_chat_process,
    ),
    hook(
        "hub_v1.req_execution_plan.not_implemented",
        V3HubHookSlot::ReqExecutionPlan,
        not_implemented_req_execution_plan,
    ),
    hook(
        "hub_v1.req_target_resolve.not_implemented",
        V3HubHookSlot::ReqTargetResolve,
        not_implemented_req_target_resolve,
    ),
    hook(
        "hub_v1.req_provider_semantic.not_implemented",
        V3HubHookSlot::ReqProviderSemantic,
        not_implemented_req_provider_semantic,
    ),
    hook(
        "hub_v1.provider_wire_build.not_implemented",
        V3HubHookSlot::ProviderWireBuild,
        not_implemented_provider_wire_build,
    ),
    hook(
        "hub_v1.provider_transport.not_implemented",
        V3HubHookSlot::ProviderTransport,
        not_implemented_provider_transport,
    ),
    hook(
        "hub_v1.resp_inbound_normalize.not_implemented",
        V3HubHookSlot::RespInboundNormalize,
        not_implemented_resp_inbound_normalize,
    ),
    hook(
        "hub_v1.resp_chat_process.not_implemented",
        V3HubHookSlot::RespChatProcess,
        not_implemented_resp_chat_process,
    ),
    hook(
        "hub_v1.resp_continuation_commit.not_implemented",
        V3HubHookSlot::RespContinuationCommit,
        not_implemented_resp_continuation_commit,
    ),
    hook(
        "hub_v1.resp_client_project.not_implemented",
        V3HubHookSlot::RespClientProject,
        not_implemented_resp_client_project,
    ),
    hook(
        "hub_v1.server_frame.not_implemented",
        V3HubHookSlot::ServerFrame,
        not_implemented_server_frame,
    ),
];

const fn hook(
    hook_id: &'static str,
    slot: V3HubHookSlot,
    callback: fn() -> Result<(), V3HubHookError>,
) -> V3HubHookDeclaration {
    let (input_node, output_node) = hook_nodes(slot);
    V3HubHookDeclaration {
        hook_id,
        slot,
        input_node,
        output_node,
        implementation: V3HubHookImplementation::NotImplemented,
        callback,
    }
}

const fn hook_nodes(slot: V3HubHookSlot) -> (&'static str, &'static str) {
    match slot {
        V3HubHookSlot::ReqInboundNormalize => {
            ("V3HubReqInbound01ClientRaw", "V3HubReqInbound02Normalized")
        }
        V3HubHookSlot::ReqContinuationClassify => (
            "V3HubReqInbound02Normalized",
            "V3HubReqContinuation03Classified",
        ),
        V3HubHookSlot::ReqChatProcess => (
            "V3HubReqContinuation03Classified",
            "V3HubReqChatProcess04Governed",
        ),
        V3HubHookSlot::ReqExecutionPlan => (
            "V3HubReqChatProcess04Governed",
            "V3HubReqExecution05Planned",
        ),
        V3HubHookSlot::ReqTargetResolve => {
            ("V3HubReqExecution05Planned", "V3HubReqTarget06Resolved")
        }
        V3HubHookSlot::ReqProviderSemantic => (
            "V3HubReqTarget06Resolved",
            "V3HubReqOutbound07ProviderSemantic",
        ),
        V3HubHookSlot::ProviderWireBuild => (
            "V3HubReqOutbound07ProviderSemantic",
            "V3ProviderReqOutbound08WirePayload",
        ),
        V3HubHookSlot::ProviderTransport => (
            "V3ProviderReqOutbound08WirePayload",
            "V3ProviderReqOutbound09TransportRequest",
        ),
        V3HubHookSlot::RespInboundNormalize => {
            ("V3ProviderRespInbound01Raw", "V3HubRespInbound02Normalized")
        }
        V3HubHookSlot::RespChatProcess => (
            "V3HubRespInbound02Normalized",
            "V3HubRespChatProcess03Governed",
        ),
        V3HubHookSlot::RespContinuationCommit => (
            "V3HubRespChatProcess03Governed",
            "V3HubRespContinuation04Committed",
        ),
        V3HubHookSlot::RespClientProject => (
            "V3HubRespContinuation04Committed",
            "V3HubRespOutbound05ClientSemantic",
        ),
        V3HubHookSlot::ServerFrame => (
            "V3HubRespOutbound05ClientSemantic",
            "V3ServerRespOutbound06ClientFrame",
        ),
    }
}

#[derive(Debug, Clone)]
pub struct V3HubStaticHookRegistry {
    manifest: &'static [V3HubHookDeclaration],
}

impl V3HubStaticHookRegistry {
    pub fn manifest(&self) -> &'static [V3HubHookDeclaration] {
        self.manifest
    }
    pub fn hook(&self, slot: V3HubHookSlot) -> Option<&V3HubHookDeclaration> {
        self.manifest.iter().find(|hook| hook.slot == slot)
    }
}

pub fn compile_v3_hub_v1_static_registry() -> Result<V3HubStaticHookRegistry, V3HubStartupError> {
    validate_v3_hub_v1_hook_manifest(&V3_HUB_V1_STATIC_HOOKS)?;
    Ok(V3HubStaticHookRegistry {
        manifest: &V3_HUB_V1_STATIC_HOOKS,
    })
}

pub fn validate_v3_hub_v1_hook_manifest(
    manifest: &[V3HubHookDeclaration],
) -> Result<(), V3HubStartupError> {
    let known = V3_HUB_V1_STATIC_HOOKS
        .iter()
        .map(|hook| (hook.hook_id, hook.slot, hook.input_node, hook.output_node))
        .collect::<BTreeSet<_>>();
    let mut slots = BTreeSet::new();
    for declaration in manifest {
        let Some((_, expected_slot, expected_input, expected_output)) = known
            .iter()
            .find(|(hook_id, _, _, _)| *hook_id == declaration.hook_id)
        else {
            return Err(V3HubStartupError::UnknownHook {
                hook_id: declaration.hook_id,
            });
        };
        if !slots.insert(declaration.slot) {
            return Err(V3HubStartupError::DuplicateHook {
                slot: declaration.slot,
            });
        }
        if declaration.slot != *expected_slot
            || declaration.input_node != *expected_input
            || declaration.output_node != *expected_output
        {
            return Err(V3HubStartupError::IncompatibleHook {
                hook_id: declaration.hook_id,
                slot: declaration.slot,
            });
        }
    }
    for slot in V3HubHookSlot::ALL {
        if !slots.contains(&slot) {
            return Err(V3HubStartupError::MissingHook { slot });
        }
    }
    Ok(())
}

pub fn compile_v3_hub_v1_static_registry_from_config(
    manifest: &routecodex_v3_config::V3HubV1Manifest,
) -> Result<V3HubStaticHookRegistry, V3HubStartupError> {
    if manifest.skeleton != "hub_v1" {
        return Err(V3HubStartupError::ConfiguredManifest {
            reason: "skeleton must be hub_v1".to_string(),
        });
    }
    let protocols = ["responses", "anthropic", "gemini", "openai_chat"];
    if manifest
        .entry_protocols
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        != protocols
    {
        return Err(V3HubStartupError::ConfiguredManifest {
            reason: "entry protocol set does not match compiled static registry".to_string(),
        });
    }
    let registry = compile_v3_hub_v1_static_registry()?;
    let configured = manifest
        .hooks
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let compiled = registry
        .manifest
        .iter()
        .map(|hook| hook.hook_id)
        .collect::<Vec<_>>();
    if configured != compiled {
        return Err(V3HubStartupError::ConfiguredManifest {
            reason: "hook set does not match compiled static registry".to_string(),
        });
    }
    Ok(registry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn all_adjacent_builders_form_the_fixed_typed_topology() {
        let req01 = build_v3_hub_req_inbound_01_client_raw(
            json!({"input":"x"}),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        let req02 = build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(req01);
        let req03 = build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02(
            req02,
            V3HubContinuationOwnership::New,
        );
        let req04 = build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03(req03);
        let req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
            req04,
            V3HubExecutionMode::Direct,
        );
        let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
            req05,
            V3HubTargetResolution::Routed,
        );
        let req07 = build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
            req06,
            V3HubProviderWireProtocol::Responses,
        );
        let req08 = build_v3_provider_req_outbound_08_from_v3_hub_req_outbound_07(req07);
        let _req09 = build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(req08);

        let resp01 = build_v3_provider_resp_inbound_01_raw(
            json!({"output":"x"}),
            V3HubEntryProtocol::Responses,
            V3HubProviderWireProtocol::Responses,
            V3HubContinuationOwnership::New,
            V3HubExecutionMode::Direct,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        let resp02 = build_v3_hub_resp_inbound_02_from_v3_provider_resp_inbound_01(resp01);
        let resp03 = build_v3_hub_resp_chat_process_03_from_v3_hub_resp_inbound_02(resp02);
        let resp04 = build_v3_hub_resp_continuation_04_from_v3_hub_resp_chat_process_03(
            resp03,
            V3HubContinuationCommit::None,
        );
        let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04);
        let _resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);
    }

    #[test]
    fn four_branch_axes_are_independent_values() {
        let facts = (
            V3HubEntryProtocol::Responses,
            V3HubContinuationOwnership::RouteCodexLocalOwned,
            V3HubExecutionMode::Relay,
            V3HubProviderWireProtocol::Gemini,
        );
        assert_eq!(facts.0, V3HubEntryProtocol::Responses);
        assert_eq!(facts.1, V3HubContinuationOwnership::RouteCodexLocalOwned);
        assert_eq!(facts.2, V3HubExecutionMode::Relay);
        assert_eq!(facts.3, V3HubProviderWireProtocol::Gemini);
    }
}
