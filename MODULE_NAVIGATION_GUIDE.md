# RouteCodex 模块导航和目录指引

> **版本**: 1.0.0
> **更新时间**: 2025-11-01
> **用途**: 为开发者提供完整的模块导航和快速查找指南

## 🗺️ 项目整体架构导航

### 📍 项目根目录结构
```
routecodex-worktree/dev/
├── 📄 PIPELINE_ARCHITECTURE_GUIDE.md    # 完整架构指南 (本文档)
├── 📄 MODULE_NAVIGATION_GUIDE.md         # 模块导航指南 (本文件)
├── 📁 src/                              # 核心源代码目录
├── 📁 sharedmodule/                     # 共享模块目录
├── 📁 web-interface/                    # Web调试界面
├── 📁 docs/                             # 项目文档
├── 📁 scripts/                          # 构建和部署脚本
├── 📄 package.json                      # 项目依赖配置
└── 📄 tsconfig.json                     # TypeScript配置
```

## 🎯 按功能分类的模块导航

### 🚀 核心流水线模块 (4层架构)

#### **Layer 1: LLM Switch - 动态路由分类**
```
📁 sharedmodule/llmswitch-core/         # 工具调用统一处理核心
├── 📄 src/conversion/shared/
│   ├── tool-canonicalizer.ts           # 工具调用标准化处理
│   └── [功能: 统一工具文本收割、调用去重、结果包剥离]
└── 📄 README.md                         # llmswitch-core模块说明

📁 sharedmodule/llmswitch-ajv/           # AJV协议转换
├── 📄 src/
│   └── [功能: OpenAI <> Anthropic协议转换]
└── 📄 README.md                         # AJV模块说明
```

**快速查找**: 🚨 **工具调用问题** → `sharedmodule/llmswitch-core/src/conversion/shared/tool-canonicalizer.ts`

#### **Layer 2: Compatibility - 格式转换**
```
📁 src/modules/pipeline/modules/compatibility/
├── 📄 passthrough-compatibility.ts      # 直通兼容 (无转换)
├── 📄 lmstudio-compatibility.ts         # LM Studio格式适配
├── 📄 qwen-compatibility.ts             # 通义千问格式适配
├── 📄 glm-compatibility.ts              # 智谱GLM格式适配
├── 📄 iflow-compatibility.ts            # Iflow格式适配
├── 📄 field-mapping.ts                  # 通用字段映射工具
├── 📄 glm-utils/                        # GLM专用工具集
└── 📄 README.md                         # Compatibility模块说明
```

**快速查找**: 🔄 **格式转换问题** → `src/modules/pipeline/modules/compatibility/`

#### **Layer 3: Provider - HTTP服务**
```
📁 src/modules/pipeline/modules/provider/
├── 📄 shared/
│   ├── base-http-provider.ts           # HTTP Provider基类
│   └── provider-helpers.ts              # Provider辅助工具
├── 📄 generic-http-provider.ts          # 通用HTTP Provider
├── 📄 generic-openai-provider.ts        # 通用OpenAI Provider
├── 📄 lmstudio-provider-simple.ts       # LM Studio Provider
├── 📄 openai-provider.ts                # OpenAI官方Provider
├── 📄 qwen-provider.ts                  # 通义千问Provider
├── 📄 glm-http-provider.ts              # 智谱GLM Provider
├── 📄 iflow-provider.ts                 # Iflow Provider
├── 📄 qwen-oauth.ts                     # Qwen OAuth处理
├── 📄 iflow-oauth.ts                    # Iflow OAuth处理
└── 📄 README.md                         # Provider模块说明
```

**快速查找**: 🌐 **HTTP通信问题** → `src/modules/pipeline/modules/provider/shared/base-http-provider.ts`

#### **Layer 4: Workflow - 流式控制**
```
📁 src/modules/pipeline/modules/workflow/
├── 📄 streaming-control.ts              # 流式控制核心
└── 📄 README.md                         # Workflow模块说明
```

**快速查找**: 📡 **流式传输问题** → `src/modules/pipeline/modules/workflow/streaming-control.ts`

### 🔧 流水线基础设施

#### **核心接口和类型**
```
📁 src/modules/pipeline/interfaces/
├── 📄 pipeline-interfaces.ts            # 核心接口定义 ⭐️最重要
└── 📄 README.md                         # 接口模块说明

📁 src/modules/pipeline/types/
├── 📄 base-types.ts                     # 基础类型
├── 📄 pipeline-types.ts                 # 流水线类型
├── 📄 provider-types.ts                 # Provider类型
├── 📄 transformation-types.ts           # 转换类型
├── 📄 external-types.ts                 # 外部依赖类型
└── 📄 README.md                         # 类型模块说明
```

