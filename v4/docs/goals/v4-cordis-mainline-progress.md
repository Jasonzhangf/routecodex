# V4 Cordis 主线进度表

主树：`codex/v4-cordis-refactor-main`。所有 task merge target 固定为该主树；每个 milestone 完成后再合并仓库 `main`。

## 依赖图

```text
M00 -> M01 -> M02 --┐
  ├-> M03 ----------┼-> M04 -> M05 -> M06 -> M07 --┐
  ├-> D0 ----------┘                    M08 --------┼-> M09 -> M10 -> M11 -> M12
  └--------------------------------------┘
```

## 任务状态

| task | 当前状态 | 依赖 | 并行关系 |
|---|---|---|---|
| M00-T00 迁移计划 | `merged` | 无 | 已合并 `3b62ffd9a` |
| M00-T01 合同 | `merged` | 无 | 已进主树 |
| M00-T02 ratchet/protected promotion | `merged` | T01 | 已合并；canonical live admission 的 upstream HTTP 502 阻塞 M00 退出 |
| M00-T03 审计面 | `merged` | T01 | 已合并 `c4d13d7b8` |
| M00-T04 每 milestone 独立 claim 表 | `merged` | T03 | 已合并 `5e0090f9d` |
| M00-T05 live admission closeout | `blocked_by_provider_websocket_v2_endpoint` | T02 + T04 | 历史有效证据：A 首轮 HTTP 200；同 response-id continuation 要求 Responses WebSocket v2，当前 profile 无 HTTP 101；C continuation 503。最新 recheck 使用同一 profile 返回 provider `401 invalid_api_key`（Casdoor token validation failed），V4 `5520` 未监听；不得绕过 |
| M00-T06 canonical B wire evidence contract | `merged` | T01 + T03 | 已合并主树 `0bcd0e3ff` / merge `9f9ebc25d`；固定同 requestId 的 provider-request/provider-response diagnostic bundle，不改变 provider/continuation 语义 |
| M00-T07 live B capture binding contract | `merged` | T06 | 已合并独立 task `70ccc287b`，V4 主树 merge `3bec92d81`；绑定 provider-owned raw pair contract；无合法 owner/binding fail-closed；不实现 M08 runtime、不伪造 B 证据；M08 完成后再做 live integration |
| M00-T08 dependency reconciliation | `merged` | T01 + T03 + T04 | 已合并独立 task `764351194`，V4 主树 merge `0f353bee8`；拆分 T07 contract 与 M08 async/native runtime，消除循环依赖 |
| M00-T09 no-active-epoch admission | `merged` | T01 + T02 | 已合并独立 task `23220dceb`，V4 主树 merge `4298257666`；ActiveEpochStore 无 active epoch 时 fail-closed，6 项 L2、架构 gates、Active-linked build 与 AGY review 通过 |
| M01 NativePlugin ABI | `merged` | M00 structural contracts | task `7c7e141f5` 已合入重构主树 `100b9fd12`；主树 contract/catalog tests、plugin plan、resource binding `91/91`、diff check 通过；T05 独立保留 |
| M02 generic factory | `merged` | M01 | task `ff9065c8c` 已合入重构主树 `aa5518b50`；主树 host 30/30、red 10/10、release build、plugin tests 通过 |
| M03 Cordis daemon | `merged` | M00 structural contracts | task `8be1e7ced` 已合入重构主树 `3a425633c`；daemon 3/3、host 联测 30/30、red 10/10、release build 通过 |
| D0 differential harness | `merged` | M00 structural contracts | commit `2a48fe256` 已在 `codex/v4-cordis-refactor-main`；AGY PASS、merge queue 状态 `merged_main_tree`，worktree clean，无需重复实现 |
| M04 epoch transaction | `merged` | M02 + M03 | task `9914a69fe` 已以 merge `ba4af6c02` 合入重构主树；目标树定向 gates 全部通过，active-link 仍缺 frozen-consumer-registry 环境文件 |
| M05 ExecutionEngine | `in_progress` | M04 | 唯一 owner 已恢复其 runtime→plugin-contract 边并完成 red/partial-green；其独立 candidate 仍缺 build-link 注册、新 Active binding、candidate/protected projection，未 build/install/live/AGY/commit/merge |
| M06 request JSON | `blocked` | M05 | 必须串行 |
| M07 response JSON | `blocked` | M06 | 必须串行 |
| M08 async data plane | `blocked_waiting_m05_handoff` | M00 structural contracts + M00-T07 | provider/server 独立 slice 已交接（5/5 provider、2/2 server、locked check、diff-check、handoff PASS）；整体无合法并发实现面，待 M05 明确交接，runtime-bin async stream/cancellation、M00-T07 live evidence、full gates/live/AGY 未闭环；不得覆盖 M05 execution owner |
| M09 SSE | `blocked` | M07 + M08 | 必须串行 |
| M10 state semantics | `blocked` | M09 | 必须串行 |
| M11 protocols/tools/admin | `contract_preflight_merged` | M10 | M11-T01 前置合同已合入；实现仍依赖 M10，既有 host owner/catalog drift 仍需后续治理 |
| M12 parity/release | `blocked` | M11 + D0 | 最终串行收敛 |

