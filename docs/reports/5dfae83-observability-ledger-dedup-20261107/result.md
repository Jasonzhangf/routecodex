# p1-5dfae83-observability-ledger-dedup-20261107 result

## Root cause

`build_v3_provider_failure_event_sink` emits two lifecycle events for the same
provider failure: `ProviderAttemptFailed` and `ProviderSwitched`. The
`ProviderSwitched` row inherits the failed attempt's `provider_status`,
`error_category`, `error_detail`, and `observed_error` through
`merge_v3_obs_request_meta`. As a result one failed attempt writes two
failure-looking rows into `request-records.jsonl`, and downstream facets and
streak consumers read the duplicated failure fields from the raw lifecycle
lines.

## Code change

File: `v3/crates/routecodex-v3-server/src/webui_observability.rs`

At the end of `record_observed`, after `drop(inner)` and before the persisted
row is queued, a `ProviderSwitched` row now clears the four failure-specific
persisted fields:

- `provider_status`
- `error_category`
- `error_detail`
- `observed_error`

The in-memory row keeps its last-failure projection for the live table. Only
the persisted switch snapshot drops the duplicated failure fields, so the
switch line remains a lifecycle control event rather than a second failure.

## Red test

File: `v3/crates/routecodex-v3-server/src/webui_observability_tests.rs`

New test:
`provider_switch_row_does_not_repeat_failure_fields_in_records`

It asserts that started + failed + switched produce exactly three persisted
lines, only one line is `request.provider_attempt_failed`, that failed line
keeps `provider_status=400` and `error_category=provider_http_400`, and the
`request.provider_switched` line has null `provider_status`, `error_category`,
`error_detail`, and `observed_error`.

## Public-entry black-box test

File:
`v3/crates/routecodex-v3-server/tests/issue5dfae83_provider_switch_ledger_dedup.rs`

Stable test ID: `issue5dfae83_provider_switch_ledger_dedup`.

It starts a real listener plus the admin WebUI, sends a real request through
the listener, and makes provider `a` answer HTTP 503 while provider `b` answers
business 200. It then reads the public request-records store and the admin HTTP
surface and asserts:

- provider `a` and provider `b` are each attempted exactly once;
- the client receives the switched provider's business body;
- the raw lifecycle stream has exactly one
  `request.provider_attempt_failed` row and exactly one
  `request.provider_switched` row;
- the switch row has null `provider_status`, `error_category`, `error_detail`,
  and `observed_error`;
- the same request has exactly one `request.completed` row;
- the admin records surface counts `failed_attempts == 1`.

The test then flips provider `a` to success and sends a second request on the
same listener. That success control asserts:

- provider `a` is attempted once and provider `b` is never reached;
- the control request writes no `request.provider_attempt_failed` and no
  `request.provider_switched` row;
- the control request has exactly one `request.completed` row;
- the admin records surface counts `failed_attempts == 0` for it.

The test is bound to `v3.server_internal_observability_projection` in
`docs/architecture/v3-verification-map.yml`.

## Green results

Focused red-to-green test:

```sh
cargo test -p routecodex-v3-server --lib provider_switch_row_does_not_repeat_failure_fields
```

Result: 1 passed.

Server observability suite:

```sh
cargo test -p routecodex-v3-server --lib webui_observability::tests
```

Result: 22 passed.

Observability store suite:

```sh
cargo test -p routecodex-v3-debug --lib observability_store
```

Result: 12 passed.

Public-entry black-box:

```sh
cargo test -p routecodex-v3-server --test issue5dfae83_provider_switch_ledger_dedup
```

Result: 1 passed.

Admin observability suite:

```sh
cargo test -p routecodex-v3-admin observability
```

Result: 8 passed + 13 passed + 10 passed.

Server build:

```sh
cargo build -p routecodex-v3-server
```

Result: Finished dev profile.

Architecture gate:

```sh
npm run verify:v3-architecture-ci
```

Result: ok (33/33 sub-gates green).

Architecture map gates:

```sh
npm run verify:v3-resource-map
npm run verify:architecture-mainline-call-map
git diff --check
```

Result: all passed.

## CI and baseline comparison

PR554 test job:
https://github.com/Jasonzhangf/routecodex/actions/runs/42854045909/job/129962958322

The PR554 head `69029ffc9c` failed the `test` job at the rustfmt gate, not at
the provider behavior tests. The failing check was:

