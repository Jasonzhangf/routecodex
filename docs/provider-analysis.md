# RouteCodex Provider 配置与初始化引导梳理

## 一、当前 Provider 初始化状态机

```
┌─────────────────────────────────────────────────────────────────┐
│                        Provider 初始化流程                        │
└─────────────────────────────────────────────────────────────────┘

[开始]
   │
   ▼
┌─────────────────────────────────────────────────────────────────┐
│  1. 检查配置状态 (inspectConfigState)                          │
│     ├─ missing → 首次初始化                                       │
│     ├─ invalid → 错误退出                                          │
│     ├─ v1 → V1→V2 迁移                                            │
│     └─ v2 → V2 维护菜单                                            │
└─────────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. 配置初始化分支                                                 │
│                                                                   │
│  ┌─────────────┐    ┌──────────────┐    ┌──────────────────┐ │
│  │ 首次初始化    │→   │ V1→V2 迁移   │→   │  V2 维护菜单      │ │
│  └─────────────┘    └──────────────┘    └──────────────────┘ │
│         │                  │                      │             │
│         ▼                  ▼                      ▼             │
│  ┌──────────────┐  ┌──────────────┐   ┌──────────────────┐ │
│  │- 选择 Provider│  │- 拆分 Provider│   │- 编辑路由         │ │
│  │  模板         │  │  配置文件      │   │- 添加/删除 Provider│ │
│  │- 设置默认     │  │- 备份原配置    │   │- 调整端口/主机     │ │
│  │  Provider     │  │- 生成 V2 配置  │   │- 配置 Web Search  │ │
│  │- 配置路由     │  └──────────────┘   └──────────────────┘ │
│  └──────────────┘                                             │
└─────────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. Provider 配置生成 (writeProviderV2)                        │
│     位置: ~/.routecodex/provider/{providerId}/config.v2.json  │
│                                                                   │
│  配置结构:                                                       │
│  {                                                               │
│    "version": "v2",                                              │
│    "providerId": "openai",                                       │
│    "provider": {                                                  │
│      "id": "openai",                                             │
│      "enabled": true,                                             │
│      "type": "openai",                                           │
│      "baseURL": "https://api.openai.com/v1",                   │
│      "auth": { "type": "apikey", "apiKey": "${OPENAI_API_KEY}" },│
│      "models": { "gpt-5.2": { "supportsStreaming": true } }   │
│    }                                                             │
│  }                                                               │
└─────────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. 主配置生成 (buildV2ConfigObject)                            │
│     位置: ~/.routecodex/config.json                              │
│                                                                   │
│  配置结构:                                                       │
│  {                                                               │
│    "virtualrouterMode": "v2",                                    │
│    "httpserver": { "host": "127.0.0.1", "port": 5555 },      │
│    "virtualrouter": {                                             │
│      "activeRoutingPolicyGroup": "default",                      │
│      "routingPolicyGroups": {                                     │
│        "default": {                                               │
│          "routing": {                                             │
│            "default": [{ "id": "default-primary", "targets": [...] }],│
│            "thinking": [...],                                     │
│            "tools": [...],                                        │
│            "web_search": [...]                                    │
│          }                                                       │
│        }                                                         │
│      }                                                           │
│    }                                                             │
│  }                                                               │
└─────────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. 可选: Camoufox 环境准备 (maybePrepareCamoufoxEnvironment) │
└─────────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────────┐
│  6. Provider 运行时初始化 (服务器启动时)                          │
│     ├─ bootstrapVirtualRouterConfig()                            │
│     ├─ initializeProviderRuntimes()                              │
│     ├─ 非阻塞认证验证 (runNonBlockingCredentialValidation)      │
│     └─ Antigravity 预热 (fire-and-forget)                       │
└─────────────────────────────────────────────────────────────────┘
   │
   ▼
[完成]
```

## 二、如何初始化新的 Provider

### 方式一: 使用 CLI 交互式初始化

```bash
# 1. 查看可用 Provider 模板
routecodex init --list-providers

# 2. 交互式初始化 (选择 Provider、路由等)
routecodex init

# 3. 或使用命令行参数直接指定
routecodex init --providers openai,qwen --default-provider qwen --force
```

### 方式二: 手动添加 Provider

1. **创建 Provider 配置目录**:

```bash
mkdir -p ~/.routecodex/provider/myprovider
```

2. **创建 config.v2.json**:

```json
{
  "version": "v2",
  "providerId": "myprovider",
  "provider": {
    "id": "myprovider",
    "enabled": true,
    "type": "openai",
    "baseURL": "https://api.myprovider.com/v1",
    "compatibilityProfile": "chat:openai",
    "auth": {
      "type": "apikey",
      "apiKey": "${MYPROVIDER_API_KEY}"
    },
    "models": {
      "my-model-1": { "supportsStreaming": true },
      "my-model-2": { "supportsStreaming": true }
    },
    "defaultModel": "my-model-1"
  }
}
```

3. **更新主配置 config.json 中的路由**:

```json
{
  "virtualrouter": {
    "routingPolicyGroups": {
      "default": {
        "routing": {
          "default": [
            {
              "id": "default-primary",
              "targets": ["myprovider.my-model-1"]
            }
          ]
        }
      }
    }
  }
}
```

4. **设置环境变量**:

```bash
export MYPROVIDER_API_KEY="your-api-key-here"
```

