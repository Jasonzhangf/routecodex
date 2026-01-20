# 当前任务（活跃）

> 历史已完成任务已归档到 `task.archive.md`（含 Unified Hub Framework V1 Phase0–5、CLI 拆分等）。

## 目标（llms-engine 逐步替换，Hub inbound/outbound 优先）

- 在同一个 `routecodex` 进程内同时支持两套 llms 核心：
  - baseline：`@jsonstudio/llms`（TS，API/类型对齐基线）
  - candidate：`@jsonstudio/llms-engine`（wasm 引擎，dist 子路径与 TS 1:1）
- 先对齐 Hub 流水线两条核心面：
  - inbound：`HubPipeline.execute()`（生成 `providerPayload + target + metadata`）
  - outbound：`convertProviderResponse()`（provider response → client response）
- 通过 **shadow 黑盒对比 + 模块级切换** 消灭 diff，最后默认切到 engine。
- shadow diff 落盘目录：`~/.routecodex/llms-shadow`（独立目录，不进 errorsamples）。

---

## 已完成（已归档到 task.archive.md）

- [x] Phase 1：双库加载（不改行为）
- [x] Phase 2：Hub inbound/outbound shadow 黑盒对齐（同进程）

---

## Phase 3：逐模块消灭 diff → flip 到 engine

按前缀逐个收口（先 Hub inbound/outbound）：

1) `conversion/hub/pipeline/**`
- [ ] 先 shadow（diff=0 门禁）
- [ ] diff=0 后加入 `ROUTECODEX_LLMS_ENGINE_PREFIXES`（真实切到 engine）
- [ ] 新增/固化回归用例（fixtures + diff=0）

2) `conversion/hub/response/**`
- [ ] 同上

验收：
- [ ] 两个前缀均 engine 且 shadow diff=0（或 shadow 关闭后回归全绿）

---

## Phase 4：默认切到 engine + 回退方案

- [ ] 支持 `ROUTECODEX_LLMS_DEFAULT_IMPL=engine|ts`（默认 engine，ts 作为紧急回退）
- [ ] 文档补充：如何安装 `@jsonstudio/llms-engine`、如何开启 shadow、如何读取 `~/.routecodex/llms-shadow`
- [ ]（后续）评估 `rcc` release 路径切到 engine（保留版本 pin 与回滚策略）
