# V3 Hub Relay Four-Worker Implementation Plan

Canonical contract: [V3 Hub Relay Fixed Pipeline Contract](../design/v3-hub-relay-fixed-pipeline-contract.md).

## Objective

Make Relay implementable without changing the fixed Hub v1 topology by splitting the work into four
parallel, non-overlapping worker slices: request semantics, response semantics, runtime
resources/hooks, and maps/gates/wiki. All slices are Rust-first and must preserve the continuation
immutable interval.

## Shared rules for all workers

- Do not add, remove, renumber, or reuse Hub node IDs.
- Do not create a second lifecycle, second Runtime kernel, or second response exit.
- Do not put semantic logic between continuation save and restore except round-trip-equivalent
  normalization, scope validation, storage/transport, expiry, and release.
- Do not add TypeScript business semantics; TS may only remain an IO/bridge/diagnostic shell when
  explicitly allowed by the owner map.
- Do not change V2, `~/.rcc`, global install, live server, provider credentials, or release runtime.
- Claim semantic ownership in `.agent-collab/` before writing implementation.
- Use borrow-first, move-at-boundary payload ownership. Do not deep-copy full request, response,
  context, provider wire, SSE, snapshot, or continuation payloads for hooks, classification, Debug,
  Error, retry, or resource config. Any required full copy needs an owner node, size bound, release
  point, and gate.

## Worker A — Relay request semantic chain

Claim ID: `feature_id:v3.hub_relay_request_semantics`

Allowed paths:

- `v3/crates/routecodex-v3-runtime/src/hub_v1.rs`
- `v3/crates/routecodex-v3-runtime/src/*request*`
- `v3/crates/routecodex-v3-virtual-router`
- `v3/crates/routecodex-v3-target`
- request-side tests under `v3/crates/**/tests`
- matching docs/maps for this feature ID

Scope:

- implement or stub request entry/exit hooks for Req01-Req07;
- implement Relay request Chat Process typed effects only inside
  `V3HubReqChatProcess04Governed`;
- classify local/remote/new continuation without restoring outside Req04;
- produce `V3HubReqExecution05Planned` and `V3HubReqTarget06Resolved` through the standard nodes;
- build provider semantic request without provider-family branches.

Forbidden:

- request shortcut from Server to Provider;
- direct provider call from request hooks;
- context restore in Req02/Req03/Server/Provider/Debug;
- tool/history repair outside Req04;
- dynamic hooks or config file reads.

Required gates:

- focused Rust request hook tests;
- provider-facing blackbox dry-run proving final provider request shape;
- negative fixture for non-adjacent request conversion;
- request payload ownership tests proving Req01 -> Req04 uses borrowed views or moves rather than
  duplicate full request/context clones;
- shared gates from the canonical contract.

Completion signal:

- request worker can say only: Relay request-side source slice is implemented/verified. It cannot
  claim response, runtime resources, live Relay, or continuation end-to-end.

## Worker B — Relay response semantic chain

Claim ID: `feature_id:v3.hub_relay_response_semantics`

Allowed paths:

- `v3/crates/routecodex-v3-runtime/src/hub_v1.rs`
- `v3/crates/routecodex-v3-runtime/src/*response*`
- `v3/crates/routecodex-v3-provider-responses` only for generic provider raw/semantic helpers
- response-side tests under `v3/crates/**/tests`
- matching docs/maps for this feature ID

Scope:

- implement or stub response entry/exit hooks for Resp01-Resp06;
- keep tool harvest, servertool response hooks, terminal/non-terminal judgment, and response logic
  inside `V3HubRespChatProcess03Governed`;
- commit continuation only in `V3HubRespContinuation04Committed`;
- project client semantics only after continuation commit;
- keep JSON/SSE framing as transport-only.

Forbidden:

- continuation save in Resp05/Resp06/SSE/handler/store;
- required_action inference after Resp03;
- second response exit for servertool or Relay;
- internal metadata/debug/error carrier in client normal payload;
- provider-family branches in Hub response logic.

Required gates:

- focused Rust response hook tests;
- client-facing JSON/SSE blackbox proving one response exit;
- negative fixture for continuation save after Resp04;
- response payload ownership tests proving response governance does not materialize full SSE/body
  clones and continuation save stores one canonical context truth;
