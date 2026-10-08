# RouteCodex V3 Contract

## Highest Priority: Transparent Proxy

- RouteCodex is a transparent proxy. Its primary product goal is to increase the success rate of forwarding real client requests and returning real provider responses. For any parseable request or response, local validation must not impose narrower rules than the actual target protocol and reject traffic that the provider or client can handle.
- Preserve request, response, tool name, arguments, call ID, history, and matched tool result across the complete round trip. An invalid tool call returned by a model and the client's corresponding error result remain paired and are forwarded into the next turn so the model can correct itself; they are not grounds for a proxy-generated 502.
- Validation may diagnose and classify, but it must not become an extra admission boundary for otherwise forwardable business payload. Unrepresentable protocol data and genuine failures remain truthful in internal typed error resources and diagnostic evidence; the client error-response prohibition below applies without exception. No invented rejection, silent truncation, or success-wrapped error is permitted.

## Provider HTTP Errors and Provider Business Responses Are Different

- **Provider HTTP error response:** Provider failure, not client response data. Keep the actual status, body and cause in the typed Error chain; try the next eligible Provider. Never return a Provider HTTP error response or a proxy-generated replacement error response to the model client. If all eligible Providers fail, terminate only that request's transport without forwarding the Provider error payload and without fabricating success.
- **Provider correct/business response:** once a Provider has returned a response as model/business content, RouteCodex is not a semantic judge. Do not reject, suppress, or reinterpret that response because model arguments or tool parameters are invalid. Preserve the content and return it to the client as faithfully as the client protocol allows, so the client can report the issue and the model can correct it in a later turn.
- These rules are not in conflict: the first concerns Provider HTTP/error-channel responses; the second concerns business/model content returned by a Provider. Never classify model-generated invalid arguments as a Provider HTTP error, Provider health failure, or reason to switch Providers.
- Compatibility projection may perform only the transformations required by the target protocol. An allowlist/denylist field-selection mechanism does its declared mechanical job and makes no judgment: it does not judge model meaning, validate business correctness, classify errors, or decide whether a response is acceptable. If a target field is string-valued and the Provider returned a structured value, serialize that complete value faithfully. Do not turn a schema/parser preference mismatch into a locally generated `502 network_error` or a closed stream when the content can be represented.
- The protocol terminal `content_filter` is the Provider's own content filter reporting that it filtered the response. It is a legal Provider terminal, not a Provider failure: forward it (`status=incomplete` with `incomplete_details.reason=content_filter`; OpenAI Chat `finish_reason=content_filter`).
- Internal routing, cooldown, retry, and transport diagnostics stay in typed control/error resources. They must not rewrite, suppress, or fabricate business response semantics.
- Regression tests must prove that a Provider HTTP error is not returned to the client and triggers candidate recovery where possible; separately prove that a successful Provider response containing invalid/model-generated arguments is faithfully returned and remains available to the client's next-turn correction flow. Unit-only tests do not replace public-entry evidence.

## Mandatory: Runtime Lifecycle — Only `rcc restart`, Never stop/start

- **禁止把 `rcc stop` + `rcc start`（或 `rcc start --restart`）当作重启手段。** 需要让新构建生效时，只调用一次 `rcc restart`（或 `rcc restart --port <locator-port>`），由**原进程/原 supervisor 在原 session 内**重新拉起 server child。
- **`rcc stop`、`rcc start --snap`、`rcc restart` 均须人类明确批准。** 未取得明确批准不得对 live runtime 执行任何 lifecycle 动作；live runtime 存在时 `rcc restart` 只允许调用一次，禁止自行 spawn `start --restart` 接管。
- 4444/7777 承载用户与其他 agent 的实时流量。任何 lifecycle 动作前必须先说明将造成的中断并取得批准；禁止 `pkill`、`killall`、`kill $(...)`。
- 依据：`docs/loops/runtime-lifecycle/gate-matrix.md`（Blackbox 层）与 `docs/design/server-runtime-lifecycle-ssot.md`（`rcc restart` 第 6、9、10 条）。
- 反例（2026-10-04）：用 stop+start 代替 `rcc restart`，导致 4444 中断并触发 supervisor 二次拉起，用户明确抗议。禁止重犯。