## 周期

`audit → claim → isolated worktree → red → implement → boundary self-check → focused gates → build/live → evidence → checker → merge refactor main → refactor main reverify → milestone merge repo main → sync`。

任何 task 未合并并通过主树复验，依赖 task 保持 blocked；worker 不得直接写主树。

## 当前并发任务清单（2026-08-26）

| lane | task | 状态 | 是否可再派发 | 原因 / 收口条件 |
|---|---|---|---|---|
| execution owner | M05-T01 | `blocked_external_input_with_scope_ruling` | 否 | 父审计已完成 35 个物理文件分类：A=26 个在 claim 内，B=3 个 M05 gate 已获父任务批准扩展 claim，C=6 个 standard-plugins/real-pipeline gate 必须返还其他 owner；真实 Active-link/isolation 输入仍缺失；不得清理 C、伪造 artifact、clean、AGY、commit、merge |
| build-link owner | B01 | `blocked_external_input` | 否 | 独立 claim/worktree 内已完成并验证真实 consumer registry/mainline edge（23/23 resolver red、Active-link、execution-binding）；canonical `gen-index/verify-index` 对隔离 worktree 缺真实 frozen Active fail-fast，不得复制、伪造、软链或 allowlist；等待 Active/record-graph owner 提供 exact target input |
| Active lifecycle owner | B02 | `blocked_owner_handoff` | 否 | B02 隔离 worktree 的 `begin-version`/`publish-active`/`gen-index`/`verify-index` 均 fail-closed：`ACTIVE_INDEX_MISSING`、`MISSING_RECORD:module-artifact`、`ActiveLinkErr03ArtifactMissing`；AppSDK 0.1.5 源码确认 `module-artifact` 只能由 `compile_module→promote_module→freeze_module` 产生，现有 records/protected history 没有合法恢复命令。主 tree 的 canonical index 虽可生成，但其 `source_commit=555bee…` 与当前重构主 tree HEAD=`228130e96…` 不一致，不能作为 exact candidate；等待 `appsdk::lifecycle` / `appsdk::record_graph` 为当前 candidate 提供 module-artifact/Active input，禁止复制、软链、手写或 allowlist |
| differential governance | D0-T01 | `merged_and_ready_for_cleanup` | 否 | `2a48fe256` 已在重构主 tree；queue 标记 `merged_main_tree`，AGY PASS，worktree clean；可释放 claim/cleanup，不再阻塞 M05 |
| async data plane | M08-T01 | `blocked_waiting_m05_handoff` | 否 | provider/server 独立 slice 已完成并写入 handoff；整体无合法并发实现面，runtime-bin async stream/cancellation 尚未完成，必须等待 M05 交接，不覆盖 M05 |
| provider live admission | M00-T05 | `blocked` | 否 | Responses WebSocket v2 / credential blocker；不得猜 endpoint、伪造 101 或绕过真实 continuation |
| next dependency | M06-T01 | `blocked` | 否 | 必须等待 M05 合入重构主 tree 并完成主树复验 |
| governance audit | M00-T10 | `merged_and_cleaned` | 否 | merge `de7596514`；red/positive 主树复验通过；claim、worktree、branch 已释放/清理 |
| protocol/tools/admin contract | M11-T01 | `merged_and_cleaned` | 否 | merge `d48956155`；合同/host/red gates 主树复验通过；resource binding 的既有 host owner/catalog drift 已记录；claim、worktree、branch 已释放/清理 |

