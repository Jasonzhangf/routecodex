# Codex Capability and Tool Filtering Audit Plan

## 1. 目标与验收标准

目标：查清 RouteCodex 是否在 Codex 的 MCP、browser use、computer use、node_repl、tool_search 等能力链路中做了错误过滤、错误能力声明或错误工具投影，并修复唯一真源，让 Codex 在真实会话中能稳定看到并调用应暴露的工具。

验收标准：
- 明确区分三类根因：`/v1/models` 能力声明缺失、Codex app/model capability 消费不匹配、RouteCodex 请求/响应工具链过滤或改写。
- 对比 `~/code/codex` 的真实能力消费代码，确认 Codex 需要哪些字段、哪些 thread/tool item 类型、哪些 MCP/browser/computer 配置要求。
- 用 `~/.rcc/codex-samples/.../ports/5520/...`、`~/.rcc/logs/server-5520.log` 或当前实际日志入口证明工具是否在 client request、provider request、provider response、client response 任一阶段被移除、降级或泄漏到文本。
- 若修代码，必须先有 red test / failing sample，再改唯一 owner，不能用 fallback、补丁式双路径或 silent drop。
- 修复后必须 build、全局安装、重启 5520，并用同入口真实 `/v1/responses` Codex 样本验证工具可见、可调用、无文本泄漏。

## 2. 范围与边界

In scope:
- RouteCodex `/v1/models` Codex-facing capability metadata。
- `modelProvider/capabilities/read` 与 Codex app capability 消费对齐。
- MCP namespace 工具、browser/computer/node_repl/tool_search/apply_patch 的请求声明、历史恢复、响应投影、文本泄漏 gate。
- 5520 live logs、codex samples、provider request/response/client response 快照。
- 与 `~/code/codex` 真实源码的 capability/tool contract 对比。

Out of scope:
- 不重构整个 Hub Pipeline。
- 不新增 provider-specific 分支。
- 不把 client-side MCP/browser/computer 逻辑搬进 provider runtime。
- 不用日志隐藏、文本清洗或 fallback 成功来掩盖工具缺失。

## 3. 设计原则

- `/v1/models` 是 Codex 模型级能力真源；RouteCodex 不能只靠 provider 级 capability 返回。
- Codex client/tool capability 属于客户端能力面；RouteCodex 只做协议等价传输、Hub 工具治理与响应投影，不重新发明工具系统。
- MCP/browser/computer 工具若应由 Codex 客户端执行，必须保留为 Codex 可识别的工具调用语义，不能被降级成普通文本。
- Bare MCP aggregator 与 child MCP tool 的过滤规则必须有明确 contract：只过滤已确认非法的 aggregator call/history，不得误删真实 child tool 或工具声明。
- 错误必须显式暴露；禁止把工具缺失包装成成功完成。

## 4. 技术方案与文件清单

优先查文档和 map：
- `AGENTS.md`
- `docs/agent-routing/05-foundation-contract.md`
- `docs/agent-routing/00-entry-routing.md`
- `.agents/skills/rcc-dev-skills/SKILL.md`
- `docs/design/codex-model-capability-contract.md`
- `docs/architecture/function-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/verification-map.yml`

RouteCodex 重点文件：
- `src/server/runtime/http-server/routes.ts`
- `src/server/runtime/http-server/middleware.ts`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/tool_surface_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics*`
- `tests/server/http-server/routes.invalid-json.spec.ts`
- 相关 MCP/tool/history Rust tests。

Codex 对比源码：
- `~/code/codex`
- 查找 `modelProvider/capabilities/read`
- 查找 `/v1/models` / `ModelInfo`
- 查找 `namespace_tools`
- 查找 `computerUse`
- 查找 `browser`
- 查找 `tool_search`
- 查找 `mcpServers`
- 查找 thread processor / model list / config requirements。

Live evidence：
- `~/.rcc/logs/server-5520.log`
- `~/.rcc/codex-samples/openai-responses/ports/5520/`
- 必要时用同入口 `/v1/responses` 最小真实请求生成 fresh sample。

## 5. 风险与规避

风险：把 Codex 客户端工具误当 provider wire tool。
规避：先对比 Codex source 与 RouteCodex provider-request，分别检查 client-visible tool declaration 与 provider wire payload。

风险：修在 handler/outbound，造成错层补丁。
规避：先锁 feature owner 和 mainline edge；工具治理默认回 Rust Hub Pipeline 或 `/v1/models` projection owner。

风险：只看本地测试，不证明真实 5520。
规避：build/install/restart 后用 live sample 和日志断言闭环。

风险：误删 MCP aggregator 的合法能力。
规避：红测同时覆盖 aggregator 非法 call 被过滤、child MCP tool 保留、browser/computer/tool_search 保留。

## 6. 测试计划

Red tests：
- `/v1/models` 对 `gpt-5.5`、provider-prefixed aliases 返回完整 Codex capability fields。
- Codex source 需要的 fields 在 RouteCodex `/v1/models` 不得缺失。
- MCP child tool、browser/computer/tool_search/tool_search_call 不被 inbound/history normalization 错误删除。
- 非法 MCP namespace aggregator call/history 被删除，且 matching output 同步删除。
- 工具调用不允许泄漏为普通 assistant text。

Green gates：
- `npm run verify:models-capability-contract`
- `npm run verify:function-map-compile-gate`
- 针对 MCP/tool normalization 的 Rust focused tests。
- 针对 response client projection 的 focused Jest/Rust tests。
- `npm run build:base`

Live verification：
- `ROUTECODEX_INSTALL_SKIP_BUILD=1 npm run install:global`
- `routecodex restart --port 5520`
- `curl -4fsS http://127.0.0.1:5520/health`
- 真实 `/v1/responses` 同入口样本验证：模型收到工具能力、返回可执行 tool call、客户端执行工具，不再出现工具调用文本泄漏或静默停止。

## 7. 实施步骤

1. 查 `function-map/mainline-call-map/verification-map`，锁 `/v1/models` capability owner 与 Hub tool governance owner。
2. 在 `~/code/codex` 中定位 Codex 实际消费的 capability fields、config requirements、thread tool 分类。
3. 对比 RouteCodex `/v1/models` live 输出与 Codex expected fields。
4. 从 5520 fresh sample 分阶段检查 client request、provider request、provider response、client response。
5. 若是能力声明缺失，修 `src/server/runtime/http-server/routes.ts` 和 capability contract tests。
6. 若是工具过滤错误，修 Rust Hub tool governance 唯一 owner，并补正反 tests。
7. 若是响应投影文本泄漏，修 Rust resp outbound client semantics owner，并补 gate。
8. 跑 focused tests、required gates、build。
9. 全局安装重启 5520，live replay 同入口样本。
10. 更新 `note.md`；若形成可复用经验，更新 `.agents/skills/rcc-dev-skills` lessons。

## 8. 完成定义

- 已证明真实根因，不再用“可能是过滤”作为结论。
- 代码只改唯一 owner，无 fallback、无双路径、无错层 handler 补丁。
- tests/gates/build/live 证据齐全。
- 5520 live 会话中 browser/computer/MCP/node_repl/tool_search 能力按 Codex contract 暴露，工具调用不再被清洗成文本或静默丢失。
- `note.md` 已记录根因、修复、验证和剩余风险。
