# Windsurf 同 session 多轮调用对齐 Windsurf.app — 实现计划

依赖文档：

- `docs/design/windsurf-cascade-reentry-account-strategy.md`
- `docs/design/windsurf-cascade-execution-plan.md`
- `docs/providers/windsurf-chat-provider-design.md`

## 目标与验收标准

### 目标

单账号、单 LS runtime、单 session，稳定完成 Windsurf.app 风格多轮调用：

1. 同 session 连续多轮对话复用同一 `cascadeId`。
2. 遇到 `CASCADE_RUN_STATUS_RUNNING` 时 bounded retry，不重建、不切号、不记 account failure。
3. 超时 fail-fast，错误可观测。
4. 从巨型 `windsurf-chat-provider.ts` 拆出函数库 + blocks + 纯编排层。

### 验收标准

- 同 session 连续两轮不重建 cascade。
- `CASCADE_RUN_STATUS_RUNNING` 触发 bounded retry，不 rebuild。
- retry 成功后返回完整 assistant response。
- 超时 fail-fast 返回 `WINDSURF_CASCADE_BUSY`。
- provider 不把 cascade busy 归类为 account failure。
- `npm run probe:windsurf-continuation` 可一键复跑。
- `npx jest --config jest.config.js tests/providers/core/runtime/windsurf-cascade-continuation.spec.ts` 全绿。
- 编译安装通过，不引入 TypeScript 报错。

## 范围与边界

### In Scope

1. 把需要功能从巨型文件迁出到新小模块重写，provider 只保留编排，然后删除旧实现。
2. 新增 cascade busy retry 逻辑。
3. 新增 `WINDSURF_CASCADE_BUSY` 错误码。
4. 新增 7 个单元测试。
5. 新增真实 LS probe 脚本。

### Out of Scope

1. 多账号 session 绑定（后续 Phase 2）。
2. Virtual Router / Hub Pipeline 改动。
3. Windsurf.app UI 对齐（只对齐协议与行为语义）。

## 设计原则

1. 函数库：无状态，只做数据转换、proto 编解码、文本构建。
2. Blocks：有状态但职责单一，如 gRPC transport、auth、cascade lifecycle、session binding、runtime management。
3. Provider 主体：纯编排层，只调度 blocks，不承载实现细节。
4. 禁止 fallback / 降级 / 双路径。
5. 禁止在 Hub Pipeline / Virtual Router 写 provider 特例。

## 模块拆分

### 拆分后文件清单

```text
src/providers/core/runtime/windsurf/
  windsurf-proto-utils.ts                (新建，纯函数)
  windsurf-cascade-prompt.ts             (新建，纯函数)
  windsurf-cascade-transport-block.ts    (新建，有状态 block)
  windsurf-cascade-lifecycle-block.ts    (新建，有状态 block)
  windsurf-cascade-session-block.ts      (新建，有状态 block)
  windsurf-auth-block.ts                 (新建，有状态 block)
  windsurf-runtime-management-block.ts   (已有，有状态 block)
  windsurf-response-parsing-block.ts     (已有，纯函数)
  windsurf-history-projection-block.ts   (已有，纯函数)
  windsurf-account-store.ts              (已有)
  windsurf-account-pool.ts               (已有)
  windsurf-account-session-manager.ts    (已有)

src/providers/core/runtime/windsurf-chat-provider.ts
  纯编排层
```

### windsurf-proto-utils.ts

纯函数，无状态：

- `encodeProtoVarintValue` / `encodeProtoTag` / `writeProtoVarintField` / `writeProtoBoolField` / `writeProtoStringField` / `writeProtoMessageField`
- `parseProtoFields` / `getProtoField` / `getAllProtoFields` / `readProtoString` / `readProtoNumber`
- `parseWindsurfModelUsageStats` / `tryParseWindsurfCompletionDeltaProto`
- `buildCascadeStepBody` / `buildCascadeAdditionalStep` / `buildCascadeMcpToolStep`
- `grpcFrame` / `decodeGrpcFramePayload` / `stripGrpcFrame` / `extractGrpcFrames`

### windsurf-cascade-prompt.ts

纯函数，无状态：

- `extractLatestCascadeUserText`
- `buildCascadeHistoryTurnText`
- `buildWindsurfNativeToolAliasText`
- `rewriteWindsurfNativeToolAliasesInText`
- `extractWindsurfToolChoiceName`
- `readDeltaSeedParts`
- `buildCompletedNativeToolCallIds`
- `buildCompletedNativeToolSignatures`
- `buildWindsurfNativeToolSignature`
- `isWindsurfNativeToolName`
- `readBridgeToolHistoryPairs`
- `appendBridgeToolHistoryToSemanticConversation`

### windsurf-cascade-transport-block.ts

gRPC session + framing + unary：

- `grpcUnaryLocal`
- `getLocalGrpcSession`
- `closeLocalGrpcSession`
- `resolveLiveLocalGrpcRuntime`

### windsurf-cascade-lifecycle-block.ts

Cascade 生命周期核心：

- `sendStartCascade`
- `sendCascadeMessage`（含 busy retry）
- `pollCascadeTrajectorySteps`
- `ensureWindsurfCascadeWarmup`
- `buildCascadeCompletionFromOutput`
- `classifyWindsurfCascadeError`
- `resolveWindsurfCascadeBusyError`（新增）

### windsurf-cascade-session-block.ts

session binding + runtime pinning：

