# Hub Pipeline Rust Lib 化代码分析（2026-05-31）

## 目标

把 Hub Pipeline 从“TS 编排 + 多个 native 语义碎片”推进为“Rust 完整 lib + TS 最薄入口”。最终形态：Hub request/response processing、chat_process、req_process、resp_process、servertool followup orchestration、tool governance、protocol semantic mapping 的业务语义只存在 Rust；TypeScript 只保留 Node runtime 边界、NAPI 调用、stream/HTTP glue、配置加载与不可迁移的外部副作用调度。

## 当前代码态结论

1. Hub Pipeline 入口仍是 TypeScript class/runtime。
   - 主入口：`sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.ts`
   - 类型入口：`sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-types.ts`
   - package export：`sharedmodule/llmswitch-core/src/index.ts`
   - 当前入口负责 VirtualRouterEngine 初始化、provider runtime hook 注册、request normalize、chat_process entry、request stage 选择。

2. Rust 已覆盖大量 stage 语义，但不是完整 lib 入口。
   - 当前 Rust crate：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/`
   - crate 类型：`cdylib` + `rlib`，已具备作为 Rust lib 的基础。
   - 已有 Hub/Rust 模块：`hub_pipeline.rs`、`hub_req_inbound_format_parse.rs`、`hub_req_inbound_semantic_lift.rs`、`hub_req_outbound_format_build.rs`、`hub_resp_inbound_format_parse.rs`、`hub_semantic_mapper_chat.rs`、`hub_standardized_bridge.rs`、`req_process_stage2_route_select.rs`、`resp_process_stage2_finalize.rs` 等。
   - 问题：这些模块现在主要以 NAPI function 群提供能力，尚未收敛成一个 Rust-owned `HubPipelineRuntime` / `HubPipelineEngine` API。

3. TypeScript stage 目录已经“native-primary”，但仍有 TS residue。
   - stage tree：`sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/`
   - stage shell 多数调用 `WithNative` wrapper。
   - 仍存在 TS 执行链中的 metadata merge、snapshot recorder、stage timing、working request 分析、servertool required/image attachment 判断、policy apply、runtime hook 等逻辑。
   - 其中一部分是允许保留的 Node/runtime glue；另一部分需要迁入 Rust 或变成 Rust 返回的 plan。

4. chat_process/process 目录已有 Rust 边界文档，但“完整 lib 化”仍未完成。
   - 现有边界：`docs/hubpipeline-rust-boundary.md`
   - 当前分类把 `chat-process-heartbeat-directives.ts`、`chat-process-session-usage.ts` 等归为 runtime infra。
   - 需要补充一层：runtime infra 不迁语义，但它必须改成执行 Rust 返回的 effect plan，不能自己决定 payload/tool/route 语义。

5. 当前最大架构缺口不是“缺 Rust 函数”，而是“缺 Rust 总控 API”。
   - 现在 TS 仍负责串联：normalize → governance → route select → outbound payload → response processing。
   - Rust 函数分散在多个 NAPI wrapper 后面，调用顺序和错误边界由 TS 决定。
   - 完整 Rust lib 要把调用顺序、stage contract、错误类型、nodeResults、metadata 变更、diagnostics、effect plan 一次性收归 Rust。

## 现有 Rust 覆盖面

| Pipeline 区域 | 现有 Rust 真源/候选 | 当前状态 | 缺口 |
|---|---|---|---|
| req_inbound stage1 format parse | `hub_req_inbound_format_parse.rs` | Rust native 已存在 | 需接入总控 API |
| req_inbound stage2 semantic lift | `hub_req_inbound_semantic_lift.rs` | Rust native 已存在 | 需统一输入输出 typed contract |
| req_inbound stage3 context capture | `hub_req_inbound_context_capture.rs`、`hub_req_inbound_tool_output_snapshot.rs` | 部分 Rust | cache write / snapshot side effect 需 effect plan |
| req_process stage1 tool governance | `req_process_stage1_tool_governance.rs`、`chat_governance_*`、`hub_tool_governance_semantics.rs` | Rust-backed，但 TS shell 仍串联 | stage shell 需退化为 NAPI call only |
| req_process stage2 route select | `req_process_stage2_route_select.rs`、`virtual_router_engine/` | Rust 主体 | VirtualRouterEngine TS lifecycle 仍外置 |
| req_outbound context merge | `hub_req_outbound_context_merge.rs` | Rust native 已存在 | 需纳入统一 route/outbound stage |
| req_outbound format build | `hub_req_outbound_format_build.rs` | Rust native 已存在 | provider mapper 总控仍散在 TS |
| req_outbound compat | `req_outbound_stage3_compat.rs` | Rust native 已存在 | compat policy 需统一登记到 Rust stage catalog |
| resp_inbound sse decode/sniffer | `hub_resp_inbound_sse_decode_semantics.rs`、`hub_resp_inbound_sse_stream_sniffer.rs` | Rust native 已存在 | streaming Node Readable 仍需 TS glue |
| resp_inbound format parse | `hub_resp_inbound_format_parse.rs` | Rust native 已存在 | 需统一 response envelope typed contract |
| resp_process stage1 governance | `resp_process_stage1_tool_governance.rs`、`hub_resp_outbound_client_semantics.rs` | Rust-backed | TS still prepares/applies native calls |
| resp_process stage2 finalize | `resp_process_stage2_finalize.rs` | Rust-backed | servertool executed-call stripping 仍需要收归 Rust plan |
| resp_outbound client remap | `hub_resp_outbound_client_semantics.rs` | Rust module很薄 | 需扩成完整 outbound response builder |
| chat_process clock/web/servertool | `chat_clock_*`、`chat_web_search_*`、`chat_servertool_orchestration.rs` | 大量 Rust native | 需要 Rust 返回 effect plan，TS 不再判定语义 |
| bridge/responses/tool ids | `hub_bridge_actions/`、`hub_standardized_bridge.rs`、`shared_tool_call_id_*` | Rust 很强 | 需统一进 HubPipelineLib API |

## 需要物理收口的 TS residue 分类

### A. 必须迁入 Rust lib 的语义 residue

这些逻辑会影响请求/响应 payload、tool list、route、metadata 语义，不能长期留在 TS：

- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-normalize-request*.ts`：entryEndpoint/providerProtocol/processMode/routeHint/stream/shadowCompare 等规范化必须 Rust-owned。
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-chat-process-entry*.ts`：chat_process 主链顺序、metadata merge、standardized request 构建必须 Rust-owned。
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-route-and-outbound.ts`：route + outbound payload 总控必须 Rust-owned。
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage*.ts`：request stage 总控必须 Rust-owned。
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-provider-payload-*.ts`：provider payload policy/finalize/observation 中凡影响 payload/diagnostic 的部分必须 Rust-owned。
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-working-request-*.ts`：hasImageAttachment/serverToolRequired/heavy input fastpath 等语义必须 Rust-owned 或 Rust 返回 decision。
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/**/index.ts`：stage index 不能再做业务判断，只能 serialize input → call native → deserialize output。
- `sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/*.ts`：provider protocol mapper 必须迁入 Rust mapper registry，TS mapper 只能删除或变成类型导出。
- `sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-*.ts` 中凡决定 tools/messages/system instruction/servertool/web-search/clock 注入的逻辑，必须改为 Rust plan。

