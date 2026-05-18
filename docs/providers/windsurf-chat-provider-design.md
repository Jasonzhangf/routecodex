# WindsurfAPI Chat Provider 设计

本文定义 WindsurfAPI 在 RouteCodex 中的标准接入方案：
- WindsurfAPI 本身是本地 HTTP 服务（端口 3003），暴露 `/v1/chat/completions` 接口
- 目标是内建标准 provider，接入方式与直接 HTTP 上游一致
- 保持单执行路径：`HTTP server → llmswitch-core Hub Pipeline → Provider V2 → WindsurfAPI`
- 严格分层：Provider 做 transport；语义适配在 llmswitch-core compat

---

## 1. 设计目标

1. 将 WindsurfAPI 的 `/v1/chat/completions` 纳入 Provider V2。
2. 保证工具调用在标准响应面可消费：优先结构化 `tool_calls`，文本意图可选 fallback。
3. 错误与健康状态统一进入 `providerErrorCenter` / `errorHandlingCenter`。
4. 保证后续可观测、可回放、可灰度（same-shape + control replay）。

## 2. 非目标

1. 不把 WindsurfAPI 自身逻辑（账号池、gRPC、Language Server 管理）搬到 Provider 内部。
2. 不在 Provider 层做工具路由、语义修复、参数猜测。
3. 不在 Host/Provider 里复制 compat 的 fallback 逻辑。

## 3. 分层与职责边界

```
client
  │
  ▼
routecodex HTTP server
  │
  ▼
llmswitch-core Hub Pipeline
  │
  ├── compat (语义适配层)          ← 本文档范围到此截止
  │   ├── chat-windsurf-request    │ WindsurfAPI 非标字段 → 标准 Chat
  │   └── chat-windsurf-response   │ WindsurfAPI 非标响应 → 标准 SSE
  │
  └── provider (传输层)            ← 本文档范围到此截止
      └── windsurf-chat-provider   │ HTTP transport to WindsurfAPI
          │
          ▼
      WindsurfAPI (localhost:3003)
          │
          ▼
      Language Server (gRPC)
          │
          ▼
      Windsurf Cloud
```

### 3.1 RouteCodex Provider（传输层）

建议模块：
- `src/providers/core/runtime/windsurf-chat-provider.ts`
- `src/providers/auth/windsurf-account-auth.ts`（可选：复用 account auth 基类）

职责：
- HTTP 发送（stream/non-stream）到 WindsurfAPI
- 请求头注入（API Key、环境标识）
- 重试矩阵、上游错误映射
- 失败统一 `emitProviderError(...)`，不静默 fallback
- 健康检查（Ping WindsurfAPI `/health` 或 `/v1/models`）

**禁止**：
- 工具调用提取/补全
- route/tool_choice 决策
- payload 语义清洗（messages/tool args 语义）
- 管理 Windsurf 账号池、Language Server 进程

### 3.2 llmswitch-core Compat（语义适配层）

建议模块：
- `sharedmodule/llmswitch-core/src/conversion/compat/profiles/chat-windsurf.json`
- `sharedmodule/llmswitch-core/src/conversion/compat/actions/windsurf-request.ts`
- `sharedmodule/llmswitch-core/src/conversion/compat/actions/windsurf-response.ts`

职责：
- 请求侧：标准 Chat 形状 → WindsurfAPI 非标字段（如有）
- 响应侧：WindsurfAPI 非标响应 → 标准 assistant / SSE / tool_calls
- 处理 WindsurfAPI 特有关系：
  - Cascade 模型工具调用的 `<tool_use>` 标签提取
  - GPT 模型的 `gpt_native` 方言适配
  - 文本工具意图 fallback（受配置开关/strict 约束）
  - 路径泄漏清理（`/tmp/windsurf-workspace` 等）

**禁止**：
- HTTP 请求发送
- 认证与 API Key 管理
- provider transport 重试策略

## 4. WindsurfAPI Chat 协议分析

