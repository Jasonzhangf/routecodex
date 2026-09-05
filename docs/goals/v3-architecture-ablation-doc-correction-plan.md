# V3 架构消融审计、文档校正与修复计划

状态：计划已建立；执行时必须从最新 `origin/main` 重新核验。
范围：RouteCodex V3 架构、唯一 owner、重复实现、非法穿透/旁路、`docs/**` 与 V3 function map 校正。
基线记录：2026-09-04，审计启动时 `main == origin/main` 且 worktree clean；当前 HEAD 以执行时重新读取结果为准。

## 1. 目标与验收标准

### 目标

建立一份可追溯的 V3 架构审计闭环：

1. 以 resource/function/mainline/verification map 和真实 Rust 调用边为准，识别冗余、重复 owner、重复实现、死 wrapper 和未收口的并行路径。
2. 识别控制面穿透业务 payload、非相邻转换、绕过 Runtime/Chat Process/Virtual Router/Target Interpreter/Provider/Error/Debug owner 的旁路。
3. 校正 `docs/**` 与 `docs/architecture/v3-function-map.yml`，并按依赖同步 resource map、mainline map、verification map、manifest、binding budget、topology manifest、Markdown/HTML 生成 review 面。
4. 输出按 P0/P1/P2 排序的修复计划；本目标不擅自实施 runtime 语义修复。

### 验收标准

- 审计报告明确列出每个 finding 的：问题、首次偏离点、唯一 owner、实际调用边、违规/允许边界、影响、修复建议、证据和未验证项。
- 每个“冗余/重复”结论都有反向 caller 搜索、定义唯一性和 map 对照证据；grep 命中不能单独定案。
- 每个“穿透/旁路”结论都有 source 级调用边或负向 fixture 证据；架构允许的 Direct/Relay/协议适配差异不误报为违规。
- `v3-function-map.yml` 中每个受审 feature 的 owner、owner path、canonical symbol、allowed/forbidden path、required gate 与真实代码一致。
- 受影响的 docs、maps、manifest、generated wiki/HTML 同步；不得留下“文档已更新但 gate 仍红”的未说明状态。
- 所有未完成事项显式标记为 `design`、`binding_pending`、`source_pending_live_replay` 或对应当前状态；不把 source green、map green 或 health green 误报为 runtime closeout。
- 形成最小修复序列：先修文档/map 真相，再修唯一 owner；禁止为了过 gate 添加 fallback、side channel、重复实现或静默兼容。

## 2. 范围与边界

### In scope

- V3 Rust workspace：`v3/crates/**`、`v3/src/**`（如存在）、V3 CLI/server/config/runtime/provider/error/debug/lifecycle。
- V3 架构真相：
  - `docs/architecture/v3-resource-operation-map.yml`
  - `docs/architecture/v3-function-map.yml`
  - `docs/architecture/v3-mainline-call-map.yml`
  - `docs/architecture/v3-verification-map.yml`
  - `docs/architecture/v3-architecture-audit-locks.yml`
  - `docs/architecture/v3-runtime-module-registry.yml`
  - `docs/architecture/v3-build-tool-module-registry.yml`
  - `docs/architecture/mainline-binding-budget.yml`
  - `docs/architecture/topology-sync-manifest.yml`
- V3 设计/审计/review 文档：`docs/architecture/**`、`docs/design/**`、`docs/goals/**`，包括 Markdown 与由真源生成的 HTML。
- 六条主线：入口/Server、Runtime/固定生命周期、Chat Process/协议语义、Virtual Router/Target Interpreter、Provider/Error/Health、SSE/Debug/ServerTool/MetadataCenter。

### Out of scope

- 不重写 V3 runtime 业务语义，不改变路由优先级、retry、health、continuation、Stopless、协议字段或 provider wire 行为。
- 不复活 V2 runtime；兼容读取器只作为输入转换证据检查。
- 不修改 live config、凭据、生产服务、全局安装、重启或 provider 流量，除非后续单独授权并按 runtime evidence SOP 执行。
- 不清理其他 worker 的 worktree、branch、claim、dirty 文件。
- 不通过降低 gate、删除负向测试、改成 warning、增加 fallback 或静默丢字段来消除 finding。

## 3. 设计原则

