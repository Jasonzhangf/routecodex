# Windsurf Session 持久化与账号池实现计划

## 1. 目标与验收标准

### 1.1 目标
为 Windsurf provider 建立可持久化的 session 认证层、批量账号池与失效感知调度层；provider 不再把账号/session 状态保存在实例临时变量里，而是改为接入独立的持久化真源与账号池状态机。

### 1.2 验收标准
1. 进程重启后，若 `devinSessionToken` 仍有效，provider 不再重新走账号密码登录链，而是直接复用持久化 session。
2. 当某账号出现 `weekly quota exhausted` / `daily quota exhausted` 时，系统将该账号标记为 cooldown，并在 cooldown 期内不再选中；cooldown 至少按 24h 粒度检查恢复。
3. 当某账号出现 auth 失效（401、invalid email/password、invalid devin session token 等）时，系统将其标记为 auth-invalid，并触发单账号 refresh/login；refresh 失败时短时退避。
4. 当某账号只出现 runtime 故障（如 empty completion、ECONNRESET、pending stream canceled、上游连接取消）时，只重置 runtime/live state，不清空持久化 auth。
5. 同一 runtimeKey 下多个 Windsurf 账号能够形成候选池，支持轮转、sticky、cooldown、失效跳过。
6. 错误归一后，quota 类错误必须进入统一错误处理，不得直接把“原始 provider 失败”立刻回给客户端导致池切换失效。
7. 必须有红测锁定：
   - session 持久化复用
   - quota cooldown 跳过
   - auth invalid refresh
   - runtime reset 不影响 auth
   - sticky binding
   - 重启后可恢复 ban/cooldown 状态
8. build、定向测试、live smoke 全部通过。

## 2. 范围与边界

### 2.1 In Scope
- Windsurf provider 的 auth/session 持久化
- Windsurf 多账号池调度
- quota/auth/runtime 三类错误分类与状态迁移
- cooldown 持久化
- sticky account binding
- provider 对账号池层的接入
- 定向单测、provider 测试、live smoke

### 2.2 Out of Scope
- 公共 SSE 架构重构
- 非 Windsurf provider 的账号池复用抽象
- servertool 历史失败修复
- llmswitch-core router-wide 通用 quota manager 替换
- 新增 fallback / 降级 / 兜底链路

## 3. 设计原则
1. **单一真源**：账号/session/quota 状态真源独立于 provider 实例，不能继续堆在 `windsurf-chat-provider.ts` 的临时字段里。
2. **状态分层**：严格区分 auth、quota、runtime 三类状态，禁止混用一个“坏了就重登”的粗暴流程。
3. **No fallback**：失败必须显式分类；不能在 provider 内偷偷降级、吞错、双路径补偿。
4. **最小接入**：provider 只负责 request transform、send、response parse、error classify；账号池负责选号与状态迁移。
5. **先红后绿**：先补 store/pool/session-manager 的红测，再接 provider。
6. **持久化优先**：可持久化的只有认证态与账号健康态；live runtime 只做进程内状态。

## 4. 参考真源与已知事实
1. 参考实现：`/Volumes/extension/code/WindsurfAPI`
   - 登录链：`CheckUserLoginMethod -> password/login -> WindsurfPostAuth -> devin-session-token$...`
   - `devin-session-token$...` 才是长期持久化真源；临时会话态不得当成 provider 真源
2. RouteCodex 当前现状：
   - `src/providers/core/runtime/windsurf-chat-provider.ts`
   - 只有进程内：`windsurfSessionCredential` / `windsurfSessionCredentialPromise`
   - 重启后必然重新登录
3. 已验证现象：
   - 鉴权真相已收敛到：`token 优先 -> token 失败再账号密码登录 -> 成功后持久化 devin-session-token$...`
  - tool / history / continuity 的参考锚点来自 `WindsurfAPI` 的 cascade 语义转换层
   - 该计划只允许建立在 `chat -> provider -> local managed LS gRPC -> Cascade` 单一路径上
   - 禁止把账号池/持久化设计接成第二套实现

## 5. 总体方案

### 5.1 模块拆分
新增三层模块：

1. `src/providers/core/runtime/windsurf-account-store.ts`
   - 账号池持久化真源
   - 负责 load/save/atomic write/schema migration

2. `src/providers/core/runtime/windsurf-account-pool.ts`
   - 候选过滤
   - sticky binding
   - cooldown/auth/runtime 状态筛选
   - 选择下一个账号

