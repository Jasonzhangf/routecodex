# Hub Pipeline Phase Typing Phase 2 Response Plan

## 1. 目标与验收标准

目标：只为 Hub Pipeline 响应链建立 `resp_inbound / resp_chatprocess / resp_outbound` 三段数据结构命名骨架与边界红测，不改变现有响应运行流程、不改变 client response 语义、不移动真实业务逻辑。

验收标准：

1. 新增类型名遵循 `docs/design/pipeline-type-topology-and-module-boundaries.md` 的 `<Module><Phase><NN><Node>`。
2. 第二阶段只覆盖响应链三段：`HubRespInbound02Parsed`、`HubRespChatProcess03Governed`、`HubRespOutbound04ClientSemantic`。
3. 现有响应执行流程、native 调用顺序、SSE/JSON client 输出保持语义等价。
4. red test 能阻止 provider raw 直达 server client frame、旧命名 `RespProc` / `resp_process` 新数据结构、响应 payload 携带 internal metadata。
5. 不引入 fallback、不吞 provider parse error、不在响应链修复请求侧历史污染。

## 2. 范围与边界

### In Scope

- Hub Pipeline response-side 类型骨架。
- 相邻节点 parser/projector 的命名规范与最小壳。
- 架构 red test / residue scan。
- 必要的文档引用更新。

### Out of Scope

- 不改请求链实现。
- 不改 Provider Runtime raw decode 行为。
- 不改 Server handler/SSE write 行为。
- 不改 servertool followup 编排逻辑。
- 不做大规模文件重命名。
- 不删除旧实现，除非 red test 证明是本阶段新增的错误壳。

## 3. 设计原则

1. 先类型边界，后流程迁移。
2. 只允许相邻转换：`ProviderRespInbound01Raw -> HubRespInbound02Parsed -> HubRespChatProcess03Governed -> HubRespOutbound04ClientSemantic -> ServerRespOutbound05ClientFrame`。
3. `RespChatProcess` 是响应侧工具治理语义，不允许退回泛化 `RespProcess`。
4. internal metadata 只能走 `Meta*` carrier，不能进入 client response body。
5. 错误必须进入 `Error*` 链，不得在响应链伪装成功 payload。

## 4. 技术方案与文件清单

建议新增或调整：

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/hub_resp_inbound_02_parsed.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/hub_resp_chatprocess_03_governed.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/hub_resp_outbound_04_client_semantic.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/mod.rs`
- `tests/red-tests/hub_pipeline_response_type_topology_contract.test.ts`

类型只做最小字段包裹或透明 newtype，不复制响应解析、工具治理、servertool followup、client remap 业务语义。parser/projector 先保持语义透传，并通过命名表达相邻来源与目标。

## 5. 风险与规避

| 风险 | 规避 |
|---|---|
| 类型骨架变成第二套响应实现 | 只做透明封装，不复制解析/治理/remap 逻辑 |
| provider raw 被误认为可直达 client | 红测禁止 `ProviderRespInbound01 -> ServerRespOutbound05` shortcut |
| 响应错误被包装成成功 payload | 红测要求错误链 `Error*`，响应类型不承载 error success shim |
| metadata 泄漏到 client body | 类型和红测禁止 response payload metadata 字段 |

## 6. 测试计划

1. Jest red test：扫描旧命名、跨节点 shortcut、metadata/client body 泄漏模式。
2. Rust 定向测试：只跑 `hub_pipeline_types` response-side 相关测试。
3. `sharedmodule/llmswitch-core` build：确认 TS/Rust 壳层不破。
4. `git diff --check`：确认格式与空白。

## 7. 实施步骤

1. 阅读 `AGENTS.md` 与 `docs/design/pipeline-type-topology-and-module-boundaries.md`。
2. 在既有 `hub_pipeline_types/` 内追加 response-side 三段类型骨架。
3. 定义三类响应节点类型与相邻 parser/projector 壳。
4. 增加 response topology red test，先证明旧命名/shortcut 会红。
5. 接入最小导出，不改变现有运行流程。
6. 跑定向验证。
7. 更新 note/MEMORY/skill 中本阶段已验证结论。
8. 本地提交，不 push。

## 8. 完成定义

- 响应链三段类型骨架存在且命名正确。
- red test 覆盖旧命名、跨节点 shortcut、metadata/client body 泄漏模式。
- 现有响应流水线行为保持语义等价。
- 验证命令有明确通过证据。
- 本地 commit 完成，未 push。