#### **核心编排引擎**
```
📁 src/modules/pipeline/core/
├── 📄 base-pipeline.ts                  # 基础流水线实现 ⭐️最重要
├── 📄 pipeline-manager.ts               # 流水线管理器
├── 📄 pipeline-registry.ts              # 流水线注册表
└── 📄 README.md                         # 核心模块说明

📁 src/modules/pipeline/config/
├── 📄 pipeline-config-manager.ts        # 配置管理器
├── 📄 default-config.ts                 # 默认配置
├── 📄 pipeline-assembler.ts             # 流水线组装器
└── 📄 README.md                         # 配置模块说明
```

#### **工具和辅助功能**
```
📁 src/modules/pipeline/utils/
├── 📄 transformation-engine.ts          # 转换引擎 ⭐️重要
├── 📄 auth-resolver.ts                  # 认证解析器
├── 📄 enhanced-auth-resolver.ts         # 增强认证解析
├── 📄 oauth-manager.ts                  # OAuth管理器
├── 📄 debug-logger.ts                   # 调试日志器
├── 📄 preflight-validator.ts            # 预检验证器
├── 📄 tool-mapping-executor.ts          # 工具映射执行器
├── 📄 schema-arg-normalizer.ts          # Schema参数标准化
└── 📄 README.md                         # 工具模块说明
```

### 🔍 调试和监控系统

#### **干运行系统 (高级调试)**
```
📁 src/modules/pipeline/dry-run/
├── 📄 pipeline-dry-run-framework.ts    # 干运行框架 ⭐️核心
├── 📄 dry-run-pipeline-executor.ts     # 干运行执行器
├── 📄 input-simulator.ts                # 输入模拟器
├── 📄 bidirectional-pipeline-dry-run.ts # 双向流水线干运行
├── 📄 memory-management.ts              # 内存管理
├── 📄 error-boundaries.ts               # 错误边界
├── 📄 memory-interface.ts               # 内存接口
├── 📄 pipeline-dry-run-examples.ts      # 使用示例
└── 📄 README.md                         # 干运行系统说明
```

**快速查找**: 🧪 **干运行调试** → `src/modules/pipeline/dry-run/pipeline-dry-run-framework.ts`

#### **性能监控**
```
📁 src/modules/pipeline/monitoring/
├── 📄 performance-monitor.ts            # 性能监控器
└── 📄 README.md                         # 监控模块说明

📁 src/modules/debug/                   # 系统级调试
├── 📄 [功能: 跨模块性能度量、请求日志与错误追踪]
└── 📄 README.md                         # 调试模块说明
```

### 🏛️ 系统级模块

#### **服务器和协议处理**
```
📁 src/server/
├── 📁 handlers/                         # 请求处理器
│   ├── chat-completions.ts              # Chat端点处理 ⭐️重要
│   ├── responses.ts                     # Responses端点处理
│   └── [功能: OpenAI/Anthropic端点实现]
├── 📁 streaming/                        # 流式传输
│   ├── streaming-manager.ts             # 流式管理器
│   └── [功能: SSE流式传输实现]
├── 📁 protocol/                         # 协议适配
├── 📁 types/                            # 服务器类型定义
├── 📁 utils/                            # 服务器工具
└── 📄 README.md                         # 服务器模块说明
```

**快速查找**: 🌐 **API端点问题** → `src/server/handlers/chat-completions.ts`

#### **配置管理**
```
📁 src/config/
├── 📄 [功能: 完整配置管理解决方案]
└── 📄 README.md                         # 配置模块说明

📁 src/modules/config-manager/
├── 📄 [功能: 配置文件管理、热重载和监控]
└── 📄 README.md                         # 配置管理模块说明

📁 sharedmodule/config-engine/           # 配置引擎
├── 📄 [功能: 配置解析、校验、环境变量展开]
└── 📄 README.md                         # 配置引擎说明

📁 sharedmodule/config-compat/           # 配置兼容层
├── 📄 [功能: 历史/外部配置规范化和兼容支持]
└── 📄 README.md                         # 配置兼容层说明
```

#### **虚拟路由和负载均衡**
```
📁 src/modules/virtual-router/
├── 📄 [功能: 智能请求路由、负载均衡和协议转换]
├── 📁 classifiers/                      # 分类器
└── 📄 README.md                         # 虚拟路由模块说明
```

### 🛠️ 开发和部署工具

#### **CLI命令**
```
📁 src/commands/
├── 📄 [功能: RouteCodex命令行工具实现]
└── 📄 README.md                         # CLI命令说明
```

#### **日志系统**
```
📁 src/logging/
├── 📁 validator/                        # 日志验证器
├── 📁 parser/                           # 日志解析器
├── 📁 indexer/                          # 日志索引器
├── 📁 __tests__/                        # 测试文件
└── 📄 README.md                         # 日志系统说明
```

