# Metadata Lifecycle Cleanup Plan (Revised)

Audit date: 2026-06-XX
Auditor: Reasonix Code
Status: Plan only — not yet executed

## 真实泄漏路径（审计修正）

实际代码审计发现：`__routecodex`（对象）出现在 `resolveRequestSemantics()` 的返回值中，该返回值作为 `requestSemantics` 供内部 followup dispatch 消费——**不直接进入客户端响应 body**。

但存在以下真实问题：

### 问题 1：控制字段散落三个层级

当前 `serverToolFollowup` 和 `serverToolFollowupSource` 被写在三个地方：

| 层级 | 写入点 | 消费者 |
|---|---|---|
| `requestSemantics.__routecodex.serverToolFollowup` | `provider-response-utils.ts:238-253` | `servertool-followup-dispatch.ts` 读取 |
| `metadata.serverToolFollowup` | `servertool-adapter-context.ts:60-63` | 多处在 `metadata` 顶层读取 |
| `metadata.__rt.serverToolFollowup` | `runtime-metadata.ts` | 标准 `readRuntimeMetadata()` 入口 |

这违反了"单一真源"原则。`__rt` 是真源，其他两个是冗余副本。

### 问题 2：`resolveRequestSemantics` 不该负责打标记

`resolveRequestSemantics()` 是 response normalization 阶段的函数，却在这里写 `__routecodex.*` 到 request semantics 中。这个标记应由 `servertool-followup-dispatch.ts` 消费，但后者已经从 `metadata.__rt` 读取——说明此处是**旧的冗余注入**。

### 问题 3：`metadata.*` 顶层读控制字段（已确认）

`servertool-adapter-context.ts:60-63` 和 `stop-message-auto.ts:262-271` 直接在 `metadata.*` 顶层读 `serverToolFollowup` 和 `stopMessageEnabled`，未走 `__rt`。

## 设计原则（不变）

- `metadata.__rt` 是控制面字段唯一真源
- `metadata` 顶层只存放来自客户端的合法字段
- provider outbound payload 不得包含任何控制面字段（已由 policy engine + allowlist 保证，无需改动）
- requestSemantics 不应包含控制面标记——这些标记应走 `metadata.__rt`

## 修复步骤

### Step 1: 移除 `resolveRequestSemantics` 中的 `__routecodex` 注入

**文件**：`src/server/runtime/http-server/executor/provider-response-utils.ts`

**改动**：删除函数末尾的 `__routecodex` 对象组装和返回。`serverToolFollowup` 和 `serverToolFollowupSource` 的消费者（`servertool-followup-dispatch.ts` 等）已经通过 `metadata.__rt` 读取，不依赖 `requestSemantics.__routecodex`。

**验证**：
- grep 确认所有读取 `requestSemantics.__routecodex` 的地方已通过 `__rt` 获取
- 跑 `tests/server/runtime/http-server/provider-response-utils.request-semantics.spec.ts` 确认测试更新
- 跑 `tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts` 确认 followup dispatch 正常工作

**风险**：中。需更新 10+ 个测试文件，但生产逻辑不变（消费者已从 `__rt` 读取）。

### Step 2: 控制字段读取统一走 `__rt`

**范围**：

| 文件 | 当前 | 目标 |
|---|---|---|
| `servertool-adapter-context.ts:60-63` | `metadata.serverToolFollowup` | `readRuntimeMetadata(record).serverToolFollowup` |
| `stop-message-auto.ts:262-271` | `record.stopMessageEnabled`, `record.routecodexPortStopMessageEnabled` | `readRuntimeMetadata(record)?.stopMessagePortEnabled` |
| `provider-response-utils.ts:194-200` | `processedMetadata?.serverToolFollowup` | `processedRt?.serverToolFollowup`（已走 `readRt`） |

**验证**：`grep '\.serverToolFollowup'` 确认只从 `__rt` 读取。

**风险**：低——字段值来源不变，只改读取路径。

### Step 3: 补测试

1. 更新 `provider-response-utils.request-semantics.spec.ts` — 删除对 `__routecodex` 的断言，或改为断言 `__routecodex` 不存在
2. 更新 `servertool-followup-dispatch.spec.ts` — 确认 followup dispatch 不从 `requestSemantics.__routecodex` 读

## 验收标准

1. `grep -r '__routecodex.*serverToolFollowup' src/` 返回空（不再有 `__routecodex` 注入）
2. `grep -r '\.serverToolFollowup' src/ --include='*.ts'` 只命中 `metadata.__rt` 路径
3. 全部现有测试通过
4. 无 `metadata.*` 顶层读取控制字段的代码
