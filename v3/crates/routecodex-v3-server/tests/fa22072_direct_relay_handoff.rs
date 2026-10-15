//! Wiring-only public target for the Chat Direct-to-Relay handoff.
//!
//! Stable test IDs:
//! - `fa22072_direct_to_relay_business_continuation_public_entry`
//! - `fa22072_direct_to_relay_beta_positive_public_entry`
//! - `fa22072_direct_kernel_returns_selected_relay_handoff_public_consumer`
//! - `fa22072_direct_relay_provider_model_pin_failure_does_not_admit_default_pool`
//! - `fa22072_direct_relay_default_pool_exhaustion_public_entry`
//! - `fa22072_direct_relay_captured_plan_and_exclusions_public_consumer`
//!
//! This target is deliberately separate from the pending raw-wire diagnostic
//! artifact test. It does not read `provider-failed-attempts.json`.

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "support/fa22072_test_home.rs"]
mod test_home;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

#[path = "fa22072_direct_relay_handoff/handoff.rs"]
mod direct_relay_handoff;
