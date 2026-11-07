# RouteCodex V3 Contract

## Highest Priority: Transparent Proxy

- RouteCodex is a transparent proxy. Its primary product goal is to increase the success rate of forwarding real client requests and returning real provider responses. For any parseable request or response, local validation must not impose narrower rules than the actual target protocol and reject traffic that the provider or client can handle.
- Preserve request, response, tool name, arguments, call ID, history, and matched tool result across the complete round trip. An invalid tool call returned by a model and the client's corresponding error result remain paired and are forwarded into the next turn so the model can correct itself; they are not grounds for a proxy-generated 502.
- Validation may diagnose and classify, but it must not become an extra admission boundary for otherwise forwardable business payload. Unrepresentable protocol data and genuine failures remain truthful in internal typed error resources and diagnostic evidence; the client error-response prohibition below applies without exception. No invented rejection, silent truncation, or success-wrapped error is permitted.

## Provider HTTP Errors and Provider Business Responses Are Different

- **Provider HTTP error response:** Provider failure, not client response data. Keep the actual status, body and cause in the typed Error chain; try the next eligible Provider. A mid-chain Provider HTTP error or a proxy-generated replacement error response must never be returned to the model client. If all eligible Providers fail, terminate only that request's transport without forwarding the Provider error payload and without fabricating success; the sole exception is the v27 normal last-candidate rule below, where a complete real upstream HTTP error returns its original status, body bytes, and legal end-to-end headers once no client HTTP head is committed.
- **Provider correct/business response:** once a Provider has returned a response as model/business content, RouteCodex is not a semantic judge. Do not reject, suppress, or reinterpret that response because model arguments or tool parameters are invalid. Preserve the content and return it to the client as faithfully as the client protocol allows, so the client can report the issue and the model can correct it in a later turn.
- These rules are not in conflict: the first concerns Provider HTTP/error-channel responses; the second concerns business/model content returned by a Provider. Never classify model-generated invalid arguments as a Provider HTTP error, Provider health failure, or reason to switch Providers.
- Compatibility projection may perform only the transformations required by the target protocol. An allowlist/denylist field-selection mechanism does its declared mechanical job and makes no judgment: it does not judge model meaning, validate business correctness, classify errors, or decide whether a response is acceptable. If a target field is string-valued and the Provider returned a structured value, serialize that complete value faithfully. Do not turn a schema/parser preference mismatch into a locally generated `502 network_error` or a closed stream when the content can be represented.
- The protocol terminal `content_filter` is the Provider's own content filter reporting that it filtered the response. It is a legal Provider terminal, not a Provider failure: forward it (`status=incomplete` with `incomplete_details.reason=content_filter`; OpenAI Chat `finish_reason=content_filter`).
- Internal routing, cooldown, retry, and transport diagnostics stay in typed control/error resources. They must not rewrite, suppress, or fabricate business response semantics.
- Request failures and local response-processing failures enter the same typed Error chain. Preserve the request source, internal response 599, and actual upstream status separately. After all declared filtering and tool harvesting, a complete attempt without visible body, a complete tool call, refusal, content_filter or another independent business result becomes internal 502 and follows declared retry/reselection. Preserve reasoning alongside deliverable results; reasoning alone, pre-filter content and a normal terminal do not authorize success. Recognized tool-call leakage that cannot be completely harvested also fails the whole attempt through internal 502; representable model-generated invalid arguments remain business content. Whitespace, invisible characters and recognized protocol-only residue cannot fabricate a visible result; do not judge ordinary prose by meaning. Exhaustion terminates only the request transport detectably, without client error numbers, error payloads or a normal empty completion; the sole exception is the v27 normal last-candidate rule below, which returns the original complete HTTP error without fabricating a proxy error or a success.
- Regression tests must prove that a mid-chain Provider HTTP error is not returned to the client and triggers candidate recovery where possible; separately prove the normal last-candidate exception returns the original complete HTTP error, and that a successful Provider response containing invalid/model-generated arguments is faithfully returned and remains available to the client's next-turn correction flow. Unit-only tests do not replace public-entry evidence.

## Mandatory Review: Provider Switching and Request Independence