### B. 可保留但必须变薄的 Node/runtime glue

这些可保留在 TS，但不能持有业务语义：

- HTTP/Readable/SSE stream glue：Node stream 对接、codec 转换、实际写响应。
- file/session store glue：实际 fs 读写、cache persistence、snapshot file write。
- daemon/tool execution glue：clock daemon、servertool 进程/外部调用、provider HTTP runtime。
- NAPI loader/wrapper：required export 检查、JSON serialize/deserialize、typed wrapper。
- telemetry glue：日志输出、timing flush，但 timing label/stage decision 应由 Rust 返回。

### C. 必须删除的双真源形态

完成对应 Rust API 后应物理删除，不应只“不调用”：

- TS semantic mapper 与 Rust mapper 并存。
- TS stage index 内仍保留 native 结果之外的 payload patch。
- TS process 文件内仍保留 clock/web/servertool/tool-governance 判定分支。
- `.js` sibling shadow 覆盖 `.ts` 改动的活跃路径。
- NAPI wrapper 中 `catch` 后返回旧 TS 路径/空对象/跳过结果的 fallback 行为。

## 完整 Rust lib 建议形态

### Rust API 分层

在 `router-hotpath-napi` 内先形成 Rust lib 模块，不先拆新 crate，避免违反当前项目“Rust runtime 真源路径”约束。建议模块边界：

```text
rust-core/crates/router-hotpath-napi/src/
  hub_pipeline_lib/
    mod.rs
    engine.rs
    types.rs
    errors.rs
    stage_catalog.rs
    request.rs
    response.rs
    chat_process.rs
    req_process.rs
    resp_process.rs
    mapper_registry.rs
    effect_plan.rs
    diagnostics.rs
```

后续如果需要把 NAPI binding 与 pure Rust lib 拆开，再以 `hub-pipeline-core` 新 crate 承接；拆 crate 前必须先更新项目真源约束文档，否则当前唯一真源仍应落在 `router-hotpath-napi`。

### 核心 public API

