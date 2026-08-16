# Replay Codex Sample Payload Copy Budget Test Design

## Scope

`feature_id: debug.replay_codex_sample_payload_copy_budget` owns only debug replay request preparation in `scripts/replay-codex-sample.mjs`.

## Lifecycle

The CLI loads one captured codex-samples request, derives a replayable client request, optionally strips replay-only metadata, sends that request to a selected RouteCodex base URL, and writes diagnostic artifacts. Importing the module for tests must not call live HTTP.

## Positive Cases

- Replay-only metadata stripping shallow-copies only the top-level request body and rewritten metadata object.
- Unchanged `input`, `tools`, extension values, and nested metadata values preserve reference identity.
- Provider-request-to-Responses replay conversion creates a new client request envelope while borrowing typed content blocks, tools, metadata, and stream intent.
- Non-Responses provider replay returns the original request object because no script-local mutation is required.

## Negative Cases

- Request preparation must not use `JSON.parse(JSON.stringify(body))`, `structuredClone`, `deepClone`, or recursive copying.
- Metadata stripping must not mutate the captured source sample.
- Provider-request conversion must not become a second provider/client payload truth, route truth, MetadataCenter state, provider config path, or live provider replay proof.

## Required Gates

- `npm run jest:run -- --runTestsByPath tests/scripts/replay-codex-sample.spec.ts --runInBand`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-mainline-manifest-sync`
- `npm run verify:architecture-mainline-mermaid-sync`
- `npm run verify:architecture-wiki-sync`
- `npm run verify:architecture-wiki-html-sync`
- `npx tsc --noEmit --pretty false --skipLibCheck`
- Target `git diff --check`

## Completion Boundary

This slice proves source/Jest-level debug replay request preparation only. It does not execute live replay, mutate provider config, change `~/.rcc`, restart servers, or prove installed-runtime RSS reduction.
