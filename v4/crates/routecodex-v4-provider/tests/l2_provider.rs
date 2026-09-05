//! routecodex-v4-provider L2 regression: session-scoped availability.

use routecodex_v4_provider::{
    load_profile,
    validate_auth_alias, verify_profile_auth, AvailabilityRecord, AvailabilityState,
    ProviderBoundRawEvidenceBindingError, ProviderBoundRawEvidenceOwnerContract,
    V4Availability01SessionScoped, PROVIDER_BOUND_RAW_EVIDENCE_OWNER,
};
use std::fs;

#[test]
fn session_scoped_availability_positive_and_red() {
    let mut registry = V4Availability01SessionScoped::new();
    registry
        .record(
            "srv-1",
            "rg-1",
            "session-a",
            "provider-1",
            AvailabilityState::Healthy,
            0,
        )
        .expect("record must succeed");
    let record: &AvailabilityRecord = registry
        .get("srv-1", "rg-1", "session-a", "provider-1")
        .expect("session record must exist");
    assert_eq!(record.state, AvailabilityState::Healthy);
    registry
        .record(
            "srv-1",
            "rg-1",
            "session-a",
            "provider-1",
            AvailabilityState::Unavailable,
            3,
        )
        .expect("same-session update must replace the record");
    assert_eq!(
        registry
            .get("srv-1", "rg-1", "session-a", "provider-1")
            .expect("updated record")
            .consecutive_errors,
        3
    );
    // Different session must never observe the other session's availability.
    assert!(registry
        .get("srv-1", "rg-1", "session-b", "provider-1")
        .is_none());
    assert_eq!(registry.records().count(), 1);
    registry
        .mark_failure("srv-1", "rg-1", "session-a", "provider-1", true, 4)
        .expect("cooldown failure records");
    assert!(!registry.is_eligible("srv-1", "rg-1", "session-a", "provider-1"));
    assert!(registry.is_eligible("srv-1", "rg-1", "session-b", "provider-1"));
    registry
        .mark_success("srv-1", "rg-1", "session-a", "provider-1")
        .expect("success clears cooldown");
    assert!(registry.is_eligible("srv-1", "rg-1", "session-a", "provider-1"));
}

