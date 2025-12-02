# RouteCodex 系统架构文档

## 概述

RouteCodex 是一个多 Provider OpenAI 代理服务器，支持动态路由、负载均衡和兼容性处理。系统采用模块化设计，支持主题订阅、错误处理、调试中心等高级功能。

## 与 sharedmodule/llmswitch-core 的职责边界

| 责任层 | RouteCodex Host (本仓库) | sharedmodule/llmswitch-core |
| --- | --- | --- |
| 配置解析 | 读取用户配置文件，调用 `bootstrapVirtualRouterConfig`，将 `virtualRouterArtifacts.config` 传给 `HubPipeline` | 验证 routing/providers/classifier，展开 provider.keyAlias.model，输出 `targetRuntime` |
| HTTP 请求 | `/v1/chat`/`/v1/responses`/`/v1/messages` handler 将 HTTP/SSE 载荷封装为 `HubPipelineRequest` | SSE Input → Chat Process → Virtual Router → Output，生成 `providerPayload` + `target` |
| Provider 初始化 | 根据 `virtualRouterArtifacts.targetRuntime` 初始化 Provider 实例，绑定 auth/baseURL/compat profile | 不直接创建 Provider 客户端，仅输出 runtime 元数据 |
| Provider 调用 | 使用 runtimeKey 查找 Provider 实例，向上游发送请求，记录日志/快照 | 输出 `target.runtimeKey`，供 host 查表；捕获 `ProviderErrorEvent` 以管理熔断 |
| 错误处理 | Provider/Compatibility 抛错 → `errorHandlingCenter.handleError` → 上报 `providerErrorCenter`，并映射为 HTTP 响应 | Virtual Router 接收 `ProviderErrorEvent`、执行熔断/降级；Hub Pipeline 将错误冒泡给 host |
| 热更新 | 监听配置变更 → 调用 `hubPipeline.updateVirtualRouterConfig(newArtifacts.config)`，并刷新 Provider runtime | 在内部替换 Virtual Router 配置并继续输出最新的 routing/runtime 状态 |

> **落地要求**：Host 不再解析旧的“合并配置”蓝图，也不在 Provider 层做“模型选择”；所有模型替换/目标决策由 Virtual Router 执行，Host 仅负责“把 HTTP/SSE 转交给 Hub Pipeline + 根据 runtimeKey 调用 Provider”，从而保证单一职责和无兜底策略。

## 系统架构

### 核心组件