- `selectUsablePinnedGrpcRuntime`
- `rememberWindsurfCascadeSessionBinding`
- `normalizeWindsurfSessionKey`
- `markWindsurfSessionActive` / `markWindsurfSessionStopped`
- `cleanupReleasedWindsurfSessions`
- `runWindsurfCascadeSendExclusive`
- `resetWindsurfCascadeTransportState`
- `setPinnedGrpcRuntime` / `clearPinnedGrpcRuntime`

### windsurf-auth-block.ts

认证 + token 管理：

- `ensureWindsurfSessionCredential`
- `resolveCascadeApiKey`
- `resolveWindsurfSessionStateKeyFromRequest`
- `selectWindsurfAccount`
- `resolveWindsurfTokenFilePath`
- `loadPersistedWindsurfSessionCredential`
- `persistWindsurfSessionCredential`
- `loginWindsurfSessionCredential`
- `clearManagedWindsurfSessionCredential`
- `buildCascadeAuthProbeHeaders`
- `buildCascadeAuthProbeBody`
- `buildAccountLoginHeaders`
- `fetchCascadeModelConfigsForSite`

### windsurf-chat-provider.ts

只保留：

- `sendRequestInternal`：调度 lifecycle + session + prompt + response。
- `preprocessRequest`：调用纯函数库做请求预处理。
- `checkHealth`：调用 auth block + lifecycle block。
- 状态字段声明 + 构造函数。

## Cascade Busy 逻辑设计

### busy 识别

```text
error.message 包含 "CASCADE_RUN_STATUS_RUNNING"
  → resolveWindsurfCascadeBusyError(error) 返回 true
```

### retry 策略

```text
backoff: 1s → 2s → 4s → 8s
retry 上限: 4 次
每次 retry 使用同一 cascadeId + sessionId
```

### 错误码

新增 `WINDSURF_CASCADE_BUSY`：

```typescript
code: 'WINDSURF_CASCADE_BUSY'
status: 429
retryable: true
```

### busy 行为

1. 保留当前 `cascadeId`。
2. 不 `resetWindsurfCascadeTransportState`。
3. 不重新 `StartCascade`。
4. 不调 `markQuotaExhausted` / `markAuthInvalid` / `markRuntimeFailure`。
5. retry 成功后继续正常 poll。
6. retry 全部失败后返回 `WINDSURF_CASCADE_BUSY`。

## 风险与规避

| 风险 | 影响 | 规避 |
|---|---|---|
| executor settle 时间不稳定 | retry 次数不确定 | retry 上限固定，超时 fail-fast |
| 拆分后模块边界不清 | 循环依赖 | 函数库无状态，block 只依赖函数库 |
| 现有测试断裂 | 回归 | 先迁移位置，保持行为，再加新逻辑 |
| TypeScript 编译错误 | 构建失败 | 小步拆分，每步跑定向 tsc/jest |

## 测试计划

### Unit Tests

**新增文件**：`tests/providers/core/runtime/windsurf-cascade-continuation.spec.ts`

| # | 测试名 | 验证什么 |
|---|---|---|
| 1 | same-session-reuses-cascade | 同 sessionKey 连续两轮复用同一 cascadeId |
| 2 | running-error-triggers-bounded-retry | sendCascadeMessage 返回 RUNNING 时 bounded retry |
| 3 | retry-uses-same-cascade-id | retry 过程中 cascadeId 不变 |
| 4 | retry-success-preserves-stepOffset | retry 成功后 stepOffset 正确推进 |
| 5 | retry-timeout-returns-explicit-busy | 超过最大等待返回 WINDSURF_CASCADE_BUSY |
| 6 | busy-does-not-call-account-failure | RUNNING 错误不调 markQuotaExhausted/markAuthInvalid |
| 7 | running-does-not-trigger-rebuild | RUNNING 错误不调 StartCascade |

### Real LS Probe

**脚本**：`scripts/windsurf-cascade-continuation-probe.ts`

1. `StartCascade` + first `SendUserCascadeMessage` succeeds.
2. Immediate second message returns `CASCADE_RUN_STATUS_RUNNING`.
3. Waiting/retrying same cascade eventually succeeds.
4. No new `StartCascade` happens during retry.
5. Session isolation verified (different sessionId → different cascadeId).

## 实施顺序

1. 新增 `windsurf-proto-utils.ts`：提取 proto util 纯函数。
2. 新增 `windsurf-cascade-prompt.ts`：提取 prompt 纯函数。
3. 新增 `windsurf-cascade-transport-block.ts`：gRPC transport block。
4. 新增 `windsurf-cascade-lifecycle-block.ts`：cascade lifecycle block + busy retry。
5. 新增 `windsurf-cascade-session-block.ts`：session binding block。
6. 新增 `windsurf-auth-block.ts`：auth block。
7. 重构 `windsurf-chat-provider.ts` 为纯编排层。
8. 新增 `WINDSURF_CASCADE_BUSY` 错误码。
9. 新增 `windsurf-cascade-continuation.spec.ts`（先红）。
10. 实现 busy retry 逻辑（转绿）。
11. 新增 `scripts/windsurf-cascade-continuation-probe.ts`。
12. 跑 probe + build + install + restart 验证。

## 完成定义（DoD）

- 巨型文件 `windsurf-chat-provider.ts` 从 5000+ 行收缩到 ≤ 1500 行（纯编排）。
- 所有函数库模块无状态、可独立测试。
- 所有 block 模块职责单一、无循环依赖。
- 同 session 多轮调用不重建 cascade，对齐 Windsurf.app 行为。
- 所有新增测试全绿。
- 编译安装通过，不引入 TypeScript 报错。
- probe 脚本可一键复跑。