#[test]
fn provider_bound_raw_evidence_owner_binding_positive_and_red() {
    let bound = ProviderBoundRawEvidenceOwnerContract::bind(
        PROVIDER_BOUND_RAW_EVIDENCE_OWNER,
        "req-live-b-1",
        br#"{"model":"wire"}"#,
        br#"{"error":{"code":"upstream"}}"#,
    )
    .expect("canonical provider owner must bind both raw artifacts");
    assert_eq!(bound.request_id, "req-live-b-1");
    assert_eq!(bound.provider_request, br#"{"model":"wire"}"#);
    assert_eq!(bound.provider_response, br#"{"error":{"code":"upstream"}}"#);

    assert_eq!(
        ProviderBoundRawEvidenceOwnerContract::bind(
            "routecodex-v4-server::V4ErrorEvidenceFlushOnTerminalFailure",
            "req-live-b-1",
            b"request",
            b"response",
        )
        .expect_err("diagnostic server owner cannot claim provider-bound evidence"),
        ProviderBoundRawEvidenceBindingError::InvalidOwner {
            owner: "routecodex-v4-server::V4ErrorEvidenceFlushOnTerminalFailure".to_string(),
        }
    );
}

#[test]
fn provider_bound_raw_evidence_binding_fails_closed_on_missing_owner_or_artifact() {
    assert_eq!(
        ProviderBoundRawEvidenceOwnerContract::bind("", "req-1", b"request", b"response")
            .expect_err("missing owner must fail closed"),
        ProviderBoundRawEvidenceBindingError::MissingOwner
    );
    assert_eq!(
        ProviderBoundRawEvidenceOwnerContract::bind(
            PROVIDER_BOUND_RAW_EVIDENCE_OWNER,
            "req-1",
            b"",
            b"response",
        )
        .expect_err("missing provider request must fail closed"),
        ProviderBoundRawEvidenceBindingError::MissingProviderRequest
    );
    assert_eq!(
        ProviderBoundRawEvidenceOwnerContract::bind(
            PROVIDER_BOUND_RAW_EVIDENCE_OWNER,
            "req-1",
            b"request",
            b"",
        )
        .expect_err("missing provider response must fail closed"),
        ProviderBoundRawEvidenceBindingError::MissingProviderResponse
    );
}

#[test]
fn secret_file_requires_and_resolves_exact_secret_key() {
    let root = std::env::temp_dir().join(format!("rccv4-provider-{}", std::process::id()));
    fs::create_dir_all(&root).expect("temp root");
    let secrets = root.join("secrets.toml");
    fs::write(&secrets, "[provider]\nkey1 = \"real-secret\"\n").expect("secret file");
    let profile_path = root.join("provider.toml");
    let profile = format!(
        "providerId = \"real\"\n[provider]\nbaseURL = \"https://example.invalid/v1\"\ndefaultModel = \"wire\"\ntype = \"responses\"\n[provider.models.wire]\nwireName = \"wire\"\n[provider.auth]\nentries = [{{ alias = \"key1\", secretFile = \"{}\", secretKey = \"provider.key1\" }}]\n",
        secrets.display()
    );
    fs::write(&profile_path, profile).expect("profile");
    let loaded = load_profile(profile_path.to_str().expect("utf8 path")).expect("load profile");
    verify_profile_auth(&loaded).expect("exact key resolves");
}

#[test]
fn secret_file_without_secret_key_fails_fast() {
    let root = std::env::temp_dir().join(format!("rccv4-provider-invalid-{}", std::process::id()));
    fs::create_dir_all(&root).expect("temp root");
    let profile_path = root.join("provider.toml");
    fs::write(
        &profile_path,
        "providerId = \"real\"\n[provider]\nbaseURL = \"https://example.invalid/v1\"\ndefaultModel = \"wire\"\ntype = \"responses\"\n[provider.models.wire]\nwireName = \"wire\"\n[provider.auth]\nentries = [{ alias = \"key1\", secretFile = \"/tmp/secrets.toml\" }]\n",
    )
    .expect("profile");
    let error = load_profile(profile_path.to_str().expect("utf8 path")).expect_err("must fail");
    assert_eq!(error.code, "provider_auth_handle_invalid");
}

#[test]
fn responses_continuation_owner_is_compiled_and_invalid_values_fail_fast() {
    let root = std::env::temp_dir().join(format!(
        "rccv4-provider-continuation-{}",
        std::process::id()
    ));
    fs::create_dir_all(&root).expect("temp root");
    let relay_path = root.join("relay.toml");
    fs::write(
        &relay_path,
        "providerId = \"relay\"\n[provider]\nbaseURL = \"https://example.invalid/v1\"\ndefaultModel = \"wire\"\ntype = \"responses\"\nresponsesContinuation = \"relay\"\n[provider.models.wire]\nwireName = \"wire\"\n[provider.auth]\nenv = \"RCCV4_TEST_KEY\"\n",
    )
    .expect("relay profile");
    let profile = load_profile(relay_path.to_str().expect("utf8 path"))
        .expect("retired relay hint is ignored");
    assert_eq!(profile.responses_continuation, "direct");

    let invalid_path = root.join("invalid.toml");
    fs::write(
        &invalid_path,
        "providerId = \"invalid\"\n[provider]\nbaseURL = \"https://example.invalid/v1\"\ndefaultModel = \"wire\"\ntype = \"responses\"\nresponsesContinuation = \"unknown\"\n[provider.models.wire]\nwireName = \"wire\"\n[provider.auth]\nenv = \"RCCV4_TEST_KEY\"\n",
    )
    .expect("invalid profile");
    let profile = load_profile(invalid_path.to_str().expect("utf8 path"))
        .expect("retired continuation hint is ignored");
    assert_eq!(profile.responses_continuation, "direct");
}

#[test]
fn v3_provider_profile_reads_secret_file_handle_without_runtime_import() {
    let root = std::env::temp_dir().join(format!("rccv4-provider-v3-{}", std::process::id()));
    fs::create_dir_all(&root).expect("temp root");
    let secrets = root.join("secrets.conf");
    fs::write(&secrets, "real.key1 = real-secret\n").expect("secret file");
    let profile_path = root.join("provider.v2.toml");
    let profile = format!(
        "version = \"2.0.0\"\nproviderId = \"real\"\n[provider]\nid = \"real\"\ntype = \"responses\"\nbaseURL = \"https://example.invalid/v1\"\ndefaultModel = \"wire\"\n[provider.models.wire]\ncapabilities = [\"text\"]\n[provider.auth]\ntype = \"apikey\"\nsecretFile = \"{}\"\n",
        secrets.display()
    );
    fs::write(&profile_path, profile).expect("profile");
    let loaded = load_profile(profile_path.to_str().expect("utf8 path")).expect("load v3 profile");
    verify_profile_auth(&loaded).expect("v3 secret handle resolves");
}

#[test]
fn compiled_auth_alias_is_checked_before_transport() {
    let root = std::env::temp_dir().join(format!("rccv4-provider-alias-{}", std::process::id()));
    fs::create_dir_all(&root).expect("temp root");
    let profile_path = root.join("provider.toml");
    fs::write(
        &profile_path,
        "providerId = \"real\"\n[provider]\nbaseURL = \"https://example.invalid/v1\"\ndefaultModel = \"wire\"\ntype = \"responses\"\n[provider.auth]\nentries = [{ alias = \"default\", secretFile = \"/tmp/secrets.conf\", secretKey = \"real.key1\" }]\n",
    )
    .expect("profile");
    let path = profile_path.to_str().expect("utf8 path");
    validate_auth_alias(path, Some("default")).expect("matching alias");
    let error = validate_auth_alias(path, Some("key2")).expect_err("mismatched alias");
    assert_eq!(error.code, "provider_auth_alias_mismatch");
}