### 4.1 标准 Chat 字段支持

WindsurfAPI 的 `/v1/chat/completions` 完全兼容 OpenAI Chat 格式：

```json
{
  "model": "gpt-5.1-high",
  "messages": [
    {"role": "system", "content": "你是一个助手"},
    {"role": "user", "content": "你好"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "获取天气",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}
      }
    }
  ],
  "stream": true
}
```

### 4.2 WindsurfAPI 非标字段

WindsurfAPI 在标准 Chat 格式上增加的字段（由 `src/handlers/chat.js` 处理）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `thinking` | boolean | 启用推理模式（Opus/Sonnet 的 thinking 功能） |
| `reasoning_effort` | string | GPT 模型 reasoning 等级（xhigh/high/medium/low） |
| `cascade_id` | string | Cascade 会话复用 ID（由服务端管理） |
| `tool_choice` | string/object | 工具选择策略（auto/required/none/特定函数） |
| `user` | string | 终端用户标识（用于速率限制隔离） |

### 4.3 WindsurfAPI 响应非标特征

WindsurfAPI 基于标准 Chat 格式，但在以下方面有非标行为（由 `src/handlers/chat.js` 处理）：

| 特征 | 说明 | Compat 处理 |
|------|------|------------|
| 模型身份 | 响应中模型名可能为 `claude-sonnet-4.6` 而非 `gpt-5.1` | 透传上游模型名 |
| 工具调用 | Claude 家族走 `<tool_use>` 协议，GPT 家族走 `gpt_native` 方言 | compat 统一为 `tool_calls` |
| 路径泄漏 | Cascade 工具执行路径如 `/tmp/windsurf-workspace/` | compat 做路径清理 |
| 模型自称 | 模型自称 "我是 Claude 由 Anthropic 开发" 而非 "我是 GPT" | compat 可选项：保留或替换身份声明 |
| 流式结束 | SSE `[DONE]` 标记可能存在多阶段结束 | compat 处理多阶段 `[DONE]` |

## 5. 多账号体系设计

### 5.1 WindsurfAPI 账号类型

WindsurfAPI 支持三种账号等级：

| 等级 | 标识 | RPM | 可用模型 |
|------|------|-----|---------|
| **Pro** | `pro` | 60 | GPT-5 全系、Claude 4 全系、Gemini 等 |
| **Trial** | `trial` | 20 | 同 Pro，配额有限 |
| **Free** | `free` | 10 | 仅限免费模型（Gemini 2.5-flash、GLM-4.7 等） |

### 5.2 账号凭据格式

WindsurfAPI 使用 Windsurf Token 作为认证凭据：

```jsonc
{
  "accounts": [
    {
      "alias": "pro-1",
      "type": "windsurf-account",
      "token": "${WINDSURF_TOKEN_PRO_1}",        // 环境变量引用
      "tier": "pro",
      "tierManual": false                         // 是否手动设置 tier
    },
    {
      "alias": "free-1",
      "type": "windsurf-account",
      "token": "${WINDSURF_TOKEN_FREE_1}",
      "tier": "free",
      "tierManual": true                          // 手动指定为 free
    }
  ]
}
```

### 5.3 Provider 层账号管理

WindsurfAPI 的账号管理由 WindsurfAPI 服务自身负责（通过 `accounts.json`），Provider 层只需配置 API Key：

```typescript
// src/providers/auth/windsurf-account-auth.ts（可选：复用 account auth 基类）
export interface WindsurfAccountAuthConfig {
  type: 'windsurf-account';
  accounts: WindsurfAccountEntry[];
}

export interface WindsurfAccountEntry {
  alias: string;
  token: string | null;        // 支持 null（表示使用共享账号池）
  tier?: 'pro' | 'trial' | 'free';
  tierManual?: boolean;
  tokenFile?: string;          // 引用外部 token 文件
}
```

