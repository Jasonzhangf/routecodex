# Hub Pipeline Phase Typing Phase 3 VR Provider Boundary Plan

## 1. 目标与验收标准

目标：为 Hub Pipeline 与 Virtual Router / Provider Runtime 的交界建立类型命名骨架与红测边界，只固定 `VrRoute04SelectedTarget`、`HubReqOutbound05ProviderSemantic`、`ProviderReqOutbound06WirePayload` 的接口关系，不改变现有路由选择、provider wire 输出或 runtime transport 行为。

验收标准：

1. 新增类型名遵循 `docs/design/pipeline-type-topology-and-module-boundaries.md` 的 `<Module><Phase><NN><Node>`。
2. Virtual Router 只消费 `HubReqChatProcess03Governed` 风格的 governed request，不新增 payload patch / tool governance 语义。
3. Provider Runtime 只消费 outbound/provider wire 类型边界，不从 inbound/raw/client payload 或 metadata.context 构造 provider body。
4. red test 能阻止 Hub/Vr 直造 provider wire、VR 写 provider payload patch、Provider Runtime 重建 Hub 工具治理、metadata 进入 provider wire body。
5. 不引入 fallback、不改 route selection、不改 provider request body 语义。

## 2. 范围与边界

### In Scope

- Virtual Router selected target 类型骨架或命名对齐。
- Provider request outbound wire payload 类型骨架或命名对齐。
- Hub outbound provider semantic 与 VR/provider 交界 red test。
- 必要的文档与 skill 记忆更新。

### Out of Scope

- 不改 Virtual Router selection algorithm。
- 不改 provider-specific request encoder 输出。
- 不改 health/quota/cooldown 逻辑。
- 不改 HTTP server executor 行为。
- 不做 provider runtime 大规模重命名。
- 不删除旧实现，除非 red test 证明是本阶段新增的错误壳。

## 3. 设计原则

1. Phase 3 仍是类型边界，不是流程迁移。
2. VR 只产出 target/decision，不改 payload、不治理 tools。
3. Provider Runtime 只负责 provider protocol wire/auth/transport，不承担 Hub 工具治理。
4. metadata 只能通过 `Meta*` carrier 影响控制语义，不得进入 provider wire body / SDK options。
5. 只允许相邻关系：`HubReqChatProcess03Governed -> VrRoute04SelectedTarget -> HubReqOutbound05ProviderSemantic -> ProviderReqOutbound06WirePayload`。

## 4. 技术方案与文件清单

建议新增或调整：

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/` 下的 selected target 类型骨架或现有类型命名对齐说明。
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/` 中必要的 route/outbound 接口 wrapper。
- `src/providers/core/runtime/` 中 provider wire payload 类型边界或 red-test-only contract。
- `tests/red-tests/hub_pipeline_vr_provider_boundary_contract.test.ts`

优先用透明 wrapper / contract scan，不复制 route selection 或 provider encoding 逻辑。

## 5. 风险与规避

| 风险 | 规避 |
|---|---|
| VR 类型骨架变成第二套路由器 | 只表达 selected target，不复制 selection algorithm |
| Provider 类型骨架改变 wire body | 透明 wrapper；验证 provider wire 输出不变 |
| metadata 又被塞进 provider body | red test 扫 provider wire builder 与 SDK options |
| Hub 写 provider-specific 分支 | red test 扫 Hub Pipeline / VR provider-specific token |

## 6. 测试计划

1. Jest red test：扫描 VR payload patch、Hub/Vr provider wire shortcut、provider metadata leak、provider-specific Hub 分支。
2. Rust 定向测试：`hub_pipeline_types` 与 Virtual Router selected target 相关测试。
3. `sharedmodule/llmswitch-core` build。
4. `git diff --check`。

## 7. 实施步骤

1. 阅读 `AGENTS.md`、拓扑文档和 Phase 1/2 类型骨架。
2. 审计现有 VR selected target 与 provider request builder 类型落点。
3. 新增最小边界类型或 contract wrapper，不接入真实选择/编码流程。
4. 增加 VR/provider boundary red test。
5. 跑定向验证。
6. 更新 note/MEMORY/skill 中已验证结论。
7. 本地提交，不 push。

## 8. 完成定义

- VR/provider 交界类型或 contract 骨架存在且命名正确。
- red test 锁住 VR 不修 payload、Provider 不重建 Hub 工具治理、metadata 不进 provider wire。
- 现有路由选择与 provider wire 输出保持语义等价。
- 验证命令有明确通过证据。
- 本地 commit 完成，未 push。
