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

## Unrelated suite hang

The full `cargo test -p routecodex-v3-server --lib` suite was interrupted while
an unrelated `local599_output::fixture::empty_http200_attempt_is_typed502_without_last_candidate_health_mutation`
test was stuck. That test is not part of this change. The affected observability
tests, build, and architecture gate were verified separately and passed.
