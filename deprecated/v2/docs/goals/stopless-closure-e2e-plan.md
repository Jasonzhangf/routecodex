# Stopless 闭环修复与端到端验证计划

## 1. 目标

把 stopless 收口成一个可验证、可上线复测、可抗异常分支的唯一闭环，实现以下结果：

1. 请求侧固定注入停止契约，模型在结束时明确知道必须提供结束 summary 与 stop schema。
2. 响应侧无条件拦截 `finish_reason=stop`，统一走 stop gate / schema gate / terminal filter。
3. 缺 schema、非法 schema、`stopreason=2`、budget exhausted、合法终止都走同一 Rust 真源，不允许多处分流。
4. stopless followup 只能命中 thinking 路由；direct 路径不得激活 stopless。
5. 非终态 stop 必须自动改写为客户端可见 CLI/tool call；下一轮模型看到的是文本引导，不是它自己误调用工具的历史。
6. 端到端验证必须覆盖普通成功路径、恢复路径、连续失败路径、异常路径、协议污染路径。

## 2. 验收标准

必须同时满足：

1. stopless 闭环语义唯一 owner 在 Rust，请求/响应/CLI/restore 没有第二套等价实现。
2. 系统提示词或等价 request-side system instruction 明确包含：
   - 结束时要给 summary
   - 结束时要给 stop schema
   - `stopreason=0/1/2` 的含义
3. 响应侧 `finish_reason=stop` 被统一拦截；合法终止时过滤 schema，非合法终止时统一投影 CLI/tool call。
4. `NoSchema -> InvalidSchema -> NonTerminalSchema -> BudgetExhausted -> SchemaPass` 全部分支都有红测、绿测、反向测试。
5. stopless followup 命中 thinking 路由，且不再带 `search/tools/old routeHint` 污染。
6. direct path 不激活 stopless；relay path 激活 stopless；两者边界有 gate 锁死。
7. 至少完成一组真实 `/v1/responses` + 恢复轮次端到端验证，并记录 request id / response id / 日志证据。
8. 意外情况不会死循环，不会污染历史，不会把内部 stopless/schema/runtime metadata 泄漏给客户端或下游 provider。

## 3. 范围与边界

### In Scope

1. `stop_message_auto` request injection / response intercept / CLI projection / request restore。
2. `finish_reason=stop` gate、schema gate、terminal visible payload filter。
3. relay stopless 生命周期与 routing。
4. `/v1/responses` 与 `/v1/responses/{id}/submit_tool_outputs` 的 stopless 恢复链。
5. 用户可见 payload 的 schema/control text 清理。
6. 红测、gate、live sample replay、端到端 smoke。

### Out of Scope

1. 与 stopless 无关的 apply_patch、responses outbound 全量协议审计。
2. 与 stopless 无关的 provider fallback、quota、冷却、错误链收口。
3. 非 stopless 的 servertool 流程，除非本次闭环必须触及共享 owner。

## 4. 设计原则

1. 单一路径真源：`req_chatprocess -> resp_chatprocess -> cli projection -> req restore`。
2. 不做 fallback；发现 owner 错位就物理删除错误实现。
3. direct 不做 stopless，不做透明 reenter，不做请求修补。
4. relay 才允许 stopless，且客户端看到工具执行，模型看到文本引导。
5. stop schema 属于控制语义，合法终止时必须从可见输出与后续历史中剥离。
6. 计数、状态、trigger 解释统一使用 `used/maxRepeats/left/action/reasonCode`，不用口语轮次做真相。

## 5. 当前已知缺口

1. request-side 没有把“结束 summary + stop schema”收口到明确 system instruction owner。
2. 当前主流程对 `NoSchema / InvalidSchema / NonTerminalSchema` 的 trigger 使用仍不够精细，存在压平成 `NoSchema` 的风险。
3. terminal filter 已存在，但“stop 拦截 -> trigger 分类 -> terminal strip / cli projection”还没有完全在单点统一。
4. stopless followup 虽已有 thinking gate，但还要确认不同入口、不同旧 routeHint、不同恢复轮次下都成立。
5. 要补异常路径：非法 schema、字段缺失、解析失败、重复 stop、restore 历史缺失、旧 session 污染、stream path。

## 6. 技术方案

### 6.1 Request-side 单点收口

