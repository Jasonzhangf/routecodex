# RouteCodex - iFlow Context

## 项目概述

RouteCodex 是一个多Provider OpenAI代理服务器，采用4层流水线架构，支持动态路由、协议转换和AI服务提供商的无缝集成。项目使用TypeScript构建，提供完整的OpenAI兼容API，支持工具调用、流式处理、OAuth认证等高级功能。

## 核心架构

### 4层流水线架构
```
HTTP Request → LLM Switch → Workflow → Compatibility → Provider → AI Service
     ↓             ↓          ↓            ↓           ↓
  请求分析      协议路由    流式控制    格式转换    标准HTTP
```

1. **LLM Switch层**: 协议标准化和动态路由
2. **Workflow层**: 流式/非流式转换控制  
3. **Compatibility层**: 供应商特定格式转换
4. **Provider层**: 标准HTTP通信和认证

### 主要模块
- **Pipeline System**: 可配置的请求处理流水线
- **Virtual Router**: 智能请求路由和分类
- **Config Manager**: 动态配置管理和热重载
- **Debug Center**: 调试信息收集和分析
- **Error Handling**: 统一的错误处理和恢复机制

## 技术栈

- **Runtime**: Node.js 18+ (ES Modules)
- **Language**: TypeScript 5.0+
- **Web Framework**: Express.js
- **Testing**: Jest with ts-jest
- **Build**: TypeScript Compiler
- **Package Manager**: npm

## 关键命令

### 开发命令
```bash
# 安装依赖
npm install

# 构建项目
npm run build

# 开发模式（热重载）
npm run dev

# 运行测试
npm test

# 运行特定测试
npm run test:integration
npm run test:adv-module

# 代码质量检查
npm run lint
npm run lint:fix
npm run format:check
npm run format:fix
```

### 运行命令
```bash
# 启动服务器
npm start

# 使用CLI启动
routecodex start
routecodex start --port 8080 --config ./config.json

# 配置管理
routecodex config init
routecodex config show
routecodex config validate

# 服务器状态
routecodex status
```

### 干运行测试
```bash
# 基础干运行测试
npm run test:dry-run

# LM Studio干运行测试
npm run test:lmstudio-dryrun

# 使用干运行CLI
routecodex dry-run request ./request.json --pipeline-id test
routecodex dry-run batch ./test-data --pattern *.json
```

## 项目结构

```
src/
├── cli.ts              # CLI入口点
├── index.ts            # 主应用入口
├── commands/           # CLI命令实现
├── config/            # 配置管理
├── core/              # 核心模块
├── debug/             # 调试系统
├── logging/           # 统一日志系统
├── modules/           # 功能模块
│   ├── pipeline/      # 流水线系统
│   ├── llmswitch/     # LLM开关模块
│   ├── compatibility/ # 兼容性模块
│   ├── provider/      # 提供商模块
│   └── workflow/      # 工作流模块
├── providers/         # AI服务提供商
├── server/            # HTTP服务器
├── types/             # TypeScript类型定义
└── utils/             # 工具函数

tests/                 # 测试文件
docs/                  # 文档
config/                # 配置文件
scripts/               # 构建和部署脚本
```

## 配置系统

### 配置文件位置
- 用户配置: `~/.routecodex/config.json`
- 模块配置: `./config/modules.json`
- 合并配置: `./config/merged-config.{port}.json`

### 环境变量
- `ROUTECODEX_CONFIG_PATH`: 用户配置文件路径
- `ROUTECODEX_MODULES_CONFIG`: 模块配置文件路径

### 配置模板
```json
{
  "port": 5506,
  "server": { "host": "localhost" },
  "providers": {
    "lmstudio": {
      "type": "lmstudio",
      "baseUrl": "http://localhost:1234",
      "apiKey": "your-api-key"
    }
  },
  "routing": { "default": "lmstudio" },
  "compatibility": "passthrough"
}
```

## 支持的AI提供商

### 完全支持
- **LM Studio**: 本地AI模型托管，完整工具调用支持
- **Qwen**: 阿里云语言模型，OAuth 2.0认证
- **iFlow**: AI服务平台，OAuth 2.0 + PKCE认证
- **OpenAI**: GPT模型系列
- **Anthropic**: Claude模型系列
- **ModelScope**: 模型即服务API

### 计划支持
- Google Gemini
- Cohere
- 自定义提供商框架

## API端点

### OpenAI兼容端点
```
POST /v1/chat/completions
POST /v1/completions
GET  /health
GET  /config
```

### 测试示例
```bash
# 基础对话
curl -X POST http://localhost:5506/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-key" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# 工具调用
curl -X POST http://localhost:5506/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Calculate 15*25"}],
    "tools": [{"type": "function", "function": {"name": "calculate", ...}}]
  }'

# 流式响应
curl -X POST http://localhost:5506/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Count to 5"}],
    "stream": true
  }'
```

## 开发规范

### 代码风格
- TypeScript严格模式启用
- ESLint配置强制执行
- Prettier代码格式化
- 模块化架构设计
- 依赖注入模式

### 测试要求
- 单元测试覆盖率: 70%+
- 集成测试覆盖核心流程
- 端到端测试验证完整功能
- 干运行测试验证流水线

### 错误处理
- 统一的错误处理中心
- 分级错误处理策略
- 自动重试机制
- 详细的错误日志

## 调试和监控

### 调试系统
- DebugCenter: 集中调试信息管理
- 干运行引擎: 离线测试和验证
- 性能分析: 请求处理时间跟踪
- 内存监控: 资源使用情况监控

### 日志系统
- 统一日志格式
- 分级日志级别 (debug, info, warn, error)
- 文件和控制台输出
- 日志轮转和压缩

### 健康检查
```bash
# 服务器状态
curl http://localhost:5506/health

# 配置信息
curl http://localhost:5506/config
```

## 部署和运维

### 构建和发布
```bash
# 构建项目
npm run build

# 运行测试
npm test

# 安全检查
npm run security:audit
npm run security:check

# 代码质量检查
npm run complexity:check
npm run duplication:check
npm run license:check
```

### 生产部署
```bash
# 使用安装脚本
./scripts/simple-install.sh

# 全局安装
npm install -g routecodex

# 使用进程管理器
pm2 start dist/index.js --name routecodex
```

### 性能优化
- 流水线预创建避免运行时开销
- 智能路由减少处理延迟
- 连接池和缓存机制
- 内存泄漏防护

## 故障排除

### 常见问题
1. **端口冲突**: 使用 `graceful-port-handler.sh` 脚本
2. **配置错误**: 验证配置文件格式和路径
3. **Provider连接失败**: 检查网络连接和认证信息
4. **内存泄漏**: 启用调试模式监控内存使用

### 调试工具
```bash
# 启用调试模式
export DEBUG=routecodex:*

# 干运行调试
routecodex dry-run request ./test-request.json --verbose

# 日志分析
routecodex simple-log on --level debug
```

## 版本信息

- **当前版本**: 0.2.7
- **Node.js要求**: >= 18.0.0
- **TypeScript**: 5.0+
- **许可证**: MIT

## 相关文档

- [架构文档](./docs/ARCHITECTURE.md)
- [配置指南](./docs/CONFIG_ARCHITECTURE.md)
- [流水线架构](./docs/pipeline/ARCHITECTURE.md)
- [LM Studio集成](./docs/lmstudio-tool-calling.md)
- [干运行系统](./docs/dry-run/README.md)