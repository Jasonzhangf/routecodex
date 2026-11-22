# RouteCodex V3 Contract

## Highest Priority: Transparent Proxy

- RouteCodex is a transparent proxy. Its primary product goal is to increase the success rate of forwarding real client requests and returning real provider responses. For any parseable request or response, local validation must not impose narrower rules than the actual target protocol and reject traffic that the provider or client can handle.
- Preserve request, response, tool name, arguments, call ID, history, and matched tool result across the complete round trip. An invalid tool call returned by a model and the client's corresponding error result remain paired and are forwarded into the next turn so the model can correct itself; they are not grounds for a proxy-generated 502.
- Validation may diagnose and classify, but it must not become an extra admission boundary for otherwise forwardable business payload. Unrepresentable protocol data and genuine failures remain truthful in internal typed error resources and diagnostic evidence. The current provider-error terminal rule is declared in `.appsdk/requirements.json` under `routecodex-client-provider-error-decoupling` v9. No invented rejection, silent truncation, or success-wrapped error is permitted.

## Provider HTTP Errors and Provider Business Responses Are Different

- **Provider HTTP error response:** Keep its actual status, headers, body and cause in the typed Error chain. If another declared, untried eligible identity remains, continue to that identity and keep the failed response internal. Only a complete real non-2xx response from the actual exhausted final identity may be projected at the pre-business-commit client boundary using that entry's protocol. A prior attempt's witness, 2xx response followed by internal failure, incomplete body, transport failure, or locally generated error never qualifies and ends only that request's transport without a fabricated response. A single or final eligible candidate failure remains health-neutral: it receives no cooldown, probe, automatic retry, admission gate or recovery hold.
- **Provider correct/business response:** once a Provider has returned a response as model/business content, RouteCodex is not a semantic judge. Do not reject, suppress, or reinterpret that response because model arguments or tool parameters are invalid. Preserve the content and return it to the client as faithfully as the client protocol allows, so the client can report the issue and the model can correct it in a later turn.
- These rules are not in conflict: the first concerns Provider HTTP/error-channel responses; the second concerns business/model content returned by a Provider. Never classify model-generated invalid arguments as a Provider HTTP error, Provider health failure, or reason to switch Providers.
- Compatibility projection may perform only the transformations required by the target protocol. An allowlist/denylist field-selection mechanism does its declared mechanical job and makes no judgment: it does not judge model meaning, validate business correctness, classify errors, or decide whether a response is acceptable. If a target field is string-valued and the Provider returned a structured value, serialize that complete value faithfully. Do not turn a schema/parser preference mismatch into a locally generated `502 network_error` or a closed stream when the content can be represented.
- The protocol terminal `content_filter` is the Provider's own content filter reporting that it filtered the response. It is a legal Provider terminal, not a Provider failure: forward it (`status=incomplete` with `incomplete_details.reason=content_filter`; OpenAI Chat `finish_reason=content_filter`).
- Internal routing, cooldown, retry, and transport diagnostics stay in typed control/error resources. They must not rewrite, suppress, or fabricate business response semantics.
- Request failures and local response-processing failures enter the same typed Error chain. Preserve the request source, internal response 599, and actual upstream status separately. After all declared filtering and tool harvesting, a complete attempt without visible body, a complete tool call, refusal, content_filter or another independent business result becomes internal 502 and follows declared retry/reselection. Preserve reasoning alongside deliverable results; reasoning alone, pre-filter content and a normal terminal do not authorize success. Recognized tool-call leakage that cannot be completely harvested also fails the whole attempt through internal 502; representable model-generated invalid arguments remain business content. Whitespace, invisible characters and recognized protocol-only residue cannot fabricate a visible result; do not judge ordinary prose by meaning. Exhaustion terminates only the request transport detectably, without client error numbers, error payloads or a normal empty completion.
- Regression tests must prove that a non-final Provider HTTP error stays internal and triggers candidate recovery, and that a final complete real non-2xx response is projected only from that final identity. Internal failures and true transport failures must remain transport breaks. Separately prove that a successful Provider response containing invalid/model-generated arguments is faithfully returned and remains available to the client's next-turn correction flow. Unit-only tests do not replace public-entry evidence.

