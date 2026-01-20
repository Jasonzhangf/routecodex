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

## Phase 1：双库加载（不改行为）

- [ ] `package.json` 增加 `@jsonstudio/llms-engine`（建议 optionalDependencies；未安装时可运行 baseline）
- [ ] 扩展 `src/modules/llmswitch/core-loader.ts`：
  - [ ] 支持 `impl=ts|engine` 两套 package root（`@jsonstudio/llms` vs `@jsonstudio/llms-engine`）
  - [ ] 同一 subpath 解析为 `<pkg>/dist/<subpath>.js`
- [ ] 改造 `src/modules/llmswitch/bridge.ts`：
  - [ ] 所有 core import/require 都走统一 loader（避免硬编码 `@jsonstudio/llms/dist/...`）
  - [ ] 仍保持 “单一桥接面” 规则（Host/Provider 不直接触碰 core）

验收：
- [ ] `npm test` 通过（默认仍只用 TS）
- [ ] `npm run build:dev` 通过

---

## Phase 2：Hub inbound/outbound shadow 黑盒对齐（同进程）

### 2.1 Shadow 配置开关（仅 bridge/host 生效）

- [ ] `ROUTECODEX_LLMS_ENGINE_ENABLE=1`：允许加载 `@jsonstudio/llms-engine`
- [ ] `ROUTECODEX_LLMS_ENGINE_PREFIXES=conversion/hub/pipeline,conversion/hub/response`：这些前缀“真实走 engine”
- [ ] `ROUTECODEX_LLMS_SHADOW_PREFIXES=conversion/hub/pipeline,conversion/hub/response`：这些前缀双跑对比（baseline 输出仍取 TS）
- [ ] `ROUTECODEX_LLMS_SHADOW_SAMPLE_RATE=0.1`：采样（避免全量双跑）
- [ ] `ROUTECODEX_LLMS_SHADOW_DIR=~/.routecodex/llms-shadow`：diff 落盘目录（默认该值）

### 2.2 inbound：HubPipeline.execute() shadow

- [ ] baseline：TS HubPipeline（真实输出）
- [ ] shadow：engine HubPipeline（仅对比，不影响真实输出）
- [ ] diff 口径（稳定字段）：
  - [ ] `providerPayload`
  - [ ] `target.providerKey/providerType/outboundProfile/runtimeKey/processMode`
  - [ ] `metadata.entryEndpoint/providerProtocol/processMode/stream/routeHint`（其它字段按需扩展）
- [ ] side-effect 隔离：
  - [ ] shadow 路径不得写入 healthStore / routingStateStore / quotaView（必要时实现只读/吞写代理）
  - [ ] shadow 输入必须 deep clone，避免引用共享导致“假 diff”

### 2.3 outbound：convertProviderResponse() shadow

- [ ] baseline：TS convert（真实输出）
- [ ] shadow：engine convert（仅对比）
- [ ] diff 口径：对比转换后的响应结构（忽略 requestId/timestamps 等非确定字段）

验收：
- [ ] `~/.routecodex/llms-shadow` 产出结构化 diff 文件（包含 prefix、requestId、diff paths、baseline/candidate 摘要）
- [ ] `npm run build:dev` 通过（含 e2e / shadow regression / global install）

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

