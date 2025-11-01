# RouteCodex 兼容性模块配置指南

## 概述

RouteCodex 兼容性模块完全兼容现有的标准配置文件格式。本文档详细说明了如何在现有配置中集成和使用兼容性模块。

## 🎯 核心兼容性特性

### 1. **完全向后兼容**
- ✅ 支持现有 `~/.routecodex/config.json` 格式
- ✅ 保持现有配置结构不变
- ✅ 可选的兼容性模块配置，不影响现有功能

### 2. **标准配置结构**
```json
{
  "httpserver": { "port": 5506 },
  "server": { "port": 5506, "host": "127.0.0.1" },
  "logging": { "level": "info" },

  // 新增：兼容性模块配置
  "compatibility": {
    "modules": [...]
  },

  // 现有配置保持不变
  "pipeline": [...],
  "providers": {...}
}
```

## 📋 配置文件格式

### 标准兼容性模块配置

```json
{
  "compatibility": {
    "modules": [
      {
        "id": "glm-compatibility-main",
        "type": "glm",
        "providerType": "glm",
        "enabled": true,
        "priority": 1,
        "profileId": "glm-standard",
        "transformationProfile": "default",
        "config": {
          "debugMode": true,
          "strictValidation": true,
          "fieldMappings": {
            "usage.prompt_tokens": "usage.input_tokens",
            "usage.completion_tokens": "usage.output_tokens",
            "created_at": "created"
          }
        },
        "hookConfig": {
          "enabled": true,
          "debugMode": true,
          "snapshotEnabled": false
        }
      }
    ]
  }
}
```

### 配置字段说明

#### 基础字段
| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 模块唯一标识符 |
| `type` | string | ✅ | 兼容性模块类型 (如: "glm", "qwen") |
| `providerType` | string | ✅ | 目标Provider类型 |
| `enabled` | boolean | ❌ | 是否启用模块 (默认: true) |
| `priority` | number | ❌ | 模块优先级 (默认: 1) |

#### 扩展字段
| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `profileId` | string | ❌ | 兼容性配置文件ID |
| `transformationProfile` | string | ❌ | 字段转换配置文件ID |
| `config` | object | ❌ | 模块特定配置 |
| `hookConfig` | object | ❌ | Hook系统配置 |

## 🔧 使用方式

### 方式1: 使用标准API (推荐)

```typescript
import { createCompatibilityAPI } from './src/modules/pipeline/modules/compatibility/index.js';

// 创建兼容性API实例
const compatibilityAPI = createCompatibilityAPI(dependencies);

// 初始化
await compatibilityAPI.initialize();

// 从配置文件批量加载模块
const moduleIds = await compatibilityAPI.manager.loadModulesFromConfig(
  '~/.routecodex/config.json'
);

// 处理请求
const processedRequest = await compatibilityAPI.processRequest(
  'glm-compatibility-main',
  originalRequest,
  context
);
```

### 方式2: 直接使用管理器

```typescript
import { CompatibilityManager } from './src/modules/pipeline/modules/compatibility/compatibility-manager.js';

const manager = new CompatibilityManager(dependencies);
await manager.initialize();

// 加载配置文件
const moduleIds = await manager.loadModulesFromConfig('./config.json');

// 获取特定模块
const glmModule = manager.getModule('glm-compatibility-main');
```

### 方式3: 工厂模式创建

```typescript
import { CompatibilityModuleFactory } from './src/modules/pipeline/modules/compatibility/compatibility-factory.js';

// 创建单个模块
const module = await CompatibilityModuleFactory.createModule({
  id: 'glm-compatibility',
  type: 'glm',
  providerType: 'glm',
  config: { debugMode: true }
}, dependencies);
```

## 🏗️ 集成示例

### 完整配置文件示例

```json
{
  "httpserver": {
    "port": 5506
  },
  "server": {
    "port": 5506,
    "host": "127.0.0.1"
  },
  "logging": {
    "level": "info"
  },

  "pipeline": [
    {
      "id": "glm-pipeline",
      "name": "GLM Processing Pipeline",
      "enabled": true,
      "modules": [
        {
          "id": "glm-llmswitch",
          "type": "llmswitch",
          "config": { "providerType": "glm" }
        },
        {
          "id": "glm-compatibility",
          "type": "glm",
          "providerType": "glm",
          "enabled": true,
          "config": { "debugMode": true }
        },
        {
          "id": "glm-provider",
          "type": "provider",
          "config": {
            "baseUrl": "http://localhost:8080",
            "apiKey": "your-api-key"
          }
        }
      ]
    }
  ],

  "compatibility": {
    "modules": [
      {
        "id": "glm-compatibility-main",
        "type": "glm",
        "providerType": "glm",
        "enabled": true,
        "priority": 1,
        "profileId": "glm-standard",
        "config": {
          "debugMode": true,
          "strictValidation": true
        },
        "hookConfig": {
          "enabled": true,
          "debugMode": false,
          "snapshotEnabled": true
        }
      }
    ]
  },

  "providers": {
    "glm": {
      "type": "glm",
      "enabled": true,
      "config": {
        "baseUrl": "http://localhost:8080",
        "apiKey": "your-api-key"
      }
    }
  }
}
```

