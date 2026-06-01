use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubPipelineError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl HubPipelineError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Value,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: Some(details),
        }
    }
}

impl From<String> for HubPipelineError {
    fn from(message: String) -> Self {
        if message.contains("orphan_tool_result") || message.contains("missing_tool_call_id") {
            return Self::new("MALFORMED_REQUEST", message);
        }
        Self::new("hub_pipeline_error", message)
    }
}

impl From<serde_json::Error> for HubPipelineError {
    fn from(error: serde_json::Error) -> Self {
        Self::new("hub_pipeline_json_error", error.to_string())
    }
}

pub type HubPipelineResult<T> = Result<T, HubPipelineError>;
