---
name: rcc-dev-skills
description: RouteCodex 调试与架构路由入口
---

# RCC Dev Skills

## 何时用
- RouteCodex / llmswitch-core 请求链调试
- Hub Pipeline / Virtual Router / Provider Runtime owner 定位
- `feature_id` / gate / owner 查询
- `~/.rcc` / provider 配置排障
- note.md → MEMORY.md → skill 沉淀

## 先读
1. 项目 `AGENTS.md`
2. `docs/agent-routing/05-foundation-contract.md`
3. `docs/agent-routing/00-entry-routing.md`
4. `docs/agent-routing/40-task-memory-routing.md`
5. `references/24-node-contract-debug-method.md`
6. 本 skill 路由表对应的小文件

## 先查（硬性）

任何会改实现的任务，先执行且不能跳过：

0. 先用 MemPalace 查项目记忆与旧结论；snippet 只当 locator，必须打开返回源文件再判断。
   - 例外：Rustification L1 / source-doc-only 审计 / 生成物排除类任务，不得用
     MemPalace、`.mempalace`、`.local-index`、`dist`、`target`、`coverage`
     或其他生成物作为当前代码状态证据；文件发现必须从 `git ls-files`
     加源码/文档 allowlist 和生成物 denylist 开始。
1. 定位 feature_id（有时来自问题描述关键词）
2. 在 `docs/architecture/function-map.yml` 查 `feature_id` 的 owner、allowed / forbidden paths。
3. 在 `docs/architecture/mainline-call-map.yml` 查 `feature_id`、`caller`、`callee`。
4. 在 `docs/architecture/verification-map.yml` 查必跑验证栈。
5. 在 `docs/architecture/wiki/mainline-call-graph.md`（或功能 wiki）核对节点闭环。
6. 若相关 skill 已覆盖现成流程/经验，优先复用；如果没有，任务结束时必须回查并沉淀到对应 skill。

## 多 worker 协作（RouteCodex 本地协议）

- 项目协作真源是 `.agent-collab/PROTOCOL.md`；不要假设共享控制面、共享 worker 内存、可靠实时消息或可见工具状态。
- 代码/配置编辑、长 gate、提交、合并前，先刷新 `.agent-collab/` 视图：`runs/*/heartbeat.json`、`claims/*/owner.json`、最近 `events.jsonl`、`handoff/`、`merge-queue/`、`KILL_SWITCH`。
- 写入前 claim 语义 owner，不 claim 裸文件路径；优先 `feature_id`、`resource_id`、`mainline_node_id`、`gate_id`，用 `mkdir .agent-collab/claims/<semantic_id>` 作为本地原子占用。
- 保留并行 worker 的无关 dirty worktree；禁止用 checkout/reset/broad cleanup 清理他人改动。
- 心跳 stale 不等于接管授权；生产写入、删除、迁移、发布、鉴权、密钥、global install、live runtime 变更仍需明确授权或 checked handoff。
- 完成声明必须有 `evidence.jsonl`；跨 worker 集成默认走 `handoff/` 或 `merge-queue/`，checker 读取证据后再合并。

## Debug 首选顺序（强制）
1. 先查 `function map / owner registry / verification map`
- 锁唯一 owner、允许路径、required gates。
2. 再查 `mainline source / wiki / manifest`
- 先判断生命周期、节点合同、正常/错误/超预期路径是否逻辑闭环。
3. 再设计测试
- 先白盒节点测试，再 provider/client 两端黑盒。
4. 最后才查实现并改代码
- 合同没锁清楚时，禁止直接 grep 后改实现。
- 1-2 次查询内找不到唯一 owner 或唯一主线边，先补 map/contract。
- 数据/控制分流先验：如果数据字段能从原始请求/响应负载直接拿到，就不要从 `MetadataCenter`、上下文 carrier、日志投影、matchedPort/localPort 之类中间语义里再取一遍；`MetadataCenter` 只用于控制语义，不能当数据面第二真源。
- 请求协议字段先验：HTTP headers、body 标准字段、`metadata`、`client_metadata`、`x-*` / `x-codex-*` 都是请求协议数据面，默认透传；不要搬进 `MetadataCenter`，不要因为名字含 metadata 就判成 RouteCodex 控制信号。`MetadataCenter` 只写 RouteCodex 内部控制信号。
- 反模式：同一字段多次派生、多处 fallback、先从 payload 再从 metadata 回读、用上下文零散字段拼接原始数据。
- 直通路径特例：provider-direct / same-protocol direct 若绕过 request-executor，必须在实际送给 provider 前把 `clientConnectionState` 生成的 `abortSignal` 写进 provider runtime metadata；只保留 state 不够，direct provider 会继续跑到自然结束。