1. 唯一真源：先查 map，再查真实定义和 caller；不从文件名、grep 数量或历史文档推断 owner。
2. 一功能一 owner、一实现、一条决策链；协议差异只保留相邻 codec 的必要差异。
3. 控制面与业务 payload 物理分离；route/provider/retry/health/continuation/debug/snapshot 不得经由 payload、metadata 字段、日志或隐式上下文重建。
4. Runtime 保持固定生命周期骨架；operation 配置化、hook 注册化、gate 声明化；缺失能力显式失败或显式跳过。
5. Direct 与 Relay 只在已声明的协议/入口边界分叉；不得在 Server、SSE transport、Debug 或输出层复制路由/错误/continuation 决策。
6. 文档生成链：authoring map/manifest → validate → render → sync gate；生成 Markdown/HTML 不手改。
7. 已锁定主链的 caller/callee/resource/fingerprint 变更必须记录 Jason manual authorization；只修正文档 path 也不能绕过锁。

## 4. 当前已知基线证据（执行时必须复核）

以下是本轮只读检查已看到的信号，不直接等同最终 finding：

- `verify:v3-contract-map-owner`、`verify:v3-mainline-manifest-sync`、`verify:v3-module-boundaries`、`verify:v3-resource-map`、`verify:v3-mainline-caller-flow`、`verify:v3-rust-only`、`verify:v3-selected-provider-model-binding`、`verify:v3-provider-action-gate`、`verify:v3-normalization-payload-logic-boundary`、`verify:v3-static-hook-registry`、`verify:v3-server-tool-center-audit`：在正确 repo-root 调用方式下已出现通过结果。
- `verify:v3-architecture-ci` 在 `verify:v3-file-size` 处失败；当前超限/棘轮漂移文件必须重新读取实际行数，不得沿用旧快照。已见超限族包括 provider compat、config v2 compat/validate、provider health、runtime hooks、Anthropic/OpenAI Chat relay、`resp_chat_process_03_governed`、direct SSE consumers、server endpoint handlers、restart handoff 等。
- `verify:v3-hub-v1-node-file-topology` 已报告至少三处 map path drift：`v3-de-22` 的 Anthropic output 定义在 `anthropic_relay_runtime_helpers.rs`；`v3-responses-sse-tree-03` 的 rewrite 定义在 `responses_sse_tree_projection.rs`。执行时需同时核对真实 caller symbol，不能只替换文件名。
- protocol conversion parity gate 已报告若干缺失的测试/文档锚点，涉及 provider error/client invalid request 归因、client metadata 保留、reasoning effort projection 和 unmapped target protocol 行为；必须区分“旧锚点”与“真实行为缺口”。
- P6 freeze gate 已报告 Relay/entry protocol expansion、Runtime kernel entry、response frame builder、response exit 等约束信号；必须从真实入口确认是 gate 过期、调用图漂移还是实际旁路。
- `docs/architecture/README.md` 仍有旧的 `draft_architecture`/“进入 Rust source implementation”描述；`v3-module-decomposition-sop.md` 与 `v3-god-file-decomposition-plan.md` 仍使用旧巨型文件行数和“未开始”状态；这些属于优先文档校正候选。
- mainline caller-flow 当前能报告 `binding_pending` 和 manual-audit pending 数量；这些 debt 必须保留并更新预算，不能在报告中写成全量闭环。

## 5. 审计方法与输出

### 5.1 反向 owner/重复实现审计

按以下资源族逐项反查：

| 资源/语义 | 期望唯一 owner | 重点检查 |
|---|---|---|
| entry protocol binding | Config registry + Server projection | HTTP/WebSocket 是否共用同一 binding；pending 是否被显式保留 |
| request normalization | ReqInbound/ReqNormalized + adjacent codec | Server/Provider 是否重新解析或修 payload |
| route facts/classification | Virtual Router | Runtime、Server、Provider 是否重新选路或 provider-specific 分支 |
| target expansion/selection | Target Interpreter | keyless 展开、priority/weight、cooldown 是否存在第二份排序 |
| selected provider/model binding | `selected_provider_model_binding.rs` | Direct/Relay 是否在 compat/wire 之前绑定；Provider 是否重复绑定 |
| execution lifecycle/attempt budget | Runtime execution control | Server 是否重建 budget、重复发送 client frame、绕过 terminal seal |
| protocol semantic projection | adjacent protocol codec/Chat Process | SSE transport、Server facade、provider wire 是否直接改语义 |
| provider failure/error chain | Error + Provider action/health | runtime 是否手拼 retryable/health/cooldown，错误是否被包装成 client 400 |
| continuation | declared local/remote continuation owner | route/provider pin 是否从 payload/metadata 镜像恢复；Direct/Relay 是否串线 |
| ServerTool/Stopless/MetadataCenter | typed control resource + registered hooks | 是否存在 inline injection、payload carrier、跨轮隐式状态 |
| debug/observability | Debug/Server side-channel | Debug 是否成为业务决策输入，是否存在第二份 persistence writer |

