# 多端口独立路由与 Provider 协议自适应设计

> 目标：把 `config.toml` 的多监听端口配置升级为 **per-port authoritative config**。每个端口独立声明自己的工作模式、路由策略或 provider 绑定；禁止再用“多端口监听 + 全局一套 activeRoutingPolicyGroup”冒充 per-port 路由。

## 索引概要
- L1-L8 `purpose`：目标、范围、核心结论
- L10-L24 `current-gap`：当前实现与目标语义的差异
- L26-L54 `config-ssot`：新的 config.toml 真源结构
- L56-L88 `router-port`：router 端口的独立路由语义
- L90-L123 `provider-port`：provider 端口的 direct / relay / auto 语义
- L125-L152 `runtime-ownership`：运行时唯一 owner 与禁止误修位置
- L154-L183 `validation-migration`：配置校验与旧模式废弃策略
- L185-L214 `implementation-slices`：实现切片与文件 owner
- L216-L235 `verification`：验证矩阵与完成标准

---

## 1. 当前差异（必须先统一认知）

### 1.1 Jason 的目标语义
1. 一个 `config.toml` 同时管理多个监听端口。
2. **每个端口独立配置**，不是“端口配置一份、路由配置另一份全局共享”。
3. 每个端口都要明确声明自己是：
   - `router` 模式，还是
   - `provider` 模式。
4. `provider` 模式下 `protocolBehavior=auto` 必须按**该端口绑定 provider 的协议能力**决定 `direct` 还是 `relay`。

### 1.2 当前实现真相（与目标不一致）
- `httpserver.ports[]` 目前只承载 transport 字段：`port/host/mode/protocolBehavior/providerBinding`。
- `router` 端口目前**没有独立 routing 字段**。
- 运行时 `router` 请求最终仍共享全局 `virtualrouter.activeRoutingPolicyGroup`。
- `provider` 模式的 `auto` 当前只做“入站协议 == provider 协议 → direct，否则 relay”的局部判断，且 relay 范围过窄。

### 1.3 本设计的结论
- **端口配置才是运行时入口真源**。
- `virtualrouter.routingPolicyGroups` 退化为“策略库”，不再承担全局 active 运行态。
- `router` 端口必须显式绑定自己的 `routingPolicyGroup`。
- `provider` 端口必须显式绑定自己的 `providerBinding`。
- 旧的“全局 active group 驱动所有 router 端口”语义直接废弃。

---

## 2. Config.toml 真源结构

### 2.1 顶层结构
```toml
version = "2.0.0"
virtualrouterMode = "v2"

[httpserver]
# 兼容字段仅保留给旧配置探测；新设计不再作为 router 运行态真源
port = 5520
host = "127.0.0.1"

[[httpserver.ports]]
port = 10000
host = "0.0.0.0"
mode = "router"
routingPolicyGroup = "coding"

[[httpserver.ports]]
port = 5520
host = "0.0.0.0"
mode = "router"
routingPolicyGroup = "default"

[[httpserver.ports]]
port = 5555
host = "0.0.0.0"
mode = "provider"
protocolBehavior = "auto"
providerBinding = "dbittai-gpt.gpt-5.4"

[virtualrouter.routingPolicyGroups."default"]
# ... 独立 router policy

[virtualrouter.routingPolicyGroups."coding"]
# ... 独立 router policy
```

### 2.2 `httpserver.ports[]` 新 schema

#### 通用字段
- `port: number`
- `host: string`
- `mode: "router" | "provider"`
- `apikey?: string`
- `timeout?: number`
- `bodyLimit?: string`

#### `mode = "router"`
- **必填**：`routingPolicyGroup: string`
- **禁止**：`protocolBehavior`
- **禁止**：`providerBinding`

#### `mode = "provider"`
- **必填**：`providerBinding: string`
- **必填**：`protocolBehavior: "direct" | "relay" | "auto"`
- **禁止**：`routingPolicyGroup`

### 2.3 `virtualrouter` 的新角色
保留：
- `virtualrouter.routingPolicyGroups`

废弃：
- `virtualrouter.activeRoutingPolicyGroup`

含义：
- `routingPolicyGroups` 只是全局“策略库 / 命名路由集合”。
- 哪个 group 真正生效，不再由全局 active 决定，而是由进入请求的 **localPort → PortConfig.routingPolicyGroup** 决定。

---

## 3. Router 端口语义

