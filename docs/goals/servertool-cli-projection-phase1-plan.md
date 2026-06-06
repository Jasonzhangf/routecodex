# Servertool CLI Projection Phase 1 Plan

## 目标与验收标准

Phase 1 目标：保留当前 servertool 工具注入和响应侧拦截判定，完成 stopless 改造、基本 servertool 拦截骨架、servertool CLI 执行骨架，并把被拦截后的执行路径从私有 server-side handler execution + followup 改为客户端可见的标准 `exec_command` CLI 执行。

验收标准：

- stopless / stop-message migrated path 返回 reasoning + `exec_command` tool call。
- 基本 servertool 工具调用 migrated path 能投影为 `exec_command` CLI，不再由响应侧直接执行 handler。
- servertool CLI 骨架能读取 ticket、执行 dispatcher、输出标准 stdout/stderr/exit code。
- CLI 命令形态固定为 `routecodex servertool run --ticket <ticketId>`。
- `submit_tool_outputs` 能按 ticket 恢复原模型 tool call identity。
- CLI-projected path 不调用 `reenterPipeline`、`providerInvoker` 或旧 servertool followup。
- SSE 请求仍返回 SSE，不得变成 JSON。
- `apply_patch` 不进入 servertool CLI；继续 native/freeform 客户端工具链。

## 范围与边界

In scope：

- Phase 1 必须完成 stopless / `stop_message_auto` 的执行通路迁移。
- Phase 1 必须完成基本 servertool 工具调用的拦截骨架和 CLI 执行骨架。
- 新增 ticket-backed CLI projection 和 result restoration 的最小闭环。
- 新增红测、单元/黑盒测试、静态 gate。
- 更新必要 function map / verification map / skills 经验。

Out of scope：

- 不要求完成 `web_search`、`vision_auto`、`memory/cache_auto` 的完整业务迁移，但 Phase 1 必须提供通用 dispatcher 骨架和至少一个基本 servertool 工具执行样例/fixture。
- 不取消 servertool 工具注入。
- 不删除全部 legacy followup，只禁止 migrated path 进入 followup。
- 不改 provider runtime / direct passthrough 协议。
- 不把 `apply_patch` 做成 servertool。

## 设计原则

- Rust 是 Hub Pipeline / servertool governance 语义真源；TS 只做 CLI IO、ticket 文件 IO、HTTP/SSE 壳层。
- 不做 fallback：ticket 写入、读取、恢复失败必须 fail-fast。
- 不猜语义：只修 shape，call id / tool name 必须来自 ticket。
- 结果恢复不是 followup：客户端执行 `exec_command` 后通过正常 `submit_tool_outputs` 回来，再恢复为原模型 tool result。
- reasoning 是完整 summary/explanation carrier；CLI stdout 是短工具结果。
- 内部 metadata、ticket path、`__rt`、snapshot/debug carrier 不得进入 provider body 或 client body。

## 技术方案

权威设计文档：

- `docs/design/servertool-cli-projection-migration.md`
- `docs/agent-routing/30-servertool-lifecycle-routing.md`
- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`

新增/修改的关键契约：

- `ServertoolCliProjection01Planned`
- `ServertoolCliResult02Captured`
- `ServertoolCliResult03RestoredToolResult`
- `build_servertool_cli_projection_01_from_hub_resp_chatprocess_03`
- `capture_servertool_cli_result_02_from_submit_tool_outputs`
- `restore_servertool_cli_result_03_to_model_tool_result`
- `ServertoolCliExecution04Dispatched`
- `execute_servertool_cli_ticket_04`

建议文件范围：

- Rust contract / decision owner：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src`
- Servertool TS shell / ticket IO：`sharedmodule/llmswitch-core/src/servertool`
- CLI command shell：`src/commands` 或当前 RouteCodex CLI 命令入口实际 owner
- HTTP/SSE projection shell：`src/server/handlers`
- 禁止修改 provider-specific 逻辑：`src/providers/**`

Ticket 存储：

```text
~/.rcc/servertool/tickets/<ticketId>.json
~/.rcc/servertool/tickets/<ticketId>.consumed.json
```

Ticket 必须包含：

- `ticketVersion`
- `ticketId`
- `createdAt`
- `expiresAt`
- `entryEndpoint`
- `requestId`
- `responseId`
- `sessionId` / `conversationId` when available
- `clientTool.name=exec_command`
- `clientTool.callId`
- `modelTool.name`
- `modelTool.callId`
- `executor.kind`
- `executor.toolName`
- `executor.arguments`
- `executor.capabilities`
- `presentation.reasoningText`
- `presentation.stdoutPreview`

