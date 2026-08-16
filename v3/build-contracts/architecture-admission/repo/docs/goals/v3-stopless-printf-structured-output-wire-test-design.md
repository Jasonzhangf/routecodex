# V3 Stopless printf and structured output wire test design

## Scope

This change closes two independent Rust-owned contracts:

1. `v3.stopless_client_printf_projection`: a non-terminal Stopless response keeps the provider's assistant text and adds one client-executed `exec_command`. Its `printf` body is the StoplessCenter continuation guidance that will be sent to the model; internal config controls full versus short display, and full display is the default.
2. `v3.protocol_structured_output_strict_wire_parity`: Responses `text.format` and custom-tool `strict` reach the target provider wire shape without capability guessing or silent field loss.

Direct/GPT Stopless enablement is not changed. Internal reentry/followup is explicitly out of scope.

## Lifecycle and owners

```text
HubRespChatProcess03Governed
  -> servertool-core client projection owner
  -> assistant content + exec_command(printf)
  -> client executes printf
  -> next Responses tool output remains client-owned history
  -> ReqChatProcess reads it only with active scoped StoplessCenter state

Responses request text.format
  -> ProviderReqOutbound codec owner
  -> OpenAI Chat response_format OR Anthropic output_config.format
  -> provider transport
```

- Stopless projection owner: `servertool-core/src/cli_contract.rs`; the NAPI bridge consumes the canonical projection and must not restamp a second command.
- OpenAI Chat conversion owner: `hub_v1/responses_openai_codec.rs`.
- Anthropic conversion owner: `hub_v1/anthropic_codec.rs`.
- Virtual Router, MetadataCenter, SSE framing, and provider capability selection do not own these wire conversions.

## White-box tests

Positive:

- Stopless command uses `printf` with the exact state-machine continuation guidance, shell-quoted as one argument.
- Default config prints the full guidance; explicit short-display config prints only `继续执行`.
- Assistant content remains a sibling of the added `exec_command` call.
- Plain `继续执行` tool output can reuse only existing scoped StoplessCenter state.
- Responses `text.format.type=json_schema` maps to OpenAI Chat `response_format.json_schema`.
- Responses `text.format.type=json_schema` maps to Anthropic `output_config.format`.
- Flat and wrapped custom tools preserve `strict` at the protocol-defined location.

Negative:

- Client projection contains no `routecodex hook run`, session/request identity flag, schema feedback, or repeat counter in the shell command; only the model-facing continuation guidance is printable.
- Plain continuation text without active scoped StoplessCenter state cannot reconstruct private continuation state.
- Malformed `text`, `text.format`, schema, or `strict` types fail explicitly.
- Anthropic rejects an OpenAI `strict:false` structured format because Anthropic's constrained format cannot represent non-strict semantics.
- No provider/model-name capability inference is added.

## Module black-box tests

- Run focused `router-hotpath-napi` Stopless projection and request-governance tests.
- Run V3 OpenAI Chat provider-wire field parity tests.
- Run V3 Anthropic codec characterization and relay provider-wire tests.
- Run the existing protocol conversion field parity gate and red fixtures.

## Project black-box and live replay

- Build and globally install V3, then restart the aggregate instance once through `routecodex restart --port 5520`.
- Verify `/health` on `10000`, `5520`, and `5555`.
- Replay a real 5520 Stopless request and verify the client-visible SSE contains the original assistant text plus `exec_command(printf)`.
- Run provider-request dry-runs for cc-sol/OpenAI Chat/Anthropic targets and inspect the captured provider body.
- Real provider probes remain capability evidence only; configuration enablement is a separate decision.

## Known gaps

- A provider may advertise a field but ignore constrained decoding. RouteCodex still validates its own canonical stop schema locally.
- `printf` output is client-owned history. RouteCodex does not claim it can delete client history.
- Anthropic official documentation was unreachable from this host, so wire shape was cross-checked against the generated official Anthropic Python and TypeScript SDK types (`output_config.format`, `JSONOutputFormatParam`, and `ToolParam.strict`).

## RCC text-control experiment

Live endpoint: `http://127.0.0.1:5520/v1/responses`.

The probe required an exact `<|RCC|>{...}</|RCC|>` block in both natural-stop text and strict function-tool arguments for four configured protocol/model targets.

| Target | Natural stop | Forced tool call |
| --- | --- | --- |
| `glmrelay_openai.glm-5.2` | exact block, `finish_reason=stop` | exact block in arguments, `finish_reason=tool_calls` |
| `glmrelay_anthropic.glm-5.2` | exact block, `finish_reason=end_turn` | exact block in arguments, `finish_reason=tool_calls` |
| `minimax_openai.MiniMax-M3` | failed: first hit `length`; larger budget ended with `stop` but refused the exact block | exact block in arguments, `finish_reason=tool_calls` |
| `minimax_anthropic.MiniMax-M3` | exact block, `finish_reason=end_turn` | exact block in arguments, `finish_reason=tool_calls` |

Conclusion: strict tool arguments reproduced the control block 4/4. Natural-stop text reproduced it 3/4 and is sensitive to model safety interpretation and reasoning budget. RCC text delimiters are therefore useful as best-effort evidence framing only; they are not a semantic fallback for protocol Structured Output or strict tool schemas.
