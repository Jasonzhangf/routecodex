# V3 Debug and Error Foundation Plan

## Objective and acceptance

Complete P3 Global Debug and P4 Global Error/Provider Health foundations before implementing Virtual Router, Target selection, or Responses Provider execution.

Acceptance requires one global Debug system with logs, node snapshots, and same-kernel Dry Run; one six-node Error chain; and Provider-owned health state/actions at provider-instance, auth-key, and canonical-model scopes. The existing P2 pending endpoint lifecycle must exercise these systems through the same Server/Runtime resources.

## Scope

In scope:

- `routecodex-v3-debug` complete P3 implementation;
- `routecodex-v3-error` complete P4 classification/action/exhaustion contracts;
- Provider-local health state and action executor contracts;
- Target-facing read-only availability interface;
- Server debug endpoints and pending endpoint integration;
- CLI/debug fixture support needed for real validation;
- resource, function/mainline, verification, Wiki, and test-design updates.

Out of scope:

- P5 Virtual Router route selection and Target runtime selection;
- P6 Responses upstream transport and client protocol conversion;
- Relay, continuation, servertool, and TypeScript bridges;
- changing real `~/.rcc/config.v3.toml`, global installs, or existing V2 processes.

## Design principles

1. Debug and Error are global side-channel owners, never normal request/response truth.
2. Runtime remains the only complete lifecycle executor; Debug/Error return typed events, plans, and projections.
3. Dry Run uses the same Runtime skeleton and explicit no-network terminal effect; it cannot form a replay pipeline.
4. Normal execution retains raw request/raw response plus event/error ledger according to policy, not every node payload.
5. Error classifies and creates action plans; Provider alone stores health/cooldown/quota/concurrency state and executes actions.
6. Target can query typed availability only. Router cannot read Provider health. Neither can mutate Provider state.
7. No fallback, error-as-success, silent repair, second logger, second snapshot store, or handler-local error policy.

## Technical design and file surface

Primary Rust owners:

- `v3/crates/routecodex-v3-debug/src/`: trace context, event registry, console/file sinks, redaction, snapshot registry, raw capture policy, Dry Run registry/executor projections.
- `v3/crates/routecodex-v3-error/src/`: six adjacent Error node types, taxonomy, action-plan builder, exhaustion decision, client projection.
- `v3/crates/routecodex-v3-provider-responses/src/health.rs`: Provider-owned process-local health state, scoped action executor, availability projection. Transport remains uncalled in P4 tests.
- `v3/crates/routecodex-v3-runtime/src/`: adjacent orchestration only; same-kernel Dry Run terminal effect registration.
- `v3/crates/routecodex-v3-server/src/`: debug endpoint transport and Error frame emission only.
- `v3/crates/routecodex-v3-cli/src/`: debug/status invocation shell only.

Required typed resources:

- request trace context;
- ordered debug event ledger;
- raw request/raw response capture reference;
- transient node snapshot session;
- Dry Run fixture and execution plan;
- Error01 through Error06 resources;
- provider health action plan;
- provider-instance/auth-key/model health state;
- Target-facing availability projection.

## Risks and controls

| Risk | Control |
| --- | --- |
| Debug becomes payload truth | type separation, serialization red tests, provider/client leak gates |
| Dry Run creates second lifecycle | same Runtime entry and explicit terminal effect gate |
| snapshots retain full payload indefinitely | transient session ownership and retention/concurrency tests |
| secrets enter logs/snapshots/errors | centralized redaction plus positive/negative fixtures |
| Error stores cooldown state | dependency/source gate; only Provider health module mutates state |
| Target or Router mutates health | read-only availability trait and compile-fail tests |
| provider error becomes success | Error06 projection and success/error polarity tests |
| placeholder logic survives after full owner exists | unique source owner gates and physical deletion of replaced placeholder code |

## Test plan

White-box:

- trace/event ordering, sink failure, redaction, snapshot registration/release;
- Dry Run fixture validation, same-kernel node order, no transport send;
- all six adjacent Error conversions;
- error taxonomy/action scope/duration/retry eligibility;
- Provider health state mutation at each scope and read-only availability projection.

Module blackbox:

- Server pending request emits console/file event and queryable trace;
- debug endpoints return status/log/snapshot/dry-run projections without exposing secrets;
- raw request/response fixture replays through the registered nodes and produces transient snapshots;
- Error action changes Provider health and Target availability while Router remains isolated.

Positive/negative pairs:

- success/failure/non-terminal/already-terminal;
- snapshot enabled/disabled/released/retention exceeded;
- valid/malformed/missing Dry Run fixture;
- provider/auth/model scoped cooldown and cross-scope isolation;
- target candidates remaining/fully exhausted;
- client disconnect health-neutral versus provider failure health-affecting;
- error remains error and success remains success.

Project blackbox:

- build the actual V3 CLI;
- start the P2 multi-listener fixture on dedicated ports;
- call pending endpoint and debug status/log/snapshot/dry-run endpoints;
- prove ordered trace and six-node error output;
- prove Dry Run performs no upstream network send;
- stop the exact process and confirm ports close.

## Implementation order

1. Expand resource/function/mainline/verification maps and test design for P3/P4; add red gates first.
2. Replace the minimal Debug placeholder with typed trace/event registry and sinks.
3. Add raw capture policy and transient snapshot registry.
4. Implement Dry Run fixture registry and same-kernel no-network terminal effect.
5. Wire Debug HTTP/CLI query surfaces.
6. Replace the minimal Error placeholder with six adjacent owning builders and taxonomy/action plans.
7. Add Provider-owned health store/action executor and availability projection.
8. Wire Error action execution without implementing P5 selection.
9. Run unit/module/project blackboxes, architecture review, actual CLI multi-port validation, memory/evidence closeout.

## Definition of done

- P3 and P4 maps, Wiki, test design, symbols, and gates are synchronized and anchored.
- Debug logs to console/file, records ordered node events, captures policy-approved raw payloads, registers transient snapshots, and replays Dry Run through the same Runtime skeleton.
- Debug/error/secret data cannot enter provider or client normal payloads.
- Every error traverses Error01 through Error06 with no bypass.
- Error outputs typed health actions; Provider alone mutates provider/auth/model health state.
- Target-facing availability is read-only; Router has no health dependency.
- Actual V3 CLI multi-port probes demonstrate debug endpoints, Dry Run no-send behavior, and pending endpoint Error chain.
- P5/P6 remain pending and no upstream Provider request is made.

## Verified closeout — 2026-07-14

- All mapped P3/P4 architecture, compile-fail, Rust-only, static-hook, fmt, Clippy, focused contract, workspace, and CLI build gates passed.
- The module/source gate proves the six Error structs exist only in `routecodex-v3-error`, Server does not classify/build Error nodes, Error does not mutate health, and the P3 Dry Run foundation does not import or call Provider transport/P6 Runtime execution.
- The compile-fail fixture proves an external Target-style crate can construct/read the public availability owner but cannot call the crate-private Provider health mutation method.
- Post-startup file sink failure, malformed Dry Run, and disabled Dry Run explicitly project `500 v3_debug_failure` through Error01-Error06; they do not panic, downgrade, or silently continue.
- Actual CLI/HTTP evidence on `45444` and `45445` proves shared Debug state, secret isolation, six transient Dry Run snapshots, `no_network_send`, snapshot release, complete pending Error chain, precise Ctrl-C shutdown, and both ports closed.
- This closeout advances only P3/P4. It does not use P5/P6/P7 behavior as completion evidence and does not change V2, `~/.rcc`, global installation, or a real upstream Provider.