```text
[v3 verify] FAIL 1 gate(s)
- rustfmt: cargo fmt --all -- --check failed: exit 1
```

The only formatting difference was in the new public-entry test:

```text
v3/crates/routecodex-v3-server/tests/issue5dfae83_provider_switch_ledger_dedup.rs
```

The current worktree fixes only that formatting difference. After the fix:

```sh
cargo fmt --all -- --check
```

Result: exit 0.

```sh
node scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test issue5dfae83_provider_switch_ledger_dedup -- --nocapture
```

Result: 1 passed.

```sh
cargo test -p routecodex-v3-server --lib provider_switch_row_does_not_repeat_failure_fields_in_records
```

Result: 1 passed.

For comparison, origin/main run:
https://github.com/Jasonzhangf/routecodex/actions/runs/42772306077

That run is the latest main baseline at `1a01fc3fdd`. Its installed V3
protocol live-mock matrix stopped with six inherited failures:

```text
issue-745f6e9-provider-concurrency-all-busy-direct
issue-745f6e9-provider-concurrency-all-busy-relay
issue-745f6e9-provider-concurrency-mixed-exclusion-direct
issue-745f6e9-provider-concurrency-mixed-exclusion-relay
media-anthropic-older-turn-tool-image
provider-error-exhaustion
```

Those six failures belong to their existing owners and are outside this
change. The earlier PR554 rustfmt failure was separate from that baseline. It
was fixed in `3999b5ec5c`, which is pushed and is the current PR head. The
local review branch is two commits ahead of that pushed head: this report's
terminal-CI section and the same-listener success control in the public-entry
test.

### Terminal PR CI run (42864567365)

This terminal-CI receipt applies to the pushed PR head `3999b5ec5c`. The
reviewed candidate is the tip of branch
`codex/5dfae83-observability-ledger-dedup-20261110` (the commit under review);
`3999b5ec5c` is an ancestor of it. The candidate-only changes since
`3999b5ec5c` are this report section and the same-listener success control in
the public-entry test. CI has not been re-run on the reviewed tip; it will be
re-run on the recombined candidate after the inherited baseline is fixed.
Workflow run
https://github.com/Jasonzhangf/routecodex/actions/runs/42864567365:

- `scope` and `repo-sanity` passed.
- The `test` job failed inside `V3 canonical verification stack`. The stack
  started at `2026-11-10T17:34:01Z` and ended at `18:38:14Z`.
- First assertion failure at `2026-11-10T18:02:20Z`:

  ```text
  broker_terminal_validation_holds_active_recovery_lane_beyond_five_seconds
  crates/routecodex-v3-runtime/tests/gemini_relay_runtime_integration.rs:1415
  active Broker recovery permit expired before validated terminal EOF
  ```

- After that assertion, the stack kept running until the last visibly running
  test `malformed_non_terminal_and_post_terminal_sse_fail_explicitly`. At
  `18:38:08Z` the cargo wrapper reported
  `cargo timeout 2400000ms; sending SIGTERM to process group 37139`, then sent
  SIGKILL after the grace period. The canonical command exited `86`. The cause
  of the post-assertion timeout was not independently established.

Base control on the same focused test, run on the tested ancestor
`3999b5ec5c` and on clean detached `origin/main` `1a01fc3fdd`:

- Candidate ancestor `3999b5ec5c`: `0 passed; 1 failed` in 5.44s.
- Clean detached `origin/main` `1a01fc3fdd`: `0 passed; 1 failed` in 5.44s,
  same assertion.
- The candidate diff changes only
  `docs/architecture/v3-verification-map.yml`, this report,
  `webui_observability.rs`, its unit test, and its public-entry test. It does
  not touch the runtime test or the Broker recovery owner.

Classification: inherited baseline red, not a regression from this change. The
gap is routed to the existing board task
`p0-gemini-broker-terminal-baseline-red-20261110` (revision 12, status
`rework`, `needs_reassignment=true`, empty owner, executor Jack). This task
does not repair that unrelated runtime failure.

## Unrelated suite hang

The full `cargo test -p routecodex-v3-server --lib` suite was interrupted while
an unrelated `local599_output::fixture::empty_http200_attempt_is_typed502_without_last_candidate_health_mutation`
test was stuck. That test is not part of this change. The affected observability
tests, build, and architecture gate were verified separately and passed.
