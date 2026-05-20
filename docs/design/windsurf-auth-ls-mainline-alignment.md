# Windsurf 认证 / 鉴权 / LS 主链对齐设计

## 索引概要
- L1-L8 `purpose`：本文用途与边界。
- L10-L34 `reference-auth`：WindsurfAPI 认证/鉴权真源。
- L36-L61 `reference-ls`：WindsurfAPI LS 生命周期真源。
- L63-L87 `current-gap`：当前 RouteCodex 偏差点。
- L89-L112 `target-architecture`：目标架构与职责边界。
- L114-L142 `implementation-slices`：最小实施切片。
- L144-L159 `verification`：验证闭环。
- L161-L173 `non-goals`：当前不做的事。

## 目的与边界
本文只回答一件事：**RouteCodex 的 Windsurf provider 应如何完整对齐 WindsurfAPI 的认证、鉴权、LS 初始化、会话与聊天主链**。

硬边界：
1. 不讨论 fallback/降级设计；错误必须显式暴露。
2. 不先讨论 retry/reroute 策略；先修正主链真源。
3. 不在 Provider 内再发明第二套认证/LS 生命周期。
4. 本文以 WindsurfAPI 代码为参考真源，不以当前 RouteCodex 现状为真。

## WindsurfAPI 真源：认证 / 鉴权链

### 1. 推荐主入口：token 登录
WindsurfAPI README 明确给出推荐入口：
1. 用户从 `https://windsurf.com/show-auth-token` 复制 token。
2. 服务端调用 `POST /auth/login`，body 传 `{ token }`。
3. token 入池后，后续请求直接以该账号的 `sessionToken / apiKey` 参与云端请求与 LS/gRPC 主链。

这说明：**token 是一等入口，不是补充入口。**

### 2. 邮箱密码入口并不是“直接拿 password 当 key”
WindsurfAPI `src/auth.js` 与 `src/dashboard/windsurf-login.js` 的真链路是：
1. `CheckUserLoginMethod`
2. 若需要再探测 `/_devin-auth/connections`
3. `/_devin-auth/password/login`
4. `WindsurfPostAuth`
5. 从返回中提取 `sessionToken`
6. **把 `sessionToken` 作为后续 metadata.apiKey 的真值**

结论：
- 邮箱密码只是获取会话凭据的入口。
- 真正进入后续调用链的是 `sessionToken`，不是邮箱，也不是原始密码。

### 3. Cloud metadata 请求与 chat 主链不是一回事
WindsurfAPI `src/windsurf-api.js` 暴露的是账号/目录/限额面的 Connect-RPC 接口：
- `GetUserStatus`
- `GetCascadeModelConfigs`
- `CheckUserMessageRateLimit`

这些接口用于：
- 账号状态探测
- 模型目录发现
- 限额预检

它们**不是**真正的聊天主链，不应被误认为“有 cloud metadata 就等于 chat 已经对齐”。

## WindsurfAPI 真源：LS 生命周期 / 会话主链

### 1. 主链一定先过 LS manager
WindsurfAPI 的聊天路径不是“provider 直接拼 gRPC 然后发”。
其真源顺序是：
1. `ensureLs(proxy)`
2. `getLsFor(proxy)`
3. `waitPortReady(...)`
4. 取得 LS entry：`port/csrfToken/sessionId/workspaceInit/ready/generation`
5. 基于 LS entry 构造 `WindsurfClient(apiKey, ls.port, ls.csrfToken)`
6. `warmupCascade()`
7. 再进入 `InitializeCascadePanelState / StartCascade / SendUserCascadeMessage ...`

结论：**LS readiness 是会话主链前置条件，不是 provider 内部一个临时 promise 就能替代的。**

### 2. session/workspace 不属于 provider 的 ad-hoc 局部状态
WindsurfAPI 中，以下状态都归属于 LS entry，而不是某个单次 provider 实例的散状态：
- `sessionId`
- `workspaceInit`
- `generation`
- `ready`
- `port`
- `csrfToken`

这说明唯一正确结构是：
- **LS manager 持有 LS 生命周期状态**
- provider 只消费“已就绪 LS entry”

### 3. warmupCascade 是 LS 级别、幂等、可重入的预热动作
WindsurfAPI 的 `warmupCascade()` 不是一次性杂项调用，而是会话主链组成部分：
- 它依赖已就绪的 LS
- 它为后续 panel/session/cascade 调用铺平状态
- 它必须跟随 LS 生命周期管理

如果缺少这层，最常见表现就是：
- `InitializeCascadePanelState` 早期取消
- `StartCascade` / `SendUserCascadeMessage` transport cancel
- session token 看似有了，但聊天仍起不来

## 当前 RouteCodex 偏差

当前 RouteCodex `src/providers/core/runtime/windsurf-chat-provider.ts` 仍存在以下偏差：

### 1. provider 直接持有本应属于 LS manager 的状态
当前 provider 直接持有：
- `windsurfSessionCredential`
- `cascadeWorkspaceInitPromise`
- `cascadeSessionId`

