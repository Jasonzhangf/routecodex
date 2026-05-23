# apply_patch 配置门控 servertool 实施计划

## 索引概要
- L1-L13 `purpose`：目标、真源与当前状态。
- L15-L42 `acceptance`：两模式验收标准。
- L44-L66 `scope`：范围与禁止项。
- L68-L103 `architecture`：分支架构与唯一修改层。
- L105-L158 `files`：预计文件清单与职责。
- L160-L238 `steps`：明确修改步骤。
- L240-L282 `tests`：验证矩阵与真实入口。
- L284-L308 `dod`：完成定义与唯一性说明。
- L310-L345 `goal-prompt`：可直接复制的 `/goal` 执行提示词。

## 目标与真源

目标：把 `apply_patch` 改为配置门控双模式：默认 `client` 兼容路线，显式 `servertool` 本地执行 + followup。

设计真源：

```text
docs/design/apply-patch-config-gated-servertool.md
```

当前状态：设计已定稿；实现必须按本文步骤推进，先红测/contract，再改实现，再构建安装和 10000 真实 smoke。不得宣称完成，直到 samples 与真实文件变化证明两模式均正确。

## 验收标准

### `client` 默认模式

- 未配置 `[servertool.apply_patch]` 或 `mode="client"` 时默认进入 client 模式。
- provider-request 中 `apply_patch` 不被改写为 `filePath/fileContent/patch`。
- provider-request 不含 hashline/internal line-edit guidance。
- provider-response 中的 `apply_patch` 不被 servertool dispatch 消费。
- client response 保留 `apply_patch` tool_call / required_action，由 client executor 执行。
- 没有 servertool followup。

### `servertool` 显式模式

- 配置 `mode="servertool"` 后，provider-facing `apply_patch` schema 为 `filePath` / `fileContent` / `patch`。
- provider-response 中 `apply_patch` 被 Hub/servertool 识别并本地执行。
- client 不收到已执行的 `apply_patch` tool_call / required_action。
- 成功时真实文件变化，followup 返回 `APPLY_PATCH_APPLIED`。
- 失败时 followup 返回 `APPLY_PATCH_FAILED` + reason，不伪造成成功。
- provider-facing 历史不泄露 Codex canonical patch 私有语法或客户端错误提示。

## 范围与禁止项

### In Scope

- 配置读取与默认值。
- runtime metadata 透传。
- Rust Hub request governance 的 `apply_patch` schema gate。
- Rust servertool dispatch 的 runtime gate。
- `apply_patch` servertool handler 本地执行。
- response outbound / history 的模式分支。
- Rust/Jest/10000/codex samples 验证。

### Out of Scope / 禁止项

- 不碰 Windsurf provider。
- 不在 provider 内实现 apply_patch 分支。
- 不做失败后 fallback 或自动切模式。
- 不保留 `mode` 与 `enabled` 双配置真源。
- 不把 hashline 作为当前用户可见主事实。
- 不伪造成功；servertool smoke 必须真实改文件。
- 不用 broad kill。

## 架构与唯一修改层

```text
config.toml
  |
  v
Config Loader
  - normalize servertool.apply_patch.mode = client | servertool
  - default = client
  - invalid value fail-fast
  |
  v
runtimeMetadata / adapterContext
  - __rt.applyPatch.mode
  |
  v
Hub Pipeline (Rust truth)
  |
  +-- client
  |     - request: 不改 apply_patch schema
  |     - response: 不 servertool 消费
  |     - outbound: 返回 client tool_call
  |     - history: 保持 client executor 原始事实
  |
  +-- servertool
        - request: schema 改为 filePath/fileContent/patch
        - response: servertool dispatch 消费 apply_patch
        - execute: 本地修改文件
        - followup: 返回结构化结果给模型
        - outbound: client 不收到已执行 apply_patch
```

唯一分支位置：

```text
config -> runtimeMetadata -> Hub request governance + servertool dispatch + response outbound/history
```

## 预计文件清单与职责

### 配置与 metadata

- `src/config/user-config-loader.ts`
  - 允许 `[servertool.apply_patch]`。
  - 校验 `mode` 只能是 `client|servertool`。
- `src/config/virtual-router-builder.ts`
  - 把 top-level `servertool.apply_patch.mode` 传入 virtual router/runtime config。
- `src/config/toml-commented-template.ts`
  - 增加默认示例。
