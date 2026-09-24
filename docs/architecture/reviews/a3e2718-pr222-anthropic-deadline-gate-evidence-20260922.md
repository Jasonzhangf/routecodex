# a3e2718 PR222 Anthropic Deadline Gate Evidence

Candidate scope: bug `a3e2718`, worktree
`playground/pr222-anthropic-deadline-ci-0922`, base
`3f8b35145f30eab1247cb88bfa27ee53c7987047`.

Changed runtime/test files at this evidence point:

- `v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_helpers.rs`
- `v3/scripts/tests/v3-execution-control-payload-architecture-red-fixtures.mjs`

Worker-reported focused validation from `m1790063795543-8`:

- `git diff --check`: PASS
- `npm run test:v3-execution-control-payload-architecture-red-fixtures`: PASS
- `npm run verify:v3-execution-control-payload-architecture`: PASS
- `cargo +stable fmt --manifest-path v3/Cargo.toml --all -- --check`: PASS
- `cargo test ... anthropic_relay_continuous_non_terminal_sse_returns_typed_failure`: PASS 1/1
- `cargo test ... attempt_budget_exhaustion_projects_execution_control_without_provider_send`: PASS 1/1
- `cargo test -p routecodex-v3-runtime --test anthropic_relay_runtime_integration`: PASS 18/18

Master re-ran additional architecture gates in this same worktree after review
attempt `a3e2718-pr222-anthropic-deadline-review-a4-0922` requested visible
verification evidence:

- `npm run verify:v3-resource-map`: PASS
- `npm run verify:v3-module-boundaries`: PASS
- `npm run verify:v3-execution-control-payload-architecture`: PASS
- `npm run test:v3-execution-control-payload-architecture-red-fixtures`: PASS, including 37 forbidden mutation checks
- `npm run verify:v3-architecture-ci`: PASS, 39/39 sub-gates green

Standalone `npm run verify:v3-mainline-caller-flow` failed before
architecture admission setup because `v3/build-contracts/architecture-admission`
was absent. The later `npm run verify:v3-architecture-ci` run performed the
admission setup and covered caller-flow successfully.

Lifecycle boundary:

- No commit yet.
- No merge to `main` yet.
- No install, restart, health check, OTA, emulator/device, or live replay yet.
- `npm ci --prefix v3 --no-audit --no-fund` was run by the worker to restore a
  missing dependency and executed its install script, rebuilding/installing
  `rccv3`, `rccv3-admin`, and `rccv3-hooksd` as a side effect. No service
  restart or runtime-loaded proof is claimed from that side effect.

Review interpretation:

- This document is candidate review evidence for source/test/architecture gates.
- It does not claim merge, runtime installation, restart, listener health, or
  same-entry live replay evidence.
- Those lifecycle stages remain required after a valid review PASS and merge,
  if this candidate proceeds to integration.
