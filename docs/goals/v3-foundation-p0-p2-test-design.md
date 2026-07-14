# V3 Foundation P0-P2 Test Design

## Scope

This design covers only P0 architecture contracts, P1 Config, and P2 multi-listener Server/CLI. It does not validate Provider execution or Responses direct behavior.

## Lifecycle cases

| Lifecycle | Positive | Negative |
| --- | --- | --- |
| Config compile | full multi-server/provider/model/auth/forwarder/route/debug/error declaration compiles deterministically | unknown field, invalid reference, alias ambiguity, literal secret, empty default, duplicate listener, no enabled server, forwarder cycle fail |
| Config IO | `V3ConfigStore` reads and atomically writes `config.v3.toml` | non-config crate file IO and mismatched write plan fail |
| Server startup | one Manifest starts all enabled listeners | any occupied/invalid listener fails aggregate startup and releases earlier binds |
| Health | every listener returns its own server ID/address/port and Manifest version | listener absent after explicit shutdown |
| Pending endpoint | request registers Debug node, traverses all Error nodes, emits Server frame | handler-local direct response and provider call are forbidden by source gates |
| CLI | config check, server status, and server start consume `V3ConfigStore`/Server APIs | CLI direct file IO, listener bind, provider dependency, or second lifecycle fail source gates |

## White-box tests

- Config parser/validator/registry/publisher node tests.
- Recursive target graph DFS cycle test.
- Auth alias and canonical model reference tests.
- Server aggregate preflight/bind cleanup test.
- Debug event and six-node Error projection assertions.
- Unique adjacent Server request/frame builder source anchors.

## Module blackboxes

- Config fixture -> `V3ConfigStore::load_snapshot` -> deterministic declaration-only Manifest.
- Manifest -> aggregate Server -> two listener handles.
- HTTP request -> `V3Server03HttpRequestRaw` -> Debug -> Error -> `V3Server16HttpFrame`.
- CLI process -> Config Store/Server public entrypoints.

## Project blackbox

Build the actual `routecodex-v3` Rust binary, start `v3/fixtures/config.p2.toml`, probe every `/health`, probe pending business endpoints, stop the exact process through its control handle, and prove both ports are closed.

## Required gates

- Rust fmt, Clippy with warnings denied, full V3 workspace tests/build.
- V3 architecture docs, resource map, module boundaries, Rust-only, static-hook, and compile-fail gates.
- Config-only IO scan and no compatibility projection scan.
- Targeted `git diff --check`.

## Known exclusions

- P3 persistent logging/snapshot/dry-run implementation.
- P4 runtime retry/cooldown policy.
- P5 Virtual Router/Target runtime.
- P6 Provider request/response execution.
