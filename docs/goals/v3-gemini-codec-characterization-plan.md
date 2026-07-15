# V3 Gemini Codec Characterization Plan

## 1. Objective and acceptance

Characterize the generic Gemini protocol codec as one closed, Rust-only adjacent conversion contract. Acceptance requires lossless request, provider-wire, provider-response, and client-projection evidence for JSON and event-level SSE shapes, plus fail-fast negative coverage and source gates proving this module is not wired into Hub hooks, Server, Provider transport, continuation, Relay, or live Gemini runtime.

## 2. Scope and boundaries

In scope:

- Gemini `generateContent` request object and `contents[].parts[]` contract;
- `functionCall` and later `functionResponse` name correlation;
- JSON response `candidates`, `finishReason`, `usageMetadata`, and function-call preservation;
- event-level streaming chunk characterization without byte parsing or materialization;
- explicit provider error shape;
- internal control/metadata side-channel rejection;
- maps, machine manifest, wiki, source gate, mutation gate, focused Rust tests.

Out of scope:

- `/v1beta/models/:model/generateContent` Server implementation or endpoint status change;
- Hub hook registration or Runtime kernel wiring;
- Responses/Anthropic/OpenAI Chat conversion;
- Provider transport or auth;
- remote/local continuation, Relay, servertool, stopless;
- SSE Transport Core changes, stream parser/framer, history repair;
- V2, live configuration, install, restart, live replay, fallback.

## 3. Design principles

- The codec owns only adjacent protocol validation and lossless movement.
- Entry and provider protocol axes must both be `Gemini`.
- `functionResponse.name` must refer to a previously declared `functionCall.name`; missing or orphan identities fail.
- JSON and SSE stay separate transport intents; SSE input is one already-framed event object.
- Internal route, provider, auth, debug, metadata, continuation, and resource fields never enter normal payloads.
- No hook registry, Server handler, Provider transport, routing, or lifecycle symbols may appear.

## 4. Technical design and files

- `v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs`: typed stage wrappers, protocol guards, request/response validators.
- `v3/crates/routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs`: positive and negative characterization.
- `scripts/architecture/verify-v3-gemini-codec-characterization.mjs`: ownership, residue, maps, and wiring denial gate.
- `scripts/tests/v3-gemini-codec-characterization-red-fixtures.mjs`: forbidden mutation tests.
- `docs/architecture/v3-{function,mainline-call,verification}-map.yml`: queryable owner, adjacent evidence edges, required gates.
- `docs/architecture/manifests/v3.gemini.codec_characterization.mainline.yml`: machine lifecycle.
- `docs/architecture/wiki/v3-gemini-codec-characterization.md`: human review surface.

## 5. Risks and controls

- Accidental runtime wiring: gate scans Server, Provider, resource hooks, and kernel for codec symbols.
- Tool history repair: validator rejects invalid function response identity but never rewrites or reorders contents.
- SSE ownership leak: codec accepts event objects only and contains no byte/frame parser.
- Control payload leak: explicit deny list and mutation gate.
- Pending endpoint confusion: completion wording must keep Gemini endpoint `pending_not_implemented` until a separate runtime integration target changes it.

## 6. Test plan

Positive:

- request contents/tools/generationConfig preserve exact JSON;
- `functionCall` followed by matching `functionResponse` preserves names and payload;
- JSON response preserves candidates, finish reason, usage metadata, and function calls;
- SSE chunks preserve candidate events without aggregation;
- provider error remains explicit error payload.

Negative:

- wrong entry/provider protocol;
- non-object payload or missing `contents`/`parts`/`candidates`;
- missing or orphan `functionResponse.name`;
- malformed provider error;
- internal side-channel fields;
- mutation attempts to register hooks, add runtime wiring, fallback, or another protocol branch.

## 7. Implementation order

1. Lock plan and test design.
2. Add focused tests and confirm missing-module red baseline.
3. Implement the single codec owner and exports.
4. Add source gate and mutation fixtures.
5. Bind function/mainline/verification maps, manifest, and wiki.
6. Run focused, mutation, architecture/resource/module/Rust-only, fmt, and diff gates.
7. Architecture review and precise claim-only handoff/commit.

## 8. Definition of done

- All four characterization stages are typed, lossless, and source-bound.
- Positive/negative tests and mutation gates pass.
- Maps, manifest, and wiki use the same node IDs and real symbols.
- Gates prove no runtime/Server/Provider/continuation/Relay/SSE Core/live wiring.
- Completion wording stays limited to codec characterization; `/v1beta/models/:model/generateContent` remains explicitly `pending_not_implemented`.