```
┌─────────────────────────────────────────────────────────────────┐
│                        RouteCodex 架构                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │   HTTP Server   │  │   Config Mgr    │  │   Provider Mgr  │  │
│  │                 │  │                 │  │                 │  │
│  │  • 请求处理      │  │  • 配置管理      │  │  • Provider管理  │  │
│  │  • 路由分发      │  │  • 验证器        │  │  • 负载均衡      │  │
│  │  • 响应格式化    │  │  • 热重载        │  │  • 故障转移      │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│           │                     │                     │         │
│           └─────────────────────┼─────────────────────┘         │
│                                 │                               │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │   Core Logic    │  │   MessageCenter │  │   DebugCenter   │  │
│  │                 │  │                 │  │                 │  │
│  │  • 请求转发      │  │  • 主题订阅      │  │  • 调试记录      │  │
│  │  • 响应处理      │  │  • 消息路由      │  │  • 性能监控      │  │
│  │  • 错误处理      │  │  • 模块通信      │  │  • 会话管理      │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│           │                     │                     │         │
│           └─────────────────────┼─────────────────────┘         │
│                                 │                               │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │    Utilities    │  │   ErrorHandling  │  │     Patches     │  │
│  │                 │  │                 │  │                 │  │
│  │  • 日志工具      │  │  • 错误处理      │  │  • 兼容性补丁    │  │
│  │  • 负载均衡      │  │  • 重试机制      │  │  • 响应转换      │  │
│  │  • 故障转移      │  │  • 异常恢复      │  │  • 格式适配      │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 主题订阅系统

#### MessageCenter 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        MessageCenter                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │   Module Mgr    │  │TopicSubscription │  │MessageProcessor │  │
│  │                 │  │      Manager     │  │                 │  │
│  │  • 模块注册      │  │  • 主题订阅      │  │  • 消息验证      │  │
│  │  • 生命周期      │  │  • 通配符支持    │  │  • 消息处理      │  │
│  │  • 状态管理      │  │  • 订阅管理      │  │  • 路由分发      │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│           │                     │                     │         │
│           └─────────────────────┼─────────────────────┘         │
│                                 │                               │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │Request Mgr     │  │Statistics Mgr   │  │ Broadcast Mgr   │  │
│  │                 │  │                 │  │                 │  │
│  │  • 请求管理      │  │  • 性能统计      │  │  • 消息广播      │  │
│  │  • 响应处理      │  │  • 监控指标      │  │  • 多播分发      │  │
│  │  • 超时控制      │  │  • 报告生成      │  │  • 订阅通知      │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

#### 主题订阅特性

1. **主题订阅**
   - 支持模块订阅特定主题
   - 动态订阅/取消订阅
   - 订阅状态管理

2. **通配符支持**
   - 支持通配符订阅所有主题
   - 灵活的消息路由
   - 订阅者过滤

3. **消息路由**
   - 基于主题的消息分发
   - 多播消息传递
   - 订阅者隔离

4. **统计监控**
   - 订阅统计信息
   - 消息传递统计
   - 性能指标收集

### 调试中心集成

#### DebugCenter 主题订阅集成

```
┌─────────────────────────────────────────────────────────────────┐
│                     DebugCenter                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │   Event Bus     │  │   Session Mgr   │  │   Topic Sub     │  │
│  │                 │  │                 │  │                 │  │
│  │  • 事件总线      │  │  • 会话管理      │  │  • 主题订阅      │  │
│  │  • 事件处理      │  │  • 状态跟踪      │  │  • 消息发布      │  │
│  │  • 订阅管理      │  │  • 生命周期      │  │  • 跨模块通信    │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│           │                     │                     │         │
│           └─────────────────────┼─────────────────────┘         │
│                                 │                               │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │   Pipeline      │  │   Message Ctr  │  │   Statistics    │  │
│  │                 │  │                 │  │                 │  │
│  │  • 流水线处理    │  │  • 消息中心      │  │  • 统计信息      │  │
│  │  • 事件记录      │  │  • 集成通信      │  │  • 性能监控      │  │
│  │  • 协调调度      │  │  • 全局实例      │  │  • 报告生成      │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 模块依赖关系

