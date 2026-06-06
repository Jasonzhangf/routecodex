# Servertool CLI Projection Phase 1 Plan

## 目标与验收标准

Phase 1 目标：保留当前 servertool 工具注入和响应侧拦截判定，完成 stopless 改造、基本 servertool 拦截骨架、servertool CLI 执行骨架，并把被拦截后的执行路径从私有 server-side handler execution + followup 改为客户端可见的标准 `exec_command` CLI 执行。

验收标准：

- stopless / `stop_message_auto` migrated path 返回 reasoning + `exec_command` tool call。
- 基本 servertool 工具调用 migrated path 能投影为 `exec_command` CLI，不再由响应侧直接执行 handler。
- CLI 命令形态固定为 `routecodex servertool run <toolName> --input-json <json>`。
- 客户端执行 CLI 后，通过普通客户端工具结果回传；不恢复为内部 servertool/model tool identity。
- CLI-projected path 不调用 `reenterPipeline`、`providerInvoker` 或旧 servertool followup。
- SSE 请求仍返回 SSE，不得变成 JSON。
- provider request/client body 不泄漏 `metadata`、`__rt`、snapshot/debug carrier 或 old CLI restoration markers。
- `apply_patch` 不进入 servertool CLI；继续 native/freeform 客户端工具链。

## 范围与边界

In scope：

- Phase 1 必须完成 stopless / `stop_message_auto` 的执行通路迁移。
- Phase 1 必须完成基本 servertool 工具调用的拦截骨架和 CLI 执行骨架。
- 新增 direct CLI projection 的最小闭环。
- 新增红测、单元/黑盒测试、静态 gate。
- 更新 function map / verification map / skills 经验。

Out of scope：

- 不要求完成 `web_search`、`vision_auto`、`memory/cache_auto` 的完整业务迁移，但 dispatcher 必须对 unsupported 工具 fail-fast。
- 不取消 servertool 工具注入。
- 不删除全部 legacy followup，只禁止 migrated path 进入 followup。
- 不改 provider runtime / direct passthrough 协议。
- 不把 `apply_patch` 做成 servertool。
- 不做 旧 restoration 文件、single-use restoration handles、old CLI restoration、内部 model tool identity 恢复。

## 设计原则

- Rust 是 Hub Pipeline / servertool governance 语义真源；TS 只做 CLI IO、HTTP/SSE 壳层。
- 不做 fallback：CLI dispatcher unsupported、shape invalid、执行失败必须 fail-fast。
- 不猜语义：Phase 1 的 CLI 执行结果保持标准 `exec_command` 客户端工具结果，不从结果文本恢复内部 tool identity。
- migrated path 不是 followup：response-side 只投影 `exec_command`，客户端执行后由普通请求链继续。
- reasoning 是完整 summary/explanation carrier；CLI stdout 是短工具结果。
- 内部 metadata、`__rt`、snapshot/debug carrier 不得进入 provider body 或 client body。

## Target Protocol

```text
ProviderRespInbound01Raw
  -> HubRespInbound02Parsed
  -> HubRespChatProcess03Governed
  -> ServertoolCliProjection01Planned
  -> HubRespOutbound04ClientSemantic
  -> ServerRespOutbound05ClientFrame
       emits:
         - reasoning item/event with full summary or action explanation
         - exec_command tool_call:
             routecodex servertool run <toolName> --input-json <json>
  -> Codex client executes command
  -> client submits normal exec_command tool result
  -> HubReqInbound02Standardized
  -> normal request pipeline
```

## CLI Contract

### Command Shape

```bash
routecodex servertool run <toolName> --input-json <json>
```

Rules：

- `<toolName>` 只能是安全 token：`[A-Za-z0-9_.-]+`。
- `--input-json` 必须是 JSON object。
- CLI stdout 是客户端工具结果，优先 JSON。
- CLI stderr 只放诊断；非零 exit 表示工具失败。
- 不写 旧 restoration 文件，不读 旧 restoration 文件，不消费 old restoration，不输出 old restoration marker。

Phase 1 dispatcher 必须支持：

- `stop_message_auto` / stopless continuation。
- `servertool_fixture` 基本执行样例。

Phase 1 dispatcher 对其它工具必须明确 unsupported/fail-fast，不能 silent noop。

## Reasoning Mapping

