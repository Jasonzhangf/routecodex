# OAuth Portal 修复测试指南

## ✅ 构建和安装已完成

- **版本**: 0.89.354
- **安装位置**: `/opt/homebrew/bin/routecodex`
- **构建时间**: 2025-12-26 19:58

## 🧪 测试步骤

### 1. 检查已安装的版本

```bash
which routecodex
# 应该显示: /opt/homebrew/bin/routecodex

ls -la /opt/homebrew/bin/routecodex
# 确认是最新的符号链接
```

### 2. 启动服务器并观察日志

```bash
# 确保之前的服务器已停止
routecodex stop

# 启动服务器
routecodex start
```

**关键日志检查点**:

✅ **步骤 1**: 查找提前注册路由的日志
```
[RouteCodexHttpServer] Initialized (pipeline=hub)
[RouteCodexHttpServer] OAuth Portal route registered (early initialization)
```
👆 这表明 OAuth Portal 路由已在 Provider 初始化前注册

✅ **步骤 2**: Provider 初始化时查找 OAuth 流程日志
```
[provider-xxxx] initialization-start
[provider-xxxx] oauth-init-start
```

✅ **步骤 3**: 如果需要 OAuth 认证，应该看到
```
[OAuth] Portal server is ready          <-- 新增的就绪检查
Opening browser for authentication...
Portal URL: http://127.0.0.1:5555/token-auth/demo?...
OAuth URL: https://accounts.google.com/...
```

✅ **步骤 4**: 服务器启动完成
```
✔ RouteCodex server starting on 0.0.0.0:5555
[RouteCodexHttpServer] Server started on 0.0.0.0:5555
```

### 3. 手动验证 Portal 端点

在服务器启动后，打开新终端运行：

```bash
# 测试 health 端点
curl http://127.0.0.1:5555/health

# 测试 OAuth Portal 端点
curl "http://127.0.0.1:5555/token-auth/demo?provider=test&alias=test-alias&tokenFile=~/test.json&oauthUrl=https://example.com&sessionId=test-123"
```

应该返回完整的 HTML 页面，包含：
- "RouteCodex Token Auth Demo" 标题
- Provider、Alias、Token file 信息
- "Continue to OAuth" 按钮

### 4. 运行自动化验证脚本

```bash
cd /Users/fanzhang/Documents/github/routecodex
./verify-oauth-portal-fix.sh
```

应该看到：
```
✅ Health 端点可访问
✅ OAuth Portal 端点可访问
   ✓ HTML 标题正确
   ✓ Provider 信息显示正确
   ✓ Alias 信息显示正确
   ✓ OAuth 按钮存在
```

### 5. 测试实际 OAuth 流程

如果你有配置需要 OAuth 认证的 provider（如 antigravity, iflow 等）：

```bash
# 删除或重命名现有 token 文件，强制重新认证
mv ~/.routecodex/auth/antigravity-oauth-2-geetasamodgeetasamoda.json \
   ~/.routecodex/auth/antigravity-oauth-2-geetasamodgeetasamoda.json.bak

# 重启服务器触发 OAuth 流程
routecodex stop
routecodex start
```

**期望结果**:
1. 服务器启动后检测到 token 无效/不存在
2. 显示 `[OAuth] Portal server is ready`
3. 浏览器自动打开，显示 Portal 页面
4. Portal 页面正确显示 provider 和 alias 信息
5. 点击"Continue to OAuth"后跳转到上游 OAuth 页面
6. 完成认证后，token 保存成功

### 6. 检查修复前后的区别

**修复前** (❌ 问题):
```
Opening browser for authentication...
Portal URL: http://127.0.0.1:5555/token-auth/demo?...
```
👆 浏览器打开，但显示 404 错误（路由还未注册）

**修复后** (✅ 正常):
```
[OAuth] Portal server is ready          <-- 新增：确认服务器就绪
Opening browser for authentication...
Portal URL: http://127.0.0.1:5555/token-auth/demo?...
```
👆 浏览器打开，正常显示 Portal 页面

## 🔍 故障排查

### 问题 1: 仍然看到 404

检查：
```bash
# 查看路由是否提前注册
grep "OAuth Portal route registered" ~/.routecodex/logs/*.log

# 如果没有这个日志，可能是缓存问题
npm run build && npm install -g .
```

### 问题 2: 浏览器打开太快，服务器还没就绪

观察日志中是否有：
```
[OAuth] Portal server health check timed out, continuing anyway...
```

这说明 `waitForPortalReady()` 超时了。检查：
- 服务器是否在 3 秒内完成初始化
- `/health` 端点是否正常响应

### 问题 3: 多个 token 的情况

如果你配置了多个 token（通过不同的 alias），每个 token 认证时都应该：
- 显示正确的 alias 名称
- 显示正确的 token 文件路径
- Portal 页面能清楚区分是哪个 token

测试方法：
```bash
# 示例：两个 antigravity token
# ~/.routecodex/auth/antigravity-oauth-2-account1.json
# ~/.routecodex/auth/antigravity-oauth-2-account2.json

# 删除它们触发重新认证
mv ~/.routecodex/auth/antigravity-oauth-2-*.json /tmp/

# 启动服务器，观察 Portal 页面是否显示正确的 alias
routecodex start
```

## 📊 成功标志

✅ 所有以下检查都通过：

- [ ] 服务器启动日志包含 `OAuth Portal route registered (early initialization)`
- [ ] OAuth 认证时显示 `[OAuth] Portal server is ready`
- [ ] 浏览器能成功打开 Portal 页面（无 404）
- [ ] Portal 页面显示正确的 provider、alias、token file
- [ ] 点击"Continue to OAuth"正确跳转
- [ ] 验证脚本全部通过
- [ ] 多 token 场景下每个 token 都能正确认证

## 📝 反馈

如果遇到任何问题，请提供：
1. 完整的启动日志
2. 浏览器访问 Portal URL 的截图或 HTML 源码
3. `curl` 测试的完整输出
4. 服务器配置文件 (`~/.routecodex/config.json`)

---
测试愉快！🚀