```
┌─────────────────────────────────────────────────────────────────┐
│                       模块依赖关系                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐  │
│  │   RouteCodex    │    │  rcc-errorhandling │  │
│  │                 │    │                 │    │                 │  │
│  │  • 主应用        │    │  • 调试中心      │    │  • 错误处理      │  │
│  │  • 服务器        │    │  • 主题订阅      │    │  • 异常管理      │  │
│  │  • 路由管理      │    │  • 会话跟踪      │    │  • 重试机制      │  │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘  │
│           │                       │                       │         │
│           └───────────────────────┼───────────────────────┘         │
│                                   │                               │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │                    rcc-basemodule                              │  │
│  │                                                                 │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │  │
│  │  │  MessageCenter  │  │   Interfaces    │  │   Utilities     │  │  │
│  │  │                 │  │                 │  │                 │  │
│  │  │  • 主题订阅      │  │  • 类型定义      │  │  • 工具函数      │  │
│  │  │  • 消息路由      │  │  • 接口规范      │  │  • 辅助方法      │  │
│  │  │  • 模块通信      │  │  • 数据结构      │  │  • 通用模块      │  │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘  │  │
│  │                                                                 │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Hub Pipeline 集成（llmswitch-core）

RouteCodex 现在完全依赖 sharedmodule/llmswitch-core 的 Hub Pipeline，实现“HTTP ↔ 标准化请求 ↔ Virtual Router ↔ Provider”全链路处理：

- **唯一入口**：服务器通过 `RouteCodexHttpServer` 调用 `sharedmodule/llmswitch-core/dist/conversion/hub/pipeline/hub-pipeline`，禁止旁路加载核心模块。
- **配置来源**：`routecodex-config-loader` 读取用户配置后调用 `bootstrapVirtualRouterConfig`。该工具会校验 routing/providers、展开 `provider.keyAlias.model`、生成 `targetRuntime` 映射（endpoint、headers、auth、compat profile），Hub Pipeline 构造函数直接接受该结果。
- **节点链路**：Hub Pipeline 在内部组成 `SSE Input → Input Node → Chat Process → Virtual Router → (Compatibility，可选) → Output/SSE`。Host 不关心节点细节，只需要把 HTTP 请求封装成标准化的 Hub 请求。
- **工具治理**：唯一的工具治理点位于 `chat-process-node`。Compatibility 层被下沉到 Provider 运行时（`src/modules/pipeline/modules/provider/v2/compatibility`），仅做 Provider 特定的最小字段修剪。
- **Provider 调度**：Virtual Router 负责分类、熔断、负载均衡，并把 `target.runtimeKey` 写入请求。Host 使用 `bootstrapVirtualRouterConfig` 输出的 `targetRuntime` 把 runtimeKey 映射到具体 Provider 实例（包含 OAuth/apiKey 配置、baseURL、compat profile）。
- **错误流**：Provider/Compatibility 报错后调用 `errorHandlingCenter.handleError`，同时通过 `providerErrorCenter.emit` 把 `ProviderErrorEvent` 交还给 Virtual Router，以便执行熔断和健康统计。

借助 Hub Pipeline，HTTP 层只需关注请求封装与 Provider runtime 生命周期，核心能力全部收敛在 sharedmodule 中，实现“入口单一、无兜底”的目标。

## 技术栈

### 核心技术

- **Node.js**: 运行时环境
- **TypeScript**: 类型安全的JavaScript
- **ESM**: 纯ES模块系统
- **Rollup**: 模块打包工具

### 构建工具

- **TypeScript**: 编译时类型检查
- **Rollup**: ESM模块打包
- **Jest**: 单元测试框架
- **ESLint**: 代码质量检查

### 发布工具

- **NPM**: 包管理器
- **Semantic Versioning**: 版本管理
- **CI/CD**: 自动化构建和发布

## 消息流程

### 主题订阅消息流程

```
┌─────────────────────────────────────────────────────────────────┐
│                      主题订阅消息流程                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Publisher → MessageCenter → TopicSubscription → Subscribers   │
│      │             │                   │             │          │
│      │             │                   │             │          │
│  ┌─────┐      ┌──────┐          ┌──────┐      ┌──────┐         │
│  │Publish│      │Route │          │Topic │      │Receive│       │
│  │Message│      │Message│          │Match │      │Message│       │
│  └─────┘      └──────┘          └──────┘      └──────┘         │
│      │             │                   │             │          │
│      │             │                   │             │          │
│      ▼             ▼                   ▼             ▼          │
│  ┌─────┐      ┌──────┐          ┌──────┐      ┌──────┐         │
│  │Create│      │Validate│          │Filter│      │Process│       │
│  │Message│      │Message│          │Subs  │      │Message│       │
│  └─────┘      └──────┘          └──────┘      └──────┘         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 错误处理流程

