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
        // A provider failure after commit is a real terminal for the affected
        // client session: closing at EOF left that session without any protocol
        // terminal, so it never reached a terminal state again while a new
        // session still worked. Only a genuine client disconnect or an
        // exhausted target pool may close the stream.
        _ => V3SsePostCommitDisposition::ProjectInternalTerminal,
    }
}
