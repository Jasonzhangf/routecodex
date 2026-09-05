# RouteCodex V3 Contract

## Project Truth

- RouteCodex V3 is the only active production implementation.
- Runtime, routing, protocol projection, provider execution, lifecycle, and CLI live in the `v3/` Rust workspace.
- Installed command: `rccv3`. Default authoring: `~/.rcc/config.v3.toml`.
- `routecodex` and `rcc` are compatibility shims; do not create new runtime or config ownership under them.
- V3-owned legacy-config readers may translate supported input into V3 contracts. They do not revive a V2 runtime.

## Semantic Invariants

- General safety, ablation, rule precedence, and review policy inherit the global AGENTS.md. This section adds RouteCodex protocol and ownership constraints.
- Proxy behavior stays transparent: preserve request, response, history, and observable protocol meaning.
- Inbound parses and normalizes fields; Chat Process governs semantics; adjacent outbound codecs project target protocol.
- Unsupported or lossy mapping fails explicitly at the owning adjacent boundary.
- No guessed repair, fallback, downgrade, silent drop, hidden history rewrite, or success-wrapped error.
- Control state uses typed control resources or Error chain only. Business payload cannot carry or reconstruct it.
- Request, response, and error graphs remain separate.

## Runtime Ownership

- Server: listener, HTTP/WebSocket framing, body limits, client disconnect.
- Runtime: only complete request lifecycle and fixed node/hook order.
- Chat Process: tool/history governance and continuation restore/save boundaries.
- Virtual Router: classify and select one opaque route target.
- Target Interpreter: expand candidates and reselect only inside selected target.
- Provider: wire construction, auth, transport, compatibility, provider health mutation.
- Error: classify source failure, plan action, decide exhaustion, project client error.
- Debug: logs, snapshots, dry-run, replay; never business truth.
- Direct: registered same-protocol branch. Relay: registered adjacent protocol codecs.

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
