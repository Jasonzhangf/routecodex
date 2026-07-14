# Full-Pipeline Contract Observation Payload Copy Budget Test Design

## Lifecycle

1. Request Executor detects a provider request or provider response contract violation.
2. Live ErrorErr handling and forced provider snapshot persistence keep their existing full semantic inputs.
3. The payload-contract errorsample path converts the observation to a bounded diagnostic summary before JSON serialization.
4. The errorsample writer receives only the summary plus marker/reason/request identifiers.
5. No summarized observation may feed back into provider payloads, client responses, retry policy, or ErrorErr projection.

## White-Box Positive Cases

- Provider request and response observations keep status, header names, object keys, array lengths, and selected small scalar identifiers.
- Oversized strings are represented by length and preview metadata only.
- Circular references terminate without throwing.
- Existing errorsample writer queue, pruning, and redaction behavior remains unchanged.

## White-Box Negative Cases

- `queueRequestExecutorPayloadContractErrorsample` must not pass `args.observation` directly into the errorsample payload.
- Contract observation summaries must not contain complete provider request bodies, normalized response bodies, or converted response bodies.
- Snapshot persistence must not be changed by this budget; it remains a separate explicit diagnostic write path.

## Module Black-Box

- Existing response contract tests still reroute or report host response contract failures through the provider error chain.
- Focused source tests reject direct full-observation passthrough into `writeErrorsampleJson`.
- Unit tests prove large observations serialize without embedding full large strings.

## Known Gap

This slice budgets payload-contract errorsamples only. Forced provider contract snapshots and enabled snapshot recorder native crossings remain tracked separately in `docs/design/payload-copy-hotspot-inventory.md`.