### 3.1 核心原则
`router` 端口仍走完整 Hub Pipeline：
```text
HTTP server -> request executor -> llmswitch-core Hub Pipeline -> Virtual Router -> Provider
```

但“Virtual Router 使用哪个 routing config”必须改为：
```text
localPort -> PortConfig.routingPolicyGroup -> virtualrouter.routingPolicyGroups[groupId]
```

### 3.2 运行时行为
对于每个 `router` 请求：
1. HTTP server 从 `req.socket.localPort` 找到对应 `PortConfig`。
2. 若 `mode == router`：读取 `routingPolicyGroup`。
3. 从 `virtualrouter.routingPolicyGroups[groupId]` 取出该端口专属 routing policy。
4. 用该 policy 构造本次请求的 router input。
5. 后续所有 route selection / load balancing / session / webSearch / health / contextRouting 都基于该端口绑定的 group 运行。

### 3.3 禁止的旧行为
- 禁止所有 router 端口继续共享 `virtualrouter.activeRoutingPolicyGroup`。
- 禁止 router 端口省略 `routingPolicyGroup` 后偷偷回退到 `default`。
- 禁止仅把 `routecodexLocalPort` 打到 metadata，却不让 port 真正参与 routing group 选择。

---

## 4. Provider 端口语义

### 4.1 核心原则
`provider` 端口绕过 route selection，直连绑定 provider：
```text
HTTP server -> provider-direct-pipeline -> bound provider -> response remap -> client
```

### 4.2 `protocolBehavior` 语义

#### `direct`
- 要求：入站协议必须与该端口绑定 provider 的协议完全一致。
- 否则：直接 fail-fast。

#### `relay`
- 强制走协议转换链，即使入站协议与 provider 协议相同也允许。
- 但必须存在合法转换 owner；否则 fail-fast。

#### `auto`
固定语义：
1. 先识别入站协议 `inboundProtocol`
2. 读取该端口绑定 provider 的协议 `providerProtocol`
3. 若 `inboundProtocol == providerProtocol`：走 `direct`
4. 若 `inboundProtocol != providerProtocol`：
   - 若存在支持的转换链，走 `relay`
   - 否则 fail-fast

**注意**：
- 这里的 `auto` 决策依据是“该端口绑定 provider 的真实协议能力”。
- 不是全局默认值。
- 不是按端口名猜测。
- 不是额外 fallback。

### 4.3 Relay 范围要求
本设计要求 provider-direct relay 支持主流协议对：
- `openai-chat`
- `openai-responses`
- `anthropic-messages`
- `gemini-chat`

实现要求：
- 不能继续把 `provider-direct-pipeline.ts` 里的浅层字段 remap 扩写成第二套协议语义面。
- 必须复用现有统一协议转换真源。
- 对任何未覆盖或语义不等价的协议对，一律 fail-fast。

---

## 5. 运行时唯一 owner

### 5.1 入口 owner
唯一入口仍在 HTTP server：
- `buildHttpHandlerContext(req.socket.localPort)`
- `RouteCodexHttpServer.executePortAwarePipeline(...)`

这里负责：
- 查 `localPort`
- 取 `PortConfig`
- 分流到 `router` 或 `provider`

### 5.2 Router 端口 owner
Router 端口的唯一修改点在 host-side runtime wiring：
- 让 `localPort -> routingPolicyGroup` 真正参与 router input 构造
- 不能去 llmswitch-core 内部新增“按端口猜 group”的第二入口

### 5.3 Provider 端口 owner
Provider 端口的唯一 owner 仍是：
- `src/server/runtime/http-server/provider-direct-pipeline.ts`

但它只负责：
- 选择 `direct/relay/auto`
- 调统一协议转换 owner
- 调 provider runtime

它**不负责**：
- 自己发明第二套协议 map/unmap
- 自己补 fallback 或 silently degrade

### 5.4 禁止误修位置
- 禁止在 `request-executor.ts` 里偷塞端口级 group 选择逻辑。
- 禁止在 llmswitch-core 内部以 `metadata.routecodexLocalPort` 为依据自行切 active group。
- 禁止在 `provider-direct-pipeline` 内继续维护手写跨协议字段拼接真源。

---

## 6. 配置校验与旧模式废弃