#### **通用工具**
```
📁 src/utils/
├── 📁 model-field-converter/            # 模型字段转换器
├── 📄 [功能: 通用工具函数和辅助类]
└── 📄 README.md                         # 工具模块说明
```

## 🔍 问题定位快速指南

### 🚨 常见问题快速定位

#### **工具调用问题**
```
问题: 工具调用不被执行或格式错误
位置: sharedmodule/llmswitch-core/src/conversion/shared/tool-canonicalizer.ts
调试: 检查工具文本收割、调用去重、参数标准化
```

#### **格式转换问题**
```
问题: 请求格式不兼容Provider
位置: src/modules/pipeline/modules/compatibility/[对应provider]-compatibility.ts
调试: 检查字段映射、参数适配、特殊处理
```

#### **HTTP通信问题**
```
问题: 无法连接AI服务或认证失败
位置: src/modules/pipeline/modules/provider/[对应provider].ts
调试: 检查认证配置、网络连接、错误处理
```

#### **流式传输问题**
```
问题: 流式响应中断或格式错误
位置: src/modules/pipeline/modules/workflow/streaming-control.ts
调试: 检查SSE解析、缓冲管理、协议适配
```

#### **性能问题**
```
问题: 响应慢或内存占用高
位置: src/modules/pipeline/monitoring/performance-monitor.ts
调试: 检查性能指标、内存监控、瓶颈分析
```

#### **配置问题**
```
问题: 配置加载失败或不生效
位置: src/modules/pipeline/config/pipeline-config-manager.ts
调试: 检查配置格式、验证规则、热重载机制
```

### 📊 日志和调试信息查看

#### **实时调试日志**
```bash
# 查看实时调试日志
tail -f ~/.routecodex/logs/debug.log

# 查看流水线执行日志
tail -f ~/.routecodex/logs/pipeline.log

# 查看错误日志
tail -f ~/.routecodex/logs/error.log
```

#### **Web调试界面**
```
访问: http://localhost:3000 (web-interface)
功能: 实时监控、性能图表、事件追踪、配置管理
```

#### **采样数据分析**
```bash
# 查看最近的请求采样
ls -la ~/.routecodex/codex-samples/openai-chat/ | head -10

# 分析工具调用处理
grep -r "tool_calls" ~/.routecodex/codex-samples/openai-chat/
```

## 🚀 开发工作流程导航

### 📝 新增Provider开发流程

1. **接口了解** → `src/modules/pipeline/interfaces/pipeline-interfaces.ts`
2. **基类继承** → `src/modules/pipeline/modules/provider/shared/base-http-provider.ts`
3. **实现示例参考** → `src/modules/pipeline/modules/provider/generic-http-provider.ts`
4. **测试验证** → `src/modules/pipeline/testing/test-utils.ts`
5. **配置注册** → `src/modules/pipeline/config/pipeline-assembler.ts`

### 🔄 新增Compatibility模块开发流程

1. **接口实现** → `CompatibilityModule` 接口
2. **转换规则** → `src/modules/pipeline/utils/transformation-engine.ts`
3. **字段映射** → `src/modules/pipeline/modules/compatibility/field-mapping.ts`
4. **示例参考** → `src/modules/pipeline/modules/compatibility/passthrough-compatibility.ts`

### 🧪 干运行调试使用流程

1. **框架了解** → `src/modules/pipeline/dry-run/pipeline-dry-run-framework.ts`
2. **执行器使用** → `src/modules/pipeline/dry-run/dry-run-pipeline-executor.ts`
3. **输入模拟** → `src/modules/pipeline/dry-run/input-simulator.ts`
4. **示例参考** → `src/modules/pipeline/dry-run/pipeline-dry-run-examples.ts`

## 📚 文档和学习资源

### 📖 必读文档 (按优先级)

1. **[PIPELINE_ARCHITECTURE_GUIDE.md](./PIPELINE_ARCHITECTURE_GUIDE.md)** ⭐️最重要
   - 完整的架构指南和9大核心原则

2. **各模块README.md** ⭐️重要
   - 每个模块的详细功能说明和使用指南

3. **[CLAUDE.md](./CLAUDE.md)** ⭐️重要
   - 项目开发规范和核心规则

### 🔗 相关外部资源

- **Web调试界面**: `http://localhost:3000`
- **API文档**: 查看各端点的具体实现
- **配置示例**: `verified-configs/` 目录
- **测试用例**: 各模块的 `__tests__/` 目录

---

**导航原则**:
- 🎯 **按问题类型定位**: 先确定问题类型，再查找对应模块
- 🔄 **遵循数据流向**: 按照请求处理的4层架构顺序排查
- 📊 **利用调试工具**: 优先使用Web界面和日志系统
- 🚀 **参考实现示例**: 新功能开发优先参考现有实现

**更新频率**: 每次架构重大变更时更新此导航指南