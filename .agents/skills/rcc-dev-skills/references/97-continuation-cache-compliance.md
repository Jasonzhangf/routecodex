# Continuation Prefix Compliance

## When

Use when history placeholders, protocol conversion, reasoning/tool projection, or continuation changes cause cache miss or transcript drift.

## Contract

Provider-bound request N+1 must preserve request N rendered prefix byte-for-byte or token-for-token, then append finalized assistant output and current turn. Any transformation inside persisted prefix requires round-trip equivalence; otherwise reject at owning adjacent codec.

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
- Control state, route/model override, Stopless state, and debug data never enter persisted provider transcript.

## Evidence

Record request ids, provider/model/protocol, rendered prefix comparison, first mismatch, owner, red/green tests, installed version, and live cache signal when available.