### Virtual Router 在线诊查优先

- 遇到路由命中错误、端口路由组错配、longcontext 优先级、provider 切换/兜底、`PROVIDER_NOT_AVAILABLE`、default floor 或 route pool availability 问题时，优先建议并执行 live VR diagnostics。
- 先查 `/_routecodex/diagnostics/virtual-router/status` 或 `routecodex port status <port> --json`，确认 `localPort`、`routingPolicyGroup`、route prefix、pool、forwarder、availableTargets。
- 再用 `/_routecodex/diagnostics/virtual-router/dry-run` 或 `routecodex port dry-run <port> ... --json` 重放最小样本；短样本和 longcontext 大样本分开验证。
- 禁止只凭日志、短请求或 config 片段判断 VR 问题；线上能查时，必须用在线 status + dry-run 作为第一证据。
- default pool 最后目标不可被排空；不要用排除 default singleton 制造 `PROVIDER_NOT_AVAILABLE`，应解释为 default floor 保护。

## 修改前 / 验证后 必做

- 修改前：必须同时看 `function map` 和 `mainline source`，确认模块边界、允许路径、禁止路径、主线 caller/callee。
- 配置/loader/VR/Hub/Pipeline 接线前：必须先完成未接线状态下的模块黑盒与旧配置样本对比，证明新实现能读取/等价处理现有用户配置；黑盒未绿禁止接线、禁止启动/重启 live server。
- 禁止为绕过代码缺陷去修改 `~/.rcc` 或用户真实配置文件。若现有配置暴露兼容失败，必须回代码唯一 owner 修正；需要清理/迁移用户配置文件时必须先获得 Jason 明确授权。
- 验证后：必须做 architecture review，判断结果是否正确、架构是否正确、是否用了 fallback / 临时绕路 / 补丁式修复、是否存在“结果对了但架构错了”。
- 验证通过不等于闭环完成；架构 review 不过，仍视为未完成。

## 全局安装 / release 验证硬规则

- 所有交付级 RouteCodex 测试必须使用全局安装版本。单元测试、编译、repo-local build 只能作为前置 gate，不能作为“已修复/已启动/已可用”的最终证据。
- 实验测试和 live closeout 使用 `routecodex` 安装面执行：先安装目标产物，再用全局 `routecodex --version` / `/health.version` 确认版本，再用 `routecodex restart --port <port>` 重启验证。
- Jason 未明确要求时，不得覆盖或改写 `rcc` 的 release 安装、Homebrew/global shim、或正在工作的 release runtime。需要动 `rcc` release install 时，先确认这是本轮目标。
- 禁止用 `rcc start`、repo-local `node dist/...`、手工 snapshot、或临时 shim 代替标准 release/global 安装验证；这些只能作为定位证据，不能作为交付闭环。
- 版本真相必须三点一致：命令入口版本、`~/.rcc/install/current/package.json`、目标端口 `/health.version`。不一致时先修安装/入口，不继续判断业务功能。
- 区分测试与生命周期动作：`npm run test:webui` 这类 Jest/UI 单测不得启动、停止、重启 live server；若测试前后 server 变化，必须用 `~/.rcc/logs/server-<port>.log` 的 `signal_received` / `self_termination` / `restart_signal_received` 追真正 stop owner，禁止把 install/restart/HTTP shutdown 误归因给 UI 单测。
- 如果 Jason 说某次执行导致 live server 停止，并且已经手动恢复，立刻接受现场事实；停止争辩和重复复现。后续命令先按 side-effect 分级：禁止再跑 install/restart/start/stop/HTTP shutdown/foreground server/可能退出会话的 browser probe，除非 Jason 明确要求。

