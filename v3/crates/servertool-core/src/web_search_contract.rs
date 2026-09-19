use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Request-local scope carried by a WebSearch hook execution.
///
/// This is a serialized control-plane boundary between Runtime and the hooks
/// sidecar. It must never be projected into a client response or provider body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WebSearchHookScope {
    pub entry_endpoint: String,
    pub session_id: String,
    pub conversation_id: String,
    pub port: u16,
    pub routing_group: String,
}

impl WebSearchHookScope {
    pub fn validate(&self) -> Result<(), WebSearchHookContractError> {
        if self.entry_endpoint.trim().is_empty() {
            return Err(WebSearchHookContractError::MissingScopeField(
                "entryEndpoint",
            ));
        }
        if self.session_id.trim().is_empty() {
            return Err(WebSearchHookContractError::MissingScopeField("sessionId"));
        }
        if self.conversation_id.trim().is_empty() {
            return Err(WebSearchHookContractError::MissingScopeField(
                "conversationId",
            ));
        }
        if self.routing_group.trim().is_empty() {
            return Err(WebSearchHookContractError::MissingScopeField(
                "routingGroup",
            ));
        }
        if self.session_id == self.conversation_id && self.session_id.starts_with("request:") {
            return Err(WebSearchHookContractError::MissingClientSessionScope);
        }
        Ok(())
    }
}

/// Typed request sent to the WebSearch hook adapter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WebSearchHookRequest {
    pub request_id: String,
    pub call_id: String,
    pub query: String,
    pub count: Option<u32>,
    pub recency: Option<String>,
    pub content_types: Vec<String>,
    pub scope: WebSearchHookScope,
    /// Absolute request deadline. The adapter owns enforcement; callers may
    /// not replace this with a local timeout that is not tied to the request.
    pub deadline_unix_ms: u64,
    pub policy_id: String,
}

impl WebSearchHookRequest {
    pub fn validate(&self) -> Result<(), WebSearchHookContractError> {
        if self.request_id.trim().is_empty() {
            return Err(WebSearchHookContractError::MissingRequestId);
        }
        if self.call_id.trim().is_empty() {
            return Err(WebSearchHookContractError::MissingCallId);
        }
        if self.query.trim().is_empty() {
            return Err(WebSearchHookContractError::MissingQuery);
        }
        if self.policy_id.trim().is_empty() {
            return Err(WebSearchHookContractError::MissingPolicyId);
        }
        if self.deadline_unix_ms == 0 {
            return Err(WebSearchHookContractError::MissingDeadline);
        }
        self.scope.validate()?;
        Ok(())
    }

