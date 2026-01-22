# 当前任务（活跃）

> 历史已完成任务已归档到 `task.archive.md`（含 Unified Hub Framework V1 Phase0–5、CLI 拆分等）。

## Hotfix / Workstream：stopMessage / servertool / clock / quota（进行中）

### stopMessage（新语法 + 作用域 + 持久化一致性）

- [x] 支持 `<**stopMessage:<file://stopMessage/message1.md>**>`：设置时解析并读入内存（相对 `~/.routecodex/`），触发时仅发送已缓存内容
- [x] 去掉旧兼容逻辑，只保留新逻辑（仅从 session 持久化状态读取，不使用 stopMessageState/implicit 回退）
- [x] 仅对“设置时的 server 实例”生效：serverId 作用域隔离，避免跨 server 串读
- [x] 仅对“设置时的 sessionId”生效：触发必须 sessionId 匹配（不匹配不触发）
- [x] 触发后必须计数（repeatCount++），并同步刷新持久化（不允许内存更新但盘未刷）
- [x] 增加可观测日志：触发时会在 servertool 黄色进度里打印 `stopMessage reserved ... (cleared)`（含 stickyKey）
- [x] 单元测试 + 回归测试（覆盖 session/server 作用域、触发计数与持久化）

### clock（servertool + daemon 定时提醒，仅设计已落盘）

- [x] 详细设计（含 retention=20min、断开后下次请求注入、`stopMessage` 优先级、`<**clock:clear**>`）：`docs/SERVERTOOL_CLOCK_DESIGN.md`
- [ ] 实验：验证“hold（stop 时无限等待）+ 断开后下次请求注入”在客户端侧的可观测表现（确认 UI/CLI 行为与超时边界）
- [ ] 实现（待确认）：clock tool schema 注入、daemon 任务持久化、reservation/commit、启动清理（过期 >20min 删除）

### servertool 可观测性（执行进度日志）

- [x] servertool 执行进度亮黄色日志（已在 sharedmodule 侧实现并验证）✅
- [ ] 进一步：每条工具/handler 的“第 N 步”细粒度进度（仅当有必要再做）

### apply_patch errorsamples（形状巡检）

- [x] 扫描 `~/.routecodex/errorsamples/apply_patch_exec/invalid_patch` 并用当前 llmswitch-core `validateToolCall('apply_patch')` 复跑：`total=250 fails=0`
- [x] 扫描 `~/.routecodex/errorsamples/apply_patch/**`：`total=17 fails=13`（其余为真实无效输入：missing_changes/invalid_json/invalid_lines 等；`unsupported_patch_format` 均已被 normalize 覆盖）
- [x] 新增 shape-fix：结构化补丁 payload 顶层 `target` 作为 file（当 `file` 缺失且 changes[] 不含 file 时），修复一条 `invalid_file` 样本
- [x] 回归：`tool-governance-check` 增补 Begin/End Patch marker variant（`*** Begin Patch ***`）、classic context diff、structured payload `target` file 三类形状

### MCP 工具调用“变成文字”问题（Playwright 等）

- [ ] 复现：收集一次原始请求 payload + tool schema + tool_choice + providerProtocol（含 glm-4.7 / anthropic-messages 路径）
- [ ] 定位：确认是“模型未按 tool_call 输出”还是“Hub/compat 把 tool_call 降级成文本”
- [ ] 修复：只在 llmswitch-core（HubPipeline/工具治理）里做（Host/Provider 不修 payload 语义）
- [ ] 回归：e2e tool-loop（/v1/responses + tool_outputs）覆盖该场景

### quota alias 重复 + quota 不一致

- [ ] 复现：QuotaView 中 `1-geetasamodgeetasamoda` vs `geetasamodgeetasamoda`、`2-jasonqueque` vs `jasonqueque` 的重复与 quota 差异
- [ ] 定位：alias 解析/标准化链路（含序号前缀是否应参与 key）
- [ ] 修复：统一 alias 规范（确保同一 tokenFile 不会产生两套不同 quota 视图）
- [ ] 回归：单测覆盖 “同一凭据 → 同一 quota key”

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
