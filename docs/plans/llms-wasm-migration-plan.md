---
title: "llms-wasm 逐步替换迁移计划"
tags:
  - migration
  - wasm
  - architecture
status: planning
priority: high
created: 2026-01-26
owners:
  - name: RouteCodex Team
    role: Architecture
---

# llms-wasm 逐步替换迁移计划

> [!important] 核心目标
> 让 llms-wasm 和 llms TS 同时加载、同一请求可双跑；默认流量仍走 TS，WASM 跑影子并产出 diff；diff 可回溯、可修正；按模块逐步替换并具备清晰的验收与回滚开关。

## 成功指标（建议起始阈值）

- diff rate ≤ 0.5%（按模块可更严格）
- shadow error rate ≤ 0.1%（影子侧）
- P95 latency delta ≤ +10ms（主路 vs 基线）

> [!note] 统计口径
> 指标必须按 `tenant`、`route`、`module`、`runtime(ts|wasm)` 分维度统计，并支持按 ruleset 版本回溯。

---

## 阶段 0：边界与基线

### 0.1 模块边界清单（Contract + 归属）

> [!tip] 产出物
> 输出一份“模块边界清单”，用于：替换顺序、归因、验收与回滚。

| 模块 | 输入 Contract | 输出 Contract | Owner/修复路径 | 仓库归属 |
|---|---|---|---|---|
| tokenizer/encoding | `text` | `tokens` | wasm core | llmswitch-core |
| tool canonicalization | `ToolCallRaw[]` | `ToolCallCanonical[]` | wasm core | llmswitch-core |
| compat | `UpstreamResponse` | `CanonicalResponse` | compat adapter | llmswitch-core |
| streaming (SSE) | `SSEChunk[]` | `CanonicalSSEEvents[]` | wasm core | llmswitch-core |
| routing | `RequestContext` | `ProviderTarget` | wasm core | llmswitch-core |

> [!note] 依赖顺序
> `tokenizer → tools → routing → compat → streaming`（可按实际代码调整，但必须写入清单）。

**任务清单**：

- [ ] 产出模块边界清单文档（`docs/llms-wasm-module-boundaries.md`）
- [ ] 定义每个模块的输入/输出 Contract（TypeScript interface）
- [ ] 明确依赖顺序与替换优先级
- [ ] 确认 Owner/修复路径（wasm core vs compat adapter）

> [!important] 本轮补充要求（阶段 0 必须落地）
> - **统一 tokenizer**：整理成单一实现与单一入口（single source of truth）。
> - **统一 SSE event 协议**：定义唯一 canonical SSE event schema + diff 协议（event + token 级）。
> - **统一 compat profile**：在 llmswitch-core 统一定义、版本化、并成��唯一触发来源。

### 0.2 基线回放集（Replay Baseline）

- 固定请求集：覆盖典型模型/工具/路由/SSE 场景
- 固定版本快照：记录 TS 与 WASM 的版本号 + core ruleset 版本
- 回放方式：离线 replay + 线上 sampled replay（可选）

> [!important] 回放基线必须可重复
> - 输入需要脱敏但可复现（结构不变）
> - 影子侧必须能独立重放同一请求（同版本、同 ruleset）

**任务清单**：

- [ ] 设计回放集采样策略（覆盖典型场景）
- [ ] 实现回放集存储格式（JSON + 脱敏）
- [ ] 实现回放 runner（支持离线 replay）
- [ ] 建立 baseline 版本管理（TS/WASM/ruleset 版本号）

---

## 阶段 1：双加载 + 开关矩阵

### 1.1 双加载初始化

- TS runtime：当前 `@jsonstudio/llms`（TS）
- WASM runtime：`llms-wasm`
- 目标：同进程内并存、互不影响、初始化失败可降级（不 silent fallback；需上报错误）

> [!warning] Fail fast + 可观测
> WASM 初始化失败必须走 `providerErrorCenter` + `errorHandlingCenter` 上报；主路仍按模式走 TS。

**任务清单**：

- [ ] Host 实现双加载初始化（`src/server/runtime/http-server/dual-runtime.ts`）
- [ ] WASM 初始化失败上报（通过 `providerErrorCenter`）
- [ ] 验证双加载互不影响（隔离测试）

### 1.2 运行模式

- `ts_primary`：主路 TS（默认）
- `shadow`：主路 TS，WASM 影子
- `wasm_primary`：主路 WASM，TS 影子
- `split`：按比例分流（用于逐步切流）

**任务清单**：

- [ ] 定义 RuntimeMode 类型与枚举
- [ ] 实现模式切换逻辑（Host 侧）

### 1.3 开关优先级与作用域

> [!important] 优先级（强制）
> 全局 > 租户 > 路由 > 请求

| 作用域 | 示例 | 说明 |
|---|---|---|
| 全局（进程级） | env `ROUTECODEX_WASM_MODE=shadow` | 默认行为 |
| 租户级 | config `tenants[*].wasmMode` | 覆盖全局 |
| 路由级 | virtual router `routes[*].wasmMode` | 覆盖租户 |
| 请求级 | header `X-WASM-Mode: wasm_primary` | 单次请求 override |

