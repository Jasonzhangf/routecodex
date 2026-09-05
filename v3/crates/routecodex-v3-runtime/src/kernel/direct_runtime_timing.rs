use super::{
    runtime_source, V3Error01SourceRaised, V3RuntimeStreamObservation, V3RuntimeTimingState,
};

pub(super) fn finish_v3_direct_runtime_timing(
    committed_client_sse: bool,
    live_client_sse: bool,
    stream_observation: Option<&V3RuntimeStreamObservation>,
    runtime_timing: &V3RuntimeTimingState,
) -> Result<Option<crate::V3RuntimeTimingSummary>, V3Error01SourceRaised> {
    let timing = if committed_client_sse {
        match stream_observation {
            Some(observation) => {
                observation
                    .snapshot()
                    .map_err(|error| runtime_source("V3RuntimeTimingObservation", error))?
                    .timing
            }
            None => None,
        }
    } else if live_client_sse {
        None
    } else {
        Some(
            runtime_timing
                .finish_runtime()
                .map_err(|error| runtime_source("V3RuntimeTimingTerminal", error))?,
        )
    };
    if committed_client_sse && timing.is_none() {
        return Err(runtime_source(
            "V3RuntimeTimingTerminal",
            "successful Direct SSE completed without typed timing",
        ));
    }
    Ok(timing)
}
