use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubPipelineDiagnostic {
    pub stage_id: String,
    pub status: HubPipelineDiagnosticStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum HubPipelineDiagnosticStatus {
    Started,
    Completed,
    Failed,
    Skipped,
}