## Project Truth

- RouteCodex V3 is the only active production implementation.
- RouteCodex V4 is a refactor of V3 and is not connected to the production baseline.
- RouteCodex V2 is retired completely. Do not retain or restore a V2 runtime, V2 config reader, V2 migration path, or V2 backup.
- Runtime, routing, protocol projection, provider execution, lifecycle, and CLI live in the `v3/` Rust workspace.
- Installed command: `rccv3`. Default V3 authoring file and active local 4444 route config: `~/.rcc/config.toml`; verify with `rccv3 config check -c ~/.rcc/config.toml` and `rccv3 status -c ~/.rcc/config.toml`. Debug samples: `~/.rcc/codex-samples`; locate a failing request by endpoint, port and request ID before replay.
- `routecodex` and `rcc` are compatibility shims; do not create new runtime or config ownership under them.

## Semantic Invariants

- **Highest protocol priority: RouteCodex is a transparent proxy whose goal is to maximize successful pass-through.** Field and protocol-shape validation selects mappings and supplies diagnostics; it is never, by itself, a reason to reject a client request or provider response. Preserve unknown or unrepresentable business fields as opaque data through the paired request/response cycle. A model-generated semantic/tool error and a provider response that is validly preservable must reach the client; they must not become a proxy-generated `502 network_error`. Repair the responsible mapping; do not fail locally, silently drop data, or change its meaning. Actual transport failures and irrecoverable protocol boundaries remain explicit in their owning error path.
- General safety, ablation, rule precedence, and review policy inherit the global AGENTS.md. This section adds RouteCodex protocol and ownership constraints.
- The runtime is a fixed skeleton configured by typed declarations. Data-plane payloads and control-plane resources remain physically separate.
- Proxy behavior stays transparent: maximize cross-protocol compatibility and connectivity while preserving request, response, history, and observable protocol meaning. Extra semantic validation must not reject a passable request or intercept a compatible response.
- Every request enters as JSON. Inbound only performs lossless request/response normalization into Chat Process: it preserves every field, maps Chat semantics into the canonical Chat shape, and carries non-Chat semantics as extensions. Inbound never filters or rewrites payload meaning.
- Relay payload rewriting is owned only by request/response Chat Process. Direct payload rewriting is owned only by registered Direct hooks. No other stage rewrites payloads.
- Outbound projects canonical Chat plus extensions into the target standard protocol. It forwards business fields without a known compatible mapping as opaque original values, preserving their inverse association; allowlists and denylists may choose a known mapping, but may not discard or locally reject business fields.
- Provider Compat performs only provider-private adjustments after standard outbound projection and before or after provider transport as declared. It is not a second Chat Process or a general Outbound implementation.
- Request-shape regressions require a real public-entry black-box test that asserts the selected provider accepts the first attempt, preserves tools and paired history, and completes actual client tool execution plus follow-up. A final client 200 after provider switching does not prove shape compatibility. Cover the failing combination of hosted declarations and tool history; a fixture that unconditionally returns 200 cannot lock this regression. Explicit gateway profiles and their required tests are bound in `docs/architecture/v3-verification-map.yml`.
- No guessed repair, fallback, downgrade, silent drop, hidden history rewrite, or success-wrapped error.
- Control state uses typed control resources or Error chain only. Business payload cannot carry or reconstruct it.
- Request, response, and error graphs remain separate.
- Internal request/response classifications and upstream status codes belong to internal typed Error resources and diagnostics only. They never authorize a client HTTP status, error payload, or terminal failure event; the no-client-error contract above also covers complete route-pool exhaustion. Candidate switching and provider health remain in the typed Error chain.
- SSE is the client communication boundary and is decoupled from Provider. The Server may establish the client SSE transport channel and transport-only keepalives before the runtime outcome exists; that transport accept is not a semantic client commit, and the Runtime still fully buffers every provider attempt before any provider payload byte is projected. Provider errors enter the Error chain independently of client response projection: a client never receives a provider error payload on the committed client channel, the Error chain records and prints the cause, and candidate switching stays inside the Runtime before any client payload is committed.
- Provider startup probes are advisory: a failed or unavailable probe must never block listener startup, terminate the server, or count as a business/provider transport attempt. A provider request failure is request-local and must not terminate other sessions or the aggregate server; recovery and client projection stay in the typed Error chain. When Target10 selects a later route tier, it probes each preceding tier's cooled, request-eligible candidate once before committing to that fallback; probe failure preserves cooldown and never blocks the request.
- Repeated provider transport/runtime failures are not closed by `switch_provider` alone. The first confirmed repeat pattern must become a typed provider policy/config change that removes the failed provider key from subsequent candidate selection until a successful probe restores it; the fix requires a regression test and live same-entry evidence.
- Provider health uses the existing typed failure threshold and same-fingerprint streak for its exact provider+auth key+model identity. An isolated recoverable failure must not create global cooldown; the default threshold is two consecutive failures, and a real success clears the streak. Declared terminal authentication/account or manual-disable policies retain their explicit scope and threshold. Once cooldown begins, the first recovery probe is due after 5 seconds, and consecutive failures/probe failures advance the shared 5s → 10s → 30s → 60s → 120s → 900s → 1800s ladder per identity. A successful semantic probe resets the ladder; failed probes remain expected, preserve cooldown, and never block startup or other sessions. Declared request-local provider compatibility failures exclude only the failed candidate for that request and remain health-neutral; an unconfirmed cause does not create a new cooldown or health exemption.