> [!note] 开关读取位置
> Host 只做“读取与决策分发”；具体逻辑执行（含 canonicalization、diff 协议）在 llmswitch-core。

**任务清单**：

- [ ] 实现开关读取逻辑（Host 侧）
- [ ] 实现优先级解析（全局 > 租户 > 路由 > 请求）
- [ ] 更新配置 schema（支持 wasmMode 字段）
- [ ] 文档化开关优先级矩阵

---

## 阶段 2：影子 + Diff 机制（含 SSE 协议）

### 2.1 影子请求分发

- 主路请求正常执行
- 影子请求异步执行（不阻塞主路响应）
- 影子失败不重试（默认）；如需重试必须可配置且有预算（error budget）

**任务清单**：

- [ ] Host 实现影子请求分发（异步、非阻塞）
- [ ] 影子失败记录（error 摘要，不影响主路）
- [ ] 实现影子重试配置（可选，带 error budget）

### 2.2 Diff 协议与 Canonicalization（在 llmswitch-core）

> [!warning] Canonicalization 归属
> 所有 canonicalization、diff ruleset、比较逻辑都必须在 llmswitch-core；Host 不做字段修补。

#### 通用 Diff 规则（降噪）

- 排除/标准化：`timestamp`、随机 id、trace id 等
- 容忍策略：浮点容忍、集合无序、JSON 格式化
- 非确定性：白名单 + ruleset 版本化（见附录 A）

#### SSE 对比协议（event + token）

> [!tip] 核心原则
> 允许 chunk 拆包差异，但要求最终 token 序列一致；对比基于 event-level schema。

Canonical event schema：

- `event_type`
- `ordinal_index`
- `normalized_payload`
- `token_digest`（可选，用于 token 级校验）

判定逻辑：

- event 序列可容忍“拆包导致的分段差异”
- 最终 token_digest 序列一致则通过
- 失败时输出最小 diff 摘要（added/removed/mismatch）

**任务清单**：

- [ ] 实现通用 Diff 规则（降噪、容忍策略）
- [ ] 实现 SSE canonicalization schema
- [ ] 实现 SSE diff 判定逻辑（event + token 级）
- [ ] 实现 diff ruleset 版本化（`diff_ruleset_v1`）

### 2.3 Diff 记录（绑定 ruleset）

每条 diff 必须包含：

- `requestId` / `tenant` / `route`
- `runtime_main` / `runtime_shadow`
- `ruleset_version`
- `diff_summary`（可索引）
- `payload_refs`（可选：用于回放；存储时需脱敏）

**任务清单**：

- [ ] 设计 diff 记录 schema
- [ ] 实现 diff 存储（索引 + 保留策略）
- [ ] 实现脱敏规则（PII hash + mask，secrets 完全移除）
- [ ] 实现 diff 查询接口（按 requestId/ruleset）

---

## 阶段 3：责任归属与修复路径

### 3.1 责任归属表（Owner + Fix Location）

> [!important] 修复入口
> 所有 diff 必须能被归因到“修复路径”：`compat` vs `wasm core`（Host 永远不是修复入口）。

| 模块 | Owner | 修复路径 | 入口函数/文件（示例） |
|---|---|---|---|
| tokenizer | @team/core | wasm core | `llmswitch-core/src/tokenizer/*` |
| tools | @team/tools | wasm core | `llmswitch-core/src/tools/*` |
| compat | @team/compat | compat adapter | `llmswitch-core/src/conversion/compat/*` |
| streaming | @team/streaming | wasm core | `llmswitch-core/src/streaming/*` |
| routing | @team/routing | wasm core | `llmswitch-core/src/routing/*` |

**任务清单**：

- [ ] 产出责任归属表（`docs/llms-wasm-ownership-table.md`）
- [ ] 实现自动归因逻辑（diff → module + owner + fix location）

### 3.2 修复闭环

1. 影子 diff 收集 → 2. 分类（compat/logic/nondeterministic） → 3. 修复 → 4. 基线回放验证 → 5. diff 下降 → 6. 推进模块替换阶段

**任务清单**：

- [ ] 实现 diff 分类器（compat_issue / logic_bug / nondeterministic / data_quality）
- [ ] 实现修复建议生成（自动推断 fix location）
- [ ] 集成基线回放验证（修复后自动回归）
- [ ] 实现 diff 下降趋势监控

---

## 阶段 4：模块级替换（shadow → canary → default）

### 4.1 建议替换顺序（低风险 → 高风险）

1. tokenizer/encoding
2. tool canonicalization
3. compat layer
4. streaming response formatting (SSE)
5. routing decision logic

**任务清单**：

- [ ] 确认替换顺序（风险评级）
- [ ] 定义每个模块的验收阈值（diff rate / error rate / latency delta）
- [ ] 定义观察期时长（shadow/canary/default）

