# v4-cordis 架构整改长程计划（C0-C4）

本文件是 `/goal` 提示词真源。目标：依据静态审计报告，把 v4-cordis 从“Cordis 生命周期绑定 + Rust 顺序执行器”的 vertical slice，整改为“Cordis 一切皆插件 + 单进程 Arc 数据面 + typed Event 控制面”的完整实现，最终通过 V3 等价 parity 验收。

**所有改动只合入 `v4-cordis`，禁止合入 `main`。** 每个 issue 独立 worktree，精确合入后主线复验、push、清理，再创建下一个。

## 硬约束

- 不再写新提示词，直接按 C0 → C1 → C2 → C3 → C4 顺序执行。
- 每项开始前先读取并拉取最新 `main`，再读取并核对最新 `v4-cordis` tip；从该 tip 创建唯一 `playground/<semantic-id>-<run_id>` worktree，分支 `codex/v4-cordis-<issue>-<run_id>`。
- 禁止改 V3、`main`、active/protected/frozen artifact 和他人 dirty；禁止脚本批量替换、fallback、silent strip、第二执行路径和错层补偿。
- 控制面必须保持 typed side-channel；业务数据必须由单一 immutable Arc carrier 承载；Event Bus 只发布只读事实，不参与 routing/retry/continuation/branch 或业务结果。
- 修改前先读 resource/function/mainline/verification maps、module registry、相关 contract 和现有 goal，锁唯一 owner、allowed/forbidden paths、相邻调用边；不能定位就先补 map/contract。

## 每个 issue 的固定流程

1. 拉取最新 `main` 与最新 `v4-cordis`，核对 tip，声明 claim 并建立唯一 worktree。
2. 先写反/正红测并确认当前为红；再在唯一 owner 层实现转绿。禁止 patch-first、禁止把红测改成跳过。
3. 完成模块边界自检、定向正反测试、workspace build/test、architecture/AppSDK gates；运行时改动完成全局安装、聚合 restart、全部 listener health 和同入口真实样本。
4. 前置验证全部通过后才运行默认 `agy-review`；FAIL 必须修复并重新验证/review。
5. PASS 后精确合入 `v4-cordis`，主 tree 只读复验并 push `v4-cordis`；确认远端与本地一致、worktree clean 后才清理 worktree、分支和 claim，保留 evidence/handoff/审计快照。
6. 下一 issue 重新拉取两条分支，禁止复用旧基线。

## C0 生产准入与单一 authority

- 删除或降级 `cordis_service_readiness()` 这类模拟式 readiness；生产 epoch 只在真实 Cordis NodeContext 与全部 Fiber ACTIVE 后 commit。
- 生产入口必须经真实 Cordis daemon admission（socket handshake + graph/manifest/epoch/capability/generation 校验）。
- 统一 daemon / Rust materializer 的 chain 合同（含 `control` 链），禁止 5/6 链不一致。
- 重建 graph/manifest/node-plan/artifact 的关系校验，禁止 hash 覆盖；节点 `plan_hash` 采用确定带前缀格式。
- daemon、PluginManager、ActiveEpochStore 只保留一个 active epoch authority。

治理前置：若 C0 改动横跨 feature-layer 的多个 lane/candidate，必须先按 lane 拆分提交或重建对应 candidate/evidence 记录，再跑 architecture gate。当前 v4-cordis tip 的 evidence 已整体过期，合入前必须先执行一次受控证据刷新，不能把过期证据当作可合入门禁。

## C1 Event 控制面

- 把 `V4Debug02BusSubscription` 从订阅登记表实现为只读事件发布/投递面，支持 publish、dispatch、事件 envelope、序号、scope 过滤、取消订阅、投递结果与不可变 ledger。
- 控制状态变化的唯一输入是 typed `ControlEvent` → reducer → 不可变 `ControlSnapshot`；事件不得反向影响业务结果或控制决策。
- 删除可变 `ControlView` 字符串字段与 Bridge 的 `Value` 控制字段，改成 owner-specific typed command/resource API，控制状态只能由唯一 owner 裁决。
- 证明 bus 故障不改变业务路径；证明 scope 隔离、顺序、重复投递、subscriber 隔离；证明 event 不被误用作 continuation/routing/retry 输入。

## C2 Arc 共享数据面

- 让 immutable `Arc` carrier 成为节点间唯一数据真源，删除并行 `Value` 与 stale `Arc` sidecar 的双真源。
- 插件只读共享与可变控制访问有类型边界；插件不得修改共享 carrier。
- 实现 node-scoped service registry 与共享所有权/生命周期；stale/disposed service 不得继续被执行使用。
- in-flight execution 对 active artifact/plan epoch 的 pin 闭环。
- 跨 JS/Rust bridge 不进行逐节点业务 JSON 往返；Cordis 只传 epoch/control。

## C3 节点容器与插件化

- 生产路径由 Cordis `RootContext → PipelineContext → NodeContext → Plugin Fiber ACTIVE` 承载，Rust 不再自造 `context_created/plugins_mounted` 生命周期。
- 实现 `routecodex-v4-cordis-plugins` 的通用 `RustPluginFiber` factory，每个 plan entry 表现为独立 Fiber，业务执行留在 Rust。
- registry key 收紧为 `(plugin_id, version, artifact_hash, contract_hash)`；真实 plugin config 与 config hash 传入 Handle。
- 先把所有未接入的标准插件加入红测，全部红测就位后逐插件接入修复、绿化。
- 插件返回 typed `Continue / Branch / Terminal / Failure`，executor 按声明 edge 前进；删除 core 中按具体 node_id 硬编码的业务 stage 表。
- 把 routing、availability、retry、transport、continuation、SSE policy 等业务 owner 从 runtime-bin 移入插件。

## C4 V3 parity 与验收

- 建立差分矩阵：`Responses / Chat / Anthropic / Gemini × stream / non-stream × direct / relay × normal / tool call / malformed × provider 4xx / 5xx / timeout / mid-stream failure × retry / cooldown / reroute / recovery × continuation first / follow-up / missing scope × config reload / plugin upgrade / rollback`。
- parity ledger 由测试自动生成或校验，不再依赖手写 `pass`；矩阵每个单元绑定 V3 owner、V4 plugin owner、Rust symbol、red/green test、live evidence 和 CI gate。

## 最终验收标准

- 任一生产插件 Fiber 未 ACTIVE，epoch 无法 commit。
- disable/upgrade 一个插件会真实改变生产执行，不修改 runtime core。
- plugin version/artifact/config 漂移会在 admission 前失败。
- 节点间无 serde_json 重序列化，Arc 是唯一数据真源，不再存在 `Value` 与 stale `Arc` sidecar。
- 所有控制状态变化都有对应 typed event。
- 生产 runtime 不再模拟 `context_created/plugins_mounted`。
- daemon、plugin manager、runtime 只有一个 active epoch truth。
- 完整 V3 差分矩阵由 CI 通过。
- 当前 HEAD 有实际 build/test/check 结果。

## 证据要求

- 每个 C0-C4 具备有效 behavior red、green、正反测试、构建、架构 gate、治理证据和合并后主线复验。
- 生产改动具备安装版本、聚合重启、全部 listener health、同入口旧样本和 live parity 证据；没有在线证据不得宣称完成。
- 最终 review 明确 PASS，且 C0-C4 独立 worktree、合并、主线验证、push、清理证据完整。
