# 2026-05-17 完整转换回归矩阵审计（req/resp 双向 + servertool）

## 审计范围
你要求的两个方向：
1. `req`: `client inbound -> chat process -> provider outbound`
2. `response`: `provider inbound -> chat process -> client outbound`
并且必须覆盖：
- 工具调用 schema（tools/tool_choice/tool_calls/function_call/required_action）
- 响应 schema（finish_reason/status/output）
- servertool 拦截/续轮/剥离语义

---

## 结论（先给结论）
当前仓库**有大量局部测试**，但“完整 matrix 骨架 + 强制 CI 门禁”仍不完整：
- 有骨架：部分 cross-protocol + 样本回放 + servertool 回归已存在。
- 缺口：没有一个统一的 `req/resp 双向全矩阵` 套件把“协议 × 入口出口 × transport × tool schema × servertool状态”一次性约束住。
- 关键风险：仍可能出现“某个关键组合未被 CI 白名单执行”。

---

## 一、req 方向矩阵（inbound -> chat process -> provider）

## A. 维度定义
- `clientProtocol/entryEndpoint`:
  - `/v1/responses`
  - `/v1/chat/completions`
  - `/v1/messages`
- `providerProtocol`:
  - `openai-chat`
  - `openai-responses`
  - `anthropic-messages`
  - `gemini-chat`
- `tool schema`:
  - 无工具
  - `tools + tool_choice=auto`
  - `tools + tool_choice=required`
  - `submit_tool_outputs / function_call_output` 续轮输入
- `transport`: json / sse（req 侧主要约束 JSON shape，sse 对应 resp）
- `servertool mode`:
  - off
  - on（含 reasoning.stop guard/continue, web_search, clock）

## B. req 侧 schema 不变量（必须全部断言）
1. `tools` 不可被错误清洗为空（除非源请求本来为空）。
2. `tool_choice=auto|required` 时，provider 出站请求必须与 tools 语义一致（不能出现 auto+空tools）。
3. `function_call_output` / `submit_tool_outputs` 在续轮请求中不可丢 `call_id`。
4. `sameProtocol direct` 下：请求主 payload 透明，仅允许白名单覆盖（model/thinking/ua 等）。

## C. 现有覆盖（已存在）
- `tests/sharedmodule/req-inbound-stage2-tool-shape-normalization.spec.ts`
- `tests/sharedmodule/req-inbound-stage3-tool-shape.spec.ts`
- `tests/sharedmodule/responses-submit-tool-outputs.spec.ts`
- `tests/sharedmodule/request-continuation-semantics.spec.ts`
- `tests/server/runtime/http-server/router-direct-pipeline.spec.ts`
- `tests/server/runtime/http-server/provider-direct-pipeline.spec.ts`

## D. req 侧缺口
1. 缺“统一组合矩阵”把 `tool_choice × tools` 与 provider outbound 强绑定（避免 400 bad_request 重现）。
2. 缺“sameProtocol direct + servertool on/off”并排矩阵（确保直连不误触 chat reshape，同时 servertool 语义可控）。
3. 缺把真实错误样本（auto|required + tools 丢失）纳入强制 replay 门禁。

---

## 二、response 方向矩阵（provider -> chat process -> client）

## A. 维度定义
- `providerProtocol`:
  - `openai-chat`
  - `openai-responses`
  - `anthropic-messages`
  - `gemini-chat`
- `clientProtocol/entryEndpoint`:
  - `/v1/responses`
  - `/v1/chat/completions`
  - `/v1/messages`
- `response shape`:
  - text stop
  - tool_calls
  - requires_action
  - empty output / malformed
- `transport`:
  - json final
  - sse chunk + completed
- `servertool state`:
  - no servertool
  - servertool followup active
  - servertool executed calls stripping

## B. response 侧 schema 不变量
1. 只要上游语义是工具调用：
   - chat 面必须有 `assistant.tool_calls`
   - responses 面必须有 `output.function_call` + `required_action.submit_tool_outputs.tool_calls`
