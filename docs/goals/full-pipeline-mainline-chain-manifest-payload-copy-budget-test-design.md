# Mainline Chain Manifest Payload Copy Budget Test Design

## Contract

- `feature_id`: `architecture.mainline_chain_manifest_payload_copy_budget`
- `resource_id`: `architecture.mainline_chain_manifest_projection`
- Owner: `scripts/architecture/generate-mainline-chain-manifests.mjs`
- Goal: build one authoritative architecture manifest projection per chain and serialize it directly to YAML without a full JSON round-trip clone.

## Lifecycle

1. Parse the canonical mainline call map once for an explicit CLI generation run.
2. Build one manifest projection for each chain through `buildMainlineChainManifest`.
3. Pass that same projection to `YAML.stringify` and write the generated review artifact.
4. Release the projection after the write; never expose it as runtime request, response, provider, config, or MetadataCenter truth.

## Positive Gates

- Builder output preserves lifecycle id, summary, dominant owner, entrypoint, sorted node ids, edge status/owner/split fields, and verification gates.
- Importing the module performs no repository IO or logging.
- Direct CLI regeneration passes `verify:architecture-mainline-manifest-sync`.

## Negative Gates

- Reject `JSON.parse(JSON.stringify(manifest))`, `manifestClean`, `structuredClone`, recursive clone helpers, and import-time generation.
- Do not trim or reinterpret canonical map semantics to reduce object size.

## Verification Boundary

- Focused Jest, direct generator execution, and manifest sync prove architecture artifact equivalence.
- This slice does not prove or claim runtime request/response memory, installed-runtime behavior, provider equivalence, concurrency, or RSS reduction.
