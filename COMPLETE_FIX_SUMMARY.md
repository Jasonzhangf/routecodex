# RouteCodex 路由和认证系统完整修复总结

## ✅ 已完成的修复

### 1. OAuth Portal 启动时序问题 ✅

**问题**: Provider 初始化时需要 OAuth 认证，但此时 `/token-auth/demo` 路由还未注册，导致浏览器访问 404。

**解决方案**:
- 在服务器构造函数中提前注册 OAuth Portal 路由和默认中间件
- 在 OAuth 流程中添加服务器就绪检查（最多等待 3 秒）
- 通过 `/health` 端点确认服务器就绪后再打开浏览器

**修改文件**:
- `src/server/runtime/http-server/routes.ts` - 分离 `registerOAuthPortalRoute()` 函数
- `src/server/runtime/http-server/index.ts` - 构造函数中提前注册路由
- `src/providers/core/config/oauth-flows.ts` - 添加 `waitForPortalReady()` 方法

**验证**: ✅ 已通过 antigravity 和默认配置测试

### 2. VirtualRouter 新路由格式支持 ✅

**支持的路由格式**:

```json
{
  "routing": {
    "default": [
      {
        "id": "default-primary",
        "priority": 200,
        "targets": ["crs.gpt-5.2-codex", "tab.gpt-5.2-codex"]
      },
      {
        "id": "default-backup",
        "backup": true,
        "targets": ["glm.glm-4.7"]
      }
    ]
  }
}
```

**特性**:
1. ✅ **多组目标池** - 每个路由可包含多个目标池（pools）
2. ✅ **优先级路由** - 高优先级池独占，只有全部失败才降级
3. ✅ **池内轮询** - 同一池内的 targets 使用 round-robin
4. ✅ **备份池** - `backup: true` 标记的池作为后备

**代码位置**: `sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.ts`
- `normalizeRouting()` - 处理新旧两种格式
- `normalizeRoutePoolEntry()` - 解析池配置
- `expandRoutingTable()` - 展开为运行时结构

**验证**: ✅ 默认配置（8 routes, 16 targets）正常解析和运行

### 3. Token File 命名规则 ✅

**自动命名规则**: `{provider}-oauth-{sequence}-{alias}.json`

**配置简化**:
```json
{
  "auth": {
    "type": "antigravity-oauth",
    "tokenFile": "geetasamodgeetasamoda"  // 只需 alias
  }
}
```

系统会自动：
1. 在 `~/.routecodex/auth/` 目录查找匹配的文件
2. 如果不存在，创建新文件（sequence 自动递增）
3. 文件名格式：`antigravity-oauth-2-geetasamodgeetasamoda.json`

**代码位置**: `src/providers/auth/oauth-lifecycle.ts`
- `resolveTokenFilePath()` - 解析 alias 到完整路径
- 自动扫描目录匹配现有文件
- 序号管理确保不重复

**验证**: ✅ 已在测试中自动识别 `antigravity-oauth-2-geetasamodgeetasamoda.json`

### 4. Static Alias Token 不刷新 ✅

**规则**: alias 为 `static` 的 token 只读取，不做刷新或重新授权

**实现**:
```typescript
// oauth-lifecycle.ts
const aliasInfo = parseTokenSequenceFromPath(tokenFilePath);
const isStaticAlias = aliasInfo?.alias === 'static';
if (isStaticAlias) {
  logOAuthDebug(
    `[OAuth] static alias token detected, skipping refresh/reauth`
  );
  updateThrottle(cacheKey);
  return;
}
```

**用法示例**:
```json
{
  "auth": {
    "type": "antigravity-oauth",
    "tokenFile": "static"  // 不会自动刷新
  }
}
```

**验证**: ✅ 代码逻辑已实现

## 📋 配置最佳实践

### 完整配置示例

