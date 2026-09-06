# RouteCodex V3 Contract

## Project Truth

- RouteCodex V3 is the only active production implementation.
- RouteCodex V4 is a refactor of V3 and is not connected to the production baseline.
- RouteCodex V2 is retired completely. Do not retain or restore a V2 runtime, V2 config reader, V2 migration path, or V2 backup.
- Runtime, routing, protocol projection, provider execution, lifecycle, and CLI live in the `v3/` Rust workspace.
- Installed command: `rccv3`. Default authoring: `~/.rcc/config.v3.toml`.
- `routecodex` and `rcc` are compatibility shims; do not create new runtime or config ownership under them.

## Semantic Invariants

- General safety, ablation, rule precedence, and review policy inherit the global AGENTS.md. This section adds RouteCodex protocol and ownership constraints.
- The runtime is a fixed skeleton configured by typed declarations. Data-plane payloads and control-plane resources remain physically separate.
- Proxy behavior stays transparent: preserve request, response, history, and observable protocol meaning.
- Every request enters as JSON. Inbound only performs lossless request/response normalization into Chat Process: it preserves every field, maps Chat semantics into the canonical Chat shape, and carries non-Chat semantics as extensions. Inbound never filters or rewrites payload meaning.
- Relay payload rewriting is owned only by request/response Chat Process. Direct payload rewriting is owned only by registered Direct hooks. No other stage rewrites payloads.
- Outbound projects canonical Chat plus extensions into the target standard protocol. It may filter only fields that cannot be represented compatibly, through an explicit allowlist/denylist contract.
- Provider Compat performs only provider-private adjustments after standard outbound projection and before or after provider transport as declared. It is not a second Chat Process or a general Outbound implementation.
- No guessed repair, fallback, downgrade, silent drop, hidden history rewrite, or success-wrapped error.
- Control state uses typed control resources or Error chain only. Business payload cannot carry or reconstruct it.
- Request, response, and error graphs remain separate.
- Internal request-stage failures project `598`; internal response-stage failures project `599`; network failures project `502`. External failures retain their real external status and are not rewritten.
- SSE is the client communication boundary and is decoupled from Provider. Provider attempts are fully buffered before any client response is committed; provider errors enter the Error chain independently of client response projection.

## Runtime Ownership

- Server: listener, HTTP/WebSocket framing, body limits, client disconnect.
- Runtime: complete request lifecycle, fixed skeleton/node/hook order, provider transport relay, and full-attempt buffering.
- Inbound: lossless request/response normalization only; no filtering or payload rewriting.
- Chat Process: Relay-only payload rewriting, standard Chat semantic mapping, non-Chat extension governance, tool/history governance, and continuation restore/save boundaries.
- Outbound: canonical Chat and extension projection to the target standard protocol; compatibility filtering only through declared allowlists/denylists.
- Compat: provider-private protocol adjustments only.
- Virtual Router: classify and select one opaque route target.
- Target Interpreter: expand candidates and reselect only inside selected target.
- Provider: wire construction, auth, transport, and provider health mutation.
- SSE: all client-facing communication, transport framing, and projection of committed client payload or typed terminal error.
- Error: classify source failure, plan action, decide exhaustion, project client error.
- Debug: logs, snapshots, dry-run, replay; never business truth.
- Direct: default for a same-protocol target unless configuration explicitly selects Relay; all payload rewrites occur inside registered Direct hooks.
- Relay: selected for cross-protocol execution or by explicit configuration; all payload rewrites occur inside Chat Process.
- Direct still reaches Provider through the runtime provider transport relay. That transport relay is distinct from the Relay protocol-conversion execution mode.

## Architecture Truth

- Resource relations: `docs/architecture/v3-resource-operation-map.yml`.
- Feature owner and allowed/forbidden paths: `docs/architecture/v3-function-map.yml`.
- Request/response/error caller edges: `docs/architecture/v3-mainline-call-map.yml`.
- Required tests, gates, and runtime evidence: `docs/architecture/v3-verification-map.yml`.
- Human review surface: `docs/architecture/wiki/v3-mainline-caller-flow.md`.
- Maps, source anchors, generated review surfaces, and gates must agree. Unbound or ambiguous ownership blocks implementation.

## Git Protection

- `.githooks/pre-commit` rejects protected-branch commits; `.githooks/pre-push` rejects protected-ref pushes.
- Bootstrap with `npm run setup:git-main-protection`; verify with `appsdk verify-git-main-protection .`.
- PASS proves Git protection only.

## Task Routing

Use `rcc-dev-skills` as the sole V3 development workflow; generic skills supply methods only. This contract describes V3; work under a separately governed subtree must load its scoped AGENTS.md and skill before applying V3 commands or gates.

| Need | Read |
| --- | --- |
| completion evidence | `docs/agent-routing/05-foundation-contract.md` |
| development/debug | `.agents/skills/rcc-dev-skills/SKILL.md` |
| runtime owner lookup | `docs/agent-routing/10-runtime-ssot-routing.md` |
| build/install/restart | `docs/agent-routing/20-build-test-release-routing.md` |
| servertool/Stopless | `docs/agent-routing/30-servertool-lifecycle-routing.md` |
| task memory | `docs/agent-routing/40-task-memory-routing.md` |
| AppSDK lifecycle | `.appsdk/skills/appsdk-project-governance/SKILL.md` |

## Evidence Boundary

Report source, test, build, install, restart, health, same-entry replay, review, merge, and remote receipt separately. Never infer a later level from an earlier one.
