use super::*;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{V3ProviderIdentityRef, V3ProviderKeyRef};

const PROVIDER: &str = "recovery-provider";
const INTERFACE: &str = "responses";
const KEY: &str = "key-a";
const MODEL: &str = "model-a";
static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn manifest() -> V3Config05ManifestPublished {
    let source = r#"
version = 3
[servers.recovery]
bind = "127.0.0.1"
port = 5555
routing_group = "recovery"
endpoints = ["responses"]
[servers.recovery.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]
[providers.recovery-provider]
type = "responses"
base_url = "http://recovery.invalid/v1"
default_model = "model-a"
auth = { type = "api_key", entries = [{ alias = "key-a", env = "RECOVERY_KEY" }] }
[providers.recovery-provider.models.model-a]
wire_name = "model-a"
[route_groups.recovery.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "recovery-provider", model = "model-a", key = "key-a", priority = 1 }]
"#;
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(source).expect("stale settlement authoring"),
    )
    .expect("stale settlement manifest")
}

fn health_scope(session_id: &str) -> V3ProviderFailureSessionScope {
    V3ProviderFailureSessionScope::new("recovery", "recovery", session_id)
        .expect("valid health scope")
}

fn projection(
    health: &V3ProviderFailureRuntimeHealth,
    now_ms: u64,
) -> V3ProviderSchedulingProjection {
    health
        .store()
        .scheduling_projection_for_key_with_interface(
            V3ProviderKeyRef::new(PROVIDER, KEY, MODEL),
            INTERFACE,
            1,
            1,
            now_ms,
        )
        .expect("health projection")
}

#[test]
fn superseded_business_recovery_success_does_not_mutate_newer_episode_or_skip_ordinary_success() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let manifest = manifest();
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_tests(&manifest);
    let control =
        crate::execution_control::V3RequestExecutionControl::from_manifest(&manifest, "recovery")
            .expect("request execution control");
    let scope = health_scope("stale-success");
    let receipt = crate::nodes::V3AttemptSuccessReceipt::from_buffered_terminal_attempt();

    health
        .store()
        .add_cooldown_entry_for_interface(
            V3ProviderIdentityRef::new(PROVIDER, Some(KEY), Some(MODEL)),
            INTERFACE,
            "probe",
            1_000,
            1_000,
        )
        .expect("seed current episode");
    assert!(control
        .acquire_business_recovery_trial(&health.store(), PROVIDER, INTERFACE, KEY, MODEL, 2_000,)
        .expect("acquire owned trial"));
    // A newer episode replaces the permit's deadline while the old trial is
    // still held. Its success belongs to the old episode and must be inert.
    health
        .store()
        .add_cooldown_entry_for_interface(
            V3ProviderIdentityRef::new(PROVIDER, Some(KEY), Some(MODEL)),
            INTERFACE,
            "probe",
            60_000,
            2_010,
        )
        .expect("replace current episode");
    let newer = projection(&health, 2_011);
    assert!(!newer.available, "the replacement episode remains cooled");
    let concurrency = V3AdaptiveConcurrencyController::process_shared();
    let concurrency_key = v3_provider_concurrency_key_parts(PROVIDER, KEY);
    let concurrency_scope =
        routecodex_v3_provider_responses::adaptive_concurrency::V3ConcurrencyIdentityScope {
            interface_id: INTERFACE.into(),
            model_id: MODEL.into(),
        };
    concurrency
        .ensure_initial_budget(&concurrency_key, 4)
        .unwrap();
    let lease = concurrency
        .try_acquire_business_scoped(&concurrency_key, Some(&concurrency_scope))
        .unwrap();
    concurrency.release(lease.into_permit()).unwrap();
    concurrency
        .observe_rate_limit_scoped(&concurrency_key, Some(&concurrency_scope), 2_011)
        .unwrap();
    let adaptive_before =
        concurrency.snapshot_for_scope(&concurrency_key, Some(&concurrency_scope));
    let action_key = V3ProviderActionGateKey::new(
        &scope,
        v3_relay_provider_candidate_key_parts(PROVIDER, Some(INTERFACE), Some(KEY), Some(MODEL)),
        "provider_transport_error",
    )
    .unwrap();
    health.action_gate.record_failure(&action_key).unwrap();
    health.action_gate.record_failure(&action_key).unwrap();

    health
        .record_provider_success_with_business_recovery(
            &control,
            &receipt,
            &scope,
            PROVIDER,
            INTERFACE,
            Some(KEY),
            Some(MODEL),
            2_020,
        )
        .expect("stale success is ignored without an operator failure");
    assert_eq!(
        projection(&health, 2_021),
        newer,
        "a superseded recovery result must not mutate adaptive or ordinary health state"
    );
    assert_eq!(
        concurrency.snapshot_for_scope(&concurrency_key, Some(&concurrency_scope)),
        adaptive_before,
        "a stale result cannot clear newer adaptive saturation or increase its budget"
    );
    assert_eq!(
        health
            .action_gate
            .record_failure(&action_key)
            .unwrap()
            .minimum_delay_ms,
        1_000,
        "real business success still resets its request/session action lane"
    );

    // A request with no recovery ownership still takes the ordinary success
    // path. This guards against turning stale-result filtering into a blanket
    // success suppression.
    let ordinary_health = V3ProviderFailureRuntimeHealth::from_manifest_for_tests(&manifest);
    let ordinary_control =
        crate::execution_control::V3RequestExecutionControl::from_manifest(&manifest, "recovery")
            .expect("ordinary request control");
    let before = projection(&ordinary_health, 3_000);
    ordinary_health
        .record_provider_success_with_business_recovery(
            &ordinary_control,
            &receipt,
            &health_scope("ordinary-success"),
            PROVIDER,
            INTERFACE,
            Some(KEY),
            Some(MODEL),
            3_000,
        )
        .expect("ordinary success applies");
    let after = projection(&ordinary_health, 3_001);
    assert!(after.available);
    assert!(after.score_generation > before.score_generation);
}

#[test]
fn current_owned_business_recovery_success_clears_the_episode() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let manifest = manifest();
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_tests(&manifest);
    let control =
        crate::execution_control::V3RequestExecutionControl::from_manifest(&manifest, "recovery")
            .expect("request execution control");
    health
        .store()
        .add_cooldown_entry_for_interface(
            V3ProviderIdentityRef::new(PROVIDER, Some(KEY), Some(MODEL)),
            INTERFACE,
            "probe",
            1_000,
            1_000,
        )
        .expect("seed current episode");
    assert!(control
        .acquire_business_recovery_trial(&health.store(), PROVIDER, INTERFACE, KEY, MODEL, 2_000,)
        .expect("acquire current trial"));
    health
        .record_provider_success_with_business_recovery(
            &control,
            &crate::nodes::V3AttemptSuccessReceipt::from_buffered_terminal_attempt(),
            &health_scope("current-success"),
            PROVIDER,
            INTERFACE,
            Some(KEY),
            Some(MODEL),
            2_001,
        )
        .expect("current owned success settles");
    assert!(
        projection(&health, 2_002).available,
        "the matching governed success clears the episode"
    );
}
