# Router Same-Protocol Direct（5520）最终实现方案

日期：2026-05-17  
状态：Final Plan（Decision Complete）

## 1. 目标与约束

- 5555 provider mode 保持现状不变：
  - 单 provider 绑定；
  - protocolBehavior=auto；
  - 同协议 direct、跨协议 relay。
- 5520 router mode 新增同协议 direct：
  - 必须保留路由判定能力；
  - 同协议命中后，跳过 chat process 与 outbound 整形；
  - 请求使用原始 payload + 最小配置覆盖；
  - 响应直透客户端。
- 禁止 fallback/兜底/静默补偿。

---

## 2. 关键语义（最终确认）

### 2.1 Direct 请求语义
- 基线：原始入站 payload（语义不改写）。
- 仅允许最小配置覆盖（白名单）：
  - thinking/reasoning
  - model
  - ua（User-Agent 相关）
- 禁止结构性改写（messages/input/tool/history/media 等）。

### 2.2 Direct 响应语义
- 若命中同协议 direct：
  1) 响应直接透回客户端（不做 outbound 整形）；
  2) 请求最小覆盖部分必须“透明可追踪”：
     - 至少在 snapshot/log 中可回放；
     - 可选在响应元信息中附带 `applied_overrides`（仅元信息，不改业务 body 语义）。

---

## 3. 配置与接口变更

### 3.1 Router 端口新增配置
`sameProtocolBehavior = "direct" | "relay"`（默认 `direct`）

- `direct`：同协议 direct，跨协议 relay
- `relay`：统一走 relay

### 3.2 校验规则
- router:
  - 允许 `sameProtocolBehavior`
  - 禁止 `providerBinding/protocolBehavior`
- provider:
  - 禁止 `sameProtocolBehavior`
- 非法枚举值 fail-fast。

---

## 4. 流水线改造设计

### 4.1 Router 请求入口
1. 保留 inbound 路由判定能力，得到 target provider。
2. 判断：
   - `sameProtocolBehavior=direct` 且 `inboundProtocol == targetProviderProtocol` => direct 分支
   - 其他 => relay 分支（现有 inbound/chat/outbound）

### 4.2 Direct 分支（同协议）
1. clone 原始 payload；
2. 应用最小覆盖层（白名单键）；
3. 记录 direct 请求快照；
4. `providerHandle.instance.processIncoming(payload)` 直发；
5. 响应直透回客户端（transport 壳层可保留最小处理，如 status/header 透传）。

### 4.3 Relay 分支
- 维持现有 RequestExecutor 全链行为，不改语义。

---

## 5. Snap / 日志 / 证据链

新增或明确 stage：
- `router-direct.hit`
- `router-direct.send.start`
- `router-direct.send.completed`
- `router-direct.response.start`
- `router-direct.response.completed`
- `router-relay.hit`

快照建议：
- `direct.request.raw`（原始）
- `direct.request.applied`（覆盖后）
- `direct.response.raw`（provider 原始）
- `direct.response.sent`（回给客户端壳层结果摘要）

覆盖透明性要求：
- 记录 `applied_overrides`（键+值）
- 能从证据链回放“原始请求 -> 覆盖后请求 -> 原始响应 -> 透传响应”。

---

## 6. 测试计划（必须通过）

1. router + direct + 同协议：
   - 命中 direct；
   - provider 收到“原始payload + 最小覆盖”；
   - 未调用 chat/outbound 整形链。
2. router + direct + 跨协议：
   - 命中 relay（现有链路）。
3. router + relay + 同协议：
   - 强制 relay。
4. direct 响应透传：
   - JSON/SSE 均无 outbound 改写。
5. 覆盖透明性：
   - snapshot/log 可精确看到 applied_overrides。
6. 配置校验：
   - sameProtocolBehavior 合法/非法用例。
7. 回归：
   - provider-direct 现有 5 用例不回归。

---

## 7. 唯一性说明（实现路径）

该方案是唯一正确路径：
- 保留 virtual router 的路由真源（不绕路由）；
- direct 语义严格满足“跳过 chat/outbound”；
- 同时保留 snap 与可审计证据链；
- 其他方案会导致：要么不是真 direct，要么破坏路由真源，要么形成双语义面。
