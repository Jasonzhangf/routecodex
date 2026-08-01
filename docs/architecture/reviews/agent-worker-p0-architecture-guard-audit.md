# Agent / Worker P0 Architecture Guard Audit

## Scope

This audit covers the non-routing entry surfaces that a worker can see before it selects a RouteCodex workflow:

- global Agent entry: `~/.codex/AGENTS.md`
- project Agent entry: `AGENTS.md`
- global engineering/review entries: `coding-principals`, `pipedebug`, `rcc-v3-config-ssot`, `codex-review`
- project RouteCodex entries: `rcc-dev-skills`, `rcc-v3-architecture`, `rcc-server-restart`
- V3 architecture CI wiring and negative fixtures

## Findings

1. No first-screen P0 rule prohibited script-based semantic batch replacement. A worker could use an ad hoc script, loop, regex command, or broadened generator before reading each target context.
2. The payload/control isolation rule existed, but it was buried below routing and workflow material. A worker could begin searching or designing before seeing it.
3. Project skills did not share a first-screen P0 contract. The merged restart skill and legacy pipeline debug skill were especially weak entry points.
4. The module maps were required as lookup tools, but the worker lifecycle did not strictly order module-definition reading, design boundary review, implementation, diff boundary self-review, functional verification, live verification, and code review.
5. The Codex review prompt checked broad owner and map drift, but it did not require an explicit per-module binding to `owned/allowed/forbidden paths`, adjacent calls, and resource relations before issuing PASS.
6. No CI gate prevented these first-screen rules or their review ordering from drifting.

## Locked Contract

The P0 contract now applies before routing:

1. Semantic batch replacement is forbidden across files and across multiple locations in one file. Python, Node, Perl, `sed`, `awk`, temporary scripts, shell loops, regex replacement commands, editor macros, and generated transformation scripts are not permitted for this purpose.
2. Each target file is read first and changed through explicit, reviewable `apply_patch` hunks. Existing formatters and canonical generators may only emit their declared mechanical/generated outputs; they may not perform semantic rewrites.
3. Control semantics use typed carriers, MetadataCenter control resources, or the Error chain. They never enter or mirror into provider/client normal payloads, including protocol `metadata`.
4. Normal payloads never reconstruct routing, switching, continuation, retry, selection, health, debug, snapshot, error, scope, stopless, or servertool control state.
5. Leakage fails at the owning boundary. Silent strip, request-side cleanup, and handler/SSE/outbound compensation are forbidden.
6. Before code, the worker reads every involved module definition and verifies owner, owned/allowed/forbidden paths, adjacent caller/callee edges, resource relations, and required gates.
7. The worker rejects an out-of-bound design before implementation, reviews the actual diff against the same module definitions after implementation, then performs functional verification and required live verification. Code review runs last.
8. The reviewer independently repeats both P0 checks and the module-boundary check; unbound files, paths, calls, resource edges, or script-based batch rewrites are blocking findings.

## Machine Gates

- `npm run verify:agent-p0-payload-control-guard`
- `npm run verify:agent-p0-payload-control-guard-global`
- `npm run test:agent-p0-payload-control-guard-red-fixtures`
- `npm run verify:v3-architecture-ci` runs the project verifier and red fixtures as its first two steps.

The project verifier checks first-screen P0 visibility, placement of the batch-replacement ban before payload/control rules, the explicit `apply_patch` requirement, the narrow formatter/generator exception, and full lifecycle ordering. The global verifier additionally checks global Agent/skill entries and Codex review surfaces. Red fixtures reject removal or weakening of the batch-replacement ban, `apply_patch` requirement, generator boundary, fail-fast, payload/control separation, reverse-control reconstruction prohibition, module path review, review ordering, transport compensation prohibition, and CI wiring.
