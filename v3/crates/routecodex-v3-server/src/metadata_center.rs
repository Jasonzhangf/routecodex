use crate::V3ResponsesProtocolExecutionPlan;
use std::ops::Deref;

/// Request-scoped control carrier for the execution plan selected before
/// provider dispatch. It is not request/response payload and must not be
/// reconstructed from either wire shape.
#[derive(Debug, Clone)]
pub(crate) struct V3MetadataCenterExecutionPlan {
    pub(crate) request_id: String,
    pub(crate) pipeline_id: String,
    pub(crate) server_id: String,
    pub(crate) port: u16,
    pub(crate) session_scope: String,
    pub(crate) requested_stream: bool,
    plan: V3ResponsesProtocolExecutionPlan,
}

impl V3MetadataCenterExecutionPlan {
    pub(crate) fn new(
        request_id: impl Into<String>,
        pipeline_id: impl Into<String>,
        server_id: impl Into<String>,
        port: u16,
        session_scope: impl Into<String>,
        requested_stream: bool,
        plan: V3ResponsesProtocolExecutionPlan,
    ) -> Self {
        Self {
            request_id: request_id.into(),
            pipeline_id: pipeline_id.into(),
            server_id: server_id.into(),
            port,
            session_scope: session_scope.into(),
            requested_stream,
            plan,
        }
    }

    pub(crate) fn protocol_plan(&self) -> &V3ResponsesProtocolExecutionPlan {
        &self.plan
    }
}

impl Deref for V3MetadataCenterExecutionPlan {
    type Target = V3ResponsesProtocolExecutionPlan;

    fn deref(&self) -> &Self::Target {
        &self.plan
    }
}