当前无可执行的 V4 并发实现 lane：重构主 tree 的 canonical Active/index 已可生成并通过自身 `verify-index`/`verify:isolation`，但 B02 目标 worktree 仍缺同一真实输入，不能把 ignored 输出当隔离 admission 证据；B02 继续负责唯一 owner handoff，B01 只读等待，M05 保留 dirty candidate 等待 B01/B02；M08 的 provider/server slice 已 ready，但整体 runtime-bin 接线等待 M05 明确交接；D0-T01 是 stale owner handoff，不能抢改。M06 及后续 milestone 继续等待 M05 合入重构主树并完成主树复验。M00-T10、M11-T01、M03-T01 已完成合入并清理，不得重复 claim；不为填充并发槽位新开会话或 worktree。下一次可派发条件是 B02 在自身 worktree 通过正式 lifecycle 并提供真实 Active/index，随后并发唤醒 B01 与 M05；在此之前只保留既有 claims/worktrees，不做无效派发。

## 当前派发记录（2026-08-26，证据优先）

> 更正：D0-T01 已实际合入（`2a48fe256`），queue 状态为 `merged_main_tree`，worktree clean；不再视为 stale owner blocker，可在本轮完成 release claim/cleanup。

> 收口：D0 的遗留 status-sync worktree（`6757f163e`，已包含在重构主 tree）亦已核对 clean 并删除，未触碰 M05/B01/B02/M08 的未完成改动。

> 收口：M00 初始 architecture-freeze worktree 已核对其两个未跟踪文档均为主树已有的旧版本；删除旧副本后 worktree clean，分支已删除。主树现有审计 checklist/progress 版本保留。

> M08-T01 provider/server 独立 slice 已提交 `0f9d49d72`，并以 merge `662fc8aec` 精确合入 `codex/v4-cordis-refactor-main`；7 个声明路径、provider 5/5、server 2/2、locked check、legacy transport scan、diff-check 均通过。整体 M08 仍等待 M05-owned runtime-bin async stream/cancellation、M00-T07 live evidence、full gates/live/AGY，不提前宣称 milestone 完成。

