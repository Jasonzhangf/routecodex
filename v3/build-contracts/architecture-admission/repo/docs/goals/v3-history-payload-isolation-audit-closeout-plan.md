# V3 History Immutability and Payload Isolation Audit Closeout

## 1. Goal and Acceptance Criteria

Complete the in-progress V3 pipeline audit and repair for client/provider history
immutability, control-plane isolation, and the Responses continuation immutable
interval.

The task is complete only when all of the following are true:

1. Provider Responses wire preserves the complete client-generated historical
   prefix byte-for-byte. It does not replace historical images, recursively
   remove historical fields, sanitize history, or rebuild history from control
   resources.
2. RouteCodex control state remains in typed carriers, MetadataCenter resources,
   or the Error chain. No routing, switching, retry, provider, continuation,
   health, debug, snapshot, scope, or Stopless state is written into normal
   provider/client payload.
3. The registered Stopless exception remains intact: Req04 may project only the
   current-turn guidance/tool/action, and Resp03 may remove only the matching
   same-turn artifacts using provenance. Restored history remains immutable.
4. No semantic logic exists between Resp04 continuation save and the next Req04
   restore. Resp05, Server06, SSE, handlers, adapters, and store transport only
   project, frame, transport, validate scope, or release resources.
5. Architecture gates, paired red fixtures, build, managed V3 installation and
   restart, live replay of previous failing samples, and Codex review all pass.
6. Only task-owned files are committed. Unrelated dirty worktree changes remain
   untouched.

## 2. Scope and Boundaries

### In Scope

- Audit and finish the changes already made in:
  - `v3/crates/routecodex-v3-provider-responses/src/wire.rs`
  - V3 history/payload, Relay parity, and continuation immutable-boundary gates.
  - V3 resource, function, mainline, verification, test-design, and generated
    review surfaces directly changed by removal of historical rewrites.
- Record one corrective manual authorization for
  `chain:v3.responses_direct.required_mainline` if and only if its sole audited
  fingerprint delta is removal of the forbidden historical image-placeholder /
  historical-field-cleanup resource.
- Run the required runtime closeout and commit the verified task-owned files.

### Out of Scope

- Do not modify provider credentials, routing priorities, provider selection, or
  production configuration values.
- Do not remove legacy `provider_request_cleanup.historical_fields` config keys
  from user configuration in this task. Runtime must not execute them; schema or
  config retirement requires a separately authorized migration.
- Do not repair unrelated function-map anchor drift, unrelated worker changes,
  deleted TS surfaces, or other architecture chains.
- Do not redesign Direct, Relay, continuation ownership, Stopless, reasoning, or
  protocol field projection.
- Do not add fallback, private headers, payload guidance labels, dynamic provider
  probing, or request-history repair.

## 3. Design Principles

1. Client history is already-established business truth. Necessary protocol
   conversion may operate on the current turn only; historical content and order
   are immutable.
2. Provider wire owns target wire validation and encoding, not historical
   cleanup. Unsupported current-turn content must follow the registered static
   compatibility contract; it must not trigger a history rewrite.
3. Control state and business payload are physically separate. Payload cannot
   reconstruct control state, and downstream layers cannot compensate for an
   upstream leak by silently stripping it.
4. Stopless Req04/Resp03 current-turn projection is a registered protocol
   projection, not control-state leakage. It must stay suffix-scoped and
   provenance-bound.
5. Responses continuation is saved only at Resp04 and restored only at the next
   Req04. The interval between them is semantically immutable.
6. Direct remains same-protocol passthrough plus registered hooks. Relay keeps
   every stage in its declared protocol shape and performs only static registered
   projections.
7. No semantic bulk replacement is allowed. Read each file and edit explicit
   hunks with `apply_patch` only.

## 4. Technical Plan and File Ownership

### Runtime

- `v3/crates/routecodex-v3-provider-responses/src/wire.rs`
  - Keep control-key rejection, current-turn data-image validation, stream intent,
    and selected provider model binding.
  - Physically remove historical image placeholder replacement and recursive
    configured historical-field deletion.
  - Keep positive preservation tests for historical tool-output images and
    reasoning/encrypted content, including when legacy cleanup config is present.

### Architecture Gates

- `scripts/architecture/verify-v3-relay-tool-servertool-multiturn-parity.mjs`
- `scripts/tests/v3-relay-tool-servertool-multiturn-parity-red-fixtures.mjs`
  - Reject revival of provider-wire historical replacement/removal helpers.
- `scripts/architecture/verify-responses-continuation-immutable-boundary.mjs`
- `scripts/tests/responses-continuation-immutable-boundary-red-fixtures.mjs`
  - Bind the gate to current Rust ReqInbound/Req04/Resp04/Resp05/Server06 owners.
  - Reject history rebuild/repair and continuation restore/save in forbidden
    nodes.
- `scripts/architecture/verify-v3-architecture-ci.mjs`
  - Require both positive gates and their red fixtures.

### Maps and Review Surfaces

- Update only the entries directly affected by deleting the historical rewrite
  resource in:
  - `docs/architecture/v3-resource-operation-map.yml`
  - `docs/architecture/v3-function-map.yml`
  - `docs/architecture/v3-mainline-call-map.yml`
  - `docs/architecture/v3-verification-map.yml`
  - `docs/goals/v3-responses-direct-mvp-implementation-plan.md`
  - `docs/goals/v3-responses-direct-mvp-test-design.md`
- Refresh canonical mainline Markdown/HTML only through the existing renderer.

### Audited Lock

- Inspect the exact chain diff and recompute the current fingerprint through the
  existing mainline verifier/renderer.