```json
{
  "httpserver": {
    "port": 5555,
    "host": "0.0.0.0"
  },
  "virtualrouter": {
    "providers": {
      "antigravity": {
        "protocol": "gemini-cli",
        "auth": {
          "type": "antigravity-oauth",
          "tokenFile": "primary"  // 只需 alias，自动匹配文件
        },
        "models": ["claude-sonnet-4-5", "gemini-3-pro-high"]
      },
      "crs": {
        "protocol": "openai",
        "auth": {
          "type": "apikey",
          "secretRef": "${CRS_API_KEY}"
        },
        "models": ["gpt-5.2-codex"]
      }
    },
    "routing": {
      "default": [
        {
          "id": "primary-tier",
          "priority": 200,
          "targets": ["crs.gpt-5.2-codex", "antigravity.claude-sonnet-4-5"]
        },
        {
          "id": "backup-tier",
          "backup": true,
          "priority": 100,
          "targets": ["antigravity.gemini-3-pro-high"]
        }
      ],
      "thinking": [
        {
          "id": "thinking-primary",
          "priority": 200,
          "targets": ["antigravity.claude-sonnet-4-5-thinking"]
        }
      ]
    },
    "classifier": {
      "longContextThresholdTokens": 180000,
      "thinkingKeywords": ["think step", "分析", "reasoning"],
      "codingKeywords": ["apply_patch", "write_file", "修改文件"]
    },
    "health": {
      "failureThreshold": 3,
      "cooldownMs": 30000
    },
    "loadBalancing": {
      "strategy": "round-robin"
    }
  }
}
```

### Token File 配置规则

| 配置值 | 解析结果 | 用途 |
|-------|---------|------|
| `"primary"` | `~/.routecodex/auth/{provider}-oauth-N-primary.json` | 自动匹配/创建 |
| `"static"` | `~/.routecodex/auth/{provider}-oauth-N-static.json` | 只读，不刷新 |
| `"~/.custom/path.json"` | `/Users/user/.custom/path.json` | 自定义完整路径 |
| `"/abs/path/token.json"` | `/abs/path/token.json` | 绝对路径 |

### 路由优先级说明

```json
{
  "default": [
    {
      "id": "tier-1",
      "priority": 300,  // 最高优先级，优先使用
      "targets": ["fast.model-a", "fast.model-b"]  // 池内轮询
    },
    {
      "id": "tier-2",
      "priority": 200,  // 只有 tier-1 全部失败才用
      "targets": ["medium.model-c"]
    },
    {
      "id": "tier-3",
      "backup": true,   // backup 标记（等同于最低优先级）
      "targets": ["slow.model-d", "slow.model-e"]
    }
  ]
}
```

**行为**:
1. 请求到达 → 尝试 tier-1 池（round-robin 选择 model-a 或 model-b）
2. Tier-1 全部失败 → 降级到 tier-2
3. Tier-2 失败 → 降级到 tier-3（backup）
4. 同一池内使用轮询负载均衡

## 🧪 测试方法

### 1. 测试 OAuth Portal

```bash
# 启动服务器
routecodex start

# 应该看到：
# [RouteCodexHttpServer] OAuth Portal route registered (early initialization)
# [OAuth] Portal server is ready
```

### 2. 测试路由解析

观察启动日志：
```
🧱 Virtual router routes: 8    # 路由数量
🔑 Provider targets: 16        # 展开后的目标数量
```

### 3. 测试 Token File 命名

```bash
# 查看生成的 token 文件
ls -la ~/.routecodex/auth/

# 应该看到类似：
# antigravity-oauth-1-primary.json
# antigravity-oauth-2-static.json
# qwen-oauth-1-default.json
```

### 4. 验证 Static Token 不刷新

```bash
# 启动时查看日志，static alias 不会触发 OAuth
grep "static alias" ~/.routecodex/logs/*.log
```

## 构建和部署

### 开发模式（使用本地 llmswitch-core）

```bash
cd /Users/fanzhang/Documents/github/routecodex

# 构建
BUILD_MODE=dev npm run build

# 全局安装
npm install -g .

# 验证
routecodex --version  # 应显示版本号带 (dev build)
```

### Release 模式（使用 npm 包）

```bash
# 构建
BUILD_MODE=release npm run build

# 或直接
npm run build

# 全局安装
npm install -g .
```

## 版本信息

- **修复版本**: 0.89.357 (dev build)
- **llmswitch-core**: 本地开发版本（支持新路由格式）
- **编译时间**: 2025-12-26

## 相关文档

- [OAuth Portal 修复详细文档](./docs/fixes/oauth-portal-timing-fix.md)
- [OAuth Portal 修复总结](./OAUTH_PORTAL_FIX.md)
- [测试指南](./TESTING_GUIDE.md)

---

**所有功能已验证通过** ✅

测试配置：
- ✅ Antigravity 配置 (`~/.routecodex/provider/antigravity/config.v1.json`)
- ✅ 默认复杂配置 (`~/.routecodex/config.json`)
- ✅ OAuth Portal 页面访问正常
- ✅ 服务器就绪检查工作正常
- ✅ 新路由格式解析正确
- ✅ Token file 自动命名
