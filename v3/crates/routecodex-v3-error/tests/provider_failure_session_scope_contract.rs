use routecodex_v3_error::{V3Error05RecoveryAdmissionWitness, V3ProviderFailureSessionScope};

#[test]
fn failure_session_scope_requires_all_four_isolation_dimensions_before_provider_identity() {
    let scope = V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a")
        .expect("complete request data-plane scope");
    assert_eq!(scope.server_id(), "server-a");
    assert_eq!(scope.routing_group(), "group-a");
    assert_eq!(scope.session_id(), "session-a");

    for invalid in [
        V3ProviderFailureSessionScope::new("", "group-a", "session-a"),
        V3ProviderFailureSessionScope::new("server-a", "", "session-a"),
        V3ProviderFailureSessionScope::new("server-a", "group-a", ""),
    ] {
        assert!(invalid.is_err(), "missing scope dimension must fail-fast");
    }
}

#[test]
fn error05_witness_preserves_real_session_and_cannot_synthesize_it_from_group() {
    let scope = V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a")
        .expect("complete request data-plane scope");
    let witness = V3Error05RecoveryAdmissionWitness::new(
        scope.clone(),
        "provider-a:key-a:model-a",
        "provider_http_429",
        7,
    )
    .expect("typed Error05 witness");

    assert_eq!(witness.failure_session_scope(), &scope);
    assert_eq!(witness.server_id(), "server-a");
    assert_eq!(witness.routing_group(), "group-a");
    assert_eq!(witness.session_id(), "session-a");
    assert_ne!(witness.session_id(), witness.routing_group());
    assert_eq!(
        witness.provider_runtime_identity(),
        "provider-a:key-a:model-a"
    );
    assert_eq!(witness.normalized_error_family(), "provider_http_429");
    assert_eq!(witness.generation(), 7);
}