## 路由表

| 主题 | 文件 | 用途 |
| --- | --- | --- |
| 架构总览 | `references/00-architecture-map.md` | 单一路径、分层职责、关键文件 |
| PipeDebug 流程 | `references/10-pipedebug-flow.md` | 按阶段切段定位 |
| 改动落点 | `references/20-change-index.md` | 功能改动先改哪 |
| 改动流程 | `references/21-change-workflow.md` | 功能变更先看什么、怎么锁唯一修改点 |
| servertool hook 骨架 | `references/22-servertool-hook-skeleton-workflow.md` | servertool/stopless CLI lifecycle + hook-governed 请求/响应骨架、测试闭环 |
| servertool 开发/调试流 | `references/23-servertool-hook-dev-debug-flow.md` | servertool hook skeleton 的实施顺序、debug 切段、证据链与删 TS 前置条件 |
| 节点合同调试法 | `references/24-node-contract-debug-method.md` | 高优先级方法：先生命周期/节点合同，再设计白盒与两端黑盒，最后才 debug/改代码 |
| 协议/SSE/continuation 边界 | `references/25-protocol-sse-continuation-boundary.md` | `/v1/responses` continuation Chat Process save/restore 不可变区、SSE transport-only、inbound/outbound 只归一化 |
| 唯一功能块 | `references/30-unique-block-index.md` | 快速锁唯一功能块 |
| owner / feature / gate | `references/40-owner-registry.md` | function map / verification map / source anchor |
| `~/.rcc` / provider 配置 | `references/50-rcc-config-ssot.md` | runtime 配置真源、schema、排障命令 |
| note / MEMORY / skill | `references/60-note-memory-flow.md` | note→MEMORY→skill 提炼 |
| gate 反查 | `references/70-gate-discovery.md` | feature_id → required_gates |
| skill 写法 | `references/80-skill-routing-convention.md` | 主 skill 保持短入口 |
| 2026-05 lessons | `references/91-lessons-2026-05.md` | 5 月沉淀 |
| 2026-06 lessons | `references/92-lessons-2026-06.md` | 6 月沉淀 |
| 2026-07 lessons | `references/93-lessons-2026-07.md` | 7 月沉淀 |

## 最小使用法

### 1. 先判类
- 架构 / 节点 / 责任 → `00` / `30`
- 调试流程 → `10`
- 改动落点 / 修改顺序 → `20` / `21`
- owner / gate / feature → `40` / `70`
- servertool / stopless / hook run / followup / reenter → `22` / `23` + `40` / `70`
- 运行时配置 / provider → `50`
- note / memory / skill 沉淀 → `60`

### 生命周期/合同类问题的最小执行序
1. `24`：锁生命周期、节点合同、白盒/黑盒设计方法
2. `40` + `70`：锁 owner、feature、gate
3. `22` / `23`：锁 servertool 主线、落点、切段法、验证顺序
4. 再回真实实现