- shared gates from the canonical contract.

Completion signal:

- response worker can say only: Relay response-side source slice is implemented/verified. It cannot
  claim request, live Relay, or continuation end-to-end.

## Worker C — Runtime resource configuration and static hooks

Claim ID: `feature_id:v3.hub_relay_runtime_resources_hooks`

Allowed paths:

- `v3/crates/routecodex-v3-config`
- `v3/crates/routecodex-v3-runtime/src/hub_v1.rs`
- `v3/crates/routecodex-v3-runtime/src/*hook*`
- `v3/fixtures/config*.toml`
- hook/config/resource tests under `v3/crates/**/tests`
- matching docs/maps for this feature ID

Scope:

- extend `config.v3.toml` declarations for runtime resources, hook sets, servertool hook profiles,
  continuation policies, execution modes, and protocol capabilities;
- compile declarations into deterministic Manifest resources;
- validate static entry/exit hook registry for every node;
- ensure Runtime consumes only Manifest resources;
- enforce required/optional hook behavior and deterministic ordering.

Forbidden:

- Runtime direct file reads;
- dynamic hook discovery/loading;
- request-specific branch decisions in Config;
- resolved secret or selected provider in Manifest;
- control resources entering provider/client normal payload;
- servertool outside Chat Process hook profile.

Required gates:

- config positive/negative tests for hook/resource declarations;
- static hook registry verifier and red fixtures;
- resource side-channel isolation checks;
- copy-budget gates rejecting unbounded clone calls, JSON round-trip cloning, full SSE
  materialization, and debug/snapshot copies used as live Relay truth;
- shared gates from the canonical contract.

Completion signal:

- resource/hook worker can say only: Relay resource and hook declaration surface is implemented and
  verified. It cannot claim request/response runtime behavior unless those worker gates also pass.

## Worker D — Maps, gates, wiki, migration control

Claim ID: `feature_id:v3.hub_relay_gate_review_surface`

Allowed paths:

- `docs/design/v3-hub-relay-fixed-pipeline-contract.md`
- `docs/goals/v3-hub-relay-four-worker-implementation-plan.md`
- `docs/architecture/v3-resource-operation-map.yml`
- `docs/architecture/v3-function-map.yml`
- `docs/architecture/v3-mainline-call-map.yml`
- `docs/architecture/v3-verification-map.yml`
- `docs/architecture/wiki/v3-hub-relay-fixed-pipeline.md`
- `scripts/architecture/verify-v3-*.mjs`
- `scripts/tests/v3-*.mjs`
- `package.json`

Scope:

- keep feature IDs, resources, mainline edges, verification gates, and wiki review surface
  queryable;
- add red fixtures for shortcut, dynamic hook, wrong continuation placement, second response exit,
  and P6 extension;
- keep P6 frozen until Hub v1 Direct cutover and old-chain deletion are separately verified;
- produce the merge checklist for workers A-C.

Forbidden:

- runtime implementation;
- claiming symbols that do not exist;
- marking pending runtime resources as anchored;
- deleting P6;
- modifying live runtime or user config.

Required gates:

- architecture docs verifier;
- map/resource/static-hook verifiers;
- red fixtures for contract mutation;
- `git diff --check`;
- shared gates from the canonical contract.

Completion signal:

- gate worker can say only: Relay architecture review surface is locked. It cannot claim runtime
  implementation.

## Integration order after parallel work

1. Merge Worker D first if it only locks docs/maps/gates and does not claim runtime completion.
2. Merge Worker C after Config/Manifest/static hook gates pass.
3. Merge Workers A and B after their focused whitebox and blackbox gates pass.
4. Run combined workspace gates.
5. Run payload-copy budget probes for Relay JSON, Relay SSE, local continuation, and servertool
   roundtrip before claiming latency/memory safety.
6. Only after Direct Hub v1 equivalence and sole-entry cutover are verified, add live Relay replay
   and continuation end-to-end gates.

## Phase completion rule

P-Relay contract phase is complete when all four worker slices have queryable owners, allowed paths,
forbidden paths, required gates, and completion signals, and the architecture gates reject shortcut
implementations.

It is not complete as live Relay until a later controlled-upstream replay proves request and response
execution through the fixed Hub v1 skeleton.
