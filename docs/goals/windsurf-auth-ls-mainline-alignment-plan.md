# Windsurf Auth / LS Mainline Alignment Plan

## 1. 目标与验收标准

### 目标
把 RouteCodex 当前 Windsurf provider 的认证、鉴权、LS 初始化、会话持有、warmup 与聊天主链，完整对齐到 WindsurfAPI 的真实实现路径，消除当前 provider 内部错误 ownership，恢复 5520 入口下 Windsurf 路由的可用性与可验证性。

### 验收标准
1. `windsurf-chat-provider.ts` 不再把 `cascadeWorkspaceInitPromise`、`cascadeSessionId` 作为主状态真源持有。
2. 新增独立 `windsurf-langserver-manager.ts`，唯一持有 LS entry 生命周期状态：`port/csrfToken/sessionId/workspaceInit/generation/ready`。
3. provider 登录链走 WindsurfAPI 真链路：
   - token 入口可直接入链
   - 邮箱密码入口走 `CheckUserLoginMethod -> password/login -> WindsurfPostAuth -> sessionToken`
   - 后续请求使用 `sessionToken` 作为 `apiKey` 真值
4. 5520 下最小 `POST /v1/responses` smoke 不再在 `InitializeCascadePanelState` 首跳直接 cancel。
5. 针对错误样本回放，错误形态不再停留在当前错误 ownership 的首跳取消上。
6. 定向测试、编译、全局安装、restart、运行时 smoke 全通过并留证据。

## 2. 范围与边界

### In Scope
- Windsurf provider 认证/鉴权链
- Windsurf LS manager 抽象与生命周期管理
- provider 对 LS manager 的接入改造
- warmup / panel init / cascade start 的调用归位
- 对应单测、构建、安装、restart、runtime smoke
- 必要文档与 note/MEMORY 沉淀

### Out of Scope
- 不先重写 Router retry/reroute 策略
- 不先调 adaptive concurrency
- 不先做 key 冷却/失效 UI 展示增强
- 不先做多 provider 通用 LS 抽象
- 不把 cloud metadata client 当聊天主链替代

## 3. 设计原则
1. 单一路径真源：认证与 LS 主链严格对齐 WindsurfAPI。
2. 不做 fallback / 降级 / 静默恢复。
3. 先修 ownership，再谈 retry 症状。
4. provider 只做 auth/model/request orchestration，不持有 LS 生命周期真相。
5. LS readiness 是前置条件，不是 provider 内部临时 promise 补丁。
6. 修改必须最小闭环：实现、测试、编译、安装、restart、smoke 一次做完。

## 4. 技术方案

### 4.1 参考真源文档
- `docs/design/windsurf-auth-ls-mainline-alignment.md`
- `/Volumes/extension/code/WindsurfAPI/src/auth.js`
- `/Volumes/extension/code/WindsurfAPI/src/langserver.js`
- `/Volumes/extension/code/WindsurfAPI/src/client.js`
- `/Volumes/extension/code/WindsurfAPI/src/handlers/chat.js`
- `/Volumes/extension/code/WindsurfAPI/src/dashboard/windsurf-login.js`
- `/Volumes/extension/code/WindsurfAPI/src/windsurf-api.js`

### 4.2 文件清单
#### 新增
- `src/providers/core/runtime/windsurf-langserver-manager.ts`
- `tests/providers/core/runtime/windsurf-langserver-manager.spec.ts`

#### 重点修改
- `src/providers/core/runtime/windsurf-chat-provider.ts`
- `src/providers/core/contracts/windsurf-provider-contract.ts`
- `tests/providers/core/runtime/windsurf-chat-provider.spec.ts`
- `tests/server/runtime/http-server/request-executor.spec.ts`（如需补 5520 定向链路）
- `note.md`
- `MEMORY.md`（仅在结论稳定后追加）

### 4.3 实施结构
#### Slice A：LS manager 真源模块
实现 `WindsurfLangserverEntry`：
- `port`
- `csrfToken`
- `ready`
- `sessionId`
- `workspaceInitPromise`
- `generation`
- 需要时可带 `lastError/lastReadyAt`

