# Hub Pipeline Phase Typing Phase 1 Plan

## 1. 目标与验收标准

目标：只为 Hub Pipeline 请求链建立 `inbound / chatprocess / outbound` 三段数据结构命名骨架与边界红测，不改变现有运行流程、不改变 provider wire 行为、不移动真实业务逻辑。

验收标准：

1. 新增或调整的类型名遵循 `docs/design/pipeline-type-topology-and-module-boundaries.md` 的 `<Module><Phase><NN><Node>`。
2. 第一阶段只覆盖请求链三段：`HubReqInbound02Standardized`、`HubReqChatProcess03Governed`、`HubReqOutbound05ProviderSemantic`。
3. 现有请求执行流程、native 调用顺序、provider payload 输出保持语义等价。
4. red test 能阻止新增旧命名 `ReqProc` / `req_process` 数据结构或跨节点 shortcut。
5. 不引入 fallback、不引入 provider-specific Hub 分支、不把 metadata 放入正常 req payload。

## 2. 范围与边界

### In Scope

- Hub Pipeline request-side 类型骨架。
- 相邻节点 builder/parser 的命名规范与最小壳。
- 架构 red test / residue scan。
- 必要的文档引用更新。

### Out of Scope

- 不改响应链实现。
- 不改 Virtual Router 选择逻辑。
- 不改 Provider Runtime wire 编码语义。
- 不改 HTTP handler 行为。
- 不做大规模文件重命名。
- 不删除旧实现，除非 red test 证明是本阶段新增的错误壳。

## 3. 设计原则

1. 先类型边界，后流程迁移。
2. 只允许相邻转换：`HubReqInbound02Standardized -> HubReqChatProcess03Governed -> HubReqOutbound05ProviderSemantic`。
3. `ChatProcess` 是工具治理语义，不允许退回泛化 `Process`。
4. metadata 只能走 `Meta*` carrier，不能进入 request 类型正文。
5. 旧名可以作为历史文件暂存，但不得新增旧名 API / DTO。

## 4. 技术方案与文件清单

建议新增或调整：

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/mod.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/hub_req_inbound_02_standardized.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/hub_req_chatprocess_03_governed.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/hub_req_outbound_05_provider_semantic.rs`
- `tests/red-tests/hub_pipeline_type_topology_contract.test.ts`

类型只做最小字段包裹或透明 newtype，不复制复杂业务语义。builder/parser 先保持语义透传，并通过命名表达相邻来源与目标。

## 5. 风险与规避

| 风险 | 规避 |
|---|---|
| 类型骨架变成第二套实现 | 只做透明封装，不复制治理逻辑 |
| 重命名误伤现有流程 | 不改入口调用顺序，不移动 native stage |
| red test 过宽误伤历史文件 | 只禁止新增旧命名结构/API，历史事实需白名单或按文件范围限制 |
| metadata 被顺手塞入类型 | 只允许引用 `Meta*` carrier id/scope，不承载 metadata object |

## 6. 测试计划

1. `node`/Jest red test：扫描新增旧命名、跨节点转换、metadata provider payload 泄漏模式。
2. Rust 定向测试：只跑 hub pipeline request-side 相关测试。
3. TypeScript build 或 llmswitch-core build：确认导出与壳层不破。
4. `git diff --check`：确认格式与空白。

## 7. 实施步骤

1. 阅读 `AGENTS.md` 与 `docs/design/pipeline-type-topology-and-module-boundaries.md`。
2. 建立 request-side `hub_pipeline_types/` 骨架。
3. 定义三类请求节点类型与相邻 builder/parser 壳。
4. 增加 topology red test，先证明旧命名/shortcut 会红。
5. 接入最小导出，不改变现有运行流程。
6. 跑定向验证。
7. 更新 note/MEMORY/skill 中本阶段已验证结论。
8. 本地提交，不 push。

## 8. 完成定义

- 第一阶段类型骨架存在且命名正确。
- red test 覆盖旧命名与跨节点 shortcut。
- 现有请求流水线行为未改。
- 验证命令有明确通过证据。
- 本地 commit 完成，未 push。
