# /v1/responses handler single-bridge closeout plan

## 1. 目标与验收标准

目标：
- 收口 `/v1/responses` 的 server 边界，让 `src/server/handlers/responses-handler.ts` 与 `src/server/handlers/handler-response-utils.ts` 只保留 HTTP adapter 职责。

验收标准：
- server handler 不再拥有 Responses 协议解析、协议修补、continuation 生命周期语义、SSE 状态机语义。
- 上述语义只允许存在于：
  - `src/modules/llmswitch/bridge/responses-request-bridge.ts`
  - `src/modules/llmswitch/bridge/responses-response-bridge.ts`
- `docs/architecture/function-map.yml`、`docs/architecture/verification-map.yml`、对应 gate 与实现一致。
- 定向 Jest、TS 编译、bridge surface gate 全部通过。

## 2. 范围与边界

In scope：
- `/v1/responses` handler request/response 边界继续瘦身
- request bridge / response bridge façade 收口
- function-map / verification-map / 单桥接 gate 更新
- 对应 focused tests 修复与补强

Out of scope：
- provider runtime 语义修改
- Hub Pipeline Rust owner 之外的新功能扩展
- 无关路由或非 `/v1/responses` handler 重构

## 3. 设计原则

- server 只做 HTTP read/write、status/header、timeout/abort、stream write、日志。
- request protocol 语义只进 request bridge。
- response / SSE / continuation 语义只进 response bridge。
- 不做 fallback，不保留第二套 bridge，不在 server 留本地 helper 副本。
- 每次收口都要先有 gate，再有验证。

## 4. 技术方案

唯一 owner：
- request bridge：`src/modules/llmswitch/bridge/responses-request-bridge.ts`
- response bridge：`src/modules/llmswitch/bridge/responses-response-bridge.ts`

server 允许保留：
- HTTP 请求读取
- HTTP 响应写出
- stream 生命周期控制
- timeout / abort / close 监听
- 非语义日志与 metrics hook

server 必须移出的语义：
- Responses request 字段判定与续接语义
- tool_call -> responseId seed 语义
- SSE terminal 事件判定与状态机
- SSE frame 摘要解析与 provider protocol hint 解析
- chat.completion -> responses JSON/SSE 规范化语义
- continuation capture / record / finalize 语义编排

## 5. 文件清单

- `src/server/handlers/responses-handler.ts`
- `src/server/handlers/handler-response-utils.ts`
- `src/modules/llmswitch/bridge/responses-request-bridge.ts`
- `src/modules/llmswitch/bridge/responses-response-bridge.ts`
- `scripts/architecture/verify-responses-handler-single-bridge-surface.mjs`
- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts`
- `tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts`
- `tests/sharedmodule/responses-continuation-store.spec.ts`
- `tests/server/runtime/http-server/direct-server-contract.red.spec.ts`

## 6. 风险与规避

- 风险：server 本地 helper 删掉后遗漏调用链，导致行为回退。
  - 规避：单桥接 gate + 定向 Jest + tsc。
- 风险：force-SSE suite 因 native/open handle 造成假绿。
  - 规避：补 mock，跑 `--detectOpenHandles`。
- 风险：function-map 说法和真实代码再次漂移。
  - 规避：同时更新 function-map / verification-map / gate。

## 7. 测试计划

必须验证：
- `npm run verify:responses-handler-single-bridge-surface`
- `npx tsc --noEmit --pretty false`
- `npm run jest:run -- --runInBand --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts`
- 必要时补：
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --detectOpenHandles --runTestsByPath tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts`

## 8. 实施步骤

1. 审计 `responses-handler.ts` 剩余 request 语义残留，继续迁到 request bridge。
2. 审计 `handler-response-utils.ts` 剩余 response / SSE / continuation 语义残留，继续迁到 response bridge。
3. 为新增迁移点补单桥接 gate。
4. 同步 function-map / verification-map。
5. 先跑定向红测/回归，再跑 tsc 与 gate。
6. 若 open handle 仍存在，先修测试隔离，再继续收口。

## 9. 完成定义（DoD）

- `/v1/responses` server 层只剩 HTTP adapter 职责。
- request/response 语义各自只有一个 bridge surface。
- function-map / verification-map / gate / tests 全部一致。
- focused verification 全绿，且无已知未解释 open handle。
