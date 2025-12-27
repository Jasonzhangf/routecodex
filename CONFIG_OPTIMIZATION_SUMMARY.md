# 配置文件优化总结

## ✅ 优化完成

配置文件已按照新的最佳实践优化完成。

### 📁 备份

原配置已备份到：
```
~/.routecodex/config.json.before-optimization
```

### 🔄 主要变更

#### 1. Antigravity Provider

**优化前**:
```json
{
  "auth": {
    "type": "antigravity-oauth",
    "entries": [
      {
        "alias": "geetasamodgeetasamoda",
        "type": "antigravity-oauth",
        "tokenFile": "~/.routecodex/auth/antigravity-oauth-2-geetasamodgeetasamoda.json"
      }
    ]
  }
}
```

**优化后**:
```json
{
  "auth": {
    "type": "antigravity-oauth",
    "entries": [
      {
        "alias": "geetasamodgeetasamoda",
        "type": "antigravity-oauth"
      }
    ]
  }
}
```

✅ **移除**: `tokenFile` 完整路径  
✅ **保留**: `alias`  
🤖 **自动**: 系统会匹配 `~/.routecodex/auth/antigravity-oauth-*-geetasamodgeetasamoda.json`

#### 2. Qwen Provider

**优化前**:
```json
{
  "auth": {
    "type": "qwen-oauth",
    "tokenFile": "~/.routecodex/auth/qwen-oauth.json"
  }
}
```

**优化后**:
```json
{
  "auth": {
    "type": "qwen-oauth"
  }
}
```

✅ **移除**: `tokenFile` 配置  
🤖 **自动**: 系统会匹配或创建 `~/.routecodex/auth/qwen-oauth-1-default.json`

#### 3. Iflow Provider

**优化前**:
```json
{
  "auth": {
    "type": "iflow-oauth",
    "tokenFile": "~/.routecodex/auth/iflow-oauth.json"
  }
}
```

**优化后**:
```json
{
  "auth": {
    "type": "iflow-oauth"
  }
}
```

✅ **移除**: `tokenFile` 配置  
🤖 **自动**: 系统会匹配或创建 `~/.routecodex/auth/iflow-oauth-*-default.json`

## 🎯 优化原则

### 新的 Token File 命名规则

系统会自动匹配或创建 token 文件，遵循命名规则：
```
{provider}-oauth-{sequence}-{alias}.json
```

示例：
- `antigravity-oauth-1-geetasamodgeetasamoda.json`
- `antigravity-oauth-2-default.json`
- `qwen-oauth-1-default.json`
- `iflow-oauth-1-186.json`
- `iflow-oauth-2-173.json`

### 配置最佳实践

#### ✅ 推荐做法（新格式）

```json
{
  "auth": {
    "type": "{provider}-oauth",
    "entries": [
      {
        "alias": "primary"
      },
      {
        "alias": "backup"
      },
      {
        "alias": "static"  // static alias 不会自动刷新
      }
    ]
  }
}
```

或单个 token：
```json
{
  "auth": {
    "type": "{provider}-oauth"
    // 系统会使用 "default" alias
  }
}
```

#### ❌ 不推荐（旧格式）

```json
{
  "auth": {
    "type": "{provider}-oauth",
    "tokenFile": "~/.routecodex/auth/{provider}-oauth-1-alias.json"
  }
}
```

## 🔄 如何回滚

如果需要恢复原配置：

```bash
# 备份当前优化后的配置
cp ~/.routecodex/config.json ~/.routecodex/config.json.optimized

# 恢复原配置
cp ~/.routecodex/config.json.before-optimization ~/.routecodex/config.json

echo "已恢复原配置"
```

## 🧪 测试优化后的配置

### 1. 删除旧 token（触发重新认证）

```bash
# 删除 antigravity token
rm ~/.routecodex/auth/antigravity-oauth-*-geetasamodgeetasamoda.json

# 系统会自动：
# 1. 扫描 ~/.routecodex/auth/ 目录
# 2. 查找匹配 "antigravity-oauth-*-geetasamodgeetasamoda" 的文件
# 3. 如果没找到，创建新的（sequence 自动递增）
```

### 2. 启动服务器

```bash
routecodex start
```

### 3. 观察日志

应该看到类似：
```
[provider-xxx] oauth-init-start {
  "providerType": "antigravity",
  "tokenFile": "~/.routecodex/auth/antigravity-oauth-1-geetasamodgeetasamoda.json",
  "forceReauthorize": false
}
```

注意：
- ✅ `tokenFile` 路径是**自动解析**的
- ✅ **不需要**在配置中指定完整路径
- ✅ **只需要** alias，系统会自动匹配

### 4. 验证 Token 文件

完成 OAuth 认证后：

```bash
# 查看生成的 token 文件
ls -lh ~/.routecodex/auth/ | grep antigravity

# 应该看到类似：
# antigravity-oauth-1-geetasamodgeetasamoda.json  (自动创建或匹配的)
```

## 📊 优化效果对比

### 配置文件大小

- **优化前**: 每个 OAuth provider 都有 `tokenFile` 完整路径
- **优化后**: 只需 `alias`，减少冗余配置

### 可维护性

#### 优化前 ❌
```
修改 token 存储位置？
→ 需要更新配置文件中的所有 tokenFile 路径
```

#### 优化后 ✅
```
修改 token 存储位置？
→ 只需修改环境变量或系统默认目录
→ 配置文件无需改动
```

### 多账号管理

#### 优化前 ❌
```json
{
  "entries": [
    {
      "alias": "account1",
      "tokenFile": "~/.routecodex/auth/provider-oauth-1-account1.json"
    },
    {
      "alias": "account2",
      "tokenFile": "~/.routecodex/auth/provider-oauth-2-account2.json"
    }
  ]
}
```
- 需要手动维护 sequence number
- 容易出错（重复 sequence）

#### 优化后 ✅
```json
{
  "entries": [
    { "alias": "account1" },
    { "alias": "account2" }
  ]
}
```
- Sequence 自动管理
- 只需指定 alias
- 系统自动查找或创建

## 🔐 特殊 Alias：`static`

**用途**: 只读 token，不自动刷新

```json
{
  "entries": [
    { "alias": "static" }
  ]
}
```

系统行为：
- ✅ 读取 `{provider}-oauth-*-static.json`
- ❌ **不会**自动刷新 token
- ❌ **不会**触发 OAuth 重新认证
- ✅ 适合长期有效的 token

## 📝 总结

### ✅ 已完成
- 配置文件已优化为新格式
- 原配置已备份
- 移除了冗余的 `tokenFile` 路径

### 🎉 优势
- 更简洁的配置
- 自动化的文件名管理
- 更好的可维护性
- 支持多账号无需手动管理 sequence

### 🚀 现在可以
- 启动服务器测试优化后的配置
- 添加新的 OAuth alias 只需指定名称
- Token 文件自动管理，无需关心路径

---

**配置优化完成！** 🎊

下一步：测试新配置
```bash
routecodex start
```