## Runtime Ownership

- Server: listener, HTTP/WebSocket framing, body limits, client disconnect.
- Runtime: complete request lifecycle, fixed skeleton/node/hook order, provider transport relay, and full-attempt buffering.
- Inbound: lossless request/response normalization only; no filtering or payload rewriting.
- Chat Process: Relay-only payload rewriting, standard Chat semantic mapping, non-Chat extension governance, tool/history governance, and continuation restore/save boundaries.
- Outbound: canonical Chat and extension projection to the target standard protocol; declared allowlists/denylists select compatible mappings, never reject or discard unmatched business fields by themselves.
- Compat: provider-private protocol adjustments only.
- Virtual Router: classify and select one opaque route target.
- Target Interpreter: expand candidates and reselect only inside selected target.
- Provider: wire construction, auth, transport, and provider health mutation.
- SSE: client-facing transport framing and projection of committed successful business payloads; terminate an uncompletable transport without error semantics or fabricated success.
- Error: classify source failure, plan recovery, decide exhaustion, and publish typed internal outcomes; never project an error response to a model client.
- Debug: logs, snapshots, dry-run, replay; never business truth.
- Direct: default for a same-protocol target unless configuration explicitly selects Relay; all payload rewrites occur inside registered Direct hooks.
- Relay: selected for cross-protocol execution or by explicit configuration; all payload rewrites occur inside Chat Process.
- Direct still reaches Provider through the runtime provider transport relay. That transport relay is distinct from the Relay protocol-conversion execution mode.

## Architecture Truth

- DAGPipe 业务目标、逐模块接入状态与静态图治理入口：`docs/architecture/dagpipe/README.md`。先审业务图，再核对现有 map 和代码；未登记图不代表模块已接入。DAGPipe CLI 校验只证明静态拓扑，不能证明 Operator 编译或代理真实入口。
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
| servertool | `docs/agent-routing/30-servertool-lifecycle-routing.md` |
| task memory | `docs/agent-routing/40-task-memory-routing.md` |
| AppSDK lifecycle | `.appsdk/skills/appsdk-project-governance/SKILL.md` |

## Evidence Boundary

Report source, test, build, install, restart, health, same-entry replay, review, merge, and remote receipt separately. Never infer a later level from an earlier one.

## Standard Defect Delivery Flow

`rcc-dev-skills` owns the V3 defect procedure; see
`.agents/skills/rcc-dev-skills/references/60-defect-lifecycle.md` for its
issue, sample-audit, and resource-close DAGs. AppSDK's project-governance Skill
owns bug intake and solution-record commands. This section fixes the project
contract and terminal conditions; it does not define a second command flow.

