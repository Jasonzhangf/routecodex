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

## 10. 2026-07-04 Final Closeout Execution Contract

本节覆盖当前最终执行任务。前置事实：Hub Pipeline 尚未完整 Rust 化。当前 gate 结果显示 `servertool.hook_skeleton.mainline` 仍有 12 条 `binding pending`，`responses.continuation.mainline` 仍有 3 条 `partial`，`error.mainline` 和 `vr.route_availability.mainline` 各有 1 条非 Hub-adjacent partial；`verify:llmswitch-rustification-audit` 仍报告 production TS surface 存在。后续执行不得把“gate 在预算内 PASS”误报为“完整 Rust-only closeout”。

### 10.1 当前主目标

把 Hub Pipeline / Chat Process / servertool followup orchestration / Responses continuation 相关剩余语义全部收口到 Rust 唯一真源，并完成本地 gate、架构 gate、release install、live `/health.version`、同入口 replay 的全闭环。

### 10.2 当前剩余必关项

1. `servertool.hook_skeleton.mainline`
   - 目标：将 12 条 `binding pending` 边全部变成真实 Rust caller/callee adjacent binding。
   - 要求：每条边必须能回链到 wiki/manifest 节点 ID、function map owner、verification map gate 和真实 Rust symbol。
   - 禁止：只改 budget 把 pending 消掉；禁止伪造 symbol；禁止让 TS shell 承担 hook scheduling、response action、request restore、followup/reentry 语义。

2. `responses.continuation.mainline`
   - 目标：关闭 3 条 partial，确认 direct/relay continuation owner、`previous_response_id`、tool output materialize、client projection bypass 等决策是否仍在 TS；凡属语义必须移入 Rust Chat Process/store owner。
   - 要求：`resp_chatprocess save -> immutable interval -> req_chatprocess restore` 之间只允许传输、投影、scope 校验和释放；不得在 TS inbound/outbound/handler/bridge 恢复 history、补 tool 状态或推断 required_action。
   - 禁止：用 `entryOriginRequest`、`capturedChatRequest`、`requestSemantics`、session-only scope 或 MetadataCenter 重建 continuation 语义。

3. TS surface classification and deletion
   - 目标：对剩余 Hub-adjacent TS 文件逐个分类为 `thin bridge`、`IO glue`、`diagnostic/test`、`delete now`、`move to Rust`。
   - 要求：`move to Rust` 必须先写红测，再迁到唯一 Rust owner；`delete now` 必须物理删除并加 residue gate；保留文件必须有 owner 注释或 map 可反查理由。
   - 禁止：保留“以后可能用”的 semantic helper；禁止新增 TS 业务逻辑。

4. Runtime closeout
   - 目标：source/package/global/live runtime version 一致，并用同入口旧样本或真实样本 replay 证明 installed runtime 消费的是本次 Rust owner。
   - 要求：`/health.version === package.json.version`，`status=ok`，`ready=true`，`pipelineReady=true`；若 mismatch，先修 release adoption，不宣称 closeout。

### 10.3 强制执行顺序

1. 读并执行项目入口规则：`AGENTS.md`、`docs/agent-routing/05-foundation-contract.md`、`.agents/skills/rcc-dev-skills/SKILL.md`、`/Users/fanzhang/.codex/skills/rustify-the-code/SKILL.md`。
2. 先跑基线：`git status --short`、`npm run verify:llmswitch-rustification-audit`、`npm run verify:architecture-mainline-binding-pending-gate`、`npm run verify:architecture-mainline-call-map`。
3. 对每个 remaining edge 先查 `docs/architecture/function-map.yml`、`docs/architecture/mainline-call-map.yml`、`docs/architecture/verification-map.yml`、wiki/manifest；无法定位唯一 owner 时先补 map/contract。
4. 先写测试设计和红测：白盒锁 Rust owner，模块黑盒锁公开入口，项目黑盒锁 HTTP/provider/client，架构红测锁 TS residue 不复活。
5. 只改唯一 Rust owner；TS 只允许 NAPI/JSON/stream bridge 或外部 IO glue。
6. 删除或收缩已迁移 TS residue；删除前确认依赖，删除后跑 residue gate。
7. 每个可闭合 slice 绿后立即精确 commit；多 worker dirty worktree 下只 stage 已 review/已验证范围，不 checkout/reset。
8. 所有本地 gate 绿后做 release install/runtime adoption：pack、temporary install verification、global/release install、managed restart、strict `/health.version` gate。
9. live replay 同入口旧失败样本或真实样本，至少覆盖 `/v1/responses` continuation/servertool stopless/followup、success、failure、non-terminal、already-terminal。
10. 最后做 architecture review、更新 `note.md`、`MEMORY.md` 和必要 skill lessons，再提交 docs/memory。

### 10.4 必跑验证矩阵