## Mandatory: Runtime Lifecycle — Only `rcc restart`, Never stop/start

- **禁止把 `rcc stop` + `rcc start`（或 `rcc start --restart`）当作重启手段。** 需要让新构建生效时，只调用一次 `rcc restart`（或 `rcc restart --port <locator-port>`），由**原进程/原 supervisor 在原 session 内**重新拉起 server child。
- 正式 `rccv3 restart`（含兼容入口 `rcc restart`）无需另行人类授权。每次加载新构建只执行一次正式 restart；失败后先查明原因，不盲目重复。禁止自行 spawn `start --restart` 接管。
- `rccv3 stop`、`rccv3 start`（含所有参数及兼容入口）仍须人类明确批准；不得用 stop+start 代替 restart。
- 4444/7777 承载用户与其他 agent 的实时流量。restart 前必须说明预计中断；stop/start 前必须说明中断并取得批准。禁止 `pkill`、`killall`、`kill $(...)`。
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
- Internal request and response classifications remain in the typed Error chain, which owns candidate switching, provider health and exhaustion. Only the complete real HTTP error from the exhausted final identity can qualify for client projection under the terminal rule above.
- SSE is the client communication boundary and is decoupled from Provider. The Server may establish the transport and send transport-only keepalives before the Runtime outcome. The Runtime privately buffers every Provider attempt and completes protocol validation, declared response governance and deliverable-result checks before projecting business frames. A failed attempt contributes no business frames to the client. Error records its typed cause and selects another declared eligible identity when available. A client receives the accepted attempt in protocol order, once. Complete tool items, protected business text, refusal, content_filter and associated reasoning retain their protocol semantics.
- Request admission imposes no limits. Remove business capacity and adaptive concurrency gates, business leases, FIFO permits, capability admission and Server/session admission. An accepted parseable request immediately reaches declared routing and transport. Empty tiers and pools immediately continue to declared successors. Requests never wait for Provider cooldown, probes or recovery, and never enter Deferred admission. Remove artificial attempt ceilings and sleep-to-residence-deadline branches. Only consecutive unresolved errors in the same session may incur a fixed two-second delay in that attempt's Error chain. The first error and normal new requests remain immediate. Real business success resets session error state. Other requests and sessions remain independent. Preserve actual transport timeouts, cancellation, byte-memory accounting and independently bounded background probes. Failed startup probes remain advisory and request failures remain request-local.
- Repeated provider transport/runtime failures are not closed by `switch_provider` alone. The first confirmed repeat pattern must become a typed provider policy/config change that removes the failed provider key from subsequent candidate selection until a successful probe restores it; the fix requires a regression test and live same-entry evidence.
- Remote provider first-byte wait is capped at 120 seconds: `sse_first_frame_timeout_ms` above 120000 is rejected at config compile. Only a provider declared `local = true` may exceed this cap. A remote candidate that produces no first frame within 120 seconds is a failed candidate; the request continues with the next tier or pool. `request_timeout_ms` independently bounds request setup and non-streaming HTTP bodies. Once an upstream SSE stream starts producing frames, use the rolling idle timeout and allow the stream to run past the request and residence deadlines.
- P0: provider health and request exclusions use the complete provider/interface/model/key identity within its listener. When the current request has an untried eligible successor, count ordinary real Provider HTTP 429 separately and measure the span from the first to the latest 429. At ten or more consecutive 429s within 120 seconds, cool the identity for 15 seconds and restore eligibility at expiry without a probe. Start a one-hour cooldown from the eleventh 429 onward only when the span strictly exceeds 120 seconds. Other real recoverable Provider HTTP errors, including 500 and 502, start a one-hour cooldown at the tenth consecutive error in their shared streak. Confirmed authentication, permission, account and exhausted quota failures start a one-hour cooldown immediately. Matching real business success resets the streaks. The final or only eligible candidate keeps the terminal health exception above. Other identities retain eligibility and may accept independent requests. Probe cadence and the request execution budget remain independent.
- A failed recovery probe advances only its own cadence. A matching HTTP 2xx probe can restore the complete identity once the cooldown has elapsed. A probe before expiry or a declaration of `health.advisory_probe = true` cannot override the active cooldown or another typed restriction.

