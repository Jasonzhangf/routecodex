# Responses / Chat SSE typed-tree test design

## Lifecycle under test

```text
provider JSON/SSE
 -> independent SSE object
 -> Responses or Chat typed tree
 -> normalized object
 -> typed hook notification/rewrite
 -> Hub response projection
 -> client JSON or SSE
```

Direct and Relay are separate black-box paths but share the transport-object
boundary. Gemini and Anthropic are excluded.

## Red/green gates

The first red tests must prove that a malformed frame, unknown Responses item,
identity-changing rewrite, and metadata/control leakage are rejected. Green
implementation must preserve the failure owner and must not add a fallback or
silent strip.

## Transport white-box tests

- single-line and multiline `data`, named `event`, comments, empty-line flush;
- arbitrary chunk splitting, UTF-8 failure, incomplete frame, size/buffer
  limits, EOF, malformed field, and `[DONE]`;
- object normalization and JSON/SSE re-encoding round trip;
- every decoder/finish error exports Error01 source data.

## Protocol tree tests

Responses covers root/container identity/status/model/usage/error, every
registered output item subtype, item identity/output index, content-part and
delta/done events, reasoning/message/refusal/function/custom-tool fields,
interleaved items, terminal events, extensions, and same-protocol round trip.
The tree itself must not retain a full normalized input `Value`; only typed
fields and explicit extension fields may participate in reconstruction.

Chat covers envelope identity/model/created/fingerprint, multiple choices,
choice index, role/content/reasoning/refusal, tool-call index/function name/
arguments delta, finish reason, usage, terminal state, extensions, order, and
same-protocol round trip.

Each protocol has positive, negative, non-terminal, already-terminal,
malformed, extension-preservation, and projection-parity cases.

## Hook tests

- notification receives transport, protocol, and semantic types;
- typed text/reasoning/refusal/arguments rewrite reprojects to valid JSON/SSE;
- reverse tests prove rewrite cannot change identity, item/choice type, index,
  terminal state, event framing, or control fields;
- no hook output contains MetadataCenter state and no business object can
  reconstruct it.

## Direct/Relay module black-box tests

Direct success, non-terminal, terminal, malformed, provider transport error,
historical compatibility rewrites, JSON projection, SSE projection, and
`[DONE]` ordering are required. Relay has the same cases plus normalized Hub
response processing, provider error classification, and client JSON/SSE mode
selection. Both tests assert that no second raw parser is invoked.

## Project gates

Required before runtime delivery:

- targeted crate/runtime tests from the verification map;
- full feature and workspace Rust tests;
- resource/function/mainline/module/verification architecture gates;
- Rust format/build/clippy gates as configured;
- `git diff --check`;
- global install, aggregate `routecodex restart`, all listener health checks;
- same-entry online old/real sample replay;
- DSH Review only after all preceding evidence.