- `sharedmodule/llmswitch-core/src/router/virtual-router/types.ts`
  - 声明 `applyPatch.mode`。
- `sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.ts`
  - 规范化 mode 并送入 native bootstrap。
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/config_bootstrap.rs`
  - Rust 侧默认值与非法值 fail-fast。
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline.rs`
  - 把 `applyPatch` 写入 `__rt` metadata。

### Hub / servertool

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance.rs`
  - 仅 `mode=servertool` 改写 `apply_patch` schema。
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs`
  - dispatch planner 接收 runtime metadata。
  - 仅 `mode=servertool` 允许 apply_patch servertool。
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_skeleton_config.rs`
  - 注册 apply_patch internal tool spec；执行仍受 runtime gate 控制。
- `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts`
  - 注册 handler，并把 runtime metadata 传入 dispatch。
- `sharedmodule/llmswitch-core/src/servertool/execution-shell.ts`
  - dispatch plan input 携带 runtime metadata。
- `sharedmodule/llmswitch-core/src/servertool/handlers/apply-patch.ts`
  - TS 薄壳 handler，调用 native/Rust 或最小本地 executor。
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics.rs`
  - servertool 模式 strip 已执行 apply_patch；client 模式不 strip。
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs`
  - servertool 模式防历史污染；client 模式不清洗。

### 测试

- `tests/sharedmodule/apply-patch-chat-process-contract.spec.ts`
  - 两模式 contract。
- Rust crate tests
  - request governance / dispatch gate / config bootstrap / response history。
- 10000 smoke 脚本或手工记录
  - 证明真实文件变化与 client required_action 分支。

## 明确修改步骤

### Phase 0：冻结事实与保护边界

1. 读：`AGENTS.md`、`.agents/skills/rcc-dev-skills/SKILL.md`、本设计文档、本计划。
2. `git status --short`，确认不改、不 restore、不提交 Windsurf provider 文件。
3. 查现有 codex samples，记录 apply_patch 失败/污染现象作为红测依据。
4. 在 `note.md` 记录开始状态与约束。

### Phase 1：先补红测

1. Rust request governance：
   - default/client 不改写 schema。
   - servertool 改写为 `filePath/fileContent/patch`。
2. Rust dispatch：
   - client 跳过 apply_patch servertool。
   - servertool 允许 apply_patch servertool。
3. Jest contract：
   - client response 返回 apply_patch 给 client。
   - servertool response 不返回 apply_patch 给 client。
4. 失败 handler 测试：
   - content mismatch / invalid patch / path outside workspace 返回 `APPLY_PATCH_FAILED`。

### Phase 2：配置读取与透传

1. 允许 `[servertool.apply_patch] mode="client|servertool"`。
2. 默认未配置为 `client`。
3. 非法 mode fail-fast。
4. 把 mode 透传为 `__rt.applyPatch.mode`。
5. 补 config bootstrap/loader 测试。

### Phase 3：client 模式恢复兼容路线

1. 找出所有 apply_patch schema/guidance 改写点。
2. 给改写点加 `mode=servertool` gate。
3. client 模式下禁止出现 `fileContent`、internal line-edit、hashline guidance。
4. response/outbound 不能吞掉 client 的 apply_patch。

### Phase 4：servertool dispatch

1. servertool skeleton 注册 apply_patch。
2. dispatch input 接收 runtime metadata。
3. dispatch planner 仅在 `mode=servertool` 时消费 apply_patch。
4. client 模式 skipped reason 可记录为 `apply_patch_client_mode`，但不能影响 outbound 给 client。

### Phase 5：servertool handler 本地执行

1. handler 解析 `filePath`、`fileContent`、`patch`。
2. path 解析为 workspace-relative，禁止越界。
3. 校验当前文件内容与 `fileContent` 一致。
4. 执行 line-edit patch。
5. 成功返回 `APPLY_PATCH_APPLIED`。
6. 失败返回 `APPLY_PATCH_FAILED` + reason + nextAction。

### Phase 6：response/outbound/history

1. servertool 模式：已执行 apply_patch 不返回 client。
2. servertool 模式：结果 followup 回模型。
3. servertool 模式：provider-facing history 不含 Codex canonical patch / client executor 错误提示。
4. client 模式：不启用上述清洗。

### Phase 7：构建安装与真实验证

1. Rust targeted tests。
2. Jest targeted tests。
3. `npm run build:min`。
4. `npm run install:global`。
5. 重启 10000 端口；禁止 broad kill，只用项目允许的服务/端口重启方式。
6. 10000 `client` mode smoke。
7. 10000 `servertool` mode smoke。
8. 查 codex samples，证明两模式没有混线。

## 验证矩阵

| 层级 | 模式 | 必须证明 |
|---|---|---|
| Rust unit | client | request governance 不改写 apply_patch schema |
| Rust unit | servertool | request governance 改写为 `filePath/fileContent/patch` |
| Rust unit | client | dispatch 不消费 apply_patch |
| Rust unit | servertool | dispatch 消费 apply_patch |
| Rust unit | servertool | handler 成功/失败结构化输出 |
| Rust unit | servertool | 越界路径 fail-fast |
| Jest contract | client | outbound 返回 client apply_patch tool_call |
| Jest contract | servertool | outbound strip 已执行 apply_patch |
| Jest contract | servertool | followup 包含 `APPLY_PATCH_APPLIED/FAILED` |
| Config test | both | 默认 client，非法值 fail-fast |
| Build | both | `npm run build:min` 通过 |
| Install | both | `npm run install:global` 通过 |
| Live 10000 | client | client executor 收到 apply_patch |
| Live 10000 | servertool | 本地文件真实变化，client 不收到 apply_patch |
| codex samples | both | request/response/followup 与 mode 一致 |

推荐命令（可按实际脚本名调整）：

```bash
cd sharedmodule/llmswitch-core/rust-core
cargo test -p router-hotpath-napi apply_patch -- --nocapture
cargo test -p router-hotpath-napi servertool -- --nocapture
cd /Users/fanzhang/Documents/github/routecodex
npm run jest:run -- --runTestsByPath tests/sharedmodule/apply-patch-chat-process-contract.spec.ts --runInBand --forceExit --testTimeout=120000 --no-cache
npm run build:min
npm run install:global
```

真实 smoke 后必须检查 samples：

```text
~/.rcc/codex-samples/openai-responses
/Volumes/extension/.rcc/codex-samples/openai-responses
```

## 完成定义 DoD

- 设计文档与实现计划一致。
- `client` 与 `servertool` 两模式都有红测转绿。
- 配置默认 client、非法值 fail-fast。
- 构建、全局安装、10000 真实验证通过。
- codex samples 能证明两模式没有混线。
- `note.md`、`MEMORY.md`、`.agents/skills/rcc-dev-skills/SKILL.md` 更新当前事实。
- summary 必须说明唯一性：分支只能在 Hub Pipeline/servertool 做，不能放 provider；这是因为 provider 不拥有 client executor/servertool followup/history 污染治理的全链路语义。

## /goal 执行提示词

```text
/goal
目标：实现 apply_patch 配置门控双模式：默认 client 兼容路线；显式 servertool 时由 RouteCodex 本地执行 apply_patch 并 followup，client 不收到已执行的 apply_patch。

