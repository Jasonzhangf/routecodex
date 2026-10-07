use serde_json::{Map, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use super::operators::CurrentFieldAssociations;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestOriginKind {
    ClientEntry,
    Retry,
    InternalFollowup,
    /// A same-request Direct-to-Relay handoff. The Direct phase already
    /// published the original pair through REQ02, so the handoff entry reads
    /// that pair unchanged instead of recapturing or republishing the wire.
    DirectRelayHandoff,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RequestNormalizationEntry {
    RawEntry(Value),
    AlreadyCanonical(Value),
}

impl RequestNormalizationEntry {
    pub fn value(&self) -> &Value {
        match self {
            Self::RawEntry(value) | Self::AlreadyCanonical(value) => value,
        }
    }

    pub fn into_value(self) -> Value {
        match self {
            Self::RawEntry(value) | Self::AlreadyCanonical(value) => value,
        }
    }

    pub fn validate_origin(&self, origin: RequestOriginKind) -> Result<(), String> {
        match (origin, self) {
            (RequestOriginKind::ClientEntry, Self::RawEntry(_))
            | (
                RequestOriginKind::Retry
                | RequestOriginKind::InternalFollowup
                | RequestOriginKind::DirectRelayHandoff,
                Self::AlreadyCanonical(_),
            ) => Ok(()),
            (RequestOriginKind::ClientEntry, Self::AlreadyCanonical(_)) => {
                Err("client entry cannot consume an already-canonical invocation input".to_string())
            }
            (RequestOriginKind::Retry | RequestOriginKind::InternalFollowup, Self::RawEntry(_)) => {
                Err("retry and internal followup require an already-canonical entry".to_string())
            }
            (RequestOriginKind::DirectRelayHandoff, Self::RawEntry(_)) => {
                Err("direct relay handoff requires an already-canonical entry".to_string())
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct FieldMapping {
    pub source_path: String,
    pub destination: String,
    pub operator: String,
    pub shape: Option<String>,
    pub semantics: Option<String>,
    pub transform_id: Option<String>,
    pub collision_policy: Option<String>,
    pub encoding: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OpaqueRecordReference {
    pub record_id: String,
    pub path: String,
    pub encoding: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolDeclarationReference {
    pub record_id: String,
    pub source_path: String,
    pub kind: String,
    pub name: Option<String>,
    pub namespace: Option<Value>,
    pub encoding: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HistoryPairingReference {
    pub source_path: String,
    pub call_id: Option<String>,
    pub name: Option<String>,
    pub kind: String,
    pub namespace: Option<Value>,
    pub encoding: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeContainerRole {
    ToolResultPart,
    ContentPart,
    FunctionCallPart,
    Message,
    GenerationConfig,
    ToolDeclaration,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NativeContainerBinding {
    pub source_path: String,
    pub canonical_anchor: String,
    pub role: NativeContainerRole,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RequestInverseContext {
    pub entry_protocol: String,
    pub normalized_protocol: String,
    pub field_mappings: Vec<FieldMapping>,
    pub opaque_record_references: Vec<OpaqueRecordReference>,
    pub tool_declarations: Vec<ToolDeclarationReference>,
    pub native_container_bindings: Vec<NativeContainerBinding>,
}

impl RequestInverseContext {
    fn from_field_value(value: Value) -> Result<Self, String> {
        let object = value
            .as_object()
            .ok_or_else(|| "request inverse context must be a JSON object".to_string())?;
        let entry_protocol = required_string(object, "entry_protocol")?;
        let normalized_protocol = required_string(object, "normalized_protocol")?;
        let field_mappings = required_array(object, "field_mappings")?
            .iter()
            .map(parse_field_mapping)
            .collect::<Result<Vec<_>, _>>()?;
        let opaque_record_references = required_array(object, "opaque_record_references")?
            .iter()
            .map(parse_opaque_reference)
            .collect::<Result<Vec<_>, _>>()?;
        let tool_declarations = required_array(object, "tool_declarations")?
            .iter()
            .map(parse_tool_declaration)
            .collect::<Result<Vec<_>, _>>()?;
        let native_container_bindings = required_array(object, "native_container_bindings")?
            .iter()
            .map(parse_native_container_binding)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            entry_protocol,
            normalized_protocol,
            field_mappings,
            opaque_record_references,
            tool_declarations,
            native_container_bindings,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ExplicitHistoryPairing {
    pub entry_protocol: String,
    pub messages: Vec<HistoryPairingReference>,
}

impl ExplicitHistoryPairing {
    fn from_field_value(value: Value) -> Result<Self, String> {
        let object = value
            .as_object()
            .ok_or_else(|| "explicit history pairing must be a JSON object".to_string())?;
        let entry_protocol = required_string(object, "entry_protocol")?;
        let messages = required_array(object, "messages")?
            .iter()
            .map(parse_history_pairing)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            entry_protocol,
            messages,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RequestScopedContextPair {
    pub inverse_context: RequestInverseContext,
    pub explicit_history_pairing: ExplicitHistoryPairing,
}

impl RequestScopedContextPair {
    pub fn from_field_json(
        inverse_context: Value,
        explicit_history_pairing: Value,
    ) -> Result<Self, String> {
        Ok(Self {
            inverse_context: RequestInverseContext::from_field_value(inverse_context)?,
            explicit_history_pairing: ExplicitHistoryPairing::from_field_value(
                explicit_history_pairing,
            )?,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProjectionPath {
    pub source_path: String,
    pub destination_path: String,
    pub encoding: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolMappingReference {
    pub declaration_record_id: String,
    pub source_path: String,
    pub destination_path: String,
    pub emitted_kind: String,
    pub emitted_name: Option<String>,
    pub emitted_namespace: Option<Value>,
    pub encoding: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AttemptProjectionContext {
    pub attempt_id: String,
    pub provider_protocol: String,
    pub provider_model: String,
    pub paths: Vec<ProjectionPath>,
}

impl AttemptProjectionContext {
    fn validate_identity(
        &self,
        expected_attempt_id: &str,
        expected_protocol: &str,
        expected_model: &str,
    ) -> Result<(), String> {
        if self.attempt_id != expected_attempt_id {
            return Err(format!(
                "attempt projection id `{}` does not match attempt `{expected_attempt_id}`",
                self.attempt_id
            ));
        }
        if self.provider_protocol != expected_protocol {
            return Err(format!(
                "attempt projection protocol `{}` does not match attempt protocol `{expected_protocol}`",
                self.provider_protocol
            ));
        }
        if self.provider_model != expected_model {
            return Err(format!(
                "attempt projection model `{}` does not match attempt model `{expected_model}`",
                self.provider_model
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AttemptDeclarationMap {
    pub attempt_id: String,
    pub provider_protocol: String,
    pub provider_model: String,
    pub tool_mappings: Vec<ToolMappingReference>,
}

impl AttemptDeclarationMap {
    fn validate_identity(
        &self,
        expected_attempt_id: &str,
        expected_protocol: &str,
        expected_model: &str,
    ) -> Result<(), String> {
        if self.attempt_id != expected_attempt_id {
            return Err(format!(
                "attempt declaration id `{}` does not match attempt `{expected_attempt_id}`",
                self.attempt_id
            ));
        }
        if self.provider_protocol != expected_protocol {
            return Err(format!(
                "attempt declaration protocol `{}` does not match attempt protocol `{expected_protocol}`",
                self.provider_protocol
            ));
        }
        if self.provider_model != expected_model {
            return Err(format!(
                "attempt declaration model `{}` does not match attempt model `{expected_model}`",
                self.provider_model
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AttemptContext {
    pub attempt_id: String,
    pub projection: AttemptProjectionContext,
    pub declarations: AttemptDeclarationMap,
}

impl AttemptContext {
    fn validate_identity(&self) -> Result<(), String> {
        self.projection.validate_identity(
            &self.attempt_id,
            &self.declarations.provider_protocol,
            &self.declarations.provider_model,
        )?;
        self.declarations.validate_identity(
            &self.attempt_id,
            &self.projection.provider_protocol,
            &self.projection.provider_model,
        )
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResponseProjectionView {
    request: RequestScopedContextPair,
    successful_attempt: AttemptContext,
}

impl ResponseProjectionView {
    pub fn from_successful_attempt(
        request: &V3RequestContextHandle,
        attempt_context: &AttemptContext,
    ) -> Result<Self, String> {
        let request_pair = request.original_pair()?;
        let successful_attempt = request.successful_attempt(&attempt_context.attempt_id)?;
        if &successful_attempt != attempt_context {
            return Err(format!(
                "attempt `{}` does not match the successful attempt stored for request {}",
                attempt_context.attempt_id,
                request.request_id()
            ));
        }
        Ok(Self {
            request: request_pair,
            successful_attempt,
        })
    }

    pub fn request_inverse_context(&self) -> &RequestInverseContext {
        &self.request.inverse_context
    }

    pub fn explicit_history_pairing(&self) -> &ExplicitHistoryPairing {
        &self.request.explicit_history_pairing
    }

    pub fn attempt(&self) -> &AttemptContext {
        &self.successful_attempt
    }
}

#[derive(Clone, Debug)]
pub struct V3RequestContextHandle {
    inner: Arc<V3RequestContextInner>,
}

#[derive(Debug)]
struct V3RequestContextInner {
    request_id: String,
    entry_protocol: String,
    slots: Mutex<RequestContextSlots>,
    terminated: AtomicBool,
    finalizer_taken: AtomicBool,
}

#[derive(Default, Debug)]
struct RequestContextSlots {
    original_pair: Option<RequestScopedContextPair>,
    current_field_associations: Option<CurrentFieldAssociations>,
    successful_attempt: Option<AttemptContext>,
    failed_attempts: Vec<(String, String)>,
    attempt_released: bool,
    request_released: bool,
    #[cfg(test)]
    release_events: Vec<&'static str>,
}

impl V3RequestContextHandle {
    pub fn new(request_id: String, entry_protocol: String) -> Self {
        Self {
            inner: Arc::new(V3RequestContextInner {
                request_id,
                entry_protocol,
                slots: Mutex::new(RequestContextSlots::default()),
                terminated: AtomicBool::new(false),
                finalizer_taken: AtomicBool::new(false),
            }),
        }
    }

    pub fn request_id(&self) -> &str {
        &self.inner.request_id
    }

    pub fn entry_protocol(&self) -> &str {
        &self.inner.entry_protocol
    }

    pub fn same_scope(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }

    pub fn take_finalizer(&self) -> Result<V3RequestFinalizerGuard, String> {
        if self.inner.finalizer_taken.swap(true, Ordering::AcqRel) {
            return Err(format!(
                "request {} finalizer guard already taken",
                self.inner.request_id
            ));
        }
        Ok(V3RequestFinalizerGuard::new(self.inner.clone()))
    }

    pub fn original_pair(&self) -> Result<RequestScopedContextPair, String> {
        self.ensure_active()?;
        let slots = lock_slots_guard(&self.inner.slots)?;
        slots.original_pair.clone().ok_or_else(|| {
            format!(
                "request {} original pair not initialized",
                self.inner.request_id
            )
        })
    }

    pub fn current_field_associations(&self) -> Result<CurrentFieldAssociations, String> {
        self.ensure_active()?;
        let slots = lock_slots_guard(&self.inner.slots)?;
        slots.current_field_associations.clone().ok_or_else(|| {
            format!(
                "request {} current field associations not initialized",
                self.inner.request_id
            )
        })
    }

    pub fn current_field_associations_option(
        &self,
    ) -> Result<Option<CurrentFieldAssociations>, String> {
        self.ensure_active()?;
        let slots = lock_slots_guard(&self.inner.slots)?;
        Ok(slots.current_field_associations.clone())
    }

    pub(crate) fn publish_current_field_associations(
        &self,
        associations: CurrentFieldAssociations,
    ) -> Result<(), String> {
        self.ensure_active()?;
        let mut slots = lock_slots_guard(&self.inner.slots)?;
        slots.current_field_associations = Some(associations);
        Ok(())
    }

    pub fn publish_original_pair(
        &self,
        candidate: RequestScopedContextPair,
    ) -> Result<RequestScopedContextPair, String> {
        self.ensure_active()?;
        let mut slots = lock_slots_guard(&self.inner.slots)?;
        if slots.original_pair.is_some() {
            return Err(format!(
                "request {} original pair already published; reentry requires AlreadyCanonical",
                self.inner.request_id
            ));
        }
        slots.original_pair = Some(candidate.clone());
        Ok(candidate)
    }

    pub fn publish_successful_attempt(&self, context: AttemptContext) -> Result<(), String> {
        self.ensure_active()?;
        context.validate_identity()?;
        let mut slots = lock_slots_guard(&self.inner.slots)?;
        slots
            .failed_attempts
            .retain(|(attempt_id, _)| attempt_id != &context.attempt_id);
        slots.successful_attempt = Some(context);
        Ok(())
    }

    pub fn record_failed_attempt(&self, attempt_id: &str, reason: &str) -> Result<(), String> {
        self.ensure_active()?;
        let mut slots = lock_slots_guard(&self.inner.slots)?;
        if slots
            .successful_attempt
            .as_ref()
            .is_some_and(|attempt| attempt.attempt_id == attempt_id)
        {
            return Err(format!(
                "attempt {attempt_id} already recorded as successful"
            ));
        }
        slots
            .failed_attempts
            .retain(|(stored, _)| stored != attempt_id);
        slots
            .failed_attempts
            .push((attempt_id.to_string(), reason.to_string()));
        Ok(())
    }

    pub fn successful_attempt(&self, attempt_id: &str) -> Result<AttemptContext, String> {
        self.ensure_active()?;
        let slots = lock_slots_guard(&self.inner.slots)?;
        slots
            .successful_attempt
            .as_ref()
            .filter(|attempt| attempt.attempt_id == attempt_id)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "request {} has no successful attempt `{attempt_id}`",
                    self.inner.request_id
                )
            })
    }

    fn ensure_active(&self) -> Result<(), String> {
        if self.inner.terminated.load(Ordering::Acquire) {
            return Err(format!(
                "request {} scope already released",
                self.inner.request_id
            ));
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn poison_slots_for_test(&self) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = self
                .inner
                .slots
                .lock()
                .expect("test poison guard must acquire request slots");
            panic!("poison request slots for test");
        }));
    }

    #[cfg(test)]
    pub(super) fn release_events_for_test(&self) -> Vec<&'static str> {
        self.inner
            .slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .release_events
            .clone()
    }
}

#[derive(Debug)]
pub struct V3RequestFinalizerGuard {
    inner: Arc<V3RequestContextInner>,
    finalized: AtomicBool,
}

impl V3RequestFinalizerGuard {
    fn new(inner: Arc<V3RequestContextInner>) -> Self {
        Self {
            inner,
            finalized: AtomicBool::new(false),
        }
    }

    pub fn finalize(&self) -> Result<(), String> {
        if !self.finalized.swap(true, Ordering::AcqRel) {
            release_request_scope(&self.inner)
        } else {
            Ok(())
        }
    }
}

impl Drop for V3RequestFinalizerGuard {
    fn drop(&mut self) {
        if let Err(error) = self.finalize() {
            eprintln!("request finalization error: {error}");
        }
    }
}

fn release_request_scope(inner: &V3RequestContextInner) -> Result<(), String> {
    let (mut slots, poison_error) = match inner.slots.lock() {
        Ok(slots) => (slots, None),
        Err(poisoned) => (
            poisoned.into_inner(),
            Some("request-scoped context slot lock poisoned during finalization".to_string()),
        ),
    };
    if !slots.attempt_released {
        slots.attempt_released = true;
        slots.successful_attempt = None;
        slots.failed_attempts.clear();
        #[cfg(test)]
        slots.release_events.push("attempts-cleared");
    }
    if !slots.request_released {
        slots.request_released = true;
        slots.current_field_associations = None;
        slots.original_pair = None;
        #[cfg(test)]
        slots.release_events.push("current-associations-cleared");
        #[cfg(test)]
        slots.release_events.push("original-pair-cleared");
        inner.terminated.store(true, Ordering::Release);
        #[cfg(test)]
        slots.release_events.push("terminated");
    }
    drop(slots);
    if poison_error.is_some() {
        inner.slots.clear_poison();
    }
    poison_error.map_or(Ok(()), Err)
}

#[derive(Clone, Debug)]
pub struct RequestInvocationContext {
    request_handle: V3RequestContextHandle,
    invocation_id: String,
    attempt_id: String,
    origin_kind: RequestOriginKind,
}

impl RequestInvocationContext {
    pub fn new(
        request_handle: V3RequestContextHandle,
        invocation_id: String,
        attempt_id: String,
        origin_kind: RequestOriginKind,
    ) -> Self {
        Self {
            request_handle,
            invocation_id,
            attempt_id,
            origin_kind,
        }
    }

    pub fn request_handle(&self) -> &V3RequestContextHandle {
        &self.request_handle
    }

    pub fn invocation_id(&self) -> &str {
        &self.invocation_id
    }

    pub fn attempt_id(&self) -> &str {
        &self.attempt_id
    }

    pub fn origin_kind(&self) -> RequestOriginKind {
        self.origin_kind
    }
}

fn lock_slots_guard(
    slots: &Mutex<RequestContextSlots>,
) -> Result<MutexGuard<'_, RequestContextSlots>, String> {
    slots
        .lock()
        .map_err(|_| "request-scoped context slot lock poisoned".to_string())
}

fn required_string(object: &Map<String, Value>, key: &str) -> Result<String, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("request inverse object omitted string `{key}`"))
}

fn required_array<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a Vec<Value>, String> {
    object
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("request inverse object omitted array `{key}`"))
}

fn parse_field_mapping(value: &Value) -> Result<FieldMapping, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "field mapping record must be an object".to_string())?;
    Ok(FieldMapping {
        source_path: required_string(object, "source_path")?,
        destination: required_string(object, "destination")?,
        operator: required_string(object, "operator")?,
        shape: optional_string(object, "shape"),
        semantics: optional_string(object, "semantics"),
        transform_id: optional_string(object, "transform_id"),
        collision_policy: optional_string(object, "collision_policy"),
        encoding: required_string(object, "encoding")?,
    })
}

fn parse_opaque_reference(value: &Value) -> Result<OpaqueRecordReference, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "opaque reference must be an object".to_string())?;
    Ok(OpaqueRecordReference {
        record_id: required_string(object, "record_id")?,
        path: required_string(object, "path")?,
        encoding: required_string(object, "encoding")?,
    })
}

fn parse_tool_declaration(value: &Value) -> Result<ToolDeclarationReference, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "tool declaration reference must be an object".to_string())?;
    Ok(ToolDeclarationReference {
        record_id: required_string(object, "record_id")?,
        source_path: required_string(object, "source_path")?,
        kind: required_string(object, "kind")?,
        name: optional_string(object, "name"),
        namespace: object.get("namespace").cloned(),
        encoding: required_string(object, "encoding")?,
    })
}

fn parse_history_pairing(value: &Value) -> Result<HistoryPairingReference, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "history pairing record must be an object".to_string())?;
    Ok(HistoryPairingReference {
        source_path: required_string(object, "source_path")?,
        call_id: optional_string(object, "call_id"),
        name: optional_string(object, "name"),
        kind: required_string(object, "kind")?,
        namespace: object.get("namespace").cloned(),
        encoding: required_string(object, "encoding")?,
    })
}

fn parse_native_container_binding(value: &Value) -> Result<NativeContainerBinding, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "native container binding record must be an object".to_string())?;
    let source_path = required_string(object, "source_path")?;
    let canonical_anchor = required_string(object, "canonical_anchor")?;
    let role = match required_string(object, "role")?.as_str() {
        "tool_result_part" => NativeContainerRole::ToolResultPart,
        "content_part" => NativeContainerRole::ContentPart,
        "function_call_part" => NativeContainerRole::FunctionCallPart,
        "message" => NativeContainerRole::Message,
        "generation_config" => NativeContainerRole::GenerationConfig,
        "tool_declaration" => NativeContainerRole::ToolDeclaration,
        role => {
            return Err(format!(
                "native container binding has unknown role `{role}`"
            ));
        }
    };
    Ok(NativeContainerBinding {
        source_path,
        canonical_anchor,
        role,
    })
}

fn optional_string(object: &Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(Value::as_str).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> RequestScopedContextPair {
        RequestScopedContextPair {
            inverse_context: RequestInverseContext {
                entry_protocol: "responses".to_string(),
                normalized_protocol: "chat".to_string(),
                field_mappings: Vec::new(),
                opaque_record_references: Vec::new(),
                tool_declarations: Vec::new(),
                native_container_bindings: Vec::new(),
            },
            explicit_history_pairing: ExplicitHistoryPairing {
                entry_protocol: "responses".to_string(),
                messages: Vec::new(),
            },
        }
    }

    fn associations(destination: &str) -> CurrentFieldAssociations {
        CurrentFieldAssociations::from_normalization(&RequestInverseContext {
            entry_protocol: "responses".to_string(),
            normalized_protocol: "chat".to_string(),
            field_mappings: vec![FieldMapping {
                source_path: "request.tools[0]".to_string(),
                destination: destination.to_string(),
                operator: "test".to_string(),
                shape: None,
                semantics: None,
                transform_id: None,
                collision_policy: None,
                encoding: "json".to_string(),
            }],
            opaque_record_references: Vec::new(),
            tool_declarations: Vec::new(),
            native_container_bindings: Vec::new(),
        })
    }

    #[test]
    fn current_associations_are_request_local_and_failed_attempts_do_not_clear_them() {
        let request_a = V3RequestContextHandle::new("a".to_string(), "responses".to_string());
        let request_b = V3RequestContextHandle::new("b".to_string(), "responses".to_string());
        let current_a = associations("chat.tools[0]");
        let current_b = associations("chat.tools[1]");

        request_a.publish_original_pair(pair()).unwrap();
        request_b.publish_original_pair(pair()).unwrap();
        request_a
            .publish_current_field_associations(current_a.clone())
            .unwrap();
        request_b
            .publish_current_field_associations(current_b.clone())
            .unwrap();
        request_a
            .record_failed_attempt("attempt-retry", "retry")
            .unwrap();

        assert_eq!(request_a.current_field_associations().unwrap(), current_a);
        assert_eq!(request_b.current_field_associations().unwrap(), current_b);
    }

    #[test]
    fn finalizer_clears_current_associations_after_attempts_and_before_original_pair() {
        let request = V3RequestContextHandle::new("finalize".to_string(), "responses".to_string());
        request.publish_original_pair(pair()).unwrap();
        request
            .publish_current_field_associations(associations("chat.tools[0]"))
            .unwrap();
        request
            .publish_successful_attempt(AttemptContext {
                attempt_id: "attempt-1".to_string(),
                projection: AttemptProjectionContext {
                    attempt_id: "attempt-1".to_string(),
                    provider_protocol: "chat".to_string(),
                    provider_model: "model".to_string(),
                    paths: Vec::new(),
                },
                declarations: AttemptDeclarationMap {
                    attempt_id: "attempt-1".to_string(),
                    provider_protocol: "chat".to_string(),
                    provider_model: "model".to_string(),
                    tool_mappings: Vec::new(),
                },
            })
            .unwrap();

        let guard = request.clone().take_finalizer().unwrap();
        guard.finalize().unwrap();

        assert_eq!(
            request.release_events_for_test(),
            vec![
                "attempts-cleared",
                "current-associations-cleared",
                "original-pair-cleared",
                "terminated"
            ]
        );
        assert!(request.current_field_associations().is_err());
        assert!(request.original_pair().is_err());
        assert!(request
            .publish_current_field_associations(associations("chat.tools[0]"))
            .is_err());
    }

    #[test]
    fn dropped_finalizer_clears_current_associations_and_clone_cannot_read_them() {
        let request = V3RequestContextHandle::new("drop".to_string(), "responses".to_string());
        request.publish_original_pair(pair()).unwrap();
        request
            .publish_current_field_associations(associations("chat.tools[0]"))
            .unwrap();
        let clone = request.clone();

        let guard = request.clone().take_finalizer().unwrap();
        drop(guard);

        assert!(request.current_field_associations().is_err());
        assert!(clone.current_field_associations().is_err());
    }
}