- 用户于 2026-11-03 要求所有真实执行错误切换其他合格 Provider，请求独立、不被阻塞。模型返回的可保真业务内容不是代理执行错误，仍按透明代理合同返回。
- 用户于 2026-11-06 明确：任何情况下都不 retry the same。当前请求中真实失败的完整身份不得自动业务重发；失败集合跨 default、refill 和独立 probe 成功保留。HTTP 429 与普通错误共用 typed Error 和候选切换路径，不做 429 专属排除、冷却、恢复、并发降额或请求等待。此条替代旧 429 episode/minimum/required-probe/健康中立特例；原始 status、body、cause 仍保真记录。
- canonical `.appsdk/requirements.json` 根版本 27 的 `routecodex-last-provider-failure-terminal-policy` v4 明确：已选候选真实失败后，原 Target owner 一次正常证明没有同 target 的 eligible 替代时，本次不写 health/冷却/观察或新增 probe，不准入、不等待、不自动重发；保留原始 typed Error，并将末次完整真实 HTTP 错误按原 status、原 body 字节与合法 end-to-end headers 透传到未提交 client head 的客户端，不伪造成功或代理错误。有替代时才应用适用普通健康动作并直接消费捕获选择。选择解析故障、初始暂态池空、显式 pin 范围、非 HTTP/不完整 body 和已提交 client head 不据此泛化透传；未验收处保持 OPEN。多候选也不得恢复已退役的业务准入或泄漏中间候选错误。
- 用户于 2026-11-05 明确：Provider 探测、冷却、恢复有独立生命周期，只影响完整 provider/interface/model/key 在所属 listener 的 VR 可见性。此条替代旧请求恢复等待和先 probe 后 fallback 条款。
- VR 当次在可见池按声明的 tier、pool、default pool 路径命中最高优先级 provider > model.key。请求消费已捕获选择后立即 transport，不二次按健康选路，不等待 probe、冷却、恢复、FIFO 或 permit，不承载生命周期 witness/ticket/permit，也不受本地 attempt/store 容量准入控制。真实失败经 typed Error 回交原选择 owner，不排除未尝试身份，不阻塞兄弟请求。
- refill 是独立的 Chat Process 业务续写规则：连续最多额外一次，原始执行不计，0 可关闭，配置不得放宽为多次。错误候选切换不扣 refill，也不重置已用次数。新 refill 执行按当前可见性选择，不复用原始失败选择。
- 每次 Review 必须显式审计这些契约并亲读当前适用需求。真实入口证据须证明错误后替代完成、健康并发继续、probe 尚未完成时空可见池仍可走 default、取消和原始 deadline 有效、Provider 错误不泄露客户端、refill 不超过一次。无证据标 UNVERIFIED，证实违约为阻断 finding，不以最终 200 或单测通过替代。
- SSE 首帧提交后仍审计错误恢复、Provider 切换和帧保真；已交付帧不得撤回、重复或伪造。不能以直接断流作为切换成功或豁免证据；未闭合处由唯一 owner 修订并验证。

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
- Internal request/response classifications and upstream status codes belong to internal typed Error resources and diagnostics only. They never authorize a client HTTP status, error payload, or terminal failure event; the no-client-error contract above also covers complete route-pool exhaustion. Candidate switching and provider health remain in the typed Error chain.
- SSE is the client communication boundary and is decoupled from Provider. The Server may establish the client SSE transport channel and transport-only keepalives before the runtime outcome exists; that transport accept is not a semantic client commit, and the Runtime fully buffers every provider attempt before any provider payload byte is projected except under first-frame commit. With first-frame commit enabled, the first committable business frame crosses the client channel at its provider arrival time; the Direct content probe certifies the commit only once client-visible business content exists (visible output_text or a named tool-call start) and no governed text marker has appeared, delivered frames are never rewritten, replaced, suppressed, or re-emitted, a tool-call argument payload stays behind the completeness gate until its item completes, that gate and the tool-call certification are decided only by the incremental item carriers (`output_item.added`/`output_item.done`) and the terminal snapshot, so a non-terminal `created`/`in_progress`/`queued` state mirror never certifies a start and never releases the gate, and the terminal remainder replays only the undelivered tail. After the commit the probe is only a hold signal: while the newest text may still be governed, the collector suspends projection, keeps those frames inside the attempt, and the registered complete-attempt owner decides the whole attempt at the terminal, so protected business text (fenced or inline code, quoted text) is replayed unchanged instead of truncating the response, and governed text never reaches the client. The request-level predicate only filters which attempts carry the probe; DSML and thinking rewrites run for the whole attempt. Provider errors enter the Error chain independently of client response projection: a client never receives a provider error payload on the committed client channel, the Error chain records and prints the cause, candidate switching stays inside the Runtime before any client payload is committed, and after delivery a provider failure records provider health for the attempted identity, switches no candidate, and ends the committed transport as a 200 SSE body break without an error frame, keepalive, or normal terminator.
- Provider startup probes are advisory: a failed or unavailable probe must never block listener startup, terminate the server, or count as a business/provider transport attempt. A provider request failure is request-local and must not terminate other sessions or the aggregate server; recovery and client projection stay in the typed Error chain. When Target10 selects a later route tier, it probes each preceding tier's cooled, request-eligible candidate once before committing to that fallback; probe failure preserves cooldown and never blocks the request.
- Repeated provider transport/runtime failures are not closed by `switch_provider` alone. The first confirmed repeat pattern must become a typed provider policy/config change that removes the failed provider key from subsequent candidate selection until a successful probe restores it; the fix requires a regression test and live same-entry evidence.
- Remote provider first-byte wait is capped at 120 seconds: `sse_first_frame_timeout_ms` above 120000 is rejected at config compile. `request_timeout_ms` is the whole-request budget and is not capped by this rule, so a long healthy stream is not cut off. Only a provider declared `local = true` may exceed the first-byte cap. A remote candidate that produces no first frame within 120 seconds is a failed candidate; the request continues with the next tier or pool instead of extending the wait.
- P0: every automatic failure exclusion, health mutation, cooldown and recovery probe is independent for the complete provider/interface/model/key identity within its listener. No error may exclude untried keys, other models, interfaces, providers or listeners. All real failures, including HTTP 429, preserve their raw status, body and cause in the typed Error chain and immediately select another currently visible matching identity through the same ordinary policy. Do not retain a 429-specific episode, minimum cooldown, required-probe disposition, health-neutral bypass or concurrency reduction. Ordinary typed error thresholds, precool observation and independent recovery probes remain in their existing owner and change only pool visibility. A probe success cannot clear the current request's failed-identity set. Requests never wait for capacity, cooldown, probes, recovery, FIFO, permits or attempt/store budgets and do not recheck a captured selection. Real client cancellation, the original request deadline and real transport failure retain their own semantics. Ordinary recovery probes use the 5s → 10s → 30s → 60s → 120s → 900s → 1800s ladder; a verified HTTP 2xx needs no response-body validation but cannot bypass another ordinary typed restriction. Failed probes never block startup or other sessions. Passable business responses and model-generated argument errors are not provider failures.
- A failed recovery probe advances only its own cadence and does not advance the business cooldown ladder. A declared `health.advisory_probe = true` makes ordinary probe scheduling advisory; it does not bypass another ordinary typed restriction or clear request-local failure exclusions.

