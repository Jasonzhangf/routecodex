use routecodex_v4_base_node::Scope;
use routecodex_v4_error::{
    ClassifyAuditWitness, ClientProjection, DecisionAction, ErrorCategory, ErrorCenter, ErrorChain,
    ErrorChainError, ErrorFact, ErrorStage, ExecutionDecision, RetryPolicy,
};

fn scope_a() -> Scope {
    Scope::new("req-1", "pipe-1", 5555, "sess-1", "conv-1")
}

fn scope_b() -> Scope {
    Scope::new("req-2", "pipe-2", 6666, "sess-2", "conv-2")
}

fn retry_policy() -> RetryPolicy {
    RetryPolicy {
        policy_id: "policy-1".to_string(),
        provider_scope: "cc".to_string(),
        matcher: "timeout".to_string(),
        action_class: "retry".to_string(),
        reason_code: "timeout".to_string(),
    }
}

fn execution_decision() -> ExecutionDecision {
    ExecutionDecision {
        decision_id: "decision-1".to_string(),
        action: DecisionAction::Retry,
        reason_code: "timeout".to_string(),
    }
}

fn classify_through_center(
    chain: &mut ErrorChain,
    center: &mut ErrorCenter,
) -> ClassifyAuditWitness {
    let captured = chain.capture().unwrap();
    let audit = center.classify(captured).unwrap();
    chain.classify(audit.clone()).unwrap();
    audit
}

fn full_chain() -> ErrorChain {
    let mut chain = ErrorChain::new(scope_a());
    let mut center = ErrorCenter::new(scope_a());
    chain
        .raise("5xx", Some("sha256:payload"), Some("provider:timeout"))
        .unwrap();
    classify_through_center(&mut chain, &mut center);
    chain.apply_policy(retry_policy()).unwrap();
    chain.decide(execution_decision()).unwrap();
    chain.project("upstream timeout").unwrap();
    chain
}

#[test]
fn error_chain_full_chain_success() {
    let mut chain = ErrorChain::new(scope_a());
    let mut center = ErrorCenter::new(scope_a());
    let raised = chain
        .raise("5xx", Some("sha256:payload"), Some("provider:timeout"))
        .unwrap();
    assert_eq!(raised.stage, ErrorStage::SourceRaised);
    let captured = chain.capture().unwrap();
    assert_eq!(captured.stage, ErrorStage::HostCaptured);
    let audit = center.classify(captured).unwrap();
    assert_eq!(
        chain.classify(audit).unwrap().stage,
        ErrorStage::RuntimeClassified
    );
    assert_eq!(
        chain.apply_policy(retry_policy()).unwrap().stage,
        ErrorStage::RouterPolicyApplied
    );
    assert_eq!(
        chain.decide(execution_decision()).unwrap().stage,
        ErrorStage::ExecutionDecision
    );
    let projection = chain.project("upstream timeout").unwrap();
    assert_eq!(projection.code, "5xx");
    assert_eq!(projection.message, "upstream timeout");
    assert!(chain.is_terminal());
    assert_eq!(chain.current_stage(), Some(ErrorStage::ClientProjected));
    assert_eq!(chain.records().count(), 6);
    let policy_detail = chain
        .records()
        .find(|r| r.to == ErrorStage::RouterPolicyApplied)
        .and_then(|r| r.detail.as_deref());
    assert_eq!(policy_detail, Some("policy-1"));
}

#[test]
fn error_chain_non_adjacent_transition_red() {
    let mut chain = ErrorChain::new(scope_a());
    chain.raise("5xx", None, None).unwrap();
    let mut center = ErrorCenter::new(scope_a());
    let mut source = ErrorChain::new(scope_a());
    source.raise("5xx", Some("sha256:p"), Some("ctx")).unwrap();
    let audit = center.classify(source.capture().unwrap()).unwrap();
    let err = chain.classify(audit).unwrap_err();
    assert!(matches!(err, ErrorChainError::NonAdjacentTransition));
    let err = chain.decide(execution_decision()).unwrap_err();
    assert!(matches!(err, ErrorChainError::NonAdjacentTransition));
    assert_eq!(chain.records().count(), 1);
}

#[test]
fn error_chain_operation_before_raise_red() {
    let mut chain = ErrorChain::new(scope_a());
    let mut source = ErrorChain::new(scope_a());
    source.raise("5xx", Some("sha256:p"), Some("ctx")).unwrap();
    let mut center = ErrorCenter::new(scope_a());
    let audit = center.classify(source.capture().unwrap()).unwrap();
    assert!(matches!(
        chain.capture().unwrap_err(),
        ErrorChainError::NoActiveFact
    ));
    assert!(matches!(
        chain.classify(audit).unwrap_err(),
        ErrorChainError::NoActiveFact
    ));
    assert!(matches!(
        chain.decide(execution_decision()).unwrap_err(),
        ErrorChainError::NoActiveFact
    ));
    assert!(matches!(
        chain.project("boom").unwrap_err(),
        ErrorChainError::NoActiveFact
    ));
    assert_eq!(chain.records().count(), 0);
}