```rust
pub struct HubPipelineEngine { /* policy, router, mapper registry, runtime handles */ }

impl HubPipelineEngine {
    pub fn new(config: HubPipelineConfig) -> Result<Self, HubPipelineError>;
    pub fn update_virtual_router_config(&mut self, config: VirtualRouterConfig) -> Result<(), HubPipelineError>;
    pub fn update_runtime_deps(&mut self, deps: HubRuntimeDeps) -> Result<(), HubPipelineError>;
    pub fn execute(&mut self, request: HubPipelineRequest) -> Result<HubPipelineResult, HubPipelineError>;
}
```

NAPI 只暴露一个总入口：

```rust
#[napi]
pub fn execute_hub_pipeline_json(input_json: String) -> napi::Result<String>;
```

TS 最终形态：

```ts
export class HubPipeline {
  execute(request: HubPipelineRequest): Promise<HubPipelineResult> {
    return executeHubPipelineWithNative({ request, runtimeHandle });
  }
}
```

### Rust 返回 effect plan，不直接做 Node 副作用

Rust lib 不应直接承担所有 Node 外设操作。正确形态是 Rust 决策，TS 执行：

```text
Rust decides:
  - messages/tools/payload/route/metadata/nodeResults
  - snapshot records to write
  - servertool followup action
  - clock schedule/cancel action
  - health/quota state transition

TS executes:
  - write snapshot file
  - call provider runtime HTTP
  - call clock/servertool daemon
  - pipe Node streams
```

这样可以同时满足 Rust-only 语义和 Node runtime 可用性。

## 推进步骤与原因

### Phase 0：冻结边界与红测

动作：生成 residue audit red tests，禁止新增 TS 语义。

原因：没有 deletion gate，只会继续“native-backed but TS-authoritative”。

验收：
- `hub-pipeline-stage-residue-audit.spec.ts` 能检测 stage/process/mapper 中新增 TS payload/tool/route 语义。
- `native-router-hotpath-required-exports.ts` 覆盖完整 HubPipelineLib 必需 exports。
- 禁止 wrapper fallback：native 缺失或异常必须 fail-fast。

### Phase 1：Rust typed contract 统一

动作：新增 `hub_pipeline_lib/types.rs`、`errors.rs`、`effect_plan.rs`，把 TS `HubPipelineRequest/Result/NormalizedRequest/NodeResult` 映射为 Rust typed structs。

原因：现在 NAPI 函数靠 JSON object 群传参，stage contract 分散，难以证明完整 lib。

验收：
- Rust unit tests 覆盖 request/result serde。
- TS wrapper 只做 JSON serialize/deserialize，不做字段推断。
- serde enum 加 `rename_all`，避免 TS 小写值反序列化失败。

### Phase 2：Rust 总控 engine 骨架

动作：在 Rust 中实现 `HubPipelineEngine::execute()`，先串起现有 Rust stage 函数，不改语义。

原因：先把“调用顺序真源”从 TS 迁到 Rust，才能谈完整 lib。

验收：
- `execute_hub_pipeline_json` 能跑最小 chat request。
- nodeResults/stage diagnostics 与旧链路等价。
- TS `executeHubPipelineRequest` 降级为 native call shell。

### Phase 3：req path 收口

动作：normalize、req_inbound、req_process、req_outbound 全部由 Rust engine 调度；TS stage index 退化或删除。

原因：request payload 是上游真实传输 payload，不能由 TS/Rust 双路径共同修改。

验收：
- req stage coverage 全绿：format parse、semantic lift、context capture、route select、outbound build、compat。
- TS stage index 不再包含 payload patch/route/tool 判定。
- 删除已替代 TS semantic residue。

### Phase 4：resp path 收口

动作：resp_inbound、resp_process、resp_outbound 全部由 Rust engine 调度；streaming 仅保留 TS pipe glue。

原因：tool harvest、servertool followup、client remap 是最容易形成双真源的区域。

验收：
- resp stage coverage 全绿：SSE decode/sniffer、format parse、governance、finalize、client remap、SSE stream。
- servertool executed-call stripping、text harvest、tool_call id normalization 都只在 Rust。
- TS 只执行 Rust 返回的 response/effect plan。

### Phase 5：chat_process effect plan 化

动作：clock/web-search/servertool/governance/media/session usage 相关 TS 判定迁为 Rust plan；TS 只执行 fs/daemon/provider 副作用。

原因：chat_process 是 Hub Pipeline 语义主链，不能靠“process 文件已调用 native”作为完成标准。

验收：
- clock/web-search/servertool coverage 全绿。
- process 目录中影响 messages/tools/system instruction 的 TS 分支删除。
- runtime infra 文件只能消费 `effectPlan`。

### Phase 6：provider mapper registry Rust 化

动作：把 `operation-table/semantic-mappers/*.ts` 收敛到 Rust `mapper_registry.rs`，每个 provider mapper 变成 Rust trait 实现。

