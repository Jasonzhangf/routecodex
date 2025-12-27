# OAuth Callback 服务器修复

## 🔧 修复的问题

**问题**: 在 Google OAuth 认证完成后，浏览器重定向到 `http://localhost:8080/oauth2callback` 时显示 "ERR_CONNECTION_REFUSED"（连接被拒绝）。

**根本原因**:
1. 临时 HTTP 服务器启动时没有等待 `listen()` 回调完成
2. 服务器可能在接收 callback 前就关闭了（没有超时保护）
3. 缺少详细的错误处理和日志

## ✅ 实施的修复

### 1. 确保服务器完全启动

**修改前**:
```typescript
server.listen(port, host); // 没有等待回调
```

**修改后**:
```typescript
server.listen(port, host, () => {
  logOAuthDebug(`[OAuth] Callback server listening on ${host}:${port}${pathName}`);
  console.log(`[OAuth] Waiting for OAuth callback at http://${host}:${port}${pathName}`);
  console.log(`[OAuth] You have 10 minutes to complete the authentication in your browser`);
  
  // 设置 10 分钟超时保护
  timeoutHandle = setTimeout(() => {
    // 超时处理...
  }, 10 * 60 * 1000);
});
```

###  2. 添加10分钟超时保护

用户有足够的时间完成 Google 认证（包括 2FA、选择账户等）。超时后会清理资源并给出明确提示。

### 3. 改进错误处理

- **服务器错误**: 添加 `server.on('error')` 监听
- **端口占用**: 会捕获并报告
- **非 callback 请求**: 返回 404 但继续等待正确的 callback
- **状态不匹配**: 详细日志并优雅关闭

### 4. 详细日志输出

所有关键步骤都有日志：
- 服务器启动：`Callback server listening on...`
- 收到请求：`Callback server received request: ...`
- 成功接收：`Successfully received authorization code via callback`
- 错误情况：具体的错误消息

### 5. 改进用户体验

**成功页面**:
```html
<html><body>
  <h1>OAuth Success!</h1>
  <p>Authentication successful. You can close this window now.</p>
  <script>setTimeout(function(){window.close()},3000);</script>
</body></html>
```
- 显示成功消息
- 3秒后自动关闭窗口

## 🧪 测试步骤

### 1. 删除过期 Token 强制重新认证

```bash
# 备份现有 token
mv ~/.routecodex/auth/antigravity-oauth-1-geetasamodgeetasamoda.json \
   ~/.routecodex/auth/antigravity-oauth-1-geetasamodgeetasamoda.json.old

# 或者简单删除
rm ~/.routecodex/auth/antigravity-oauth-1-geetasamodgeetasamoda.json
```

### 2. 启动服务器

```bash
routecodex start
```

### 3. 观察日志

应该看到：
```
[RouteCodexHttpServer] OAuth Portal route registered (early initialization)
[RouteCodexHttpServer] Server started on 0.0.0.0:5555
Opening browser for authentication...
Portal URL: http://127.0.0.1:5555/token-auth/demo?...
[OAuth] Portal server is ready
[OAuth] Callback server listening on localhost:8080/oauth2callback
[OAuth] Waiting for OAuth callback at http://localhost:8080/oauth2callback
[OAuth] You have 10 minutes to complete the authentication in your browser
```

### 4. 浏览器中完成认证

1. ✅ 看到 Portal 页面
2. ✅ 点击 "Continue to OAuth"
3. ✅ 完成 Google 认证
4. ✅ 浏览器重定向到 localhost:8080
5. ✅ 看到 "OAuth Success!" 页面
6. ✅ 窗口 3 秒后自动关闭

### 5. 查看终端

应该看到：
```
[OAuth] Callback server received request: /oauth2callback?state=...&code=...
[OAuth] Successfully received authorization code via callback
[OAuth] [auth_code] Token saved to: ~/.routecodex/auth/antigravity-oauth-1-geetasamodgeetasamoda.json
```

### 6. 验证 Token 已保存

```bash
ls -lh ~/.routecodex/auth/antigravity-oauth-*.json
cat ~/.routecodex/auth/antigravity-oauth-1-geetasamodgeetasamoda.json | jq '.'
```

## 🔍 故障排查

### 如果仍然看到 "ERR_CONNECTION_REFUSED"

#### 1. 检查端口占用

```bash
# 查看 8080 端口是否被占用
lsof -ti :8080

# 如果有进程，查看详情
lsof -nP -i :8080

# 停止占用进程
kill $(lsof -ti :8080)
```

#### 2. 检查防火墙

```bash
# macOS 防火墙状态
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate

# 如果开启，临时允许 Node.js
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /opt/homebrew/bin/node
```

#### 3. 手动测试端口

在另一个终端：
```bash
# 测试 8080 端口是否响应
curl http://localhost:8080/test

# 如果服务器运行正常，应该返回 404 Not Found
# 如果连接被拒绝，说明服务器没有启动
```

#### 4. 查看详细日志

```bash
# 启动时启用调试日志
DEBUG_OAUTH=1 routecodex start 2>&1 | tee /tmp/oauth-debug.log
```

### 如果超时（10分钟后）

可能原因：
1. 网络太慢
2. Google 认证过程中断
3. 浏览器没有正确重定向

解决：
```bash
# 重新开始认证流程
routecodex stop
routecodex start
```

## 📊 修复前后对比

### 修复前 ❌

```
Opening browser for authentication...
[用户完成 Google 认证]
浏览器重定向...
ERR_CONNECTION_REFUSED  ← 服务器已关闭或未启动
Token 保存失败
```

### 修复后 ✅

```
Opening browser for authentication...
[OAuth] Callback server listening on localhost:8080/oauth2callback
[OAuth] Waiting for OAuth callback...
[OAuth] You have 10 minutes to complete the authentication

[用户完成 Google 认证]
浏览器重定向...
[OAuth] Successfully received authorization code via callback
OAuth Success!  ← 浏览器显示成功页面
Token saved to: ~/.routecodex/auth/...  ← Token 保存成功
```

## 🚀 现在可以测试

版本: **0.89.358 (dev build)**

修复包括：
- ✅ OAuth Portal 路由提前注册
- ✅ Portal 服务器就绪检查
- ✅ **Callback 服务器正确启动和保持运行**
- ✅ **10分钟超时保护**
- ✅ **详细错误处理和日志**
- ✅ **改进的成功页面**

请按照上面的测试步骤进行验证！
