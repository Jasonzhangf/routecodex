# RouteCodex - 多提供商OpenAI代理服务器

[![npm version](https://badge.fury.io/js/routecodex.svg)](https://badge.fury.io/js/routecodex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-4.9+-blue.svg)](https://www.typescriptlang.org/)

RouteCodex是一个功能强大的多提供商OpenAI代理服务器，支持原生dry-run调试能力、动态路由分类、4层管道架构和实时监控。提供统一的API接口，无缝集成多个AI服务提供商。

## 🚀 核心特性

### 🏗️ 4层管道架构
- **LLM Switch层**: 动态路由分类和协议转换
- **Compatibility层**: 格式转换和字段适配
- **Provider层**: 标准HTTP通信和服务适配
- **AI Service层**: 多提供商AI模型支持

### 🔧 智能路由系统
支持7种动态路由类别，自动选择最优处理流水线：
- `default`: 标准请求路由
- `longcontext`: 长文本处理请求
- `thinking`: 复杂推理请求
- `background`: 后台处理请求
- `websearch`: 网络搜索请求
- `vision`: 图像处理请求
- `coding`: 代码生成请求

### 🛠️ Provider V2架构
完全重构的Provider系统，提供：
- 统一的OpenAI标准接口
- 配置驱动的服务适配
- 双向钩子系统
- 高级内存管理
- 错误边界保护

### 🎯 Dry-Run调试系统
完整的调试和测试框架：
- 节点级dry-run执行
- 智能输入模拟
- 双向管道处理
- 高级错误恢复机制

### 📊 实时监控界面
基于Web的综合调试界面：
- 实时系统监控
- 性能可视化
- 模块管理
- 事件探索

## 📦 支持的提供商

| 提供商 | 支持状态 | 认证方式 | 特色功能 |
|--------|----------|----------|----------|
| **OpenAI** | ✅ 完全支持 | API Key | GPT系列模型，DALL-E图像生成 |
| **Anthropic** | ✅ 完全支持 | API Key | Claude系列模型，长上下文支持 |
| **Qwen** | ✅ 完全支持 | OAuth/API Key | 阿里云通义千问系列 |
| **GLM** | ✅ 完全支持 | API Key | 智谱AI GLM系列 |
| **LM Studio** | ✅ 完全支持 | API Key | 本地模型部署，工具调用支持 |
| **iFlow** | ✅ 完全支持 | OAuth | 多模态AI服务 |

## 🚀 快速开始

### 系统要求

- **Node.js**: 16.0.0 或更高版本
- **npm**: 8.0.0 或更高版本
- **操作系统**: Windows 10+, macOS 10.15+, Ubuntu 20.04+
- **内存**: 建议 4GB 以上
- **磁盘空间**: 500MB 可用空间

### 安装

#### 方式一：自动安装（推荐）

```bash
# 使用npm脚本自动安装
npm run install:global

# 或者快速安装（跳过测试）
npm run install:quick
```

#### 方式二：手动安装

```bash
# 克隆仓库
git clone https://github.com/your-repo/routecodex.git
cd routecodex

# 安装依赖
npm install

# 构建项目
npm run build

# 全局安装
npm install -g .
```

#### 方式三：使用安装脚本

```bash
# Linux/macOS
./scripts/build-and-install.sh

# Windows
scripts\build-and-install.bat
```

### 基础配置

1. **创建配置文件**
```bash
# 复制示例配置
cp config/examples/basic-config.json ~/.routecodex/config.json
```

2. **配置提供商**
```json
{
  "providers": {
    "openai-provider": {
      "type": "openai-standard",
      "config": {
        "baseUrl": "https://api.openai.com/v1",
        "auth": {
          "type": "apikey",
          "apiKey": "${OPENAI_API_KEY}"
        }
      }
    }
  },
  "pipelines": [
    {
      "id": "openai-gpt4",
      "providerId": "openai-provider",
      "models": ["gpt-4"],
      "modules": {
        "llmSwitch": { "type": "openai-passthrough" },
        "compatibility": { "type": "openai-normalizer" },
        "provider": { "type": "openai-http" }
      }
    }
  ]
}
```

3. **设置环境变量**
```bash
# OpenAI API密钥
export OPENAI_API_KEY="your-openai-api-key"

# 可选：其他提供商密钥
export ANTHROPIC_API_KEY="your-anthropic-api-key"
export QWEN_API_KEY="your-qwen-api-key"
```

### 启动服务

```bash
# 启动RouteCodex服务器
routecodex start --config ~/.routecodex/config.json --port 5506

# 后台运行
routecodex start --config ~/.routecodex/config.json --port 5506 --daemon

# 前台运行（限时）
routecodex start --config ~/.routecodex/config.json --port 5506 --timeout 300
```

### 验证安装

```bash
# 检查版本
routecodex --version

# 检查配置
routecodex config validate

# 测试API连接
curl -X POST http://localhost:5506/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-key" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Hello, world!"}]
  }'
```

## 📖 使用指南

### 基础API调用

RouteCodex提供与OpenAI完全兼容的API接口：

#### Chat Completions

```bash
curl -X POST http://localhost:5506/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Explain quantum computing in simple terms."}
    ],
    "max_tokens": 1000,
    "temperature": 0.7
  }'
```

#### 工具调用

```bash
curl -X POST http://localhost:5506/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {"role": "user", "content": "What is the weather in Tokyo?"}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Get current weather information",
          "parameters": {
            "type": "object",
            "properties": {
              "location": {"type": "string", "description": "City name"}
            },
            "required": ["location"]
          }
        }
      }
    ]
  }'
```

#### 流式响应

```bash
curl -X POST http://localhost:5506/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Write a short story"}],
    "stream": true
  }'
```

### 高级功能

#### 动态路由配置

```json
{
  "dynamicRouting": {
    "enabled": true,
    "categories": {
      "longcontext": {
        "targets": [
          {
            "providerId": "anthropic-provider",
            "modelId": "claude-3-5-sonnet-20241022"
          }
        ],
        "triggers": [
          {"type": "token_count", "threshold": 100000},
          {"type": "content_type", "value": "document"}
        ]
      },
      "coding": {
        "targets": [
          {
            "providerId": "qwen-provider",
            "modelId": "qwen3-coder-plus"
          }
        ],
        "triggers": [
          {"type": "keyword", "values": ["code", "function", "bug"]},
          {"type": "language_detection", "languages": ["python", "javascript", "typescript"]}
        ]
      }
    }
  }
}
```

#### Dry-Run调试

```bash
# 启用dry-run模式
routecodex start --config ~/.routecodex/config.json --dry-run

# 运行dry-run测试
routecodex dry-run --config ~/.routecodex/config.json --test-file examples/test-request.json

# 生成dry-run报告
routecodex dry-run --config ~/.routecodex/config.json --output-report debug-report.json
```

#### 性能监控

```bash
# 启用监控
routecodex start --config ~/.routecodex/config.json --monitoring

# 查看性能指标
curl http://localhost:5506/api/debug/metrics

# 导出监控数据
curl http://localhost:5506/api/debug/export/json > monitoring-data.json
```

## 🏗️ 架构设计

### 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                    RouteCodex System Architecture               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │   HTTP Server   │  │   WebSocket     │  │   Debug API     │  │
│  │                 │  │   Interface     │  │                 │  │
│  │ • REST API      │  │ • Real-time     │  │ • Metrics       │  │
│  │ • Streaming     │  │   updates       │  │ • Event log     │  │
│  │ • Authentication│  │ • Monitoring    │  │ • Health check  │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    4-Layer Pipeline Architecture             │  │
│  │                                                             │  │
│  │  ┌─────────────┬──────────────┬──────────────────────────┐  │  │
│  │  │  LLM Switch │ Compatibility │        Provider         │  │  │
│  │  │             │              │                          │  │  │
│  │  │ • Routing   │ • Format     │ • HTTP communication     │  │  │
│  │  │ • Protocol  │   conversion │ • Authentication         │  │  │
│  │  │ • Classification │ • Field  │ • Error handling         │  │  │
│  │  │             │   mapping    │ • Health monitoring      │  │  │
│  │  └─────────────┴──────────────┴──────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    Configuration & Management               │  │
│  │                                                             │  │
│  │  ┌─────────────┬──────────────┬──────────────────────────┐  │  │
│  │  │   Config    │   Monitoring  │      Dry-Run System      │  │  │
│  │  │  Engine     │              │                          │  │  │
│  │  │ • JSON      │ • Performance │ • Node-level execution   │  │  │
│  │  │ • Validation │ • Metrics     │ • Input simulation       │  │  │
│  │  │ • Hot reload │ • Health      │ • Error boundaries       │  │  │
│  │  └─────────────┴──────────────┴──────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 核心组件

#### 1. LLM Switch层
- **动态路由分类**: 基于请求内容自动选择处理流水线
- **协议转换**: OpenAI ↔ Anthropic ↔ Gemini协议转换
- **请求预处理**: 模型映射、参数标准化、工具调用处理

#### 2. Compatibility层
- **格式转换**: 字段映射、数据结构适配
- **提供商适配**: 处理不同提供商的特殊要求
- **响应标准化**: 统一输出格式，错误处理

#### 3. Provider层 (V2)
- **统一接口**: 标准化的Provider实现
- **认证管理**: API Key、OAuth、会话管理
- **连接管理**: 连接池、重试机制、健康检查

#### 4. AI Service层
- **多提供商支持**: 统一的AI服务接口
- **模型管理**: 动态模型加载、能力检测
- **性能优化**: 批量处理、缓存机制

### 配置系统

#### 配置文件结构
```json
{
  "version": "1.0",
  "server": {
    "host": "0.0.0.0",
    "port": 5506,
    "cors": {
      "enabled": true,
      "origins": ["*"]
    }
  },
  "providers": {
    "provider-id": {
      "type": "openai-standard|anthropic|qwen|glm|lmstudio",
      "enabled": true,
      "config": {
        "baseUrl": "https://api.provider.com/v1",
        "auth": {
          "type": "apikey|oauth",
          "apiKey": "${API_KEY}" | "oauth-config"
        },
        "models": {
          "model-id": {
            "maxTokens": 8192,
            "temperature": 0.7,
            "supportsTools": true,
            "supportsStreaming": true
          }
        },
        "overrides": {
          "defaultModel": "gpt-4",
          "headers": {
            "User-Agent": "RouteCodex/2.0"
          }
        }
      }
    }
  },
  "pipelines": [
    {
      "id": "pipeline-id",
      "providerId": "provider-id",
      "models": ["model-1", "model-2"],
      "modules": {
        "llmSwitch": {
          "type": "openai-passthrough|anthropic-converter",
          "config": {}
        },
        "compatibility": {
          "type": "openai-normalizer|field-mapping",
          "config": {}
        },
        "provider": {
          "type": "openai-http|anthropic-http",
          "config": {}
        }
      },
      "hooks": {
        "preProcess": [],
        "postProcess": []
      }
    }
  ],
  "dynamicRouting": {
    "enabled": true,
    "defaultTarget": {
      "providerId": "default-provider",
      "modelId": "default-model"
    },
    "categories": {
      "category-id": {
        "targets": [
          {
            "providerId": "provider-id",
            "modelId": "model-id",
            "weight": 1.0
          }
        ],
        "triggers": [
          {
            "type": "token_count|content_type|keyword|language_detection",
            "condition": ">=|<=|==|contains|matches",
            "value": "threshold|pattern|list"
          }
        ]
      }
    }
  },
  "monitoring": {
    "enabled": true,
    "metrics": {
      "performance": true,
      "errors": true,
      "usage": true
    },
    "logging": {
      "level": "info",
      "format": "json"
    }
  },
  "dryRun": {
    "enabled": false,
    "global": {
      "defaultMode": "output-validation",
      "verbosity": "normal",
      "autoCleanup": true
    },
    "memory": {
      "maxMemoryUsage": 536870912,
      "cleanupInterval": 60000,
      "enableMonitoring": true
    }
  }
}
```

## 🔧 开发指南

### 项目结构

```
routecodex/
├── src/                          # 源代码目录
│   ├── cli.ts                   # CLI入口点
│   ├── index.ts                 # 主模块入口
│   ├── commands/                # CLI命令实现
│   │   ├── start.ts            # 启动命令
│   │   ├── config.ts           # 配置命令
│   │   ├── dry-run.ts          # Dry-run命令
│   │   └── debug.ts            # 调试命令
│   ├── server/                  # HTTP服务器
│   │   ├── http-server.ts      # 主HTTP服务器
│   │   ├── websocket-server.ts # WebSocket服务器
│   │   └── handlers/           # API处理器
│   ├── modules/                # 核心模块
│   │   ├── pipeline/           # 4层管道架构
│   │   │   ├── modules/        # 管道模块
│   │   │   │   ├── provider/   # Provider V2模块
│   │   │   │   └── ...
│   │   │   └── ...
│   │   ├── config-manager/     # 配置管理
│   │   ├── monitoring/         # 监控系统
│   │   └── debug/             # 调试系统
│   └── types/                  # TypeScript类型定义
├── sharedmodule/               # 共享模块
│   ├── llmswitch-core/        # LLM转换核心
│   ├── config-engine/         # 配置引擎
│   └── config-testkit/        # 配置测试工具
├── config/                     # 配置文件
│   ├── examples/              # 配置示例
│   └── schemas/               # JSON Schema定义
├── scripts/                    # 构建和安装脚本
├── web-interface/             # Web调试界面
├── docs/                      # 文档
├── tests/                     # 测试文件
└── vendor/                    # 第三方依赖
```

### 构建和开发

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 构建项目
npm run build

# 运行测试
npm test

# 代码检查
npm run lint

# 自动修复lint问题
npm run lint:fix

# 类型检查
npm run type-check

# 清理构建文件
npm run clean
```

### 测试

```bash
# 运行所有测试
npm test

# 运行特定测试
npm test -- --grep "provider"

# 运行集成测试
npm run test:integration

# 运行E2E测试
npm run test:e2e

# 生成测试覆盖率报告
npm run test:coverage

# 运行性能测试
npm run test:performance
```

### 代码规范

- **TypeScript**: 严格模式，完整类型定义
- **ESLint**: 代码风格检查和错误预防
- **Prettier**: 代码格式化
- **Husky**: Git hooks，确保代码质量
- **Conventional Commits**: 标准化提交信息

## 📊 监控和调试

### Web调试界面

RouteCodex提供功能强大的Web调试界面：

```bash
# 启动Web界面
cd web-interface
npm install
npm run dev

# 访问界面
open http://localhost:3000
```

**功能特性**:
- 📊 实时性能仪表板
- 🔧 模块管理和配置
- 📈 交互式图表
- 🔍 事件探索器
- 🎨 响应式设计，支持深色模式

### CLI调试工具

```bash
# 查看系统状态
routecodex status

# 验证配置
routecodex config validate

# 测试提供商连接
routecodex test-provider --provider openai-provider

# 查看实时日志
routecodex logs --follow

# 导出调试数据
routecodex debug export --format json

# 性能分析
routecodex debug profile --duration 60
```

### API调试端点

```bash
# 系统健康检查
GET /api/debug/health

# 模块状态列表
GET /api/debug/modules

# 模块详细信息
GET /api/debug/modules/:id

# 事件列表（支持过滤）
GET /api/debug/events?type=error&limit=100

# 性能指标
GET /api/debug/metrics

# 导出调试数据
GET /api/debug/export/:format
```

## 🔌 集成示例

### Node.js集成

```javascript
import { RouteCodexClient } from 'routecodex-client';

const client = new RouteCodexClient({
  baseURL: 'http://localhost:5506',
  apiKey: 'your-api-key'
});

// 简单对话
const response = await client.chat.completions.create({
  model: 'gpt-4',
  messages: [
    { role: 'user', content: 'Hello, RouteCodex!' }
  ]
});

console.log(response.choices[0].message.content);
```

### Python集成

```python
import openai

# 配置RouteCodex端点
openai.api_base = "http://localhost:5506/v1"
openai.api_key = "your-api-key"

# 使用标准OpenAI客户端
response = openai.ChatCompletion.create(
    model="gpt-4",
    messages=[
        {"role": "user", "content": "Hello from Python!"}
    ]
)

print(response.choices[0].message.content)
```

### cURL集成

```bash
# 设置环境变量
export ROUTECODEX_URL="http://localhost:5506"
export ROUTECODEX_API_KEY="your-api-key"

# 创建别名方便使用
alias rcurl='curl -H "Authorization: Bearer $ROUTECODEX_API_KEY" -H "Content-Type: application/json" $ROUTECODEX_URL/v1'

# 使用别名调用API
rcurl/chat/completions -d '{
  "model": "gpt-4",
  "messages": [{"role": "user", "content": "Hello from cURL!"}]
}'
```

## 🚨 故障排除

### 常见问题

#### 1. 安装问题

**问题**: `npm install -g routecodex` 权限错误
```bash
# 解决方案1：使用nvm管理Node.js
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install node
npm install -g routecodex

# 解决方案2：配置npm前缀
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
npm install -g routecodex
```

#### 2. 启动失败

**问题**: 端口被占用
```bash
# 查看端口占用
lsof -i :5506

# 杀死占用进程
kill -9 <PID>

# 或者使用其他端口
routecodex start --port 5507
```

#### 3. 认证问题

**问题**: API密钥无效
```bash
# 检查环境变量
echo $OPENAI_API_KEY

# 测试API连接
routecodex test-provider --provider openai-provider

# 验证配置
routecodex config validate
```

#### 4. 性能问题

**问题**: 响应速度慢
```bash
# 启用性能监控
routecodex start --monitoring

# 查看性能指标
curl http://localhost:5506/api/debug/metrics

# 优化建议：
# 1. 增加连接池大小
# 2. 启用请求缓存
# 3. 调整超时设置
# 4. 使用更快的模型
```

### 调试模式

```bash
# 启用详细日志
DEBUG=routecodex:* routecodex start

# 启用调试API
routecodex start --debug-api

# 查看内部状态
curl http://localhost:5506/api/debug/internal
```

### 日志分析

```bash
# 查看错误日志
routecodex logs --level error

# 实时跟踪日志
routecodex logs --follow

# 导出日志
routecodex logs --export logs.json

# 分析日志模式
routecodex logs --analyze --pattern "timeout"
```

## 📈 性能优化

### 配置优化

```json
{
  "server": {
    "compression": true,
    "maxRequestSize": "10mb",
    "timeout": 30000
  },
  "providers": {
    "provider-id": {
      "connectionPool": {
        "maxConnections": 10,
        "minConnections": 2,
        "acquireTimeout": 5000
      },
      "cache": {
        "enabled": true,
        "ttl": 300,
        "maxSize": 1000
      }
    }
  }
}
```

### 监控指标

- **响应时间**: P50, P95, P99延迟
- **吞吐量**: 每秒请求数
- **错误率**: 4xx/5xx错误比例
- **内存使用**: 堆内存和系统内存
- **CPU使用**: 处理器使用率

### 扩展性

- **水平扩展**: 支持多实例部署
- **负载均衡**: 内置负载均衡策略
- **缓存策略**: 多级缓存机制
- **连接复用**: HTTP连接池管理

## 🤝 贡献指南

### 开发流程

1. **Fork仓库**并创建功能分支
   ```bash
   git checkout -b feature/amazing-feature
   ```

2. **编写代码**并遵循项目规范
   - TypeScript严格模式
   - 完整的单元测试
   - 详细的文档注释

3. **运行测试**确保代码质量
   ```bash
   npm test
   npm run lint
   npm run type-check
   ```

4. **提交代码**使用规范化信息
   ```bash
   git commit -m "feat: add amazing feature"
   ```

5. **推送分支**并创建Pull Request
   ```bash
   git push origin feature/amazing-feature
   ```

### 代码贡献规范

- **提交信息**: 遵循[Conventional Commits](https://www.conventionalcommits.org/)
- **代码风格**: 使用ESLint和Prettier保持一致
- **测试覆盖率**: 新功能必须包含测试，覆盖率>90%
- **文档更新**: 重大变更需要更新相关文档

### 问题报告

使用GitHub Issues报告问题时，请包含：

- **详细描述**: 问题的具体表现
- **复现步骤**: 如何触发问题
- **环境信息**: OS、Node.js版本、RouteCodex版本
- **相关日志**: 错误日志和调试信息
- **期望行为**: 您期望发生什么

## 📄 许可证

本项目采用MIT许可证 - 详见[LICENSE](LICENSE)文件。

## 🙏 致谢

感谢以下开源项目的支持：

- **OpenAI**: GPT模型和API标准
- **Anthropic**: Claude模型和安全研究
- **TypeScript**: 类型安全的JavaScript
- **Fastify**: 高性能Node.js web框架
- **Zod**: 运行时类型验证
- **Winston**: 日志管理库

## 📞 支持

- **文档**: [完整文档](https://docs.routecodex.com)
- **API参考**: [API文档](https://api.routecodex.com)
- **社区**: [GitHub Discussions](https://github.com/your-repo/routecodex/discussions)
- **问题反馈**: [GitHub Issues](https://github.com/your-repo/routecodex/issues)
- **邮箱**: support@routecodex.com

## 🗺️ 路线图

### v1.0 (当前版本)
- ✅ 4层管道架构
- ✅ Provider V2系统
- ✅ 动态路由分类
- ✅ Dry-Run调试系统
- ✅ Web调试界面

### v1.1 (计划中)
- 🔄 更多AI提供商支持
- 🔄 插件系统
- 🔄 高级缓存策略
- 🔄 分布式部署支持

### v1.2 (未来版本)
- 📋 机器学习模型
- 📋 自动化测试
- 📋 性能优化
- 📋 安全增强

---

**RouteCodex** - 让AI服务集成变得简单而强大 🚀