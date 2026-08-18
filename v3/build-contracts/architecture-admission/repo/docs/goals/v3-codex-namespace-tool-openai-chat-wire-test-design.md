# V3 Codex Namespace Tool To OpenAI Chat Wire Test Design

Feature owner: `v3.protocol_conversion_field_parity`

Shared source owner: `sharedmodule/llmswitch-core/rust-core/crates/provider-compat-core/src/namespace_tools.rs`

Runtime callers:

- V2: `normalize_provider_outbound_tool`
- V3: `normalize_openai_chat_messages_payload`

## Lifecycle And Node Contract

```text
Codex Responses client $.tools
  -> V3HubReqInbound02Normalized (namespace container preserved as client semantics)
  -> V3HubReqChatProcess04Governed
  -> V3HubReqOutbound07ProviderSemantic
  -> ProviderReqCompat06ProviderCompat
  -> build_v3_openai_chat_standard_request_from_chat_canonical
  -> V3ProviderReqOutbound08WirePayload (function tools only)
  -> OpenAI Chat upstream
```

Node: `ProviderReqCompat06ProviderCompat -> V3ProviderReqOutbound08WirePayload`

- Input: Codex Responses tool declarations, including `type=namespace` containers whose `tools[]`
  children are ordinary function declarations.
- Output: OpenAI Chat `tools[]` containing one `type=function` item per namespace child, preserving
  child name, description, parameters, and strictness.
- Normal: ordinary function/custom/tool_search/web_search mappings remain unchanged and retain
  order; namespace children replace the container in child order.
- Error: malformed namespace children remain explicit invalid input; nested `function` must be an
  object, `description` must be a string, `parameters` must be an object, and `strict` must be a
  boolean. Invalid children must not be silently dropped or sent as provider-valid-looking functions.
- Unexpected: no `type=namespace` may cross `V3ProviderReqOutbound08WirePayload`; no sibling or
  nested tool surface may be invented.
- Provider blackbox: the final provider request contains only target-valid OpenAI Chat tool types.

## Paired Tests

Positive:

- A namespace with two valid function children becomes two OpenAI Chat function tools.
- Child schema and strictness survive conversion.
- An ordinary function before/after the namespace remains present and ordered.

Negative:

- The provider-wire array contains no `type=namespace`.
- The namespace aggregate name itself is not emitted as a callable function.
- A malformed namespace child fails explicitly instead of being dropped or passed through.
- Invalid nested `function`, `description`, `parameters`, and `strict` types fail in the shared helper
  and propagate through both the V2 and V3 provider-wire callers.

## Runtime Replay

- `npm run test:v3-responses-continuation-namespace-contract` is required by both `build:v3-cli`
  and CI so V2/V3 shared-helper drift and Resp04 status-only regressions cannot merge as manual-only gates.

- Replay the captured 5520 request shape from
  `openai-responses-router-gpt-5.5-20260728T090459120-654392-1127` through provider-request dry-run.
- Assert attempts targeting OpenAI Chat contain only `function`/provider-supported builtin tool
  types and no `namespace` container.
- Live replay the same Codex prompt after managed install/restart and verify the upstream no longer
  returns `field Tools[8].Type invalid, should be one of: function, custom`.
