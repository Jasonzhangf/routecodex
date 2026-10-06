# REQ02 Authorized Terminal Author Result (2026-10-03)

## Scope

- Assignment: `.execution/terminal-newmain-assignment.md`
- Candidate HEAD: `de953d36ea731c5afd8ad6e8464e9fa2abac6b02`
- Worktree: `/Volumes/Intel/playground/routecodex/dagpipe-req02-authorized-20261003`
- Exclusive writable range used: `.execution/terminal-newmain/` plus this evidence file.
- The candidate keeps the imported REQ02 changes and is not a production caller cutover.
- No product source, tests, maps, goal, install/restart, commit/push, 4444, or other worktree was modified.

## Input Evidence

- Isolated test HOME: `.execution/terminal-newmain/test-home`
- Original `HOME`: `/Users/fanzhang`
- Original `CARGO_HOME` and `RUSTUP_HOME`: unset; effective paths `/Users/fanzhang/.cargo` and `/Users/fanzhang/.rustup`, set explicitly for the suites.
- Affected Server/runtime/CLI source and exact test files hashed: `64`
- Affected-file list SHA-256: `093745ce8c8b97d7701844450c2088d7e731c867d0ef40f32f2d8235d58f9b17`
- Pre-run hash manifest SHA-256: `90194d951be129bf9ca7a9210bfb02d1df0f9174a9c79fc18b0e97509e85d577`
- Post-run hash manifest SHA-256: `90194d951be129bf9ca7a9210bfb02d1df0f9174a9c79fc18b0e97509e85d577`
- Hash comparison exit: `0`

## Actual Suites

Both suites ran sequentially from `v3/`, with `CARGO_NET_OFFLINE=true`, the owned HOME, preserved toolchain homes, and `--test-threads=1`. True exits were captured separately in the `.exit` files below.

1. `CARGO_NET_OFFLINE=true node scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test multi_listener_server -- --nocapture --test-threads=1`
   - Actual exit: `0`
   - Captured result: `78 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 23.62s`
   - Log: `.execution/terminal-newmain/server-multi-listener.log`
   - Log SHA-256: `57074529ba5d44b1bb47dc37a0f4fffc2d5a88292fc46ebd7b77e8c014130810`
   - Exit file SHA-256: `5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9`
   - The new main full-sampling burst case is included in the passing suite.

2. `CARGO_NET_OFFLINE=true node scripts/run-v3-cargo-test.mjs -p routecodex-v3-cli --test h2_chat_direct_isolation -- --nocapture --test-threads=1`
   - Actual exit: `0`
   - Captured result: `13 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 129.54s`
   - Log: `.execution/terminal-newmain/cli-h2-direct-isolation.log`
   - Log SHA-256: `35af281f25a8ecea83ab0a4d9eaf6f1d57fc22d7e8a03b2b5944ce890aa0bfb2`
   - Exit file SHA-256: `5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9`

## Disposition

- Author verification: PASS for both assigned suites with true exit `0` and nonzero expected counts.
- The prior shared-HOME `Server spawn ENOENT` shape did not recur under the owned HOME.
- Independent review, source integration, install/restart, runtime replay, caller E2E, sample audit, commit, merge, push, and OTA remain UNVERIFIED and were not performed.
- `4444` was untouched. The owned test HOME and evidence are retained for parent cleanup.
