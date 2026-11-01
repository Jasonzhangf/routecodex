# Magpie live mock matrix corpus inventory

Status: corpus definition complete; live baseline results are owned by the E4
runner report. This document distinguishes fixture definition from proof.

## Identity

- Worktree: `/Volumes/Intel/playground/routecodex/magpie-live-matrix-20261012`
- Corpus: `v3/fixtures/protocol-live-mock-matrix/`
- Manifest: `v3/fixtures/protocol-live-mock-matrix/manifest.json`
- Source repo: `https://github.com/yetone/magpie`
- Source SHA: `bfaedf18301d02a423bd5422d22e41432d231ab8`
- License/notice: `v3/fixtures/protocol-live-mock-matrix/LICENSE.magpie`
- Runner interface: `/Volumes/Intel/playground/routecodex/.worker-runs/magpie-live-matrix-20261012-0435/runner/interface.md`

## Matrix coverage

All sixteen entry x provider cells have JSON and SSE variants except the
explicit same-protocol Relay supplemental, which is JSON:

| Entry \ Provider | openai_chat | responses | anthropic | gemini |
| --- | --- | --- | --- | --- |
| openai_chat | Direct JSON/SSE; Relay JSON | Relay JSON/SSE | Relay JSON/SSE | Relay JSON/SSE |
| responses | Relay JSON/SSE | Direct JSON/SSE | Relay JSON/SSE | Relay JSON/SSE |
| anthropic | Relay JSON/SSE | Relay JSON/SSE | Direct JSON/SSE | Relay JSON/SSE |
| gemini | Relay JSON/SSE | Relay JSON/SSE | Relay JSON/SSE | Direct JSON/SSE |

Cell count: 16 cells, 32 JSON/SSE cases, plus one explicit same-protocol Relay
supplemental case.

Fixed counts across all 48 case files:

- Transport: 27 JSON, 21 SSE.
- Execution mode: 14 Direct, 34 Relay.
- Boundary and supplemental extension cases beyond the 32 base variants: 16.
- Multi-turn cases: 2 (`tool-followup-responses-to-chat`,
  `namespace-custom-complete-args`), each with exactly 2 turns.
- Scripted multi-attempt cases: 1 (`provider-fault-stream-cut`, 2 attempts).
- Cases declaring runner setup metadata: 2 (`provider-error-exhaustion`,
  `provider-fault-stream-cut`).

## Boundary coverage

| Group | Cases | Failure mode bound |
| --- | --- | --- |
| A tool/namespace | `tool-followup-responses-to-chat`, `namespace-custom-complete-args` | Tool identity, namespace, complete arguments, call/output pairing, no synthesized result and no implicit permission. |
| B media | `media-gemini-function-response-image`, `media-gemini-function-response-file`, `media-anthropic-older-turn-tool-image` | Native media bytes, MIME and position preserved; no description substitution or silent deletion. |
| C reasoning | `reasoning-signature-anthropic-to-gemini`, `reasoning-provided-signature-not-invented` | Provided signatures preserved; missing signatures not guessed; no signature tunneling. |
| D usage/terminal | `usage-cache-writes-chat-entry`, `usage-missing-or-null-preserved`, `terminal-content-filter`, `terminal-length` | Cache writes counted once; null versus zero preserved; legal terminal values forwarded, not reclassified as provider errors. |
| E error/fault | `provider-error-exhaustion`, `provider-fault-stream-cut` | Provider error stays internal; exhaustion closes without client error/success; transport cut recovery stays internal. |
| F field boundary | `unregistered-request-field-continuation`, `unregistered-response-field-preserved` | Unregistered request field excluded from provider wire with continuation; representable response field retained. |

## Source mapping