3. `src/providers/core/runtime/windsurf-account-session-manager.ts`
   - 单账号 refresh/login 去重锁
   - runtime reset 协调
   - 将 provider 错误分类后回写状态机

provider 仅接入上述三层，不再自己成为状态真源。

### 5.2 推荐持久化路径
- 默认：`~/.rcc/state/windsurf/accounts.json`
- 要求：
  - 原子写入
  - schema version
  - 重启可恢复
  - 只保存必要敏感字段

### 5.3 数据模型

#### 持久化账号记录
```json
{
  "version": 1,
  "accounts": [
    {
      "keyAlias": "ws-pro-1",
      "email": "user@example.com",
      "accountId": "account-xxx",
      "passwordRef": "config:windsurf.ws-pro-1.password",
      "devinSessionToken": "...",
      "auth": {
        "status": "ready",
        "lastLoginAt": "2026-05-21T10:00:00.000Z",
        "lastAuthFailureAt": null,
        "lastAuthFailureReason": null
      },
      "quota": {
        "status": "ready",
        "cooldownUntil": null,
        "lastQuotaFailureAt": null,
        "lastQuotaFailureReason": null
      },
      "runtime": {
        "status": "ready",
        "lastRuntimeFailureAt": null,
        "lastRuntimeFailureReason": null,
        "backoffUntil": null
      },
      "routing": {
        "stickyScore": 0,
        "lastSelectedAt": null,
        "lastSuccessAt": null,
        "consecutiveFailures": 0
      }
    }
  ]
}
```

#### 进程内运行态
```ts
{
  runtimeKey: string,
  accountKey: string,
  cascadeSessionKey?: string,
  runtimeGeneration: number,
  runtimeReady: boolean,
  refreshPromise?: Promise<...>,
  runtimeResetPromise?: Promise<void>
}
```

### 5.4 状态机

#### Auth 状态
- `ready`
- `refreshing`
- `invalid`
- `backoff`

触发：
- 401 / invalid email or password / invalid devin session token
- postAuth hard auth failure

动作：
- 清理持久化 `devinSessionToken`
- 走一次受锁保护的登录刷新
- 成功后回写新 token
- 失败则短时 backoff（建议 10min）

#### Quota 状态
- `ready`
- `cooldown`

触发：
- weekly plan exhausted
- daily quota exhausted
- 其他明确 quota exhausted 信号

动作：
- 写入 `cooldownUntil`
- 默认 24h 后再试
- 每次选号时跳过 cooldown 中账号
- 到期后允许再探活一次

#### Runtime 状态
- `ready`
- `backoff`
- `resetting`

触发：
- empty completion
- ECONNRESET
- pending stream canceled
- cascade transport unavailable
- upstream transport canceled

动作：
- 仅重置 live runtime：当前请求相关的 cascade/runtime 临时态
- 不删持久化 `devinSessionToken`
- 短 backoff（30s~2min）后允许再试

## 6. Provider 接入策略

### 6.1 接入原则
`src/providers/core/runtime/windsurf-chat-provider.ts` 只保留：
- 请求构造
- 发送
- 响应解析
- 错误分类
- 调用 pool/session manager

不再承担：
- session 真源保存
- cooldown 真源保存
- 多账号轮转规则

### 6.2 请求前流程
1. 从 runtimeKey 获取账号池
2. 过滤掉：
   - auth backoff
   - quota cooldown
   - runtime backoff 未到期
3. 优先 sticky 账号
4. 否则按最近成功/失败数/轮询选号
5. 获取该账号的 session credential：
   - 有效 `devinSessionToken` 先复用
   - 无 token 或 token 失效再 refresh/login

### 6.3 请求后流程
- 成功：
  - 更新 `lastSuccessAt`
  - 清空 runtime failure streak
  - 维持 sticky
- quota exhausted：
  - 写 `quota.cooldownUntil`
  - 当前账号出池
  - 允许路由层继续切到下一个账号
- auth invalid：
  - 清 token
  - 标记 invalid/backoff
  - 触发 refresh
- runtime failure：
  - reset runtime
  - 标记短时 runtime backoff
  - 不清 auth

## 7. 错误分类规则

### 7.1 quota 类
命中任一文本/码即归类 quota：
- `weekly usage quota has been exhausted`
- `daily quota`
- `plan exhausted`
- 未来如有 trace/body code，也统一映射到 quota classifier

归一输出：
- provider 内部分类：`WINDSURF_WEEKLY_QUOTA_EXHAUSTED` / `WINDSURF_DAILY_QUOTA_EXHAUSTED`
- 对调度层语义：`quota_exhausted`
- 对客户端最终错误：如所有账号都 exhausted，再统一 429