**注意**：Provider 层只负责传递认证信息，不负责账号池管理、轮询、速率限制等逻辑。这些由 WindsurfAPI 服务自身处理。

### 5.4 账号轮询策略

WindsurfAPI 内部实现：
- **加权轮询**：优先选择配额充足的账号（基于 `quotaScore`）
- **RPM 限制**：按 tier 分级限制（Pro 60 RPM、Free 10 RPM）
- **速率限制检测**：`_rpmHistory` 滑动窗口追踪请求频率
- **干旱模式**：当所有账号都耗尽时触发，拒绝新请求而非继续尝试
- **故障转移**：账号不可用时自动切换到下一个

Provider 层**无需**复制这些逻辑，只需配置正确的认证信息。

## 6. Provider 类型定义

### 6.1 类型注册

```typescript
// src/providers/core/api/provider-types.ts
export type ProviderType =
  | 'openai'
  | 'responses'
  | 'anthropic'
  | 'gemini'
  | 'mimoweb'
  | 'mock'
  | 'windsurf';  // 新增

// src/providers/core/api/provider-config.ts
export type OpenAIStandardConfig['type'] =
  | 'openai-standard'
  | 'openai-http-provider'
  | 'responses-http-provider'
  | 'anthropic-http-provider'
  | 'gemini-http-provider'
  | 'deepseek-http-provider'
  | 'mimoweb-provider'
  | 'qwenchat-web-provider'
  | 'mock-provider'
  | 'windsurf-chat-provider';  // 新增
```

### 6.2 WindsurfAPI 扩展配置

```typescript
// src/providers/core/contracts/windsurf-provider-contract.ts（新建）
export interface WindsurfProviderOverrides {
  // 推理模式
  enableThinking?: boolean;
  defaultReasoningEffort?: 'xhigh' | 'high' | 'medium' | 'low';

  // 响应处理
  sanitizePaths?: boolean;
  preserveUpstreamIdentity?: boolean;

  // 工具调用
  toolEmulationStrict?: boolean;

  // 健康检查
  healthCheckEndpoint?: '/health' | '/v1/models';
  healthCheckTimeoutMs?: number;
}
```

## 7. 配置草案（示意）

```jsonc
{
  "virtualrouter": {
    "providers": {
      "windsurf-chat": {
        "id": "windsurf-chat",
        "enabled": true,
        "type": "openai",
        "providerModule": "windsurf-chat-provider",
        "compatibilityProfile": "chat:windsurf",
        "baseURL": "http://localhost:3003",       // WindsurfAPI 服务地址
        "auth": {
          "type": "windsurf-account",
          "accounts": [
            {
              "alias": "pro-1",
              "tokenFile": "~/.rcc/auth/windsurf-pro-1.json",
              "tier": "pro"
            },
            {
              "alias": "pro-2",
              "tokenFile": "~/.rcc/auth/windsurf-pro-2.json",
              "tier": "pro"
            },
            {
              "alias": "free-1",
              "tokenFile": "~/.rcc/auth/windsurf-free-1.json",
              "tier": "free",
              "tierManual": true
            }
          ]
        },
        "models": [
          "gpt-5.1-high",
          "gpt-5.1-medium",
          "gpt-5.2-xhigh",
          "gpt-5.4-high",
          "claude-sonnet-4.6",
          "claude-opus-4.7-medium"
        ],
        "extensions": {
          "windsurf": {
            "enableThinking": true,
            "defaultReasoningEffort": "high",
            "sanitizePaths": true,
            "preserveUpstreamIdentity": false,
            "toolEmulationStrict": true,
            "healthCheckEndpoint": "/v1/models",
            "healthCheckTimeoutMs": 5000
          }
        }
      }
    }
  }
}
```

说明：
- `type` 使用标准 `openai`，因为 WindsurfAPI 对外的 `/v1/chat/completions` 接口完全兼容 OpenAI Chat 协议。
- `providerModule: "windsurf-chat-provider"` + `compatibilityProfile: "chat:windsurf"` 表达家族差异。
- **账号配置**：通过 `tokenFile` 引用外部 token 文件，支持多账号轮询。
- WindsurfAPI 独有的扩展配置放在 `extensions.windsurf` 下。