## Runtime Ownership

- Provider health has two states for each complete identity in a listener. An identity is routable or visible in that listener's cooldown pool. Due, waiting and in-flight probes remain cooldown substates. A 15-second HTTP 429 cooldown restores routing at expiry. For a one-hour cooldown, matching HTTP 2xx probe success at or after expiry restores routing and removes the cooldown entry atomically.

- Server: listener, HTTP/WebSocket framing, body limits, client disconnect.
- Runtime: complete request lifecycle, fixed skeleton/node/hook order, provider transport relay, and complete attempt buffering and validation before client projection.
- Inbound: lossless request/response normalization only; no filtering or payload rewriting.
- Chat Process: Relay-only payload rewriting, standard Chat semantic mapping, non-Chat extension governance, tool/history governance, and continuation restore/save boundaries.
- Outbound: canonical Chat and extension projection to the target standard protocol; declared allowlists/denylists select compatible mappings, never reject or discard unmatched business fields by themselves.
- Compat: provider-private protocol adjustments only.
- Virtual Router: classify and select one opaque route target.
- Target Interpreter: expand candidates and reselect only inside selected target.
- Provider: wire construction, auth, transport, and provider health mutation.
- SSE: own client-facing framing and project committed business payloads or a qualified final Provider error using the client protocol. End an uncompletable transport without fabricating a response.
- Error: classify the source, plan recovery, decide exhaustion and publish the typed internal outcome. Qualify only the actual final Provider error for the Server to project.
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
| ordinary tools, hosted search, bounded refill and servertool retirement | `docs/agent-routing/30-servertool-lifecycle-routing.md` |
| task memory | `docs/agent-routing/40-task-memory-routing.md` |
| AppSDK governance and legacy ablation | installed `~/.agents/skills/appsdk-project-governance/SKILL.md` |

## LayerFS Task Branch & Git Workflow

RouteCodex 已启用 LayerFS 作为主开发与 Git 同步流程；新任务不再新建 Git worktree，按 LayerFS Skill 执行分支同步、publish、Git 集成与验收。

- 新任务使用 LayerFS task branch 开发，在项目专属 Workspace 内运行；并发任务各有独占 task branch 和唯一 writer。已经同步、空闲且没有未交付内容的工作线可以复用，不为每个后续任务重建。
- Git main 由 master 管理。Git 同步工作线只负责 Git main 与 LayerFS main 之间的同步（从 Git 获取主线变化，保存 LayerFS commit，并 publish 到 LayerFS main）；task 工作线只负责自身与 LayerFS main 之间的同步。Git main 与 task branch 不直接管理彼此，通过 LayerFS main 交换更新。具体步骤以 `layerfs` Skill 为准。
- 每次 LayerFS publish 前，在实际待发布候选上运行并通过项目本地 CI。CI 失败时保留原错，修复并重新验证后再 publish；不得 publish 或绕过失败。
- master 管理独立 Git 元数据与任务提交捕获；多个任务提交可汇合为一个 PR。PR 合并并核对远端后，由 Git 同步工作线更新 LayerFS main。
- 已有 Git worktree 继续由原 owner 完成原任务和 PR；合并后按规则关闭。不强删、不覆盖、不中断活动、dirty 或尚有未交付内容的工作树；不动他人资源或共享 base。
- 项目专属事实（`rccv3`、4444/7777、`~/.rcc/config.toml`）记录于本规则；通用分支复用、publish、Git 同步流程引用 `layerfs` Skill，不写入其他项目的路径、Store 或运行入口。
- 运行入口使用通用 `layerfs --project routecodex`（或 `LAYERFS_PROJECT=routecodex`），项目的 Store 与运行环境差异由项目配置承载；不再写入项目专用命令包装或其他项目的固定路径。

## Evidence Boundary

Report source, test, build, install, restart, health, same-entry replay, review, merge, and remote receipt separately. Never infer a later level from an earlier one.

## Standard Defect Delivery Flow

