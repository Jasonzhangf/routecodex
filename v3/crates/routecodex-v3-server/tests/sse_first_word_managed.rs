//! Real Responses listener -> OpenAI Chat TCP peer timeout contract.
//! HTTP headers, comments and an empty role are not a semantic first word.
//! After that word, neither the old provider total, residence nor idle interval
//! may cut the attempt short. Business output remains buffered until terminal.

#[path = "support/sse_first_word_managed.rs"]
mod fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
use fixture::{run_case, Case};

#[tokio::test]
async fn content_first_word_survives_old_provider_total_and_residence() {
    run_case(Case::Content, true).await;
}
#[tokio::test]
async fn reasoning_first_word_survives_old_provider_total_and_residence() {
    run_case(Case::Reasoning, true).await;
}
#[tokio::test]
async fn tool_arguments_first_word_preserves_identity_past_old_deadlines() {
    run_case(Case::ToolArguments, true).await;
}
#[tokio::test]
async fn first_word_then_pause_has_no_idle_or_lifetime_cutoff() {
    run_case(Case::Pause, true).await;
}
#[tokio::test]
async fn headers_comments_and_empty_role_do_not_satisfy_first_word() {
    run_case(Case::NoWord, false).await;
}
#[tokio::test]
async fn semantic_progress_then_real_eof_is_not_partial_success() {
    run_case(Case::Eof, false).await;
}
#[tokio::test]
async fn semantic_progress_then_truncated_http_body_is_not_partial_success() {
    run_case(Case::BodyError, false).await;
}