## 8. Provider 实现概要

### 8.1 类层次

```typescript
// src/providers/core/runtime/windsurf-chat-provider.ts
import { HttpTransportProvider } from './http-transport-provider.js';

export class WindsurfChatProvider extends HttpTransportProvider {
  constructor(
    config: OpenAIStandardConfig,
    dependencies: ModuleDependencies
  ) {
    super(config, dependencies, 'windsurf-chat-provider');
  }

  protected override getServiceProfile(): ServiceProfile {
    const base = super.getServiceProfile();
    return {
      ...base,
      defaultEndpoint: '/v1/chat/completions',
      supportsTools: true,
      supportsVision: true,
      supportsThinking: true,  // Opus/Sonnet 的 thinking 功能
      streamingModes: ['sse']
    } as ServiceProfile;
  }

  protected override async checkHealth(): Promise<boolean> {
    // 使用 /v1/models 端点检查健康状态
    const endpoint = this.config.extensions?.windsurf?.healthCheckEndpoint ?? '/v1/models';
    const timeout = this.config.extensions?.windsurf?.healthCheckTimeoutMs ?? 5000;
    return this.performHealthCheck(endpoint, timeout);
  }
}
```

### 8.2 实例化注册

```typescript
// src/providers/core/runtime/provider-factory-helpers.ts
import { WindsurfChatProvider } from './windsurf-chat-provider.js';

export function mapProviderModule(providerType: ProviderType): OpenAIStandardConfig['type'] {
  // ... 现有代码 ...
  if (providerType === 'windsurf') {
    return 'windsurf-chat-provider';
  }
  return 'openai-http-provider';
}

export function instantiateProvider(...) {
  // ... 现有代码 ...
  if (moduleType === 'windsurf-chat-provider') {
    return new WindsurfChatProvider(config, dependencies);
  }
}
```

## 9. Compat 适配要点

### 9.1 请求适配（windsurf-request.ts）

```typescript
// sharedmodule/llmswitch-core/src/conversion/compat/actions/windsurf-request.ts

export function adaptChatRequestToWindsurf(
  standardRequest: OpenAIChatRequest,
  config: WindsurfProviderOverrides
): WindsurfChatRequest {
  const adapted = { ...standardRequest };

  // 1. 转换 thinking 字段
  if (adapted.reasoning_effort && !adapted.thinking) {
    adapted.thinking = true;
  }

  // 2. 模型名映射（如需要）
  //    标准 Chat 可能使用 gpt-5.1，WindsurfAPI 可能需要 gpt-5.1-high
  //    或者由 Hub Pipeline 的路由层处理模型选择

  // 3. 保留其他标准字段不变
  return adapted;
}
```

### 9.2 响应适配（windsurf-response.ts）

```typescript
// sharedmodule/llmswitch-core/src/conversion/compat/actions/windsurf-response.ts

export function adaptWindsurfResponseToStandard(
  response: WindsurfChatResponse,
  config: WindsurfProviderOverrides
): OpenAIChatResponse {
  const adapted = { ...response };

  // 1. 模型身份处理
  if (!config.preserveUpstreamIdentity) {
    adapted.model = mapToRequestedModel(adapted.model);
  }

  // 2. 工具调用标准化
  for (const choice of adapted.choices) {
    if (choice.message?.tool_calls) {
      choice.message.tool_calls = normalizeToolCalls(choice.message.tool_calls);
    }
  }

  // 3. 路径清理
  if (config.sanitizePaths) {
    adapted.choices.forEach(choice => {
      if (choice.message?.content) {
        choice.message.content = sanitizePaths(choice.message.content);
      }
    });
  }

  return adapted;
}
```

### 9.3 工具调用状态机

