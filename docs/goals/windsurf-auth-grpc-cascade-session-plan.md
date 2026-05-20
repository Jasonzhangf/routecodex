# Windsurf Auth -> gRPC -> Cascade -> Session Mainline Plan

## 1. 目标与验收标准

### 目标
抛开“本地服务器/本地 LS 是否存在”的错误前提，直接梳理并实现 RouteCodex 中 Windsurf provider 的真实主链：**账号密码/Token 如何进入认证链、如何转换为 gRPC/Cascade 所需凭据、session 如何保存、如何复用、何时失效、何时重建**，并以 WindsurfAPI 真源为参考完成对齐。

### 验收标准
1. 明确并落实两类入口：
   - token 型账号如何进入认证链；
   - 邮箱密码型账号如何进入认证链。
2. 明确并落实认证产物：
   - 哪个字段才是后续 gRPC / Cascade 真正消费的凭据；
   - 原始 email/password/token 在认证后是否还应继续参与后续请求。
3. 明确并落实 session 生命周期：
   - session 保存在什么结构；
   - 作用域是 provider/account/runtime/request 中的哪一层；
   - 成功后如何复用；
   - 401/失效/transport cancel 时如何清理或重建。
4. 明确并落实 gRPC / Cascade 调用链：
   - provider 在哪一层把认证产物注入到下游 metadata/header/body；
   - Cascade 初始化、发送消息、流式响应各阶段使用的凭据与 session 一致。
5. same-provider 的重试语义正确：
   - 账号级状态独立维护；
   - 失败后优先切换同 provider 下一个账号实例，而不是同一账号死循环。
6. 定向测试、编译、构建、全局安装、restart、5520/样本回放全部通过并留证据。

## 2. 范围与边界

### In Scope
- Windsurf 账号密码 / token 认证链
- 认证产物到 gRPC / Cascade 的注入链
- session 保存、读取、复用、失效与重建
- 账号级错误状态机与轮转
- 相关测试与运行验证

### Out of Scope
- 不先讨论“本地服务器是否需要重建”这种偏题前提
- 不改 Hub Pipeline 主语义
- 不改非 Windsurf provider
- 不先做 UI 账号管理
- 不做与本问题无关的 stopless / followup 改造

## 3. 设计原则
1. 先追真源，再写代码：必须先读 WindsurfAPI 中 auth / client / handlers / session 相关实现。
2. 关注“凭据如何传递”而不是机械照抄模块表面结构。
3. session 必须有唯一持有层，不能 provider/request/runtime 多处散落复制。
4. fail-fast：错误分类必须清晰，禁止静默 fallback。
5. 先补错误测试，再改代码，再做 build/install/restart/live 验证。
6. 删除错误实现与死语义，不保留“闲置旧逻辑”。

## 4. 参考真源
- `/Volumes/extension/code/WindsurfAPI/README.md`
- `/Volumes/extension/code/WindsurfAPI/src/auth.js`
- `/Volumes/extension/code/WindsurfAPI/src/client.js`
- `/Volumes/extension/code/WindsurfAPI/src/handlers/chat.js`
- `/Volumes/extension/code/WindsurfAPI/src/windsurf-api.js`
- `/Volumes/extension/code/WindsurfAPI/src/dashboard/windsurf-login.js`
- `~/.rcc/provider/windsurf/config.v2.toml`

## 5. 技术方案

### Slice A：先做真源链路审计
输出一条可落地链路：
1. email/password 或 token 从哪个入口进入；
2. 调了哪些 auth API；
3. 拿到了哪些字段；
4. 最终哪个字段进入 gRPC / Cascade；
5. session 存在哪里；
6. 下次请求如何复用；
7. 失败时哪里清理。

要求把这条链路落实到 RouteCodex 当前文件路径与函数名，不允许只写概念。

### Slice B：统一认证产物模型
在 RouteCodex 中统一为单一会话凭据对象，例如：
- account identity
- auth source(token/password)
- session token / access token / api key 真值
- acquiredAt / expiresAt / invalidatedAt
- error state / cooldown state

约束：
- 原始 password 只允许用于登录阶段；
- 原始 token 只允许用于 token 登录阶段；
- 登录后下游主链只消费统一 session credential。

### Slice C：打通 gRPC / Cascade 注入点
明确并修改：
- 哪个 client/transport 构造 gRPC metadata 或 header；
- 哪个 handler 发起 cascade init / send message；
- 哪个字段被放进 metadata/header/body；
- stream/non-stream 是否共用同一凭据注入逻辑。

### Slice D：session 保存与维持
明确唯一真源层：
- 不允许 request 级临时变量伪装成 session 真相；
- 不允许多个地方各自缓存一份互相漂移；
- 成功请求后可复用；
- 401 / invalid credential / explicit logout / transport cancel 时按规则清理。

### Slice E：账号轮转与错误状态
- same-provider = 同 provider 组下的下一个账号实例。
- 401：永久失效/出池，直到凭据更新。
- 429：冷却，保留账号但暂时不选。
- 5xx / upstream transient：可重试，但切下一个账号实例。
- client closed：立即终止，不继续派发。
- 成功一次后，该账号错误计数归零。

## 6. 文件清单
- `src/providers/core/runtime/windsurf-chat-provider.ts`
- `src/providers/core/contracts/windsurf-provider-contract.ts`
- `src/providers/core/runtime/*windsurf*`
- `tests/providers/core/runtime/windsurf-chat-provider.spec.ts`
- `tests/providers/core/runtime/grpc-client.spec.ts`
- `tests/server/runtime/http-server/request-executor.spec.ts`（如需补 5520 定向回放）
- `note.md`
- `MEMORY.md`（仅稳定结论后追加）

## 7. 测试计划
1. token 登录与邮箱密码登录都能归一到统一 session credential。
2. gRPC / Cascade 请求读取的是统一 session credential，而不是原始密码/token。
3. session 能跨请求复用；401 后清理；成功后继续可复用。
4. same-provider 连续失败后切换到下一个账号实例。
5. 401 / 429 / 5xx / client-close 分类正确。
6. 定向 TypeScript / jest / build / install / restart / 5520 smoke 全跑。

## 8. 实施步骤
1. 先 review WindsurfAPI 真源，画出 auth -> credential -> grpc -> cascade -> session 的精确链路。
2. 对照 RouteCodex 现状，标出错误传递点、错误 session 持有点、错误重试点。
3. 先补测试锁定错误场景。
4. 再改统一 session credential 与注入链。
5. 再改账号状态机与轮转。
6. 跑测试、编译、构建、安装、restart、smoke、样本回放。
7. 证据稳定后更新 MEMORY.md。

## 9. 完成定义（DoD）
1. 已能明确回答“账号密码如何传递到 gRPC，再到 Cascade”。
2. 已能明确回答“认证后获得的 session 保存在哪里、如何复用、如何维持、何时失效”。
3. RouteCodex 代码已按上述唯一真源实现，不再混乱散落。
4. same-provider 不再同账号死循环。
5. 5520 运行验证与错误样本回放有证据通过。
