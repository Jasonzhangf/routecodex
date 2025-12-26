# OAuth Portal 修复总结

## ✅ 已完成修复

### 问题
启动时打不开 OAuth Portal 页面 (`/token-auth/demo`)，浏览器访问时返回 404。

### 根本原因
Provider 初始化（需要 OAuth 认证）发生在 HTTP 路由注册之前，导致浏览器打开时路由还不存在。

### 解决方案

#### 1. 提前注册 OAuth Portal 路由
- ✅ 从 `registerHttpRoutes()` 中分离出 `registerOAuthPortalRoute()`
- ✅ 在服务器构造函数中提前注册该路由和默认中间件
- ✅ 确保在 Provider 初始化之前路由已可用

#### 2. 添加智能等待机制  
- ✅ 新增 `waitForPortalReady()` 方法
- ✅ 在打开浏览器前检查服务器是否就绪（通过 `/health` 端点）
- ✅ 最多等待 3 秒（15 次 × 200ms），防止竞态条件

### 修改的文件

1. **src/server/runtime/http-server/routes.ts**
   - 新增 `registerOAuthPortalRoute()` 函数
   - 更新 `registerHttpRoutes()` 避免重复注册

2. **src/server/runtime/http-server/index.ts**
   - 导入 `registerOAuthPortalRoute`
   - 在构造函数中提前注册关键路由
   - 更新 `initialize()` 避免重复注册中间件

3. **src/providers/core/config/oauth-flows.ts**
   - 新增 `waitForPortalReady()` 方法
   - 更新 `activateWithBrowser()` 添加就绪检查

### 测试方法

启动服务器后，观察日志应包含：
```
[RouteCodexHttpServer] OAuth Portal route registered (early initialization)
```

当触发 OAuth 认证时：
```
[OAuth] Portal server is ready
Opening browser for authentication...
Portal URL: http://127.0.0.1:5555/token-auth/demo?...
```

手动测试：
```bash
# 确保服务器运行
routecodex start

# 测试 Portal 端点
curl "http://127.0.0.1:5555/token-auth/demo?provider=test&alias=test&oauthUrl=https://example.com"
```

### 预期结果

- ✅ 浏览器能正常打开 Portal 页面
- ✅ Portal 页面显示 provider、alias、token file 等信息
- ✅ 点击 "Continue to OAuth" 按钮后正确跳转到上游 OAuth URL
- ✅ 完全向后兼容，不影响现有流程

## 📝 相关文档

详细技术文档: [docs/fixes/oauth-portal-timing-fix.md](./oauth-portal-timing-fix.md)

---
修复完成时间: 2025-12-26
