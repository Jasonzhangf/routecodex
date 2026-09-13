use crate::{V3Error01SourceRaised, V3ErrorSourceKind};

/// Typed post-commit decision consumed by the server's SSE transport boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3SsePostCommitDisposition {
    CloseEof,
    ProjectInternalTerminal,
}

pub fn v3_sse_post_commit_disposition(
    source: &V3Error01SourceRaised,
) -> V3SsePostCommitDisposition {
    match source.source_kind {
        V3ErrorSourceKind::ClientDisconnect | V3ErrorSourceKind::TargetPoolExhausted => {
            V3SsePostCommitDisposition::CloseEof
        }
        _ => V3SsePostCommitDisposition::ProjectInternalTerminal,
    }
}