操作要求：

- 从 function map 的 `canonical_builders`、`canonical_types` 反查全仓定义；定义数为零或大于一都记录。
- 从 mainline map 的 caller/callee 反查真实调用体；只登记“调用者确实调用被声明 callee”的边。
- 对同语义文件族比较输入/输出类型、错误类型、状态写入和副作用；相同命名不等于重复，实现差异必须写清。
- 找到旧 wrapper、无人调用函数、兼容 facade 或生成 artifact 时，先证明真实 caller 为零和 owner 已接管，再把“可删除”列入修复计划；本 goal 不直接删除 source。

### 5.2 穿透/旁路审计

逐条检查：

- `Server → Provider`：是否跳过 Runtime/Chat Process/Router/Target Interpreter。
- `SSE transport → client/provider semantics`：transport 是否解析、修复、重试、选 provider 或注入 control。
- `Provider → client`：是否跳过 provider raw/error/adjacent projection，直接把 raw body 当 client payload。
- `Error/Health`：是否从 bare HTTP status、日志、metadata 或 payload 重建 typed Error/control。
- `Continuation`：是否绕过 Req03/Resp04 owner，使用旧 payload mirror、session mirror、route hint 或 provider key。
- `Debug/observability`：snapshot、logs、dry-run、request ledger 是否反向改变业务决策。
- `Direct/Relay`：是否存在未声明 re-entry、Relay expansion、第二个 response frame builder/exit。
- `Config/manifest`：runtime 是否宽松扫描目录、绕过 authoring → validate → compile → load，或使用未登记 operation/hook。

每个疑似旁路必须给出：入口、首次越界节点、绕过的 owner、携带的资源、允许/禁止规则、正向或反向证据。

### 5.3 文档/map 一致性审计

- 以 source symbol/file 为底，校正 `v3-function-map.yml` 的 owner/allowed/forbidden/entry/gates/status。
- 以真实 caller/callee 为底，校正 `v3-mainline-call-map.yml`；必要时同步 `v3-architecture-audit-locks.yml` 授权和 fingerprint。
- 以 resource flow 为底，校正 `v3-resource-operation-map.yml`，特别是 control、payload、error、debug side-channel 的 reads/writes。
- 以实际可执行 gate 为底，校正 `v3-verification-map.yml` 的 command、status、live boundary；命令必须可查询，不能保留失效路径。
- 只有 map/manifest 变化后才运行生成器：`render:v3-mainline-caller-flow`、对应 architecture wiki renderer、HTML renderer；生成页不手改。
- 对旧文档进行最小校正：`docs/architecture/README.md`、模块拆解 SOP/plan、topology residual review、相关 protocol/SSE/ServerTool review 页；保留历史审计文档，不覆写历史结论。

## 6. 文件清单

### 必查

- `AGENTS.md`、`MEMORY.md`、`note.md`、当前 run notes。
- `docs/architecture/v3-resource-operation-map.yml`
- `docs/architecture/v3-function-map.yml`
- `docs/architecture/v3-mainline-call-map.yml`
- `docs/architecture/v3-verification-map.yml`
- `docs/architecture/v3-architecture-audit-locks.yml`
- `docs/architecture/v3-runtime-module-registry.yml`
- `docs/architecture/v3-build-tool-module-registry.yml`
- `docs/architecture/README.md`
- `docs/architecture/wiki/v3-mainline-skeleton-sop.md`
- `docs/architecture/wiki/v3-module-decomposition-sop.md`
- `docs/goals/v3-god-file-decomposition-plan.md`

### 按 finding 校正

- `docs/architecture/mainline-binding-budget.yml`
- `docs/architecture/topology-sync-manifest.yml`
- 对应 `docs/architecture/manifests/*.yml`
- 对应 `docs/architecture/wiki/*.md` 与 `docs/architecture/wiki/html/*.html`
- 新审计报告：`docs/architecture/reviews/v3-architecture-ablation-audit-2026-09-04.md`

### 可能修复的源码 owner（仅列计划入口，不代表本目标直接修改）

