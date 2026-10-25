# Continuation Prefix Compliance

## When

Use when history placeholders, protocol conversion, reasoning/tool projection, or continuation changes cause cache miss or transcript drift.

## Contract

For the same continuation scope and provider rendering, request N+1 preserves request N's rendered prefix, then appends finalized assistant output and the current turn. A mismatch is evidence for the save/restore or codec owner to investigate and repair; it does not authorize a new runtime rejection of forwardable traffic. Preserve protocol meaning and paired history under the project transparent-proxy contract.

## Procedure

1. Capture final provider-bound payload for N and N+1 from same installed runtime/session/provider.
2. Render both with actual provider codec; do not compare client payload or debug summary.
3. Find first byte/token mismatch before N frontier.
4. Map mismatch to continuation save/restore or adjacent codec owner.
5. Add positive stable-prefix and negative mismatch tests.
6. Replay with provider cache telemetry only after installed same-entry proof.

## Boundaries

- Do not change usage display, cache policy, provider transport, or logger to hide a transcript mismatch.
- Do not rewrite prior user/assistant/tool items to improve cache rate.
- Do not infer compliance from cache-hit percentage alone; provider may not expose cache telemetry.
- Control state, route/model override, and debug data never enter persisted provider transcript.

## Evidence

Record request ids, provider/model/protocol, rendered prefix comparison, first mismatch, owner, red/green tests, installed version, and live cache signal when available.