### servertool 专项必经流
- 只要任务涉及 `servertool / stopless / reasoning_stop / hook run / followup / reenter / schema validation / tool injection`，必须先读 `22` 再读 `23`。
- 只要任务涉及 `/v1/responses` continuation、SSE、req_inbound/resp_outbound、history/tool loss、JSON/SSE parity，必须先读 `25`，再回 function map/mainline 锁 owner。
- **Continuation 不可变区高优先级**：`resp_chatprocess save -> immutable store interval -> req_chatprocess restore` 之间禁止任何语义转换、上下文恢复、history/tool 修补、required_action 推断、stopless/servertool guidance 注入。`req_inbound` / `resp_outbound` / SSE / handler / adapter / store transport 只能做语义等价归一化、投影、传输、scope 校验和释放。
- 如果看到 `entryOriginRequest` / `capturedChatRequest` / `requestSemantics` / session-only scope 在保存后到恢复前被用来补上下文或 history，先判定为越界 owner shortcut；修复方式是删除该逻辑并回 Chat Process continuation owner，而不是在 inbound/outbound/handler 再补一层。
- `22` 锁目标骨架、主线顺序、case matrix、黑盒闭环。
- `23` 锁实施顺序、debug 切段、证据链、删 TS 准入条件。
- `24` 锁高优先级方法：任何复杂 debug/设计先画生命周期，逐节点定义输入/输出/正常/错误/超预期，再补白盒节点测试和 provider/client 两端黑盒，最后才允许改代码。
- 对 servertool hook skeleton，整个开发和 debug 流程本身也属于 repo 资产：稳定后的执行步骤、切段法、验证顺序、删 TS 准入条件，必须沉淀进 `23` 或 lessons，不能只留在 wiki、`note.md`、goal 或聊天。
- `23` 也是 servertool 开发 + debug 的执行真源：每轮新增的稳定 slice 顺序、串行验证顺序、黑盒口径、删 TS 前置条件，都必须回写到 `23` 或当月 lessons，不能只留在聊天或 `note.md`。
- servertool 相关开发/调试一旦形成稳定动作序列、切段法、反模式或验证口径，必须同步回写 `23` 或当月 lessons；禁止只留在 `note.md` 或聊天上下文里。
- 若 `mainline-call-map` 仍是 `binding pending`，只能宣称“目标/骨架已锁定”，不能宣称 runtime 已 Rust-only 落地。
- 发现 inbound/outbound 里混入逻辑时，先查真源 owner 是否应上移到 Chat Process；尤其 continuation save/restore 只能在 Chat Process 响应出口/请求入口。修复后必须物理删除错误 helper / 重复实现，禁止在 outbound/inbound/handler 留第二套语义补丁。
- SSE / transport 日志只可作为证据，不可作为语义 owner；当日志类测试与更高层 regression 重叠时，优先删重复断言，不要在 handler/outbound 里再补一套“日志即真相”的测试语义。
- architecture review 发现 fallback、补丁式修复、临时绕路、错层实现时，必须回到唯一 owner 修正，而不是把结果正确误记为完成。

### 2. 再做三问
1. 失败在哪一段？
2. 这一段唯一 owner 是谁？
3. 最小 gate 和 live probe 是什么？

### 3. 最后闭环
1. red test / failing sample
2. 改唯一 owner
3. green gate
4. request dry-run：真实入口或 codex sample 走 `x-routecodex-dry-run: provider-request`，确认返回 `routecodex.pipeline_dry_run`、最终 `providerRequest` 和 `stoppedBeforeProviderSend=true`；若返回普通 provider response，先修 dry-run loop
5. response dry-run：相关 `provider-response*.json` 走 `npm run dry-run:codex-response -- --sample <file>`，确认现有 response converter 输出；未 materialize 的 live `sseStream` 样本不能当离线响应证据
6. live replay old sample
7. note → MEMORY → lessons