CLI dispatcher 最小形态：

```text
routecodex servertool run --ticket <ticketId>
  -> read/validate/consume ticket
  -> dispatch executor.kind/toolName
  -> execute local servertool function
  -> stdout JSON
  -> stderr diagnostics
  -> exit code
```

Phase 1 dispatcher 必须支持：

- `stop_message_auto` / stopless continuation
- 一个基本 servertool fixture executor，用于锁定普通 servertool tool-call execution shape

Phase 1 dispatcher 可以只为 `web_search`、`vision_auto`、`memory/cache_auto` 返回明确 unsupported/fail-fast，不能 silent noop。

## 风险与规避

| 风险 | 规避 |
|---|---|
| SSE 被 JSON 化 | 黑盒测试锁 `/v1/responses` stream path，断 `response.required_action` SSE event |
| 模型 tool call identity 丢失 | ticket 必填 `modelTool` + submit restoration 单测 |
| migrated path 仍走 followup | 静态 red test 禁止 migrated path 调用 reenter/providerInvoker |
| ticket 被复用 | consume atomic rename + consumed ticket 红测 |
| provider body 泄漏内部字段 | snapshot/blackbox 断 provider request 无 ticket path / metadata / `__rt` |
| apply_patch 被误纳入 servertool | registry/static test 断无 apply_patch servertool registration |
| 基本工具执行骨架没闭环 | fixture servertool CLI e2e 锁 projection -> CLI -> submit restoration |

## 测试计划

红测优先：

- `tests/servertool/servertool-cli-projection.spec.ts`
- `tests/servertool/servertool-cli-execution.spec.ts`
- `tests/servertool/servertool-cli-result-restore.spec.ts`
- `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`
- 更新 `tests/sharedmodule/servertool-active-js-shadow-audit.spec.ts` 锁 no-reenter/no-providerInvoker。

定向验证：

- projection 单测：stopless response -> reasoning + `exec_command`。
- ticket 单测：write/read/consume/expired/unknown/mismatched/single-use。
- CLI dispatcher 单测：stopless + fixture tool 成功执行；unsupported tool fail-fast。
- restoration 单测：`rcc_cli_*` -> original `modelTool.callId/name`。
- SSE 黑盒：stream=true 仍输出 SSE required_action，不返回 JSON。
- provider outbound snapshot：恢复后 provider request 不含 `rcc_cli_*` 和 ticket 内部字段。

构建与 smoke：

- `npm run build:min`
- `npm run verify:architecture-ci`
- 新增 tests 对应的 `npm run jest:run -- --runInBand --runTestsByPath ...`
- 10000 端口在线复测 stopless / servertool CLI projection 样本。

## 实施步骤

1. 先加红测：projection、ticket、restoration、SSE 黑盒、no-followup 静态 gate。
2. 增加 Rust contract 类型和 builder/parser，先让红测进入可定位失败。
3. 实现 ticket writer/reader/consumer，单测覆盖 TTL 与 single-use。
4. 实现 `routecodex servertool run --ticket <ticketId>` CLI shell。
5. 实现 servertool CLI dispatcher 骨架：stopless executor + 基本 fixture executor + unsupported fail-fast。
6. 在 response-side servertool orchestration 中为 stopless path 和基本 servertool tool-call path 生成 `ServertoolCliProjection01Planned`。
7. 在 resp outbound / handler projection 中输出 reasoning + `exec_command`。
8. 在 submit_tool_outputs 入站处捕获 `rcc_cli_*`，消费 ticket 并恢复原模型 tool result。
9. 禁止 migrated stopless path 和基本 migrated tool-call path 进入旧 followup/reenter。
10. 跑定向测试、build、architecture gate。
11. 全局安装重启后，用 10000 端口在线复测 stopless + 基本 servertool CLI execution，并检查 `~/.rcc/codex-samples/**`。
12. 把验证经验沉淀到 `.agents/skills/rcc-dev-skills/SKILL.md` 和 `note.md`。

## 完成定义

- Phase 1 migrated stopless flow 端到端可用：client 看见 reasoning + exec_command，CLI 执行后正常 submit，下一轮 provider request 使用原模型 tool result。
- Phase 1 基本 servertool tool-call flow 端到端可用：provider/model servertool call 被拦截投影为 exec_command，CLI dispatcher 执行后 submit 恢复为原模型 tool result。
- 所有新增红测先红后绿，并纳入 verification map。
- 10000 端口在线复测有样本证据。
- 无 provider-specific patch、无 fallback、无 apply_patch servertool 回归。
