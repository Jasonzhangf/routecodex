use super::{
    build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03,
    build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02,
    build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01, V3HubContinuationOwnership,
    V3HubEntryProtocol, V3HubReqChatProcess04Governed, V3HubReqInbound01ClientRaw,
};
use serde_json::Value;
use std::sync::Arc;

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
        let ownership = classify_continuation(lookup)?;
        let classified =
            build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02(normalized, ownership);
        events.extend([
            V3HubRelayRequestHookEvent::Req03Exit,
            V3HubRelayRequestHookEvent::Req04Entry,
        ]);
        let local_context = restore_local_context_at_req04(ownership, lookup)?;
        if local_context.is_some() {
            events.push(V3HubRelayRequestHookEvent::Req04LocalContextRestored);
        }
        govern_tool_outputs(&classified.previous.previous.payload.0)?;
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

fn govern_tool_outputs(payload: &Value) -> Result<(), V3HubRelayRequestError> {
    let Some(input) = payload.get("input").and_then(Value::as_array) else {
        return Ok(());
    };
    for (index, item) in input.iter().enumerate() {
        if matches!(
            item.get("type").and_then(Value::as_str),
            Some("function_call_output" | "custom_tool_call_output")
        ) && item
            .get("call_id")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        {
            return Err(V3HubRelayRequestError::MalformedToolOutput { index });
        }
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
