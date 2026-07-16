use super::{
    build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03,
    build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02,
    build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01, find_v3_hub_side_channel_key,
    V3HubContinuationOwnership, V3HubEntryProtocol, V3HubReqChatProcess04Governed,
    V3HubReqInbound01ClientRaw, V3HubReqInbound02Normalized,
};
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};

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
    Enabled(Vec<&'static str>),
    RequiredFailure(&'static str),
}
impl V3HubServertoolRequestProfile {
    pub fn disabled() -> Self {
        Self::Disabled
    }
    pub fn enabled<const N: usize>(hook_ids: [&'static str; N]) -> Self {
        Self::Enabled(hook_ids.into())
    }
    pub fn required_failure(hook_id: &'static str) -> Self {
        Self::RequiredFailure(hook_id)
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
    Req04HistoryGoverned,
    Req04ServertoolGoverned,
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
    #[error("unknown static servertool request hook: {hook_id}")]
    UnknownStaticHook { hook_id: &'static str },
}

#[derive(Debug)]
pub struct V3HubRelayRequestOutcome {
    governed: V3HubReqChatProcess04Governed,
    local_context: Option<Arc<Value>>,
    tool_output_count: usize,
    events: Vec<V3HubRelayRequestHookEvent>,
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
        if let Some(key) = find_v3_hub_side_channel_key(&classified.previous.previous.payload.0) {
            return Err(V3HubRelayRequestError::SideChannelLeaked { key });
        }
        let tool_output_count = govern_tool_outputs_at_req04(
            &classified.previous.previous.payload.0,
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

fn govern_tool_outputs_at_req04(
    payload: &Value,
    local_context: Option<&Value>,
) -> Result<usize, V3HubRelayRequestError> {
    let Some(input) = payload.get("input").and_then(Value::as_array) else {
        return Ok(0);
    };
    let mut expected_outputs = local_context.map(expected_tool_outputs).unwrap_or_default();
    let mut output_count = 0;
    for (index, item) in input.iter().enumerate() {
        if let Some((call_id, expected_kind)) = expected_tool_call_output_from_item(item) {
            expected_outputs.insert(call_id, expected_kind);
            continue;
        }
        let actual_kind = match item.get("type").and_then(Value::as_str) {
            Some("function_call_output") => V3HubRelayExpectedToolOutputKind::Function,
            Some("custom_tool_call_output") => V3HubRelayExpectedToolOutputKind::Custom,
            _ => continue,
        };
        output_count += 1;
        let call_id = item
            .get("call_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or(V3HubRelayRequestError::MalformedToolOutput { index })?;
        if let Some(expected_kind) = expected_outputs.get(call_id) {
            if *expected_kind != actual_kind {
                return Err(V3HubRelayRequestError::ToolOutputKindMismatch {
                    index,
                    call_id: call_id.to_owned(),
                });
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
    Some((call_id.to_owned(), expected_kind))
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
        V3HubServertoolRequestProfile::Enabled(ids) => {
            for hook_id in ids {
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
