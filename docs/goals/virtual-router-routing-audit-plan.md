# Virtual Router Routing Audit Plan

## 目标与验收标准

目标：审计并收敛 RouteCodex Virtual Router 的命中、continuation、错误切换与观测机制，删除错误 sticky 语义，确保调度只由当前轮请求与统一错误策略驱动。

验收标准：
- sticky 语义被物理删除；除 continuation 上下文恢复外，不存在 provider/session 粘滞规则。
- continuation 不叫 sticky：
  - direct/remote continuation 必须恢复到原 provider key。
  - local/relay continuation 只恢复本地上下文，不 pin provider，继续标准路由。
- 所有 route 判断只看当前最新轮；工具声明、历史工具调用、followup 历史不触发路由。
- coding 只由当前轮真实写操作触发；read/search/update_plan 不触发 coding。
- recoverable 错误统一入口/出口：同请求前两次 same provider retry，第三次 exclude 当前 provider 并 reroute backup；跨请求按 10m/30m/5h 循环 cooldown，cooldown provider 必须移出可路由池。
- weighted / priority / failover / minimax provider 可见性均有黑盒覆盖。
- 错误请求不永久进入 ResponsesConversationStore；pending input 可通过 mem-observer 持续观测。
- `[mem-observer] ... pendingNoResponseId=... retainedInputItems=...` 默认保留并可见，禁止移除。
- build dev、全局安装、`routecodex restart --port 5555` 后在线日志能证明命中与切换正确。

## 范围与边界

In scope：
- Virtual Router 当前轮特征提取。
- routing metadata 透传与 provider exclusion。
- retry/reroute/cooldown 统一错误策略。
- continuation direct/local 上下文恢复。
- sticky 旧语义物理删除。
- 黑盒回归测试、文档和 skills 更新。
- mem-observer 默认打印保留。

Out of scope：
- 不重写 provider 协议层。
- 不新增 fallback/降级/兜底路径。
- 不把 direct 改成 relay。
- 不绕过 Hub Pipeline / llmswitch-core 真源。
- 不用 release build 作为本次验证主路径。
- 不在安装脚本里跑 e2e。

## 设计原则

1. 单一路径真源：`HTTP server -> llmswitch-core Hub Pipeline -> Provider V2 -> upstream`。
2. 先黑盒红测，再修复变绿；黑盒必须模拟真实 HTTP/request-level 行为与真实响应结构。
3. 路由判断只看当前轮；历史只服务 continuation 上下文恢复，不参与普通 route decision。
4. sticky 物理删除，不保留闲置分支、旧字段、旧语义引用。
5. 错误管理统一：分类、retry、exclude、cooldown、success reset 只能在唯一链路闭环。
6. mem-observer 是生产排障观测，不是临时 debug，必须默认保留。

## 技术方案与文件清单

