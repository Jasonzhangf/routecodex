# Followup / Meta / Provider Outbound 白名单收口计划

## 目标与验收标准

目标：
- 完成 followup / continuation / provider metadata 消费链审计与收口。
- 所有内部 meta 仅在 hub / router / servertool / provider runtime 内部使用，不再通过 outbound payload 泄露给 provider。
- 普通 `/v1/responses` 请求不得因 scope 上存在历史 continuation 而被错误注入 `previous_response_id`。
- 建立并固定 `store=false / direct+store=true / relay+store=true` 的 continuation ownership 共识，作为后续 direct / relay / followup / submit_tool_outputs 的统一架构约束。

验收标准：
1. `search`、普通 `thinking`、普通 `coding` 首发请求，在没有显式 continuation 证据时，不会自动续接 Responses continuation。
2. provider outbound payload 不再包含内部控制面字段：`metadata`、`routeHint`、`responsesResume`、`__rt`、`__shadowCompareForcedProviderKey`、`clientInject*` 等。
3. provider runtime 仍可通过 runtime symbol / context 读取所需内部 hint，不因 outbound 白名单前移而失能。
4. direct / relay / submit_tool_outputs / servertool followup 的请求形状与上下文语义保持正确。
5. `store=false` 请求绝不自动续接；`direct+store=true` 只能同 provider 远程恢复；`relay+store=true` 只能本地恢复。
6. followup 只作为“正常请求重入”，不再形成第二套 continuation 私有协议。
7. 通过红测→实现→绿测→build/install/restart/live replay 全链路验证。

## 范围与边界

In Scope：
- Rust Responses continuation trigger / restore owner 的触发条件收紧
- hub outbound allowlist / provider payload policy 收口
- provider 侧 `body.metadata` 消费迁移到 runtime symbol / context
- followup / submit_tool_outputs / direct / relay 相关回归测试
- 架构文档补充“meta 不出 hub pipeline”的约束

Out of Scope：
- 不重做 provider transport 协议
- 不扩展新的 followup 功能
- 不做与本问题无关的 provider retry / cooldown 改造
- 不引入 fallback / 双路径长期共存

## 设计原则

## 新增架构约束（2026-05-26）

### Responses continuation / save-restore ownership

新增单一语义文档：
- `docs/design/responses-continuation-storage-ownership.md`

必须遵守：
1. `store=false` 不保存，不允许 continuation
2. `direct + store=true` 的 state 属于远程 provider，只能由同一个 provider 恢复
3. `relay + store=true` 的 state 属于本地 store，只能由本地恢复
4. 普通 `/v1/responses` create 不得因 session / conversation / scope 命中历史而自动续接
5. followup 只是正常请求重入；若触发 continuation，必须遵守 direct/relay ownership，不允许跨介质恢复
6. 内部 meta / ownership / sticky 信息只允许在 hub 内部流转；provider 与 client 都不可见

这条规则的唯一 continuation 真源只允许收口在 Rust/native owner：
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/responses_resume.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`

已删除的旧 TS owner 禁止恢复：
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/route-aware-responses-continuation.ts`
- `tests/sharedmodule/route-aware-responses-continuation.spec.ts`

1. 单一真源：
   - continuation 触发真源收口在 Rust `hub_pipeline_blocks/responses_resume.rs`
   - continuation store restore/materialize 真源收口在 Rust `shared_responses_conversation_utils.rs`
   - provider outbound 白名单真源收口在 hub provider payload policy / native allowlist
2. 内部控制面与外部协议面分离：
   - 内部 meta 走 runtime symbol / adapter context
   - 外部 payload 只保留协议允许字段
3. 不靠 provider client 末端删字段兜底：
   - client 层删 `metadata` 只能作为防御，不能作为主真源
4. direct 不过 hub 语义改写，relay 才走 hub request/response 编排；两者都不得向 provider 泄露内部 meta
5. 先红测，再最小修改，再绿测，再真实入口验证
6. followup 语义不单独发明协议：只允许“恢复 origin 标准输入 + 增量并入 + 正常 create 重入”