### 方式三: 使用 Provider Doctor 验证

```bash
# 检查 Provider 配置
routecodex provider inspect myprovider

# 使用路由提示
routecodex provider inspect myprovider --routing-hints

# 使用 Vercel AI SDK 验证连接
routecodex provider doctor myprovider
```

## 三、README 中标注情况分析

### ✅ 已清晰标注的内容

1. **基本初始化流程** (README.md 第 93-157 行):
   - `rcc init` 基本用法
   - V1→V2 迁移步骤
   - 环境变量配置
   - Provider 鉴权类型对照表

2. **Provider 目录结构** (README.md 第 142-144 行):
   - `~/.routecodex/provider/<providerId>/config.v2.json`

3. **Provider 类型文档**:
   - `docs/PROVIDER_TYPES.md` - Provider 类型说明
   - `docs/PROVIDERS_BUILTIN.md` - 内置 Provider 列表

4. **Provider 模块架构**:
   - `src/providers/README.md` - Provider V2 模块说明

### ⚠️ 不够清晰或缺失的内容

1. **手动添加 Provider 的完整步骤** - 只有 CLI 方式，缺少手动创建配置的详细指南
2. **Provider 配置文件 schema 说明** - 没有完整的 config.v2.json 字段说明文档
3. **自定义 Provider 开发指南** - 如何添加不在 catalog 中的新 Provider 类型
4. **路由配置详细说明** - routingPolicyGroups 的完整 schema 和最佳实践
5. **provider inspect/routing-hints 的使用场景** - 这些高级功能的实际应用案例

## 四、优化方向

### 1. 文档优化

#### A. 新增或完善文档

- [ ] `docs/PROVIDER_CONFIG_V2.md` - Provider V2 配置完整 schema 说明
- [ ] `docs/PROVIDER_ADD_MANUAL.md` - 手动添加 Provider 完整步骤指南
- [ ] `docs/ROUTING_POLICY_GUIDE.md` - 路由策略配置完整指南
- [ ] 更新 `README.md` - 补充手动添加 Provider 的章节

#### B. 增强现有文档

- [ ] 在 `README.md` 中添加 "Provider 管理" 独立章节
- [ ] 在 `src/providers/README.md` 中添加配置示例
- [ ] 补充 `provider inspect --routing-hints` 的实际应用案例

### 2. CLI 工具增强

#### A. 新增命令

```bash
# 新增 provider add 命令
routecodex provider add myprovider \
  --type openai \
  --base-url https://api.myprovider.com/v1 \
  --auth-type apikey \
  --env-var MYPROVIDER_API_KEY \
  --model "my-model-1:supportsStreaming=true" \
  --model "my-model-2:supportsStreaming=true" \
  --default-model my-model-1

# 新增 provider template 命令 - 导出模板
routecodex provider template openai > myprovider-template.json

# 新增 provider validate 命令 - 验证配置
routecodex provider validate myprovider
```

#### B. 增强现有命令

- [ ] `init` 命令支持从 JSON 模板导入 Provider 配置
- [ ] `provider inspect` 输出更友好的配置建议
- [ ] `provider doctor` 支持更多 Provider 类型

### 3. 配置系统增强

#### A. Provider Catalog 扩展

- [ ] 支持自定义 catalog 扩展 (`~/.routecodex/provider-catalog.json`)
- [ ] 支持从远程 URL 加载 catalog
- [ ] catalog 版本管理和更新检查

#### B. 配置验证

- [ ] Provider 配置加载时的完整 schema 验证
- [ ] 更友好的配置错误提示
- [ ] 配置 lint 工具

### 4. 开发者体验优化

#### A. 配置生成辅助

- [ ] 交互式 `provider add` 向导
- [ ] 从 OpenAPI/Swagger 文档生成 Provider 配置
- [ ] Provider 配置分享和导入导出

#### B. 调试工具

- [ ] Provider 配置 dry-run 模式
- [ ] 实时配置变更预览
- [ ] 配置历史和回滚

## 五、优先级建议

### P0 (立即实施)

1. **文档**: 新增 `docs/PROVIDER_CONFIG_V2.md` - Provider V2 配置完整 schema
2. **文档**: 在 `README.md` 中补充"手动添加 Provider"完整步骤
3. **CLI**: 增强 `provider inspect --routing-hints` 输出更实用的配置片段

### P1 (短期)

1. **CLI**: 新增 `provider add` 命令
2. **文档**: 新增 `docs/ROUTING_POLICY_GUIDE.md`
3. **验证**: 实现 Provider 配置 schema 验证

### P2 (中期)

1. **扩展**: 支持自定义 Provider catalog
2. **工具**: Provider 配置导入导出
3. **调试**: 配置 dry-run 和预览

## 六、总结

### 当前状态

- ✅ CLI 初始化流程完善
- ✅ Provider 模板 catalog 丰富
- ✅ 基本文档覆盖
- ⚠️ 手动配置指引不足
- ⚠️ 高级功能文档缺失

### 核心问题

1. **新用户上手难**: 缺少完整的手动添加 Provider 指南
2. **配置不透明**: 缺少完整的配置 schema 文档
3. **工具链不完整**: 缺少 `provider add` 等便捷命令

### 优化重点

1. **文档优先**: 先完善文档，降低使用门槛
2. **工具增强**: 补充便捷 CLI 命令
3. **扩展性**: 支持自定义 Provider 类型和 catalog