### 6.1 新校验规则
1. 每个 `router` 端口都必须有 `routingPolicyGroup`。
2. `routingPolicyGroup` 必须引用存在的 `virtualrouter.routingPolicyGroups.*`。
3. `router` 端口禁止设置 `providerBinding` / `protocolBehavior`。
4. 每个 `provider` 端口都必须有 `providerBinding` + `protocolBehavior`。
5. `provider` 端口禁止设置 `routingPolicyGroup`。
6. v2 配置中若仍出现 `virtualrouter.activeRoutingPolicyGroup`，直接报错。

### 6.2 旧模式处理策略
Jason 已明确选择：**彻底废弃旧模式**。

因此：
- 不保留“旧 router 端口可共享全局 active group”的兼容运行态。
- 对旧配置只允许给出显式错误 / 迁移指引。
- 不允许自动脑补默认 group。

### 6.3 模板更新要求
默认 `config.toml` 模板必须同步改成：
- router 端口显式写 `routingPolicyGroup`
- provider 端口显式写 `providerBinding` + `protocolBehavior`
- 删除 `activeRoutingPolicyGroup` 示例

---

## 7. 实现切片与文件 owner

### Slice A：Config schema / loader
目标：让配置层接受新 schema，并明确拒绝旧语义。

Owner：
- `src/server/runtime/http-server/port-config-types.ts`
- `src/server/runtime/http-server/port-config-validator.ts`
- `src/config/user-config-loader.ts`

结果：
- 端口类型新增 `routingPolicyGroup`
- v2 校验器移除 `activeRoutingPolicyGroup`
- 配置错误信息可直接指向迁移动作

### Slice B：Virtual Router 输入构造
目标：从“全局 active group”切换到“按端口引用 group”。

Owner：
- `src/config/virtual-router-builder.ts`
- `src/server/runtime/http-server/http-server-runtime-setup.ts`

结果：
- 提供“按 groupId 提取 routing input”的能力
- 不再隐式 materialize 全局 active group 到运行态 `virtualrouter.routing`

### Slice C：HTTP server port-aware routing
目标：真正让 router 端口按自己的 group 跑。

Owner：
- `src/server/runtime/http-server/index.ts`

结果：
- `localPort -> PortConfig.routingPolicyGroup -> router input`
- metadata 继续保留，但不再只是观测字段

### Slice D：Provider auto / relay
目标：让 `provider` 端口的 auto 语义按绑定 provider 的协议能力决定，并扩展 relay 范围。

Owner：
- `src/server/runtime/http-server/provider-direct-pipeline.ts`
- 统一协议转换 owner（现有 host/llmswitch 真源，实施时按真实协议转换 owner 落位）

结果：
- `auto` 行为稳定
- 主流协议对可 relay
- 不支持的协议对显式失败

### Slice E：Admin / UI
目标：管理面和新 schema 对齐。

Owner：
- `src/server/runtime/http-server/daemon-admin/ports-handler.ts`
- 端口管理 UI 对应前端

结果：
- router 端口可配置 group
- provider 端口可配置 binding + protocolBehavior
- 不允许跨 mode 填错字段

---

## 8. 验证矩阵

### 8.1 配置校验
- router 端口缺 `routingPolicyGroup` -> 报错
- provider 端口缺 `providerBinding` / `protocolBehavior` -> 报错
- 旧 `activeRoutingPolicyGroup` 仍存在 -> 报错
- group 引用不存在 -> 报错

### 8.2 Router 端口独立路由
- 两个 router 端口指向不同 group，同类请求命中不同 provider 池
- 相同 payload 从不同 router 端口进入，routingDecision 不同
- 相关 session / health / webSearch / contextRouting 不串组

### 8.3 Provider 端口 auto
- 同协议 provider：`auto -> direct`
- 跨协议且支持转换：`auto -> relay`
- 跨协议且不支持转换：fail-fast
- `direct` 模式遇到协议不匹配：fail-fast

### 8.4 安装态 / live
- `npm run build:min`
- 端口管理相关定向测试
- 至少一条 router 端口 live/request sample replay
- 至少一条 provider 端口 direct live/request sample replay
- 至少一条 provider 端口 relay live/request sample replay

### 8.5 完成标准
1. `config.toml` 已能表达 per-port 独立 router/provider 配置。
2. router 端口不再共享全局 active group。
3. provider `auto` 已按端口绑定 provider 的协议能力决定 direct/relay。
4. 主流协议对 relay 已接入统一转换真源；不支持者 fail-fast。
5. summary 必须明确说明：唯一真源修改点、为什么旧全局 active 语义已被物理移除、验证证据与剩余缺口。