## 现状审计结论

### A. continuation 误触发真源
- 文件：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/responses_resume.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
- 当前问题：只要 `entryProtocol === 'openai-responses'` 且 scope 命中，就可能自动恢复 continuation。
- 风险：普通 `/v1/responses` create（尤其 search）会被错误注入 `previous_response_id`，打成 continuation。
- 边界：旧 `route-aware-responses-continuation.ts` TS owner 已删除，不能作为修复点恢复。

### B. metadata 出站收口过晚
- 文件：
  - `src/client/responses/responses-protocol-client.ts`
  - `src/client/openai/chat-protocol-client.ts`
- 当前问题：provider client 层会 `delete body.metadata`，但这是过晚收口；在此之前 payload 已可能被多层消费或污染。
- 正确收口点：hub outbound provider payload allowlist。

### C. provider 仍有 body.metadata 消费
重点文件：
- `src/providers/core/runtime/provider-request-preprocessor.ts`
- `src/providers/core/runtime/responses-provider.ts`
- `src/providers/profile/families/glm-profile.ts`
- `src/providers/core/runtime/deepseek-http-provider-helpers.ts`
- `src/providers/core/runtime/vercel-ai-sdk/openai-sdk-transport.ts`

其中要区分：
1. 正确：`extractProviderRuntimeMetadata(...)` 读取 non-enumerable runtime symbol
2. 错误/待迁移：直接从 `request.body.metadata` 读取内部 hint

## 技术方案