`rcc-dev-skills` owns the V3 defect procedure; see
`.agents/skills/rcc-dev-skills/references/60-defect-lifecycle.md` for its
issue, sample-audit, and resource-close DAGs. AppSDK's project-governance Skill
owns bug intake and solution-record commands. Use the installed Skill above;
the pinned `.appsdk/skills/` distribution is not the daily procedure owner.
This section fixes the project
contract and terminal conditions; it does not define a second command flow.

Every execution-bound local defect, including one found in post-restart Codex
samples, must be deduplicated or recorded in the project bug tracker and carry
its authoritative issue ID to a solution receipt. Every repeated regression
requires a regression test in the mapped required gate. Each issue runs on its
own LayerFS task branch from the latest LayerFS main; do not reproduce or fix
separate issues in one shared branch, and do not create a new Git worktree.
Classify provider sample errors from their typed cause and a probe bound to the same provider,
interface, auth-key identity, and model. A later probe success is an independent
attempt, not proof that an earlier payload failure was local. Confirmed local
failures and unresolved causes keep the sample gate open. Confirmed upstream
capacity failures or transport failures may be recorded as upstream exceptions;
they are not passing payloads or local fixes. The sole classification procedure
and retention limits are in
`.agents/skills/rcc-dev-skills/references/60-defect-lifecycle.md`.

Do not start issue work until canonical AppSDK intake/dedup returns the bug ID.
If intake is unavailable, report the blocker and recovery condition before
opening a task branch/workspace; never substitute a local tracker or fabricated ID. The
issue owner carries the issue through its gates and cleanup, independent
reviewers own their review verdicts, the authorized delivery owner handles
merge/push, and the master owns the separate residual-resource inventory.

Each issue run has one entry and one disposition exit:

```text
bug intake/dedup -> issue-owned LayerFS task branch from latest LayerFS main
-> reproduce + bind feature DAG/maps, first divergence, unique owner, and regression evidence
-> minimal owner-scoped fix -> fetch/combine latest origin/main
-> mapped tests/build + author debug + real-entry E2E or scoped consumer verification
-> when runtime-impacting: install/restart candidate, check health/replay, audit Codex samples
-> independent overall architecture review under the global host contract -> candidate commit
-> applicable PR CI PASS -> recheck origin/main -> merge validated candidate into clean main -> push
-> remote receipt
-> post-merge verification: runtime path rebuild/install/restart -> health -> real-entry replay -> sample audit; otherwise scoped consumer check
-> issue-owner cleanup of its task branch/workspace and temporary resources
-> one bug disposition receipt: solved or open
```

The global host orchestrator owns delivery order and independent review roles.
Author verification and applicable candidate runtime acceptance precede the
independent overall review; review and applicable CI must pass before integration.
Fix blocking findings in their owner and revalidate the affected behavior.
Required repository checks and Git protection remain enforced.

Before merge, a newer `origin/main` or any candidate change invalidates only
evidence whose bound inputs changed. Record the new candidate under the same
bug ID and rerun affected gates and E2E. The independent review covers the
tested changes; do not reuse results for changed behavior. Before external
release preparation, do not compute or compare SHA/checksums, freeze snapshots,
bind candidate identities, reconstruct patches, or add packaging checks. Use
necessary diffs, actual behavior results and ordinary Git receipts. Release
checks cover actual distribution needs only.

`solved` requires every applicable test/build/E2E and runtime gate, an effective
independent architecture review, merge and remote receipts,
post-merge replay and sample audit after any managed restart, and
verified removal of the issue owner's resources. Post-merge verification uses
the real entrypoint for runtime changes and the scoped consumer for non-runtime
changes; sample audit covers every managed restart in the issue run. Any failed
or unavailable gate, resource-cleanup failure, review finding,
unresolved/local regression sample, merge/push failure, or
cancellation reaches the same `open` disposition with cause, owner, recovery
condition, and retained-resource state. Keep an active or blocked task branch/workspace; do
not clean resources still needed for recovery. A candidate commit, review,
artifact, restart, or health result alone never proves the bug solved.

The master has a separate residual-resource DAG at scheduling close:

```text
inventory remaining Git worktrees, LayerFS task branches/workspaces, tmp/logs/forwards/processes
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
