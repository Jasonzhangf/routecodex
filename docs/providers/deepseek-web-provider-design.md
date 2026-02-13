# DeepSeek Web 原生标准 Provider 设计（对标 antigravity）

本文定义 DeepSeek Web 在 RouteCodex 中的标准接入方案：
- 目标是 **内建标准 provider**（不是 sidecar / 反向代理进程依赖）
- 保持单执行路径：`HTTP server -> llmswitch-core Hub Pipeline -> Provider V2 -> upstream`
- 严格分层：Provider 做 transport；工具语义在 llmswitch-core compat

---

## 1. 设计目标

1. 将 DeepSeek Web 登录/会话/PoW/completion 纳入 Provider V2。
2. 保证工具调用在标准响应面可消费：优先结构化 `tool_calls`，文本意图可选 fallback。
3. 错误与健康状态统一进入 `providerErrorCenter` / `errorHandlingCenter`。
4. 保证后续可观测、可回放、可灰度（same-shape + control replay）。

## 2. 非目标

1. 不把 `deepseek2api` 作为 routecodex 上游依赖。
2. 不在 Provider 层做工具路由、语义修复、参数猜测。
3. 不在 Host/Provider 里复制 compat 的 fallback 逻辑。

## 3. 分层与职责边界

### 3.1 RouteCodex Provider（传输层）

建议模块：
- `src/providers/core/runtime/deepseek-http-provider.ts`
- `src/providers/auth/deepseek-account-auth.ts`
- `src/providers/core/runtime/deepseek-session-pow.ts`

职责：
- auth（tokenFile 读取/热更新、header 注入）
- session（会话创建/复用）
- PoW（challenge 获取、求解、超时控制）
- HTTP 发送（stream/non-stream）、重试矩阵、上游错误映射
- 失败统一 `emitProviderError(...)`，不静默 fallback

禁止：
- 工具调用提取/补全
- route/tool_choice 决策
- payload 语义清洗（messages/tool args 语义）

### 3.2 llmswitch-core Compat（语义适配层）

建议模块：
- `sharedmodule/llmswitch-core/src/conversion/compat/profiles/chat-deepseek-web.json`
- `sharedmodule/llmswitch-core/src/conversion/compat/actions/deepseek-web-request.ts`
- `sharedmodule/llmswitch-core/src/conversion/compat/actions/deepseek-web-response.ts`

职责：
- 请求侧：OpenAI/Responses 形状 -> DeepSeek Web 合同字段
- 响应侧：DeepSeek Web 形状 -> 标准 assistant / SSE / tool_calls
- tool_call_id 标准化（无 id 时生成稳定 id）
- 文本工具意图 fallback（受配置开关/strict 约束）

禁止：
- HTTP 请求发送
- 认证与 token 管理
- provider transport 重试策略

## 4. 配置草案（示意）

```jsonc
{
  "virtualrouter": {
    "providers": {
      "deepseek-web": {
        "id": "deepseek-web",
        "enabled": true,
        "type": "openai",
        "providerModule": "deepseek-http-provider",
        "compatibilityProfile": "chat:deepseek-web",
        "baseURL": "https://chat.deepseek.com",
        "auth": {
          "type": "deepseek-account",
          "entries": [
            {
              "alias": "1",
              "type": "deepseek-account",
              "tokenFile": "~/.routecodex/auth/deepseek-account-1.json"
            }
          ]
        },
        "deepseek": {
          "strictToolRequired": true,
          "textToolFallback": true,
          "powTimeoutMs": 15000,
          "sessionReuseTtlMs": 1800000
        }
      }
    }
  }
}
```

说明：
- `type` 继续使用标准 `openai`，家族差异通过 `providerModule` + `compatibilityProfile` 表达。
- 凭据通过 `tokenFile` 引用（`deepseek-account-*.json`），支持多账号轮转，不把明文回写到配置。

## 5. 工具调用状态机（Compat 单一实现）

### 5.1 状态定义

1. `native_tool_calls`
   - 上游已返回结构化工具调用
   - compat 做字段映射、id 补齐、参数 JSON 合法性校验
2. `text_tool_calls`
   - 上游仅返回文本工具意图
   - compat 解析并生成标准 `tool_calls`
3. `no_tool_calls`
   - 无法识别工具调用

### 5.2 严格策略

- 若 `tool_choice=required` 且最终状态为 `no_tool_calls`：
  - compat 抛显式错误（fail-fast）
  - provider 不兜底为普通文本成功

### 5.3 单一真相源

- fallback 解析器仅在 `deepseek-web-response.ts` 维护。
- Host / Provider 不复制解析规则，避免双实现漂移。

## 6. 错误分类与重试策略（Provider）

### 6.1 不重试（直接 fail-fast）

- 认证失败（401/403）
- 合同失败（4xx，如必填字段/格式错误）
- compat 显式错误（如 strict tool required）

### 6.2 可重试（有限次）

- 网络抖动 / 超时
- 5xx 上游故障
- PoW 挑战服务短暂失败（带总超时）

### 6.3 统一上报字段

每次错误事件应包含：
- `requestId`
- `providerId` / `providerKey` / `providerProtocol`
- `model` / `route`
- `statusCode` / `upstreamCode`
- `processingTime`

## 7. 可观测与回放

### 7.1 请求级追踪

- `requestId` 全链路透传
- 记录 provider runtime key 与 session key（不暴露敏感值）
- tool 归一化日志：`source=native|fallback`、`parse_ok`、`schema_ok`

### 7.2 回放要求

每次兼容行为修改后必须提供：
1. 目标 provider same-shape replay（1 例）
2. 非目标 provider control replay（1 例）

## 8. 里程碑

### M1（设计冻结）

- 冻结配置字段、错误码、观测字段、strict/fallback 开关定义
- 产物：本文档 + `routecodex-132` 及子任务
- M1 合同落盘（当前仓）：
  - `src/providers/core/contracts/deepseek-provider-contract.ts`
  - `src/providers/core/api/provider-config.ts`
  - `src/providers/core/api/provider-types.ts`
  - `src/providers/profile/provider-profile-loader.ts`

### M2（Provider Skeleton）

- 落地 provider/auth/session/pow runtime
- 打通 non-stream / stream
- 接入 provider error 上报

### M3（Compat + Tool Calling）

- 落地 `chat:deepseek-web` profile 与 request/response actions
- 完成工具调用三态与 strict 策略
- 增加回归脚本并完成 replay 证据

## 9. 验证命令（按双仓顺序）

1. `sharedmodule/llmswitch-core`: `npm run build`
2. `routecodex`: `npm run build:dev`
3. `routecodex`: `npm run install:global`
4. provider 定向脚本：`scripts/provider-deepseek-*`（M2/M3 新增）
5. replay：same-shape + control provider
