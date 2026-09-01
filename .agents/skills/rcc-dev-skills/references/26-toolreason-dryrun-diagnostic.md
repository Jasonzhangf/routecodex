# 26 Toolreason 双 Dry-Run 诊断

## 触发

- `TOOLREASON MISSING` 比例高、偶发 `OK`，或 provider 原始工具参数与客户端显示不一致。
- `/v1/responses` Direct 或 `/v1/messages` Relay 的 reason 剥离、Resp03、reasoning/正文投影异常。
- request dry-run 已绿，但真实客户端仍看不到 Toolreason。

## 完成口径

必须用同一 `request_id`、同一入口协议、同一 Direct/Relay 路径、同一 provider/model 绑定四件套：

```text
client request
→ final provider request
→ provider raw response
→ client response
```

请求 dry-run 只证明 provider-bound payload；响应 dry-run 只证明捕获的 provider raw 能经过当前 Rust 响应链。两者都绿后，仍需安装、聚合 restart、4444 同入口真实五轮。Direct 与 Relay 必须分别闭环，不能互相替代。

## 固定顺序

### 1. 锁请求身份与路径

先记录：

- `request_id`、port、entry protocol；
- `direct|relay` 的 node trace / execution decision；
- provider、model、provider wire protocol；
- canonical `request.json`、`provider-request.json`、`provider-response.json`、`response.json`。

只看 console、最终 200、node trace 或另一次成功请求都不算同请求证据。

### 2. Provider CURL A/B/C

1. A：同 provider/model/key 的最小工具请求，验证 provider 基线。
2. B：把失败请求的完整 `provider-request.json` body 原样直连同一 provider；只补 transport auth/header，不改 body。
3. C：同一客户端 payload 经过 RouteCodex 真实入口。
4. A/B 至少各重复五次，记录原始响应中 reason 的命中率；不得用另一个 provider、模型、协议或路由成功替代。

判定：

- A 失败：provider/key/model/endpoint 基线问题。
- A 成功、B 失败：provider-bound 请求的历史、role、guidance 位置、schema 或序列化问题。
- A/B 成功、C 失败：RouteCodex transport、响应 inbound、Resp03 或 client projection 问题。

### 3. 请求 dry-run

对真实客户端 payload 使用同一入口的 `x-routecodex-dry-run: provider-request`，检查最终 `providerRequest`：

- 实际 provider/model/wire protocol 正确；
- 当前轮 system/instructions 中有严格三字段 guidance，明确三项缺一不可；
- 工具 description 与参数 schema 中有 `reason`、`goal_alignment_confidence`、`model_id`；
- 三字段都位于 `properties`，并全部在 `required`；
- `model_id.description` 强制要求模型填写自身当前真实 model ID，且没有从 `request_id`、客户端/请求 model、route alias、selected target 或 provider-bound wire model 绑定、预填或派生任何值；
- 原始 system/history/tool 不被改写；
- `providerNetworkSend=false`，且 provider pipeline 已执行。

guidance 只能落在当前 provider-facing slice；多 system history 不得用第一个 system 作为无条件注入点。请求 dry-run 的合成 `response_payload` 不是 provider 行为证据。

### 4. 先判 raw response

- provider raw 没有 reason：回请求构造和 A/B；禁止在响应端伪造、补值或 fallback。
- provider raw 有 reason、client 没有：继续追 `ProviderResp14Raw → RespInbound → Resp03 → client projection`。
- 请求 guidance/schema 强制三字段；响应兼容判罚只硬要求非空 `reason`。不得因 provider raw 缺少 `model_id` 或 `goal_alignment_confidence` 把有效 reason 判 invalid/missing。

### 5. V3 Rust 响应 dry-run

调用当前 server 的 `POST /_routecodex/debug/dry-run`，完整 fixture 必须同时带原请求和捕获的 provider raw：

```json
{
  "fixture_id": "toolreason-response-replay",
  "method": "POST",
  "path": "/v1/responses",
  "request_payload": {},
  "response_payload": {
    "object": "routecodex.v3.provider_response_snapshot",
    "stage": "provider-response",
    "bodyKind": "sse",
    "rawSse": "data: {...}\n\n"
  }
}
```

Anthropic Relay 使用 `path=/v1/messages`；JSON provider response 使用：

```json
{
  "object": "routecodex.v3.provider_response_snapshot",
  "stage": "provider-response",
  "bodyKind": "json",
  "body": {}
}
```

有效响应证据必须同时满足：

- `kind=provider_response`；
- `evidence.providerNetworkSend=false`；
- `evidence.providerResponseConsumed=true`；
- `clientResponse` 已 materialize；
- raw reason 被 Resp03 剥离，原生 tool call 仍可执行；
- 客户端投影含对应 reasoning 或独立正文。

只出现响应 node trace 不够：Direct SSE 是 lazy stream，未消费就不能证明 Resp03 执行。不得复活 V2 TS `convertProviderResponseIfNeeded` 或 `dry-run:codex-response`。

### 6. Direct 与 Relay 投影

- Direct：语义只能在注册的 Direct hook / Rust Resp03 处理；禁止在普通 SSE transport、HTTP handler 或 RespOutbound 补偿。
- Direct 独立正文必须有完整 Responses message lifecycle：`output_item.added(message) → content_part.added → output_text.delta/done → content_part.done → output_item.done(message)`，并在 `response.completed` 前结束。
- Relay：先由对应 provider RespInbound 归一化，再由同一 Rust Resp03 剥离，最后走目标客户端协议投影；不得复用 Direct 证据。
- Anthropic 独立正文使用标准 text block，原 `tool_use.input` 去除 reason 后仍保持合法。

### 7. 正反测试与在线闭环

正向：raw 含三件套时，reason 被剥离、原工具可执行、client reasoning/正文可见；raw 只有合法 reason 时也必须完成同一剥离和投影。

反向：

- raw 无 reason：不伪造 reasoning/正文，不删除原工具调用；
- malformed snapshot：显式进入 typed response error chain；
- Direct message lifecycle 不完整：测试必须红；
- Relay 路径不能由 Direct fixture 代替。

源码绿后按项目合同：从最新 main 构建 → 全局安装 → 一次聚合 `routecodex restart -c <active-config>` → 只验证任务指定端口 → 同一真实 artifact 响应回放 → Direct 五轮 → Relay 五轮。每轮按 request_id 核对四件套和客户端证据。

## 首次偏离判定

```text
provider request 无 guidance/schema
  → Req04 / provider outbound owner
provider raw 无 reason
  → 请求方法或 provider 执行率
provider raw 有 reason，Resp03 未观测
  → RespInbound / lazy stream consumption / Resp03 owner
Resp03 已剥离，client 不可见
  → Direct/Relay 注册投影合同
```

## 反模式

- 用 request dry-run 宣称响应链已闭环。
- 用 CURL 方法成功宣称 RouteCodex 流水线已部署正确。
- 用 node trace 宣称 lazy SSE 已消费。
- 用普通 smoke、另一 provider、另一协议、另一路径代替真实失败 artifact。
- 在 handler、SSE、RespOutbound、provider runtime 增加第二套 Toolreason parser/projector。
- 缺 reason 时文本猜测、伪造 reason、静默吞错或切 provider。
- 把 debug snapshot/control 字段写入 provider/client normal payload。
