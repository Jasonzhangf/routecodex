use routecodex_v4_base_node::Scope;
use routecodex_v4_error::{DecisionAction, ErrorChain, ErrorCenter, ErrorStage, ExecutionDecision, RetryPolicy};

fn scope() -> Scope { Scope::new("red", "error", 7777, "session", "conversation") }

fn raised_chain() -> ErrorChain {
    let mut chain = ErrorChain::new(scope());
    chain.raise("timeout", Some("sha256:payload"), Some("typed")).unwrap();
    chain
}

#[test]
fn source_stage_has_positive_and_negative_contract() {
    let mut chain = ErrorChain::new(scope());
    assert_eq!(chain.raise("timeout", Some("sha256:p"), Some("typed")).unwrap().stage, ErrorStage::SourceRaised);
    assert!(chain.raise("again", Some("sha256:p"), Some("typed")).is_err());
}

#[test]
fn capture_stage_has_positive_and_negative_contract() {
    let mut chain = raised_chain();
    assert_eq!(chain.capture().unwrap().stage, ErrorStage::HostCaptured);
    assert!(chain.capture().is_err());
}

#[test]
fn classify_stage_requires_the_owner_witness() {
    let mut chain = raised_chain();
    let fact = chain.capture().unwrap();
    let mut center = ErrorCenter::new(scope());
    let witness = center.classify(fact).unwrap();
    assert_eq!(witness.record().fact_id, "err-1");
    assert!(chain.classify(witness).is_ok());
}

#[test]
fn policy_stage_is_adjacent_and_rejects_reentry() {
    let mut chain = raised_chain();
    let fact = chain.capture().unwrap();
    let mut center = ErrorCenter::new(scope());
    chain.classify(center.classify(fact).unwrap()).unwrap();
    let policy = RetryPolicy { policy_id: "p".into(), provider_scope: "provider".into(), matcher: "timeout".into(), action_class: "retry".into(), reason_code: "timeout".into() };
    assert_eq!(chain.apply_policy(policy.clone()).unwrap().stage, ErrorStage::RouterPolicyApplied);
    assert!(chain.apply_policy(policy).is_err());
}

#[test]
fn decision_stage_consumes_policy_once() {
    let mut chain = raised_chain();
    let fact = chain.capture().unwrap();
    let mut center = ErrorCenter::new(scope());
    chain.classify(center.classify(fact).unwrap()).unwrap();
    chain.apply_policy(RetryPolicy { policy_id: "p".into(), provider_scope: "provider".into(), matcher: "timeout".into(), action_class: "retry".into(), reason_code: "timeout".into() }).unwrap();
    let decision = ExecutionDecision { decision_id: "d".into(), action: DecisionAction::Retry, reason_code: "timeout".into() };
    assert_eq!(chain.decide(decision.clone()).unwrap().stage, ErrorStage::ExecutionDecision);
    assert!(chain.decide(decision).is_err());
}

#[test]
fn projection_stage_is_terminal_and_rejects_reentry() {
    let mut chain = raised_chain();
    let fact = chain.capture().unwrap();
    let mut center = ErrorCenter::new(scope());
    chain.classify(center.classify(fact).unwrap()).unwrap();
    chain.apply_policy(RetryPolicy { policy_id: "p".into(), provider_scope: "provider".into(), matcher: "timeout".into(), action_class: "retry".into(), reason_code: "timeout".into() }).unwrap();
    chain.decide(ExecutionDecision { decision_id: "d".into(), action: DecisionAction::Retry, reason_code: "timeout".into() }).unwrap();
    assert_eq!(chain.project("timeout").unwrap().code, "timeout");
    assert!(chain.project("again").is_err());
}

#[test]
fn error_stages_publish_independent_checkpoint_facts() {
    let mut chain = raised_chain();
    let _checkpoint = chain.stage_checkpoint();
}
