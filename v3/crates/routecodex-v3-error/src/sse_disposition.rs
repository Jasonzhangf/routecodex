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

/// Client-visible content of a post-commit SSE terminal, framed by the server's
/// SSE transport boundary. The server never classifies or rebuilds Error state:
/// the error owner returns the real public code/status/message, or `None` when
/// the source must close the stream at EOF (client disconnect / pool exhausted).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3SsePostCommitTerminal {
    pub status: u16,
    pub code: String,
    pub message: String,
}

pub fn v3_sse_post_commit_terminal(
    source: V3Error01SourceRaised,
) -> Option<V3SsePostCommitTerminal> {
    if v3_sse_post_commit_disposition(&source) == V3SsePostCommitDisposition::CloseEof {
        return None;
    }
    let default_status = match source.source_kind {
        V3ErrorSourceKind::ProviderFailure => 502,
        _ => 599,
    };
    let projected = crate::project_v3_post_commit_sse_source(source, default_status);
    let (code, message) = projected_public_code_message(&projected.body);
    Some(V3SsePostCommitTerminal {
        status: projected.status,
        code,
        message,
    })
}

fn projected_public_code_message(body: &serde_json::Value) -> (String, String) {
    let error = body.get("error").unwrap_or(body);
    let code = error
        .get("code")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("runtime_error")
        .to_string();
    let message = error
        .get("message")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("V3 Responses runtime error")
        .to_string();
    (code, message)
}