每个 slice 的最小验证以 `verification-map.yml` 为准；全局最终验证至少包含：

```bash
npm run verify:llmswitch-rustification-audit
npm run verify:architecture-mainline-binding-pending-gate
npm run verify:architecture-mainline-call-map
npm run verify:architecture-mainline-manifest-sync
npm run verify:architecture-mainline-mermaid-sync
npm run verify:architecture-wiki-sync
npm run verify:architecture-wiki-html-sync
npm run verify:function-map-compile-gate
npm run verify:servertool-rust-only
npm run verify:responses-history-protocol-contract
cargo test -p router-hotpath-napi --lib -- --nocapture
node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs
npm run build:base
npm run pack:rcc
npm run verify:rcc-release-install
```

Live/runtime gate 必须包含：

```bash
routecodex --version
rcc --version
routecodex restart --port <managed-port>
curl -sS http://127.0.0.1:<managed-port>/health
```

如果 `/health.version` 与 `package.json` 不一致，停止 rustification 完成声明，先修 release/runtime adoption。禁止用 CLI version、install success、restart success 或 `/health.ready` 替代 exact version gate。

### 10.5 最终完成标准

完整闭环只在以下条件全部满足时成立：

- `servertool.hook_skeleton.mainline` pending 为 0，且每条边真实绑定 Rust caller/callee。
- `responses.continuation.mainline` partial 为 0，continuation save/restore 不可变区无 TS 语义恢复。
- Hub-adjacent TS semantic residue 全部迁移或物理删除；保留 TS 均为 thin bridge / IO glue / diagnostic/test。
- `verify:llmswitch-rustification-audit`、mainline/map/wiki/function gates、Rust/Jest/build gates 全绿。
- release/global/live runtime version 严格一致。
- 同入口 live replay 覆盖 success、failure、non-terminal、already-terminal，并证明 internal metadata/debug/control 不进入 provider payload 或 client body。
- `git status --short` 最终干净，所有可验证 slice 已分组提交。
- `MEMORY.md` 与相关 lessons 记录最终已验证事实、剩余风险为零或明确列出未闭合项；若仍有未闭合项，不得称为完整 Rust 化。

## 11. 2026-07-12 Complete TS Orchestration Removal Contract

本节是当前 `/goal` 的执行真源。目标不是继续把 TS 编排拆成更多 native helper，而是把 Hub Pipeline 运行时语义收成 Rust-owned controller / Rust-owned plan / Rust-owned effect contract。TS 只能保留 Node 无法避免的边界：HTTP/SSE transport、stream object handoff、NAPI JSON call、process lifecycle IO、文件/网络 side effect executor。

### 11.1 主目标

完整去除 Hub Pipeline TS 编排：

- 请求链：`req_inbound -> req_chatprocess -> VR -> req_outbound` 的语义调度、metadata/control 写入、tool/history/continuation 判定必须由 Rust 拥有。
- 响应链：`resp_inbound -> resp_chatprocess -> resp_outbound` 的响应解析、tool harvest、servertool followup、client projection、effect plan 必须由 Rust 拥有。
- 错误链：provider/runtime/direct/executor error 必须单向进入 Rust/ErrorErr owner；TS 不得本地决定 retry/reroute/backoff/client projection。
- Runtime side effects：TS 可以执行 Rust plan 指定的 HTTP/FS/SSE/stream/process IO，但不能解释 plan 语义或补第二套成功路径。

### 11.2 收口对象

优先收以下 TS 编排面：

1. `src/modules/llmswitch/bridge/responses-request-bridge.ts`
   - request body prepare、runtime prepare、request context capture、tool-call seed、conversation cleanup、resume projection。
   - 目标：每块变为 Rust plan + TS side-effect executor。
2. `src/server/runtime/http-server/executor/provider-response-converter.ts` 及其 split hosts
   - SSE wrapper error remap、MetadataCenter sync、stage recorder、usage/finish reason、stream/body capture、provider context/error mapping。
   - 目标：语义投影/判定进 Rust；TS 只保留 stream 引用保护和 IO。
3. request/response executor host glue
   - provider invocation 前后的 Hub Pipeline handle、ErrorErr decision consumption、dry-run/snapshot side effects。
   - 目标：TS 不再组合多个 native helper 做业务判断。
4. servertool / stopless / continuation bridge residue
   - 目标：`resp_chatprocess save -> immutable interval -> req_chatprocess restore` 之间无 TS 语义恢复、history 修补、required_action 推断或 tool 状态补偿。

### 11.3 每轮固定执行顺序

每一轮只收一个 owner-specific slice，并强制执行：

