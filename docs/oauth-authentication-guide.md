# Unified OAuth Authentication System Guide

## Overview

The Unified OAuth Authentication System provides a comprehensive solution for managing authentication across multiple AI service providers. It supports both static token files and dynamic OAuth 2.0 flows with automatic token refresh, PKCE security, and unified configuration management.

## Architecture

### Core Components

1. **OAuthConfigManager** - Centralized configuration management
2. **BaseOAuthManager** - Abstract base class for OAuth implementations
3. **Provider-specific Managers** - QwenOAuthManager and iFlowOAuthManager
4. **AuthResolver** - Unified token resolution supporting both static and OAuth
5. **UserConfigParser** - Extended to support OAuth configuration parsing

### Authentication Flow

```
Request → Provider → AuthResolver → OAuth Manager → Token Resolution → Response
```

## 🔐 iFlow OAuth 实现详解

### 核心流程概述

iFlow 的 OAuth 实现遵循 **"access_token → API Key → 实际请求"** 的两阶段模式：

1. **OAuth 认证阶段**：获取 `access_token` 和 `refresh_token`
2. **API Key 提取阶段**：用 `access_token` 调用 `getUserInfo` 获取真正的 `api_key`
3. **业务请求阶段**：所有后续 API 调用都使用 `api_key` 作为 `Authorization: Bearer <api_key>`

> ⚠️ **关键区别**：iFlow 的 `access_token` **只能**用来换取 API Key，**不能**直接作为鉴权凭证调用聊天完成接口。

### 详细流程步骤

#### 阶段1：OAuth 认证（获取 access_token）

```
用户授权 → 浏览器回调 → 授权码交换 → 获取 access_token + refresh_token
```

- **端点**：`https://iflow.cn/oauth/token`
- **流程**：标准 OAuth 2.0 授权码流程或设备码流程
- **输出**：`{ access_token, refresh_token, token_type, expires_in, scope }`

#### 阶段2：API Key 提取（getUserInfo 调用）

```
access_token → getUserInfo → api_key + email
```

- **端点**：`https://iflow.cn/api/oauth/getUserInfo?accessToken=<token>`
- **请求**：`GET` 请求，无额外 headers
- **响应**：`{ success: true, data: { apiKey: "sk-xxx", email: "user@mail", phone: "+86..." } }`
- **关键**：如果 `apiKey` 为空，整个流程失败（Fast-Fail 原则）

#### 阶段3：业务 API 调用（使用 api_key）

```
api_key → Authorization: Bearer <api_key> → 聊天完成接口
```

- **端点**：`https://apis.iflow.cn/v1/chat/completions`
- **鉴权**：`Authorization: Bearer sk-xxx`（**不是** access_token）
- **模型**：默认 `kimi`，支持模型列表需查阅 iFlow 官方文档

### 与 CLIProxyAPI 的对齐

我们的实现完全对齐 CLIProxyAPI 的 Go 版本逻辑：

| 步骤 | CLIProxyAPI (Go) | RouteCodex (TypeScript) |
|------|------------------|-------------------------|
| OAuth 认证 | `ExchangeCodeForTokens()` | `oauth-lifecycle.ts` 中的标准流程 |
| 获取 API Key | `FetchUserInfo()` → `apiKey` | `fetchIFlowUserInfo()` → `api_key` |
| 存储格式 | `IFlowTokenStorage` 结构体 | 相同字段名的 JSON 对象 |
| 鉴权方式 | `Authorization: Bearer <api_key>` | 完全一致 |
| 错误处理 | Fast-Fail，无隐藏回退 | 完全一致 |

### 代码实现位置

1. **OAuth 生命周期管理**：`src/modules/pipeline/modules/provider/v2/auth/oauth-lifecycle.ts`
   - 在 `ensureValidOAuthToken()` 中，iFlow 认证成功后会自动调用 `fetchIFlowUserInfo()`
   - 将返回的 `api_key` 和 `email` 合并到 token 数据中并重新保存

2. **API Key 提取逻辑**：`src/modules/pipeline/modules/provider/v2/auth/iflow-userinfo-helper.ts`
   - `fetchIFlowUserInfo()`：调用 `https://iflow.cn/api/oauth/getUserInfo`
   - `mergeIFlowTokenData()`：将 OAuth token 与用户信息合并

3. **认证提供者**：`src/modules/pipeline/modules/provider/v2/auth/tokenfile-auth.ts`
   - `TokenFileAuthProvider.buildHeaders()`：优先使用 `api_key`，回退到 `access_token`

4. **服务配置**：`src/modules/pipeline/modules/provider/v2/config/service-profiles.ts`
   - iFlow 默认端点：`https://apis.iflow.cn/v1/chat/completions`
   - 默认模型：`kimi`

### 使用示例

```typescript
// 1. 配置 iFlow OAuth
const iflowConfig = {
  type: 'openai-standard',
  config: {
    providerType: 'iflow',
    auth: {
      type: 'oauth'
      // 无需手动指定 clientId/secret，使用内置默认值
    }
  }
};

// 2. 首次使用会触发浏览器授权
const provider = new ChatHttpProvider(iflowConfig, dependencies);
await provider.initialize(); // → 打开浏览器 → 授权 → 获取 API Key

// 3. 后续使用直接读取本地 token 文件
// ~/.routecodex/auth/iflow-oauth.json 包含：
// {
//   "access_token": "...",
//   "refresh_token": "...",
//   "api_key": "sk-xxx",      // ← 实际用于 API 调用
//   "email": "user@mail.com",
//   "type": "iflow"
// }

// 4. 正常调用模型
const response = await provider.processIncoming({
  model: 'kimi',
  messages: [{ role: 'user', content: 'Hello iFlow!' }]
});
```

### 故障排查

| 问题 | 可能原因 | 解决方案 |
|------|----------|----------|
| `getaddrinfo ENOTFOUND iflow.cn` | DNS 解析失败 | 检查网络连接，确认 iFlow 服务状态 |
| `empty api key returned` | getUserInfo 未返回 apiKey | 确认 iFlow 账户已开通 API 权限 |
| `401 Unauthorized` | api_key 无效 | 重新走 OAuth 流程获取新的 api_key |
| `40308` 业务错误 | 使用了 access_token 而非 api_key | 确认 TokenFileAuthProvider 正确读取了 api_key 字段 |

### 环境变量

- `IFLOW_CLIENT_ID`：覆盖默认 clientId（高级用法）
- `IFLOW_CLIENT_SECRET`：覆盖默认 clientSecret（高级用法）
- `ROUTECODEX_OAUTH_AUTO_OPEN=0`：禁用自动打开浏览器（手动授权）

# Unified OAuth Authentication System Guide

## Overview

The Unified OAuth Authentication System provides a comprehensive solution for managing authentication across multiple AI service providers. It supports both static token files and dynamic OAuth 2.0 flows with automatic token refresh, PKCE security, and unified configuration management.

## Architecture

### Core Components

1. **OAuthConfigManager** - Centralized configuration management
2. **BaseOAuthManager** - Abstract base class for OAuth implementations
3. **Provider-specific Managers** - QwenOAuthManager and iFlowOAuthManager
4. **AuthResolver** - Unified token resolution supporting both static and OAuth
5. **UserConfigParser** - Extended to support OAuth configuration parsing

### Authentication Flow

```
Request → Provider → AuthResolver → OAuth Manager → Token Resolution → Response