原因：Hub Pipeline / Virtual Router 禁止 provider 特例；provider 差异必须在受控 mapper registry 内，不应散落 TS 分支。

验收：
- OpenAI Chat / Responses / Anthropic / Gemini mapper golden 全绿。
- TS mapper 文件删除或仅保留 type/export shim。
- mapper registry 有 provider family allowlist 与 red tests。

### Phase 7：删除 TS residue 与发布门禁

动作：物理删除已替代 TS 文件/分支，更新 exports 和 tests，跑全矩阵。

原因：项目规则要求错误/重复/死语义必须物理移除，不能闲置。

验收：
- residue audit 绿。
- Rust unit + NAPI coverage + Hub matrix 绿。
- `docs/hubpipeline-rust-boundary.md` 更新为最终边界。

## 推荐首批落地 PR 切片

1. PR-1：`hub_pipeline_lib/types.rs` + `errors.rs` + serde tests。
   - 原因：最小无行为改动，先立 typed contract。

2. PR-2：`execute_hub_pipeline_json` 总入口 skeleton，只串现有 Rust normalize + req stage + route select smoke。
   - 原因：先证明 Rust engine 可作为 lib 入口。

3. PR-3：TS `HubPipeline.execute()` 走 native total entry；旧 TS path 改为测试-only shadow 或直接删除已覆盖分支。
   - 原因：切断 TS 调用顺序真源。

4. PR-4：req path deletion gate，物理删除 req stage 内 payload/tool/route TS residue。
   - 原因：先收口请求路径，避免真实传输 payload 双改写。

5. PR-5：resp path + servertool followup effect plan。
   - 原因：工具治理和 followup 是风险最高区域，需单独红测。

6. PR-6：mapper registry Rust 化，删除 TS semantic mapper。
   - 原因：消灭 provider mapper 双真源。

## 验证矩阵

### Rust 单测

```bash
cd sharedmodule/llmswitch-core/rust-core
cargo test -p router-hotpath-napi hub_pipeline
cargo test -p router-hotpath-napi req_process
cargo test -p router-hotpath-napi resp_process
cargo test -p router-hotpath-napi servertool
```

### NAPI/Hub stage coverage

```bash
cd sharedmodule/llmswitch-core
node scripts/tests/coverage-hub-req-inbound-format-parse.mjs
# retired 2026-06-09: coverage-hub-req-inbound-semantic-lift.mjs targeted deleted TS stage dist owner; req_inbound semantic lift is now covered by Rust tests and Hub residue gates.
node scripts/tests/coverage-hub-req-process-route-select.mjs
node scripts/tests/coverage-hub-req-outbound-format-build.mjs
node scripts/tests/coverage-hub-resp-inbound-format-parse.mjs
node scripts/tests/coverage-hub-resp-process-stage2-finalize.mjs
node scripts/tests/coverage-native-chat-process-governance-semantics.mjs
node scripts/tests/coverage-native-chat-process-servertool-orchestration-semantics.mjs
node scripts/tests/hub-chain-equivalence.mjs
node scripts/tests/hub-equivalence.mjs
```

### residue/delete gate

```bash
npm test -- tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts
npm test -- tests/sharedmodule/servertool-active-js-shadow-audit.spec.ts
```

### build/matrix

```bash
cd sharedmodule/llmswitch-core
npm run build
node scripts/tests/run-matrix-ci.mjs
```

## 风险与处理

1. 风险：把 Node side effect 强行塞进 Rust。
   - 处理：Rust 只返回 effect plan；TS 只执行副作用。

2. 风险：NAPI wrapper catch 后静默 fallback。
   - 处理：required native export + fail-fast；错误进入 `HubPipelineError`。

3. 风险：provider-specific 分支混入 Hub Pipeline。
   - 处理：统一 mapper registry；Hub engine 只看 protocol family + semantic contract。

4. 风险：`.js` sibling shadow 或旧 dist 继续生效。
   - 处理：加 active shadow audit；删除已替代 `.js` 影子或纳入构建清理。

5. 风险：payload 裁剪被误当性能优化。
   - 处理：真实传输 payload 必须语义等价；只允许裁剪 debug/snapshot。

## 最终完成判定

完成不是“Rust 函数存在”，而是同时满足：

- `HubPipelineEngine` 是 Rust 调用顺序真源。
- TS `HubPipeline` 只负责 NAPI/Node runtime glue。
- request/response/chat_process/req_process/resp_process/servertool/tool governance/provider mapper 业务语义只在 Rust。
- 已替代 TS semantic residue 物理删除。
- red/deletion gate、Rust tests、NAPI coverage、Hub matrix 全绿。
- 文档 `docs/hubpipeline-rust-boundary.md` 更新为最终边界。