2. `call_id / tool_call_id / id` 映射必须可追溯一致。
3. 不得出现 `finish_reason=tool_calls` 但客户端无可消费 tool call。
4. servertool 已执行 internal calls 必须在返回客户端前剥离，不污染客户端工具面。
5. SSE 与 JSON 对同一响应语义必须等价。

## C. 现有覆盖（已存在）
- `tests/sharedmodule/provider-response-remap-toolcall-matrix.spec.ts`（本次新增）
- `tests/server/runtime/http-server/executor/provider-response-converter.unified-semantics.spec.ts`
- `tests/server/runtime/http-server/executor/provider-response-converter.servertool-regression.spec.ts`
- `tests/server/runtime/http-server/executor/provider-response-converter.finish-reason.spec.ts`
- `tests/sharedmodule/real-sample-hub-io-compare.spec.ts`
- `tests/sharedmodule/responses-cross-protocol-audit-matrix.spec.ts`

## D. response 侧缺口
1. `providerProtocol × clientEndpoint × transport(json/sse)` 还未形成完整笛卡尔矩阵。
2. 真实 codex-samples 的“tool_calls 丢映射”只有部分回放，尚未形成“新增样本自动入回归”的强门禁。
3. 缺 `requires_action` 在 SSE completed 事件与最终 JSON body 一致性强断言。

---

## 三、servertool 拦截矩阵（必须并入主矩阵，而非孤立）

servertool 关键状态必须在 req/resp 两侧并排验证：

1. **req 前置拦截**：注入/保留真实 tools，不得伪造工具面。
2. **resp 编排拦截**：reasoning.stop guard/continue 仅基于真实 tools 语义。
3. **resp 返回剥离**：internal executed servertool calls 必须剥离，用户可见面只保留客户端应见工具调用。

已有覆盖分散在：
- `provider-response-converter.servertool-regression.spec.ts`
- `servertool-followup-dispatch.spec.ts`
- `resp-process-stage2-finalize-native.test.ts`（sharedmodule 内）

缺口：这些测试没有被组织成“与协议映射同一个矩阵套件”统一执行。

---

## 四、CI 门禁完整性审计

1. Jest roots 不包含 `sharedmodule/llmswitch-core/test`（`jest.config.js`）。
2. CI 使用 `scripts/tests/ci-jest.mjs` 白名单执行，未入白名单的测试不算门禁。
3. 本次已把新关键用例加入 CI 白名单：
   - `tests/sharedmodule/provider-response-remap-toolcall-matrix.spec.ts`

剩余动作：把“双向 matrix 主套件”全部放到 `tests/sharedmodule/*` 并全部加入 `ci-jest`。

---

## 五、可直接落地的标准矩阵骨架（建议命名）

新增三套（统一放 `tests/sharedmodule/`）：

1. `conversion-req-matrix.spec.ts`
   - 主测 req 双向入站到 provider 出站
   - 强断言 tools/tool_choice/function_call_output 不变量

2. `conversion-resp-matrix.spec.ts`
   - 主测 provider 入站到 client 出站
   - 强断言 tool_calls/function_call/required_action/call_id 映射
   - 覆盖 json+sse

3. `conversion-servertool-intercept-matrix.spec.ts`
   - 同时跑 servertool on/off 与 followup 状态
   - 强断言：不伪造、不清洗真实工具面、执行后剥离 internal calls

并将三套全部加入 `scripts/tests/ci-jest.mjs` 白名单。

---

## 六、对“套样本即可回归”的判断

结论：**现在还不够**。
- 只有“样本回放”但没有“结构化矩阵不变量”会漏新形态。
- 只有“矩阵不变量”但没有“真实样本 replay”会漏真实脏数据形态。

必须“双轨并行”：
1) 结构化矩阵（协议/入口出口/transport/servertool 组合）
2) 实际错误样本 replay（codex-samples + curated errorsamples）

这两条同时作为 CI 强制门禁，才算完整闭环。
