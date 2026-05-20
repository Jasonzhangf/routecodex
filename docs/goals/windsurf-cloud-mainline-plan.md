# Windsurf Cloud Mainline Alignment Plan

## 1. 目标与验收标准

### 目标
把 RouteCodex 当前 Windsurf provider 改成**无本地服务器/无本地 LS 依赖**的唯一主链：`HTTP server -> llmswitch-core Hub Pipeline -> Windsurf provider -> Windsurf cloud / Cascade mainline`，移除错误的本地端口、本地 gRPC、本地 LS readiness 假设，确保 5520 入口下请求按账号凭据直接完成认证、建会话、发送请求、处理响应。

### 验收标准
1. Windsurf provider 不再把 `lsPort`、`csrfToken`、本地 gRPC endpoint、本地 language server readiness 当成主链前置条件。
2. provider runtime 不再尝试启动、连接、等待任何本地 LS / 本地服务器端口。
3. 认证链统一为账号凭据真链：
   - token 型账号走 token 登录；
   - 邮箱密码型账号走登录接口换取 session/auth 凭据；
   - 后续请求统一使用登录后得到的有效会话凭据，而不是把原始密码/token 混作下游请求字段。
4. 5520 最小 `POST /v1/responses` smoke 能真实进入 Windsurf 主链，不再出现 `InitializeCascadePanelState`、`windsurf grpc csrfToken missing`、`windsurf session token not initialized`、`ERR_HTTP2_STREAM_CANCEL` 这类本地 LS 假设型错误。
5. provider 轮转逻辑以“同 provider 下换账号/凭据实例”为单位，而不是死盯同一账号自旋；401/明确失效凭据必须被标记失效，冷却错误与永久失效错误必须可区分。
6. 定向测试、编译、全局安装、restart、runtime smoke 全通过并留证据。

## 2. 范围与边界

### In Scope
- Windsurf provider 认证/鉴权链真源梳理与修正
- 移除本地 LS / gRPC / 端口依赖
- 账号池轮转逻辑修正（same provider ≠ same account）
- 错误分类：永久失效 / 冷却 / 可重试 / 客户端关闭
- 对应单测、构建、安装、restart、runtime smoke
- 文档、note、必要 memory 沉淀

### Out of Scope
- 不改 Hub Pipeline 主语义
- 不改非 Windsurf provider 的 routing 规则
- 不做 UI 层账号管理界面
- 不做与本任务无关的 stopless / goal followup 改造
- 不保留任何“本地 LS 作为备用链路”的 fallback

## 3. 设计原则
1. 单一路径真源：Windsurf provider 只走云端主链，不发明本地服务器。
2. fail-fast + no fallback：发现凭据失效、协议不支持、接口未实现，直接显式暴露。
3. same provider 是“同一 provider 组下的不同账号实例”，不是“同一账号无限重试”。
4. provider 只做认证、会话、模型解析、请求发送、响应转换；不承担伪造本地运行时。
5. 删除错误实现，不保留死代码或闲置分支。
6. 先补错误场景测试，再改代码，再做 build/install/restart/live 验证。

## 4. 技术方案（文件清单）

### 参考真源
- `/Volumes/extension/code/WindsurfAPI/README.md`
- `/Volumes/extension/code/WindsurfAPI/src/auth.js`
- `/Volumes/extension/code/WindsurfAPI/src/windsurf-api.js`
- `/Volumes/extension/code/WindsurfAPI/src/handlers/chat.js`
- `/Volumes/extension/code/WindsurfAPI/src/dashboard/windsurf-login.js`
- `~/.rcc/provider/windsurf/config.v2.toml`

### 重点修改文件
- `src/providers/core/runtime/windsurf-chat-provider.ts`
- `src/providers/core/contracts/windsurf-provider-contract.ts`
- `src/providers/core/runtime/provider-runtime-registry.ts`（若有 runtime 构造/解析耦合）
- `src/providers/core/runtime/*windsurf*` 相关错误实现文件
- `tests/providers/core/runtime/windsurf-chat-provider.spec.ts`
- `tests/providers/core/runtime/grpc-client.spec.ts`（若存在错误绑定需收缩或删除）
- `tests/server/runtime/http-server/request-executor.spec.ts`（如需补 5520 定向链路）
- `note.md`
- `MEMORY.md`（仅在结论稳定后追加）