1. 读规则与定位 owner
   - `AGENTS.md`
   - `.agents/skills/rcc-dev-skills/SKILL.md`
   - `docs/agent-routing/05-foundation-contract.md`
   - `docs/agent-routing/10-runtime-ssot-routing.md`
   - `docs/architecture/function-map.yml`
   - `docs/architecture/mainline-call-map.yml`
   - `docs/architecture/verification-map.yml`
   - 对应 wiki/manifest/source anchor
2. 建 slice claim
   - `.agent-collab` claim 使用 `feature_id` / `resource_id` / `mainline_node_id` / `gate_id`。
   - 不接管无关 dirty worktree，不 checkout/reset。
3. 红测先行
   - 白盒：Rust owner input/output、正向和反向。
   - 模块黑盒：TS bridge 只调用 Rust plan，不本地判定。
   - 架构红测：旧 TS helper / broad native mock / fallback / duplicate owner 复活必红。
4. Rust 实现
   - 新语义只写 Rust owner。
   - TS 只做 NAPI JSON wrapper、stream reference preservation、IO side-effect application。
   - 旧 TS 语义物理删除。
5. 本地 gate
   - 目标 slice required tests。
   - Rust focused tests。
   - `npm run verify:function-map-compile-gate`
   - `npm run verify:hub-pipeline-native-reference-gate`
   - `npm run verify:llmswitch-rustification-audit`
   - `npm run build:native-hotpath`
   - `ROUTECODEX_SKIP_AUTO_BUMP=1 npm run build:base`
   - `git diff --check`
6. 全局安装与受管重启
   - `npm run pack:rcc`
   - `npm run verify:rcc-release-install`
   - 执行当前项目标准 global/release install 命令，使用全局 `routecodex` / `rcc` 入口验证。
   - `routecodex restart --port <managed-port>`
   - 禁止 repo-local `node dist/cli.js start`、临时 shim、手工 start 作为完成证据。
7. 版本与健康三点一致
   - `routecodex --version`
   - `rcc --version`
   - `~/.rcc/install/current/package.json`
   - `curl -sS http://127.0.0.1:<managed-port>/health`
   - `/health.version` 必须等于 installed package version，且 `ready=true`、`pipelineReady=true`。
8. 查错并修复
   - 检查 `~/.rcc/logs/server-<port>.log` 最新段。
   - 检查 `~/.rcc/codex-samples/<endpoint>/ports/<port>/<requestId>/` 最新样本。
   - 若有 `InvalidData`、SSE terminal 缺失、provider payload metadata 泄漏、silent failure、restart/session 断链、ErrorErr bypass、health mismatch，回唯一 owner 修复并重跑本轮。
9. live replay
   - 至少重放同入口真实样本或旧失败样本。
   - 覆盖 success、failure、non-terminal/still-running、already-terminal 中和本 slice 相关的正反路径。
10. 提交与记录
   - 精确 stage 本 slice。
   - commit 前确认无关 dirty 未混入。
   - `note.md` / `MEMORY.md` / skill lessons 只记录已验证事实。

### 11.4 验证矩阵

每轮最小矩阵：

```bash
npm run verify:function-map-compile-gate
npm run verify:hub-pipeline-native-reference-gate
npm run verify:llmswitch-rustification-audit
npm run build:native-hotpath
ROUTECODEX_SKIP_AUTO_BUMP=1 npm run build:base
npm run pack:rcc
npm run verify:rcc-release-install
routecodex restart --port <managed-port>
curl -sS http://127.0.0.1:<managed-port>/health
```

最终矩阵额外包含：

```bash
npm run verify:architecture-mainline-binding-pending-gate
npm run verify:architecture-mainline-call-map
npm run verify:architecture-mainline-manifest-sync
npm run verify:architecture-mainline-mermaid-sync
npm run verify:architecture-wiki-sync
npm run verify:architecture-wiki-html-sync
npm run verify:servertool-rust-only
npm run verify:responses-history-protocol-contract
cargo test --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml -p router-hotpath-napi --lib -- --nocapture
```

### 11.5 完成定义

只有同时满足以下条件，才能宣称“完整 TS 编排去除”：

- Hub Pipeline runtime 主链无 TS 语义编排；TS 只剩 NAPI/JSON/stream/IO/lifecycle glue。
- 所有保留 TS surface 都能在 function map / mainline call map / verification map 反查 owner 和允许理由。
- 架构 gate 能拦住旧 TS 编排、fallback、重复 owner、metadata payload 泄漏、broad native mock/import 回流。
- 全局安装版本、`rcc`/`routecodex` CLI、`~/.rcc/install/current`、目标端口 `/health.version` 严格一致。
- managed restart 后无新增 server log 错误；旧失败样本或同入口真实样本 replay 通过。
- 每个 slice 已分组提交；最终工作区只剩明确无关 dirty 或干净。

### 11.6 已闭环 slice：provider-request dry-run terminal action（2026-07-13）

