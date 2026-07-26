use crate::hub_v1::{
    V3ResponsesRelayLocalContinuationScope, V3ResponsesRelayLocalContinuationState,
};
use crate::kernel::{V3ResponsesDirectContinuationScope, V3ResponsesDirectContinuationState};
use routecodex_v3_config::V3EntryProtocolExecutionMode;
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error06ClientProjected, V3ErrorActionScope,
    V3ErrorHandlingCenter, V3ErrorHandlingCenterInput, V3ErrorSourceKind,
};
use serde_json::Value;

const V3_RESPONSES_CONTINUATION_OWNER_NODE: &str = "V3HubReqContinuation03Classified";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum V3ResponsesPreviousResponseOwnerResolutionError {
    #[error("previous_response_id {response_id} was not found in direct remote or relay local continuation owner store")]
    NotFound { response_id: String },
    #[error(
        "previous_response_id {response_id} has ambiguous direct and relay continuation owners"
    )]
    Ambiguous { response_id: String },
    #[error(
        "direct continuation owner lookup failed at V3HubReqContinuation03Classified: {message}"
    )]
    DirectState { message: String },
    #[error("relay local continuation owner lookup failed at V3HubReqContinuation03Classified: {message}")]
    RelayState { message: String },
}

impl V3ResponsesPreviousResponseOwnerResolutionError {
    pub const fn source_stage(&self) -> &'static str {
        V3_RESPONSES_CONTINUATION_OWNER_NODE
    }

    pub const fn code(&self) -> &'static str {
        match self {
            Self::NotFound { .. } => "responses_continuation_not_found",
            Self::Ambiguous { .. } => "responses_continuation_owner_invalid",
            Self::DirectState { .. } | Self::RelayState { .. } => {
                "responses_continuation_owner_lookup_failed"
            }
        }
    }

    pub const fn is_internal_state_failure(&self) -> bool {
        matches!(self, Self::DirectState { .. } | Self::RelayState { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct V3ResponsesPreviousResponseOwnerEvidence {
    response_id: String,
    direct_owned: bool,
    relay_owned: bool,
}

pub fn resolve_v3_responses_previous_response_owner_execution_mode_at_req03(
    payload: &Value,
    configured: V3EntryProtocolExecutionMode,
    direct_state: &V3ResponsesDirectContinuationState,
    relay_state: &V3ResponsesRelayLocalContinuationState,
    direct_scope: Option<&V3ResponsesDirectContinuationScope>,
    relay_scope: Option<&V3ResponsesRelayLocalContinuationScope>,
    now_epoch_ms: u64,
) -> Result<V3EntryProtocolExecutionMode, V3ResponsesPreviousResponseOwnerResolutionError> {
    let Some(response_id) = read_previous_response_id(payload) else {
        return Ok(configured);
    };
    let direct_owned = match direct_scope {
        Some(scope) => direct_state.contains_for_req03(&response_id, scope, now_epoch_ms),
        None => direct_state.contains(&response_id),
    }
    .map_err(|message| V3ResponsesPreviousResponseOwnerResolutionError::DirectState { message })?;
    let relay_owned = match relay_scope {
        Some(scope) => relay_state.contains_for_req03(&response_id, scope),
        None => relay_state.contains(&response_id),
    }
    .map_err(
        |error| V3ResponsesPreviousResponseOwnerResolutionError::RelayState {
            message: error.to_string(),
        },
    )?;
    resolve_v3_responses_previous_response_owner_evidence_at_req03(
        configured,
        Some(V3ResponsesPreviousResponseOwnerEvidence {
            response_id,
            direct_owned,
            relay_owned,
        }),
    )
}

pub fn project_v3_responses_previous_response_owner_resolution_error(
    error: V3ResponsesPreviousResponseOwnerResolutionError,
) -> V3Error06ClientProjected {
    let source_kind = if error.is_internal_state_failure() {
        V3ErrorSourceKind::RuntimeFailure
    } else {
        V3ErrorSourceKind::InvalidRequest
    };
    let source = build_v3_error_01_source_raised(
        source_kind,
        error.source_stage(),
        error.code(),
        error.to_string(),
    );
    V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
        source,
        action_scope: V3ErrorActionScope::None,
        candidates_remaining: 0,
        source_status: None,
    })
}

fn read_previous_response_id(payload: &Value) -> Option<String> {
    payload
        .get("previous_response_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn resolve_v3_responses_previous_response_owner_evidence_at_req03(
    configured: V3EntryProtocolExecutionMode,
    evidence: Option<V3ResponsesPreviousResponseOwnerEvidence>,
) -> Result<V3EntryProtocolExecutionMode, V3ResponsesPreviousResponseOwnerResolutionError> {
    let Some(evidence) = evidence else {
        return Ok(configured);
    };
    match (evidence.direct_owned, evidence.relay_owned) {
        (true, false) => Ok(V3EntryProtocolExecutionMode::Direct),
        (false, true) => Ok(V3EntryProtocolExecutionMode::Relay),
        (true, true) => Err(V3ResponsesPreviousResponseOwnerResolutionError::Ambiguous {
            response_id: evidence.response_id,
        }),
        (false, false) => Err(V3ResponsesPreviousResponseOwnerResolutionError::NotFound {
            response_id: evidence.response_id,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub_v1::V3ResponsesRelayLocalContinuationScope;
    use crate::kernel::V3ResponsesDirectContinuationScope;
    use serde_json::json;

    #[test]
    fn no_previous_response_id_keeps_configured_execution_mode() {
        assert_eq!(
            resolve_v3_responses_previous_response_owner_evidence_at_req03(
                V3EntryProtocolExecutionMode::Relay,
                None,
            )
            .unwrap(),
            V3EntryProtocolExecutionMode::Relay
        );
    }

    #[test]
    fn direct_owner_selects_direct_even_when_entry_config_is_relay() {
        assert_eq!(
            resolve_v3_responses_previous_response_owner_evidence_at_req03(
                V3EntryProtocolExecutionMode::Relay,
                Some(V3ResponsesPreviousResponseOwnerEvidence {
                    response_id: "resp_direct".to_string(),
                    direct_owned: true,
                    relay_owned: false,
                }),
            )
            .unwrap(),
            V3EntryProtocolExecutionMode::Direct
        );
    }

    #[test]
    fn relay_owner_selects_relay_even_when_entry_config_is_direct() {
        assert_eq!(
            resolve_v3_responses_previous_response_owner_evidence_at_req03(
                V3EntryProtocolExecutionMode::Direct,
                Some(V3ResponsesPreviousResponseOwnerEvidence {
                    response_id: "resp_relay".to_string(),
                    direct_owned: false,
                    relay_owned: true,
                }),
            )
            .unwrap(),
            V3EntryProtocolExecutionMode::Relay
        );
    }

    #[test]
    fn missing_owner_is_explicit_not_found_error_not_default_route() {
        let error = resolve_v3_responses_previous_response_owner_evidence_at_req03(
            V3EntryProtocolExecutionMode::Direct,
            Some(V3ResponsesPreviousResponseOwnerEvidence {
                response_id: "resp_missing".to_string(),
                direct_owned: false,
                relay_owned: false,
            }),
        )
        .unwrap_err();
        assert_eq!(error.code(), "responses_continuation_not_found");
        assert!(!error.is_internal_state_failure());
    }

    #[test]
    fn dual_owner_is_explicit_invalid_owner_error_not_default_route() {
        let error = resolve_v3_responses_previous_response_owner_evidence_at_req03(
            V3EntryProtocolExecutionMode::Direct,
            Some(V3ResponsesPreviousResponseOwnerEvidence {
                response_id: "resp_ambiguous".to_string(),
                direct_owned: true,
                relay_owned: true,
            }),
        )
        .unwrap_err();
        assert_eq!(error.code(), "responses_continuation_owner_invalid");
        assert!(!error.is_internal_state_failure());
    }

    #[test]
    fn scoped_direct_owner_store_selects_direct_at_req03() {
        let direct = V3ResponsesDirectContinuationState::default();
        let relay = V3ResponsesRelayLocalContinuationState::default();
        let direct_scope = V3ResponsesDirectContinuationScope::responses(
            "/v1/responses",
            "session-a",
            "conversation-a",
            5555,
            "coding",
        );
        let relay_scope = V3ResponsesRelayLocalContinuationScope::responses(
            "/v1/responses",
            "session-a",
            "conversation-a",
            5555,
            "coding",
        );
        direct
            .commit_for_req03_test("resp_direct_owner", &direct_scope, 1_000)
            .unwrap();

        let resolved = resolve_v3_responses_previous_response_owner_execution_mode_at_req03(
            &json!({"previous_response_id":"resp_direct_owner"}),
            V3EntryProtocolExecutionMode::Relay,
            &direct,
            &relay,
            Some(&direct_scope),
            Some(&relay_scope),
            1_001,
        )
        .unwrap();

        assert_eq!(resolved, V3EntryProtocolExecutionMode::Direct);
    }

    #[test]
    fn scoped_relay_owner_store_selects_relay_at_req03() {
        let direct = V3ResponsesDirectContinuationState::default();
        let relay = V3ResponsesRelayLocalContinuationState::default();
        let direct_scope = V3ResponsesDirectContinuationScope::responses(
            "/v1/responses",
            "session-a",
            "conversation-a",
            5555,
            "coding",
        );
        let relay_scope = V3ResponsesRelayLocalContinuationScope::responses(
            "/v1/responses",
            "session-a",
            "conversation-a",
            5555,
            "coding",
        );
        relay
            .commit_for_req03_test("resp_relay_owner", &relay_scope, 1_000)
            .unwrap();

        let resolved = resolve_v3_responses_previous_response_owner_execution_mode_at_req03(
            &json!({"previous_response_id":"resp_relay_owner"}),
            V3EntryProtocolExecutionMode::Direct,
            &direct,
            &relay,
            Some(&direct_scope),
            Some(&relay_scope),
            1_001,
        )
        .unwrap();

        assert_eq!(resolved, V3EntryProtocolExecutionMode::Relay);
    }

    #[test]
    fn scoped_owner_lookup_does_not_cross_session_or_default_route() {
        let direct = V3ResponsesDirectContinuationState::default();
        let relay = V3ResponsesRelayLocalContinuationState::default();
        let original_direct_scope = V3ResponsesDirectContinuationScope::responses(
            "/v1/responses",
            "session-a",
            "conversation-a",
            5555,
            "coding",
        );
        let current_direct_scope = V3ResponsesDirectContinuationScope::responses(
            "/v1/responses",
            "session-b",
            "conversation-b",
            5555,
            "coding",
        );
        let current_relay_scope = V3ResponsesRelayLocalContinuationScope::responses(
            "/v1/responses",
            "session-b",
            "conversation-b",
            5555,
            "coding",
        );
        direct
            .commit_for_req03_test("resp_cross_scope", &original_direct_scope, 1_000)
            .unwrap();

        let error = resolve_v3_responses_previous_response_owner_execution_mode_at_req03(
            &json!({"previous_response_id":"resp_cross_scope"}),
            V3EntryProtocolExecutionMode::Direct,
            &direct,
            &relay,
            Some(&current_direct_scope),
            Some(&current_relay_scope),
            1_001,
        )
        .unwrap_err();

        assert_eq!(error.code(), "responses_continuation_not_found");
    }
}
