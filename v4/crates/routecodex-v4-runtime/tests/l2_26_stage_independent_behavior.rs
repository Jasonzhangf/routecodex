use routecodex_v4_base_node::Scope;
use routecodex_v4_error::{DecisionAction, ErrorChain, ErrorCenter, ErrorStage, ExecutionDecision, RetryPolicy};
use routecodex_v4_runtime::{
    build_responses_wire_request, parse_responses_provider_payload, select_relay_operator,
    ContinuationFacts, RelayOperator,
};
use serde_json::json;

fn scope() -> Scope { Scope::new("req-26", "v4-pipeline", 7777, "session", "conversation") }
fn policy() -> RetryPolicy { RetryPolicy { policy_id: "p".into(), provider_scope: "provider".into(), matcher: "timeout".into(), action_class: "retry".into(), reason_code: "timeout".into() } }
fn decision() -> ExecutionDecision { ExecutionDecision { decision_id: "d".into(), action: DecisionAction::Retry, reason_code: "timeout".into() } }

#[test] fn request_inbound_normalize_behavior() { assert!(build_responses_wire_request(&json!({"input": []}), "m", false).is_ok()); assert!(build_responses_wire_request(&json!([]), "m", false).is_err()); }
#[test] fn request_continuation_classify_behavior() { assert_eq!(select_relay_operator(&ContinuationFacts::new("responses", "responses", "direct", "direct")).unwrap(), RelayOperator::Direct); assert!(select_relay_operator(&ContinuationFacts::new("responses", "responses", "relay", "relay")).is_err()); }
#[test] fn request_chat_process_behavior() { let value = json!({"input": [{"role":"user","content":"hi"}]}); assert!(value["input"].is_array()); assert!(!value["messages"].is_array()); }
#[test] fn request_execution_plan_behavior() { let facts = ContinuationFacts::new("chat", "chat", "relay", "relay"); assert_eq!(select_relay_operator(&facts).unwrap(), RelayOperator::Relay); assert!(select_relay_operator(&ContinuationFacts::new("unknown", "unknown", "relay", "relay")).is_err()); }
#[test] fn request_route_facts_behavior() { assert!(select_relay_operator(&ContinuationFacts::new("messages", "messages", "relay", "relay")).is_ok()); assert!(select_relay_operator(&ContinuationFacts::new("messages", "messages", "direct", "direct")).is_err()); }
#[test] fn request_target_resolve_behavior() { let direct = ContinuationFacts::new("responses", "responses", "direct", "direct"); assert_eq!(select_relay_operator(&direct).unwrap(), RelayOperator::Direct); assert!(select_relay_operator(&ContinuationFacts::new("responses", "responses", "relay", "direct")).is_err()); }
#[test] fn request_provider_semantic_behavior() { let request = build_responses_wire_request(&json!({"input": []}), "provider-model", true).unwrap(); assert_eq!(request.model, "provider-model"); assert!(request.body.windows(5).any(|w| w == b"model")); }
#[test] fn request_wire_build_behavior() { let request = build_responses_wire_request(&json!({"input": []}), "m", true).unwrap(); assert!(request.body.windows(6).any(|w| w == b"stream")); assert!(build_responses_wire_request(&json!({}), "", true).is_err()); }
#[test] fn request_wire_build_rejects_control_plane_fields() {
    let result = build_responses_wire_request(&json!({"input": [], "metadata_center": {"scope": "s"}}), "m", false);
    assert!(result.is_err(), "provider wire must reject internal control fields");
}
#[test] fn request_transport_behavior() { assert!(build_responses_wire_request(&json!({"input": []}), "m", false).is_ok()); assert!(build_responses_wire_request(&json!(null), "m", false).is_err()); }
const RESPONSE_OK: &[u8] = br#"{"id":"r","status":"completed","output":[]}"#;
#[test] fn response_provider_inbound_behavior() { assert!(parse_responses_provider_payload(200, "application/json", RESPONSE_OK, false).is_ok()); assert!(parse_responses_provider_payload(200, "application/json", b"bad", false).is_err()); }
#[test] fn response_normalize_behavior() { assert!(parse_responses_provider_payload(200, "application/json", RESPONSE_OK, false).is_ok()); assert!(parse_responses_provider_payload(500, "application/json", RESPONSE_OK, false).is_err()); }
#[test] fn response_response_process_behavior() { let parsed = parse_responses_provider_payload(200, "application/json", RESPONSE_OK, false).unwrap(); assert!(matches!(parsed, routecodex_v4_runtime::ResponsesProviderPayload::Json(_))); assert!(parse_responses_provider_payload(200, "application/json", b"", false).is_err()); }
#[test] fn response_continuation_commit_behavior() { assert!(parse_responses_provider_payload(200, "application/json", RESPONSE_OK, false).is_ok()); assert!(parse_responses_provider_payload(200, "application/json", b"not-json", false).is_err()); }
#[test] fn response_client_projection_behavior() { assert!(parse_responses_provider_payload(200, "application/json", RESPONSE_OK, false).is_ok()); assert!(parse_responses_provider_payload(200, "text/plain", b"bad", false).is_err()); }
#[test] fn response_frame_behavior() { assert!(parse_responses_provider_payload(200, "application/json", RESPONSE_OK, false).is_ok()); assert!(parse_responses_provider_payload(200, "application/json", b"bad", false).is_err()); }

#[test] fn error_source_behavior() { let mut chain = ErrorChain::new(scope()); assert_eq!(chain.raise("timeout", None, None).unwrap().stage, ErrorStage::SourceRaised); assert!(chain.raise("again", None, None).is_err()); }
#[test] fn error_capture_behavior() { let mut chain = ErrorChain::new(scope()); assert!(chain.capture().is_err()); chain.raise("timeout", None, None).unwrap(); assert_eq!(chain.capture().unwrap().stage, ErrorStage::HostCaptured); }
#[test] fn error_classify_behavior() { let mut chain = ErrorChain::new(scope()); let mut center = ErrorCenter::new(scope()); chain.raise("timeout", Some("sha256:p"), Some("typed-context")).unwrap(); let fact = chain.capture().unwrap(); let _ = center.classify(fact).unwrap(); assert_eq!(center.audit_count(), 1); }
#[test] fn error_policy_behavior() { let mut chain = ErrorChain::new(scope()); chain.raise("timeout", Some("sha256:p"), Some("typed-context")).unwrap(); assert!(chain.apply_policy(policy()).is_err()); let mut center = ErrorCenter::new(scope()); let fact = chain.capture().unwrap(); chain.classify(center.classify(fact).unwrap()).unwrap(); assert_eq!(chain.apply_policy(policy()).unwrap().stage, ErrorStage::RouterPolicyApplied); }
#[test] fn error_decision_behavior() { let mut chain = ErrorChain::new(scope()); chain.raise("timeout", Some("sha256:p"), Some("typed-context")).unwrap(); assert!(chain.decide(decision()).is_err()); }
#[test] fn error_projection_behavior() { let mut chain = ErrorChain::new(scope()); chain.raise("timeout", Some("sha256:p"), Some("typed-context")).unwrap(); let mut center = ErrorCenter::new(scope()); let fact = chain.capture().unwrap(); chain.classify(center.classify(fact).unwrap()).unwrap(); chain.apply_policy(policy()).unwrap(); chain.decide(decision()).unwrap(); assert_eq!(chain.project("timeout").unwrap().message, "timeout"); }
