use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Config01FileSource {
    pub path: std::path::PathBuf,
    pub raw_toml: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3Config02AuthoringParsed {
    pub version: u16,
    #[serde(default)]
    pub pipelines: V3PipelinesAuthoringConfig,
    pub servers: BTreeMap<String, V3ServerAuthoringConfig>,
    pub providers: BTreeMap<String, V3ProviderAuthoringConfig>,
    #[serde(default)]
    pub forwarders: BTreeMap<String, V3ForwarderAuthoringConfig>,
    pub route_groups: BTreeMap<String, V3RouteGroupAuthoringConfig>,
    #[serde(default)]
    pub features: BTreeMap<String, bool>,
    #[serde(default)]
    pub debug: V3DebugAuthoringConfig,
    #[serde(default)]
    pub error: V3ErrorAuthoringConfig,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3PipelinesAuthoringConfig {
    #[serde(default)]
    pub hub_v1: Option<V3HubV1AuthoringConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3HubV1AuthoringConfig {
    pub skeleton: String,
    pub entry_protocols: Vec<String>,
    pub hook_set_id: String,
    pub entry_protocol_bindings: Vec<V3EntryProtocolBindingAuthoringConfig>,
    pub resources: BTreeMap<String, V3HubResourceAuthoringConfig>,
    pub hooks: Vec<V3HubHookAuthoringConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3EntryProtocolBindingAuthoringConfig {
    pub entry_protocol: String,
    pub endpoint_patterns: Vec<String>,
    pub execution_mode: V3EntryProtocolExecutionMode,
    pub protocol_profile_owner: String,
    pub implemented: bool,
    pub forbidden_reentry_behavior: String,
    #[serde(default)]
    pub runtime_owner_symbol: Option<String>,
    #[serde(default)]
    pub runtime_owner_path: Option<String>,
    #[serde(default)]
    pub pending_owner_symbol: Option<String>,
    #[serde(default)]
    pub pending_owner_path: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum V3EntryProtocolExecutionMode {
    Direct,
    Relay,
    PendingNotImplemented,
}

impl V3EntryProtocolExecutionMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Relay => "relay",
            Self::PendingNotImplemented => "pending_not_implemented",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3HubResourceAuthoringConfig {
    pub kind: V3HubResourceKind,
    pub scope: V3HubResourceScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3HubHookAuthoringConfig {
    pub hook_id: String,
    pub node: V3HubFixedNode,
    pub phase: V3HubHookPhase,
    pub requirement: V3HubHookRequirement,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub priority: i32,
    pub order: u32,
    pub allowed_resources: Vec<String>,
    pub forbidden_resources: Vec<String>,
    #[serde(default)]
    pub profile: Option<V3HubHookProfile>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum V3HubFixedNode {
    V3HubReqInbound01ClientRaw,
    V3HubReqInbound02Normalized,
    V3HubReqContinuation03Classified,
    V3HubReqChatProcess04Governed,
    V3HubReqExecution05Planned,
    V3HubReqTarget06Resolved,
    V3HubReqOutbound07ProviderSemantic,
    ProviderReqCompat06ProviderCompat,
    V3ProviderReqOutbound08WirePayload,
    V3ProviderReqOutbound09TransportRequest,
    V3ProviderRespInbound01Raw,
    ProviderRespCompat02ProviderCompat,
    V3HubRespInbound02Normalized,
    V3HubRespChatProcess03Governed,
    V3HubRespContinuation04Committed,
    V3HubRespOutbound05ClientSemantic,
    V3ServerRespOutbound06ClientFrame,
}

impl V3HubFixedNode {
    pub const ALL: [Self; 17] = [
        Self::V3HubReqInbound01ClientRaw,
        Self::V3HubReqInbound02Normalized,
        Self::V3HubReqContinuation03Classified,
        Self::V3HubReqChatProcess04Governed,
        Self::V3HubReqExecution05Planned,
        Self::V3HubReqTarget06Resolved,
        Self::V3HubReqOutbound07ProviderSemantic,
        Self::ProviderReqCompat06ProviderCompat,
        Self::V3ProviderReqOutbound08WirePayload,
        Self::V3ProviderReqOutbound09TransportRequest,
        Self::V3ProviderRespInbound01Raw,
        Self::ProviderRespCompat02ProviderCompat,
        Self::V3HubRespInbound02Normalized,
        Self::V3HubRespChatProcess03Governed,
        Self::V3HubRespContinuation04Committed,
        Self::V3HubRespOutbound05ClientSemantic,
        Self::V3ServerRespOutbound06ClientFrame,
    ];

    pub const fn node_id(self) -> &'static str {
        match self {
            Self::V3HubReqInbound01ClientRaw => "V3HubReqInbound01ClientRaw",
            Self::V3HubReqInbound02Normalized => "V3HubReqInbound02Normalized",
            Self::V3HubReqContinuation03Classified => "V3HubReqContinuation03Classified",
            Self::V3HubReqChatProcess04Governed => "V3HubReqChatProcess04Governed",
            Self::V3HubReqExecution05Planned => "V3HubReqExecution05Planned",
            Self::V3HubReqTarget06Resolved => "V3HubReqTarget06Resolved",
            Self::V3HubReqOutbound07ProviderSemantic => "V3HubReqOutbound07ProviderSemantic",
            Self::ProviderReqCompat06ProviderCompat => "ProviderReqCompat06ProviderCompat",
            Self::V3ProviderReqOutbound08WirePayload => "V3ProviderReqOutbound08WirePayload",
            Self::V3ProviderReqOutbound09TransportRequest => {
                "V3ProviderReqOutbound09TransportRequest"
            }
            Self::V3ProviderRespInbound01Raw => "V3ProviderRespInbound01Raw",
            Self::ProviderRespCompat02ProviderCompat => "ProviderRespCompat02ProviderCompat",
            Self::V3HubRespInbound02Normalized => "V3HubRespInbound02Normalized",
            Self::V3HubRespChatProcess03Governed => "V3HubRespChatProcess03Governed",
            Self::V3HubRespContinuation04Committed => "V3HubRespContinuation04Committed",
            Self::V3HubRespOutbound05ClientSemantic => "V3HubRespOutbound05ClientSemantic",
            Self::V3ServerRespOutbound06ClientFrame => "V3ServerRespOutbound06ClientFrame",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum V3HubHookPhase {
    Entry,
    Exit,
}

impl V3HubHookPhase {
    pub const ALL: [Self; 2] = [Self::Entry, Self::Exit];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Entry => "entry",
            Self::Exit => "exit",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum V3HubHookRequirement {
    Required,
    Optional,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum V3HubHookProfile {
    Servertool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum V3HubResourceKind {
    Control,
    Continuation,
    Debug,
    Error,
    Snapshot,
    ProviderHealth,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum V3HubResourceScope {
    Server,
    Listener,
    RoutingGroup,
    Session,
    Request,
    Provider,
    Hook,
    Debug,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3DebugAuthoringConfig {
    #[serde(default)]
    pub log_console: bool,
    #[serde(default)]
    pub log_file: Option<String>,
    #[serde(default)]
    pub snapshots: bool,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub retention: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ErrorAuthoringConfig {
    #[serde(default)]
    pub policies: BTreeMap<String, V3ErrorPolicyAuthoringConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ErrorPolicyAuthoringConfig {
    pub action: String,
    #[serde(default)]
    pub cooldown_ms: Option<u64>,
    #[serde(default)]
    pub max_attempts: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct V3Config03SchemaValidated {
    pub authoring: V3Config02AuthoringParsed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ServerAuthoringConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub bind: String,
    pub port: u16,
    pub routing_group: String,
    #[serde(default = "default_responses_endpoint")]
    pub endpoints: Vec<String>,
    #[serde(default)]
    pub features: BTreeMap<String, bool>,
    #[serde(default)]
    pub execution: Option<V3ServerExecutionAuthoringConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ServerExecutionAuthoringConfig {
    pub allowed_modes: Vec<String>,
    pub allowed_invocation_sources: Vec<String>,
    pub allowed_transports: Vec<String>,
    pub continuation: V3ContinuationPolicyAuthoringConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ContinuationPolicyAuthoringConfig {
    pub allowed_owners: Vec<String>,
    pub scope_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ProviderAuthoringConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(rename = "type")]
    pub provider_type: String,
    pub base_url: String,
    pub default_model: String,
    pub auth: V3ProviderAuthAuthoringConfig,
    pub models: BTreeMap<String, V3ProviderModelAuthoringConfig>,
    #[serde(default)]
    pub responses: Option<V3ProviderResponsesAuthoringConfig>,
    #[serde(default)]
    pub concurrency: Option<V3ProviderConcurrencyAuthoringConfig>,
    #[serde(default)]
    pub health: Option<V3ProviderHealthAuthoringConfig>,
    #[serde(default, alias = "compatibilityProfile")]
    pub compatibility_profile: Option<String>,
    #[serde(default)]
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct V3ProviderHealthAuthoringConfig {
    pub enabled: bool,
    pub failure_threshold: u32,
    pub cooldown_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ProviderAuthAuthoringConfig {
    #[serde(rename = "type")]
    pub auth_type: V3ProviderAuthType,
    pub entries: Vec<V3ProviderAuthEntryAuthoringConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum V3ProviderAuthType {
    #[serde(alias = "apikey")]
    ApiKey,
    OAuth,
    TokenFile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ProviderAuthEntryAuthoringConfig {
    pub alias: String,
    #[serde(default)]
    pub env: Option<String>,
    #[serde(default)]
    pub token_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ProviderModelAuthoringConfig {
    #[serde(default)]
    pub wire_name: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub supports_streaming: bool,
    #[serde(default)]
    pub supports_thinking: bool,
    #[serde(default)]
    pub thinking: Option<String>,
    #[serde(default)]
    pub max_tokens: Option<u64>,
    #[serde(default)]
    pub max_context_tokens: Option<u64>,
    #[serde(default)]
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct V3ProviderResponsesAuthoringConfig {
    pub process: String,
    pub streaming: V3StreamingPolicy,
    #[serde(default)]
    pub transport: V3ResponsesTransportKind,
    #[serde(default)]
    pub websocket_v2_url: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum V3ResponsesTransportKind {
    #[default]
    Http,
    WebsocketV2,
}

impl V3ResponsesTransportKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::WebsocketV2 => "websocket_v2",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum V3StreamingPolicy {
    Always,
    Client,
    Never,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct V3ProviderConcurrencyAuthoringConfig {
    pub max_in_flight: u32,
    pub acquire_timeout_ms: u64,
    pub stale_lease_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ForwarderAuthoringConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub model: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub selection: V3SelectionPolicy,
    pub targets: Vec<V3ForwarderTargetAuthoringConfig>,
    #[serde(default)]
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ForwarderTargetAuthoringConfig {
    #[serde(default)]
    pub kind: V3RouteTargetKind,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub priority: Option<i32>,
    #[serde(default)]
    pub weight: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3RouteGroupAuthoringConfig {
    pub pools: BTreeMap<String, V3RoutePoolAuthoringConfig>,
    #[serde(default)]
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3RoutePoolAuthoringConfig {
    #[serde(default)]
    pub selection: V3SelectionPolicy,
    #[serde(default, rename = "match")]
    pub match_rule: Option<V3RoutePoolMatchAuthoringConfig>,
    pub targets: Vec<V3RoutePoolTargetAuthoringConfig>,
    #[serde(default)]
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3RoutePoolMatchAuthoringConfig {
    #[serde(default)]
    pub precedence: Option<i32>,
    #[serde(default)]
    pub entry_protocol: Option<String>,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub required_capabilities: Vec<String>,
    #[serde(default)]
    pub min_input_tokens: Option<u64>,
    #[serde(default)]
    pub max_input_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3RoutePoolTargetAuthoringConfig {
    pub kind: V3RouteTargetKind,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub priority: Option<i32>,
    #[serde(default)]
    pub weight: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum V3RouteTargetKind {
    #[default]
    ProviderModel,
    Forwarder,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct V3SelectionPolicy {
    pub strategy: V3SelectionStrategy,
}

impl Default for V3SelectionPolicy {
    fn default() -> Self {
        Self {
            strategy: V3SelectionStrategy::Priority,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum V3SelectionStrategy {
    Priority,
    Weighted,
    RoundRobin,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Config04ResourceRegistryBuilt {
    pub version: u16,
    pub hub_v1: Option<V3HubV1Manifest>,
    pub servers: BTreeMap<String, V3ServerManifest>,
    pub providers: BTreeMap<String, V3ProviderManifest>,
    pub forwarders: BTreeMap<String, V3ForwarderManifest>,
    pub route_groups: BTreeMap<String, V3RouteGroupManifest>,
    pub features: BTreeMap<String, bool>,
    pub debug: V3DebugManifest,
    pub error: V3ErrorManifest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Config05ManifestPublished {
    pub version: u16,
    pub hub_v1: Option<V3HubV1Manifest>,
    pub servers: BTreeMap<String, V3ServerManifest>,
    pub providers: BTreeMap<String, V3ProviderManifest>,
    pub forwarders: BTreeMap<String, V3ForwarderManifest>,
    pub route_groups: BTreeMap<String, V3RouteGroupManifest>,
    pub features: BTreeMap<String, bool>,
    pub debug: V3DebugManifest,
    pub error: V3ErrorManifest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3HubV1Manifest {
    pub skeleton: String,
    pub entry_protocols: Vec<String>,
    pub hook_set_id: String,
    pub entry_protocol_bindings: Vec<V3EntryProtocolBindingManifest>,
    pub resources: BTreeMap<String, V3HubResourceManifest>,
    pub hooks: Vec<V3HubHookManifest>,
}

impl V3HubV1Manifest {
    pub fn entry_protocol_binding_for_endpoint(
        &self,
        endpoint_path: &str,
    ) -> Option<&V3EntryProtocolBindingManifest> {
        self.entry_protocol_bindings.iter().find(|binding| {
            binding
                .endpoint_patterns
                .iter()
                .any(|pattern| entry_protocol_endpoint_pattern_matches(pattern, endpoint_path))
        })
    }
}

fn entry_protocol_endpoint_pattern_matches(pattern: &str, endpoint_path: &str) -> bool {
    if pattern == endpoint_path {
        return true;
    }
    pattern == "/v1beta/models/:model/generateContent"
        && endpoint_path.starts_with("/v1beta/models/")
        && endpoint_path.ends_with("/generateContent")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3EntryProtocolBindingManifest {
    pub entry_protocol: String,
    pub endpoint_patterns: Vec<String>,
    pub execution_mode: V3EntryProtocolExecutionMode,
    pub protocol_profile_owner: String,
    pub implemented: bool,
    pub forbidden_reentry_behavior: String,
    pub runtime_owner_symbol: Option<String>,
    pub runtime_owner_path: Option<String>,
    pub pending_owner_symbol: Option<String>,
    pub pending_owner_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3HubResourceManifest {
    pub resource_id: String,
    pub kind: V3HubResourceKind,
    pub scope: V3HubResourceScope,
    pub may_enter_provider_body: bool,
    pub may_enter_client_body: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3HubHookManifest {
    pub hook_id: String,
    pub node: V3HubFixedNode,
    pub phase: V3HubHookPhase,
    pub requirement: V3HubHookRequirement,
    pub enabled: bool,
    pub priority: i32,
    pub order: u32,
    pub allowed_resources: Vec<String>,
    pub forbidden_resources: Vec<String>,
    pub profile: Option<V3HubHookProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ServerManifest {
    pub id: String,
    pub enabled: bool,
    pub bind: String,
    pub port: u16,
    pub routing_group: String,
    pub endpoints: Vec<String>,
    pub features: BTreeMap<String, bool>,
    pub execution: Option<V3ServerExecutionManifest>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ServerExecutionManifest {
    pub allowed_modes: Vec<String>,
    pub allowed_invocation_sources: Vec<String>,
    pub allowed_transports: Vec<String>,
    pub continuation: V3ContinuationPolicyManifest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ContinuationPolicyManifest {
    pub allowed_owners: Vec<String>,
    pub scope_keys: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderManifest {
    pub id: String,
    pub enabled: bool,
    pub provider_type: String,
    pub base_url: String,
    pub default_model: String,
    pub auth: V3ProviderAuthManifest,
    pub models: BTreeMap<String, V3ProviderModelManifest>,
    pub responses: Option<V3ProviderResponsesAuthoringConfig>,
    pub concurrency: Option<V3ProviderConcurrencyAuthoringConfig>,
    pub health: Option<V3ProviderHealthAuthoringConfig>,
    pub compatibility_profile: Option<String>,
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderAuthManifest {
    pub auth_type: V3ProviderAuthType,
    pub entries: Vec<V3ProviderAuthEntryManifest>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderAuthEntryManifest {
    pub alias: String,
    pub env: Option<String>,
    pub token_file: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderModelManifest {
    pub id: String,
    pub wire_name: String,
    pub aliases: Vec<String>,
    pub capabilities: Vec<String>,
    pub supports_streaming: bool,
    pub supports_thinking: bool,
    pub thinking: Option<String>,
    pub max_tokens: Option<u64>,
    pub max_context_tokens: Option<u64>,
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ForwarderManifest {
    pub id: String,
    pub enabled: bool,
    pub model: String,
    pub aliases: Vec<String>,
    pub selection: V3SelectionPolicy,
    pub targets: Vec<V3ForwarderTargetManifest>,
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ForwarderTargetManifest {
    pub kind: V3RouteTargetKind,
    pub id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub key: Option<String>,
    pub priority: Option<i32>,
    pub weight: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3DebugManifest {
    pub log_console: bool,
    pub log_file: Option<String>,
    pub snapshots: bool,
    pub dry_run: bool,
    pub retention: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ErrorManifest {
    pub policies: BTreeMap<String, V3ErrorPolicyManifest>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ErrorPolicyManifest {
    pub action: String,
    pub cooldown_ms: Option<u64>,
    pub max_attempts: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3RouteGroupManifest {
    pub id: String,
    pub pools: BTreeMap<String, V3RoutePoolManifest>,
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3RoutePoolManifest {
    pub id: String,
    pub selection: V3SelectionPolicy,
    pub match_rule: Option<V3RoutePoolMatchManifest>,
    pub targets: Vec<V3RoutePoolTargetManifest>,
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3RoutePoolMatchManifest {
    pub precedence: i32,
    pub entry_protocol: Option<String>,
    pub models: Vec<String>,
    pub required_capabilities: Vec<String>,
    pub min_input_tokens: Option<u64>,
    pub max_input_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3RoutePoolTargetManifest {
    pub kind: V3RouteTargetKind,
    pub id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub key: Option<String>,
    pub priority: Option<i32>,
    pub weight: Option<u32>,
}

fn default_true() -> bool {
    true
}

fn default_responses_endpoint() -> Vec<String> {
    vec!["responses".to_string()]
}
