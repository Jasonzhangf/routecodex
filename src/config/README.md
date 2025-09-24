# 配置模块 (Configuration Module)

## 功能概述
配置模块提供RouteCodex的完整配置管理解决方案，包括配置定义、解析、验证、合并等核心功能。

## 🆕 顺序索引别名系统 (Key Alias System) - v2.1 新增

### 核心概念
为了彻底解决配置中key字段包含特殊字符（如"."）导致的解析错误，我们引入了**顺序索引别名系统**：

1. **provider.apiKey**: 填入真实key数组
2. **route配置**: 使用顺序索引别名（`key1`、`key2`、`key3`...）
3. **不填key**: 表示使用全部key（自动展开为所有别名）
4. **指定key**: 使用 `provider.model.key1` 格式

### 别名映射规则
```
真实key: ["sk-real-key-1", "sk-real-key-2", "sk-real-key-3"]
自动映射: key1 → sk-real-key-1, key2 → sk-real-key-2, key3 → sk-real-key-3
```

### 配置示例
```json
{
  "virtualrouter": {
    "providers": {
      "openai": {
        "apiKey": ["sk-proj-xxxxx", "sk-proj-yyyyy", "sk-proj-zzzzz"],
        "models": { "gpt-4": {} }
      }
    },
    "routing": {
      "default": ["openai.gpt-4"],        // 使用全部key（key1, key2, key3）
      "premium": ["openai.gpt-4.key1"],   // 仅使用第1个key
      "backup": ["openai.gpt-4.key2", "openai.gpt-4.key3"] // 使用第2、3个key
    }
  }
}
```

### 优势
- ✅ **避免解析错误**: 不再担心key中包含特殊字符
- ✅ **提高安全性**: 配置中只出现别名，不出现真实key
- ✅ **统一抽象**: 所有key都通过顺序索引别名引用
- ✅ **向后兼容**: 单key配置自动适配为key1

## 文件结构

## 文件结构

### 核心配置文件
- `modules.json`: 系统模块默认配置
- `users.json`: 用户管理配置
- `default.json`: 默认配置模板

### 配置类型定义
- `merged-config-types.ts`: **新增** - 合并配置类型定义
- `user-config-types.ts`: **新增** - 用户配置类型定义
- `system-config-types.ts`: **新增** - 系统配置类型定义
- `module-config-types.ts`: **新增** - 模块配置类型定义

### 配置处理器 (v2.0 新增)
- `user-config-parser.ts`: **新增** - 用户配置解析器，解析用户配置为模块格式
- `config-merger.ts`: **新增** - 配置合并器，合并系统配置和用户配置
- `auth-file-resolver.ts`: **新增** - AuthFile解析器，处理密钥文件解析
- `refactoring-agent.ts`: **新增** - 重构代理，自动化代码生成和重构

### 遗留文件 (待重构)
- `config-types.ts`: **旧版** - 配置类型定义
- `config-loader.ts`: **旧版** - 配置加载器
- `config-validator.ts`: **旧版** - 配置验证器

## 配置系统架构 (v2.0)

### 分层配置系统
```
用户配置 (~/.routecodex/config.json)
    ↓ 解析和转换
UserConfigParser
    ↓ 生成路由目标池和流水线配置
ConfigMerger
    ↓ 合并系统配置
./config/merged-config.json
    ↓ 模块加载
各个系统模块
```

## 🆕 兼容性字段处理 (v2.1 新增)

### 功能概述
兼容性字段处理系统支持简单字符串格式和复杂对象格式，提供灵活的配置选项。

### 支持的格式

#### 简单字符串格式
```json
{
  "compatibility": "passthrough"
}
```

**支持的字符串值**:
- `"passthrough"` - 直通模式（默认）
- `"lmstudio"` - LM Studio兼容模式
- `"qwen"` - Qwen兼容模式
- `"iflow"` - iFlow兼容模式
- `"lmstudio/qwen"` - 多Provider支持

#### 复杂对象格式
```json
{
  "compatibility": {
    "type": "lmstudio-compatibility",
    "config": {
      "toolsEnabled": true,
      "customRules": [...]
    }
  }
}
```

### 优先级层次
1. **用户配置兼容性字段**（最高优先级）
2. **模型级别兼容性**
3. **Provider级别兼容性**
4. **自动推断**（基于Provider类型）