## 硬护栏
- 单一路径：`HTTP -> Hub Pipeline -> VR -> Provider Runtime -> Upstream`
- Rust 真源优先：Hub Pipeline / Chat Process / 路由 / servertool 语义默认查 Rust
- 禁止 fallback / 静默吞错
- `feature_id` 改动必须同步 map + verification + source anchor
- `~/.rcc` 是运行时配置真源
- server handler 不得长出第二套协议解析
- gate 只是门禁；完成必须有 live/runtime 证据
- 资源收拢先建 map/gate：先落 `resource-operation-map`、function-map `resource_bindings`、mainline `resource_flow`，再按资源改 runtime；禁止先写全局 request/response manager。
- 资源第一层补缺边界：先补 `request.mainline` / `response.mainline` / `responses.continuation.mainline` / `servertool.hook_skeleton.mainline` / `error.mainline` / `vr.route_availability.mainline` / `metadata.center.mainline` 的相邻 `resource_flow` 与 owner `resource_bindings`；config/WebUI/runtime lifecycle/debug/internal-error/VR diagnostics 需先扩展资源分类再补。
- 资源第二层补缺边界：config/WebUI/runtime lifecycle/debug/internal-error/VR diagnostics/hit-log 必须先使用独立资源（如 `config.runtime_projection`、`runtime.instance_record`、`debug.internal_error_envelope`、`vr.diagnostic_decision`），禁止借用 request/response/route.selection/debug snapshot 资源凑 coverage；剩余 stopless/SSE/stage_a 属下一层 backlog。
- 资源第三层补缺边界：补 stopless/SSE/stage_a 时必须使用 `stopless.*`、`sse.protocol_stream_projection` / `sse.provider_stream_aggregate`、`stage_a.*` 资源；主线 edge 可全闭合到 `108/108`，但 feature-level `resource_bindings` backlog 仍需按 owner surfaces 分层处理，禁止为数字把非主线 owner 绑定到不相邻资源。
- 资源第四层补缺边界：mainline `resource_flow` 已 `108/108` 后，只补 feature-level `resource_bindings`。servertool engine 子功能使用 plan/state/projection/policy 资源族（如 `servertool.engine_action_plan`、`servertool.execution_contract_plan`、`servertool.registry_projection`），不新增假 mainline flow，不把非相邻 owner 绑到 request/response/route 资源凑数。
- 资源 host/runtime 补缺边界：server/host/CLI surface 要用 entry/handle/transport/projection 资源（如 `runtime.hub_pipeline_handle`、`runtime.http_entry_dispatch`、`server.handler_transport_envelope`、`models.capability_catalog`、`cli.command_dispatch_intent`），不要把 shell/handler owner 硬绑到 request/response/route truth 凑 coverage。
- 资源 protocol/conversion 补缺边界：provider-wire compat 与协议转换要用 owner-specific `protocol.*` 资源；相邻但不同 feature 的 schema 修补必须拆资源（如 Responses function tool schema 与 tool parameters schema），禁止合并成一个多 writer 模糊资源凑覆盖。`protocol.*` side_channel 只读控制面，禁止进 provider/client body。
- 资源 config codec/path 补缺边界：path resolution、TOML codec、user/provider text codec、provider coercion 要用下层 `config.*_plan` / `config.*_codec` 资源；不要把 codec/path owner 绑定到 `config.runtime_projection` / provider profile projection 这类高层 materialization 资源凑数。
- 资源 residual 补缺边界：error/VR/contract/snapshot/debug/manager/daemon/SSE residual feature 也必须用 owner-specific 资源收口；禁止为完成覆盖率把它们塞进 request/response/route 主线真相。第四层 `119/119` 只代表 map/doc/gate 闭合，不代表 runtime refactor 已完成。
- 资源 source-binding gate 边界：第四层 `119/119` 后，runtime refactor 前必须先跑 `verify:resource-source-bindings` 和红测 fixture；资源 owner 必须能经 function-map `owner_module` / `allowed_paths` 找到真实 `feature_id:` source anchor，查不到只能标 `binding pending`，禁止伪造 symbol/resource/edge。source-binding 绿门禁必须留在 `verify:architecture-review-surface-light`，红测 fixture 必须留在 `verify:architecture-ci-longtail` 并由 `verify:function-map-build-wiring` 锁住。
- 首个 runtime slice 准入：先用 `.agent-collab` claim 精确 `feature_id` / `resource_id` / `mainline_node_id`，再证明 owner/source/map/gate 可查；对 dry-run 相关 slice，runtime 改动前必须先有 request dry-run 最终 provider request 样本和 response dry-run converter 黑盒结果，后续修复先加失败 dry-run 样本再改唯一 owner。
- Dry-run 黑盒门禁：请求构造问题先用 request dry-run 固化 final `providerRequest`，响应处理问题先用 response dry-run 固化 `convertProviderResponseIfNeeded` 黑盒输出；serialized live `sseStream` 没有 `bodyText/raw/text` 不是离线 replay 证据，必须重新 capture。`test:pipeline-dry-run-blackbox-fixtures` 是 dry-run runtime refactor 前置门禁，不是事后补测。
- Host bridge 收敛先收调用面：先把 broad `native-exports.ts` 外部调用点收敛到 owner-specific narrow host，再删除零引用 facade；禁止为了删桥让 handler/executor 直接接更多 native helper。
- Host bridge 测试收敛分型：白盒 host wiring / mocked native-call tests 必须 mock owner-specific host（如 `routing-native-host.ts`、`runtime-lifecycle-host.ts`），不能 mock broad `native-exports.ts`；只有纯 Rust/NAPI 输出证据测试才迁到 `tests/sharedmodule/helpers/*direct-native*`。
- Monitored handler/executor 白盒测试也不能 import `tests/providers/helpers/llmswitch-native-exports-fake.ts`；需要 handler 专属行为时放到 owner-specific fake（如 `responses-handler-host-fakes.ts`）。
- Responses request-bridge host wiring 测试使用 `tests/modules/llmswitch/bridge/responses-request-handler-host-fake.ts` 这类 owner-specific fake；禁止回到 `llmswitch-native-exports-fake` / broad `native-exports.ts` mock。
- Host split 后 gate/source-map 必须跟随真实 helper owner：例如 provider-response converter 拆出 `provider-response-native-calls.ts` / `provider-response-effects.ts` / `provider-response-metadata-effects.ts` 后，gate 检查这些 helper 的 shared invoker / fail-fast / MetadataCenter 证据，禁止为了旧 gate 把 helper 逻辑搬回主 host。
- Hub Pipeline Rust 残留引用 gate：先跑 `verify:hub-pipeline-native-reference-gate` 和 red fixture，区分 private loader、owner-specific host、white-box mock、direct-native evidence、doc stale owner；runtime 禁 import direct-native helper，docs/wiki 禁把 broad `native-exports.ts` 写成语义 owner。

