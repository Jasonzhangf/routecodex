# V3 mainline contract architecture gap repair plan

## 1. Goal and acceptance

Repair the architecture review surface, maps, docs, and gates so the approved V3 mainline contract is the queryable truth for review and debug.

Acceptance:
- `docs/design/v3-hub-relay-fixed-pipeline-contract.md`, `docs/architecture/v3-mainline-call-map.yml`, `docs/architecture/v3-function-map.yml`, verification map, and generated HTML all describe the same approved skeleton.
- Request skeleton includes `ProviderReqCompat06ProviderCompat` and the VR/Target expansion.
- Response skeleton includes `ProviderRespCompat02ProviderCompat`.
- Error resources show provider health/availability as resources, and distinguish actual Relay bindings from Direct/foundation-only evidence.
- Aggregate entry edges are visibly non-semantic wrappers and cannot be mistaken for adjacent mainline edges.
- No live/runtime completion is claimed without current live evidence.

## 2. Scope

In scope:
- Architecture docs, wiki source, manifests, maps, renderers, verifiers, and red fixtures.
- Status wording that distinguishes typed skeleton, source slice, controlled runtime, live evidence, and binding pending.
- Gate wiring for architecture review surfaces.

Out of scope:
- Rust runtime semantic fixes.
- Provider config, credentials, live config, global install, restart, or live replay.
- Manual audit locks. Do not write `docs/architecture/v3-architecture-audit-locks.yml` locked items unless Jason explicitly authorizes.

## 3. Design principles

- Edge map is truth; do not hand-write graph-only truth.
- Do not fake `caller_symbol`, `callee_symbol`, live status, or source binding.
- `binding_pending` is allowed and must be visible when code is not yet aligned.
- Normal request/response payload, metadata/debug/error resources, provider health, and availability remain separate.
- Aggregate wrapper edges are not semantic adjacent edges.
- Do not hide a runtime gap by changing labels or summary text.

## 4. Technical plan

1. Sync fixed-pipeline contract doc with approved skeleton:
   - Request: `Req01 -> Req02 -> Req03 -> Req04 -> Req05 -> VR/Target -> Req06 -> Req07 -> ProviderReqCompat06 -> Req08 -> Req09`.
   - Response: `ProviderRespInbound01 -> ProviderRespCompat02 -> Resp02 -> Resp03 -> Resp04 -> Resp05 -> Resp06`.
   - Error: `Error01-06`, plus provider health/availability resource observation.
2. Update `v3-mainline-call-map.yml` to separate:
   - typed skeleton edges (`h1_typed_test`);
   - live runtime implementation chains;
   - aggregate server-entry wrapper edges;
   - binding-pending edges.
3. Make `v3.responses_relay.source_server_entry` aggregate-only in renderer and verifier:
   - Never render `V3HubReqInbound01ClientRaw -> V3ServerRespOutbound06ClientFrame` as semantic mainline.
   - Red fixture must fail if a non-aggregate edge jumps request raw to server frame.
4. Add or expose Relay-specific VR/Target binding status:
   - Bind existing `resolve_target` internal VR/Target calls only if source symbols and resource flows are real.
   - Otherwise mark pending visibly.
5. Add or expose Relay-specific provider health observations:
   - Responses Relay success/failure bindings may point to real source if present.
   - Anthropic/OpenAI/Gemini provider health gaps must stay pending until runtime is fixed.
6. Fix function-map status drift:
   - `v3.hub_pipeline_static_skeleton` = typed topology.
   - `v3.hub_relay_request_semantics` / response semantics = source slices.
   - runtime closeout/live status must be explicitly scoped and not used as current-live evidence without replay.
7. Harden render/verify scripts so HTML auto-gap section lists:
   - aggregate shortcuts;
   - binding-pending edges;
   - typed-test-only skeleton edges;
   - runtime closeout gate failures if known.

## 5. Risks and guardrails

- Do not convert docs to false green by weakening gates.
- Do not move runtime semantics into docs/scripts.
- Do not add provider-specific behavior to Hub/VR docs except as provider runtime boundary notes.
- Do not claim live 5555 validity in this doc-only task.

## 6. Verification plan

Minimum:
- `node --check scripts/architecture/v3-mainline-caller-flow-lib.mjs`
- `node --check scripts/architecture/verify-v3-mainline-caller-flow.mjs`
- `node --check scripts/tests/v3-mainline-caller-flow-red-fixtures.mjs`
- `npm run render:v3-mainline-caller-flow`
- `npm run verify:v3-mainline-caller-flow`
- `npm run test:v3-mainline-caller-flow-red-fixtures`
- `npm run verify:v3-architecture-docs`
- `npm run verify:architecture-wiki-html-sync`
- `node scripts/architecture/verify-architecture-wiki-browser-smoke.mjs`
- `git diff --check`

If gate wiring changes:
- Run the affected package script and the matching red fixture.

## 7. Done definition

- Jason can open the HTML and see which chains are audited, aggregate-only, typed-test-only, live-bound, or pending.
- No accepted skeleton node is missing from docs/maps/rendered HTML.
- No runtime gap is hidden by map wording.
- All architecture-only gates and red fixtures pass.
