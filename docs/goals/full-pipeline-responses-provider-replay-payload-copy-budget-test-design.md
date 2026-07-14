# Responses Provider Replay Payload Copy Budget Test Design

## Scope

`feature_id: debug.responses_provider_replay_payload_copy_budget` owns only `scripts/tools/responses-provider-replay.mjs`, a debug-only provider replay script.

## Lifecycle

The script loads a captured sample, derives a Chat-shaped replay request, optionally replaces system messages, defaults the model, converts the request to Responses format, and sends it to a provider runtime when explicitly executed as a CLI.

## Positive Cases

- Chat payload replay creates one shallow top-level owner before mutating `model`.
- Nested `messages`, `tools`, metadata, and extension objects stay borrowed until normal JSON/native/provider boundaries.
- System prompt replacement creates a new top-level chat object and a new `messages` array while preserving unaffected message object references.
- Importing the script for tests does not execute provider IO.

## Negative Cases

- The replay script must not use `JSON.parse(JSON.stringify(...))`, `deepClone`, or clone helpers for captured chat payload preparation.
- The debug replay projection must not become live provider/client payload truth, route selection truth, MetadataCenter state, or provider configuration.
- This slice must not remove the separate provider harness mutation-isolation copy in `src/debug/harness/provider.ts`.

## Required Gates

- `npm run jest:run -- --runTestsByPath tests/scripts/responses-provider-replay-payload-copy-budget.spec.ts --runInBand`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npx tsc --noEmit --pretty false --skipLibCheck`

## Completion Boundary

This is source/test evidence for a debug script copy cleanup only. It does not prove installed-runtime RSS reduction, does not execute live provider replay, and does not change provider configuration or RouteCodex runtime behavior.
