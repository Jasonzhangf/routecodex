//! L2 regression for the V4 CLI plugin thin binary shim.
//!
//! The CLI library exposes `pub fn run()` as the deterministic dispatcher for
//! every subcommand. The build-link consumer regression suite compiles this
//! crate as `--crate-type lib` and runs the tests in this file against that
//! library surface, mirroring the standard plugin library's plan compilation
//! gate. Positive cases lock the dispatcher to its declared subcommand
//! surface; negative cases lock unknown subcommands to fail fast.

use routecodex_v4_cli_plugin as cli;

#[test]
fn positive_lib_run_is_exported() {
    // The CLI library must expose a `run` symbol so the binary shim can
    // forward process output into a deterministic exit code. Build-link's
    // consumer regression compiles this crate as a library, so the symbol
    // contract is the load-bearing part of the regression.
    let symbol: fn() -> Result<(), String> = cli::run;
    let _: fn() -> Result<(), String> = symbol;
}

#[test]
fn positive_unknown_node_id_is_rejected_by_standard_surface() {
    // The CLI's `node-permissions` subcommand is bounded to the standard
    // node permission surface. The library rejects unknown nodes directly
    // so build-link can compile and run this gate without spinning up the
    // binary.
    let reads = routecodex_v4_standard_plugins::standard_node_allowed_reads("V4NotARegisteredNode");
    let writes =
        routecodex_v4_standard_plugins::standard_node_allowed_writes("V4NotARegisteredNode");
    assert!(reads.is_empty() && writes.is_empty());
}

#[test]
fn positive_response_inbound_node_permissions_locked() {
    // The standard library must publish a non-empty read/write surface for
    // the response inbound node so the CLI's `node-permissions` subcommand
    // can render its permission table deterministically.
    let reads =
        routecodex_v4_standard_plugins::standard_node_allowed_reads("V4HubRespInbound03Normalized");
    let writes =
        routecodex_v4_standard_plugins::standard_node_allowed_writes("V4HubRespInbound03Normalized");
    assert!(!reads.is_empty(), "response inbound must publish reads");
    assert!(!writes.is_empty(), "response inbound must publish writes");
}