- Rust owner：`provider_dry_run_terminal_action.rs`；marked dry-run 在 provider transport 返回后、provider response postprocess 之前 terminal return。
- TS 仅观察 opaque marker 并执行 Rust `return_dry_run_terminal` / `continue_normal_response`；unknown action fail-fast。
- 正向锁 marked dry-run 不进入 postprocess；反向锁 normal response 保持原链。
- release `0.90.3932` 安装并 managed restart 5555；强制 relay 模型 `glm-5.2` 命中 `orangeai.key1.glm-5.2`，HTTP 200、`stoppedBeforeProviderSend=true`，无新增 `500-220`。

### 11.7 已闭环 slice：provider-response MetadataCenter sync effect plan（2026-07-13）

- Rust owner：`provider_response_metadata_sync_effect.rs`；闭合输出 `no_op` / `bind_bridge_center` / `apply_writes`，并拥有合法 family/key/value/reason/writer。
- TS 只观察 request-local MetadataCenter existence/identity、读取 bridge snapshot、执行 Rust 指定的 bind/write IO；unknown action/target fail-fast，不保留本地 key/reason/action 判定。
- 正向锁 center bind 和三类内部 control/debug write；反向锁无 center/no-change no-op、未知 action、provider/client payload 隔离。
- Rust 2/2、converter Jest 22/22、function-map/native-reference/rustification/native/base/release gates 通过；安装版本 `0.90.3932` 与 5555 health 对齐。真实 relay `/v1/responses` 请求 `req_1783901694274_31145773` 返回 HTTP 200 `pong`，最新日志无 metadata sync/conversion 新错误，样本无内部 control/debug key 泄漏。

### 11.8 已闭环 slice：provider-response servertool retirement effect plan（2026-07-13）

- Rust owner：`hub_pipeline_lib/effect_plan.rs`；验证 legacy `servertoolRuntimeActions`，产出 `continue` / `reject_legacy_actions`，并拥有可选 stop-gateway write、writer/reason 与 fail-fast message。
- TS 仅调用 native plan、执行返回的 MetadataCenter write、返回 unchanged payload 或抛 Rust error；旧 array scan、stopGateway extraction、reason/message 已物理删除，unknown action fail-fast。
- 正向锁 empty continue 与 non-empty reject/write；反向锁 malformed actions、无 stopGateway reject、TS action/reason/message 复活。
- Rust 1/1、provider-response Jest 261/261、TypeScript、servertool/function-map/native-reference/rustification/native/base/release gates 通过；安装 `0.90.3932` 与 5555 health 对齐。真实 relay 请求 `req_1783902800867_58653283` 返回 HTTP 200 `pong`，日志与样本无新增错误或内部 action/control 泄漏。

### 11.9 已闭环 slice：provider-response stopless runtime-control effect plan（2026-07-13）

- Rust owner：`hub_pipeline_lib/effect_plan.rs`；直接消费 canonical `StoplessMetadataCenterWritePlan`，产出 `no_op` / `apply_runtime_control`，并拥有 `stopless` / `stopMessageCompareContext` 投影、writer/reason 与 malformed/unknown-field fail-fast。
- TS 仅调用 native planner并执行返回的 MetadataCenter write；旧 truthy 分支、通用 projector 调用、本地 writer/reason 已物理删除，unknown action fail-fast。
- 正向锁 stopless + compare-context 写入且排除 learned-note；反向锁 absent/null-only no-op、旧 `{plan: ...}` 包装和未知字段拒绝、TS key/writer/reason 复活。
- Rust 1/1、provider-response Jest 261/261、TypeScript、servertool/function-map/native-reference/rustification/wiki/native/base/release gates 通过；安装 `0.90.3932` 与 5555 health 对齐。真实 relay 请求 `req_1783904054042_3dbaf9a4` 返回 HTTP 200 `pong`，当前主日志无新增错误，样本 provider/client 文件无内部 stopless/runtime-control key 泄漏。

### 11.10 已闭环 slice：provider-response stream-pipe effect plan（2026-07-13）

- Rust owner：`hub_pipeline_lib/effect_plan.rs`；闭合 `no_pipe` / `use_pipe`，验证并归一化 `codec`、`requestId`、object `payload`，拥有 malformed error。
- TS `readProviderResponseNativeStreamPipe` 只调用 native plan、返回 pipe 或 null、拒绝未知 action；旧 `asRecord/readString` 字段校验和 malformed 文案已物理删除，Node SSE IO 保持不变。
- 正向锁 trimmed codec/requestId 与 payload；反向锁 absent no-pipe、非 object/缺字段/空字符串 malformed、TS validation/error 复活。
- Rust 1/1、provider-response Jest 261/261、TypeScript、function/resource/mainline/native-reference/rustification/wiki/native/base/release gates通过；安装 `0.90.3932` 与 5555 health 对齐。真实 relay SSE 请求 `req_1783905286656_132cccdc` HTTP 200，输出 `STREAM_PIPE_OK`、`response.completed`、`response.done` 且无 `event:error`；当前主日志与样本无内部 effect key 泄漏。