重点审计/修复文件：
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/features.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/features/tools.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/instructions/parse/parse_instructions.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/router_metadata_input.rs`
- `sharedmodule/llmswitch-core/src/router/virtual-router/engine/routing-state/metadata.ts`（2026-06-07 Phase 8F-5 已删；routing-state metadata 语义不得在 TS 复活）
- `src/server/runtime/http-server/request-executor.ts`
- `src/server/runtime/http-server/executor/request-executor-provider-send-failure.ts`
- `src/server/runtime/http-server/executor/request-executor-retry-execution-plan.ts`
- `src/server/runtime/http-server/executor/*continuation*`
- `src/server/runtime/http-server/responses-conversation-store*`
- `src/utils/memory-observer.ts`
- `.agents/skills/rcc-dev-skills/SKILL.md`
- `MEMORY.md`
- `note.md`

黑盒/回归文件：
- `scripts/tests/no-sticky-routing-blackbox.mjs`
- `scripts/tests/virtual-router-coding-current-turn-blackbox.mjs`
- `scripts/tests/provider-failure-reroute-micro-blackbox.mjs`
- `scripts/tests/virtual-router-scheduling-blackbox.mjs`
- `scripts/tests/responses-store-error-release-blackbox.mjs`
- `scripts/tests/responses-continuation-provider-key-blackbox.mjs`

## 风险与规避

- 风险：旧 sticky 字段名被 retry/continuation 误用。规避：逐项分类，真正 retry/direct-continuation pin 改名或隔离，普通 sticky 物理删除。
- 风险：黑盒过度 mock，测不到真实问题。规避：从 HTTP/request-level 入口发请求，捕获 status/body/log/route/provider，不只测单元函数。
- 风险：错误请求 store 泄漏。规避：错误路径必须断言 store release；mem-observer 默认保留。
- 风险：cooldown 后候选池为空。规避：第三次错误必须 exclude 当前 provider 后 reroute backup，最后 provider 的处理必须显式验证。
- 风险：build 未同步 Rust/TS dist。规避：dev build 后 run llmswitch ensure + tsc + 全局安装 + restart。

## 测试计划

必须先红后绿并纳入回归：
1. no-sticky routing：search 后 read/search/update_plan 不继承上轮 provider/route。
2. coding current-turn：只有当前轮写操作命中 coding。
3. provider failure reroute：三次 recoverable 后切 backup，并记录 provider-switch。
4. scheduling：weighted、weighted-minimax、priority/failover、no-sticky 都覆盖。
5. continuation provider-key：direct/remote 恢复同 provider key；local/relay 不 pin provider。
6. store error release：失败请求不永久保留 input，`pendingNoResponseId/retainedInputItems` 回落。
7. live smoke：重启 5555 后真实日志必须看到 request start、virtual-router-hit、provider-switch、session-request、mem-observer。

推荐命令：
```bash
node scripts/tests/no-sticky-routing-blackbox.mjs
node scripts/tests/virtual-router-coding-current-turn-blackbox.mjs
node scripts/tests/provider-failure-reroute-micro-blackbox.mjs
node scripts/tests/virtual-router-scheduling-blackbox.mjs
node scripts/tests/responses-store-error-release-blackbox.mjs
node scripts/tests/responses-continuation-provider-key-blackbox.mjs
BUILD_MODE=dev node scripts/build-core.mjs
npm run llmswitch:ensure
npx tsc
npm run build:dev
npm run install:global
routecodex restart --port 5555
```

## 实施步骤

1. 跑黑盒矩阵，确认当前红点与失败证据。
2. 审计 sticky 残留：按“真实 sticky / retry pin / direct continuation key restore / 测试反向命名”分类。
3. 物理删除真实 sticky 语义与引用；保留的 provider pin 必须改为语义明确的 retry/continuation 名称。
4. 修复 current-turn route feature：工具声明和历史工具不参与路由；coding 限定真实写操作。
5. 修复 continuation：direct/remote 恢复 provider key；local/relay 只恢复上下文不 pin。
6. 修复 recoverable 错误闭环：same-provider retry、third exclude+rereoute、cooldown candidate removal、success reset。
7. 修复 store release：错误/abort/timeout 不永久持有 input；mem-observer 默认保留。
8. 黑盒全绿后，dev build、全局安装、restart 5555。
9. 在线日志验证：彩色/可见 virtual-router-hit、provider-switch、session-request、mem-observer。
10. 更新 skills/MEMORY/note/CACHE，review diff，分批提交。

## 完成定义（DoD）

- 黑盒矩阵全绿。
- `npm run build:dev`、`npm run install:global` 成功。
- `routecodex restart --port 5555` 后 live 日志证明：
  - request start 有打印；
  - virtual-router-hit 有打印；
  - recoverable 三次后切 backup；
  - no sticky；
  - mem-observer 保留并显示 pending/input 释放情况。
- 文档与 skills 已更新。
- 提交中包含唯一性说明：修改点为何是真源，其他位置为何不完整。