| worker | 已派发动作 | 当前结论 |
|---|---|---|
| M05-T01（原会话复用） | 已恢复自身 `runtime → plugin-contract` 边；A=26 保留，B=3 获父任务授权纳入 claim，C=6 已标明返还对应 owner；等待 B01/B02 输入后重跑 `v4/` Active/admission/build/install/live/AGY | scope 分类已完成；当前仍被真实 Active/build-link 输入阻塞；C 不得进入 M05 candidate，禁止自行清理、伪造 artifact、allowlist、clean、AGY、commit、merge、cleanup |
| B01（复用 M02 会话） | 新 claim/worktree 处理 build-link consumer registry 与 canonical frozen Active resolver binding；只允许合入 `codex/v4-cordis-refactor-main` | exact consumer edges 已 red→green，23/23 resolver tests、Active-link、execution-binding、diff-check 通过；canonical Active index 仍因隔离 worktree 缺真实 frozen Active 输入而阻塞，已写 handoff；不 commit/AGY/queue/cleanup |
| B02（复用 Cordis host-daemon 会话） | 新 claim/worktree 由 Active lifecycle/record-graph owner 按 AppSDK 正式流程发布 `routecodex-v4-base-node active-v2`；只允许为真实输入闭环服务，不得改 B01/M05/D0/M08 | red-first 已完成；B02 worktree 的 `verify`、review admission、`compile-module`、`begin-version`、`publish-active`、`gen-index`、`verify-index` 均按合同 fail-closed，精确 blocker=`ACTIVE_INDEX_MISSING`/`MISSING_RECORD:module-artifact`/`ActiveLinkErr03ArtifactMissing`；主 tree canonical index 的 `source_commit=555bee…` 与当前 HEAD=`228130e96…` 不一致，`input_ready=false`；ignored Active/index 仅是外部状态信号，不得复制为 B02 证据；已写 blocked handoff，保留 claim/worktree，等待 canonical owner 为当前 candidate 恢复输入 |
| M08-T01（原会话复用） | provider/server async transport、chunked response、cancellation/deadline、合同/边界/定向 red/green/evidence 已完成；等待 M05 execution owner 明确交接后再接 runtime-bin | 独立 slice ready；整体状态 `BLOCKED`，当前无合法并发实现面，不得提前合并或宣称完成 |
| D0-T01（既有 owner） | 继续其 differential/build-guard gate 收口；当前等待 stale owner handoff | claim 仍占用 gate projection；原 worker 会话不可见，禁止重复派发、抢改 gate 文件或自动接管 |
| M00-T10 / M11-T01 | 已合入重构主树后完成主树复验、release claim、worktree/branch cleanup | 已完成并清理 |

## 主树治理修复记录（2026-08-26）

- 在 `codex/v4-cordis-refactor-main` 内修复 `.appsdk/project.json` 的治理模块边界：移除不存在的 `playground/**` owned path。该路径位于主树外，导致官方 `appsdk compile .` 在进入模块编译前错误退出 `MODULE_PATH_MISSING`。
- 修复后官方 `appsdk compile .` 已越过路径门禁并继续到真实依赖检查，准确暴露 `MODULE_DEPENDENCY_ARTIFACT_MISSING:routecodex-v4-base-node`；`appsdk verify --admission .` 通过，build-link `gen-index` / `verify-index` 通过。
- 仍未通过的唯一真实阻塞是 frozen BaseNode 缺失 canonical `generated/modules/routecodex-v4-base-node/module.compiled.json`。AppSDK 正式语义只允许 `compile_module → promote_module → freeze_module` 产生该文件；当前模块已 frozen，不能复制 Protected/其他 tree 产物、手写生成物或用 allowlist/fallback 绕过。
- B02 已被唤醒继续核对正式 owner-flow；在其返回前，M05/B01 的隔离 worktree 仍不得消费主树 ignored 产物。下一合法动作是由 AppSDK lifecycle owner 处理 frozen BaseNode 的 version/artifact 状态，再重新执行 B02 → B01 → M05 的验证链。
- 按 Jason 指令在主树执行了官方 `appsdk begin-version . --module routecodex-v4-base-node --from active-v2 --to active-v3` 与 `appsdk compile-module . --module routecodex-v4-base-node`，canonical `module.compiled.json` 已由 compiler 生成；但继续 promote 在 `CANDIDATE_CONTROLLED_SOURCE_DRIFT` fail-fast。原因是既有 AppSDK candidate/evidence 仍绑定旧 `head_commit=555bee…`，而重构主树已包含后续受控改动；未伪造 record/hash，也未继续 publish-active。当前需要按正式 lifecycle 重新建立与当前 candidate 一致的 candidate/review/regression evidence graph，之后才能 freeze/publish/index。
- 已按“撤销错误状态”完成精确回滚：恢复 BaseNode 原 `active-v2` Protected history、AppSDK records/project 状态，移除本次未闭环生成的 ignored `module.compiled.json` / `project.compiled.json`；`appsdk verify --admission .` 恢复 `ok`。保留并未回滚已提交的治理路径修复 `645f929d2`；主树当前仅有本进度文档未提交改动。
- 本轮再次尝试正式 `begin-version active-v2→active-v3` / `compile-module`：编译器生成新候选后，`promote-module --to architecture_stable` 以 `INVALID_LIFECYCLE_TRANSITION: source_implemented->architecture_stable` fail-closed；随后已精确恢复 Protected history、`.appsdk/project.json` 与本轮生成的 ignored candidate 输出。当前主树恢复 clean，未留下错误 Active 状态；合法重建仍需 AppSDK lifecycle/record-graph owner 先生成与当前 candidate 一致的 evidence graph。
- 进一步按真实状态机依次探测 `source_implemented→contract_bound→compiled→controlled_verified→architecture_stable`：前四步均可执行，最终 architecture-stable 仍以 `CANDIDATE_CONTROLLED_SOURCE_DRIFT` fail-closed；中间 lifecycle 状态已撤销，主树保持 clean。该证据将阻塞定位为旧 candidate evidence graph 与当前 refactor HEAD 不一致，而非 CLI 顺序错误。
- 本轮真实验证：`cargo test --locked -p routecodex-v4-base-node --test l0_base_node` = 12/12；生命周期重建仍不能宣称完成，因当前 candidate 缺合法的最新 install/restart/blackbox evidence graph。

