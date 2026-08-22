# V3 Console Request Count Visibility Test Design

## Scope

`feature_id: v3.console_request_count_visibility` is the single registered
owner of the existing V3 request counter extension used by this feature: it
returns the persisted request id together with typed total and local-day counts,
then projects that same allocation through
`feature_id: v3.console_human_readable_layering`.

The existing counter file and semantics remain unchanged:

```text
~/.rcc/state/request-id-counter.json
totalCount
windowCount
windowKey = local date
```

No console code may parse the final `-{total}-{daily}` suffix from the long
request id.

## Lifecycle

1. The aggregate creates one `Arc<Mutex<V3RequestIdCounter>>` before building
   listeners; every listener clones that same handle.
2. `V3RequestIdCounter` loads the persisted state once under the aggregate lock.
3. One allocation atomically increments total and local-day counts.
4. The owner returns one typed allocation containing `request_id`,
   `total_count`, and `daily_count`.
5. Server request context retains that exact allocation for the whole request.
6. Human request and terminal response prefixes render one fixed-width count
   cell from the typed values, for example `[#669944/7581]`.
7. The complete long request id remains only in the dim diagnostic line as
   `req=...`.

## Positive Tests

- First controlled request returns counts `1/1`; the second returns `2/2`.
- A local-date transition keeps total monotonic and resets daily to `1`.
- Restart reloads total and current local-day counts from the same persisted
  file.
- One request start and its terminal response show the same
  `[#total/daily]`.
- Exactly one routed request block is emitted; no pre-route block may publish
  placeholder route/model values.
- The request count cell has a stable display width and remains in the same
  human color as port, project, route, and model.
- Direct and Relay JSON/SSE terminal blocks preserve the same allocated counts.
- Concurrent requests on 10000, 5520, and 5555 serialize through the same
  aggregate counter handle and publish unique monotonic identities.

## Negative Tests

- Runtime code contains no `rsplit`, regex, or substring parsing of request id
  count suffixes.
- Console does not read the counter file or lock the counter after allocation.
- No second atomic, in-memory, log-derived, or statistics-derived request
  counter is created.
- Listener construction cannot allocate one counter/lock per port. Otherwise
  simultaneous listeners race on the same PID-scoped temp file and one request
  fails with `failed to publish ... No such file or directory`.
- Provider retries and switches do not increment request count.
- Request start and response completion cannot receive different count values
  under concurrent requests.
- A pre-route `received` console block cannot duplicate the routed request
  block or expose `route=-` / `target=-` as human truth.
- Counter state never enters provider or client normal payloads.
- Daily reset uses the existing local date key, not UTC.

## Verification

- Focused `V3RequestIdCounter` allocation tests.
- Concurrent request identity blackbox.
- Existing managed lifecycle persistence/restart tests.
- Focused console fixed-column/color/plain tests.
- Resource/function/mainline/manifest/verification map gates.
- Managed V3 restart and two real 5555 requests proving monotonic
  `[#total/daily]` in both request and response blocks.
- Mandatory Codex review with unambiguous `VERDICT: PASS`.
