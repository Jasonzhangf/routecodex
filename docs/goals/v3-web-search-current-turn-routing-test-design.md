# V3 Web Search Current-Turn Capability Test Design

## Bug

V3 request-fact extraction currently marks `web_search` whenever the request declares the OpenAI
Responses built-in tool type `web_search` or `web_search_preview`. Codex declares that tool on every
request, so unrelated coding/tool continuations are repeatedly routed to the configured
`web_search` pool. Live request `653120-7637` proves this: the declared tool set contained
`type=web_search`, the active user turn was `检查为何现在 github 非常慢？`, and 5555 still selected
`web_search -> cc-sol.gpt-5.6-sol`.

## Contract

`v3.route.request_facts.capabilities` may contain target capability `web_search` only from active-turn
semantics; `web_search` must never become the VR primary route/pool reason:

1. A fresh newest user message contains explicit web-search intent.
2. A tool-output continuation follows an actual assistant web-search tool call in that same active
   turn.

Declared tools are provider/client tool inventory only and contribute zero route or target capability signal. This includes every
tool declaration spelling and shape: `web_search`, `web_search_preview`, `websearch`, function
names, tool types, descriptions, and schemas.

Only the newest active-turn user message is inspected. Older user messages, instructions,
developer text, tool declarations, assistant output, reasoning, and tool output cannot supply
keyword intent. A tool-output continuation adds required target capability `web_search` only when that active turn contains
an actual assistant Web Search call; the route remains a normal route such as `tools`.

## Lifecycle Tests

Positive:

- Current user `上网搜索最新资料` emits route `thinking` plus required capability `web_search`, with or without any declared web-search tool.
- Current user `search the web for the current status` emits route `thinking` plus required capability `web_search`, with or without any declared web-search tool.
- A tool-output continuation after an actual assistant web-search call emits route `tools` plus required capability `web_search`.

Negative:

- Any web-search declaration without current-turn search semantics does not emit route or capability `web_search`.
- Removing all web-search declarations does not suppress required capability `web_search` for a fresh explicit web-search request.
- Historical user search text followed by a newer non-search user message does not emit capability `web_search`.
- Search words in developer instructions, assistant/tool outputs, and tool descriptions do not emit capability `web_search`.
- Live sample `662023-8758` emits route `coding`, not route `web_search`, because its active turn ends with an actual `custom_tool_call`/`custom_tool_call_output` pair for `apply_patch`.

## Verification

- Red then green focused `routecodex-v3-runtime` `nodes` tests.
- V3 Runtime and Virtual Router focused suites.
- `npm run verify:v3-rust-only` and scoped formatting/diff checks.
- Global V3 install, `rccv3 config check`, one aggregate restart, then replay the exact old 5520
  sample and prove the route/pool reason is not `web_search`.

## Boundaries

- Owner: shared Rust active-turn classifier, consumed by V2 and
  `v3/crates/routecodex-v3-runtime/src/nodes.rs`.
- Virtual Router still consumes typed facts only and does not inspect payloads.
- Provider capability declarations, provider wire tools, Target filtering, and live route config remain separated from VR route selection.
- No fallback or payload mutation is introduced.