- This goal constitutes Jason's authorization only for the corrective lock change
  that removes the forbidden historical rewrite resource from
  `chain:v3.responses_direct.required_mainline`.
- Append a new `manual_authorizations` record with:
  - `approved_by: Jason`
  - the exact previous fingerprint
  - the exact current fingerprint
  - an explanation that the old placeholder/cleanup owner violated immutable
    client history and was physically removed
- Point `last_manual_authorization_id` at that record.
- Do not refresh any other locked chain. If the chain diff contains any additional
  edge, owner, resource, caller, or callee change, stop and report the exact
  unexpected delta instead of authorizing it.

## 5. Risks and Controls

| Risk | Control |
| --- | --- |
| Historical payload is still altered elsewhere | Search all V3 runtime/provider owners, then rely on positive byte-preservation tests and mutation red gates. |
| Stopless is accidentally classified as leakage | Preserve the registered Req04 suffix projection and Resp03 provenance stripping; verify its dedicated gates. |
| Lock refresh hides unrelated architecture changes | Compare the locked chain structurally before writing one authorization record; reject mixed deltas. |
| Dirty worktree contaminates commit | Refresh `.agent-collab`, inspect staged/unstaged diffs per path, and stage only task-owned hunks/files. |
| Source tests pass but installed runtime is stale | Build and globally install V3, use managed aggregate restart, verify all configured health ports, then replay canonical live samples. |
| Review passes stale source | Run review only after installation/restart/live replay; any later code/test/runtime-config edit invalidates review and repeats the closeout. |

## 6. Verification Matrix

### Architecture and Static Gates

- `git diff --check`
- `cargo +stable fmt --manifest-path v3/Cargo.toml --all -- --check`
- `npm run verify:v3-mainline-caller-flow`
- `npm run verify:v3-resource-map`
- `npm run verify:v3-module-boundaries`
- `npm run verify:v3-relay-tool-servertool-multiturn-parity-closeout`
- `npm run test:v3-relay-tool-servertool-multiturn-parity-closeout-red-fixtures`
- `npm run verify:responses-continuation-immutable-boundary`
- `npm run test:responses-continuation-immutable-boundary-red-fixtures`
- `npm run verify:v3-stopless-resource-control`
- `npm run test:v3-stopless-resource-control-red-fixtures`
- `npm run verify:v3-normalization-payload-logic-boundary`
- `npm run test:v3-normalization-payload-logic-boundary-red-fixtures`
- `npm run verify:v3-protocol-conversion-field-parity`
- `npm run test:v3-protocol-conversion-field-parity-red-fixtures`
- `npm run verify:v3-architecture-ci`

Unrelated pre-existing feature-anchor failures must be reported separately and
must not be mass-repaired or hidden.

### Rust Tests and Build

- Provider Responses library tests.
- Focused Hub request semantics, Relay tool/servertool parity, and local Responses
  continuation integration tests.
- Full required V3 build/install gate declared by the project verification map.

### Installed Runtime and Live Replay

1. Install the built V3 runtime using the repository's canonical global install
   command.
2. Run V3 config check against the active configuration without mutating it.
3. Restart once through the managed aggregate V3 restart command using a locator
   port; never restart each port separately and never use broad process kills.
4. Verify every configured member port health endpoint.
5. Replay canonical previous failing samples from
   `~/.rcc/codex-samples/<endpoint>/ports/<port>/<requestId>/` through the same
   live entry endpoints.
6. Prove that historical tool images, reasoning/encrypted content, tool lists,
   tool calls/results, and ordering survive except for registered current-turn
   protocol projections. Prove no internal control key reaches provider/client
   payload and no 500/502 is caused by the removed history cleanup.

### Review

- After all preceding evidence passes, run the `codex-review` skill with
  `codex -p cc review`, writing output to the required local log.
- Use `asxs`, then `tcm`, only if the preceding profile is unavailable, fails, or
  has no final conclusion.
- Fix every blocking finding and repeat affected build/install/restart/live replay
  before re-review. Do not weaken tests to obtain PASS.

## 7. Execution Order

1. Refresh `.agent-collab` runs, claims, events, and kill switch; retain the
   existing audit claims or acquire non-conflicting semantic claims.
2. Re-read resource/function/mainline/module/verification owners and inspect the
   complete task-owned diff.
3. Confirm the runtime removals solve the unique root cause and that no other
   production history writer exists.
4. Confirm maps, tests, and red gates match the runtime behavior.
5. Structurally audit the one locked mainline delta and append the corrective
   Jason authorization only if the delta is exactly in scope.
6. Run static gates, paired red fixtures, Rust tests, and V3 architecture CI.
7. Build, globally install, config-check, aggregate-restart, health-check, and
   live-replay previous failing samples.
8. Run Codex review from a log file; repair and repeat until an unambiguous PASS.
9. Update `note.md`, append durable verified truth to `MEMORY.md`, mine the same
   MemoryPalace wing, and verify retrieval.
10. Stage and commit only task-owned files. Report the commit hash, verification
    evidence, and any unrelated repository blockers separately.

## 8. Definition of Done

- No V3 production path rewrites client history or uses payload to reconstruct
  control state.
- Stopless current-turn behavior and continuation immutable interval remain
  explicitly protected by positive and negative gates.
- The sole affected audited mainline lock has a correct Jason authorization and
  all architecture gates pass.
- The installed runtime matches the source under review and previous live failure
  samples pass on the managed V3 instance.
- Codex review returns an unambiguous PASS.
- A focused commit contains only the audited closeout changes.
