# Error-origin statistics: separate upstream failures from our own transport failures

Status: **frozen contract** — implement to this; do not re-litigate in review.
Owner: lead (architecture) · backend: `observability-vertical` · frontend: `usage-frontend`.

## Problem (observed, not hypothesised)

The WebUI's error statistics report one bucket per HTTP status, and that bucket
conflates two different things. Measured live on the running instance
(`GET /api/observability/records`, 2026-10-02):

```
error_status_codes : {"200":6, "403":3, "413":8, "429":67, "502":1699, "503":304}
error_categories   : {"provider_transport_error":743, "provider_runtime_error":579,
                      "provider_response_body_error":273, "provider_http_503":179,
                      "api_error":141, "provider_response_header_timeout":86,
                      ... , "provider_http_502":4, ...}
```

So **1699 rows are reported as "502" while only 4 of them are an upstream 502**.
The other ~1695 are our own failures. Operators read "502: 1699" as "the provider
is returning 502 a lot", which is the opposite of the truth.

### Root cause

`row_status_code` (`v3/crates/routecodex-v3-admin/src/api/observability.rs:628`)
prefers `provider_status` and only falls back to `error_category`:

```rust
let provider_status = status_code_label(row.meta.get("provider_status"));
if provider_status != "unknown" { return provider_status; }
```

But `provider_status` is the **projected client status**, not the upstream status.
Per the project contract, a network failure projects `502`; the runtime stamps that
projected 502 into `provider_status` for local failures too. Verified on real rows:

| row | `provider_status` | `error_category` | `error_detail` |
|---|---|---|---|
| genuine upstream 502 | `502` | `provider_http_502` | `provider returned HTTP 502` |
| our transport failure | `502` | `provider_transport_error` | `provider xmcc2 transport failed …` |
| our runtime failure | `502` | `provider_runtime_error` | `provider whitehat response body failed …` |
| our header timeout | `502` | `provider_response_header_timeout` | `provider xmcc2 transport failed …` |

The typed truth that separates them is `error_category`.

## Decisions (locked)

**E1. Origin is derived from the typed error category, never from the status.**
`provider_status` stays the projected status and keeps its current meaning; the
statistics gain a second, independent dimension.

**E2. Classification rule — exactly three values, `upstream` / `local` / `unknown`.**

- **`upstream`** — `error_category` matches `provider_http_<code>` with `<code>`
  parsing as `u16`. This is the *only* marker the runtime writes when the provider
  really answered with an HTTP status: `hooks.rs:951` (`V3ProviderError::HttpStatus`),
  `hooks.rs:960`, `shared.rs:244` (`raw.status()`), `v3_direct_core.rs:713`.
- **`local`** — a failure row whose category is present but is not that marker.
  This deliberately covers our transport, our runtime, our body handling, our
  timeouts, our internal lanes, our selection, client-input rejection
  (`body_too_large`, `malformed_json`, `content_type_*`), and the `http_<status>`
  fallback (our own projection with no upstream witness).
- **`unknown`** — a failure row with no category at all.

The rule is **positive for `upstream` and open for `local`**, deliberately: the
category set is open-ended (it is built from scattered `error_type` /
`external_error_code` strings), so a closed allowlist of local categories would
silently misclassify every category added later.

Consequence to state plainly, not hide: `provider_empty_visible_output` and
`provider_response_incomplete_max_tokens` are provider-*content* findings, and this
rule classifies them `local` because the provider returned no error status. That is
the intended reading of "did the provider reject us, or did we fail to get a valid
answer"; the existing `error_categories` facet still names them precisely.

**E3. New facets; the existing facet contract is unchanged.**
Add to the `facets` object:

- `error_origins`: `{"upstream": u64, "local": u64, "unknown": u64}`
- `error_status_origins`: `{"<status>": {"upstream": u64, "local": u64, "unknown": u64}}`

`error_status_codes` keeps its current shape and values. Existing tests assert on
it (`l4_admin_api.rs:610-612`, `l4_admin_observability.rs:658`) and must keep
passing untouched.

`error_status_origins` is the direct answer to the complaint: it lets a caller see
that `502` is `{upstream: 4, local: 1695}` instead of a single misleading `1699`.

**E3a. The two facets do not reconcile, deliberately.** `error_status_origins` is a
strict refinement of `error_status_codes`, so it inherits that facet's pre-existing
`499` cancellation bucket. `error_origins` is the rollup over *error* rows only and
therefore excludes cancellations. So
`sum(error_origins) == sum(error_status_origins) - cancellations`, while every
per-status refinement stays exact. Counting a client disconnect as "an error of
unknown origin" would recreate exactly the bucket-conflation this change exists to
remove, and this codebase already reports cancellations separately
(`stats.cancelled_count` vs `stats.error_count`). Consumers that want a total
matching the visible rows must sum the rows, not read `error_origins`.

