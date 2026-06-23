# `--snap` 默认 raw 边界 + 按入口 port 归档执行计划

## 1. 目标与验收标准

### 目标

把 `--snap` 收口为默认记录四个边界 raw：

- 入口 client request raw
- provider outbound request raw
- provider inbound response raw
- client final response raw

并统一按入口 `port` 归档，保证所有默认 `--snap` 样本都落到：

```text
~/.rcc/codex-samples/<endpointFolder>/ports/<port>/<groupRequestId>/
```

必要时同目录内保留 provider token 子段，但 `ports/<port>/` 必须是强制主桶，禁止 `port-unknown`、禁止裸 provider 反推主桶。

### 验收标准

1. `routecodex --snap` 默认 selector 只开四件套：`client-request` / `provider-request` / `provider-response` / `client-response`。
2. `client-request` 保存真正入口 raw，而不是仅保存 parse 后对象；若入口 body 已被框架 parse，必须新增显式 raw capture 真源。
3. `provider-request` 保存真实 provider outbound wire payload。
4. `provider-response` 保存真实 provider inbound raw：
   - JSON 路径保存完整 raw response body。
   - SSE 路径保存实际 upstream SSE 文本，不得只落 transport/meta 占位。
5. `client-response` 保存真实 client final raw：
   - JSON 路径保存最终投影给 client 的 body。
   - SSE 路径保存最终发给 client 的 SSE text/frame。
6. 所有默认 snapshot 目录必须带 `ports/<port>/`；缺 port 必须 fail-fast 或显式阻断写盘，禁止 `port-unknown`/旧裸目录继续增长。
7. 旧非 `ports/<port>/` snapshot 主路径实现从 `src/` 物理删除。
8. 完成后必须用真实 `--snap` live 样本验证 5555 或指定端口四件套齐全，且 raw 语义满足上面 2-5。

## 2. 范围与边界

### In Scope

- `--snap` 默认 stage selector
- server 入口 raw capture
- provider request/response raw capture
- client response raw capture
- snapshot path 归档规则
- 相关测试、architecture gate、function-map / doc 同步

### Out of Scope

- 不改 Hub Pipeline / VR 业务语义
- 不改 provider routing / failover 语义
- 不改 servertool / stopless 生命周期
- 不新增 fallback / dual-path 补偿

## 3. 设计原则

1. 真 raw 优先，不接受“解析后对象假装 raw”。
2. 默认 `--snap` 只保留最小四件套，不膨胀为模块级全量快照。
3. `ports/<port>/` 是 snapshot 主桶强约束，不允许 provider 反推目录为主。
4. SSE/JSON 都必须保留真实出口文本/载荷，不接受仅 meta 占位。
5. 不靠 debug facade 口头统一；要么真正唯一 owner，要么明确当前 split owner 并按单点修改。
6. 禁止 fallback：缺 raw、缺 port、缺 stage 直接显式暴露，不做 silent degrade。

## 4. 技术方案

### 4.1 默认 selector 与 stage contract

- 真源：
  - `src/utils/snapshot-stage-policy.ts`
  - `docs/architecture/snapshot-stage-contract.md`
- 动作：
  - 保持默认 selector 四件套。
  - 明确 `client-request` / `provider-request` / `provider-response` / `client-response` 的 raw 语义，不允许“边界名是 raw、实现不是 raw”。

### 4.2 入口 request raw

- 当前问题：
  - server 入口中间件走 `express.json(...)` 后，`writeInboundClientSnapshot` 只写 `input.body`，不是字节级 raw。
- 目标修复：
  - 在 HTTP middleware/adapter 层捕获原始 request body 文本或字节，并绑定到 request-scoped truth。
  - `client-request` snapshot 必须优先写这个 raw truth；parse 后对象只能作为辅助 metadata，不可替代 raw。
- 候选修改点：
  - `src/server/runtime/http-server/middleware.ts`
  - `src/server/runtime/http-server/executor/request-executor-core-utils.ts`
  - `src/debug/snapshot/provider-writer.ts`
  - 可能需新增 `raw-body-capture.ts` 或 metadata-center reader

### 4.3 provider request raw

- 当前状态：
  - `provider-request` 基本已写 `requestInfo.body`。
- 要求：
  - 确认 direct / relay / responses provider / oauth recovery 等分支都走同一 raw writer。
  - 禁止 provider-request 只写 normalize 后摘要或 debug view。
- 关键文件：
  - `src/providers/core/runtime/http-request-executor.ts`
  - `src/providers/core/runtime/responses-provider.ts`
  - `src/debug/snapshot/provider-writer.ts`

### 4.4 provider response raw

- 当前问题：
  - 非 SSE 路径接近满足。
  - SSE 路径先写 meta，再由 stream capture 补写 `bodyText`；需确认默认 `--snap` 最终稳定落 raw SSE 文件，且命名/覆盖规则可预测。
- 目标修复：
  - 默认 `provider-response` 必须稳定产出 raw JSON 或 raw SSE text。
  - 若保留双文件写法，需文档和测试明确第一份/第二份语义；更优是默认 `provider-response.json` 就是 raw 主文件，meta 另起受控文件名。
