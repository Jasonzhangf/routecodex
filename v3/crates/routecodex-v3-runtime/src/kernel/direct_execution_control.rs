use super::{
    runtime_source, V3Config05ManifestPublished, V3Error01SourceRaised, V3RequestExecutionControl,
};

pub(super) fn resolve_v3_direct_request_execution_control(
    control: Option<V3RequestExecutionControl>,
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
) -> Result<V3RequestExecutionControl, V3Error01SourceRaised> {
    match control {
        Some(control) => Ok(control),
        None => V3RequestExecutionControl::from_manifest(manifest, server_id)
            .map_err(|error| runtime_source("V3ExecutionAttemptBudget", error)),
    }
}