### 核心改造点
#### Slice A：删除错误的本地 LS / gRPC 主链
- 物理删除 Windsurf provider 对本地 `lsPort` / `csrfToken` / `InitializeCascadePanelState` / 本地 warmup 的主路径依赖。
- 若 contract 中仍暴露这些字段，只允许 debug 注释性保留；默认主链必须不读取它们。
- 删除或收缩 `windsurf-langserver-manager.ts` 这类错误 ownership 模块；不得继续保留为闲置代码。

#### Slice B：认证链对齐
- token 账号：走 token 登录接口，拿会话凭据。
- 邮箱密码账号：先登录，再换取会话凭据。
- provider 内部统一为 `WindsurfSessionCredential` 真值对象，后续主链只消费该对象。
- 严禁后续请求直接把 email/password 当 apiKey 或 metadata 混传。

#### Slice C：云端请求主链对齐
- 对齐 WindsurfAPI 的 chat 请求入口、headers、body 结构、模型字段、流式/非流式处理。
- 明确 stream/non-stream 的唯一转换点。
- 明确错误映射：
  - 401 => 凭据失效，移出可用池
  - 429 / provider cooldown => 冷却，不判永久失效
  - 5xx / upstream cancel => 可重试错误，但换账号实例，不在同账号无限自旋
  - client closed => 直接中止，不继续派发

#### Slice D：账号池轮转修正
- `same provider` 语义改为同 provider 组下的**下一个账号实例**。
- 单账号连续错误计数独立维护。
- 永久失效账号停止参与；冷却账号按时间窗恢复；成功一次清零其错误计数。
- 日志必须清晰打印：provider group、account slot、credential status、route reason。

#### Slice E：错误样本回放与证据链
- 用现有 5520 样本回放：
  - `InitializeCascadePanelState` cancel
  - `ERR_HTTP2_STREAM_CANCEL`
  - `Invalid email or password`
  - `session token not initialized`
- 目标不是掩盖错误，而是让错误转为真实云端链路的明确错误，并最终跑通有效账号。

## 5. 风险与规避
1. **继续沿用错误前提**：把参考项目里的本地组件误当本项目主链。
   - 规避：以“本项目没有本地服务器”作为硬前提，所有代码审查都先检查是否仍有本地端口依赖。
2. **只是不接入，不删除错误实现**。
   - 规避：对已确认错误的本地 LS/gRPC 方案做物理删除。
3. **账号轮转仍停留在同一账号自旋**。
   - 规避：先补测试，断言连续失败后必须切换到同 provider 下一个账号实例。
4. **把 401、429、502 混成同一类错误**。
   - 规避：先补错误分类测试，再改 runtime 分支。

## 6. 测试计划

### 单测
- token / email-password 两类登录入口归一为 session credential
- provider 发送请求时不再读取任何本地 ls/grpc 字段
- 同 provider 连续失败后切换到下一个账号实例
- 401 标记永久失效；429 标记冷却；502/transport cancel 标记可重试
- client closed 不继续派发

### 集成/回放
- 5520 最小 non-stream smoke
- 5520 stream smoke
- 错误样本回放：验证不再走本地 LS 相关错误路径

### 构建/安装/运行
- `npm run jest:run -- --runInBand <targeted tests>`
- `./node_modules/.bin/tsc -p tsconfig.json --noEmit`
- `npm run build:min`
- `npm run install:global`
- `routecodex restart --port 5520`
- `curl http://127.0.0.1:5520/v1/responses ...`

## 7. 实施步骤
1. 先 review 现有 Windsurf 代码，找出所有本地 LS / gRPC / 端口依赖点。
2. 先补错误场景测试：本地字段不应被读取、same-provider 应切账号、错误分类正确。
3. 删除错误本地主链实现与 contract 暴露。
4. 按 WindsurfAPI 真链重建登录与云端 chat 请求主链。
5. 修正账号池轮转与错误状态机。
6. 跑定向测试、编译、构建、安装。
7. restart 5520 并做 smoke/样本回放。
8. 将稳定结论写入 `MEMORY.md`，过程记录留 `note.md`。

## 8. 完成定义（DoD）
1. 代码中不存在 Windsurf 主路径的本地 LS / 本地 gRPC 依赖。
2. same-provider 失败轮转已按账号实例工作，不再同账号自旋。
3. 401/429/5xx/client-close 错误分类正确并有测试覆盖。
4. build/install/restart 成功。
5. 5520 smoke 不再出现本地 LS 假设型错误，且有效账号能够真实跑通主链。