| Source | Reasoning content | CLI stdout |
|---|---|---|
| `finish_reason=stop` summary | Full stop summary / continuation reason | Short continuation JSON |
| `servertool_fixture` | Intercept explanation | JSON fixture result |
| Unsupported servertool | Error explanation if client-visible | CLI non-zero + stderr/stdout error JSON |

Reasoning 不得包含 provider internal metadata、`__rt`、snapshot/debug carrier、old restoration path 或 old restoration-style marker。

## Tool Classification

| Tool / flow | Phase 1 action | CLI? | Notes |
|---|---:|---:|---|
| `stop_message_auto` / stopless | Project to `exec_command` | Yes | Full summary as reasoning; CLI prints short continuation result |
| `servertool_fixture` | Project to `exec_command` | Yes | Basic fixture proving generic intercepted path |
| `vision_auto` | Unsupported fail-fast until migrated | No business migration | No silent noop |
| `web_search` | Unsupported fail-fast until migrated | No business migration | No silent noop |
| `memory/cache_auto` | Unsupported fail-fast until migrated | No business migration | No silent noop |
| `apply_patch` | No servertool path | No | Keep native/freeform client apply_patch |
| normal client tools | No interception change | No | Pass through as today |

## 测试计划

红测优先：

- `tests/servertool/servertool-cli-projection.spec.ts`：projection 命令必须是 direct CLI，不含 old restoration markers。
- `tests/servertool/servertool-cli-execution.spec.ts`：dispatcher 支持 stopless + fixture，unsupported fail-fast。
- `tests/servertool/servertool-cli-result-restore.spec.ts`：锁定不使用 old CLI restoration。
- `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`：SSE 不变 JSON，输出 `exec_command`，无 old restoration/internal marker 泄漏。
- `tests/sharedmodule/servertool-active-js-shadow-audit.spec.ts`：no-reenter/no-providerInvoker/no-restoration 静态 gate。

定向验证：

- projection 单测：stopless response -> reasoning + `exec_command`。
- CLI dispatcher 单测：stopless + fixture tool 成功执行；unsupported tool fail-fast。
- direct submit contract：不捕获 `old_cli_result_*`，不恢复原模型 tool identity。
- SSE 黑盒：stream=true 仍输出 SSE tool_call，不返回 JSON。
- provider outbound snapshot：provider request 不含 old restoration marker、metadata、`__rt`。
- apply_patch exclusion：无 apply_patch servertool registration。

构建与 smoke：

- `npm run build:min`
- `npm run verify:architecture-ci`
- 定向 `npm run jest:run -- --runInBand --runTestsByPath ...`
- 全局安装重启后，用 10000 端口在线复测 stopless / servertool CLI projection 样本。

## 实施步骤

1. 先加红测：direct projection、dispatcher、SSE 黑盒、no-followup/no-restoration 静态 gate。
2. 删除 old restoration 文档和代码路径，确保没有 旧 restoration 文件 IO。
3. 实现/保留 `routecodex servertool run <toolName> --input-json <json>` CLI shell。
4. 实现 dispatcher 骨架：stopless executor + fixture executor + unsupported fail-fast。
5. 在 response-side servertool orchestration 中为 stopless path 和基本 servertool tool-call path 生成 `ServertoolCliProjection01Planned`。
6. 在 resp outbound / handler projection 中输出 reasoning + `exec_command`。
7. 禁止 migrated stopless path 和基本 migrated tool-call path 进入旧 followup/reenter。
8. 跑定向测试、build、architecture gate。
9. 全局安装重启后，用 10000 端口在线复测 stopless + 基本 servertool CLI execution，并检查 `~/.rcc/codex-samples/**`。
10. 把验证经验沉淀到 `.agents/skills/rcc-dev-skills/SKILL.md` 和 `note.md`。

## 完成定义

- Phase 1 migrated stopless flow 可用：client 看见 reasoning + `exec_command`，CLI 执行后作为普通 `exec_command` 工具结果回传。
- Phase 1 基本 servertool tool-call flow 可用：provider/model servertool call 被拦截投影为 `exec_command`，CLI dispatcher 执行后返回标准客户端工具结果。
- 没有 old CLI restoration 代码/文档/测试残留。
- 所有新增红测先红后绿，并纳入 verification map。
- 10000 端口在线复测有样本证据。
- 无 provider-specific patch、无 fallback、无 apply_patch servertool 回归。
