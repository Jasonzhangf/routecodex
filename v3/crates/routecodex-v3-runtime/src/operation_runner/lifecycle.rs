use super::OperationRunnerError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum V3RequestOriginKind {
    ClientEntry,
    Retry,
    InternalFollowup,
}

impl V3RequestOriginKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClientEntry => "client_entry",
            Self::Retry => "retry",
            Self::InternalFollowup => "internal_followup",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V3RequestOrigin {
    pub request_id: String,
    pub invocation_id: String,
    pub origin_kind: V3RequestOriginKind,
}

impl V3RequestOrigin {
    pub fn new(
        request_id: impl Into<String>,
        invocation_id: impl Into<String>,
        origin_kind: V3RequestOriginKind,
    ) -> Result<Self, OperationRunnerError> {
        let request_id = request_id.into();
        let invocation_id = invocation_id.into();
        if request_id.is_empty() || invocation_id.is_empty() {
            return Err(OperationRunnerError::new(
                "request origin requires request and invocation identities",
            ));
        }
        Ok(Self {
            request_id,
            invocation_id,
            origin_kind,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum V3RequestScopedResource {
    RequestInverseContext,
    ExplicitHistoryPairing,
    ExecutionMode,
    MetadataCenterControl,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum V3AttemptScopedResource {
    AttemptProjectionContext,
    AttemptDeclarationMap,
    ResponseProvenance,
    ResponseToolBinding,
    ClientFrameCandidate,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum V3AttemptCleanupReason {
    RetryLaunch,
    RefillRequested,
    ClientCommit,
    TerminalClientError,
    Cancel,
    Disconnect,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct V3AttemptCleanupReceipt {
    pub attempt_id: String,
    pub reason: V3AttemptCleanupReason,
    pub released: Vec<V3AttemptScopedResource>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum V3RequestFinalizeReason {
    ClientCommit,
    QualifiedFinalHttpProjection,
    UnqualifiedTerminal,
    Cancel,
    Disconnect,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct V3RequestFinalizeReceipt {
    pub request_id: String,
    pub reason: V3RequestFinalizeReason,
    pub released: Vec<V3RequestScopedResource>,
}

/// Typed owner of the request- and attempt-scoped control slots used by the
/// operation runner. The request origin is invocation scoped, so it is not a
/// MetadataCenter slot and cannot be released by the request finalizer.
#[derive(Debug)]
pub struct V3MetadataCenterControl {
    origin: Option<V3RequestOrigin>,
    request_resources: BTreeSet<V3RequestScopedResource>,
    attempt_id: Option<String>,
    attempt_resources: BTreeSet<V3AttemptScopedResource>,
}

impl V3MetadataCenterControl {
    pub fn begin_client_entry(origin: V3RequestOrigin) -> Result<Self, OperationRunnerError> {
        if origin.origin_kind != V3RequestOriginKind::ClientEntry {
            return Err(OperationRunnerError::new(
                "client entry requires client_entry request origin",
            ));
        }
        Ok(Self {
            origin: Some(origin),
            request_resources: BTreeSet::from([
                V3RequestScopedResource::RequestInverseContext,
                V3RequestScopedResource::ExplicitHistoryPairing,
            ]),
            attempt_id: None,
            attempt_resources: BTreeSet::new(),
        })
    }

    pub fn reenter(
        origin: V3RequestOrigin,
        request_resources: impl IntoIterator<Item = V3RequestScopedResource>,
    ) -> Result<Self, OperationRunnerError> {
        if origin.origin_kind == V3RequestOriginKind::ClientEntry {
            return Err(OperationRunnerError::new(
                "re-entry requires retry or internal_followup request origin",
            ));
        }
        let request_resources = request_resources.into_iter().collect::<BTreeSet<_>>();
        let required = BTreeSet::from([
            V3RequestScopedResource::RequestInverseContext,
            V3RequestScopedResource::ExplicitHistoryPairing,
            V3RequestScopedResource::ExecutionMode,
        ]);
        if !required.is_subset(&request_resources) {
            return Err(OperationRunnerError::new(
                "request re-entry requires preserved inverse, history, and execution-mode resources",
            ));
        }
        Ok(Self {
            origin: Some(origin),
            request_resources,
            attempt_id: None,
            attempt_resources: BTreeSet::new(),
        })
    }

    pub fn origin(&self) -> Option<&V3RequestOrigin> {
        self.origin.as_ref()
    }

    pub fn set_execution_mode(&mut self) {
        self.request_resources
            .insert(V3RequestScopedResource::ExecutionMode);
    }

    pub fn set_metadata_center_control(&mut self) {
        self.request_resources
            .insert(V3RequestScopedResource::MetadataCenterControl);
    }

    pub fn begin_attempt(
        &mut self,
        attempt_id: impl Into<String>,
    ) -> Result<(), OperationRunnerError> {
        if self.attempt_id.is_some() {
            return Err(OperationRunnerError::new(
                "an attempt is already active for this request invocation",
            ));
        }
        let attempt_id = attempt_id.into();
        if attempt_id.is_empty() {
            return Err(OperationRunnerError::new("attempt id must not be empty"));
        }
        self.attempt_id = Some(attempt_id);
        self.attempt_resources = BTreeSet::from([
            V3AttemptScopedResource::AttemptProjectionContext,
            V3AttemptScopedResource::AttemptDeclarationMap,
            V3AttemptScopedResource::ResponseProvenance,
            V3AttemptScopedResource::ResponseToolBinding,
            V3AttemptScopedResource::ClientFrameCandidate,
        ]);
        Ok(())
    }

    pub fn cleanup_attempt(
        &mut self,
        reason: V3AttemptCleanupReason,
    ) -> Result<V3AttemptCleanupReceipt, OperationRunnerError> {
        let attempt_id = self.attempt_id.take().ok_or_else(|| {
            OperationRunnerError::new("attempt cleanup requires an active attempt")
        })?;
        let released = std::mem::take(&mut self.attempt_resources)
            .into_iter()
            .collect();
        Ok(V3AttemptCleanupReceipt {
            attempt_id,
            reason,
            released,
        })
    }

    pub fn finalize(
        &mut self,
        reason: V3RequestFinalizeReason,
    ) -> Result<V3RequestFinalizeReceipt, OperationRunnerError> {
        if self.attempt_id.is_some() || !self.attempt_resources.is_empty() {
            return Err(OperationRunnerError::new(
                "request finalization requires attempt cleanup first",
            ));
        }
        let request_id = self
            .origin
            .as_ref()
            .map(|origin| origin.request_id.clone())
            .ok_or_else(|| OperationRunnerError::new("request origin is no longer available"))?;
        let released = std::mem::take(&mut self.request_resources)
            .into_iter()
            .collect();
        self.origin = None;
        Ok(V3RequestFinalizeReceipt {
            request_id,
            reason,
            released,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin(kind: V3RequestOriginKind, invocation_id: &str) -> V3RequestOrigin {
        V3RequestOrigin::new("request-1", invocation_id, kind).unwrap()
    }

    #[test]
    fn request_origin_is_typed_and_serializes_outside_payload_resources() {
        let origin = origin(V3RequestOriginKind::Retry, "invocation-2");
        assert_eq!(
            serde_json::to_value(&origin).unwrap(),
            serde_json::json!({
                "requestId": "request-1",
                "invocationId": "invocation-2",
                "originKind": "retry"
            })
        );
    }

    #[test]
    fn attempt_cleanup_preserves_request_scope_until_finalize() {
        let mut control = V3MetadataCenterControl::begin_client_entry(origin(
            V3RequestOriginKind::ClientEntry,
            "invocation-1",
        ))
        .unwrap();
        control.set_execution_mode();
        control.set_metadata_center_control();
        control.begin_attempt("attempt-1").unwrap();

        let cleanup = control
            .cleanup_attempt(V3AttemptCleanupReason::RetryLaunch)
            .unwrap();
        assert_eq!(cleanup.attempt_id, "attempt-1");
        assert!(cleanup
            .released
            .contains(&V3AttemptScopedResource::AttemptProjectionContext));
        assert!(control.origin().is_some());

        let finalize = control
            .finalize(V3RequestFinalizeReason::ClientCommit)
            .unwrap();
        assert!(finalize
            .released
            .contains(&V3RequestScopedResource::RequestInverseContext));
        assert!(finalize
            .released
            .contains(&V3RequestScopedResource::ExplicitHistoryPairing));
        assert!(finalize
            .released
            .contains(&V3RequestScopedResource::ExecutionMode));
        assert!(finalize
            .released
            .contains(&V3RequestScopedResource::MetadataCenterControl));
        assert!(control.origin().is_none());
    }

    #[test]
    fn request_finalizer_rejects_live_attempt_scope() {
        let mut control = V3MetadataCenterControl::begin_client_entry(origin(
            V3RequestOriginKind::ClientEntry,
            "invocation-1",
        ))
        .unwrap();
        control.begin_attempt("attempt-1").unwrap();

        let error = control
            .finalize(V3RequestFinalizeReason::ClientCommit)
            .expect_err("attempt cleanup must precede request finalization");
        assert!(error.message.contains("attempt cleanup first"), "{error}");
    }

    #[test]
    fn retry_reentry_requires_all_request_scoped_resources() {
        let error = V3MetadataCenterControl::reenter(
            origin(V3RequestOriginKind::Retry, "retry-2"),
            [V3RequestScopedResource::ExecutionMode],
        )
        .expect_err("retry must not resurrect with a partial request scope");
        assert!(error.message.contains("preserved inverse"), "{error}");
    }
}
