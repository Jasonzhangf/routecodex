//! routecodex-v4-provider L2 regression: session-scoped availability.

use routecodex_v4_provider::{
    load_profile, verify_profile_auth, AvailabilityRecord, AvailabilityState,
    V4Availability01SessionScoped,
};
use std::fs;

#[test]
fn session_scoped_availability_positive_and_red() {
    let mut registry = V4Availability01SessionScoped::new();
    registry
        .record("srv-1", "rg-1", "session-a", "provider-1", AvailabilityState::Healthy, 0)
        .expect("record must succeed");
    let record: &AvailabilityRecord = registry
        .get("srv-1", "rg-1", "session-a", "provider-1")
        .expect("session record must exist");
    assert_eq!(record.state, AvailabilityState::Healthy);
    registry
        .record("srv-1", "rg-1", "session-a", "provider-1", AvailabilityState::Unavailable, 3)
        .expect("same-session update must replace the record");
    assert_eq!(
        registry
            .get("srv-1", "rg-1", "session-a", "provider-1")
            .expect("updated record")
            .consecutive_errors,
        3
    );
    // Different session must never observe the other session's availability.
    assert!(registry.get("srv-1", "rg-1", "session-b", "provider-1").is_none());
    assert_eq!(registry.records().count(), 1);
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
