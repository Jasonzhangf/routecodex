# HubPipeline Full Rust Closeout Plan

## 1. 目标与验收标准

目标：把 Hub Pipeline 从当前“Rust 语义真源 + TS 编排/壳层”收口为“Rust 唯一运行时真源”。最终状态下，TS 不再承载 Hub Pipeline 的业务语义、响应 effect 解释、provider 执行调度、servertool orchestration 或 Virtual Router 选路真源。

验收标准：
- Hub Pipeline 的请求链、响应链、错误链、metadata carrier 统一由 Rust 运行时拥有。
- TS 只保留必要的启动/装配/桥接，且不能再包含语义判定、payload 重写、tool 处理、route 选择或 effect 解释。
- 所有确认无用或已被 Rust 接管的 dead code 先物理删除，再进入下一阶段。
- 迁移过程全程 fail-fast，无 fallback、无双路径、无静默补偿。
- 每个阶段都要有可执行验证证据，且先红后绿。

## 2. 范围与边界

### In Scope
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/**`
- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/process/**`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/**`
- `src/server/runtime/http-server/**`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/**`

### Out of Scope
- 无关 provider 兼容性重写。
- 无关 UI / CLI 体验改动。
- 以性能名义裁剪真实传输 payload。
- 任何 fallback / degrade / dual-path 方案。

## 3. 设计原则

1. **死代码先删**
   - 先确认 dead code、重复实现、旧壳层和错误实现。
   - 能物理删除的先删，不留“以防万一”的存量。

2. **Rust 唯一真源**
   - 语义、路由、effect、错误判定都只在 Rust。
   - TS 只做薄桥接，不能重建语义。

3. **阶段化推进**
   - 每阶段只收一个明确责任块。
   - 阶段结束必须有验证证据，才能进入下一阶段。

4. **无 fallback**
   - 失败必须显式暴露。
   - 不允许静默修复、降级成功、或第二条补偿链。

5. **节点双接口**
   - 每个节点必须拆成两个标准接口：`control` 和 `data`。
   - `control` 只传控制语义、路由决策、错误、状态、metadata carrier。
   - `data` 只传业务 payload，禁止混入 metadata、控制标记、路由辅助字段或 debug snapshot。
   - 控制接口和数据接口都必须是标准化、可枚举、可验证的唯一契约。

## 4. 阶段顺序

### Phase 0: Dead Code Inventory and Physical Deletion
目标：先清理已确认无用的 TS residue、重复 helper、旧分支、错误实现和重复测试残骸。

动作：
- 扫描 Hub Pipeline / response / servertool / Virtual Router 的 dead code。
- 先建立删除清单，再做物理删除。
- 删除后补对应 red/green 证据，防止旧路径复活。

完成条件：
- dead code 清单已落地。
- 已确认无用项完成物理删除。
- 删除门禁能拦住旧路径回流。

### Phase 1: Rust Runtime Ownership Baseline
目标：把 Hub Pipeline 的总控入口、节点 contract、runtime deps、stage catalog、diagnostics 基线全部收归 Rust。

动作：
- Rust 侧持有 HubPipeline 总控。
- TS 入口仅保留 JSON/stream bridge。
- 选路、metadata 归一、node result、effect plan 统一经 Rust 输出。
- 每个节点同步定义 `control` / `data` 两个标准接口，且二者必须分离实现与验证。
- metadata 只允许出现在 control 接口或专用 carrier，不得进入 data 流。

完成条件：
- TS 不再串联多个语义 helper。
- Rust 能独立表达完整请求/响应路径 contract。

### Phase 2: Request Path Rust Closeout
目标：把 req_inbound / req_chatprocess / req_outbound / VR route 相关语义全部迁入 Rust。

动作：
- 删除 TS 预选路由和 request stage 语义判断。
- Rust 直接拥有 route decision、payload shape、tool governance、compat 规则。
- 物理删除已被接管的 TS request-path helper。

完成条件：
- 请求链不再依赖 TS 语义编排。
- 关键 request-path 红测和黑盒测试全绿。

### Phase 3: Response Path and Effect Interpreter Rust Closeout
目标：把 resp_inbound / resp_chatprocess / resp_outbound 以及 effectPlan 解释器全部迁入 Rust。

动作：
- Rust 产出并消费 effect plan。
- TS 不再解释 `streamPipe` / `runtimeStateWrite` / `servertoolRuntimeAction`。
- 删除 TS response orchestration 和旧 response semantic residue。

完成条件：
- 响应链真源在 Rust。
- servertool / stream / runtime state 的决策和解释不再由 TS 持有。

### Phase 4: Provider Transport and HTTP Runtime Rust Closeout
目标：把 provider invocation、error chain consumption、HTTP ingress/egress 运行时收口到 Rust 主运行时。

动作：
- Rust 持有 provider transport contract 和 request executor 语义。
- HTTP server / request executor 不再决定 Hub 语义。
- TS 只保留最薄的启动/桥接，且不参与语义修补。

完成条件：
- 主运行时可由 Rust 独立承接。
- TS runtime path 不再是生产真源。

### Phase 5: TS Runtime Physical Deletion
目标：删除已被 Rust 接管的 TS runtime 主链。

动作：
- 删除旧的 TS Hub Pipeline / response / executor / servertool semantic residue。
- 删除与新 Rust 真源重复的实现。
- 保留的 TS 仅是必须存在的桥接层。

完成条件：
- 生产运行链路不再依赖 TS 语义实现。
- 残余 TS 仅是必要桥接，无业务语义。

## 5. 技术方案

### Rust 侧职责
- HubPipeline 总控
- req/resp/chatprocess 节点调度
- Virtual Router route decision
- response effect interpreter
- provider transport / error chain / runtime state contract
- servertool orchestration 真源

### 节点接口规范
- 每个节点必须公开两个标准接口：`<node>.control` 和 `<node>.data`
- `control` 负责状态、metadata、route、error、policy、effect 指令
- `data` 负责 payload、messages、tool result、body content
- 任一 `data` 接口若读取 metadata，必须视为违规
- 任一 `control` 接口若改写业务 payload，必须视为违规

### TS 侧允许职责
- NAPI / JSON / stream bridge
- Node 进程 glue
- 必要的外部 IO 副作用执行
- 测试与临时诊断，不承载业务语义

### 文件处理原则
- 已证实 dead 的文件先删。
- 已被 Rust 接管的旧 TS helper 物理删除。
- 只允许一个 owning builder / parser / interpreter。
- 节点接口必须由唯一 owner 同时维护 `control` / `data` 契约，禁止散落式补丁。

## 6. 验证计划

阶段验证按顺序执行：
1. dead code residue audit
2. Rust unit / contract tests
3. TS residue red tests
4. build / install / smoke
5. live runtime 证据
6. control/data split contract audit

必要门禁：
- `npm run verify:architecture-ci`
- `npm run verify:llmswitch-rustification-audit`
- `npm run build:min`
- 目标模块的定向 Rust / Jest / blackbox 测试
- control/data split 的节点契约审计

## 7. 风险与规避

- 风险：先做大改，死代码残留继续污染主链。规避：Phase 0 必须先删。
- 风险：TS 和 Rust 双真源并存。规避：每阶段结束立刻删除旧实现。
- 风险：用 fallback 掩盖迁移缺口。规避：任何不支持状态直接 fail-fast。
- 风险：只改 code 不改验证。规避：每阶段都要有对应门禁证据。

## 8. 完成定义

- dead code 已先删。
- Rust 拥有 Hub Pipeline 全链路真源。
- TS 只剩必要桥接。
- 删除门禁、定向测试、build 与 smoke 全部通过。
- 每个节点的 control/data 双接口已稳定分离，metadata 未混入 data 流。
- 没有 fallback、没有双路径、没有重复实现。

## 9. 2026-07-03 Execution Contract: Full Rustification Goal

本节是当前 `/goal` 的执行真源。目标不是只补 Stage A map，也不是只写审计报告；目标是把 Hub Pipeline / Chat Process / servertool followup orchestration 的剩余 TS 语义逐 slice Rust 化，并用白盒、黑盒、架构 gate、live replay 证明闭环。

### 9.1 P0 Rustification Scope

P0 必须按以下 feature 顺序推进；每个 feature 都必须先查 `function-map.yml`、`mainline-call-map.yml`、`verification-map.yml`，确认唯一 owner、允许路径、禁止路径和最小验证栈。

1. `servertool.followup_orchestration`
   - Rust owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs`
   - TS residue: `sharedmodule/llmswitch-core/src/servertool/**`
   - Goal: TS 只执行 Rust plan 规定的 IO，不再决定 followup/reentry/stopless/servertool outcome。

2. `hub.req_chatprocess.tool_governance`
   - Rust owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance.rs`
   - TS residue: `sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-governance-semantics.ts`
   - Goal: tool list 注入、文本工具 harvest、sanitize、servertool/web_search governance 全部 Rust-owned。

3. `hub.resp_chatprocess.tool_governance`
   - Rust owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs`
   - TS residue: `sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-governance-semantics.ts` and `native-chat-process-servertool-orchestration-semantics.ts`
   - Goal: response tool harvest、apply_patch reversal、internal tool stripping、servertool response governance 全部 Rust-owned。

4. `conversion.responses.store`
   - Rust owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
   - TS residue: `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
   - Goal: continuation save/restore、scope isolation、TTL/eviction、owner pin 全部 Rust-owned。

5. `conversion.shared.anthropic`
   - Rust owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/anthropic_openai_codec.rs`
   - TS residue: `sharedmodule/llmswitch-core/src/conversion/shared/anthropic-message-utils*.ts`
   - Goal: Anthropic/OpenAI message、thinking block、tool schema、tool_use/tool_result normalization 全部 Rust-owned。

### 9.2 Per-Slice Required Loop

每个 P0 slice 必须按同一闭环执行，不能跳步：

1. Owner lock
   - Query function map / mainline call map / verification map / wiki manifest.
   - 若 1-2 次查询内无法定位唯一 owner 或唯一相邻边，先补 map/contract，不改实现。

2. Residue inventory
   - 列出 TS residue 中仍在做语义判定、payload 重写、metadata 读写、tool governance、route/effect/error 决策的函数。
   - 分类为 `delete now`、`move to Rust`、`thin wrapper`、`IO glue`。
   - 禁止把 semantic residue 留作双路径。

3. Test design first
   - 写测试设计到当前 plan 或 feature 对应测试文件注释/fixture。
   - 必须包含 lifecycle 节点输入输出、success/failure/non-terminal/already-terminal、白盒、模块黑盒、项目黑盒、live replay 样本。

4. Red evidence
   - 先写最小红测或 failing sample，确认当前实现确实被锁住。
   - 若红测不红，先修测试设计或改用真实旧样本；禁止直接改实现后再补测试。

5. Rust implementation
   - 修改唯一 Rust owner。
   - TS 只做 NAPI/JSON/stream bridge 或外部 IO glue。
   - Rust path fail-fast；禁止 TS fallback 到旧实现。

6. TS physical deletion / collapse
   - 被 Rust 接管的 TS semantic helper 必须物理删除或收缩成薄壳。
   - 删除前确认依赖；删除后跑架构红测防旧路径复活。

7. Green evidence
   - Rust unit / contract test PASS.
   - Focused Jest whitebox/contract PASS.
   - Module blackbox PASS.
   - Architecture gate PASS.
   - Build PASS.

8. Live evidence
   - 若 slice 影响 runtime behavior，必须全局安装、managed restart、`/health`、同入口真实样本或旧失败样本 replay。
   - 只做单测、build、静态阅读不能宣称闭环完成。

9. Architecture review
   - 检查是否无 fallback、无双路径、无 metadata/payload 混流、无非相邻转换、无 provider 特例进入 Hub Pipeline。
   - review 不过则回唯一 owner 修，不得把结果正确当完成。

10. Memory / skill closeout
   - note.md 记录探索与证据。
   - 完成后把确证结论追加到 `MEMORY.md`。
   - 若形成可复用流程或反模式，更新 `.agents/skills/rcc-dev-skills/` 或相关 rustification skill。

### 9.3 Required Whitebox Coverage

每个 slice 至少覆盖：

- Rust owner unit tests: canonical builder/parser/interpreter 的正反样本。
- Rust error tests: malformed input、missing required field、wrong owner/scope、non-terminal 状态必须显式错误或显式 non-terminal。
- NAPI bridge tests: TS wrapper 只能透传 Rust output，不解释 semantic branch。
- Residue audit tests: 禁止旧 TS marker、旧 helper import、旧 action switch、旧 payload rewrite、旧 metadata fallback 复活。
- Function/mainline/verification map gates: owner、相邻边、required gate、manifest/wiki 同步可解析。

### 9.4 Required Blackbox Coverage

每个 slice 至少覆盖：

- Module blackbox: 从模块公开入口输入真实 payload，验证输出语义与 Rust contract 一致。
- HTTP blackbox: 使用 `/v1/responses`、`/v1/chat/completions` 或 `/v1/messages` 的同入口样本验证 runtime 行为。
- Provider/client blackbox: fake provider 或 live provider 证明 upstream payload 和 client response body 不含内部 metadata/debug/control。
- Error blackbox: provider/runtime/local error 进入 ErrorErr 链，禁止被包装成成功 response 或 TS fallback。
- Continuation/servertool blackbox: 覆盖 first turn、tool call、submit_tool_outputs/followup、non-terminal、already-terminal、failure。

### 9.5 Stage Gates

每个 slice 的最小 gate 由 `docs/architecture/verification-map.yml` 决定；全局收口必须至少跑：

```bash
npm run verify:function-map-compile-gate
npm run verify:architecture-mainline-call-map
npm run verify:architecture-mainline-manifest-sync
npm run verify:architecture-mainline-mermaid-sync
npm run verify:llmswitch-rustification-audit
npm run verify:servertool-rust-only
cargo check --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml -p router-hotpath-napi
npm run build:base
```

影响 live runtime 的阶段，还必须补：

```bash
npm run pack:rcc
npm run verify:rcc-release-install
routecodex restart --port <managed-port>
curl -sS http://127.0.0.1:<managed-port>/health
```

并重放同入口旧失败样本或真实样本。没有 live replay 证据，只能声明“代码/测试 gate 通过”，不能声明 rustification 闭环完成。

### 9.6 Final DoD

完整 rustification 完成必须同时满足：

- P0 scope 的 TS semantic residue 均已迁入 Rust 或物理删除。
- 保留 TS 文件均能解释为 NAPI/JSON/stream bridge、Node IO glue、diagnostic/test，不承载业务语义。
- 白盒、模块黑盒、HTTP/project 黑盒、错误链黑盒、live replay 全部有证据。
- `function-map.yml`、`mainline-call-map.yml`、`verification-map.yml`、wiki/manifest 与代码 owner 一致。
- 架构 gate 能阻止旧 TS semantic path、fallback、非相邻转换、metadata payload 泄漏、重复 owner 复活。
- `MEMORY.md` 和相关 skill 已沉淀确证流程与反模式。
