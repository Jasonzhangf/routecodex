# Provider traffic-governor ablation - delivery report

Task: provider-traffic-governor-ablation-20261107
Owner: Jack (peer/worker)
Date: 2026-11-08
Worktree: /Volumes/Intel/playground/routecodex/provider-traffic-governor-ablation-20261107
Branch: codex/provider-traffic-governor-ablation-20261107
Base: origin/main 7de2dd2952 (latest fetched and merged into the branch)

## Target behavior

A sole usable provider must receive the real request immediately. With only one
available provider there is no cooldown, no capacity admission, no probe wait,
and no traffic-governor blocking: if the request fails, it fails as-is. All
cooldown and admission processing only applies when more than one eligible
provider exists, and even then it changes provider visibility only, never the
request transport.

## Removed residue

- `v3/crates/routecodex-v3-provider-responses/src/adaptive_concurrency.rs`
- `v3/crates/routecodex-v3-target/src/sticky.rs`
- `v3/crates/routecodex-v3-runtime/src/provider_probe_fairness_tests.rs`
- `v3/crates/routecodex-v3-server/tests/session_sticky_selection_public.rs`
- `v3/crates/routecodex-v3-server/tests/support/pool_empty_recovery_blackbox.rs`
- `v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy/tests/cooldown_exhaustion.rs`
- concurrency/sticky config fields, image entries, and map residue
- stale test references to `adaptive_concurrency`, `ConcurrencyBusy`, and
  `TestLeaseCleanup`

Mapped documentation updated to the shipped behavior:

- `docs/design/provider-failure-policy-ssot.md`
- `docs/architecture/v3-function-map.yml`
- `docs/architecture/v3-verification-map.yml`

## Red-before / green-after evidence

Red-before: `.worker-runs/provider-traffic-governor-ablation-20261107/red-test-20261108.md`
and `.txt`. A sole provider with `max_in_flight = 1` and its business lease held
by a foreign holder received 0 calls; the client waited until its 10s timeout and
then failed with `IncompleteMessage`.

Green-after: `issue86b45e0_last_provider_policy` passed 7/7, including
`i86_single_provider_concurrency_lease_does_not_block`.

## Verification

- `issue86b45e0_last_provider_policy`: 7/7 passed
- runtime provider-failure-policy suite: 95/95 passed
- `cargo fmt` check passed
- fast architecture gate: 33/33 sub-gates green
- `verify:fast` passed
- Full `npm run verify:ci` on the merged branch: `[v3 verify] PASS`,
  architecture-ci ok, 1649/1650 workspace tests passed.

The single failing test is
`kernel::tests::direct_sse_no_continuation_stream_error_is_not_silent_eof`
(`kernel_unit.rs` panic: "last attempt must stay pending after provider EOF").
This is inherited baseline red, not a branch regression. The same test fails on
a clean detached `origin/main` 7de2dd2952 baseline
(`/Volumes/Intel/playground/routecodex/_ablation-baseline-probe`), and matches
the earlier known `origin/main` baseline red recorded for PR #537.

## Provider switching and request independence preserved

The ablation does not add a new routing owner or request gate. Failure still
enters the typed Error chain and reselects another eligible provider when one is
visible. Concurrent independent requests, client cancel, the original request
deadline, and real transport failure keep their existing semantics. The
first-byte cap for remote providers remains 120s and only rejects the failed
candidate.

## Request waits and cooldown policy

| Scenario | Request behavior | Wait / cooldown / admission | Value |
| --- | --- | --- | --- |
| Sole usable provider | Send immediately | None; failure propagates as-is | - |
| Multiple visible providers | Select and transport immediately | None for selection | - |
| Provider cooldown / recovery / probe | Request is never blocked | Changes VR visibility only | - |
| Pool exhaustion rescue | Keep original response pending | Waits by generation, then next candidate | - |
| Remote provider first byte | Fail candidate if no frame in time | Cap 120000 ms, then next tier/pool | 120000 |
| Whole-request deadline | Preserve original deadline | `request_timeout_ms` only, not capped | config |
| Refill (business continuation) | At most one extra after original | Business boundary only, 0 disables | 0/1 |
| Early HTTP 429 | Switch to next visible candidate immediately | None for this request | - |
| New real 429 spanning 2 min | Commit minimum cooldown | 30 min minimum cooldown | 120000 / 1800000 |
| 429 episode spanning 1 hour | Probe-required disposition | Real non-429 HTTP response required | 3600000 |
| HTTP 401/402/403 | 1 consecutive failure | 1 hour cooldown plus 1 hour explicit probe | 3600000 |
| Ordinary recoverable non-429 | Declared threshold plus precool observation | Cooldown from 5s on the failure ladder | 5000 |
| Recovery probe ladder | Independent of business cooldown | 5s -> 10s -> 30s -> 60s -> 120s -> 900s -> 1800s | ladder |
| Matching business success | Reset only an unlocked episode | Cannot bypass a committed minimum | - |
| `health.advisory_probe = true` | Advisory scheduling only | Cannot bypass 429 minimum or required probe | - |

Recovery probe ladder constants come from `PROVIDER_FAILURE_LADDER_MS`.

## Not performed

- No production install or `rcc restart`.
- No push to `main` and no merge; this delivery is a PR candidate for master
  high-priority merge.
- Main checkout `/Users/fanzhang/Documents/github/routecodex` dirty user state
  was not touched.