## 主树 Active 恢复重建（2026-08-27）

- 使用 AppSDK recovery binary 的正式 `restore-active` 在重构主树恢复四个已有 frozen archive：`routecodex-v4-base-node@active-v2`、`routecodex-v4-control@active-v3`、`routecodex-v4-edge@active-v4`、`routecodex-v4-error@active-v4`；恢复产物包含 `active/lib/**/artifact.json`、`current.json` 与 `generated/modules/*/module.compiled.json`，未复制其他 tree ignored 输出。
- 由 `routecodex-v4-build-link` owner 生成并校验 `build-control/active-index.json`：`V4_ACTIVE_INDEX_OK`；`verify:v4-active-link` PASS。
- 仍未形成当前 refactor HEAD 的完整 evidence graph：`appsdk verify` 为 `INVALID_ARTIFACT_SCHEMA`，base-node review admission 为 `CANDIDATE_CONTROLLED_SOURCE_DRIFT`；`verify:isolation` 仍受隔离 checkout 的 js-yaml 解析基线阻断。该恢复是解除 artifact 缺失的前置，不是 M05 或 V4 完成声明。
- M05 已重新启动独立 worktree 重实现；B01 已重新启动 build-link admission 验证；M08 provider/server slice 已合入，runtime-bin async 接线继续等待 M05 handoff。

## 受管实例恢复与真实请求复验（2026-08-27）

- 发现 `/Users/fanzhang/.rcc/v4/instance.json` 指向已退出 PID=3443，`control.sock` 缺失；该记录已保留为可恢复备份 `instance.json.stale-20260827T015500Z`。
- 通过全局 `/Users/fanzhang/.local/bin/rccv4` 建立 managed instance，随后执行 `rccv4 restart` 成功；`rccv4 status=running`，当前 manifest 仅声明 `127.0.0.1:5520`，该端口 `/health` 返回有效 V4 JSON。
- M05 真实 `/v1/responses` replay 返回 HTTP 200，响应 `status=completed` 且输出文本 `LIVE_RESPONSES_OK`。
- 首次 Chat replay 曾返回 HTTP 503（`curl: (16) Error in the HTTP2 framing layer`），但同语义 A/B/C 对照与后续短请求均 HTTP 200；该失败不可复现，未证明为 M05 代码根因。
- managed restart 后最终短请求复验：Responses HTTP 200 `status=completed`、Chat HTTP 200 `object=chat.completion`；M05 candidate 已取得 AGY controller `pass`，进入精确合并队列。
