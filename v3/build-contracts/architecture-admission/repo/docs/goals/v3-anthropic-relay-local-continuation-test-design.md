# V3 Anthropic Relay Local Continuation Test Design

## Lifecycle under test

```text
Anthropic turn 1
  -> Req04 new
  -> Responses provider tool call
  -> Resp04 save immutable canonical response by tool_use id
  -> Anthropic tool_use projection
immutable store interval
Anthropic turn 2 tool_result
  -> Req04 restore under exact endpoint/session/conversation/port/group scope
  -> restored reasoning + function_call precede function_call_output
  -> terminal response
  -> Resp04 release
```

## Positive matrix

- JSON: first tool call saves one record; second tool result restores it, preserves reasoning/tool order in the provider request, and terminal success releases it.
- SSE: split provider events materialize one canonical response only at Resp04; the next JSON/SSE turn restores the same canonical order and releases on terminal completion.
- Non-terminal: `completed` plus a pending function call remains non-terminal and must save.

## Negative matrix

- Provider error before Resp04 does not save or release local truth.
- Endpoint, session, conversation, port, routing group, expiry, missing id, duplicate save, and direct/remote owner mismatch fail closed.
- Terminal success, terminal failure, and already-terminal outcomes do not save or revive local truth.
- Responses Direct/OpenAI Chat cannot construct an Anthropic Relay local scope or restore its record.
- Provider/client payloads contain no local owner, store key, scope, debug, or metadata control fields.

## Verification layers

- Whitebox: `local_continuation_contract_store` plus stateful Anthropic Runtime tests.
- Module blackbox: controlled two-turn JSON/SSE transport captures exact provider requests and response/error projection.
- Architecture blackbox: dedicated verifier and mutation fixtures lock the only save/restore owner and immutable interval.
- Project gates: V3 module/Rust-only, fmt, Clippy, full workspace, architecture docs/review, and browser-rendered wiki smoke.

## Completion boundary

Passing this design proves controlled Rust Runtime integration only. It does not prove live provider compatibility, install/restart, config mutation, or production cutover.
