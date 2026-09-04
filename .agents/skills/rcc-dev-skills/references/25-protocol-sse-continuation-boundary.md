# Protocol, SSE, Continuation Debug

## When

Use for protocol conversion, malformed/partial SSE, continuation replay, missing history, duplicated tool calls, or cache-prefix drift.

## Separate Three Questions

1. Protocol: did adjacent codec preserve every compatible semantic field and explicitly reject unsupported fields?
2. SSE: did transport preserve event boundaries, order, terminal/error frame, and client disconnect state?
3. Continuation: did Chat Process save finalized canonical response and restore it before current delta governance?

Do not use success in one question as evidence for another.

## Request Procedure

1. Query V3 resource/function/mainline/verification maps for source and target protocols.
2. Capture client input and final provider-bound payload.
3. Compare stable history prefix, current delta, tool call/result pairs, reasoning, media, model, and stream intent.
4. Locate first changed field and mapped adjacent codec owner.
5. Add positive compatible mapping and negative unsupported/malformed tests.

## Response Procedure

1. Capture complete raw provider JSON/SSE, including terminal or source error.
2. Replay through current response dry-run entry.
3. Check provider decode, canonical response, Resp03 governance, continuation save, client projection, then framing.
4. For SSE, require semantic terminal before EOF; provider failure must remain explicit through client terminal projection.

## Continuation Procedure

1. Capture provider-bound request N and N+1.
2. Prove persisted prefix is unchanged; N+1 may append only finalized assistant output and current incoming delta.
3. Reject partial prefix replay, completed call-id replay, orphan output, duplicate output, scope mismatch, or guessed repair.
4. Keep continuation state separate from routing, health, Stopless, debug, and client/provider payload.

## Verification

- Focused codec/stream/continuation positive and negative tests.
- Feature `required_gates` from V3 verification map.
- Complete request and response dry-runs.
- Installed same-entry JSON and SSE replay.
- Review confirms one adjacent codec and one continuation owner.