- 关键文件：
  - `src/providers/core/runtime/http-request-executor.ts`
  - `src/debug/snapshot/provider-sse.ts`
  - `src/debug/snapshot/provider-writer.ts`

### 4.5 client response raw

- 当前状态：
  - JSON 路径写最终 sanitized body。
  - SSE 路径聚合最终写给 client 的 `bodyText`。
- 要求：
  - 继续保证 client-response 保存最终 outward raw，不被内部 metadata/debug carrier 污染。
  - 明确 JSON 和 SSE raw 语义写入 contract。
- 关键文件：
  - `src/server/handlers/handler-response-utils.ts`
  - `src/server/handlers/handler-response-common.ts`
  - `src/utils/snapshot-writer.ts`

### 4.6 按入口 port 归档

- 目标：
  - snapshot 主桶统一为 `.../<endpointFolder>/ports/<port>/<groupRequestId>/`
  - 缺 port 不得写入旧路径。
- 与现有文档对齐：
  - `docs/goals/snap-direct-relay-port-bucket-goal.md`
- 关键文件：
  - `src/debug/snapshot/writer.ts`
  - `src/debug/snapshot/provider-writer.ts`
  - `src/utils/errorsamples.ts`
  - path helper / retention helper

## 5. 文件清单

- `src/server/runtime/http-server/middleware.ts`
- `src/server/runtime/http-server/executor/request-executor-core-utils.ts`
- `src/providers/core/runtime/http-request-executor.ts`
- `src/providers/core/runtime/responses-provider.ts`
- `src/server/handlers/handler-response-utils.ts`
- `src/server/handlers/handler-response-common.ts`
- `src/debug/snapshot/writer.ts`
- `src/debug/snapshot/provider-writer.ts`
- `src/debug/snapshot/provider-sse.ts`
- `src/utils/snapshot-stage-policy.ts`
- `docs/architecture/snapshot-stage-contract.md`
- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`

## 6. 风险与规避

1. 风险：raw capture 引入重复存储/大 payload。
   - 规避：只对默认四件套做 raw；继续允许 snapshot payload size gate，但不能把 raw 语义偷偷改成摘要。
2. 风险：SSE raw 与 meta 双写导致文件语义混乱。
   - 规避：固定主文件语义并加 focused test；必要时拆出受控后缀文件。
3. 风险：入口 raw capture 改 middleware 影响解析链。
   - 规避：只做 read-only capture，不改 request 解析结果；补正反测试。
4. 风险：port 缺失导致路径断流。
   - 规避：在 writer 边界显式 fail-fast，并先补测试锁缺 port 行为。

## 7. 测试计划

### Focused tests

- `tests/utils/snapshot-stage-policy.spec.ts`
- `tests/providers/core/utils/snapshot-writer.release-gating.spec.ts`
- `tests/providers/core/utils/snapshot-writer.local-mirror.spec.ts`
- 新增：入口 raw capture focused test
- 新增：provider SSE raw snapshot focused test
- 新增：client SSE raw snapshot focused test
- 新增：port mandatory / no-port-unknown red test

### Gate / build

- `npm run verify:architecture-snapshot-stage-contract`
- `npm run verify:architecture-snapshot-stage-owners`
- `npm run verify:function-map-compile-gate`
- `npm run build:min`

### Live verification

- `routecodex restart --port 5555`
- 确认 `/health` 为目标全局安装版本后，再发带 `--snap` 的 JSON/SSE 请求
- 跑至少 1 个 JSON 请求、1 个 SSE 请求
- 核对 `~/.rcc/codex-samples/<endpoint>/ports/5555/<groupRequestId>/`
  - `client-request*.json`
  - `provider-request*.json`
  - `provider-response*.json`
  - `client-response*.json`
- 核对 raw 语义：
  - 入口 request 不是 parse 后替代品
  - provider SSE 有真实 upstream 文本
  - client SSE 有真实 outbound 文本

## 8. 实施步骤

1. 收紧/补全文档 contract：明确四件套 raw 语义与 port 主桶规则。
2. 修入口 raw capture 真源，先补红测再改代码。
3. 收口 provider-response SSE raw 主文件语义，补 focused test。
4. 复核 client-response JSON/SSE raw 语义并补缺口。
5. 清理旧非 `ports/<port>/` 主路径实现，补 port mandatory gate。
6. 跑 focused tests、architecture gates、build。
7. 全局安装/重启后跑 `--snap` live 样本复验。
8. 更新 `note.md` / 必要时 `MEMORY.md` 记录已验证真相。

## 9. 完成定义（DoD）

- 代码、文档、gate、tests 同步完成。
- 默认 `--snap` 四件套都是真 raw 边界，不再存在“名字是 raw、内容不是 raw”的缺口。
- snapshot 全部按入口 `ports/<port>/` 主桶归档。
- live 样本证明 JSON + SSE 至少各一条闭环成功。
- 汇报时明确：
  - 改了什么
  - 哪些 raw 已被真实保存
  - 哪些验证已完成
  - 剩余风险是否为零