## 🔄 配置加载流程

### 自动配置加载

1. **启动时检测**: 系统启动时自动检测配置文件中的 `compatibility` 部分
2. **模块注册**: 自动注册兼容性模块类型到工厂
3. **批量创建**: 根据配置批量创建模块实例
4. **生命周期管理**: 统一管理模块初始化和清理

### 配置解析步骤

```typescript
// 1. 加载配置文件
const config = await loadConfigFile(configPath);

// 2. 检查兼容性配置
if (config.compatibility && Array.isArray(config.compatibility.modules)) {
  // 3. 批量创建模块
  for (const moduleConfig of config.compatibility.modules) {
    const moduleId = await manager.createModule(moduleConfig);
    moduleIds.push(moduleId);
  }
}

// 4. 返回创建的模块ID列表
return moduleIds;
```

## 🎛️ GLM 兼容性模块特定配置

### Hook配置

```json
{
  "hookConfig": {
    "enabled": true,
    "debugMode": true,
    "snapshotEnabled": false
  }
}
```

- `enabled`: 启用Hook系统
- `debugMode`: 调试模式，输出详细日志
- `snapshotEnabled`: 启用数据快照，用于调试

### 字段映射配置

```json
{
  "config": {
    "fieldMappings": {
      "usage.prompt_tokens": "usage.input_tokens",
      "usage.completion_tokens": "usage.output_tokens",
      "created_at": "created",
      "reasoning_content": "reasoning"
    }
  }
}
```

### 工具清洗配置

```json
{
  "config": {
    "toolCleaning": {
      "maxToolContentLength": 512,
      "enableTruncation": true,
      "noisePatterns": [
        "<reasoning>",
        "</reasoning>",
        "<thinking>",
        "</thinking>"
      ]
    }
  }
}
```

## 📊 监控和调试

### 模块状态监控

```typescript
// 获取模块统计信息
const stats = compatibilityAPI.getStats();
console.log('模块统计:', stats);

// 输出示例:
{
  "totalModules": 1,
  "isInitialized": true,
  "registeredTypes": ["glm"],
  "modulesByType": { "glm": 1 },
  "modulesByProvider": { "glm": 1 }
}
```

### 调试日志

```typescript
// 启用调试模式
const moduleConfig = {
  id: 'glm-debug',
  type: 'glm',
  providerType: 'glm',
  config: {
    debugMode: true,
    hookConfig: {
      debugMode: true,
      snapshotEnabled: true
    }
  }
};
```

## ✅ 验证清单

### 配置兼容性检查

- [ ] 配置文件结构符合标准格式
- [ ] 必需字段 (id, type, providerType) 存在
- [ ] 模块类型已在工厂中注册
- [ ] Hook系统配置正确
- [ ] 字段映射配置有效
- [ ] 依赖项配置完整

### 运行时验证

- [ ] 模块成功初始化
- [ ] 配置加载无错误
- [ ] 模块实例可正常获取
- [ ] 请求处理功能正常
- [ ] 响应处理功能正常
- [ ] 清理流程正常执行

## 🚨 故障排除

### 常见问题

1. **模块类型未注册**
   ```
   Error: Unknown compatibility module type: glm
   ```
   **解决方案**: 确保导入了对应的模块index文件
   ```typescript
   import './src/modules/pipeline/modules/compatibility/glm/index.js';
   ```

2. **配置文件格式错误**
   ```
   Error: Failed to load config file
   ```
   **解决方案**: 验证JSON格式和必需字段

3. **模块初始化失败**
   ```
   Error: CompatibilityManager not initialized
   ```
   **解决方案**: 调用 `await compatibilityAPI.initialize()`

### 调试命令

```bash
# 检查配置文件格式
node -e "console.log(JSON.parse(require('fs').readFileSync('config.json', 'utf8')))"

# 验证模块注册
node -e "console.log(Object.keys(require('./src/modules/pipeline/modules/compatibility/compatibility-factory.js').CompatibilityModuleFactory.moduleRegistry))"

# 测试配置加载
npx tsx -e "
import { CompatibilityManager } from './src/modules/pipeline/modules/compatibility/compatibility-manager.js';
const manager = new CompatibilityManager({ logger: console });
manager.initialize().then(() => manager.loadModulesFromConfig('./config.json')).then(console.log);
"
```

## 📈 性能优化

### 配置缓存

- 配置文件解析结果自动缓存
- 模块实例复用，避免重复创建
- 延迟初始化，按需加载模块

### 内存管理

- 及时清理未使用的模块实例
- Hook系统支持独立配置和清理
- 字段映射配置共享，减少内存占用

---

## 📚 相关文档

- [GLM兼容模块详细文档](./src/modules/pipeline/modules/compatibility/glm/README.md)
- [兼容性架构设计](./docs/COMPATIBILITY_ARCHITECTURE.md)
- [Hook系统使用指南](./docs/HOOK_SYSTEM_GUIDE.md)
- [RouteCodex架构原则](./CLAUDE.md)

---

**版本**: 1.0.0
**最后更新**: 2025-11-01
**兼容性**: RouteCodex v4.x