```
┌─────────────────────────────────────────────────────────────────┐
│                        错误处理流程                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Error → ErrorHandling → Recovery → Retry/Fallback → Success     │
│    │         │              │          │            │          │
│    │         │              │          │            │          │
│  ┌───┐   ┌─────┐      ┌─────┐     ┌─────┐     ┌─────┐   ┌─────┐ │
│  │Cap│   │Class│      │Analyze│   │Retry│     │Fallback│ │Result│ │
│  │ture│   │ify │      │Error │   │Logic│     │Handler │ │Log  │ │
│  └───┘   └─────┘      └─────┘     └─────┘     └─────┘   └─────┘ │
│    │         │              │          │            │          │
│    │         │              │          │            │          │
│    ▼         ▼              ▼          ▼            ▼          │
│  ┌───┐   ┌─────┐      ┌─────┐     ┌─────┐     ┌─────┐   ┌─────┐ │
│  │Log │   │Track│      │Recover│   │Attempt│   │Alternative││End  │ │
│  │Error│   │Error│      │State  │   │Count │   │Solution│ │Flow │ │
│  └───┘   └─────┘      └─────┘     └─────┘     └─────┘   └─────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 配置管理

### 系统配置

```json
{
  "server": {
    "port": 5506,
    "host": "localhost",
    "cors": {
      "enabled": true,
      "origins": ["*"]
    }
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
  },
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

### 主题订阅配置

```json
{
  "topicSubscription": {
    "enabled": true,
    "topics": {
      "debug-events": {
        "description": "Debug events topic",
        "subscribers": ["monitoring"]
      },
      "system-events": {
        "description": "System events topic",
        "subscribers": ["errorhandler"]
      },
      "user-events": {
        "description": "User events topic",
        "subscribers": ["analytics", "monitoring"]
      }
    },
    "wildcardEnabled": true,
    "wildcardSubscribers": []
  }
}
```

## 部署架构

### 开发环境

```
┌─────────────────────────────────────────────────────────────────┐
│                        开发环境                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │   Development   │  │   Testing       │  │   Debugging     │  │
│  │                 │  │                 │  │                 │  │
│  │  • 热重载        │  │  • 单元测试      │  │  • 调试工具      │  │
│  │  • 源码映射      │  │  • 集成测试      │  │  • 性能分析      │  │
│  │  • 开发日志      │  │  • 端到端测试    │  │  • 日志查看      │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 生产环境

```
┌─────────────────────────────────────────────────────────────────┐
│                        生产环境                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │   Load Balancer │  │   RouteCodex    │  │   Monitoring    │  │
│  │                 │  │                 │  │                 │  │
│  │  • 负载均衡      │  │  • 多实例        │  │  • 性能监控      │  │
│  │  • 健康检查      │  │  • 容器化        │  │  • 日志收集      │  │
│  │  • 故障转移      │  │  • 自动扩展      │  │  • 告警通知      │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│           │                       │                       │         │
│           └───────────────────────┼───────────────────────┘         │
│                                   │                               │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │                     Infrastructure                             │  │
│  │                                                                 │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │  │
│  │  │   Database      │  │   Cache         │  │   Queue         │  │  │
│  │  │                 │  │                 │  │                 │  │
│  │  │  • 数据存储      │  │  • 缓存管理      │  │  • 消息队列      │  │
│  │  │  • 会话存储      │  │  • 性能优化      │  │  • 异步处理      │  │
│  │  │  • 配置存储      │  │  • 数据同步      │  │  • 任务调度      │  │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘  │  │
│  │                                                                 │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 版本信息

- **当前版本**: 0.0.1
- **最后更新**: 2025-01-22
- **维护团队**: RouteCodex 开发团队
- **文档版本**: 1.0.0

## 相关文档

- [README.md](./README.md) - 项目概述和快速开始
- [CONTRIBUTING.md](./CONTRIBUTING.md) - 贡献指南
- [CHANGELOG.md](./CHANGELOG.md) - 变更日志
- [API 文档](./docs/api/) - API 接口文档
- [部署指南](./docs/deployment/) - 部署相关文档