### 11.11 已闭环 slice：provider-response continuation record effect contract（2026-07-13）

- Rust owner：`publishResponsesRecordPlanJson` 产出完整 `recordArgs`，包括固定 `entryKind=responses`、`continuationOwner=relay`、`allowScopeContinuation=true` 及可选 scope/provider/route 字段。
- TS effect executor 只能把 `plan.recordArgs` 原样交给 conversation store IO；禁止重建 object、truthy 过滤字段或补 owner/default。
- 正向锁完整 record contract 直达 store；反向锁 TS 固定常量、optional spread 与第二语义 owner 不复活。
- Rust 1/1、provider-response Jest 261/261、TypeScript、responses-history/function-map/native-reference/rustification/wiki/native/base/release gates 通过；安装 `0.90.3932` 与 5555 health 对齐。真实 relay `/v1/responses` 请求 `req_1783906711085_1c5ea6bc` 返回 HTTP 200 `RECORD_EFFECT_OK`；最新样本 provider/client 响应无 continuation owner/scope 或内部 runtime-control key 泄漏，当前主日志无本请求新增错误。

### 11.12 已闭环 slice：provider-response runtime-state write input contract（2026-07-13）

- Rust owner：`publishResponsesRecordPlanJson` 解析并验证 `runtimeStateWrite` 必须是 object 或 null；非法 JSON、array、scalar 显式失败。
- TS effect executor 只把 Rust runtime effect 值原样交给 native planner，absent 才投影为 null；禁止 `asRecord` 把 malformed shape 静默改成 null。
- 正向锁 canonical object/null 继续产出 record/finalize/usage plan；反向锁 array/scalar 与 TS malformed-to-null coercion。
- Rust focused 1/1、responses-history Rust 89/89、provider-response Jest 27/27、residue、TypeScript、function-map/native-reference/rustification/wiki/native/base/release gates 通过；安装 `0.90.3932` 与 5555 health 对齐。真实 relay `/v1/responses` 请求 `req_1783907455629_46f0da58` 返回 HTTP 200 `RUNTIME_STATE_WRITE_OK`；最新 provider/client 样本无 runtime-state、continuation owner/scope 或内部 runtime-control key 泄漏，当前主日志无本请求新增错误。

### 11.13 已闭环 slice：provider-response diagnostic alarm effect plan（2026-07-13）

- Rust owner：`planProviderResponseDiagnosticAlarmEffectJson` 验证 requestId/diagnostics，筛选合法 `details.alarm`，trim 标识并生成完整 console message，闭合 `no_op` / `emit`。
- TS 只遍历 Rust 返回的 message 字符串并执行 `console.warn`；禁止读取 diagnostics/details/alarm、JSON stringify details、选择 no-op/emit 或维护 try/catch fallback 文案。
- 正向锁合法 alarm 完整消息；反向锁无 alarm no-op、malformed diagnostics fail-fast、TS filtering/formatting/fallback 不复活及 provider/client payload 隔离。
- Rust focused 1/1、真实 native binding alarm integration 1/1、provider-response Jest 27/27、residue、TypeScript、resource/function/mainline/native-reference/rustification/wiki/native/base/release gates 通过；安装 `0.90.3932` 与 5555 health 对齐。
- 真实 normal/no-op `/v1/responses` 请求 `openai-responses-router-glm-5.2-20260713T100720868-512965-681` 返回 HTTP 200 `DIAGNOSTIC_NORMAL_OK`；无显式 session 的请求 `openai-responses-router-glm-5.2-20260713T100726469-512966-682` 由 runtime 生成 request-local session truth 并返回 HTTP 200 `DIAGNOSTIC_ALARM_OK`，因此 live 入口不会自然产生 missing-session alarm。emit 分支由真实 NAPI integration 锁住，输出 `[hub-pipeline][alarm] stopless_missing_session_id ...`；最新 canonical sample 无 diagnostic/runtime-control/continuation 内部字段泄漏，当前主日志无新增目标错误。

### 11.14 已闭环 slice：provider-response outbound effect materialization（2026-07-13）

