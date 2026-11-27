use super::{runtime_source, V3RuntimeStreamObservation, V3RuntimeTimingState};

pub(super) fn finish_v3_direct_runtime_timing(
    committed_client_sse: bool,
    live_client_sse: bool,
    stream_observation: Option<&V3RuntimeStreamObservation>,
    runtime_timing: &V3RuntimeTimingState,
) -> crate::shared::V3DirectSourceResult<Option<crate::V3RuntimeTimingSummary>> {
    let timing = if live_client_sse {
        None
    } else {
        Some(
            runtime_timing
                .finish_runtime()
                .map_err(|error| runtime_source("V3RuntimeTimingTerminal", error))?,
        )
    };
    if committed_client_sse {
        let observation = stream_observation.ok_or_else(|| {
            runtime_source(
                "V3RuntimeTimingObservation",
                "successful Direct SSE completed without typed observation",
            )
        })?;
        if let Some(timing) = timing {
            observation
                .record_timing(timing)
                .map_err(|error| runtime_source("V3RuntimeTimingObservation", error))?;
        }
    }
    Ok(timing)
}