### 1. 收紧 continuation 触发条件
目标文件：
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/responses_resume.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`

策略：
- 只有存在明确 continuation 证据时才允许恢复 continuation：
  - submit_tool_outputs
  - body 已显式带 `response_id` / `previous_response_id`
  - metadata 明确有 `responsesResume`
  - 明确 servertool followup / origin followup 重入
- 普通 `/v1/responses` create 不得仅因 scope 上有历史 continuation 就自动恢复。

### 2. provider outbound allowlist 前移
目标文件：
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-provider-payload-policy-apply-blocks.ts`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_protocol_spec_semantics.rs`
- 对应 native allowlist / policy Rust 真源

策略：
- 在 providerPayload 形成后、发给 provider 前，统一剥离内部控制字段。
- 强制禁止内部 carrier 进入 outbound payload。
- provider client 末端删除逻辑保留为防御，但不再承担主职责。

### 3. provider metadata 消费迁移
目标文件：
- `src/providers/core/runtime/provider-request-preprocessor.ts`
- `src/providers/core/runtime/provider-runtime-metadata.ts`
- `src/providers/core/runtime/responses-provider.ts`
- `src/providers/profile/families/glm-profile.ts`
- `src/providers/core/runtime/deepseek-http-provider-helpers.ts`
- `src/providers/core/runtime/vercel-ai-sdk/openai-sdk-transport.ts`

策略：
- 保留 runtime symbol 机制：`attachProviderRuntimeMetadata` / `extractProviderRuntimeMetadata`
- 所有 provider runtime / profile / transport 优先读：
  1. runtime symbol
  2. provider context metadata
  3. 极少数兼容读取 body.metadata（仅迁移过渡期，如必须）
- `body.metadata` 不再作为内部控制真源，更不能进入 upstream payload。

### 4. followup / direct / relay 语义守护
目标文件：
- `src/server/handlers/responses-handler.ts`
- `sharedmodule/llmswitch-core/src/servertool/backend-route-runtime-block.ts`
- `sharedmodule/llmswitch-core/src/servertool/backend-route-backend.ts`
- `src/server/runtime/http-server/executor/provider-response-converter.ts`

策略：
- followup 仍允许通过内部 metadata / runtime symbol 控制
- 禁止 `provider-response-converter` 一类路径把 `routeHint` 等控制信号再写回 `payload.metadata`
- direct / relay 均保持“内部可见、外部透明”

## 文件清单

主修改候选：
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/responses_resume.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-provider-payload-policy-apply-blocks.ts`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_protocol_spec_semantics.rs`
- native allowlist / policy 对应 Rust 真源文件
- `src/providers/core/runtime/provider-request-preprocessor.ts`
- `src/providers/core/runtime/responses-provider.ts`
- `src/providers/profile/families/glm-profile.ts`
- `src/providers/core/runtime/deepseek-http-provider-helpers.ts`
- `src/providers/core/runtime/vercel-ai-sdk/openai-sdk-transport.ts`
- `src/server/runtime/http-server/executor/provider-response-converter.ts`
- `docs/ARCHITECTURE.md`

测试候选：
- `tests/responses/*`
- `sharedmodule/llmswitch-core/tests/hub/*`
- `tests/providers/runtime/*`
- `tests/servertool/*`
- 新增 provider outbound meta 白名单回归
- 新增 search/normal create 不自动 continuation 回归

## 风险与规避

### 风险 1：前移白名单后 provider 失去必要 hint
规避：
- 先审所有 `body.metadata` 消费点
- 先迁移到 runtime symbol / context，再启用强收口
- 红测覆盖 provider hint 仍可读

### 风险 2：submit_tool_outputs / followup 被误判为普通 create
规避：
- continuation 触发条件显式覆盖 submit / followup / explicit previous_response_id
- 针对 submit_tool_outputs、servertool followup 单独补回归

### 风险 3：direct/relay 切换再次丢上下文
规避：
- 增加 direct 首发 -> relay followup -> 普通 create 的状态机回归
- 对比相邻回合上下文增量而不是只看状态码

## 测试计划

### 第一组：红测（必须先写）
1. search 普通 `/v1/responses` create，在同 scope 已存在 continuation 时，不得自动注入 `previous_response_id`
2. 普通 thinking/coding 首发请求，不得因历史 continuation 自动恢复
3. provider outbound payload 不含内部 meta 字段
4. provider runtime 仍可通过 runtime symbol 读取 `entryEndpoint/authType/providerProtocol/reasoning_effort/clientHeaders` 等 hint
5. direct passthrough 不丢协议字段，且不把内部 meta 发给 upstream

### 第二组：绿测回归
1. submit_tool_outputs continuation 仍正常
2. servertool followup 仍正常
3. direct / relay / same-protocol responses passthrough 不回归
4. provider-a / responses provider / transport metadata 读取路径正常

### 第三组：构建与实机验证
1. 目标测试集通过
2. `npm run build:min`
3. `npm run install:global`
4. `routecodex restart --port 5555`
5. 原 failing-shape replay + control replay + live sample 验证

## 实施步骤

1. 落红测：continuation 误触发 + outbound meta 泄露 + provider hint 读取
2. 审计并迁移 provider `body.metadata` 消费到 runtime symbol / context
3. 收紧 Rust Responses continuation owner 的 continuation 触发条件
4. 前移 hub outbound allowlist，禁止 internal meta 出站
5. 清理 `provider-response-converter` 等路径的 payload.metadata 注入
6. 跑定向测试
7. build / install / restart
8. live replay / failing sample 验证
9. 更新架构文档

## 完成定义（DoD）

1. 普通 `/v1/responses` create 不再错误触发 continuation
2. 所有内部 meta 不出 hub pipeline
3. provider 所需 hint 全部走 runtime symbol / context，不再依赖 outbound body.metadata
4. submit_tool_outputs / followup / direct / relay 回归全绿
5. build/install/restart/live 验证完成
6. summary 中可明确说明：
   - continuation 真源为什么唯一在 Rust `responses_resume.rs` / `shared_responses_conversation_utils.rs`
   - outbound meta 收口为什么唯一在 hub allowlist，而不是 provider client 末端删除
7. 架构文档已明确写清 ownership 共识：`store=false` / `direct+store=true` / `relay+store=true`