- Rust owner：`materializeProviderResponseOutboundEffectPlanJson` 消费 total native response plan，验证 payload/requestId/diagnostics/effectPlan 并产出闭合 payload、diagnostic input 与 runtime effects。
- TS 只调用 native materializer、执行 console/metadata/store/stream host IO；禁止读取 nested native plan、校验 effects array、重建 runtime projection 或保留零消费者 `__nativeResponsePlan` cache。
- 正向锁 total plan materialization；反向锁 malformed payload/requestId/diagnostics/effects、旧 normalize export 与 TS nested inspection/cache 不复活。
- Rust 正反 focused 2/2、provider-response Jest 27/27、residue、TypeScript、resource/function/host-split/native-reference/rustification/wiki/native/base/release gates 通过；安装 `0.90.3932`，`routecodex` / `rcc` / install current / 5555 health 四点一致。
- 真实 5555 cross-protocol `/v1/responses` 请求 `req_1783911950468_327981fa` 从 `gpt-5.5` relay 到 `orangeai.key1.glm-5.2`，HTTP 200，返回 `EFFECT_MATERIALIZATION_LIVE_OK` 与 `requires_action`，日志 `finish_reason=tool_calls`；canonical sample 无 runtime-control/continuation/cache/materialization 内部字段泄漏。

### 11.15 已闭环 slice：provider-response stage recorder effect plan（2026-07-13）

- Rust owner：`planProviderResponseStageRecorderEffectJson` 验证 client semantic 与 stream pipe，产出有序 stage record 列表。
- TS 只在 recorder 存在时调用 Rust planner 并执行 `recorder.record(stage, payload)`；禁止本地维护 stage9/stage10 字符串、`native-effect-plan` protocol、passthrough/payload envelope 或 string payload normalizer。
- 正向锁 body 与 stream stage records；反向锁 malformed input、TS stage-name/envelope/normalizer 复活，以及 recorder IO failure 必须 fail-fast、不得吞错伪成功。
- Rust focused 2/2、provider-response Rust plan + metadata protocol 28/28、metadata protocol 6/6、residue 234/234、TypeScript、resource/function/host-split/native-reference/rustification/wiki/native/base/release gates 通过；安装版本 `0.90.3932` 与 5555 health 对齐。
- 真实 5555 cross-protocol `/v1/responses` 请求 `req_1783914007571_505e44b3` 从 `gpt-5.5` relay 到 `orangeai.key1.glm-5.2`，HTTP 200，返回 `STAGE_RECORDER_LIVE_OK`、`status=completed`，日志 `finish_reason=stop`；canonical sample 无 stage-recorder/runtime-control/continuation/native-plan 内部字段泄漏，目标请求附近无 `recordStage failed` 或新 `InvalidData`。

### 11.16 2026-07-13 当前源码审计后的剩余 closeout 顺序

当前不能因 `sharedmodule/llmswitch-core` 生产 TS 为零、mainline 全 anchored，或既有 provider-response effect slices 已闭环，就宣称 Hub Pipeline 已完全 Rust 化。根仓 Node host 仍有未登记的语义 owner；后续按以下顺序收口，禁止继续把 TS 编排拆成更多零散 native helper。

1. **先锁 continuation writer 唯一性**
   - relay canonical save 只允许由 Rust `publishResponsesRecordPlanJson` 产出完整 record/finalize effect，TS 只能把 effect 参数原样交给 conversation-store IO。
   - `src/server/handlers/responses-handler.ts -> finalizeResponsesPipelineResultForHttp -> seedResponsesToolCallResponseForHttp` 是 response Chat Process 之后的第二 save orchestration；必须先写 handler post-pipeline save 红测，再物理删除这条路径及其 `routeHint/providerKey/requestId` 多源拼接。
   - router-direct 的 direct continuation 不得删除或改成 relay；其 persist/clear/capture/finalize 决策必须进入 Rust direct-owner plan，Node 只执行闭合 store effect。
   - gate 必须枚举所有 `recordResponsesResponse` 生产 caller，并校验每条 caller 均能回链到 resource map allowed writer；未登记 caller 必须失败。
   - 2026-07-14 source-gate closeout: `verify:responses-relay-continuation-writer-uniqueness` 已锁住 relay canonical save 的唯一 Rust `publishResponsesRecordPlanJson -> continuationStoreEffects` owner；handler/request bridge 不再包含 post-pipeline save/seed writer。正反 fixture 已覆盖 handler save、request-bridge seed、Rust canonical writer 缺失和 store effect order 缺失。本项 source gate 已关闭；release/global install/restart/live replay 未授权、未执行。

2. **收缩 Responses request bridge**
   - `src/modules/llmswitch/bridge/responses-request-bridge.ts` 只保留 NAPI/JSON、Node-only lookup/store/file IO 和 opaque effect execution。
   - system prompt 是否应用、request context/input/tools 重建、continuation action、endpoint/client error default、MetadataCenter writer、tool-history errorsample 分类全部由 Rust total plan 拥有。
   - Rust plan 必须返回 final payload、typed metadata writes、完整 IO effect 参数和完整 client error descriptor；TS 不得补字段、过滤 malformed shape、按 payload 推断 owner/protocol/scope，unknown action 必须 fail-fast。
   - 2026-07-13 source closeout: MetadataCenter writer identity, system prompt payload mutation, malformed tool-history errorsample classification, closed continuation `execute_effect|complete` arguments/results, and resume client-error descriptor/projection are now Rust-planned. TS only reads host prompt config, serializes thrown errors, attaches MetadataCenter, executes exact file/store/native IO effects, and round-trips opaque `resultPlanInput`; no TS response-id/owner/scope/endpoint/payload/resume-meta reconstruction remains in `responses-request-bridge.ts`. This closes item 2 at source/native/build level; release/global install/restart/live replay still require explicit authorization.