- `v3/crates/routecodex-v3-runtime/src/kernel/**`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/**`
- `v3/crates/routecodex-v3-runtime/src/execution_control.rs`
- `v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy*.rs`
- `v3/crates/routecodex-v3-runtime/src/selected_provider_model_binding.rs`
- `v3/crates/routecodex-v3-server/src/**`
- `v3/crates/routecodex-v3-provider-responses/src/**`
- `v3/crates/routecodex-v3-error/src/**`
- `v3/crates/routecodex-v3-config/src/**`

## 7. 风险与规避

| 风险 | 规避 |
|---|---|
| 把合法 Direct/Relay/codec 差异误报为重复 | 以 resource flow、输入输出类型和 map allowed path 判定；写清差异必要性 |
| 只改 map 掩盖真实旁路 | 先给 source caller evidence；map 只能反映事实，不能授权未声明调用 |
| 触碰 audited_locked 链导致 fingerprint drift | 先查 lock；取得 Jason authorization 后同一变更更新 fingerprint 和 generated review surface |
| 旧 gate path/cwd 错误被误判成源码失败 | 从 repo root 按 package script 真正入口执行；记录脚本路径错误与架构失败分开 |
| 生成文档手工漂移 | 修改 authoring map/manifest 后运行 renderer 和 sync gate，不手改 generated HTML |
| 发现文件超限就随意拆模块 | 只把拆解列为修复计划；按 module decomposition SOP、单 owner、同提交 map 同步执行 |
| 为消灭 pending 而伪造 anchored | 保留 `binding_pending/design`，更新 budget，补真实 symbol/edge 后再提升状态 |
| 用 source test green 宣称在线闭环 | 单独报告 build/install/restart/health/live replay/review/remote receipt |

## 8. 验证矩阵

### 审计与文档校正

- map/source：`verify:v3-contract-map-owner`、`verify:v3-mainline-manifest-sync`、`verify:v3-resource-map`、`verify:v3-mainline-caller-flow`。
- owner/boundary：`verify:v3-module-boundaries`、`verify:v3-rust-only`、`verify:v3-static-hook-registry`、`verify:v3-hub-v1-node-file-topology`。
- control/payload/error：`verify:v3-execution-control-payload-architecture`、`verify:v3-normalization-payload-logic-boundary`、provider action/error-chain、metadata leak、fallback denylist、duplicate DTO、non-adjacent conversion gates。
- protocol/entry：entry binding、selected provider/model binding、stage protocol shape、protocol conversion parity。
- generated docs：architecture wiki Markdown/HTML sync、mainline renderer sync、topology doc sync、binding-pending budget gate。
- red fixtures：对应 owner 的 negative fixtures 必须继续失败在被禁止路径；不能因校正文档而删弱。

### 若后续批准源码修复

- 先红测，再改唯一 owner，再跑定向正/负测试。
- 按 feature `required_gates` 运行 `verify:v3-architecture-ci` 与受影响 crate tests。
- Runtime 变化另行完成 build、install、managed restart、全部 listener health、同入口 JSON/SSE replay、日志 request-id 四件套、review；本目标不提前宣称。

## 9. 实施顺序

1. 读取最新基线、规则、run notes、全部 V3 maps/lock；记录当前 HEAD、clean 状态和 gate invocation。
2. 生成 map → source owner matrix；标出唯一 owner、重复候选、缺失 owner、锁定链和 pending debt。
3. 追踪六条主线的真实 caller/callee；先标首次偏离点，再判断重复或旁路。
4. 运行分层 architecture/negative gates；把 cwd/path/tooling failure 与 source/doc failure 分栏记录。
5. 建立审计报告初稿，先写证据和不确定项；不把猜测写成 finding。
6. 校正 `docs/**` 与 `v3-function-map.yml`；按实际变更联动 resource/mainline/verification map、manifest、budget、topology manifest。
7. 对 mainline/map 变更重渲染 Markdown/HTML review surface，并运行所有 sync/lock/budget gates。
8. 基于确认后的 findings 输出 P0/P1/P2 修复计划：每项绑定唯一 owner、最小 diff、红测、正负验证、live gate 与退出条件。
9. 复核 diff：无 fallback、无旁路、无重复实现、无控制面入 payload、无历史文档覆盖、无未授权 locked fingerprint 变化。
10. 交付审计报告、校正文件清单、验证结果、剩余风险和下一步；如需源码修复，另开 owner worktree/任务。

## 10. 完成定义（DoD）

- 审计报告可从 finding 反查 source、map、manifest、gate 和证据。
- `docs/**` 与 `v3-function-map.yml` 已按真实当前状态校正；相关 generated docs 已同步。
- 所有 gate 结果逐项记录：PASS、FAIL、BLOCKED、未运行及原因；不隐藏已知失败。
- 冗余、重复、穿透、旁路均分为 confirmed / allowed / stale-doc / unproven，不混为一谈。
- 修复计划不引入新的实现；每项都写明删除/收敛/改唯一 owner 的最小路径。
- 最终报告明确：source 状态、docs/map 状态、runtime/live 状态、review/remote 状态彼此独立。