实现文档：
- docs/design/apply-patch-config-gated-servertool.md
- docs/goals/apply-patch-config-gated-servertool-plan.md

执行规范：
- 只改 Hub Pipeline / servertool / config 链路；禁止触碰 Windsurf provider。
- 不做 fallback：mode=client 与 mode=servertool 由配置固定决定，失败不得自动切换。
- 默认必须是 client；非法配置 fail-fast。
- 先红测/contract，再实现；修改后必须自己构建、安装、重启 10000 并做真实 smoke。
- 禁止 broad kill；重启只能用项目允许的端口/服务 scoped 方式。

验证：
- Rust targeted tests：apply_patch、servertool、config bootstrap、response/history。
- Jest contract：tests/sharedmodule/apply-patch-chat-process-contract.spec.ts 及相关 servertool tests。
- npm run build:min。
- npm run install:global。
- 10000 端口 client/servertool 两模式真实 smoke。
- 检查 ~/.rcc/codex-samples/openai-responses 与 /Volumes/extension/.rcc/codex-samples/openai-responses，证明两模式没有混线。

完成标准：
- client 模式 provider-request 不含 fileContent/internal/hashline guidance，apply_patch 返回 client executor。
- servertool 模式 provider-request 使用 filePath/fileContent/patch，本地文件真实变化，followup 返回 APPLY_PATCH_APPLIED/FAILED，client 不收到已执行 apply_patch。
- 文档、skills、MEMORY/note 更新，并在 summary 给出唯一性论证与验证证据。
```
