# PR367 controlled Chat fixture combination

Scope: test fixture only. No runtime source or configuration change.
Parent-owned tree: `/Volumes/Intel/playground/routecodex/pr367-chat-fixture-combination-20261007-r193`.
Base HEAD: `5457958ac42c26a3942b33d20146b2851f29d941`, PR367 current head, combined with latest `origin/main` `459004b113d31f79d818992509c1a1fb17639b66`.

Changed test: `v3/crates/routecodex-v3-server/tests/openai_chat_relay_controlled.rs`.
Exact source patch reused from previously verified/reviewed `bfdcabc4e` (equivalent author patch `050c7c556`).

## Failure and unique owner

PR367 CI run37558257094 failed at line279: stream provider failure did not produce a provider capture. The fixture sent its earlier deliberate non-stream429 and later stream429 through the same exact provider identity. The first failure correctly cooled that identity, so the later request exhausted selection before provider transport. A later success case also reused that cooled identity.

The test fixture owns identity isolation. The repair uses a distinct declared provider/auth identity for its SSE cases and executes the normal-routing success case before intentional failures. It preserves all failure, client-decoupling, capture, auth, routing and payload-isolation assertions. No timeout change, sleep, disabled health, deleted assertion or production fallback is added.

## Author public-entry evidence

Command, with the real Server HTTP entry, real localhost HTTP provider and full JSON/SSE/error/isolation sequence:

```sh
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test openai_chat_relay_controlled -- server_executes_controlled_json_sse_error_and_isolation_without_second_owner --exact --nocapture
```

Evidence root: `/Volumes/Intel/playground/routecodex/.worker-runs/dagpipe-parallel-foundation-20261005/parent-pr367-combination-r193`.

| Input | Evidence | Actual result |
| --- | --- | --- |
| Exact PR367 head, no patch | host-baseline.log / host-baseline.exit | exit101; original line279 capture timeout reproduced |
| Exact head plus approved isolation patch | host-combined.log / host-combined.exit | exit0; all sequence assertions pass |
| Reverse intervention, patch removed | host-reverse.log / host-reverse.exit | exit101; same line279 capture timeout reproduced |

After the reverse experiment, the exact patch was reapplied. `git diff --check` passes. The final test diff is the same verified patch, not a new runtime repair.

Additional evidence on the full79d38a candidate already containing this patch: `../parent-chat-ci-r191/host-original.log/.exit`, exit0.

## Delivery boundary

This is author verification before independent architecture review. Review is pending. No merge, push, binary install or shared runtime restart is claimed. Runtime lifecycle is not applicable to this test-only delta. The PR still requires exact-head CI after the reviewed normal commit and push; REQ02 still requires Gemini and full node acceptance.

MCPX capability/workspace checks succeeded at runtime0.9.18, but this disposable candidate tree is not registered. CLI actions are bound to its explicit cwd; no MCPX session or completion is claimed.
