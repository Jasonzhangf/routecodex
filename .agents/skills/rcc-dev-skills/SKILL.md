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
2. `docs/agent-routing/00-entry-routing.md`
3. `references/24-node-contract-debug-method.md`
4. `docs/agent-routing/40-task-memory-routing.md`
5. 本 skill 路由表对应的小文件

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

### 2. 再做三问
1. 失败在哪一段？
2. 这一段唯一 owner 是谁？
3. 最小 gate 和 live probe 是什么？

### 3. 最后闭环
1. red test / failing sample
2. 改唯一 owner
3. green gate
4. live replay old sample
5. note → MEMORY → lessons

## 硬护栏
- 单一路径：`HTTP -> Hub Pipeline -> VR -> Provider Runtime -> Upstream`
- Rust 真源优先：Hub Pipeline / Chat Process / 路由 / servertool 语义默认查 Rust
- 禁止 fallback / 静默吞错
- `feature_id` 改动必须同步 map + verification + source anchor
- `~/.rcc` 是运行时配置真源
- server handler 不得长出第二套协议解析
- gate 只是门禁；完成必须有 live/runtime 证据

## 快查命令
- 查 owner：
  - `rg -n 'feature_id: <id>' docs/architecture/function-map.yml`
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
