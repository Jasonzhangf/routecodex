# Metadata Center Implementation Plan

## 目标与验收标准

### 目标

实现 request-scoped `MetadataCenter`，把当前分散的 flat metadata merge/backfill 收敛成单一中心，先完成 `request_truth` 与 `continuation_context` 两个 family 的真实落地，再迁移 stopless/servertool 消费侧，最后物理删除旧 merge/backfill 路径。

### 验收标准

- 当前请求存在唯一 `MetadataCenter` 实例，按 request 作用域隔离，不做全局 singleton。
- `sessionId` / `conversationId` / `requestId` / `pipelineId` 只从 `request_truth` 读取；`responsesRequestContext.*` 不得再 materialize 为 request truth。
- stopless/servertool 不再从多来源回填 session truth，而是只读 center 投影。
- `buildHandlerPipelineMetadata`、`finalizeRequestExecutorAttemptMetadata`、`servertool-adapter-context` 中已确认错误的 flat merge/backfill 逻辑被物理删除或降为薄壳投影；原 `servertool-request-normalizer` 单函数文件已内联删除。
- metadata center 保留 provenance：至少能回答值是谁写的、在哪个 stage 写的、是否允许覆盖。
- red test 先红后绿；实现后必须跑 build 和现网/真实样本 replay，不得只靠单测宣称完成。

## 范围与边界

### In Scope

- request-scoped metadata center 结构、API、family/slot/provenance contract。
- 第一阶段实现 `request_truth` 与 `continuation_context`。
- 第二阶段迁移 stopless/servertool/read-side。
- 替换以下已确认漂移点：
  - `src/server/handlers/handler-utils.ts::buildHandlerPipelineMetadata`
  - `src/server/runtime/http-server/executor/request-executor-attempt-state.ts::finalizeRequestExecutorAttemptMetadata`
  - `src/server/runtime/http-server/executor/servertool-adapter-context.ts`
  - `src/modules/llmswitch/bridge/responses-request-bridge.ts`
  - `src/server/runtime/http-server/executor-metadata.ts`
- mainline source / function-map / verification-map / wiki 跟实现同步收口。

### Out of Scope

- 本轮不重做 provider outbound metadata boundary 方案本身；只要求新 center 不破坏现有隔离边界。
- 本轮不实现完整 `runtime_control` / `client_attachment_scope` / `debug_snapshot` / 全量 response-observation 迁移。
- `provider_observation` 已从 contract-only 升级到第一阶段真实落地：当前至少覆盖 `target/providerKey/assignedModelId/modelId/clientModelId/compatibilityProfile` 的 center-backed 写入与关键读路径；剩余 response-side observation 仍待后续收口。
- 本轮不顺手改 unrelated session binding、tmux 注入、provider health、quota、retry。

## 设计原则

1. request-scoped only：metadata center 只活在单个 request/response 闭环，不允许跨请求共享。
2. provenance first：slot 除了 value，还必须记录 `module/symbol/stage/status/writePolicy/history`。
3. family hard split：`request_truth`、`continuation_context`、`runtime_control`、`provider_observation`、`client_attachment_scope`、`debug_snapshot` 禁止平铺在同一 namespace。
4. request truth write-once：除入口 materialize owner 外，后续阶段只能读，不能重定义。
5. continuation is not request truth：`responsesRequestContext.sessionId/conversationId` 永远是 continuation context，不得升级为请求真相。
6. no fallback：识别不到 request truth 时，功能可以不激活，但不能回退到别的来源猜值。
7. physical deletion：旧 merge/backfill 逻辑不能只是闲置，迁完就删。

## 技术方案

### 1. 新建中心模块

建议路径：

- `src/server/runtime/http-server/metadata-center/`

建议文件：

- `metadata-center-types.ts`
- `metadata-center.ts`
- `metadata-center-request-truth.ts`
- `metadata-center-continuation-context.ts`
- `metadata-center-projection.ts`

最低 contract：

- `createMetadataCenter(seed)`
- `writeRequestTruth(...)`
- `attachContinuationContext(...)`
- `readRequestTruth()`
- `readContinuationContext()`
- `projectServertoolAdapterContext(...)`
- `finalizeMetadataCenter(...)`

### 2. family / slot 模型

第一阶段最小 family：

- `request_truth`
  - `requestId`
  - `pipelineId`
  - `entryEndpoint`
  - `sessionId`
  - `conversationId`
  - `clientRequestId`
  - `portScope`
- `continuation_context`
  - `responsesRequestContext`
  - `responsesResume`
  - `previousResponseId`
  - `responseId`
  - `toolOutputs`
  - `continuationOwner`
  - `resumeFrom`
  - `chainId`
  - `stickyScope`

每个 slot 至少保存：

- `value`
- `family`
- `writtenBy.module`
- `writtenBy.symbol`
- `writtenBy.stage`
- `status`
- `writePolicy`
- `version`
- `history`

### 3. 第一刀 owner 定位

#### `request_truth` materialize owner

建议唯一 owner：

- `src/server/runtime/http-server/executor-metadata.ts`

职责：

- 从当前请求 seed materialize request truth
- 拒绝从 continuation/tmux scope 回填 request truth
- 产出 request-scoped metadata center

#### `continuation_context` attach owner

建议唯一 owner：

- `src/modules/llmswitch/bridge/responses-request-bridge.ts`

职责：

- 只把 responses continuation 相关数据写入 `continuation_context`
- 不得写回 `request_truth`

### 4. 旧路径替换策略

#### A. 入口 merge 替换

目标：

