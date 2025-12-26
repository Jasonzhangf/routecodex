# OAuth Portal 启动时序问题修复

## 问题描述

在项目启动时，当需要检查 token 有效性并打开浏览器进行 OAuth 认证时，浏览器无法访问 Portal 页面 (`/token-auth/demo`)，导致 404 错误。

### 根本原因

**时序问题**: OAuth 认证流程在服务器 HTTP 路由注册之前就已经开始尝试打开浏览器。

具体流程：
1. Provider 初始化阶段（在路由注册之前）
   - `cli.ts` → `index.js` → 服务器初始化
   - Provider 初始化时检查 token 有效性
   - `ensureValidOAuthToken()` 被调用
   - 此时尝试打开浏览器访问 Portal URL

2. HTTP 路由注册阶段（在所有 provider 初始化完成之后）
   - `RouteCodexHttpServer.initialize()` 中调用 `registerHttpRoutes()`
   - 这时 `/token-auth/demo` 路由才被注册

3. **问题**: 浏览器打开的时候，`/token-auth/demo` 路由还不存在！

## 解决方案

采用 **方案 1 + 方案 2 组合**:

### 方案 1: 提前注册 OAuth Portal 路由

将 `/token-auth/demo` 路由从 `registerHttpRoutes()` 中分离出来，并在服务器构造函数中提前注册。

**修改的文件**:
- `src/server/runtime/http-server/routes.ts`
  - 新增 `registerOAuthPortalRoute()` 函数
  - 从 `registerHttpRoutes()` 中移除 Portal 路由注册
  
- `src/server/runtime/http-server/index.ts`
  - 在构造函数中调用 `registerDefaultMiddleware()` 和 `registerOAuthPortalRoute()`
  - 确保在任何 provider 初始化之前，这些关键路由已经可用

### 方案 2: 添加智能等待机制

在 OAuth 流程中，当使用 Portal URL 时，先检查服务器是否已就绪，再打开浏览器。

**修改的文件**:
- `src/providers/core/config/oauth-flows.ts`
  - 新增 `waitForPortalReady()` 方法
  - 在 `activateWithBrowser()` 中，如果使用 Portal URL，先调用 `waitForPortalReady()`
  - 最多等待 3 秒（15 次 × 200ms），通过 `/health` 端点检查服务器状态

## 实现细节

### 1. 分离 OAuth Portal 路由 (`routes.ts`)

```typescript
/**
 * Register OAuth Portal route early to support token authentication flow
 * This route must be available before provider initialization
 */
export function registerOAuthPortalRoute(app: Application): void {
  app.get('/token-auth/demo', (req: Request, res: Response) => {
    // ... Portal 页面实现 ...
  });
}
```

### 2. 提前注册路由 (`index.ts` 构造函数)

```typescript
constructor(config: ServerConfigV2) {
  // ... 其他初始化 ...
  
  // Register critical routes early (before provider initialization)
  // This ensures OAuth Portal is available when providers check token validity
  registerDefaultMiddleware(this.app);
  registerOAuthPortalRoute(this.app);
  console.log('[RouteCodexHttpServer] OAuth Portal route registered (early initialization)');
}
```

### 3. 智能等待机制 (`oauth-flows.ts`)

```typescript
protected async activateWithBrowser(...): Promise<void> {
  // ... 生成 Portal URL ...
  
  if (options.openBrowser !== false) {
    // If using Portal URL, ensure server is ready before opening browser
    if (portalUrl) {
      await this.waitForPortalReady(portalUrl);
    }
    
    // ... 打开浏览器 ...
  }
}

protected async waitForPortalReady(portalUrl: string): Promise<void> {
  const healthUrl = `${baseUrl}/health`;
  const maxAttempts = 15; // 最多尝试 15 次
  const delayMs = 200;    // 每次等待 200ms，总计最多 3 秒
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 尝试访问 /health 端点
    if (healthCheckSuccess) {
      console.log('[OAuth] Portal server is ready');
      return;
    }
    await delay(delayMs);
  }
  
  // 超时但继续执行（路由可能已经可用）
  console.warn('[OAuth] Portal server health check timed out, continuing anyway...');
}
```

## 效果

修复后的启动流程：

1. ✅ 服务器构造函数执行
   - 注册默认中间件
   - **提前注册 OAuth Portal 路由** ← 关键修复
   
2. ✅ Provider 初始化
   - 检查 token 有效性
   - 需要 OAuth 认证时：
     - **检查服务器是否就绪** ← 关键修复
     - 打开浏览器访问 Portal URL
     - ✅ Portal 路由已存在，用户看到认证页面

3. ✅ 其他 HTTP 路由注册
   - 注册业务路由（/v1/chat/completions 等）

4. ✅ 服务器监听端口

## 测试方法

### 手动测试

1. 启动服务器:
   ```bash
   routecodex start
   ```

2. 观察日志中是否有:
   ```
   [RouteCodexHttpServer] OAuth Portal route registered (early initialization)
   ```

3. 如果有 token 需要认证，观察日志中是否有:
   ```
   [OAuth] Portal server is ready
   Opening browser for authentication...
   Portal URL: http://127.0.0.1:5555/token-auth/demo?...
   ```

4. 浏览器应该能正常打开 Portal 页面，显示 token 信息

### 自动化测试

创建测试脚本验证路由可用性（需要服务器先启动）:

```bash
# 测试 health 端点
curl http://127.0.0.1:5555/health

# 测试 Portal 端点
curl "http://127.0.0.1:5555/token-auth/demo?provider=test&alias=test&oauthUrl=https://example.com&sessionId=test-123"
```

## 向后兼容性

- ✅ 完全向后兼容
- ✅ 不影响现有的 OAuth 流程
- ✅ 不影响现有的路由注册
- ✅ 只是提前了 Portal 路由的注册时机
- ✅ 增加了可选的服务器就绪检查（失败也不影响后续流程）

## 相关文件

### 修改的文件
1. `src/server/runtime/http-server/routes.ts` - 分离 OAuth Portal 路由
2. `src/server/runtime/http-server/index.ts` - 提前注册路由
3. `src/providers/core/config/oauth-flows.ts` - 添加就绪检查

### 影响的功能
- OAuth 认证流程
- 多 token 支持
- Token Portal 页面

## 注意事项

1. **中间件注册**: `registerDefaultMiddleware()` 也移到了构造函数中，避免重复注册
2. **健康检查**: 使用 `/health` 端点作为服务器就绪的判断标准
3. **超时处理**: 即使健康检查超时，也会继续打开浏览器（防止误报）
4. **日志输出**: 添加了详细的日志，便于调试时序问题

## 未来改进

1. 可以考虑将所有"关键路由"（如 `/health`, `/config`）也提前注册
2. 可以添加更精确的服务器启动状态跟踪
3. 可以在 Portal 页面上显示"等待服务器就绪"的进度提示
