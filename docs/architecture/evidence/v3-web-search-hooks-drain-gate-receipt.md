# Candidate Gate Receipt

- Candidate commit: `0040730c05234a64a2550b4f3a1221fc356328ca`
- Candidate tree: `da2c15a245c2a8b5c213d257cb0ab835ba491546`
- Receipt completed: `2026-09-19T14:14:00-0700`
- Preflight HEAD: `0040730c05234a64a2550b4f3a1221fc356328ca` (exact match)
- Preflight tree: `da2c15a245c2a8b5c213d257cb0ab835ba491546` (exact match)
- Preflight `git status --porcelain=v1 --untracked-files=no`: empty
- Overall result: `PASS`

## Gate 1: routecodex-v3-hooks

- Exact command:

  ```text
  cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-hooks -- --nocapture
  ```

- HEAD: `0040730c05234a64a2550b4f3a1221fc356328ca`
- Tree: `da2c15a245c2a8b5c213d257cb0ab835ba491546`
- Exit code: `0`
- Result: `PASS`
- Key output:

  ```text
  running 78 tests
  test result: ok. 78 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.01s

  running 0 tests
  test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

  running 6 tests
  test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.47s

  running 1 test
  test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

  running 11 tests
  test result: ok. 11 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.05s

  Doc-tests routecodex_v3_hooks
  running 0 tests
  test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
  ```

## Gate 2: servertool-core web_search_contract

- Exact command:

  ```text
  cargo test --manifest-path v3/Cargo.toml -p servertool-core web_search_contract -- --nocapture
  ```

- HEAD: `0040730c05234a64a2550b4f3a1221fc356328ca`
- Tree: `da2c15a245c2a8b5c213d257cb0ab835ba491546`
- Exit code: `0`
- Result: `PASS`
- Key output:

  ```text
  running 6 tests
  test web_search_contract::tests::completed_result_accepts_sources_without_control_state ... ok
  test web_search_contract::tests::failed_result_rejects_content ... ok
  test web_search_contract::tests::request_rejects_distinct_request_only_scope ... ok
  test web_search_contract::tests::request_accepts_real_client_scope_before_deadline ... ok
  test web_search_contract::tests::request_rejects_expired_deadline ... ok
  test web_search_contract::tests::request_rejects_request_only_scope ... ok

  test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
  ```

## Gate 3: runtime web_search_hook_

- Exact command:

  ```text
  cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime web_search_hook_ -- --nocapture
  ```

- HEAD: `0040730c05234a64a2550b4f3a1221fc356328ca`
- Tree: `da2c15a245c2a8b5c213d257cb0ab835ba491546`
- Exit code: `0`
- Result: `PASS`
- Key output:

  ```text
  running 26 tests
  test result: ok. 26 passed; 0 failed; 0 ignored; 0 measured; 855 filtered out; finished in 0.02s

  Remaining filtered test binaries reported `0 passed; 0 failed`.
  ```

## Gate 4: build:v3-cli

- Exact command:

  ```text
  npm --prefix v3 run build:v3-cli
  ```

- HEAD: `0040730c05234a64a2550b4f3a1221fc356328ca`
- Tree: `da2c15a245c2a8b5c213d257cb0ab835ba491546`
- Exit code: `0`
- Result: `PASS`
- Key output:

  ```text
  > routecodex-v3@0.90.4800 build:v3-cli
  > npm run verify:v3-architecture-ci && npm run verify:v3-runtime-restart-handoff && npm run verify:v3-debug-payload-budget && npm run verify:v3-selected-provider-model-binding && npm run verify:v3-provider-action-gate && npm run verify:v3-console-request-count-visibility && npm run verify:v3-responses-session-admission && npm run verify:v3-runtime-timing-observability && npm run test:v3-p5-router-target && npm run test:distribution && CARGO_NET_OFFLINE=true cargo build --locked -p routecodex-v3-cli

  [verify:v3-build-admission-lockstep] PASS files=481 digest=1a4b7cc4bf4257e925aa55d4c1453ec437a3681fae4ecb70b8746fde510b92e8
  [verify:v3-architecture-ci] ok (39/39 sub-gates green)
  [verify:v3-architecture-ci] PASS test:v3-p5-router-target - Priority-first and same-priority weighted Router/Target selection

  running 14 tests
  test result: ok. 14 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.08s

  running 36 tests
  test result: ok. 36 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s

  running 25 tests
  test result: ok. 25 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

  running 2 tests
  test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

  Finished `dev` profile [unoptimized + debuginfo] target(s) in 25.86s
  ```

## Final Artifact

- Path: `v3/target/debug/rccv3`
- SHA-256: `9d4efd92c1fcce17653367983415e025627d36893e6ea1e8c393c8faf637efa3`
- Bytes: `76765848`
- File mtime: `2026-09-19T14:13:55-0700`
- Provenance: produced by Gate 4 after its final `CARGO_NET_OFFLINE=true cargo build --locked -p routecodex-v3-cli` step exited `0`.

## Final State

- HEAD after gates: `0040730c05234a64a2550b4f3a1221fc356328ca`
- Tree after gates: `da2c15a245c2a8b5c213d257cb0ab835ba491546`
- Tracked worktree state after gates: clean (`git status --porcelain=v1 --untracked-files=no` empty)
- Code/tests/config changes: none
- Gate completion: all four commands were executed; all four exited `0`.