实现能力：
- `ensureLs(...)`
- `waitPortReady(...)`
- `getLsFor(...)`
- `resetLsSession(...)`
- `ensureWorkspaceReady(...)`
- `ensureCascadeWarmup(...)`

#### Slice B：provider ownership 回收
把当前 provider 内：
- `cascadeWorkspaceInitPromise`
- `cascadeSessionId`
- 相关 reset/warmup 局部逻辑
迁移到 LS manager。

provider 只保留：
- 账号/密码/token 登录
- `sessionToken` 获取
- model 解析
- request body/messages 规范化
- 通过 LS manager 拿 ready entry 后发聊天请求

#### Slice C：认证链对齐
保持 token/邮箱密码两条入口，但统一在 provider 内汇聚为：
- `WindsurfSessionCredential { sessionToken -> apiKey }`

约束：
- 不允许把原始 password/token 混用为聊天阶段 apiKey 真值
- 不允许在 provider 后段再猜测式改 credential 语义

#### Slice D：contract 收缩
`windsurf-provider-contract.ts` 收缩错误对外面：
- `lsPort/csrfToken` 若保留，仅允许 debug override，不能再作为主路径语义
- 文档与注释必须明确“主链由 LS manager 持有”

#### Slice E：运行时验证
- 使用真实 5520 路由入口
- `routecodex restart --port 5520`
- 最小 non-stream / stream smoke
- 错误样本回放
- 对比日志确认错误点是否从 init ownership 问题迁移或消失

## 5. 风险与规避

### 风险 1：只抽文件，不改 ownership 真相
- 规避：必须物理删除 provider 内部 session/workspace 主状态持有。

### 风险 2：LS manager 只是转抄旧 provider 逻辑
- 规避：对齐 WindsurfAPI 的 `ensureLs/getLsFor/waitPortReady/warmupCascade` 结构，不做形式拆分。

### 风险 3：runtime 仍旧 same-provider 死循环掩盖主问题
- 规避：先以 init readiness 为验收关卡；retry/reroute 放后置。

### 风险 4：编译通过但 5520 运行时仍失败
- 规避：build/install/restart/smoke 必须全部做完，不允许只报单测通过。

## 6. 测试计划

### 单测
- `windsurf-langserver-manager.spec.ts`
  - entry 建立
  - ready/wait 行为
  - session reset
  - workspace init 幂等
- `windsurf-chat-provider.spec.ts`
  - provider 通过 LS manager 取 ready entry
  - 登录后 sessionToken 进入下游 metadata/apiKey
  - transport cancel 时 reset 交给 LS manager

### 集成/定向回归
- Windsurf provider 定向测试
- request executor 中 5520 定向链路 smoke（若现有 harness 支持）

### 构建与安装
- `npm run build:min`
- `npm run install:global`
- `routecodex --version`

### 运行时
- `routecodex restart --port 5520`
- `curl http://127.0.0.1:5520/v1/responses ...`
- 回放当前 `InitializeCascadePanelState canceled` 错误样本

## 7. 实施步骤
1. 复核 WindsurfAPI 真源并锁定结构。
2. 新增 `windsurf-langserver-manager.ts`。
3. 改造 `windsurf-chat-provider.ts` 接入 LS manager。
4. 收缩 contract 中错误 ownership 暴露。
5. 补单测与定向测试。
6. 编译与全局安装。
7. `routecodex restart --port 5520`。
8. 执行 smoke 与错误样本回放。
9. 把稳定结论写入 `MEMORY.md`，其余过程留 `note.md`。

## 8. 完成定义（DoD）
1. 代码层：provider 不再持有错误的 LS/session 主状态；LS manager 成为唯一真源。
2. 测试层：新增与修改测试全部通过。
3. 构建层：build/install 成功。
4. 运行层：5520 smoke 可跑，且不再复现当前首跳 `InitializeCascadePanelState` cancel 旧症状。
5. 文档层：design + goal plan + note/MEMORY 形成闭环。

## 9. 关联文档
- `docs/design/windsurf-auth-ls-mainline-alignment.md`
- `docs/goals/windsurf-auth-ls-mainline-alignment-plan.md`