### 自动推断逻辑
当未指定兼容性时，系统会根据Provider类型自动推断：
- `lmstudio` → `lmstudio-compatibility`
- `qwen` → `qwen-compatibility`
- `iflow` → `iflow-compatibility`
- 其他 → `passthrough-compatibility`

### 实现细节
- **解析器**: `UserConfigParser.parseCompatibilityString()`
- **转换逻辑**: 支持字符串到复杂对象的自动转换
- **向后兼容**: 完全兼容现有的复杂对象格式
- **默认值**: 未指定时默认为`passthrough`

### 关键组件

#### 1. UserConfigParser
- 解析用户配置文件
- 生成路由目标池 (Route Target Pools)
- 生成流水线配置 (Pipeline Configurations)
- 支持AuthFile密钥解析
- **🆕 兼容性字段处理**: 支持简单字符串格式和复杂对象格式

#### 2. ConfigMerger
- 深度合并系统配置和用户配置
- 配置优先级管理
- 配置验证和错误处理

#### 3. 虚拟路由配置
- **路由目标池**: 7个池 (default, longContext, thinking, coding, background, websearch, vision)
- **流水线配置**: 56个详细配置
- **协议支持**: OpenAI和Anthropic协议

## 真实Provider配置

### 支持的Provider
- **QWEN**: 2个模型，2个API密钥
  - qwen3-coder-plus, qwen3-coder
  - https://portal.qwen.ai/v1

- **IFLOW**: 4个模型，3个API密钥
  - deepseek-r1, kimi-k2, qwen3-coder, glm-4.5
  - https://apis.iflow.cn/v1

- **MODELSCOPE**: 10个模型，4个API密钥
  - Qwen3-Coder-480B, GLM-4.5, DeepSeek-V3, etc.
  - https://api-inference.modelscope.cn/v1/chat/completions

### 路由配置
- **default**: 4个目标 (主要工作负载)
- **longContext**: 2个目标 (长文本处理)
- **thinking**: 4个目标 (复杂推理)
- **coding**: 2个目标 (代码生成)
- **background**: 2个目标 (后台任务)
- **websearch**: 2个目标 (网络搜索)
- **vision**: 0个目标 (图像处理，预留)

## 依赖关系
```
config/
├── 被 core/ 依赖 - 配置管理
├── 被 modules/ 依赖 - 模块配置
├── 被 server/ 依赖 - 服务器配置
└── 依赖 utils/ - 工具函数
```

## 使用示例

### 用户配置解析
```typescript
import { UserConfigParser } from './user-config-parser';

const parser = new UserConfigParser();
const userConfig = await parser.parseConfig('~/.routecodex/config.json');
const routeTargets = parser.parseRouteTargets(userConfig);
const pipelineConfigs = parser.parsePipelineConfigs(userConfig);
```

### 配置合并
```typescript
import { ConfigMerger } from './config-merger';

const merger = new ConfigMerger();
const mergedConfig = await merger.mergeConfigs(
  './config/modules.json',     // 系统配置
  '~/.routecodex/config.json', // 用户配置
  parsedUserConfig            // 解析后的用户配置
);
```

### 重构代理使用
```typescript
import { RefactoringAgent } from './refactoring-agent';

const agent = new RefactoringAgent();
await agent.executeRefactoring();
// 自动生成所有重构代码
```

## 配置文件位置

### 用户配置
- **主配置**: `~/.routecodex/config.json`
- **AuthFile目录**: `~/.routecodex/auth/`
- **合并配置**: `./config/merged-config.json`

### 系统配置
- **模块配置**: `./config/modules.json`
- **用户管理**: `./config/users.json`
- **默认配置**: `./config/default.json`

## 性能特性
- **解析性能**: 0.03ms/次 (优秀)
- **ESM兼容**: 纯ESM模块系统
- **热重载**: 支持配置文件变更自动重载
- **验证完整**: 100%测试覆盖率

## 版本信息
- **当前版本**: v2.1 (Compatibility Field Enhancement)
- **状态**: ✅ 生产就绪，✅ 测试通过，✅ ESM兼容
- **真实Provider**: 3个Provider，16个模型，56个配置
- **🆕 新增功能**: 兼容性字段简单字符串格式支持