| Magpie source | Adapted cases |
| --- | --- |
| `internal/gateway/testdata/upstream_bodies/chat.json` | chat Direct, explicit Relay |
| `internal/gateway/testdata/upstream_bodies/responses.json` | responses Direct |
| `internal/gateway/testdata/upstream_bodies/anthropic.json` | anthropic Direct |
| `internal/gateway/testdata/upstream_bodies/chat-to-anthropic.json` | chat -> anthropic |
| `internal/gateway/testdata/upstream_bodies/responses-to-chat.json` | responses -> chat |
| `internal/gateway/testdata/upstream_bodies/anthropic-to-responses.json` | anthropic -> responses |
| `internal/gateway/namespace_test.go` | `namespace-custom-complete-args` |
| `internal/gateway/codex_custom_tools_test.go` | `namespace-custom-complete-args` |
| `internal/gateway/translate_stream_test.go` | several base SSE cells, usage/terminal variants |
| `internal/gateway/namespace_search_test.go` | `tool-followup-responses-to-chat` |
| `internal/gateway/gemini_function_parts_test.go` | Gemini entry cells, `media-gemini-function-response-image`, `media-gemini-function-response-file` |
| `internal/gateway/tool_images_test.go` | `media-anthropic-older-turn-tool-image` |
| `internal/gateway/gemini_signature_test.go` | `reasoning-signature-anthropic-to-gemini`, `reasoning-provided-signature-not-invented` |
| `internal/gateway/claude_chat_usage_test.go` | `usage-cache-writes-chat-entry` |
| `internal/gateway/retried_usage_test.go` | provider fault/error recovery evidence source |
| `internal/gateway/stream_error_open_test.go` | `provider-error-exhaustion` |
| `internal/gateway/stream_cut_test.go` | `provider-fault-stream-cut` |
| `internal/gateway/optional_fields_test.go` | `unregistered-request-field-continuation` |

## Contract differences recorded

- Provider exhaustion: Magpie can surface a provider/client error; RCC v6 closes
  the client connection without an error payload or status.
- Optional-field removal: Magpie may remove a refused field and retry; RCC v6
  drops unregistered request fields with a local warning and continues.
- Signature handling: RCC v6 does not tunnel signatures in IDs, does not guess a
  missing signature, and does not insert empty reasoning.
- Media: RCC v6 preserves representable media; it does not replace it with a
  model-generated description.
- Tool results: RCC v6 does not synthesize tool results or grant undeclared
  executor permissions.
- Retry ownership: Magpie retries the cut before content; RCC v6 recovery uses a
  declared alternative candidate identity and does not perform implicit
  same-candidate retry.

## Current gaps

- Tool/media/reasoning/usage boundary cases are bound to representative cells
  rather than every provider protocol. The base matrix is the 16-cell
  cross-product; boundary breadth is intentionally narrower.
- `provider-error-exhaustion` declares `runtime_setup` for candidate identity
  `mock-chat/mock.unavailable-model` (`model` `mock.unavailable-model`,
  `wire_model` `unavailable-model`). The declaration is complete and outside
  business payload. Live replay must prove the resolved provider body model is
  `unavailable-model`, the mock 429 is reached, and `transport = "closed"`
  remains empty rather than a model-selection failure.
- `provider-fault-stream-cut` now declares two same-tier provider candidates,
  `mock-chat-a/mock.chat-model` and `mock-chat-b/mock.chat-model`, plus the two
  allowed literal auth orders. The original single-candidate setup made the
  initial recovery mismatch a configuration precondition failure, not an
  operator bug. Live replay must prove both provider attempts and the recovered
  response before the case can pass.
- `protocol-semantics.mjs` and `tool-consumer.mjs` now exist. The observer
  `call_id` duplicate bug is fixed; the original tool-followup red result was a
  harness observation defect, not proof of a product tool failure. Live
  execution and client-side handling still require separate proof.
- The Gemini client streaming case uses `:streamGenerateContent`, a protocol
  feature beyond the currently bound `:generateContent` endpoint declaration;
  the runner must record whether the entry accepts it or classify it as an
  explicit coverage gap.
- The original `installed-baseline-20261012` report remains the raw initial
  48-case baseline: 12 passed and 36 failed/mismatch. Do not reinterpret those
  36 mismatches as 36 confirmed operator bugs; the fault-case mismatch above is
  one known invalid recovery setup.
- No live result is claimed in this document. Provider captures, client
  captures, attempt counts and pass/fail classifications are written by the E4
  runner report.
