use super::{
    apply_v3_stopless_request_hook_at_req04,
    build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03,
    build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02,
    build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01,
    drop_v3_client_tool_error_pairs_at_req04, find_v3_hub_side_channel_key,
    merge_v3_relay_restored_local_context_at_req04, V3HubContinuationOwnership, V3HubEntryProtocol,
    V3HubReqChatProcess04Governed, V3HubReqInbound01ClientRaw, V3HubReqInbound02Normalized,
    V3StoplessHookState,
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubRequestSemanticProtocol {
    Chat,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3HubContinuationScope {
    entry_protocol: V3HubEntryProtocol,
    server_id: String,
    routing_group: String,
    session_id: String,
}

impl V3HubContinuationScope {
    pub fn new(
        entry_protocol: V3HubEntryProtocol,
        server_id: impl Into<String>,
        routing_group: impl Into<String>,
        session_id: impl Into<String>,
    ) -> Self {
        Self {
            entry_protocol,
            server_id: server_id.into(),
            routing_group: routing_group.into(),
            session_id: session_id.into(),
        }
    }
}

#[derive(Debug)]
struct RemoteBinding {
    continuation_id: String,
    scope: V3HubContinuationScope,
}
#[derive(Debug)]
struct LocalContext {
    continuation_id: String,
    scope: V3HubContinuationScope,
    canonical_context: Arc<Value>,
}

#[derive(Debug)]
pub struct V3HubContinuationLookup {
    requested_continuation_id: Option<String>,
    request_scope: V3HubContinuationScope,
    remote_binding: Option<RemoteBinding>,
    local_context: Option<LocalContext>,
}

impl V3HubContinuationLookup {
    pub fn new(
        requested_continuation_id: Option<&str>,
        request_scope: V3HubContinuationScope,
    ) -> Self {
        Self {
            requested_continuation_id: requested_continuation_id.map(str::to_owned),
            request_scope,
            remote_binding: None,
            local_context: None,
        }
    }
    pub fn with_remote_binding(
        mut self,
        continuation_id: impl Into<String>,
        scope: V3HubContinuationScope,
    ) -> Self {
        self.remote_binding = Some(RemoteBinding {
            continuation_id: continuation_id.into(),
            scope,
        });
        self
    }
    pub fn with_local_context(
        mut self,
        continuation_id: impl Into<String>,
        scope: V3HubContinuationScope,
        canonical_context: Value,
    ) -> Self {
        self.local_context = Some(LocalContext {
            continuation_id: continuation_id.into(),
            scope,
            canonical_context: Arc::new(canonical_context),
        });
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3HubServertoolRequestProfile {
    Disabled,
    Enabled {
        hook_ids: Vec<&'static str>,
        stopless_reasoning_stop: bool,
    },
    RequiredFailure(&'static str),
}
impl V3HubServertoolRequestProfile {
    pub fn disabled() -> Self {
        Self::Disabled
    }
    pub fn enabled<const N: usize>(hook_ids: [&'static str; N]) -> Self {
        Self::Enabled {
            hook_ids: hook_ids.into(),
            stopless_reasoning_stop: false,
        }
    }
    pub fn stopless_reasoning_stop() -> Self {
        Self::Enabled {
            hook_ids: vec!["stop_message_auto"],
            stopless_reasoning_stop: true,
        }
    }
    pub fn required_failure(hook_id: &'static str) -> Self {
        Self::RequiredFailure(hook_id)
    }
    pub fn stopless_reasoning_stop_enabled(&self) -> bool {
        matches!(
            self,
            Self::Enabled {
                stopless_reasoning_stop: true,
                ..
            }
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3HubAttachmentHistoryPolicy {
    Preserve,
    Placeholder { placeholder: &'static str },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubRelayRequestHookEvent {
    Req01Entry,
    Req01Exit,
    Req02Entry,
    Req02Exit,
    Req03Entry,
    Req03Exit,
    Req04Entry,
    Req04LocalContextRestored,
    Req04ToolGoverned,
    Req04ProtocolToolIdentityGoverned,
    Req04ApplyPatchGuidanceGoverned,
    Req04HistoryGoverned,
    Req04ServertoolGoverned,
    Req04StoplessResultParsed,
    Req04StoplessTextRewritten,
    Req04StoplessToolInjected,
    ServertoolOptionalNoop,
    Req04Exit,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum V3HubRelayRequestError {
    #[error("continuation not found: {continuation_id}")]
    ContinuationNotFound { continuation_id: String },
    #[error("continuation scope mismatch: {continuation_id}")]
    ContinuationScopeMismatch { continuation_id: String },
    #[error("continuation has both local and remote owners: {continuation_id}")]
    AmbiguousContinuationOwnership { continuation_id: String },
    #[error("malformed tool output at input index {index}: call_id is required")]
    MalformedToolOutput { index: usize },
    #[error("orphan tool output at input index {index}: call_id {call_id}")]
    OrphanToolOutput { index: usize, call_id: String },
    #[error("tool output kind mismatch at input index {index}: call_id {call_id}")]
    ToolOutputKindMismatch { index: usize, call_id: String },
    #[error("attachment resource missing at input index {index}")]
    AttachmentResourceMissing { index: usize },
    #[error("side-channel field leaked into normal request payload: {key}")]
    SideChannelLeaked { key: &'static str },
    #[error("required request hook failed: {hook_id}")]
    RequiredHookFailed { hook_id: &'static str },
    #[error("local continuation context disappeared before Req04 restore: {continuation_id}")]
    LocalContextMissingAtRestore { continuation_id: String },
    #[error("local continuation reached Req04 restore without a continuation id")]
    ContinuationIdMissingAtRestore,
    #[error("restored local continuation context is invalid at Req04: {reason}")]
    RestoredLocalContextInvalid { reason: String },
    #[error("unknown static servertool request hook: {hook_id}")]
    UnknownStaticHook { hook_id: &'static str },
    #[error("malformed stopless CLI output at input index {index}: {reason}")]
    MalformedStoplessCliOutput { index: usize, reason: &'static str },
    #[error("{protocol} tool identity is invalid at item {index}: {reason}")]
    ProtocolToolIdentityInvalid {
        protocol: &'static str,
        index: usize,
        reason: &'static str,
    },
}

#[derive(Debug)]
pub struct V3HubRelayRequestOutcome {
    governed: V3HubReqChatProcess04Governed,
    local_context: Option<Arc<Value>>,
    tool_output_count: usize,
    events: Vec<V3HubRelayRequestHookEvent>,
    stopless_state: Option<V3StoplessHookState>,
}
impl V3HubRelayRequestOutcome {
    pub fn payload(&self) -> &Value {
        &self.governed.previous.previous.previous.payload.0
    }
    pub fn continuation(&self) -> V3HubContinuationOwnership {
        self.governed.previous.continuation
    }
    pub fn semantic_protocol(&self) -> V3HubRequestSemanticProtocol {
        self.governed.previous.previous.semantic_protocol
    }
    pub fn restored_local_context(&self) -> bool {
        self.local_context.is_some()
    }
    pub fn local_context(&self) -> Option<&Value> {
        self.local_context.as_deref()
    }
    pub fn hook_events(&self) -> &[V3HubRelayRequestHookEvent] {
        &self.events
    }
    pub fn tool_output_count(&self) -> usize {
        self.tool_output_count
    }
    pub fn stopless_state(&self) -> Option<&V3StoplessHookState> {
        self.stopless_state.as_ref()
    }
    pub fn into_governed(self) -> V3HubReqChatProcess04Governed {
        self.governed
    }
}

#[derive(Debug, Clone, Copy)]
pub struct V3HubRelayRequestHooks {
    _sealed: (),
}
pub fn compile_v3_hub_relay_request_hooks() -> V3HubRelayRequestHooks {
    V3HubRelayRequestHooks { _sealed: () }
}

impl V3HubRelayRequestHooks {
    pub fn run(
        &self,
        raw: V3HubReqInbound01ClientRaw,
        lookup: &V3HubContinuationLookup,
        profile: &V3HubServertoolRequestProfile,
    ) -> Result<V3HubRelayRequestOutcome, V3HubRelayRequestError> {
        self.run_with_attachment_history_policy(
            raw,
            lookup,
            profile,
            V3HubAttachmentHistoryPolicy::Preserve,
        )
    }

    pub fn run_with_attachment_history_policy(
        &self,
        raw: V3HubReqInbound01ClientRaw,
        lookup: &V3HubContinuationLookup,
        profile: &V3HubServertoolRequestProfile,
        attachment_history_policy: V3HubAttachmentHistoryPolicy,
    ) -> Result<V3HubRelayRequestOutcome, V3HubRelayRequestError> {
        let mut events = vec![
            V3HubRelayRequestHookEvent::Req01Entry,
            V3HubRelayRequestHookEvent::Req01Exit,
            V3HubRelayRequestHookEvent::Req02Entry,
        ];
        let normalized = build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(raw);
        events.extend([
            V3HubRelayRequestHookEvent::Req02Exit,
            V3HubRelayRequestHookEvent::Req03Entry,
        ]);
        self.run_from_normalized_with_events(
            normalized,
            lookup,
            profile,
            &attachment_history_policy,
            events,
        )
    }

    pub fn run_from_normalized(
        &self,
        normalized: V3HubReqInbound02Normalized,
        lookup: &V3HubContinuationLookup,
        profile: &V3HubServertoolRequestProfile,
    ) -> Result<V3HubRelayRequestOutcome, V3HubRelayRequestError> {
        self.run_from_normalized_with_events(
            normalized,
            lookup,
            profile,
            &V3HubAttachmentHistoryPolicy::Preserve,
            vec![V3HubRelayRequestHookEvent::Req03Entry],
        )
    }

    fn run_from_normalized_with_events(
        &self,
        normalized: V3HubReqInbound02Normalized,
        lookup: &V3HubContinuationLookup,
        profile: &V3HubServertoolRequestProfile,
        attachment_history_policy: &V3HubAttachmentHistoryPolicy,
        mut events: Vec<V3HubRelayRequestHookEvent>,
    ) -> Result<V3HubRelayRequestOutcome, V3HubRelayRequestError> {
        let ownership = classify_continuation(lookup)?;
        let mut classified =
            build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02(normalized, ownership);
        events.extend([
            V3HubRelayRequestHookEvent::Req03Exit,
            V3HubRelayRequestHookEvent::Req04Entry,
        ]);
        let local_context = restore_local_context_at_req04(ownership, lookup)?;
        if local_context.is_some() {
            events.push(V3HubRelayRequestHookEvent::Req04LocalContextRestored);
        }
        if let Some(context) = local_context.as_deref() {
            merge_v3_relay_restored_local_context_at_req04(
                &mut classified.previous.previous.payload.0,
                context,
            )
            .map_err(
                |error| V3HubRelayRequestError::RestoredLocalContextInvalid {
                    reason: error.to_string(),
                },
            )?;
        }
        if let Some(key) = find_v3_hub_side_channel_key(&classified.previous.previous.payload.0) {
            return Err(V3HubRelayRequestError::SideChannelLeaked { key });
        }
        let stopless_state = if profile.stopless_reasoning_stop_enabled() {
            apply_v3_stopless_request_hook_at_req04(
                &mut classified.previous.previous.payload.0,
                &mut events,
            )?
        } else {
            None
        };
        if govern_apply_patch_guidance_at_req04(
            classified.previous.previous.entry_protocol,
            &mut classified.previous.previous.payload.0,
        ) {
            events.push(V3HubRelayRequestHookEvent::Req04ApplyPatchGuidanceGoverned);
        }
        if govern_protocol_tool_identity_at_req04(
            classified.previous.previous.entry_protocol,
            &classified.previous.previous.payload.0,
        )? {
            events.push(V3HubRelayRequestHookEvent::Req04ProtocolToolIdentityGoverned);
        }
        let tool_output_count = govern_tool_outputs_at_req04(
            &mut classified.previous.previous.payload.0,
            local_context.as_deref(),
        )?;
        govern_attachment_history_at_req04(
            &mut classified.previous.previous.payload.0,
            attachment_history_policy,
        )?;
        events.extend([
            V3HubRelayRequestHookEvent::Req04ToolGoverned,
            V3HubRelayRequestHookEvent::Req04HistoryGoverned,
        ]);
        run_servertool_profile(profile, &mut events)?;
        let governed = build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03(classified);
        events.push(V3HubRelayRequestHookEvent::Req04Exit);
        Ok(V3HubRelayRequestOutcome {
            governed,
            local_context,
            tool_output_count,
            events,
            stopless_state,
        })
    }
}

fn classify_continuation(
    lookup: &V3HubContinuationLookup,
) -> Result<V3HubContinuationOwnership, V3HubRelayRequestError> {
    let Some(id) = lookup.requested_continuation_id.as_deref() else {
        return Ok(V3HubContinuationOwnership::New);
    };
    if lookup
        .local_context
        .as_ref()
        .is_some_and(|item| item.continuation_id == id)
        && lookup
            .remote_binding
            .as_ref()
            .is_some_and(|item| item.continuation_id == id)
    {
        return Err(V3HubRelayRequestError::AmbiguousContinuationOwnership {
            continuation_id: id.to_owned(),
        });
    }
    if let Some(local) = lookup
        .local_context
        .as_ref()
        .filter(|item| item.continuation_id == id)
    {
        if local.scope != lookup.request_scope {
            return Err(V3HubRelayRequestError::ContinuationScopeMismatch {
                continuation_id: id.into(),
            });
        }
        return Ok(V3HubContinuationOwnership::RouteCodexLocalOwned);
    }
    if let Some(remote) = lookup
        .remote_binding
        .as_ref()
        .filter(|item| item.continuation_id == id)
    {
        if remote.scope != lookup.request_scope {
            return Err(V3HubRelayRequestError::ContinuationScopeMismatch {
                continuation_id: id.into(),
            });
        }
        return Ok(V3HubContinuationOwnership::RemoteProviderOwned);
    }
    Err(V3HubRelayRequestError::ContinuationNotFound {
        continuation_id: id.into(),
    })
}

fn restore_local_context_at_req04(
    ownership: V3HubContinuationOwnership,
    lookup: &V3HubContinuationLookup,
) -> Result<Option<Arc<Value>>, V3HubRelayRequestError> {
    if ownership != V3HubContinuationOwnership::RouteCodexLocalOwned {
        return Ok(None);
    }
    let Some(requested_id) = lookup.requested_continuation_id.as_deref() else {
        return Err(V3HubRelayRequestError::ContinuationIdMissingAtRestore);
    };
    let Some(local) = lookup
        .local_context
        .as_ref()
        .filter(|item| item.continuation_id == requested_id && item.scope == lookup.request_scope)
    else {
        return Err(V3HubRelayRequestError::LocalContextMissingAtRestore {
            continuation_id: requested_id.to_owned(),
        });
    };
    Ok(Some(Arc::clone(&local.canonical_context)))
}

fn govern_protocol_tool_identity_at_req04(
    entry_protocol: V3HubEntryProtocol,
    payload: &Value,
) -> Result<bool, V3HubRelayRequestError> {
    match entry_protocol {
        V3HubEntryProtocol::OpenAiChat => {
            let Some(messages) = payload.get("messages").and_then(Value::as_array) else {
                return Ok(false);
            };
            govern_openai_chat_tool_identity_at_req04(messages)?;
            Ok(true)
        }
        V3HubEntryProtocol::Gemini => {
            let Some(contents) = payload.get("contents").and_then(Value::as_array) else {
                return Ok(false);
            };
            govern_gemini_tool_identity_at_req04(contents)?;
            Ok(true)
        }
        V3HubEntryProtocol::Responses | V3HubEntryProtocol::Anthropic => Ok(false),
    }
}

fn govern_openai_chat_tool_identity_at_req04(
    messages: &[Value],
) -> Result<(), V3HubRelayRequestError> {
    let mut declared = BTreeSet::new();
    for (index, message) in messages.iter().enumerate() {
        if let Some(calls) = message.get("tool_calls") {
            let calls =
                calls
                    .as_array()
                    .ok_or(V3HubRelayRequestError::ProtocolToolIdentityInvalid {
                        protocol: "openai_chat",
                        index,
                        reason: "tool_calls must be an array",
                    })?;
            for call in calls {
                let id = call
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .ok_or(V3HubRelayRequestError::ProtocolToolIdentityInvalid {
                        protocol: "openai_chat",
                        index,
                        reason: "tool_calls.id is required",
                    })?;
                if !declared.insert(id.to_owned()) {
                    return Err(V3HubRelayRequestError::ProtocolToolIdentityInvalid {
                        protocol: "openai_chat",
                        index,
                        reason: "duplicate tool_calls.id",
                    });
                }
            }
        }
        if message.get("role").and_then(Value::as_str) == Some("tool") {
            let id = message
                .get("tool_call_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or(V3HubRelayRequestError::ProtocolToolIdentityInvalid {
                    protocol: "openai_chat",
                    index,
                    reason: "tool_call_id is required",
                })?;
            if !declared.contains(id) {
                return Err(V3HubRelayRequestError::ProtocolToolIdentityInvalid {
                    protocol: "openai_chat",
                    index,
                    reason: "orphan tool_call_id",
                });
            }
        }
    }
    Ok(())
}

fn govern_gemini_tool_identity_at_req04(contents: &[Value]) -> Result<(), V3HubRelayRequestError> {
    let mut declared = BTreeSet::new();
    for (index, content) in contents.iter().enumerate() {
        let Some(parts) = content.get("parts").and_then(Value::as_array) else {
            continue;
        };
        for part in parts {
            if let Some(function_call) = part.get("functionCall") {
                let name = function_call
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty())
                    .ok_or(V3HubRelayRequestError::ProtocolToolIdentityInvalid {
                        protocol: "gemini",
                        index,
                        reason: "functionCall.name is required",
                    })?;
                declared.insert(name.to_owned());
            }
            if let Some(function_response) = part.get("functionResponse") {
                let name = function_response
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty())
                    .ok_or(V3HubRelayRequestError::ProtocolToolIdentityInvalid {
                        protocol: "gemini",
                        index,
                        reason: "functionResponse.name is required",
                    })?;
                if !declared.contains(name) {
                    return Err(V3HubRelayRequestError::ProtocolToolIdentityInvalid {
                        protocol: "gemini",
                        index,
                        reason: "orphan functionResponse.name",
                    });
                }
            }
        }
    }
    Ok(())
}

const V3_APPLY_PATCH_GUIDANCE_MARKER: &str = "[Codex Tool Guidance]";
const V3_APPLY_PATCH_GUIDANCE_TEXT: &str = "[Codex Tool Guidance]\napply_patch: send exactly one raw patch string using canonical *** Begin Patch / *** End Patch grammar. Use *** Add File:, *** Update File:, or *** Delete File: headers with workspace-relative paths. Do not use absolute paths. Do not include GNU diff headers, Markdown fences, shell heredocs, or prose inside the patch. If apply_patch fails, reread the target file and retry with a smaller unique context. Do not switch to exec_command or shell writes for file edits.";

fn govern_apply_patch_guidance_at_req04(
    entry_protocol: V3HubEntryProtocol,
    payload: &mut Value,
) -> bool {
    if entry_protocol != V3HubEntryProtocol::Responses || !declares_apply_patch_tool(payload) {
        return false;
    }
    let Some(root) = payload.as_object_mut() else {
        return false;
    };
    match root.get_mut("instructions") {
        Some(Value::String(existing)) => {
            if existing.contains(V3_APPLY_PATCH_GUIDANCE_MARKER) {
                false
            } else if existing.trim().is_empty() {
                *existing = V3_APPLY_PATCH_GUIDANCE_TEXT.to_string();
                true
            } else {
                existing.push_str("\n\n");
                existing.push_str(V3_APPLY_PATCH_GUIDANCE_TEXT);
                true
            }
        }
        Some(_) => false,
        None => {
            root.insert(
                "instructions".to_string(),
                Value::String(V3_APPLY_PATCH_GUIDANCE_TEXT.to_string()),
            );
            true
        }
    }
}

fn declares_apply_patch_tool(payload: &Value) -> bool {
    payload
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| tools.iter().any(is_apply_patch_tool))
}

fn is_apply_patch_tool(tool: &Value) -> bool {
    let Some(row) = tool.as_object() else {
        return false;
    };
    let name = row
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| {
            row.get("function")
                .and_then(Value::as_object)
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
        })
        .map(str::trim);
    name.is_some_and(|name| name.eq_ignore_ascii_case("apply_patch"))
}

fn govern_tool_outputs_at_req04(
    payload: &mut Value,
    local_context: Option<&Value>,
) -> Result<usize, V3HubRelayRequestError> {
    let Some(input) = payload.get_mut("input").and_then(Value::as_array_mut) else {
        return Ok(0);
    };
    drop_v3_client_tool_error_pairs_at_req04(input);
    let mut expected_outputs = local_context.map(expected_tool_outputs).unwrap_or_default();
    let mut output_count = 0;
    for (index, item) in input.iter_mut().enumerate() {
        if let Some((call_id, expected_kind)) = expected_tool_call_output_from_item(item) {
            expected_outputs.insert(call_id, expected_kind);
            continue;
        }
        let actual_kind = match item.get("type").and_then(Value::as_str) {
            Some("function_call_output") => V3HubRelayActualToolOutputKind::Function,
            Some("custom_tool_call_output") => V3HubRelayActualToolOutputKind::Custom,
            _ => continue,
        };
        output_count += 1;
        let call_id = item
            .get("call_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or(V3HubRelayRequestError::MalformedToolOutput { index })?;
        if let Some(expected_kind) = expected_outputs.get(call_id) {
            if !expected_kind.matches_actual(actual_kind) {
                return Err(V3HubRelayRequestError::ToolOutputKindMismatch {
                    index,
                    call_id: call_id.to_owned(),
                });
            }
            if *expected_kind == V3HubRelayExpectedToolOutputKind::ApplyPatch {
                normalize_apply_patch_tool_output_item_at_req04(item);
            }
        } else {
            return Err(V3HubRelayRequestError::OrphanToolOutput {
                index,
                call_id: call_id.to_owned(),
            });
        }
    }
    Ok(output_count)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum V3HubRelayExpectedToolOutputKind {
    Function,
    Custom,
    ApplyPatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum V3HubRelayActualToolOutputKind {
    Function,
    Custom,
}

impl V3HubRelayExpectedToolOutputKind {
    fn matches_actual(self, actual: V3HubRelayActualToolOutputKind) -> bool {
        matches!(
            (self, actual),
            (
                V3HubRelayExpectedToolOutputKind::Function,
                V3HubRelayActualToolOutputKind::Function
            ) | (
                V3HubRelayExpectedToolOutputKind::Custom,
                V3HubRelayActualToolOutputKind::Custom
            ) | (V3HubRelayExpectedToolOutputKind::ApplyPatch, _)
        )
    }
}

fn expected_tool_outputs(context: &Value) -> BTreeMap<String, V3HubRelayExpectedToolOutputKind> {
    let mut expected = BTreeMap::new();
    for key in ["output", "input"] {
        let Some(items) = context.get(key).and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            if let Some((call_id, expected_kind)) = expected_tool_call_output_from_item(item) {
                expected.insert(call_id, expected_kind);
            }
        }
    }
    expected
}

fn expected_tool_call_output_from_item(
    item: &Value,
) -> Option<(String, V3HubRelayExpectedToolOutputKind)> {
    let expected_kind = match item.get("type").and_then(Value::as_str) {
        Some("custom_tool_call") => V3HubRelayExpectedToolOutputKind::Custom,
        Some("function_call" | "tool_call") => V3HubRelayExpectedToolOutputKind::Function,
        _ => return None,
    };
    let call_id = item
        .get("call_id")
        .or_else(|| item.get("id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())?;
    let expected_kind = if read_tool_call_name_at_req04(item)
        .as_deref()
        .is_some_and(|name| name.eq_ignore_ascii_case("apply_patch"))
    {
        V3HubRelayExpectedToolOutputKind::ApplyPatch
    } else {
        expected_kind
    };
    Some((call_id.to_owned(), expected_kind))
}

fn read_tool_call_name_at_req04(item: &Value) -> Option<String> {
    item.get("name")
        .and_then(Value::as_str)
        .or_else(|| {
            item.get("function")
                .and_then(Value::as_object)
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn normalize_apply_patch_tool_output_item_at_req04(item: &mut Value) {
    let Some(row) = item.as_object_mut() else {
        return;
    };
    for key in ["output", "content"] {
        let Some(Value::String(raw)) = row.get_mut(key) else {
            continue;
        };
        let normalized = normalize_apply_patch_output_text_at_req04(raw);
        if normalized != *raw {
            *raw = normalized;
        }
    }
}

fn normalize_apply_patch_output_text_at_req04(raw: &str) -> String {
    const APPLY_PATCH_ERROR_TEXT: &str = "APPLY_PATCH_ERROR: apply_patch did not apply. Retry with apply_patch only. Send one raw patch string in canonical *** Begin Patch / *** End Patch grammar. Use workspace-relative paths inside patch headers (for example *** Update File: src/main.ts or *** Add File: tmp/example.txt). Do not use absolute paths. Do not switch to exec_command or shell writes.";
    const APPLY_PATCH_RESULT_TEXT: &str = "APPLY_PATCH_RESULT: apply_patch applied. Continue future apply_patch calls with one raw patch string and workspace-relative paths inside patch headers. Keep using apply_patch for line edits instead of switching tools.";

    let text = raw.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = text.trim();
    if trimmed.starts_with("APPLY_PATCH_ERROR:") {
        return APPLY_PATCH_ERROR_TEXT.to_string();
    }

    if let Ok(Value::Object(row)) = trimmed.parse::<Value>() {
        let status = row
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_uppercase();
        if row.get("ok").and_then(Value::as_bool) == Some(true)
            || status == "APPLY_PATCH_APPLIED"
            || status == "APPLY_PATCH_RESULT"
        {
            return APPLY_PATCH_RESULT_TEXT.to_string();
        }
        if row.get("ok").and_then(Value::as_bool) == Some(false)
            || status == "APPLY_PATCH_FAILED"
            || status == "APPLY_PATCH_ERROR"
        {
            return APPLY_PATCH_ERROR_TEXT.to_string();
        }
    }

    let lowered = text.to_ascii_lowercase();
    if lowered.trim() == "aborted" {
        return APPLY_PATCH_ERROR_TEXT.to_string();
    }
    if matches!(lowered.trim(), "done" | "done!") {
        return APPLY_PATCH_RESULT_TEXT.to_string();
    }
    if !(lowered.contains("apply_patch") || lowered.contains("patch")) {
        return raw.to_string();
    }
    if lowered.contains("verification failed")
        || lowered.contains("invalid patch")
        || lowered.contains("missing")
        || lowered.contains("failed")
        || lowered.contains("error")
    {
        return APPLY_PATCH_ERROR_TEXT.to_string();
    }
    raw.to_string()
}

fn govern_attachment_history_at_req04(
    payload: &mut Value,
    policy: &V3HubAttachmentHistoryPolicy,
) -> Result<(), V3HubRelayRequestError> {
    let V3HubAttachmentHistoryPolicy::Placeholder { placeholder } = policy else {
        return Ok(());
    };
    let Some(input) = payload.get_mut("input").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    let historical_len = input.len().saturating_sub(1);
    for (index, item) in input.iter_mut().take(historical_len).enumerate() {
        replace_historical_media_with_placeholder(item, placeholder, index)?;
    }
    Ok(())
}

fn replace_historical_media_with_placeholder(
    value: &mut Value,
    placeholder: &str,
    index: usize,
) -> Result<(), V3HubRelayRequestError> {
    match value {
        Value::Object(object) => {
            if object.get("type").and_then(Value::as_str) == Some("input_image")
                && !object.contains_key("image_url")
            {
                return Err(V3HubRelayRequestError::AttachmentResourceMissing { index });
            }
            for child in object.values_mut() {
                replace_historical_media_with_placeholder(child, placeholder, index)?;
            }
        }
        Value::Array(items) => {
            for child in items {
                replace_historical_media_with_placeholder(child, placeholder, index)?;
            }
        }
        Value::String(text) if text.contains("data:image") => {
            *text = placeholder.to_owned();
        }
        _ => {}
    }
    Ok(())
}

fn run_servertool_profile(
    profile: &V3HubServertoolRequestProfile,
    events: &mut Vec<V3HubRelayRequestHookEvent>,
) -> Result<(), V3HubRelayRequestError> {
    match profile {
        V3HubServertoolRequestProfile::Disabled => {
            events.push(V3HubRelayRequestHookEvent::ServertoolOptionalNoop);
            Ok(())
        }
        V3HubServertoolRequestProfile::Enabled {
            hook_ids,
            stopless_reasoning_stop,
        } => {
            for hook_id in hook_ids {
                if *stopless_reasoning_stop && *hook_id == "stop_message_auto" {
                    events.push(V3HubRelayRequestHookEvent::Req04ServertoolGoverned);
                    continue;
                }
                if *hook_id != "servertool.request" {
                    return Err(V3HubRelayRequestError::UnknownStaticHook { hook_id });
                }
                events.push(V3HubRelayRequestHookEvent::Req04ServertoolGoverned);
            }
            Ok(())
        }
        V3HubServertoolRequestProfile::RequiredFailure(hook_id) => {
            Err(V3HubRelayRequestError::RequiredHookFailed { hook_id })
        }
    }
}