## Runtime Ownership

- Provider health has two states for each complete `provider.model.key`: routable or visible in the cooldown pool. Due, waiting and in-flight recovery probes remain cooldown substates; expiry alone must not hide an excluded identity. Matching HTTP 2xx probe success restores routing and removes its cooldown entry atomically.

- Server: listener, HTTP/WebSocket framing, body limits, client disconnect.
- Runtime: complete request lifecycle, fixed skeleton/node/hook order, provider transport relay, pre-commit attempt buffering, and the append-only client frame ledger after first-frame commit.
- Inbound: lossless request/response normalization only; no filtering or payload rewriting.
- Chat Process: Relay-only payload rewriting, standard Chat semantic mapping, non-Chat extension governance, tool/history governance, and continuation restore/save boundaries.
- Outbound: canonical Chat and extension projection to the target standard protocol; declared allowlists/denylists select compatible mappings, never reject or discard unmatched business fields by themselves.
- Compat: provider-private protocol adjustments only.
- Virtual Router: classify and select one opaque route target.
- Target Interpreter: expand candidates and reselect only inside selected target.
- Provider: wire construction, auth, transport, and provider health mutation.
- SSE: client-facing transport framing and projection of committed successful business payloads; terminate an uncompletable transport without error semantics or fabricated success. The sole exception is the v27 normal last-candidate exhaustion with a complete real HTTP error, projected before client head commit rather than as a post-commit SSE event.
- Error: classify source failure, plan recovery, decide exhaustion, and publish typed internal outcomes; never project an error response to a model client. The sole authorized projection is the typed normal last-candidate exhaustion variant carrying a complete real upstream HTTP error, consumed by the Server only while no client HTTP head is committed.
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
