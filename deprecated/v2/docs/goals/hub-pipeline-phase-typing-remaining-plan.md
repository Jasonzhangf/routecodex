# Hub Pipeline Phase Typing Remaining Plan

## 1. 目标与验收标准

目标：一次性完成 Hub Pipeline 类型拓扑后续阶段：Phase 3 VR/Provider 边界、Phase 4 Error/Metadata carrier 闭环、Phase 5 旧结构/旧命名物理删除计划与可安全删除项清理。整体仍以数据结构和边界锁为主，不改变现有路由选择、provider wire 输出、client response 行为。

验收标准：

1. Phase 3：`VrRoute04SelectedTarget`、`HubReqOutbound05ProviderSemantic`、`ProviderReqOutbound06WirePayload` 的边界存在且红测锁住 VR/provider shortcut。
2. Phase 4：`Meta*` 与 `Error*` carrier 的边界契约存在，metadata 不进入 provider wire / SDK options / client body，错误不伪装成成功 payload。
3. Phase 5：旧泛名 DTO/API/shortcut 的 residue audit 存在；只删除已证明安全的旧壳或新增错误壳，无法安全删除的旧实现必须形成删除清单，不假删。
4. 不改 native stage 顺序、不改 Virtual Router selection algorithm、不改 provider-specific encoder、不改 Server handler 行为。
5. 所有新增/调整均有定向红测、Rust/TS 构建或等价验证、`git diff --check` 证据。
6. 本地 commit 完成，不 push。

## 2. 范围与边界

### In Scope

- VR/provider 交界类型或 contract 骨架。
- Metadata / Error carrier 类型边界或 contract 骨架。
- 拓扑红测：VR 不修 payload、Provider 不重建 Hub 工具治理、metadata/error 不进正常 req/resp payload。
- residue audit：旧 `ReqProc` / `RespProc` / `req_process` / `resp_process` 新增禁令、非相邻转换、provider-specific Hub 分支。
- 可安全删除的旧错误壳或新误增文件。
- note/MEMORY/skill 更新与本地提交。

### Out of Scope

- 不改真实路由选择算法。
- 不改 provider wire body 语义。
- 不改 client response body 语义。
- 不做大规模目录重命名。
- 不删除仍在 live path 的旧实现。
- 不用 fallback/兼容双路径掩盖边界问题。

## 3. 设计原则

1. 类型边界优先，流程迁移后置。
2. 只允许相邻链路转换；跨节点 shortcut 必须红。
3. VR 只 route，不 patch payload、不治理 tools。
4. Provider Runtime 只 wire/auth/transport，不重建 Hub 工具治理。
5. Metadata 只能作为 `Meta*` carrier，生命周期限当前 request/response 闭环。
6. Error 必须进入 `Error*` 链，不得回写正常 req/resp payload。
7. 旧代码删除必须有证据；无法删除时写清原因和后续删除清单。

## 4. 技术方案与文件清单

建议新增或调整：

- `docs/goals/hub-pipeline-phase-typing-phase3-vr-provider-boundary-plan.md`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/` 中 VR/provider boundary wrapper 或 contract 类型。
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/` 中 selected target 类型边界或 contract。
- `src/providers/core/runtime/` 中 provider wire payload contract 或 red-test-only scan。
- `tests/red-tests/hub_pipeline_vr_provider_boundary_contract.test.ts`
- `tests/red-tests/hub_pipeline_meta_error_carrier_contract.test.ts`
- `tests/red-tests/hub_pipeline_type_residue_contract.test.ts`
- `.agents/skills/rcc-dev-skills/SKILL.md`
- `MEMORY.md`
- `note.md`

## 5. 风险与规避

| 风险 | 规避 |
|---|---|
| contract wrapper 变成第二套实现 | 只做透明 wrapper / scan，不复制 route/provider 逻辑 |
| 删除旧代码破坏 live path | 删除前必须 rg 调用图 + 定向测试；不确定则列入删除清单 |
| red test 误伤历史必要旧名 | 区分“新增旧名”和“历史 live path”，用路径/文件范围精准扫描 |
| metadata carrier 又被混入 payload | red test 扫 provider body、SDK options、client body、normal response payload |
| Error 链被绕过 | red test 禁止 success-wrapped error 与 error spread 到 req/resp body |

## 6. 测试计划

1. Jest red tests：VR/provider boundary、Meta/Error carrier、residue audit。
2. Rust 定向测试：`hub_pipeline_types` 与 Virtual Router selected-target 相关测试。
3. `npm run -s build --prefix sharedmodule/llmswitch-core` 或等价构建。
4. `git diff --check`。
5. 如改动触及 provider/server runtime，追加对应最小 Jest/HTTP 黑盒。

## 7. 实施步骤

1. 读取 `AGENTS.md`、拓扑文档、Phase 1/2 类型骨架与本计划。
2. Phase 3：建立 VR/provider boundary contract，新增红测并验证不改变 route/wire。
3. Phase 4：建立 Meta/Error carrier contract，新增 metadata/error 泄漏红测。
4. Phase 5：新增 residue audit，识别可安全删除项；只删除已证明安全的旧壳，剩余写删除清单。
5. 跑定向验证与构建。
6. 更新 note/MEMORY/skill。
7. 本地 commit，不 push。

## 8. 完成定义

- Phase 3/4/5 的 contract、red tests、验证证据齐全。
- 现有 route selection、provider wire、client response 语义等价。
- metadata/error 与 req/resp 正常 payload 隔离边界被红测锁住。
- 可安全删除项已清理；不可安全删除项有明确清单。
- 本地 commit 完成，未 push。