| 状态 | 说明 | Compat 处理 |
|------|------|------------|
| `native_tool_calls` | 上游已返回结构化 `tool_calls` | 字段映射、id 补齐、参数校验 |
| `text_tool_calls` | 上游以文本协议返回（GPT native 方言） | 解析为结构化 `tool_calls` |
| `no_tool_calls` | 无法识别工具调用 | 返回普通文本 |

### 9.4 Strict 策略

若 `tool_choice=required` 且最终状态为 `no_tool_calls`：
- compat 抛显式错误（fail-fast）
- provider 不兜底为普通文本成功

## 10. 错误分类与重试策略（Provider）

### 10.1 不重试（直接 fail-fast）

- 认证失败（401/403）
- 合同失败（4xx，如必填字段/格式错误）
- compat 显式错误（如 strict tool required）
- 账号耗尽（所有账号 rate limit）

### 10.2 可重试（有限次）

- 网络抖动 / 超时
- 5xx 上游故障
- WindsurfAPI 服务瞬态不可用

### 10.3 统一上报字段

每次错误事件应包含：
- `requestId`
- `providerId` / `providerKey` / `providerProtocol`
- `model` / `route`
- `statusCode` / `upstreamCode`
- `processingTime`

## 11. 可观测与回放

### 11.1 请求级追踪

- `requestId` 全链路透传
- 记录 provider runtime key（不暴露敏感值）
- 工具归一化日志：`source=native|fallback`、`parse_ok`、`schema_ok`

### 11.2 回放要求

每次兼容行为修改后必须提供：
1. 目标 provider same-shape replay（1 例）
2. 非目标 provider control replay（1 例）

## 12. 里程碑

### M1（设计冻结）

- 冻结配置字段、错误码、观测字段、strict/fallback 开关定义
- 产物：本文档 + 合同文件
  - `src/providers/core/contracts/windsurf-provider-contract.ts`
  - `src/providers/core/api/provider-config.ts`（windsurf-chat-provider 类型）
  - `src/providers/core/api/provider-types.ts`（windsurf 类型）

### M2（Provider Skeleton）

- 落地 `windsurf-chat-provider.ts` runtime
- 打通 non-stream / stream
- 接入 provider error 上报
- 完成账号认证配置解析

### M3（Compat + Tool Calling）

- 落地 `chat:windsurf` profile 与 request/response actions
- 完成工具调用三态与 strict 策略
- 增加回归脚本并完成 replay 证据

## 13. 验证命令（按双仓顺序）

1. `sharedmodule/llmswitch-core`: `npm run build`
2. `routecodex`: `npm run build:dev`
3. `routecodex`: `npm run install:global`
4. provider 定向脚本：`scripts/provider-windsurf-*`（M2/M3 新增）
5. replay：same-shape + control provider

## 14. 与现有 Providers 的对比

| 维度 | DeepSeek Web | WindsurfAPI |
|------|-------------|-------------|
| provider 类型 | `openai` | `openai` |
| providerModule | `deepseek-http-provider` | `windsurf-chat-provider` |
| compatibilityProfile | `chat:deepseek-web` | `chat:windsurf` |
| 协议 | 非标 Chat Web | 标准 Chat |
| 传输 | HTTP → DeepSeek Web | HTTP → WindsurfAPI → gRPC → Cascade |
| auth | 账户文件 | 账户文件（tokenFile） |
| 工具调用 | 文本协议 | 原生 tool_calls |
| 账号管理 | Provider 管理 | WindsurfAPI 管理 |
| tier 支持 | 无 | Pro/Trial/Free |
| RPM 限制 | 无 | 按 tier 分级 |

---

> **文档范围声明**：本文档涵盖 Provider 层和 Compat 层的设计，不涉及：
> - WindsurfAPI 自身的部署、运维、账号管理
> - Language Server 二进制管理
> - Cascade 协议细节
> - Hub Pipeline 的路由策略

---

*最后更新: 2026-05-17*