#[test]
fn error_chain_double_raise_red() {
    let mut chain = ErrorChain::new(scope_a());
    chain.raise("5xx", None, None).unwrap();
    let err = chain.raise("4xx", None, None).unwrap_err();
    assert!(matches!(err, ErrorChainError::AlreadyActive));
    assert_eq!(chain.records().count(), 1);
}

#[test]
fn error_chain_after_terminal_red() {
    let mut chain = full_chain();
    assert!(chain.is_terminal());
    assert!(matches!(
        chain.raise("x", None, None).unwrap_err(),
        ErrorChainError::AlreadyTerminal
    ));
    assert!(matches!(
        chain.capture().unwrap_err(),
        ErrorChainError::AlreadyTerminal
    ));
    assert!(matches!(
        chain.decide(execution_decision()).unwrap_err(),
        ErrorChainError::AlreadyTerminal
    ));
    assert!(matches!(
        chain.project("boom").unwrap_err(),
        ErrorChainError::AlreadyTerminal
    ));
    assert_eq!(chain.records().count(), 6);
}

#[test]
fn error_chain_message_only_projection_red() {
    let mut chain = ErrorChain::new(scope_a());
    let mut center = ErrorCenter::new(scope_a());
    chain.raise("5xx", Some("sha256:p"), Some("ctx")).unwrap();
    assert!(matches!(
        chain.project("boom").unwrap_err(),
        ErrorChainError::MessageOnlyProjectionForbidden
    ));
    let captured = chain.capture().unwrap();
    assert!(matches!(
        chain.project("boom").unwrap_err(),
        ErrorChainError::MessageOnlyProjectionForbidden
    ));
    let audit = center.classify(captured).unwrap();
    chain.classify(audit).unwrap();
    chain.apply_policy(retry_policy()).unwrap();
    assert!(matches!(
        chain.project("boom").unwrap_err(),
        ErrorChainError::MessageOnlyProjectionForbidden
    ));
    assert_eq!(chain.records().count(), 4);
}

#[test]
fn retry_policy_only_at_runtime_classified() {
    let mut chain = ErrorChain::new(scope_a());
    let mut center = ErrorCenter::new(scope_a());
    chain.raise("5xx", Some("sha256:p"), Some("ctx")).unwrap();
    assert!(matches!(
        chain.apply_policy(retry_policy()).unwrap_err(),
        ErrorChainError::NonAdjacentTransition
    ));
    let captured = chain.capture().unwrap();
    assert!(matches!(
        chain.apply_policy(retry_policy()).unwrap_err(),
        ErrorChainError::NonAdjacentTransition
    ));
    let audit = center.classify(captured).unwrap();
    chain.classify(audit).unwrap();
    assert!(chain.apply_policy(retry_policy()).is_ok());
}

#[test]
fn execution_decision_duplicate_red() {
    let mut chain = ErrorChain::new(scope_a());
    let mut center = ErrorCenter::new(scope_a());
    chain.raise("5xx", Some("sha256:p"), Some("ctx")).unwrap();
    classify_through_center(&mut chain, &mut center);
    chain.apply_policy(retry_policy()).unwrap();
    chain.decide(execution_decision()).unwrap();
    assert!(matches!(
        chain.decide(execution_decision()).unwrap_err(),
        ErrorChainError::NonAdjacentTransition
    ));
}

#[test]
fn error_center_scope_isolation_red() {
    let mut chain_a = ErrorChain::new(scope_a());
    chain_a.raise("5xx", Some("sha256:p"), Some("ctx")).unwrap();
    let fact = chain_a.capture().unwrap();
    let mut center_b = ErrorCenter::new(scope_b());
    let err = center_b.classify(fact.clone()).unwrap_err();
    assert!(matches!(err, ErrorChainError::ScopeMismatch));
    assert_eq!(center_b.audit_count(), 0);
    let mut center_a = ErrorCenter::new(scope_a());
    assert!(center_a.classify(fact).is_ok());
    assert_eq!(center_a.audit_count(), 1);
}

#[test]
fn error_center_classify_audit_only() {
    let mut chain = ErrorChain::new(scope_a());
    chain
        .raise("timeout", Some("sha256:p"), Some("ctx"))
        .unwrap();
    let fact = chain.capture().unwrap();
    let mut center = ErrorCenter::new(scope_a());
    let record = center.classify(fact).unwrap();
    assert_eq!(record.record().category, ErrorCategory::Retryable);
    assert_eq!(record.record().code, "timeout");
    assert_eq!(record.record().payload_hash.as_deref(), Some("sha256:p"));
    assert_eq!(record.record().typed_context.as_deref(), Some("ctx"));
    assert_eq!(record.record().scope, scope_a());
    assert_eq!(center.audit_count(), 1);
    assert_eq!(center.records().count(), 1);
}

