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
change. The PR554 rustfmt failure is separate from that baseline and is fixed
only in the local worktree. The fix has not been pushed, so PR554 still points
to the pre-fix head until the delivery owner is authorized to push and rerun
CI.

## Unrelated suite hang

The full `cargo test -p routecodex-v3-server --lib` suite was interrupted while
an unrelated `local599_output::fixture::empty_http200_attempt_is_typed502_without_last_candidate_health_mutation`
test was stuck. That test is not part of this change. The affected observability
tests, build, and architecture gate were verified separately and passed.
