# Full-Pipeline Errorsample Payload Copy Budget Test Design

## Lifecycle

1. An error/debug owner borrows a live observation only long enough to decide whether an errorsample is eligible.
2. The errorsample writer applies sensitive-field and embedded-secret redaction during JSON serialization.
3. Normal errorsample mode creates one compact serialized string and derives an internal truncation envelope only when that string exceeds the configured sample budget.
4. Full snapshot mode creates one explicitly enabled pretty serialized string.
5. The bounded queue owns only the final serialized diagnostic string and releases it after write, drop, reset, or failure.

## White-Box Positive Cases

- Existing sensitive keys, bearer tokens, API keys, passwords, cookies, depth bounds, and circular references retain their redacted output.
- Normal mode serializes the original observation directly through the redaction replacer without first constructing a complete redacted object graph.
- Normal mode does not retain simultaneous pretty and compact full-payload strings.
- Full snapshot mode remains explicit and preserves complete non-secret diagnostic semantics.
- Queue item count, queue byte budget, file count, group byte budget, and prune interval remain enforced.

## White-Box Negative Cases

- `writeErrorsampleJson` must not call `redactSensitiveData` to deep-clone the complete observation before serialization.
- Normal serialization must not execute both pretty and compact full-payload `JSON.stringify` operations.
- A circular or unserializable diagnostic payload must not become an uncaught request-path error.
- Debug truncation must never feed back into provider/client payloads or ErrorErr client projection.

## Module Black-Box

- Existing errorsample writer tests continue to cover truncation, full snapshot mode, redaction, transient suppression, queue count/byte budgets, and file retention.
- Focused source gates reject intermediate deep redaction objects and duplicate full serialized strings.
- Sensitive-redaction tests prove object and direct-string serialization produce equivalent parsed diagnostic semantics.

## Project Black-Box

- Error routing, provider retry/reroute, client status/body projection, and live request/response payloads remain unchanged.
- The errorsample resource remains a debug side channel and cannot become ErrorErr or normal payload truth.
- TypeScript and base builds remain green.

## Known Gap

This slice removes avoidable TS errorsample deep cloning and duplicate serialized strings. Callers that construct observations containing several references to complete provider/request/response bodies remain separately tracked in the hotspot inventory until their lazy projection and retention contracts are closed.