#[test]
fn error_center_duplicate_classify_red() {
    let mut chain = ErrorChain::new(scope_a());
    chain
        .raise("timeout", Some("sha256:p"), Some("ctx"))
        .unwrap();
    let fact = chain.capture().unwrap();
    let mut center = ErrorCenter::new(scope_a());
    center.classify(fact.clone()).unwrap();
    let err = center.classify(fact).unwrap_err();
    assert!(matches!(err, ErrorChainError::AlreadyClassified));
    assert_eq!(center.audit_count(), 1);
}

#[test]
fn error_center_payload_reread_forbidden_red() {
    let err = ErrorFact::try_reconstruct_from_payload("sha256:p", scope_a()).unwrap_err();
    assert!(matches!(
        err,
        ErrorChainError::ControlNotReconstructibleFromPayload
    ));
}

#[test]
fn error_chain_audit_immutable_ordered() {
    let mut chain = ErrorChain::new(scope_a());
    let mut center = ErrorCenter::new(scope_a());
    chain.raise("5xx", Some("sha256:p"), Some("ctx")).unwrap();
    classify_through_center(&mut chain, &mut center);
    let before = chain.records().count();
    let mut last_sequence = 0u64;
    let mut ids = std::collections::HashSet::new();
    for record in chain.records() {
        assert!(record.record_sequence > last_sequence);
        last_sequence = record.record_sequence;
        assert!(record.timestamp_ms > 0);
        assert_eq!(record.scope, scope_a());
        assert!(ids.insert(record.record_id.clone()));
    }
    assert_eq!(chain.records().count(), before);
}

#[test]
fn error_stage_enum_fixed_order() {
    assert_eq!(ErrorStage::SourceRaised as u8, 1);
    assert_eq!(ErrorStage::HostCaptured as u8, 2);
    assert_eq!(ErrorStage::RuntimeClassified as u8, 3);
    assert_eq!(ErrorStage::RouterPolicyApplied as u8, 4);
    assert_eq!(ErrorStage::ExecutionDecision as u8, 5);
    assert_eq!(ErrorStage::ClientProjected as u8, 6);
    assert_eq!(
        ErrorStage::SourceRaised.next(),
        Some(ErrorStage::HostCaptured)
    );
    assert_eq!(ErrorStage::ClientProjected.next(), None);
}

#[test]
fn client_projection_contains_only_code_and_message() {
    let projection = ClientProjection {
        code: "5xx".to_string(),
        message: "boom".to_string(),
    };
    assert_eq!(projection.code, "5xx");
    assert_eq!(projection.message, "boom");
    let mut chain = ErrorChain::new(scope_a());
    let mut center = ErrorCenter::new(scope_a());
    chain.raise("5xx", Some("sha256:p"), Some("ctx")).unwrap();
    classify_through_center(&mut chain, &mut center);
    chain.apply_policy(retry_policy()).unwrap();
    chain.decide(execution_decision()).unwrap();
    let terminal = chain.project("boom").unwrap();
    assert_eq!(terminal.code, "5xx");
    assert_eq!(terminal.message, "boom");
}

#[test]
fn retry_policy_typed_passive_contract() {
    let policy = retry_policy();
    assert_eq!(policy.provider_scope, "cc");
    assert_eq!(policy.matcher, "timeout");
    assert_eq!(policy.action_class, "retry");
    let mut chain = ErrorChain::new(scope_a());
    let mut center = ErrorCenter::new(scope_a());
    chain.raise("5xx", Some("sha256:p"), Some("ctx")).unwrap();
    classify_through_center(&mut chain, &mut center);
    let fact = chain.apply_policy(policy).unwrap();
    assert_eq!(fact.stage, ErrorStage::RouterPolicyApplied);
    assert_eq!(fact.code, "5xx");
    assert_eq!(fact.payload_hash.as_deref(), Some("sha256:p"));
}

#[test]
fn error_fact_typed_fields_only() {
    let mut chain = ErrorChain::new(scope_a());
    let fact = chain.raise("4xx", Some("sha256:p"), Some("ctx")).unwrap();
    assert_eq!(fact.code, "4xx");
    assert_eq!(fact.payload_hash.as_deref(), Some("sha256:p"));
    assert_eq!(fact.typed_context.as_deref(), Some("ctx"));
    assert_eq!(fact.scope, scope_a());
    assert!(fact.sequence >= 1);
    assert!(fact.timestamp_ms > 0);
}

