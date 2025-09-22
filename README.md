# RouteCodex

多Provider OpenAI代理服务器，支持动态路由、负载均衡和主题订阅功能

## 🌟 特性

- **多Provider支持**: 支持OpenAI、Anthropic、Qwen等多种AI服务提供商
- **动态路由**: 智能请求分类和路由到最适合的Provider
- **负载均衡**: 多实例负载均衡和故障转移
- **主题订阅**: 基于主题的消息订阅和发布系统
- **调试中心**: 集成的调试和监控中心
- **错误处理**: 完善的错误处理和重试机制
- **ESM架构**: 纯ES模块系统，现代化的构建工具链

## 📋 项目结构

```
routecodex/
├── src/
│   ├── index.ts                      # 启动入口
│   ├── server/                       # 服务器模块
│   │   ├── http-server.ts            # HTTP服务器
│   │   ├── openai-router.ts          # OpenAI路由
│   │   └── types.ts                  # 服务器类型定义
│   ├── core/                         # 核心模块
│   │   ├── config-manager.ts         # 配置管理器
│   │   ├── provider-manager.ts       # Provider管理器
│   │   ├── request-handler.ts        # 请求处理器
│   │   └── response-handler.ts       # 响应处理器
│   ├── providers/                    # Provider模块
│   │   ├── base-provider.ts          # Provider基类
│   │   ├── openai-provider.ts        # OpenAI兼容Provider
│   │   └── provider-factory.ts      # Provider工厂
│   ├── config/                       # 配置模块
│   │   ├── default-config.json       # 默认配置
│   │   ├── config-types.ts           # 配置类型
│   │   ├── config-loader.ts          # 配置加载器
│   │   └── config-validator.ts       # 配置验证器
│   ├── utils/                        # 工具模块
│   │   ├── logger.ts                 # 日志工具
│   │   ├── error-handler.ts          # 错误处理
│   │   ├── load-balancer.ts          # 负载均衡
│   │   └── failover.ts               # 故障转移
│   └── patches/                      # 补丁模块
│       ├── patch-manager.ts          # 补丁管理器
│       └── openai-patch.ts           # OpenAI补丁
├── config/
│   └── routecodex.json               # 用户配置文件
├── tests/                            # 测试文件
├── docs/                             # 文档
│   ├── ARCHITECTURE.md               # 系统架构文档
│   ├── api/                          # API文档
│   └── deployment/                   # 部署文档
└── test-*.mjs                        # 集成测试文件
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

## 🔧 配置

### 基础配置

编辑 `config/routecodex.json` 文件：

```json
{
  "server": {
    "port": 5506,
    "host": "localhost"
  },
  "providers": {
    "openai-provider": {
      "type": "openai",
      "enabled": true,
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "your-api-key",
      "models": {
        "gpt-4": {
          "maxTokens": 8192,
          "temperature": 0.7
        }
      }
    }
  }
}
```

### 主题订阅配置

```json
{
  "messageCenter": {
    "enableTopicSubscription": true,
    "topics": {
      "debug-events": "Debug events topic",
      "system-events": "System events topic"
    },
    "wildcardSubscription": true
  },
  "debugCenter": {
    "outputDirectory": "./debug-logs",
    "enableTopicSubscription": true,
    "topicSubscriptionConfig": {
      "debugTopic": "debug-events",
      "systemTopic": "system-events",
      "enableWildcardSubscription": true
    }
  }
}
```

## 🧪 测试

### 运行测试

```bash
npm test
```

### 运行集成测试

```bash
# 测试主题订阅功能
node test-debugcenter-topic-subscription.mjs

# 测试基本功能
npm run test:integration
```

## 📊 主题订阅功能

### 消息中心 (MessageCenter)

- **主题订阅**: 支持模块订阅特定主题
- **通配符支持**: 订阅所有主题的通配符功能
- **消息路由**: 基于主题的消息分发和路由
- **统计监控**: 订阅统计和性能监控

### 调试中心 (DebugCenter)

- **事件记录**: 记录所有调试事件和系统事件
- **主题集成**: 与MessageCenter无缝集成
- **会话管理**: 管理调试会话和生命周期
- **性能监控**: 实时性能监控和统计

## 🔍 开发指南

### 代码规范

- 使用TypeScript进行类型安全的开发
- 遵循ESM模块标准
- 使用Prettier进行代码格式化
- 使用ESLint进行代码检查

### 提交规范

- 提交前运行测试和构建
- 使用语义化提交消息
- 确保代码符合项目规范

### 构建发布

```bash
# 构建项目
npm run build

# 验证ESM兼容性
npm run build:verify

# 发布到NPM
npm publish
```

## 📚 文档

- [系统架构](docs/ARCHITECTURE.md) - 详细的系统架构说明
- [API文档](docs/api/) - API接口文档
- [部署指南](docs/deployment/) - 部署相关文档
- [贡献指南](CONTRIBUTING.md) - 如何贡献代码

## 🤝 贡献

欢迎提交Issue和Pull Request！

## 📄 许可证

MIT License

## 🏷️ 版本信息

- **当前版本**: 0.0.1
- **最后更新**: 2025-01-22
- **维护团队**: RouteCodex 开发团队