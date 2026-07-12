# llmswitch Host Bridge

`src/modules/llmswitch` is the RouteCodex host boundary for llmswitch-core.
The host bridge is not the Hub Pipeline semantic owner: Hub Pipeline,
Virtual Router, servertool, continuation, tool governance, and error-policy
semantics belong to Rust/native owners under
`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/`.

## Source Surface

- `bridge/*.ts`: thin host IO, native binding, routing, snapshot, SSE, and
  continuation store shells.
- `bridge/native-exports.ts`: private package/dist path resolution and final
  llmswitch-core native binding loading for owner-specific host modules.

The broad `bridge.ts` and `bridge/index.ts` barrels are retired. Server/runtime
callers must import the concrete leaf bridge module they own.

Do not add checked-in side-by-side `.js` or `.d.ts` mirrors under this tree.
Runtime JavaScript belongs in `dist` after build; tests may keep ESM `.js`
specifiers because Jest maps them to the canonical TypeScript source.

## Boundary Rules

- Do call Rust/NAPI through the existing approved owner-specific host bridge
  shell for the feature.
- Do keep host code limited to IO, native binding calls, HTTP/server adapters,
  and explicit diagnostic writing.
- Do not restore `importCoreDist`, `requireCoreDist`, engine selection,
  source-prefer loading, or broad compatibility fallback paths.
- Do not implement Hub Pipeline, Chat Process, servertool, continuation,
  tool-governance, Virtual Router, or error-policy semantics in TypeScript.
- Do not add provider-specific behavior to the host bridge; provider-specific
  compatibility belongs in provider runtime.

## Verification

Relevant gates include:

- `node scripts/ci/llmswitch-ts-shell-reference-audit.mjs --strict --json`
- `npm run verify:architecture-deleted-path`
- `npm run verify:architecture-thin-wrapper-only`
- `npm run verify:function-map-compile-gate`
- `npm run jest:run -- --runInBand --runTestsByPath tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`