#[test]
fn error_blackbox_public_api_regression() {
    let mut chain = ErrorChain::new(scope_a());
    assert_eq!(chain.scope(), &scope_a());
    assert_eq!(chain.current_stage(), None);
    let fact = chain
        .raise("timeout", Some("sha256:p"), Some("ctx"))
        .unwrap();
    assert_eq!(fact.stage, ErrorStage::SourceRaised);
    let mut center = ErrorCenter::new(scope_a());
    let record = center.classify(chain.capture().unwrap()).unwrap();
    chain.classify(record.clone()).unwrap();
    assert_eq!(record.record().category, ErrorCategory::Retryable);
    assert_eq!(center.audit_count(), 1);
    assert_eq!(center.records().count(), 1);
    let mut chain2 = ErrorChain::new(scope_a());
    let mut center2 = ErrorCenter::new(scope_a());
    chain2.raise("5xx", Some("sha256:p"), Some("ctx")).unwrap();
    classify_through_center(&mut chain2, &mut center2);
    chain2.apply_policy(retry_policy()).unwrap();
    chain2.decide(execution_decision()).unwrap();
    let projection = chain2.project("boom").unwrap();
    assert_eq!(projection.code, "5xx");
    assert!(chain2.is_terminal());
}

#[test]
fn error_center_missing_payload_hash_red() {
    let mut chain = ErrorChain::new(scope_a());
    chain.raise("timeout", None, Some("ctx")).unwrap();
    let fact = chain.capture().unwrap();
    let mut center = ErrorCenter::new(scope_a());
    assert!(matches!(
        center.classify(fact).unwrap_err(),
        ErrorChainError::MissingPayloadHash
    ));
    assert_eq!(center.audit_count(), 0);
}

#[test]
fn error_center_missing_typed_context_red() {
    let mut chain = ErrorChain::new(scope_a());
    chain.raise("timeout", Some("sha256:p"), None).unwrap();
    let fact = chain.capture().unwrap();
    let mut center = ErrorCenter::new(scope_a());
    assert!(matches!(
        center.classify(fact).unwrap_err(),
        ErrorChainError::MissingTypedContext
    ));
    assert_eq!(center.audit_count(), 0);
}

#[test]
fn error_center_empty_intake_evidence_red() {
    let mut hash_chain = ErrorChain::new(scope_a());
    hash_chain.raise("timeout", Some(""), Some("ctx")).unwrap();
    let mut center = ErrorCenter::new(scope_a());
    assert!(matches!(
        center.classify(hash_chain.capture().unwrap()).unwrap_err(),
        ErrorChainError::MissingPayloadHash
    ));

    let mut context_chain = ErrorChain::new(scope_a());
    context_chain
        .raise("timeout", Some("sha256:p"), Some(""))
        .unwrap();
    assert!(matches!(
        center
            .classify(context_chain.capture().unwrap())
            .unwrap_err(),
        ErrorChainError::MissingTypedContext
    ));
    assert_eq!(center.audit_count(), 0);
}

#[test]
fn error_chain_mismatched_audit_witness_red() {
    let mut chain = ErrorChain::new(scope_a());
    chain
        .raise("timeout", Some("sha256:p"), Some("ctx"))
        .unwrap();
    chain.capture().unwrap();

    let mut other_chain = ErrorChain::new(scope_a());
    other_chain
        .raise("5xx", Some("sha256:other"), Some("other"))
        .unwrap();
    let other_fact = other_chain.capture().unwrap();
    let mut center = ErrorCenter::new(scope_a());
    let audit = center.classify(other_fact).unwrap();

    assert!(matches!(
        chain.classify(audit).unwrap_err(),
        ErrorChainError::AuditWitnessMismatch
    ));
    assert_eq!(chain.current_stage(), Some(ErrorStage::HostCaptured));
}

#[test]
fn error_chain_audit_witness_single_use_red() {
    let mut chain = ErrorChain::new(scope_a());
    chain
        .raise("timeout", Some("sha256:p"), Some("ctx"))
        .unwrap();
    let captured = chain.capture().unwrap();
    let mut center = ErrorCenter::new(scope_a());
    let audit = center.classify(captured).unwrap();
    let replay_audit = audit.clone();
    chain.classify(audit).unwrap();

    let mut replay = ErrorChain::new(scope_a());
    let replay_fact = replay
        .raise("timeout", Some("sha256:p"), Some("ctx"))
        .unwrap();
    replay.capture().unwrap();
    assert_eq!(replay_fact.fact_id, replay_audit.record().fact_id);
    assert!(matches!(
        replay.classify(replay_audit).unwrap_err(),
        ErrorChainError::AuditWitnessAlreadyConsumed
    ));
}
