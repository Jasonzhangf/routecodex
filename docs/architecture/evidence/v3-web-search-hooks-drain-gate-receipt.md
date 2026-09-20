# Candidate Gate Receipt

- Candidate commit: `0d06a76a60a78a9f9dae172fe9ea6284d0d3c4a1`
- Candidate tree: `66f8261efb779b04f892de774caf23253fc0df7c`
- Receipt completed: `2026-09-19`
- Preflight HEAD: `0d06a76a60a78a9f9dae172fe9ea6284d0d3c4a1` (exact match)
- Preflight tree: `66f8261efb779b04f892de774caf23253fc0df7c` (exact match)
- Preflight `git status --porcelain=v1 --untracked-files=no`: only this receipt was modified
- Overall result: `PASS`

This receipt records candidate source gates and the candidate artifact. It does
not claim merge, install, managed restart, health, or live replay. Those
post-merge acceptance steps are appended only after the reviewed candidate is
integrated and exercised through the declared lifecycle.

## Gate 1: routecodex-v3-hooks

- Exact command:

  ```text
  cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-hooks -- --nocapture
  ```

- HEAD: `0d06a76a60a78a9f9dae172fe9ea6284d0d3c4a1`
- Tree: `66f8261efb779b04f892de774caf23253fc0df7c`
- Exit code: `0`
- Result: `PASS`
- Key output:

  ```text
  running 79 tests
  test result: ok. 79 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.02s

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

- HEAD: `0d06a76a60a78a9f9dae172fe9ea6284d0d3c4a1`
- Tree: `66f8261efb779b04f892de774caf23253fc0df7c`
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

- HEAD: `0d06a76a60a78a9f9dae172fe9ea6284d0d3c4a1`
- Tree: `66f8261efb779b04f892de774caf23253fc0df7c`
- Exit code: `0`
- Result: `PASS`
- Key output:

  ```text
  running 27 tests
  test result: ok. 27 passed; 0 failed; 0 ignored; 0 measured; 855 filtered out; finished in 0.19s

  Remaining filtered test binaries reported `0 passed; 0 failed`.
  ```

## Gate 4: build:v3-cli

- Exact command:

  ```text
  npm --prefix v3 run build:v3-cli
  ```

- HEAD: `0d06a76a60a78a9f9dae172fe9ea6284d0d3c4a1`
- Tree: `66f8261efb779b04f892de774caf23253fc0df7c`
- Exit code: `0`
- Result: `PASS`
- Key output:

  ```text
  > routecodex-v3@0.90.4800 build:v3-cli
  > npm run verify:v3-architecture-ci && npm run verify:v3-runtime-restart-handoff && npm run verify:v3-debug-payload-budget && npm run verify:v3-selected-provider-model-binding && npm run verify:v3-provider-action-gate && npm run verify:v3-console-request-count-visibility && npm run verify:v3-responses-session-admission && npm run verify:v3-runtime-timing-observability && npm run test:v3-p5-router-target && npm run test:distribution && CARGO_NET_OFFLINE=true cargo build --locked -p routecodex-v3-cli

  [verify:v3-build-admission-lockstep] PASS files=483 digest=faae3f6b435b8b00c17a0e75c603f19d573d6e789fc0f58d728d2c4cb3521996
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

  Finished `dev` profile [unoptimized + debuginfo] target(s) in 29.98s
  ```

## Final Artifact

- Path: `v3/target/debug/rccv3`
- SHA-256: `ec75d2282967822d718129adb7a44e5b76fd73468c4ec09a9cfa6e13760ec9f0`
- Bytes: `76636680`
- File mtime: `2026-09-19T18:24:59-0700` (`1789867499`)
- Provenance: produced by Gate 4 after its final `CARGO_NET_OFFLINE=true cargo build --locked -p routecodex-v3-cli` step exited `0`.

## Final State

- HEAD after gates: `0d06a76a60a78a9f9dae172fe9ea6284d0d3c4a1`
- Tree after gates: `66f8261efb779b04f892de774caf23253fc0df7c`
- Tracked worktree state after gates: only this receipt was modified
- Code/tests/config changes: none
- Gate completion: `PASS`

## Candidate Scope Delta

- `fix(v3): reject failed web-search result in completed wrapper`
- Added the `WebSearchHookOutcome::Completed` wrapper invariant and the
  `validate_outcome_rejects_completed_wrapper_with_failed_status` regression.
- This candidate still requires independent review and post-merge lifecycle
  acceptance before delivery is complete.
