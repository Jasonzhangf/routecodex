# RouteCodex

多Provider OpenAI代理服务器，支持动态路由、负载均衡和配置热更新功能

## 🌟 核心特性

- **真实Provider支持**: 集成Qwen、IFLOW、MODELSCOPE等3个真实AI服务提供商
- **动态路由系统**: 7个智能路由类别 (default, longContext, thinking, coding, background, websearch, vision)
- **配置热更新**: 实时配置文件监控和自动重新加载
- **负载均衡**: 16个路由目标，56个流水线配置，多密钥支持
- **协议转换**: 支持OpenAI和Anthropic协议输入/输出
- **配置合并**: 用户配置与系统配置智能合并
- **现代化ESM架构**: 纯ES模块系统，完整的TypeScript支持
- **高性能**: <5ms路由延迟，<200ms重载时间

## 🏗️ 系统架构

### v2.0 配置系统架构

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

### 核心模块架构

```
HTTP Request → RouteCodex Server → Virtual Router → Route Target Pool
    ↓
Pipeline Assembly → Provider Execution → Protocol Conversion
    ↓
Configuration System (Hot-Reload) → Error Handling → Monitoring
```

### 动态路由分类

系统支持7个智能路由类别：
- **default**: 主要工作负载 (4个路由目标)
- **longContext**: 长文本处理 (2个路由目标)
- **thinking**: 复杂推理 (4个路由目标)
- **coding**: 代码生成 (2个路由目标)
- **background**: 后台任务 (2个路由目标)
- **websearch**: 网络搜索 (2个路由目标)
- **vision**: 图像处理 (预留)

## 📋 项目结构

```
routecodex/
├── src/
│   ├── index.ts                      # 启动入口
│   ├── server/                       # HTTP服务器层 ✨v2.0
│   │   ├── http-server.ts            # 主HTTP服务器
│   │   ├── openai-router.ts          # OpenAI API路由
│   │   └── types.ts                  # 服务器类型定义
│   ├── config/                      # 配置管理系统 ✨重构完成
│   │   ├── user-config-parser.ts     # 用户配置解析器
│   │   ├── config-merger.ts         # 配置合并器
│   │   ├── auth-file-resolver.ts     # AuthFile解析器
│   │   ├── refactoring-agent.ts     # 重构代理
│   │   ├── merged-config-types.ts   # 合并配置类型
│   │   ├── user-config-types.ts     # 用户配置类型
│   │   └── system-config-types.ts   # 系统配置类型
│   ├── core/                        # 核心业务逻辑
│   │   ├── config-manager.ts         # 配置管理器
│   │   ├── provider-manager.ts       # Provider管理器
│   │   └── request-handler.ts        # 请求处理器
│   ├── modules/                     # 模块系统 ✨v2.0新增
│   │   ├── virtual-router/          # 虚拟路由模块
│   │   │   ├── virtual-router-module.ts
│   │   │   ├── route-target-pool.ts
│   │   │   ├── pipeline-config-manager.ts
│   │   │   └── protocol-manager.ts
│   │   ├── config-manager/          # 配置管理模块
│   │   │   ├── config-manager-module.ts
│   │   │   ├── merged-config-generator.ts
│   │   │   └── config-watcher.ts
│   │   └── unimplemented-module.ts   # 未实现模块
│   ├── providers/                    # Provider实现
│   │   ├── base-provider.ts          # Provider基类
│   │   ├── openai-provider.ts        # OpenAI Provider
│   │   └── enhanced-provider-manager.ts # 增强Provider管理器
│   ├── utils/                       # 工具函数
│   │   ├── error-handling.ts         # 错误处理工具
│   │   ├── logger.ts                # 日志工具
│   │   └── file-watcher.ts          # 文件监控器
│   └── patches/                     # 兼容性补丁
├── config/                           # 系统配置文件
│   ├── modules.json                  # 系统模块配置
│   ├── users.json                   # 用户管理配置
│   └── default.json                 # 默认配置模板
├── tests/                            # 测试文件
├── docs/                             # 文档
└── dist/                             # 构建输出
```

### 用户配置目录

```
~/.routecodex/
├── config.json                      # 用户主配置文件
├── auth/                            # API密钥文件目录
│   ├── qwen-auth-1                 # Qwen API密钥
│   ├── iflow-auth-1                 # IFLOW API密钥
│   └── modelscope-auth-1            # MODELSCOPE API密钥
└── merged-config.json               # 合并配置输出
```

## 🚀 快速开始

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

### 构建项目

```bash
npm run build
```

### 启动服务

```bash
npm start
```

## 🔧 配置系统

### v2.0 配置架构

RouteCodex采用分层配置系统，支持用户配置与系统配置的智能合并：

#### 用户配置 (~/.routecodex/config.json)

```json
{
  "version": "1.0.0",
  "description": "RouteCodex User Configuration",
  "virtualrouter": {
    "providers": {
      "qwen": {
        "type": "openai",
        "baseURL": "https://portal.qwen.ai/v1",
        "apiKey": ["qwen-auth-1", "qwen-auth-2"],
        "models": {
          "qwen3-coder-plus": {"maxContext": 128000, "maxTokens": 32000},
          "qwen3-coder": {"maxContext": 128000, "maxTokens": 32000}
        }
      }
    }
  }
}
```

#### 系统配置 (./config/modules.json)

系统模块默认配置，包含所有模块的基础配置和默认值。

#### 合并配置 (./config/merged-config.json)

自动生成的合并配置文件，包含56个流水线配置和16个路由目标。

### 真实Provider支持

系统已集成3个真实AI服务提供商：

- **Qwen**: 2个模型，2个API密钥，支持代码生成
- **IFLOW**: 4个模型，3个API密钥，多样化模型覆盖
- **MODELSCOPE**: 10个模型，4个API密钥，丰富模型选择