**E3b. `error_status_origins` carries only observed origins.** It does not seed a
zero for each of the three origins per status, so the literal fixture shape is
`{"502": {"upstream": 1, "local": 1}}`. Only the flat `error_origins` is seeded to
all three keys. A UI that filters out zero counts is therefore defensive, not
load-bearing.

**E4. Each row exposes `error_origin`.**
A new top-level field on the serialized record, next to `result`:
`"upstream" | "local" | "unknown"` for failure rows, `null` for non-failure rows.
It is a projection of the row's own `error_category`; no new stored state.

**E5. New filter `error_origin=upstream|local|unknown`.**
Parsed and validated exactly like `error_status_code` (`observability.rs:274-278`):
an unrecognised value is a `400` with `invalid error_origin: <value>`. It combines
with `error_status_code` by AND.

**E6. Frontend: one row per (status, origin).**
`#errors-table` (`requests.html:193`) gains an **Origin** column, and its body is
built from `error_status_origins` so each pair is its own row:

```
Status code | Origin          | Errors
502         | upstream        | 4
502         | local           | 1695
```

Ordering: numeric status ascending, then `upstream` before `local` before
`unknown`. The click drilldown applies **both** `error_status_code` and
`error_origin`, and `loadErrors()` probes its sample detail per (status, origin)
pair so the example under "502 upstream" is an upstream row, not a local one.
Origin is rendered as a text badge, not colour-only, so it survives greyscale.

**E7. Scope guard.** Statistics and display only. No routing, selection, health,
error-chain, projection, persistence or runtime change. No new stored state, no
new endpoint, no new crate dependency. `row_status_code` keeps its current
behaviour for `error_status_codes`; origin is additive.

## Acceptance criteria

1. **Unit** — `row_error_origin` classifies `provider_http_502` → `upstream`;
   `provider_transport_error`, `provider_runtime_error`,
   `provider_response_header_timeout`, `http_502`, `body_too_large` → `local`;
   `None` → `unknown`; `provider_http_x` (non-numeric) → `local`.
2. **Facet** — a fixture with 1 `provider_http_502` and 1 `provider_transport_error`
   yields `error_status_codes["502"] == 2` (unchanged) **and**
   `error_status_origins["502"] == {upstream: 1, local: 1}` **and**
   `error_origins == {upstream: 1, local: 1, unknown: 0}`.
3. **Row** — the serialized row for an upstream failure reports
   `error_origin == "upstream"`, for a local failure `"local"`, and a success row
   reports `null`.
4. **Filter** — `error_origin=local` returns only local rows;
   `error_origin=upstream&error_status_code=502` returns only genuine upstream 502;
   `error_origin=bogus` → `400 invalid error_origin: bogus`.
5. **Cross-check on live data** — for every status `s`,
   `error_status_origins[s].upstream` equals the number of rows whose
   `error_category == "provider_http_s"`. On the observed sample this makes
   `502` report `upstream: 4`, not `1699`.
6. **Gates** — `verify:v3-cargo-fmt`, `verify:v3-file-size`,
   `verify:v3-module-boundaries`, `verify:webui-smoke` all pass; affected crate
   tests pass; live replay on the installed runtime shows the split.

## Implementation notes

- The backend unit tests live in `src/api/observability_tests.rs`, split out of
  `observability.rs` because that file crossed the 1500-line limit that
  `verify:v3-file-size` enforces. The new file is registered in
  `v3.admin_observability_aggregation`'s `owner_files` and `allowed_paths` in
  `docs/architecture/v3-function-map.yml`, because a source file with no declared
  owner violates the project's ownership invariant.
- The frontend fixed two pre-existing defects that this change exposed or that it
  would otherwise have tripped over: `mergeFacets()` merged only two levels and
  turned the nested `error_status_origins` bucket into `NaN` in multi-plan mode
  (now recurses one level), and the fourth column pushed the Errors tab table past
  a 390px viewport by widening `.requests-grid`'s single `1fr` column (fixed with a
  page-scoped `@media (max-width:1000px) { .requests-grid > * { min-width: 0 } }`).

## Out of scope

- Changing what `provider_status` means, or rewriting any error status.
- Splitting the `local` bucket further (operator chose a single `local` bucket;
  `error_categories` already breaks it down).
- The `error_count` / `provider_failure_count` stat cards.
- Any change to cooldown, routing, health or persistence.