Owner 目标：

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/*`

要求：

1. stopless 管理回合无条件注入同一个 stop hook/tool contract。
2. 同时把结束规则写入唯一 system instruction：
   - 何时允许停止
   - 停止必须提供 summary + stop schema
   - schema 必填字段
3. 不把内部词汇（servertool/stopless/hook）泄漏成模型可见 proxy 感知，除非这是明确的工具 schema。

### 6.2 Response-side 单点收口

Owner 目标：

- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_gateway_context.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_orchestration_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_visible_text.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs`

要求：

1. 统一拦截 `finish_reason=stop`。
2. 分类输出：
   - `no_schema`
   - `invalid_schema`
   - `non_terminal_schema`
   - `schema_pass_terminal`
   - `budget_exhausted`
3. `schema_pass_terminal`：
   - 保持 `finish_reason=stop`
   - 过滤 schema/control text
   - 提炼 summary/learning/reasoning 到合法可见位置
4. 其他非终态：
   - 改写为客户端可见 tool call / CLI projection
   - 不允许直接原样 stop 出去

### 6.3 CLI / 恢复闭环

要求：

1. 客户端看到的是 `exec_command`/官方工具调用。
2. 自动补打的 stopless CLI 结果在下一请求必须改写为文本注入。
3. 模型主动调用 stop hook 的历史保留；系统自动补打的不保留为模型自有 tool history。
4. CLI 输出必须包含：
   - continuation prompt
   - schema guidance
   - 当前 trigger 对应的修正指导

### 6.4 Routing 与 direct/relay 边界

要求：

1. relay stopless followup 强制回 thinking。
2. 清理旧 `routeHint`，不得遗留 `search/tools` 等历史污染。
3. direct path 命中 stop 时必须 passthrough，不得进入 stopless。

### 6.5 异常与意外情况治理

必须覆盖：

1. 缺 schema。
2. schema 非法 / 字段类型错 / JSON 解析失败。
3. `stopreason=2` 但 `next_step` 缺失或为空。
4. 连续 3 次缺失 schema。
5. 连续 3 次非法 schema 或 continue-needed。
6. 合法 stop 后计数 reset。
7. 非 stop / 工具调用后计数 reset。
8. 恢复轮次历史丢失或 previous id/context 不命中。
9. stream=true 与 stream=false 行为不一致。
10. 客户端关闭流 / 中途断流。
11. schema/control text 泄漏进 response outbound 或下轮 request history。

## 7. 测试计划

### 7.1 Rust 白盒

至少补齐：

1. stop trigger 分类红测。
2. terminal strip 红测。
3. `NoSchema / InvalidSchema / NonTerminalSchema / BudgetExhausted / SchemaPass` 正反测试。
4. direct disabled / relay enabled 测试。
5. routeHint 清理与 thinking 路由测试。

建议命令：

- `cargo test -p servertool-core stopless --lib -- --nocapture`
- `cargo test -p router-hotpath-napi stop_message --lib -- --nocapture`

### 7.2 TS/Native 定向黑盒

至少补齐：

1. `tests/servertool/stopless-cli-continuation.spec.ts`
2. 新增/补强：
   - system instruction 注入合同
   - direct 不激活
   - terminal schema strip
   - auto-injected CLI result -> text guidance
   - invalid schema / no schema / non-terminal 分支
   - used=0 -> 1 -> 2 -> 3

### 7.3 Project blackbox / handler blackbox

至少补齐：

1. `/v1/responses` 首轮 stopless。
2. `/v1/responses/{id}/submit_tool_outputs` 恢复继续 stopless。
3. 恢复轮次合法 stop。
4. budget exhausted 终止。
5. stream / non-stream 等价。

### 7.4 Live / E2E

必须有真实端到端：

1. build + install + restart。
2. 新 session 首轮 stopless。
3. 恢复轮次继续。
4. 恢复轮次合法终止。
5. 连续 3 次缺失或非法 schema 的强制收口。
6. 日志验证 thinking 路由、计数推进、无 schema 泄漏。

证据必须记录：

1. request id
2. response id
3. tool call id
4. server log 片段
5. client/provider sample 文件

## 8. 验证矩阵

最低 gates：

1. `cargo test -p servertool-core stopless --lib -- --nocapture`
2. `cargo test -p router-hotpath-napi stop_message --lib -- --nocapture`
3. `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-cli-continuation.spec.ts --runInBand`
4. stopless 新增的 request/response/blackbox suites
5. `npm run verify:servertool-rust-only`
6. `npm run verify:function-map-compile-gate`
7. `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
8. `git diff --check`

Live：

1. 编译、构建、全局安装、重启
2. 新 session 真实 `/v1/responses`
3. 恢复轮次真实 `/submit_tool_outputs`
4. 旧错误样本回放

## 9. 实施顺序

1. 先补红测：system instruction、trigger 分类、thinking 路由、direct disabled、terminal strip、used progression。
2. 再改 request-side system instruction owner。
3. 再改 response-side stop gate 分类与 terminal/cli_projection 分流。
4. 再改 restore 文本注入与 auto/manual stop hook 区分。
5. 再补 handler blackbox 与 e2e。
6. 最后 build/install/restart + live replay + 旧样本复测。

## 10. 完成定义

满足以下全部条件才算完成：

1. 用户要求的 5 条 stopless 闭环语义全部有 owner、代码、测试、live 证据。
2. direct 与 relay 边界清晰，direct 不激活，relay 命中 thinking。
3. stop schema 不再污染客户端可见响应和后续历史。
4. 连续缺失/非法 schema 能在 3 次内稳定收口，不死循环。
5. 新旧样本都能复测通过，且不是只修单测的假修复。