### 路由目标池

系统支持7个预定义路由池，每个池包含不同的路由目标：

- **default**: 4个目标 (主要工作负载)
- **longContext**: 2个目标 (长文本处理)
- **thinking**: 4个目标 (复杂推理)
- **coding**: 2个目标 (代码生成)
- **background**: 2个目标 (后台任务)
- **websearch**: 2个目标 (网络搜索)
- **vision**: 0个目标 (预留)

### 配置热更新

- 配置文件修改后自动重新加载
- 支持配置验证，错误配置不会影响运行
- 事件驱动的配置变更通知
- <200ms重载时间，零停机更新

### 环境变量支持

配置文件支持环境变量替换：
```json
{
  "providers": {
    "openai-provider": {
      "apiKey": "${OPENAI_API_KEY}",
      "baseUrl": "${OPENAI_BASE_URL:-https://api.openai.com/v1}"
    }
  }
}
```

### 配置热更新

- 配置文件修改后自动重新加载
- 支持配置验证，错误配置不会影响运行
- 事件驱动的配置变更通知

## 🧪 测试

### 运行测试

```bash
# 单元测试
npm test

# 测试覆盖率
npm run test:coverage

# 集成测试
npm run test:integration
```

### ESM兼容性验证

```bash
# 构建并验证ESM兼容性
npm run build && node --input-type=module --eval="import('./dist/index.js').then(m => console.log('ESM build successful'))"
```

## 📊 API端点

### OpenAI兼容端点

- `POST /v1/chat/completions` - OpenAI聊天补全
- `POST /v1/completions` - OpenAI文本补全
- `GET /v1/models` - 模型列表

### 系统端点

- `GET /health` - 健康检查
- `GET /config` - 配置信息
- `GET /metrics` - 性能指标

## 🔍 开发指南

### 代码规范

- 使用TypeScript进行类型安全的开发
- 遵循ESM模块标准 (`import/export`)
- 使用 `verbatimModuleSyntax` 严格模式
- 配置变更后必须更新README文档

### 开发流程

1. **理解现有代码**: 阅读相关模块的README和代码
2. **编写测试**: 先写测试，确保功能正确
3. **实现功能**: 编写最简代码通过测试
4. **重构代码**: 改善代码结构和可读性
5. **更新文档**: 确保README与代码保持一致
6. **提交代码**: 运行测试和构建确保无错误

### 错误处理

使用统一的错误处理系统：

```typescript
import { ErrorHandlingUtils } from './utils/error-handling-utils.js';

const errorUtils = ErrorHandlingUtils.createModuleErrorHandler('my-module');

// 处理错误
await errorUtils.handle(error, 'operation-name', {
  additionalContext: { key: 'value' }
});
```

### 配置系统使用

```typescript
import { ConfigManager } from './config/config-manager.js';

const configManager = new ConfigManager('./config.json');
await configManager.initialize();

// 获取配置
const config = configManager.config;

// 监听配置变更
configManager.watch((newConfig) => {
  console.log('配置已更新', newConfig);
});
```

## 📚 架构文档

- [配置系统文档](src/config/README.md) - v2.0配置系统详细说明
- [虚拟路由模块](src/modules/virtual-router/README.md) - 动态路由系统指南
- [配置管理模块](src/modules/config-manager/README.md) - 配置热更新和管理
- [服务器模块](src/server/README.md) - HTTP服务器和API路由
- [核心模块](src/core/README.md) - 核心业务逻辑和Provider管理

## 🏗️ 构建和发布

### 构建命令

```bash
# 开发构建
npm run build:dev

# 生产构建
npm run build

# 清理构建产物
npm run clean

# 验证构建
npm run build:verify
```

### 发布流程

```bash
# 版本更新
npm version patch/minor/major

# 构建
npm run build

# 发布
npm publish
```

## 🤝 贡献

欢迎提交Issue和Pull Request！

### 贡献流程

1. Fork 项目
2. 创建功能分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 创建 Pull Request

## 📄 许可证

MIT License

## 🏷️ 版本信息

- **当前版本**: v2.0
- **最后更新**: 2025-01-22
- **维护团队**: RouteCodex 开发团队
- **构建状态**: ✅ ESM构建成功，v2.0配置系统完整实现
- **Provider支持**: 3个真实Provider，16个模型，56个配置
- **性能评级**: ⚡ 优秀 (<5ms路由延迟，<200ms重载时间)

## 🔄 更新日志

### v2.0 (2025-01-22) - 配置系统重构
- ✅ 完成v2.0配置系统架构重构
- ✅ 实现用户配置与系统配置智能合并
- ✅ 集成3个真实AI服务提供商 (Qwen, IFLOW, MODELSCOPE)
- ✅ 实现7个动态路由类别和16个路由目标
- ✅ 添加56个流水线配置和协议转换支持
- ✅ 完成模块化架构重构
- ✅ 添加AuthFile密钥管理机制
- ✅ 实现配置热更新和文件监控
- ✅ 完善所有模块README文档

### v0.2.7 (2025-01-22)
- ✅ 完成配置管理系统实现
- ✅ 添加配置热更新功能
- ✅ 实现文件监控和自动重载
- ✅ 完善错误处理系统
- ✅ 添加配置验证机制
- ✅ 优化ESM构建流程

### v0.2.6 (2025-01-21)
- ✅ 实现动态路由系统
- ✅ 添加Provider健康监控
- ✅ 完善负载均衡算法
- ✅ 集成调试中心

### v0.2.5 (2025-01-20)
- ✅ 基础HTTP服务器实现
- ✅ OpenAI API兼容路由
- ✅ 多Provider支持框架
- ✅ 错误处理系统