3. **关闭 provider-response ErrorErr TS 旁路**
   - `src/server/runtime/http-server/executor/provider-response-converter.ts` 不得本地决定 `code/status/statusCode/retryable/upstreamCode`，不得按 context/rate-limit/network/message/provider mapping 二次分类错误。
   - raw provider body/SSE wrapper/transport exception 必须单向进入 Rust `ErrorErr01SourceRaised -> ErrorErr06ClientProjected`；Node 只捕获 raw evidence、执行 transport IO、按 Rust descriptor 抛错或写 client frame。
   - 先关闭 error path，再关闭 success body/SSE delivery；usage、finish reason、direct prebuilt SSE legality、body/stream/client frame 必须由 Rust total response plan 拥有。
   - 2026-07-13 error-path source slice 1: `provider-response-converter.ts` 已删除 rate-limit/context/network/provider-configured/bridge-SSE TS remap、normalized error-field writes 和 recoverability branch；SSE wrapper 只以 `response/details` 保存 raw message/code/status evidence 后抛出，bridge catch 只记录诊断并原样 rethrow。专用正反 gate、focused Jest 25/25、TypeScript、ErrorErr contract 和 function-map gate 已绿。
   - 2026-07-13 error-path source slice 2: `request-executor-provider-send-failure.ts` / `request-executor-provider-failure.ts` 已无 `remapBridgeSseErrorToHttp`、provider-response processing TS pre-filter、SSE message/status rate/network stage inference；旧 `provider-response-sse-error-normalizer.ts` 和只验证 TS remap 的 `provider-response-converter-empty-sse.spec.ts` 已物理删除。`verify:provider-response-errorerr-bypass-closeout` 现在同时锁住旧模块/旧测试不可复活，negative fixture 覆盖 dead module/test revival。
   - 2026-07-13 error-path source/native/build closeout: Rust `failure_policy.rs` 已删除 provider-origin 401/402/403/404、auth/quota/account/model message/code 的不可恢复特判；provider-origin auth/quota/account/model failures 归为 recoverable，并只在 route pool 与 default pool 同时耗尽后才允许 ErrorErr05 client projection。`MALFORMED_REQUEST`、`CLIENT_TOOL_ARGS_INVALID`、provider runtime request contract、local response contract 仍保持 unrecoverable；`client_disconnect` 仍 health-neutral。红证据先证明 provider-origin 401/INVALID_API_KEY 与 streaming 403+default pool available 会被旧分类阻断，绿证据覆盖 Rust failure policy 47/47、provider-origin focused 2/2、local contract negative 1/1、client-disconnect 1/1、focused executor/Jest、blackbox 401/403/quota primary+backup 200、provider-response ErrorErr gates、ErrorErr contract、function-map、architecture-light、TypeScript、native hotpath 与 `ROUTECODEX_SKIP_AUTO_BUMP=1 npm run build:base`。release/global install/restart/live replay 未授权、未执行。

4. **删除 response host dead/legacy surface**
   - 证明 `executeProviderResponseNativeServertoolEffects` 的 production result 只能 `unchanged` 或 fail-fast 后，删除 `provider-response-converter-host.ts` 中不可达的 `HubRespChatProcess03Governed` stage 分支。
   - 证明 `projectNativeMetadataWritePlanToRuntimeControlWritePlan` 无生产 caller 后，物理删除 wrapper、export、malformed result 返回 `{}` 的 fallback，以及反向锁住旧 wrapper 的测试。
   - 2026-07-13 source/build closeout: `executeProviderResponseNativeServertoolEffects` 已收成 `Promise<void>`，empty retired-action list 只返回，non-empty/malformed 仍由 Rust plan 显式失败；body 固定消费 Rust `rawPayload`，stream 固定消费 Rust `streamPipe.payload`，host 不再返回或分支 `HubRespChatProcess03Governed|unchanged` stage。零生产 caller 的 root metadata wrapper、root native-calls export 与 malformed `{}` fallback 已物理删除。红门先准确命中四类旧 surface，随后 host-split positive/negative、stage residue 249/249、provider-response Rust plan 22/22、provider-response metadata/body/stream、TypeScript、function-map、thin-wrapper、rustification、architecture-review-light、native hotpath 与 `build:base` 全部通过。release/global install/restart/live replay 未授权、未执行。