Every execution-bound local defect, including one found in post-restart Codex
samples, must be deduplicated or recorded in the project bug tracker and carry
its authoritative issue ID to a solution receipt. Every repeated regression
requires a regression test in the mapped required gate. Each issue gets its own
clean worktree under `playground/<issue-id>` from the latest `origin/main`; do
not reproduce or fix separate issues in one shared worktree. Classify provider
sample errors using the typed probe bound to the same provider, auth-key
identity, and model: probe success with payload failure is a local request
problem; a sample-bound probe failure may be excluded as upstream; an unbound
probe is unresolved and cannot pass the sample gate.

Do not start issue work until canonical AppSDK intake/dedup returns the bug ID.
If intake is unavailable, report the blocker and recovery condition before
creating a worktree; never substitute a local tracker or fabricated ID. The
issue owner carries the issue through its gates and cleanup, independent
reviewers own their review verdicts, the authorized delivery owner handles
merge/push, and the master owns the separate residual-resource inventory.

Each issue run has one entry and one disposition exit:

```text
bug intake/dedup -> issue-owned clean worktree at latest origin/main
-> reproduce + bind feature DAG/maps, first divergence, unique owner, and regression evidence
-> minimal owner-scoped fix -> fetch/combine latest origin/main -> candidate commit + exact SHA
-> mapped tests/build + author debug + real-entry E2E or scoped consumer verification
-> when runtime-impacting: install/restart candidate, check health/replay, audit Codex samples
-> applicable PR CI PASS -> recheck origin/main -> merge validated candidate into clean main -> push
-> candidate/main equivalence + remote receipt
-> post-merge verification: runtime path rebuild/install/restart -> health -> real-entry replay -> sample audit; otherwise scoped consumer check
-> independent Codex and AGY architecture reviews bound to the delivered main content and verified candidate
-> issue-owner cleanup of its worktree/playground and temporary resources
-> one bug disposition receipt: solved or open
```

**项目交付顺序：作者验证和适用 CI 通过后，先合并到 main、从 main 重建安装并重启、完成真实入口验收，再等待并完成独立架构 review。** Review pending does not block this main/runtime sequence; it does block defect closure and any claim of complete delivery. Required repository checks and Git protection remain enforced. A blocking review finding requires an owner-scoped repair and affected verification; a confirmed regression caused by the delivered change follows the traceable revert/rebuild/restart/replay recovery contract.

Before merge, a newer `origin/main` or any candidate change invalidates only
evidence whose bound inputs changed. Record the new candidate under the same
bug ID and rerun affected gates and E2E. Bind post-delivery reviews to that
exact candidate and prove its content equivalent to delivered main; do not
reuse a stale review as PASS for changed scope.

`solved` requires every applicable test/build/E2E and runtime gate, both
required architecture reviews, merge and remote receipts, candidate/main
equivalence, post-merge replay and sample audit after any managed restart, and
verified removal of the issue owner's resources. Post-merge verification uses
the real entrypoint for runtime changes and the scoped consumer for non-runtime
changes; sample audit covers every managed restart in the issue run. Any failed
or unavailable gate, resource-cleanup failure, review finding,
unresolved/local regression sample, merge/push failure, or
cancellation reaches the same `open` disposition with cause, owner, recovery
condition, and retained-resource state. Keep an active or blocked worktree; do
not clean resources still needed for recovery. A candidate commit, review,
artifact, restart, or health result alone never proves the bug solved.

The master has a separate residual-resource DAG at scheduling close:

```text
inventory remaining worktrees/playgrounds/tmp/logs/forwards/processes
-> bind each to owner, active/stale status, and evidence
-> coordinate the owner's authorized terminal disposition
-> remove only resources proven stale and authorized for cleanup
-> verify absence; retain unknown/active resources as open items
-> one residual-resource inventory receipt
```

The master owns the inventory and its receipt; resource owners perform cleanup
within their ownership. Never delete an unknown, active, shared, or other-owner
resource by assumption. No applicable node may be skipped or inferred from an
earlier node.