### 7.2 auth 类
- 401
- `Invalid email or password`
- `devin session token not initialized`
- 明确 token invalid

### 7.3 runtime 类
- `windsurf cascade returned empty completion`
- `The pending stream has been canceled`
- `WINDSURF_SERVICE_UNREACHABLE`
- `ECONNRESET`
- transport canceled

## 8. sticky 与批量池调度策略

### 8.1 选择顺序
1. 若当前会话存在 sticky 账号且可用，优先继续用
2. 否则从可用候选中选：
   - 最近成功优先
   - 连续失败少优先
   - 长时间未使用优先作为轮询补偿
3. quota cooldown / auth backoff / runtime backoff 账号不参与候选

### 8.2 sticky 生命周期
- 成功请求后增强 sticky
- quota/auth 失败立即打断 sticky
- runtime failure 可短时保留 sticky，但若连续失败则移除

### 8.3 重启恢复
- sticky 本身可选持久化弱状态
- quota cooldown / auth invalid 必须持久化
- 这样重启后不会再次优先命中已 ban/已 exhausted 账号

## 9. 测试计划

### 9.1 红测优先顺序
1. `windsurf-account-store.spec.ts`
   - load/save/atomic write/schema version
   - 重启恢复 cooldown/auth 状态
2. `windsurf-account-pool.spec.ts`
   - cooldown 账号跳过
   - auth invalid 账号跳过
   - sticky 账号优先
   - 候选耗尽时返回明确错误
3. `windsurf-account-session-manager.spec.ts`
   - 单账号 refresh 去重
   - auth invalid -> refresh success/fail
   - runtime reset 不清 auth
4. `windsurf-chat-provider.spec.ts`
   - provider 成功接池
   - quota exhausted 后切下一个账号
   - 所有账号 exhausted 时统一 429
   - 重启后 ban 状态继续生效

### 9.2 回归
- 现有 `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 必须保持全绿
- Windsurf 工具调用 live 行为不得回退
- 不允许改坏 5520/5555 公共 SSE 契约

### 9.3 Live Smoke
1. 准备 3 个 ws-pro 账号
2. 验证：
   - 首次登录后生成持久化 state
   - 重启进程后复用 devinSessionToken
   - 手工注入 quota exhausted 状态后跳过账号 1，切到账号 2/3
   - auth invalid 时重新登录并恢复

## 10. 实施步骤
1. 写设计文档（本文）
2. 补 store/pool/session-manager 红测
3. 实现 `windsurf-account-store.ts`
4. 实现 `windsurf-account-pool.ts`
5. 实现 `windsurf-account-session-manager.ts`
6. provider 接入新层，删掉旧的 provider 内状态真源逻辑
7. 补 provider 接入回归
8. build
9. 全局安装
10. scoped restart（只用显式 port restart）
11. live smoke
12. 更新 `note.md` 与必要的 `MEMORY.md/skills` 精华

## 11. 风险与规避
1. **风险：把 runtime 故障误判成 auth 失效**
   - 规避：先文本/状态码分类，分类器单测锁死
2. **风险：重启后 state 丢失导致重复命中坏账号**
   - 规避：store 原子写 + 重启恢复测试
3. **风险：provider 接入时回退现有工具调用链**
   - 规避：保留现有 windsurf tool-calls 定向测试与 live smoke
4. **风险：多个并发请求触发重复登录**
   - 规避：session-manager 单账号 refresh promise 去重锁
5. **风险：错误直接回客户端，来不及切池**
   - 规避：先在 provider/pool 层消费可恢复错误，再决定是否把最终错误上抛

## 12. 完成定义（DoD）
满足以下条件才算完成：
1. 文档、测试、实现三者一致
2. 红测先失败再转绿
3. build 成功
4. 全局安装完成
5. scoped restart 后 live smoke 通过
6. 能证明：
   - session 可持久化复用
   - quota 会持久化 cooldown
   - auth 会自动 refresh
   - runtime 故障只 reset runtime
   - 多账号池能自动跳过失效账号并继续服务

## 13. 唯一性说明
本方向是唯一正确方向，因为当前问题不是单次请求格式问题，而是**账号/session 状态被错误地塞在 provider 实例临时内存中**，天然无法支持：
- 重启复用
- 多账号池
- quota ban 持久化
- auth/runtime 分类恢复
- sticky routing

因此唯一正确的修复面不是继续往 `windsurf-chat-provider.ts` 塞字段，而是建立独立账号池持久化真源，并让 provider 退回为薄接入层。