## 快查命令
- 查 owner：
  - `rg -n 'feature_id: <id>' docs/architecture/function-map.yml`
- 查资源 owner：
  - `rg -n 'resource_id: <id>|<id>@' docs/architecture/resource-operation-map.yml docs/architecture/function-map.yml docs/architecture/mainline-call-map.yml`
- 查全项目资源覆盖：
  - `npm run audit:resource-global-coverage`
  - `sed -n '1,120p' docs/architecture/resource-global-coverage-report.json`
- 查资源 gate：
  - `npm run verify:resource-operation-map`
  - `npm run verify:resource-owner-uniqueness`
  - `npm run verify:resource-mainline-bindings`
  - `npm run verify:resource-forbidden-writes`
  - `npm run verify:resource-side-channel-isolation`
  - `npm run verify:resource-source-bindings`
  - `npm run test:resource-source-bindings-red-fixtures`
  - `npm run verify:architecture-review-surface-light`
- 查 gate：
  - `rg -n 'feature_id: <id>' docs/architecture/verification-map.yml`
- 查源码锚点：
  - `rg -n 'feature_id: <id>|<id>' sharedmodule src tests`
- 查运行时 provider：
  - `ls ~/.rcc/provider/<id>/ && cat ~/.rcc/provider/<id>/config.v2.toml`

## 维护规则
- 主 `SKILL.md` 只做入口，不回填大段细节
- 新主题新增 `references/<nn>-<topic>.md`
- 单文件尽量 ≤ 200 行；超过继续拆
- lesson 用 card，不写流水账

## 相关规则
- note.md append-only：顶部 consolidation index，正文不删 raw
- MEMORY.md append-only：只追加 dated correction
- 同主题冲突：最新已验证时间戳胜出
