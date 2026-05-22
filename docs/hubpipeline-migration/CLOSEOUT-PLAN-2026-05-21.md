# Hub Pipeline Rust-only Closeout Plan（2026-05-21）

## 目标

把 Hub Pipeline 剩余 TS 语义残面收敛到 Rust 真源，TS 只保留 thin wrapper / transport shell / orchestration shell，不再持有 payload 语义、tool governance 语义或 servertool orchestration 真相。

## 当前结论

现状不是“Hub Pipeline 还没 Rust 化”，而是“主干已在 Rust，但还有 4 个关键 closeout 面没有收口”。

### 已在 Rust 主干的部分
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline.rs`
- `req_process_stage1_tool_governance.rs`
- `req_process_stage2_route_select.rs`
- `resp_process_stage1_tool_governance.rs`
- `resp_process_stage2_finalize.rs`
- 各类 `hub_req_inbound_*` / `hub_resp_inbound_*` / `hub_resp_outbound_*`

### 仍未收口的 4 个面

#### P0-1 `req_process.stage1` 仍有 TS 语义后处理
文件：
- `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_process/req_process_stage1_tool_governance/index.ts`

残留：
- `maybeInjectClockRemindersAndApplyDirectives(...)`
- `sanitizeChatProcessRequest(...)`

结论：这两段仍直接改 `processedRequest`，不是 thin wrapper。

#### P0-2 `resp_process.stage3` servertool orchestration 主体仍在 TS
文件：
- `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage3_servertool_orchestration/index.ts`
- `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/servertool/engine.ts`
- `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts`

已 native 的点：
- `detectProviderResponseShapeWithNative`
- `readFollowupClientInjectSourceWithNative`
- 多个 planner / detector / runtime helper

未 native 的主体：
- `runServerToolOrchestration(...)`
- `runServerSideToolEngine(...)`
- mixed tool dispatch / followup mainline / pending injection / outcome resolve 的主线编排

结论：已有 Rust skeleton，但 orchestration 真源还没迁完。

#### P0-3 `resp_process.stage2_finalize` 之后仍由 TS 构 `ProcessedRequest`
文件：
- `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage2_finalize/index.ts`

现状：
1. Rust finalize payload
2. Rust strip executed servertool calls
3. TS `buildProcessedRequestFromChatResponse(...)`

结论：`ProcessedRequest` 仍由 TS 定义与组装，不算 Rust-only closeout。

#### P0-4 operation-table / semantic mappers / response mappers / format adapters 仍承载 TS 协议语义
关键路径：
- `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/operation-table/`
- `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/`
- `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/format-adapters/`
- `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/response/response-mappers.ts`
- `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-engine.ts`

结论：这些仍在做协议级语义映射，不能长期作为 TS 真源。

## closeout 顺序

### Slice 1（第一优先级）
`resp_process.stage3 servertool orchestration`

为什么先做它：
1. 它直接命中项目硬约束：`resp_process / servertool orchestration` 必须 Rust-only。
2. 当前 stage3 已经有 Rust skeleton/planner/detector，最适合做 closeout，而不是从零起新面。
3. 它对 stopless / followup / mixed tools / servertool 注入链影响最大，收益最高。
4. 如果先做 req/mapper 小块，只会继续让 stage3 成为最大 TS 真相孤岛。

### Slice 2
`req_process.stage1` 的 TS 后处理收口到 Rust。

### Slice 3
`resp_process.stage2_finalize` 的 `ProcessedRequest` 组装 Rust 化。

### Slice 4
operation-table / mappers / format adapters 的协议真源收口。

## Slice 1 骨架

### 当前 flow
```text
resp_process.stage3/index.ts
  -> detect/read small native helpers
  -> runServerToolOrchestration (TS)
       -> runPrimaryServerToolEngineSelection
       -> runServerSideToolEngine
       -> persistPendingServerToolInjection
       -> runFollowupMainline
```

### 目标 flow
```text
resp_process.stage3/index.ts
  -> runServertoolResponseStageWithNative / equivalent native stage entry
       -> response detect
       -> dispatch planning
       -> execution/outcome resolve
       -> followup/clientInject/backendInvoke planning
       -> strip/finalize contract
  -> TS 只做 JSON bridge + transport bridge
```

## Slice 1 验收标准

1. `resp_process.stage3` 不再直接 import / 调用 `sharedmodule/llmswitch-core/src/servertool/engine.ts` 的 `runServerToolOrchestration`。
2. stage3 只允许：
   - native stage entry
   - JSON parse/serialize
   - transport bridge（providerInvoker / reenterPipeline / clientInjectDispatch）
3. mixed tools / reasoning stop guard / stop_message followup / clientInjectOnly / backendInvoke 的主 outcome 判定迁入 Rust。
4. 对应回归保留：
   - `tests/servertool/resp-process-stage3-reentry.spec.ts`
   - `tests/servertool/servertool-mixed-tools.spec.ts`
   - `tests/servertool/stop-message-auto.spec.ts`
   - 需要新增架构门禁，防止 stage3 再回流到 TS 真源。

## 本轮执行计划

1. 先补红测：卡住 `resp_process.stage3` 仍直连 TS orchestrator。
2. 再按红测结果把 stage3 收到 native stage entry。
3. 每片后立即跑定向测试与最小编译。
4. 通过后再继续下一片，不并发散改。

## 为什么“先做 stage3”是唯一正确顺序

因为当前用户要求的 Rust-only 边界里，`resp_process / servertool orchestration` 是最明确、最集中、也最违反“TS 仅薄壳”原则的残面。它已经拥有 native skeleton 和 planner，因此 closeout 成本最低、收益最高；反过来先做其他小面不会消除 stage3 作为 TS 真源的事实，无法改变 Hub Pipeline 的核心违规面，所以不是正确顺序。
