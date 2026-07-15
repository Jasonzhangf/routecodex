# V3 Anthropic Relay Controlled-Upstream Replay Harness

## Scope

This gate prepares a controlled-upstream replay for:

~~~text
Anthropic client entry
  -> fixed Hub v1 Relay request nodes
  -> Responses provider wire
  -> controlled upstream
  -> fixed Hub v1 Relay response nodes
  -> Anthropic client projection
~~~

It owns only deterministic fixtures, a reusable external-driver harness, an evidence schema, and
positive/negative mutation gates. It does not wire Runtime, Server, Provider, P6, or live traffic.

## Driver contract

The harness starts a loopback controlled Responses upstream and invokes the executable named by
`V3_ANTHROPIC_RELAY_DRIVER` once per fixture:

~~~text
<driver> --fixture <case.json> --upstream-url <loopback /v1/responses URL>
~~~

The driver must execute the real Runtime integration path and print exactly one JSON object:

~~~json
{
  "client_response": {},
  "node_trace": ["V3HubReqInbound01ClientRaw", "...", "V3ServerRespOutbound06ClientFrame"]
}
~~~

The driver is not a fixture transformer. It must send its provider request to the supplied
controlled upstream. The harness compares the captured provider request, client projection, and
ordered node trace with fixture truth. A driver that skips the upstream or invents a trace fails.

## Scenario matrix

| Case | Transport | Required proof |
| --- | --- | --- |
| `json_thinking_tool_use` | JSON | Anthropic system/messages/thinking/tool_use enter Relay; Responses reasoning/function call reaches upstream; Anthropic thinking/tool_use returns to client |
| `sse_thinking_tool_use` | SSE | event ordering is preserved without full-stream semantic substitution |
| `provider_error` | JSON error | provider error remains an error and follows the fixed response/error boundary |
| `side_channel_isolation` | JSON | control/debug/resource fields enter neither provider wire nor client normal payload |

## Baseline red contract

Until an integration worker supplies a real driver, the harness must exit non-zero with
`V3_ANTHROPIC_RELAY_WIRING_MISSING` and enumerate the missing adjacent request/response edges. It
must also emit schema-valid evidence with `status=wiring_missing`. Missing wiring is not success,
skip, mock, or fallback.

## Determinism

- Manifest case IDs are sorted and unique.
- Every case is strict JSON and has a stable SHA-256 over canonical recursively sorted JSON.
- Fixture paths are repository-relative; evidence excludes random ports and timestamps from the
  deterministic digest.
- Required node IDs are the fixed contract IDs and must be an ordered subsequence of driver trace.

## Mutation matrix

- unsorted or duplicate manifest case IDs;
- missing JSON/SSE/provider-error/side-channel scenario;
- removed required adjacent node or wiring diagnostic;
- provider/client side-channel leak;
- harness accepting missing driver, skipping controlled upstream capture, or synthesizing a green
  result.

## Verification

~~~text
node scripts/architecture/verify-v3-anthropic-relay-controlled-replay-harness.mjs
node scripts/tests/v3-anthropic-relay-controlled-replay-harness-mutations.mjs
node scripts/tests/v3-anthropic-relay-controlled-replay-harness-red-fixtures.mjs
~~~

The first two commands must pass. The red-fixture command passes only when the real harness itself
fails with the exact missing-wiring diagnostic and emits schema-valid red evidence.

## Completion boundary

Passing these gates proves only that a deterministic, integration-ready controlled-upstream
harness exists and correctly remains red while Runtime is unwired. It does not prove live Relay,
Anthropic runtime integration, Server exposure, provider transport integration, P6 expansion,
global install, restart, or production replacement.