这等于把 LS 生命周期缩成 provider 局部变量，和 WindsurfAPI 真源不一致。

### 2. 缺失独立 LS manager 层
仓库内当前没有 WindsurfAPI 对应物：
- `ensureLs(...)`
- `getLsFor(...)`
- `waitPortReady(...)`
- LS entry generation/ready ownership

所以现在的实现不是“少补一个 header”级别的问题，而是**整个初始化 ownership 放错层**。

### 3. contract 仍把 LS 配置当成 provider runtime 原始字段
`src/providers/core/contracts/windsurf-provider-contract.ts` 当前仍暴露：
- `transportBackend`
- `lsPort`
- `csrfToken`

这会把错误的 ownership 固化到配置与 bootstrap 面。

### 4. 现有 runtime 失败形态已证明问题在初始化主链
已观测到的错误从：
- `SendUserCascadeMessage ... pending stream canceled`
前移到：
- `InitializeCascadePanelState: The pending stream has been canceled`

这不是“修好了”，而是说明：
- header/局部 reset 修补把问题推进到了更靠近真源的位置；
- 真正未对齐的点就是 **LS 初始化 / readiness / warmup 主链**。

## 目标架构

唯一正确的目标结构应为：

```text
HTTP server
  -> Hub Pipeline
  -> Windsurf provider
  -> Windsurf LS manager
  -> WindsurfClient / gRPC mainline
  -> Windsurf cloud
```

职责边界：

### Hub Pipeline
- 只负责编排请求，不理解 Windsurf 认证或 LS 生命周期。

### Windsurf provider
- 负责：
  - 账号解析
  - 凭据获取/刷新
  - 选择模型
  - 调用 LS manager 取得 ready entry
  - 调用 chat client 发起聊天
- 不负责：
  - 自己维护 LS session/workspace/generation 真相

### Windsurf LS manager
- 唯一持有：
  - `port`
  - `csrfToken`
  - `sessionId`
  - `workspaceInit`
  - `generation`
  - `ready`
- 唯一负责：
  - `ensureLs()`
  - `waitPortReady()`
  - `getLsFor()`
  - `warmupCascade()` 前置状态保证

### Windsurf cloud metadata client
- 只负责 `GetUserStatus / GetCascadeModelConfigs / CheckUserMessageRateLimit`
- 不承担聊天主链初始化

## 最小实施切片

### Slice 1：新增 LS manager 真源模块
新增 `src/providers/core/runtime/windsurf-langserver-manager.ts`：
- 建立 `WindsurfLangserverEntry`
- 实现 `ensureLs(proxy?)`
- 实现 `getLsFor(proxy?)`
- 实现 `waitPortReady(...)`
- 托管 `sessionId/workspaceInit/generation/ready`

### Slice 2：provider 改为消费 LS manager
`windsurf-chat-provider.ts` 改造为：
1. 先完成账号登录 / sessionToken 获取
2. 向 LS manager 请求 ready entry
3. 基于 ready entry 构造 chat client / gRPC 调用
4. provider 物理删除本地持有的 `cascadeWorkspaceInitPromise/cascadeSessionId` 主状态

### Slice 3：warmup 与 panel init 对齐
把以下动作从 provider ad-hoc 串改为 LS 主链：
- `InitializeCascadePanelState`
- tracked workspace init
- trust / heartbeat / generator metadata
- `warmupCascade` 相关前置

原则：这些不是“每次随便试试”，而是 **LS entry ready 过程的一部分**。

### Slice 4：收缩错误 contract
收缩 `windsurf-provider-contract.ts`：
- `lsPort/csrfToken` 不再作为 provider runtime 外部配置真源
- 仅保留必要的 cloud / auth / model 配置
- 若仍需 debug override，也必须标明是 debug-only，不得作为主路径语义

### Slice 5：回放验证样本
至少验证两类：
1. 错误样本回放：当前 `InitializeCascadePanelState canceled` 样本
2. 正常 smoke：`POST /v1/responses` 简单 `stream:false` 请求

## 验证闭环

实施后必须按以下顺序验证：
1. 单测：LS manager 状态机、wait-ready、session ownership
2. 定向 provider 测试：登录成功后能拿到 ready LS entry
3. 编译：`npm run build:min`
4. 全局安装：`npm run install:global`
5. 重启：`routecodex restart --port 5520`
6. 运行时 smoke：对 `http://127.0.0.1:5520/v1/responses` 发最小请求
7. 错误样本回放：确认不再在 `InitializeCascadePanelState` 首跳取消

## 当前非目标（先不做）
1. 不先优化 reroute / retry 策略。
2. 不先调 adaptive concurrency。
3. 不先做“same provider but next key”策略修饰。
4. 不把 cloud metadata client 误当聊天主链替代品。

只有当 LS 初始化与认证主链对齐后，后续 retry/reroute 讨论才有意义。
