# V3 Console Request Count Visibility Test Design

## Scope

`feature_id: v3.console_request_count_visibility` is the single registered
owner of the V3 request counter extension used by this feature. One allocation
reserves a unique request identity plus the predicted total and local-day
counts for display; only a confirmed success terminal commits those counts.
The same allocation is projected through
`feature_id: v3.console_human_readable_layering`.

The request number counts delivered normal responses only. Every error terminal
is excluded: admission rejection, error frames, provider exhaustion with a
broken client transport, mid-stream SSE failure, and client disconnect.

## Persisted state (version 2)

```text
~/.rcc/state/request-id-counter.json
version = 2
totalCount   successful responses, monotonic across restarts
windowCount  successful responses in the current local day
windowKey    local date, YYYYMMDD
sequence     monotonic allocation number, +1 for every request including errors
```

A version 1 file stays readable. Its `totalCount`, `windowCount`, and
`windowKey` are adopted as the historical success baseline, and `sequence`
starts at `max(totalCount, windowCount)` so a new request id cannot collide
with an older sample. Rolling to a new local day resets `windowCount` and never
rewinds `sequence`.

No console code may parse total or daily counts out of the long request id.

## Lifecycle

1. The aggregate creates one `Arc<Mutex<V3RequestIdCounter>>` before building
   listeners; every listener clones that same handle.
2. `V3RequestIdCounter` loads the persisted version 1 or version 2 state once
   under the aggregate lock.
3. One allocation increments only `sequence`, persists, and returns one typed
   allocation containing `request_id`, `pipeline_id`, and the predicted
   `total_count = totalCount + 1` / `daily_count = windowCount + 1`.
4. The request id is `{entry}-{provider}-{model}-{localTs}-{sequence}`, so it
   stays unique for every request, including error requests and restarts.
5. Server request context retains that exact allocation for the whole request.
6. When the request reaches a success terminal, the allocation claims one
   idempotent commit that increments `totalCount` and `windowCount` and
   persists them. A second claim for the same allocation is a no-op.
7. Human request and terminal response prefixes render one fixed-width count
   cell from the typed values, for example `[#669944/7581]`; a success shows the
   same number in both blocks because the predicted value equals the committed
   value.
8. The complete long request id remains only in the dim diagnostic line as
   `req=...`; error lines never render a count cell.

## Success terminal (commit) definition

Commit reuses the existing success judgment
`should_emit_v3_request_complete_console_line`: `status < 400` and
`response_status` is neither `error` nor `failed`. `content_filter` and
`incomplete` remain successful business terminals and count. A Relay or Direct
SSE stream counts only on normal completion; a dropped stream, a client
disconnect, or a failure branch never counts. Commit is independent of
`console_enabled`, so a disabled console still counts.

## Positive Tests

- A first successful request commits `1/1`; a second successful request shows
  `2/2` and commits `2/2`.
- A local-date transition keeps total monotonic and resets daily to `1`.
- Restart reloads `totalCount` and the current local-day `windowCount` from the
  same persisted file and continues from the next sequence.
- A version 1 file is adopted as the success baseline with `sequence` above it.
- Two allocations in a row return the same predicted success counts but two
  distinct request ids (`-1`, `-2`).
- One request start and its successful terminal response show the same
  `[#total/daily]`.
- Exactly one routed request block is emitted; no pre-route block may publish
  placeholder route/model values.
- The request count cell has a stable display width and remains in the same
  human color as port, project, route, and model.
- Direct and Relay JSON/SSE successful terminals preserve the same allocated
  counts.
- Concurrent requests on 10000, 5520, and 5555 serialize through the same
  aggregate counter handle and publish unique monotonic identities.
- `console_enabled = false` still commits the success count.

## Negative Tests

- An error terminal never increments `totalCount` or `windowCount`: malformed
  JSON admission, a disabled endpoint, an error frame, provider exhaustion with
  a broken client transport, SSE failure, and client disconnect.
- Provider retries, provider switches, continuation frames, and a repeated
  completion never commit the same request twice.
- Runtime code contains no `rsplit`, regex, or substring parsing of request id
  count suffixes; console never reads the counter file or locks the counter
  after allocation.
- No second atomic, in-memory, log-derived, or statistics-derived request
  counter is created.
- Listener construction cannot allocate one counter/lock per port. Otherwise
  simultaneous listeners race on the same PID-scoped temp file and one request
  fails with `failed to publish ... No such file or directory`.
- Request start and response completion cannot receive different count values
  under concurrent requests.
- A pre-route `received` console block cannot duplicate the routed request
  block or expose `route=-` / `target=-` as human truth.
- Counter state never enters provider or client normal payloads.
- Daily reset uses the existing local date key, not UTC.

## Verification

- Focused `V3RequestIdCounter` allocation, success-commit, idempotency, v1
  migration, and local-day roll tests.
- Public-entry blackbox
  `request_count_success_only_public`: real HTTP entry plus
  `ROUTECODEX_REQUEST_ID_COUNTER_FILE`, proving a success request commits `1/1`,
  an error terminal leaves the counts unchanged while still consuming a
  sequence, and a restart reloads the persisted counts and continues to `2/2`.
- Concurrent request identity blackbox.
- Existing managed lifecycle persistence/restart tests.
- Focused console fixed-column/color/plain tests.
- Resource/function/mainline/manifest/verification map gates.
- Managed V3 restart and two real 5555 requests proving monotonic
  `[#total/daily]` in both request and response blocks, and one error request
  proving the count does not move.
- Mandatory Codex review with unambiguous `VERDICT: PASS`.