- handler entry metadata builder 不再是 request truth 真源

做法：

- 把 request truth materialize 前移到 metadata center owner
- handler entry metadata builder 若仍保留，只能变为 thin projection/compat shell，随后删除

#### B. executor attempt merge 替换

目标：

- `finalizeRequestExecutorAttemptMetadata` 不再继续平铺 merge request truth + continuation

做法：

- 改成读取 center，再只追加 runtime-result projection
- provider target / compatibility 观察值改写入 `provider_observation` family，不得复活 flat `metadata.target` / `metadata.compatibilityProfile`
- 第一阶段若 runtime_control 尚未迁完，只允许返回显式 projection，不允许重写 request truth

#### C. servertool/stopless read path 替换

目标：

- `buildServerToolAdapterContext` 不再从 top-level metadata / nested metadata / `__rt` / captured request 多源猜 session

做法：

- 注入 metadata center read-only projection
- request truth 只读 center
- continuation context 只作为 continuation context 单独读取
- 识别不到 request truth 时 stopless 不激活，但 loop guard/非激活路径仍要自然停

### 5. 迁移顺序

1. 补测试设计与红测
2. 新建 metadata center types/API
3. 接入 `request_truth`
4. 接入 `continuation_context`
5. stopless/servertool 改读 center projection
6. 删除 flat merge/backfill
7. 更新 wiki/mainline/function-map/verification-map
8. build + live replay

## 文件清单

### 新增

- `docs/goals/metadata-center-implementation-plan.md`
- `src/server/runtime/http-server/metadata-center/*`
- 对应测试文件

### 修改

- `src/server/runtime/http-server/executor-metadata.ts`
- `src/server/handlers/handler-utils.ts`
- `src/server/runtime/http-server/executor/request-executor-attempt-state.ts`
- `src/server/runtime/http-server/executor/request-executor-pipeline-attempt.ts`
- `src/server/runtime/http-server/executor/servertool-adapter-context.ts`
- `src/server/runtime/http-server/executor/provider-request-context.ts`
- `src/server/runtime/http-server/executor/provider-response-utils.ts`
- `src/modules/llmswitch/bridge/responses-request-bridge.ts`
- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/wiki/metadata-center-mainline-source.md`
- `docs/architecture/metadata-center-manifest.yml`

### 待删除候选

- 与 request truth / continuation context 等价的旧 merge/backfill helper
- 任何继续从 `responsesRequestContext.*` 回填 request `sessionId/conversationId` 的旧路径
- 任何继续把 tmux scope 当 request truth 的旧路径

## 风险与规避

### 风险 1

stopless/session 现网问题再次出现，变成“不激活”或“无限循环”。

规避：

- 正向测试：该激活时会激活
- 反向测试：没有 request truth 时不激活
- loop guard 测试：即使 schema 缺失/执行错误，也必须在次数耗尽后自然停

### 风险 2

先引入 center，又保留旧 merge/backfill，变成双真源。

规避：

- 每迁完一个 owner，就立刻物理删除旧写入点
- 禁止“先接 center，再保留旧路径以防万一”

### 风险 3

provenance 做成空壳，写了 center 但查不出谁覆盖了值。

规避：

- 测试里直接断言 `writtenBy/stage/writePolicy/history`
- 没有 provenance 不算完成

## 测试计划

### 白盒单测

- `request_truth` 只接受合法 seed owner 写入
- `request_truth` write-once；非法 overwrite 直接失败
- `continuation_context` 可写入，但不能改写 `request_truth`
- provenance/history 正常累积

### 模块黑盒

- `responsesRequestContext` only 场景：
  - 不能 materialize request `sessionId`
  - stopless 不得误激活
- request metadata 明确有 `sessionId` 场景：
  - stopless 应激活
- tmux-only 场景：
  - 不得 materialize request truth

### 项目黑盒

- 复现之前 stopless 无限循环样本：
  - 达到次数后自然停
- 复现之前“该激活时没激活”样本：
  - request truth 在中心存在时必须激活
- replay 已知 `responsesRequestContext` 污染样本：
  - 不再误激活

### 必跑验证

- 定向 Jest/red tests
- `npm run build:min`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `node scripts/architecture/verify-architecture-wiki-sync.mjs`
- `node scripts/architecture/verify-architecture-wiki-html-sync.mjs`
- 编译、全局安装、重启服务器
- 已知线上样本 replay

## 实施步骤

1. 先补 metadata center 第一阶段测试设计与红测，锁 `request_truth`/`continuation_context`/stopless 激活边界。
2. 新建 request-scoped metadata center 模块与 slot/provenance contract。
3. 把 `executor-metadata` 改成 `request_truth` 唯一 materialize owner。
4. 把 `responses-request-bridge` 改成 `continuation_context` 唯一 attach owner。
5. 改 stopless/servertool 为 center read-only projection。
6. 物理删除旧 merge/backfill 路径。
7. 补 docs/mainline/wiki/manifest/function-map/verification-map 同步。
8. 跑测试、build、安装、重启、真实样本 replay。

## 完成定义（DoD）

- metadata center 第一阶段已真实接管 request truth 与 continuation context。
- stopless/servertool 不再多源猜 session truth。
- `responsesRequestContext.*` 不再污染 request truth。
- 无 request truth 时 stopless 可不激活，但绝不无限循环。
- 旧 merge/backfill 死语义已物理删除。
- 文档、HTML、machine-readable manifest、mainline map、验证栈同步更新。
- 定向测试、构建、全局安装、服务器重启、真实样本 replay 全部有证据。
