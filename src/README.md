# RouteCodex 源代码目录

## 概述

RouteCodex 是一个多提供商的 OpenAI 代理服务器，具有原生试运行能力。该项目的核心功能是将不同 AI 服务提供商的协议转换为统一的 OpenAI 兼容接口。

## 目录结构

```
src/
├── commands/          # CLI 命令实现
├── config/            # 配置管理和验证
├── core/              # 核心组件和系统架构
├── debug/             # 调试和诊断工具
├── logging/           # 日志系统
├── modules/           # 功能模块（流水线系统）
├── patches/           # 兼容性补丁
├── providers/         # AI 服务提供商适配器
├── server/            # HTTP 服务器和 API 路由
├── types/             # TypeScript 类型定义
└── utils/             # 工具函数和辅助类
```

## 核心架构

RouteCodex 采用 4 层管道架构：

1. **LLM Switch** - 动态路由分类
2. **Workflow** - 流程控制
3. **Compatibility** - 格式转换和适配
4. **Provider** - AI 服务提供商通信

## 主要功能

- **多提供商支持**: LM Studio、Qwen、iFlow、OpenAI、Anthropic 等
- **工具调用**: 支持 AI 模型的工具调用功能
- **流式响应**: 实时流式 AI 响应
- **动态路由**: 根据请求内容智能选择处理路径
- **配置驱动**: JSON 配置文件定义系统行为
- **调试支持**: 完整的请求追踪和调试系统

## 开发指南

### 快速开始

```bash
# 安装依赖
npm install

# 构建项目
npm run build

# 开发模式
npm run dev

# 运行测试
npm test
```

### 代码结构

- **commands/**: CLI 命令行工具
- **config/**: 配置文件管理和验证
- **core/**: 系统核心组件
- **modules/**: 可插拔的功能模块
- **providers/**: AI 服务提供商适配器
- **server/**: HTTP 服务器和 API 端点

### 关键文件

- `index.ts` - 主入口点
- `cli.ts` - CLI 命令行接口
- `server/http-server.ts` - HTTP 服务器实现
- `modules/pipeline/` - 流水线系统实现

## 构建和部署

### 构建过程

```bash
# 清理构建目录
npm run clean

# 运行代码检查
npm run lint

# 构建项目
npm run build
```

### 部署

```bash
# 全局安装
npm run install:global

# 启动服务
routecodex start
```

## 配置

RouteCodex 使用 JSON 配置文件来定义系统行为：

- **用户基础配置**: `~/.routecodex/simple-log-config.json`
- **系统配置**: 项目目录下的配置文件
- **提供商配置**: 各 AI 服务的连接参数

## 调试和测试

### 调试模式

```bash
# 启用详细日志
routecodex simple-log on --level debug

# 启动调试模式
npm run dev
```

### 测试

```bash
# 运行所有测试
npm test

# 运行集成测试
npm run test:integration

# 运行端到端测试
npm run test:e2e
```

## 扩展开发

### 添加新的提供商

1. 在 `providers/` 目录创建新的提供商实现
2. 在 `config/` 目录添加相应的配置验证
3. 在 `types/` 目录添加类型定义
4. 更新文档和测试

### 添加新的模块

1. 在 `modules/` 目录创建新模块
2. 实现必要的接口
3. 添加相应的配置和类型定义
4. 编写测试用例

## 文档

详细文档请参考：

- [项目主文档](../../README.md)

## 最近变更（重要）

- GLM 1210 兼容：在发往 GLM 的最终载荷中，移除“非最后一条”消息的 `assistant.tool_calls` 字段，避免上游 400/1210。工具功能不受影响，`tools` 与 `tool` 角色消息仍保留。
- 流式错误可见性：在 SSE 开始之前（`headersSent=false`）优先返回 JSON 错误（4xx/5xx）；若已开始 SSE，则输出包含错误信息的 SSE 块后 `[DONE]`，避免“静默停止”。
- 预心跳优化：增加预心跳延迟窗口 `RCC_PRE_SSE_HEARTBEAT_DELAY_MS`（默认 800ms），提升早期错误的可见性。
- Anthropic 工具调用对齐：默认“信任 schema”，不更改工具名与参数字段（trustSchema=true）。OpenAI `tool_calls` → Anthropic `tool_use` 时，原样透传 `function.name/arguments`，确保与 Claude Code Router 等客户端的正确工具调用流程（`stop_reason=tool_use`）。
- [架构文档](../../docs/)
- [API 文档](../../docs/api/)
- [配置指南](../../docs/configuration/)

## 贡献指南

1. Fork 项目
2. 创建功能分支
3. 提交更改
4. 推送到分支
5. 创建 Pull Request

## 许可证

本项目采用 MIT 许可证 - 详见 [LICENSE](../../LICENSE) 文件。