    pub fn validate_at(&self, now_unix_ms: u64) -> Result<(), WebSearchHookContractError> {
        self.validate()?;
        if now_unix_ms >= self.deadline_unix_ms {
            return Err(WebSearchHookContractError::DeadlineExpired);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebSearchResultStatus {
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WebSearchSource {
    pub ref_id: String,
    pub url: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WebSearchError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

/// Typed result returned by the WebSearch hook adapter.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WebSearchResult {
    pub call_id: String,
    pub status: WebSearchResultStatus,
    pub content: Option<String>,
    pub sources: Vec<WebSearchSource>,
    pub metadata: Option<Value>,
    pub error: Option<WebSearchError>,
}

impl WebSearchResult {
    pub fn validate(&self) -> Result<(), WebSearchHookContractError> {
        if self.call_id.trim().is_empty() {
            return Err(WebSearchHookContractError::MissingCallId);
        }
        match self.status {
            WebSearchResultStatus::Completed => {
                if self.error.is_some() {
                    return Err(WebSearchHookContractError::CompletedResultHasError);
                }
                if self.content.as_deref().is_none_or(str::is_empty) && self.sources.is_empty() {
                    return Err(WebSearchHookContractError::CompletedResultEmpty);
                }
            }
            WebSearchResultStatus::Failed => {
                if self.error.is_none() {
                    return Err(WebSearchHookContractError::FailedResultMissingError);
                }
                if self.content.is_some() || !self.sources.is_empty() {
                    return Err(WebSearchHookContractError::FailedResultHasContent);
                }
            }
        }
        if self
            .sources
            .iter()
            .any(|source| source.ref_id.trim().is_empty())
        {
            return Err(WebSearchHookContractError::MissingSourceRef);
        }
        if self
            .metadata
            .as_ref()
            .is_some_and(web_search_metadata_contains_control_state)
        {
            return Err(WebSearchHookContractError::ControlStateInMetadata);
        }
        Ok(())
    }
}

/// Return to the caller. `NotApplicable` means the request never entered a
/// search-capable execution path; it is not a successful empty result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
pub enum WebSearchHookOutcome {
    NotApplicable,
    Completed(WebSearchResult),
    Failed(WebSearchError),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WebSearchHookContractError {
    #[error("web_search hook request requires a non-empty requestId")]
    MissingRequestId,
    #[error("web_search hook request requires a non-empty callId")]
    MissingCallId,
    #[error("web_search hook request requires a non-empty query")]
    MissingQuery,
    #[error("web_search hook request requires a non-empty policyId")]
    MissingPolicyId,
    #[error("web_search hook request requires a non-zero deadline")]
    MissingDeadline,
    #[error("web_search hook request deadline has expired")]
    DeadlineExpired,
    #[error("web_search hook scope requires a non-empty {0}")]
    MissingScopeField(&'static str),
    #[error("web_search hook scope requires a client session identity, not a request-only scope")]
    MissingClientSessionScope,
    #[error("completed web_search result must not carry an error")]
    CompletedResultHasError,
    #[error("completed web_search result requires content or sources")]
    CompletedResultEmpty,
    #[error("failed web_search result requires a typed error")]
    FailedResultMissingError,
    #[error("failed web_search result must not carry content or sources")]
    FailedResultHasContent,
    #[error("web_search result source requires a non-empty refId")]
    MissingSourceRef,
    #[error("web_search result metadata must not carry control state")]
    ControlStateInMetadata,
}

fn web_search_metadata_contains_control_state(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            matches!(key.as_str(), "phase" | "scope_key" | "call_id")
                || web_search_metadata_contains_control_state(value)
        }),
        Value::Array(items) => items.iter().any(web_search_metadata_contains_control_state),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> WebSearchHookRequest {
        WebSearchHookRequest {
            request_id: "req-1".to_string(),
            call_id: "call-web-search-1".to_string(),
            query: "routecodex".to_string(),
            count: Some(3),
            recency: None,
            content_types: vec!["text".to_string()],
            scope: WebSearchHookScope {
                entry_endpoint: "/v1/responses".to_string(),
                session_id: "session-1".to_string(),
                conversation_id: "conversation-1".to_string(),
                port: 5520,
                routing_group: "default".to_string(),
            },
            deadline_unix_ms: 2_000,
            policy_id: "metadata-center-local-search".to_string(),
        }
    }

    #[test]
    fn request_accepts_real_client_scope_before_deadline() {
        request().validate_at(1_000).unwrap();
    }

    #[test]
    fn request_rejects_request_only_scope() {
        let mut request = request();
        request.scope.session_id = "request:req-1".to_string();
        request.scope.conversation_id = "request:req-1".to_string();
        assert_eq!(
            request.validate(),
            Err(WebSearchHookContractError::MissingClientSessionScope)
        );
    }

    #[test]
    fn request_rejects_expired_deadline() {
        assert_eq!(
            request().validate_at(2_000),
            Err(WebSearchHookContractError::DeadlineExpired)
        );
    }

    #[test]
    fn completed_result_accepts_sources_without_control_state() {
        WebSearchResult {
            call_id: "call-web-search-1".to_string(),
            status: WebSearchResultStatus::Completed,
            content: Some("result".to_string()),
            sources: vec![WebSearchSource {
                ref_id: "source-1".to_string(),
                url: Some("https://example.com".to_string()),
                title: Some("Example".to_string()),
            }],
            metadata: Some(json!({"usage":{"searchQueries":1}})),
            error: None,
        }
        .validate()
        .unwrap();
    }

    #[test]
    fn failed_result_rejects_content() {
        assert_eq!(
            WebSearchResult {
                call_id: "call-web-search-1".to_string(),
                status: WebSearchResultStatus::Failed,
                content: Some("not a success".to_string()),
                sources: Vec::new(),
                metadata: None,
                error: Some(WebSearchError {
                    code: "timeout".to_string(),
                    message: "deadline exceeded".to_string(),
                    retryable: true,
                }),
            }
            .validate(),
            Err(WebSearchHookContractError::FailedResultHasContent)
        );
    }
}
