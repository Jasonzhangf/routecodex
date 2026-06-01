# Hub Pipeline Typed Entrypoint Migration Plan

## 1. 目标与验收标准

目标：在已完成的类型拓扑 contract 基础上，规划下一阶段把 live path 逐步迁移到 typed entrypoints：`ReqInbound` / `ReqChatProcess` / `ReqOutbound` 与 `RespInbound` / `RespChatProcess` / `RespOutbound`。本计划只定义迁移顺序、红测门禁和删除条件，不直接改 runtime flow。

验收标准：

1. 明确第一批可迁移 entrypoint：优先 request-side typed entrypoints，再 response-side typed entrypoints。
2. 明确每个 entrypoint 的 owning function、输入类型、输出类型、禁止事项和验证门禁。
3. 明确旧 `req_process_*` / `resp_process_*` live path 的删除前置条件。
4. 明确本阶段仍不得改 route selection、provider wire、client response 语义。
5. 后续执行必须先红测锁旧直连，再迁移，再删除旧壳。

## 2. 范围与边界

### In Scope

- 规划 typed entrypoint migration 的阶段顺序。
- 定义 request-side 和 response-side typed entrypoints 的 owning wrapper。
- 定义 residue red tests：旧直连 import、跨节点 shortcut、旧泛名新增。
- 定义可删除项判定标准。
- 形成后续 `/goal` 可直接执行的任务边界。

### Out of Scope

- 本计划不改 Rust runtime 执行流。
- 不移动 `req_process_*` / `resp_process_*` live stage 实现。
- 不删除任何 live path 文件。
- 不改 provider encoder、Virtual Router selection、Server handler。
- 不做大规模目录重命名。

## 3. 迁移总原则

1. **Typed wrapper 先行**：先让 live path 调用 typed wrapper，wrapper 内部再调用现有实现。
2. **语义不复制**：typed wrapper 不重写业务逻辑，只承担相邻类型转换与边界校验。
3. **红测先红**：先新增 red test 禁止旧直连 import / shortcut，再迁移调用点。
4. **删除后置**：只有当 typed wrapper 成为唯一入口，旧直连 import 红测变绿后，才删除旧壳。
5. **验证等价**：每个迁移 slice 必须证明 provider wire / client response 语义等价。

## 4. 阶段拆分

### Phase 6A：Request typed entrypoint wrapper

目标：让 request live path 先经过 typed request wrapper，但不改变内部 stage 顺序。

候选 entrypoints：

- `run_hub_req_inbound_02_standardized_entrypoint`
- `run_hub_req_chatprocess_03_governed_entrypoint`
- `run_hub_req_outbound_05_provider_semantic_entrypoint`

输入输出：

- `HubReqInbound02Standardized -> HubReqChatProcess03Governed`
- `HubReqChatProcess03Governed -> VrRoute04SelectedTarget`
- `HubReqOutbound05ProviderSemantic -> ProviderReqOutbound06WirePayload`

禁止：

- 禁止改 `run_req_process_pipeline` 语义。
- 禁止 provider-specific patch 进入 Hub wrapper。
- 禁止 metadata object 进入 normal request payload。

验证：

- Rust request-side unit / existing hub pipeline request tests。
- topology red tests。
- provider wire snapshot / focused request blackbox where available。

### Phase 6B：Response typed entrypoint wrapper

目标：让 response live path 先经过 typed response wrapper，但不改变 provider raw parse、tool governance、client remap 语义。

候选 entrypoints：

- `run_hub_resp_inbound_02_parsed_entrypoint`
- `run_hub_resp_chatprocess_03_governed_entrypoint`
- `run_hub_resp_outbound_04_client_semantic_entrypoint`

输入输出：

- `HubRespInbound02Parsed -> HubRespChatProcess03Governed`
- `HubRespChatProcess03Governed -> HubRespOutbound04ClientSemantic`
- `HubRespOutbound04ClientSemantic -> ServerRespOutbound05ClientFrame`

禁止：

- 禁止 provider raw 直达 client frame。
- 禁止 success-wrapped error。
- 禁止 response payload / client body 承载 internal metadata。

验证：

- Rust response-side unit / existing response outbound tests。
- response topology red tests。
- focused SSE/JSON client response test where touched。

### Phase 6C：旧直连 import 红测与删除候选

目标：把旧 direct stage import 变成可检测 residue，并列出可删除候选。

红测禁止：

- 新增 `apply_req_process_tool_governance` 直连调用。
- 新增 `finalize_chat_response` 直连调用。
- 新增 `run_req_process_pipeline` 外部绕 typed wrapper 调用。
- 新增 `run_resp_process_*` 旧壳路径。

删除候选必须满足：

1. `rg` 调用图证明不再被 live path import。
2. typed wrapper 有等价测试覆盖。
3. red test 对旧直连 import 先红后绿。
4. Rust tests + build + relevant Jest 通过。

## 5. 风险与规避

| 风险 | 规避 |
|---|---|
| wrapper 变成第二套业务实现 | wrapper 只做 type boundary 和调用现有函数 |
| 一次迁移过大 | request 与 response 分 slice，先 request 再 response |
| 旧 live path 被误删 | 先调用图和红测，未证明前只列清单 |
| provider/client 语义漂移 | 每 slice 保留 snapshot/blackbox 或定向等价测试 |

## 6. 推荐执行顺序

1. Phase 6A-1：为 request-side 建 typed entrypoint wrapper，不切调用点。
2. Phase 6A-2：让一个最小 request live path 调用 typed wrapper，验证 wire 等价。
3. Phase 6B-1：为 response-side 建 typed entrypoint wrapper，不切调用点。
4. Phase 6B-2：让一个最小 response live path 调用 typed wrapper，验证 client response 等价。
5. Phase 6C：新增旧直连 import red test，形成可删除清单。
6. 后续 Phase 7：物理删除已证明安全的旧壳。

## 7. 完成定义

- typed entrypoint migration 的阶段、边界、验证和删除条件明确。
- 后续任务可以按 Phase 6A / 6B / 6C 拆成独立 `/goal` 执行。
- 当前文档不声明 runtime 已迁移，不声明旧 live path 可删除。
