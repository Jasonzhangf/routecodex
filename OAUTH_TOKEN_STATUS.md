# OAuth Token 状态检查报告

## 当前状态

### 已有 Token 文件

| 文件名 | 大小 | 修改时间 | Refresh Token | 过期时间 | 状态 |
|--------|------|----------|---------------|----------|------|
| `antigravity-oauth-1-geetasamodgeetasamoda.json` | 2.1K | Dec 26 19:04 | ✅ 存在 | 2025-12-26T11:48:35.916Z | ❌ 已过期 |
| `antigravity-oauth-2-jasonzhangfan.json` | 2.2K | Dec 26 16:41 | ✅ 存在 | 2025-12-26T09:41:21.886Z | ❌ 已过期 |
| `antigravity-oauth-3-static.json.bak.json` | 1.9K | Dec 26 19:26 | ❌ 无 | 2025-12-26T11:48:39.961Z | ❌ 已过期 (备份文件) |

### 问题分析

1. **所有 token 都已过期** - 这就是为什么启动时触发 OAuth 重新认证
2. **没有新的 token 文件创建** - 说明最近的 OAuth 认证流程没有完成
3. **Callback 被拒绝** - 可能原因：
   - 临时 HTTP 服务器 (localhost:8080) 没有正确接收 Google 的回调
   - 防火墙或网络问题阻止了连接
   - 认证过程中断

## OAuth 认证流程

### 正常流程

1. ✅ 检测到 token 过期
2. ✅ 启动临时 HTTP 服务器 (localhost:8080/oauth2callback)
3. ✅ 打开浏览器，显示 Portal 页面
4. ✅ 点击"Continue to OAuth"跳转到 Google 认证
5. ⏱️ 用户完成 Google 认证
6. ⏱️ Google 重定向到 `http://localhost:8080/oauth2callback?code=...`
7. ⏱️ 临时服务器接收 code，关闭
8. ⏱️ 用 code 换取 access_token 和 refresh_token
9. ⏱️ 保存 token 到文件

### 可能失败的点

- **步骤 6**: Callback 被拒绝
  - 检查：`lsof -ti :8080` - 端口是否被占用
  - 检查：防火墙是否阻止 localhost:8080
  - 检查：浏览器是否成功重定向

## 验证方法

### 1. 检查端口占用

```bash
# 检查 8080 端口是否被占用
lsof -ti :8080

# 如果有进程占用，停止它
kill $(lsof -ti :8080)
```

### 2. 手动测试 Callback 服务器

在 OAuth 认证期间，快速测试：

```bash
# 在另一个终端检查服务器是否在监听
curl http://localhost:8080/oauth2callback

# 应该看到服务器响应（即使是错误）
```

### 3. 查看详细日志

启动服务器时带环境变量：

```bash
DEBUG_OAUTH=1 routecodex start 2>&1 | tee /tmp/oauth-debug.log
```

## 建议操作

### 选项 1: 重新执行 OAuth 认证

```bash
# 1. 确保没有进程占用 8080
lsof -ti :8080 && kill $(lsof -ti :8080)

# 2. 删除过期 token (强制重新认证)
rm ~/.routecodex/auth/antigravity-oauth-1-geetasamodgeetasamoda.json

# 3. 启动服务器
routecodex start

# 4. 在浏览器中：
#    - 看到 Portal 页面
#    - 点击 "Continue to OAuth"
#    - 完成 Google 认证
#    - 等待浏览器重定向到 localhost:8080 (会显示 "OAuth Success")
#    - 关闭浏览器标签页
#    - 回到终端查看是否显示 "Token saved"
```

### 选项 2: 使用现有 token 并手动刷新

```bash
# 如果 refresh_token 还有效，尝试手动刷新
# (这需要调用 token daemon 的刷新功能)
routecodex token-daemon refresh
```

### 选项 3: 检查 Callback URL 访问

```bash
# 启动服务器后，在认证期间测试
# 打开新终端：
watch -n 1 'lsof -ti :8080 && echo "Server listening" || echo "No server"'
```

##  调试信息收集

如果问题持续，请收集以下信息：

```bash
# 1. 网络状态
netstat -an | grep 8080

# 2. 防火墙状态  
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate

# 3. 进程信息
ps aux | grep routecodex

# 4. Token 文件权限
ls -la ~/.routecodex/auth/

# 5. OAuth 调试日志
DEBUG_OAUTH=1 routecodex start 2>&1 | grep -i "oauth\|callback\|token"
```

---

**下一步**：请告诉我你在 Google OAuth 认证后看到了什么？
- 浏览器是否成功重定向到 localhost:8080？
- 是否看到 "OAuth Success" 或者连接被拒绝的错误？