5. **收紧 Rust engine 唯一真源和 fail-fast**
   - `requestId` 缺失不得回退固定字符串；`clientProtocol/providerProtocol` 必须由 typed ingress/runtime contract 写一次，禁止从 endpoint 或 flat metadata 回推。
   - `excludedProviderKeys` 只走合法 route/error control carrier，禁止 flat metadata 与 MetadataCenter 双写镜像。
   - stopless enablement 只读唯一 MetadataCenter family；required terminal `chatResponse` 缺失必须错误，禁止回退 runtime output 或原 payload；状态时间获取失败不得写 `0`。
   - 2026-07-13 test-design/audit: `docs/goals/hub-pipeline-engine-failfast-closeout-test-design.md` 已锁定上述六类 residue 的生命周期、正反白盒、module/project blackbox 和 gate。源码已确认固定 request id、endpoint/flat protocol 推断、exclusion 双写、多源 stopless activation、terminal `chatResponse` 三级回退、clock failure `0` 均仍存在。对应 Rust 路径当前与 payload/stopless active claims 重叠，已写 `.agent-collab` checked handoff 请求；交接前不修改 runtime，本项仍未闭环。
   - 2026-07-14 contract wiring: 新增 `verify:hub-pipeline-engine-failfast-closeout` 与 13/13 revival fixtures；`route.retry_exclusion_set` 已登记为 ErrorErr05 唯一 writer、retry/VR consumer 的 side-channel，function/resource/mainline/verification map 已绑定。Revival 13/13、resource map 118/118、function map 160 features/384 builders、mainline 20 chains/113 edges 均绿，source verifier 仍按预期红 13 项。连续三次 handoff 检查均无 payload-copy/stopless claim 的 checked release，故未越权修改 Rust source。
   - 2026-07-14 source/native/build closeout: Rust engine/NAPI/VR/executor source 已收紧为 fail-fast/单真源，source verifier PASS、revival fixtures 13/13 PASS、Rust focused `hub_pipeline_engine_failfast` 11/11 PASS、TS executor focused 8/8 PASS。新增编译后 `.node` handle-mode replay `tests/sharedmodule/hub-pipeline-engine-failfast-direct-native.spec.ts`：显式 `providerProtocol="openai-responses"` + 顶层 `retryExclusionSet=["openai.key1.gpt-5.5"]` 选择 `openai.key2.gpt-5.5`，只有 flat `metadata.excludedProviderKeys` 时仍选择 `openai.key1.gpt-5.5`。resource/function/mainline/review gates、native hotpath build、`ROUTECODEX_SKIP_AUTO_BUMP=1 npm run build:base` 与 target diff check 均通过。release/global install/restart/live replay 未授权、未执行，本项只能声明 source/native/build closeout。

6. **补齐根仓 host gate**
   - `verify:architecture-thin-wrapper-only` 必须覆盖根仓 bridge/handler/converter，不能以 `checked files: 0` 作为完成证据。
   - 修复当前 `verify:server-function-map-boundary` review-surface 失败，并同步 resource map、function map、mainline call map、verification map、wiki 和 manifest。
   - 新增正反红测锁 handler save、store writer uniqueness、TS ErrorErr 分类、flat metadata protocol fallback、semantic output 回原 payload、malformed plan 降级和 dead wrapper 复活。
   - 2026-07-14 source-gate closeout: `verify:architecture-thin-wrapper-only` 已从 sharedmodule-only 空扫描扩展为根仓 `src/modules/llmswitch/bridge/**` 加 handler/converter/executor 显式面，当前实际扫描 47 个 root host TS 文件，并在 `rootHostCheckedFiles=0` 时失败。新增 `test:architecture-thin-wrapper-only-red-fixtures` 10 类反例，覆盖 handler/bridge second save、ErrorErr 本地分类、flat `providerProtocol` / `excludedProviderKeys`、semantic payload fallback、malformed native plan `{}` downgrade、broad native facade 和 dead metadata wrapper 复活；gate 已接入 architecture longtail、function/resource/mainline/verification maps。`verify:server-function-map-boundary` 当前通过。source gate 已关闭；release/global install/restart/live replay 未授权、未执行。

每个 slice 仍按 §11.3 固定顺序执行：测试设计与红测先行，只改唯一 Rust owner，随后物理删除 TS semantic residue，跑 focused Rust/Jest/module blackbox、架构 gate、native/base build；获得明确授权后才做 release/global install、聚合 restart 和同入口 live replay。最终只有 root host TS 均可解释为 HTTP/SSE/stream/NAPI/FS/network/process IO，全部主线无第二语义 owner、无 fallback、无未登记 writer，并完成 success/failure/non-terminal/already-terminal 正反验证，才可宣称 Hub Pipeline 完全 Rust 化。
