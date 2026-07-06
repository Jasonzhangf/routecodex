# Conversion Module

## Current Boundary

Hub Pipeline runtime semantics are Rust-owned. TypeScript under `src/conversion/` is limited to direct-owner bridge modules, generated/dist entry points, and narrow host glue around native Rust owners.

The public conversion barrel file has been removed. Repository-live consumers must use direct owner paths or the root package exports:

- `convertProviderResponse`
- `runStandardChatRequestFilters`

Other conversion modules must be imported from their direct owner path when they remain live. Do not restore a legacy umbrella export or `./conversion` package subpath for protocol pipelines, codec registries, schema validators, Hub types, response bridge helpers, or shared tool/text helpers.

## Directory Notes

```text
src/conversion/
├── types.ts                  # Direct-owner conversion types still used by live codecs/filters.
├── codecs/                   # Legacy/direct codec implementations; not public barrel surface.
├── compat/                   # Provider compatibility profiles and direct-owner helpers.
├── hub/                      # TS bridge/glue around Rust Hub Pipeline owners.
├── pipeline/                 # Legacy V2 pipeline internals; direct-owner usage only.
├── responses/                # Responses bridge internals; direct-owner usage only.
└── shared/                   # Shared direct-owner wrappers around native/Rust semantics.
```

Deleted legacy public-surface modules must stay absent:

- `codec-registry.ts`
- `schema-validator.ts`
- `args-mapping.ts`

Residue gates in `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` lock this boundary.