### 4.2 每个模块的替换 Gate

> [!note] 状态机
> `shadow → canary → default → deprecated → removed`

- shadow：TS 主路，WASM 影子；跑满观察期（建议 1-2 周）
- canary：WASM 主路小流量（5-10%），TS 影子；对稳定性最敏感
- default：WASM 主路大流量（50-100%）；TS 影子可逐步关闭
- deprecated：TS 保留 2-3 个 release 作为 fallback

#### 验收门槛（示例，按模块调整）

- diff rate：按模块设阈值（tokenizer 可到 0.01%，streaming 可到 0.5%）
- error rate：≤ 0.1%（canary 阶段更严格）
- latency delta：P95 ≤ +10ms（或按模块调整）

**任务清单**：

- [ ] 实现模块状态机（shadow/canary/default/deprecated）
- [ ] 实现自动 gate 切换（满足阈值后自动推进）
- [ ] 实现回滚触发器（diff 激增 / 错误率超阈值 / 性能降级）
- [ ] 文档化每个模块的验收阈值

---

## 阶段 5：安全与可观测性

### 5.1 必需指标

- `diff_rate`（按 module/tenant/route/ruleset）
- `shadow_error_rate`（按 runtime）
- `latency_delta_p50/p95/p99`
- `wasm_init_time` / `wasm_memory`

**任务清单**：

- [ ] 实现指标上报（通过 `providerErrorCenter` + `errorHandlingCenter`）
- [ ] 实现指标分维度聚合（tenant/route/module/runtime/ruleset）
- [ ] 实现指标查询接口（Prometheus/自定义）

### 5.2 告警与 Error Budget

- diff 突增（超过阈值 2x）
- shadow error rate 超阈值
- 主路延迟显著上升
- WASM 初始化失败/崩溃

> [!warning] 自动回滚建议
> 若具备自动回滚能力：以“错误率 + 延迟 + diff 突增”作为触发器，回滚到 `ts_primary` 或回滚单模块。

**任务清单**：

- [ ] 实现告警规则配置（diff/error/latency/threshold）
- [ ] 实现自动回滚触发器（单模块 / 全局）
- [ ] 实现回滚开关（环境变量 + config）
- [ ] 文档化告警与回滚流程

---

## 阶段 6：正式切换与清理

### 6.1 版本策略

- TS 逻辑保留 2-3 个 release（建议）
- 在 release note 标记迁移状态与开关说明
- 在移除双路 diff 逻辑前：保留 ruleset 版本与历史 diff 归档

**任务清单**：

- [ ] 定义 TS 保留策略（版本数量 / 时长）
- [ ] 更新 release note 模板（迁移状态）
- [ ] 实现 ruleset 版本归档
- [ ] 实现历史 diff 归档

### 6.2 清理原则

> [!important] No deletions without approval
> 如需删除现有文件或大规模移除 TS 路径，必须先提案并获得确认。

清理候选（仅列举，不直接执行）：

- 移除 TS 专用实现（在确认无流量后）
- 移除双路 diff 代码（若不再需要审计）
- 更新 docs/ 与 CLI 运行手册

**任务清单**：

- [ ] 制定清理提案（需 approval）
- [ ] 实现清理脚本（可选，自动化）
- [ ] 更新文档（README / docs/）
- [ ] 更新 CLI 运行手册

---

## 附录 A：Ruleset 版本化规范

### A.1 命名与存放

- 命名：`diff_ruleset_vN`
- 存放：`llmswitch-core/src/diff/rulesets/`

### A.2 必含字段

- `version`（v1/v2/...）
- `created_at`（日期）
- `field_whitelist`（忽略字段）
- `tolerance_policy`（容忍策略）
- `nondeterministic_rules`（非确定性规则）
- `sse_protocol`（SSE 协议版本）

### A.3 升级流程

1. 新增 v(N+1) ruleset（不改旧版本）
2. 切换 `current_ruleset` 指针
3. 所有 diff 记录写入 `ruleset_version`

**任务清单**：

- [ ] 创建 ruleset 目录结构
- [ ] 实现 `diff_ruleset_v1`（初始版本）
- [ ] 实现 ruleset 版本管理（current 指针）
- [ ] 文档化 ruleset 升级流程

---

## 附录 B：Diff 存储与脱敏

### B.1 索引字段

- `requestId`
- `tenant`
- `route`
- `ruleset_version`
- `timestamp`

### B.2 保留策略

- 全量：7-14 天
- 采样摘要：30-90 天

### B.3 脱敏规则

- PII：hash + mask（结构保留）
- secrets：完全移除（不入库）
- stack：stack hash（用于聚类），必要时保留截断 stack（受访问控制）

**任务清单**：

- [ ] 设计 diff 存储索引（支持高效查询）
- [ ] 实现保留策略（全量 / 采样 / TTL）
- [ ] 实现脱敏规则（PII / secrets / stack）
