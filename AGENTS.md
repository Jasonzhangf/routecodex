# AGENTS.md - RouteCodex V2架构实施指南

RouteCodex V2架构开发规范，基于9大核心架构原则。包含个人开发流程和团队实施指南。

## 🏗️ 项目功能定义

RouteCodex是一个功能强大的多提供商OpenAI代理服务器，提供统一的AI服务接口和完整的调试生态系统。

### 核心功能
- **多提供商支持**: OpenAI、Anthropic、GLM、Qwen、LM Studio、iFlow
- **协议转换**: OpenAI ↔ Anthropic ↔ Gemini协议双向转换
- **动态路由**: 基于内容智能选择最优处理流水线
- **工具处理统一**: llmswitch-core提供三端一致的工具处理
- **Dry-Run调试**: 原生dry-run能力，无需真实AI服务调用
- **实时监控**: 完整的性能监控和调试界面

### 技术特色
- **4层管道架构**: LLM Switch Workflow → Compatibility → Provider → External AI Services
- **配置驱动**: 完全基于配置文件，无硬编码
- **Fail Fast原则**: 无隐藏fallback，错误直接暴露
- **模块化设计**: 职责单一，边界清晰
- **TypeScript严格**: 完整类型定义，编译时安全

## 🏗️ 完整架构框架图

### 系统整体架构

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                            RouteCodex V2 双向流水线架构                                │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                        双向HTTP请求层                                │  │
│  │  ┌─────────────┬──────────────┬──────────────────────────┬─────────────────┐  │  │
│  │  │ Chat端点    │ Responses端  │    Messages端点         │   调试API       │  │  │
│  │  │ /v1/chat    │ /v1/responses│    /v1/messages         │   /api/debug    │  │  │
│  │  │    ▲▼       │     ▲▼       │         ▲▼              │       ▲▼        │  │  │
│  │  │ • 双向工具   │ • 双向桥接   │ • 双向协议转换           │ • 双向快照      │  │  │
│  │  │ • 双向流式   │ • 双向适配   │ • 双向Claude支持         │ • 双向监控      │  │  │
│  │  └─────────────┴──────────────┴──────────────────────────┴─────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                    ▲▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                   双向Pipeline 4层流水线架构                          │  │
│  │  ┌─────────────┬──────────────┬──────────────────────────┬─────────────────┐  │  │
│  │  │LLM Switch   │ Compatibility │        Provider         │   External AI    │  │  │
│  │  │  Workflow   │    Layer     │          Layer              │    Services     │  │  │
│  │  │    层       │     层       │          层              │      层         │  │  │
│  │  │     ▲▼      │     ▲▼      │           ▲▼             │       ▲▼        │  │  │
│  │  │ • 双向路由   │ • 双向兼容   │ • 双向HTTP通信            │ • 双向OpenAI    │  │  │
│  │  │ • 双向协议   │   -修剪转换  │   -双向认证              │ • 双向Anthropic │  │  │
│  │  │ • llmswitch │   -字段映射  │   -双向连接              │ • 双向GLM      │  │  │
│  │  │   -core     │   -配置驱动  │   -双向请求              │ • 双向Qwen     │  │  │
│  │  │ • 双向工具   │   -错误兼容  │   -双向响应              │ • 双向LM Studio │  │  │
│  │  │   -入口     │             │   -双向Fail Fast         │ • 双向iFlow    │  │  │
│  │  └─────────────┴──────────────┴──────────────────────────┴─────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                    ▲▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                 sharedmodule 双向核心模块层                           │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │                llmswitch-core (双向工具处理唯一入口)               │  │  │
│  │  │  ┌─────────────┬──────────────┬──────────────────────────┐        │  │  │
│  │  │  │   V2引擎     │   转换层     │       端点处理器         │        │  │  │
│  │  │  │      ▲▼     │      ▲▼     │           ▲▼            │        │  │  │
│  │  │  │ • 双向API   │ • 双向编解码 │ • 双向Chat/Res/Msg处理   │        │  │  │
│  │  │  │ • 双向配置   │ • 双向流式   │ • 双向统一工具处理       │        │  │  │
│  │  │  │ • 双向兼容   │ • 双向共享   │ • 双向Hooks系统集成      │        │  │  │
│  │  │  └─────────────┴──────────────┴──────────────────────────┘        │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  │                             ▲▼                                                    │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │               双向工具处理统一入口 (核心中的核心)                    │  │  │
│  │  │  ┌─────────────┬──────────────┬──────────────────────────┐        │  │  │
│  │  │  │工具规范化器  │ 文本收割器   │      系统工具指引         │        │  │  │
│  │  │  │      ▲▼     │      ▲▼     │           ▲▼            │        │  │  │
│  │  │  │ • 双向规范   │ • 双向收割   │ • 双向schema增强         │        │  │  │
│  │  │  │ • 双向生成   │ • 双向提取   │ • 双向指引注入           │        │  │  │
│  │  │  │ • 双向去重   │ • 双向清理   │ • 双向行为标准化         │        │  │  │
│  │  │  └─────────────┴──────────────┴──────────────────────────┘        │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────┘
                                    ▲▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                        双向Provider层与AI服务通信                                │
│  ┌─────────────┬──────────────┬──────────────────────────┬─────────────────┐  │
│  │   OpenAI    │  Anthropic  │        GLM               │     Qwen        │  │
│  │  双向接口    │  双向接口    │       双向接口            │    双向接口     │  │
│  │      ▲▼      │      ▲▼     │           ▲▼             │        ▲▼       │  │
│  │ • 双向HTTP   │ • 双向HTTP   │ • 双向HTTP              │ • 双向HTTP     │  │
│  │ • 双向解析   │ • 双向解析   │ • 双向解析              │ • 双向解析     │  │
│  │ • 双向错误   │ • 双向错误   │ • 双向1210/1214处理      │ • 双向OAuth    │  │
│  └─────────────┴──────────────┴──────────────────────────┴─────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────┘

▲▼ 双向数据流：请求流(↓)和响应流(↑)在每一层双向传递
```

### 双向数据流和请求处理链

#### 一般请求处理流程

```
用户请求 <> Server端点 <> llmswitch-core <> Workflow <> Compatibility <> Provider
     ▲             ▲              ▲            ▲            ▲              ▲
     │             │              │            │            │              │
     │             │              │            │            │              │
     ▼             ▼              ▼            ▼            ▼              ▼
┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│HTTP Request │ │ HTTP协议    │ │ 工具处理    │ │ 动态路由    │ │ Provider    │ │ AI Services │
│   - 认证     │ │   - 认证     │ │   - 统一    │ │   - 选择    │ │   - HTTP    │ │ • OpenAI    │
│   - 解析     │ │   - 授权     │ │   - 收割    │ │   - 转换    │ │   - 通信    │ │ • Anthropic │
│   - 流式     │ │   - 委托     │ │   - 标准化  │ │   - 委托    │ │   - 错误    │ │ • GLM       │
│   - 错误     │ │   - 错误     │ │   - 引导    │ │   - 验证    │ │   - 处理    │ │ • Qwen      │
└─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘
     │             │              │            │            │              │
     ▼             ▼              ▼            ▼            ▼              ▼
┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│HTTP Response│ │ 格式化响应  │ │ 工具响应    │ │ 路由结果    │ │ 响应处理    │ │ AI响应      │
│   - 格式     │ │   - 流式     │ │   - 处理    │ │   - 转发    │ │   - 解析    │ │ • 模型结果  │
│   - 流式     │ │   - 状态     │ │   - 清理    │ │   - 状态    │ │   - 代理    │ │ • 工具调用  │
│   - 状态     │ │   - 记录     │ │   - 包装    │ │   - 监控    │ │   - 记录    │ │ • 元数据    │
│   - 记录     │ │   - 调试     │ │   - 透传    │ │   - 快照    │ │   - 快照    │ │ • 计量信息  │
└─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘
```

#### 工具调用完整流程

```
工具选择与执行循环：

1. 请求阶段 (Request Phase)
   用户请求带工具选择
         ↓
   llmswitch-core统一工具请求处理
         ↓
   Compatibility层进行Provider特定修剪
         ↓
   Provider发送到外部AI服务

2. 响应阶段 (Response Phase)
   外部AI服务响应
         ↓
   Provider接收响应
         ↓
   Compatibility层做修剪和转换
         ↓
   llmswitch-core做统一工具响应处理

3. 执行阶段 (Execution Phase)
   客户端执行工具
         ↓
   工具执行结果收集

4. 下一轮请求 (Next Request)
   工具执行结果附加到下一轮请求
         ↓
   llmswitch-core统一处理后进入下一轮循环
```

#### 双向流水线特性

**请求流**：用户请求 → Server → llmswitch-core → Workflow → Compatibility → Provider → AI Services
**响应流**：AI Services → Provider → Compatibility → Workflow → llmswitch-core → Server → 用户响应
**工具循环**：工具选择 → 统一处理 → Provider修剪 → AI执行 → 结果收集 → 下一轮请求

## 🏗️ sharedmodule 框架详解

### 核心模块结构

```
sharedmodule/
├── llmswitch-core/              # 工具处理核心模块
│   ├── src/
│   │   ├── v2/                # V2架构实现
│   │   │   ├── api/           # API层和类型定义
│   │   │   ├── core/          # 核心引擎和工厂
│   │   │   ├── conversion/    # 转换层
│   │   │   │   ├── codecs/    # 协议编解码器
│   │   │   │   ├── shared/    # 工具处理统一入口
│   │   │   │   ├── streaming/ # 流式处理
│   │   │   │   └── responses/ # Responses API处理
│   │   │   ├── endpoints/     # 端点处理器
│   │   │   ├── guidance/      # 系统工具指引
│   │   │   ├── hooks/         # Hooks系统
│   │   │   └── config/        # 配置管理
│   │   └── conversion/        # V1兼容转换层
│   └── package.json
├── config-engine/              # 配置引擎模块
└── config-testkit/             # 配置测试工具模块
```

### llmswitch-core 详细架构

#### V2核心组件职责

**1. API层 (`src/v2/api/`)**
- 类型定义和接口规范
- 配置管理和验证
- V1兼容性接口

**2. 核心引擎 (`src/v2/core/`)**
- 生命周期管理
- 工厂模式实现
- 性能监控和错误处理

**3. 转换层 (`src/v2/conversion/`)**

**编解码器 (`codecs/`)**
- `openai-openai-codec.ts`: OpenAI格式标准化
- `anthropic-openai-codec.ts`: Anthropic↔OpenAI转换
- `responses-openai-codec.ts`: Responses↔Chat转换

**共享组件 (`shared/`) - 工具处理统一入口**
- `tool-canonicalizer.ts`: 工具调用规范化器（**核心中的核心**）
- `tool-harvester.ts`: 文本工具意图收割
- `text-markup-normalizer.ts`: 文本标记标准化
- `tool-governor.ts`: 工具治理和验证

**流式处理 (`streaming/`)**
- SSE事件聚合和处理
- 流式协议转换
- 缓冲优化管理

**Responses处理 (`responses/`)**
- Responses API桥接转换
- 格式适配和标准化

**4. 端点处理器 (`src/v2/endpoints/`)**
- `chat-endpoint-handler.ts`: Chat端点处理器
- `responses-endpoint-handler.ts`: Responses端点处理器
- `messages-endpoint-handler.ts`: Messages端点处理器

**5. 系统工具指引 (`src/v2/guidance/`)**
- 统一工具schema增强
- 系统指引注入和精炼
- 工具行为标准化

**6. Hooks系统 (`src/v2/hooks/`)**
- 16个阶段Hooks管理
- 快照管理
- 错误处理

### 构建依赖关系

```
构建顺序:
1. sharedmodule/llmswitch-core (独立编译)
   ↓
2. 根包编译和安装
   ↓
3. 整包功能验证

依赖关系:
llmswitch-core → 根包 → 运行时
```

## 🚨 构建顺序（强制）
- **sharedmodule/修改**: 先编译模块，再编译根包
- **验证**: `npm run build:verify`

## 🚨 9大核心架构原则

### 原则1-3: 技术架构
1. **统一工具处理** - llmswitch-core唯一入口
2. **最小兼容层** - 仅处理provider特定字段
3. **统一工具引导** - 系统指引集中管理

### 原则4-6: 系统质量
4. **快速死亡** - Fail Fast，无隐藏fallback
5. **暴露问题** - 结构化日志，完整错误上下文
6. **清晰解决** - 单一处理路径，确定性行为

### 原则7-9: 可维护性
7. **功能分离** - 模块职责单一，边界清晰
8. **配置驱动** - 无硬编码，外部化配置
9. **模块化** - 文件<500行，功能导向拆分

## 🚨 模块职责边界

### llmswitch-core - 工具处理唯一入口
**位置**: `sharedmodule/llmswitch-core/`

**✅ 核心职责**:
- 三端一致性工具处理 (Chat/Responses/Messages)
- 文本工具意图收割 (rcc.tool.v1, XML blocks, Execute blocks)
- 工具调用标准化 (arguments字符串化, ID生成, 去重)
- 工具结果包剥离 (清理executed/result文本包)
- 系统工具指引 (schema增强, 指引注入)
- 格式转换 (Anthropic↔OpenAI工具格式)
- 三端工具参数聚合与修复

  细则（统一修复链）：
  - arguments 统一修复：`jsonish.repairArgumentsToString()`（JSON→JSON5风格→安全修复→失败回退"{}"）
  - 规范化器：`tool-canonicalizer.canonicalizeChatResponseTools()` 保证不变式（`content=null`，`finish_reason=tool_calls`），并在“可疑+存在文本块”时触发 `tool-harvester.harvestTools()` 从文本重建 `tool_calls`
  - 流式聚合（可选）：可在 llmswitch-core 的流式转换中启用“吞掉参数增量，完成时一次性下发”的聚合策略（默认关闭，按需启用）

**🛡️ 严格禁止**:
- Provider特定处理 (委托给Compatibility层)
- HTTP通信 (委托给Provider层)
- 配置管理 (委托给配置系统)
- 重复实现 (服务器端点、兼容层严禁重复)

  注：不得在兼容层/Provider层重复实现 JSON/JSON5 修复或文本收割；工具治理的唯一入口在 llmswitch-core。

**🔧 关键文件**:
- `tool-canonicalizer.ts` - 工具调用规范化器 (**核心**)
- `tool-harvester.ts` - 文本工具意图收割
- `text-markup-normalizer.ts` - 文本标记标准化
- `tool-governor.ts` - 工具治理和验证
- `guidance/` - 系统工具指引模块

### Compatibility Layer - 最小兼容处理
**位置**: `src/modules/pipeline/modules/compatibility/`

**✅ 职责**:
- Provider字段标准化
- Reasoning内容处理
- 字段映射 (usage, created_at等)
- 最小清理
- 配置驱动转换
- GLM专用处理 (1210/1214错误兼容)

  细则：
  - 请求侧黑名单（GLM）：`tools[].function.strict` 删除；当无 tools 时删除 `tool_choice`（仅请求预处理，最小化）
  - 响应侧黑名单（非流式）：仅删除安全字段（默认 `usage.prompt_tokens_details.cached_tokens`）；配置文件：`.../compatibility/<provider>/config/response-blacklist.json`；关键字段受保护（status/output/output_text/required_action/choices[].message.content/tool_calls/finish_reason）
  - 流式路径（/v1/responses）默认绕过任何响应黑名单/过滤，避免破坏事件序列

**❌ 禁止**:
- 工具调用转换
- 文本工具收割
- 重复处理
- 兜底逻辑
 - 修改工具语义（如重写 shell.command 等）

### Provider V2 - 统一HTTP通信
**位置**: `src/modules/pipeline/modules/provider/v2/`

**✅ 职责**:
- 统一HTTP通信
- 认证管理 (API Key/OAuth)
- 连接管理 (连接池, 超时, 重试)
- 快照系统
- 配置驱动
- 多提供商支持

**❌ 禁止**:
- 工具处理
- 格式转换
- 业务逻辑
 - 工具语义修复/参数归一（例如将 `shell.command` 字符串拆词为数组等）

  细则：
  - Responses 上游真流式直通为“可选能力”，由环境变量控制（默认关闭）：`ROUTECODEX_RESPONSES_UPSTREAM_SSE=1` 或 `RCC_RESPONSES_UPSTREAM_SSE=1`
  - 未启用时 Provider 保持统一非流式 JSON；流式合成交由 llmswitch-core

### Server Endpoints - HTTP协议处理
**位置**: `src/server/handlers/`

**✅ 职责**:
- HTTP协议处理
- 认证授权
- 流式处理
- 错误处理
- 委托模式

**❌ 禁止**:
- 工具处理逻辑
- 格式转换
- 业务逻辑

## 🚨 开发指导原则

### 责任归属原则
- **谁改代码谁负责维护**: 修改者必须承担后续维护责任
- **谁改代码谁负责验证**: 修改者必须验证修改的正确性
- **改哪里验证哪里**: 针对性验证修改的具体功能点
- **无验证不报告**: 未经验证的代码不得进入报告流程

### 修改定位原则
- **先读功能归属**: 修改前必须阅读相关模块的功能职责说明
- **架构适配检查**: 如果修改功能不属于当前架构设计，必须重新思考修改位置
- **职责边界确认**: 确认修改内容符合模块职责边界定义

### 实现方式原则
- **检查现有实现**: 修改前必须检查功能是否已经存在
- **改已有不新增**: 有实现就改已有实现，禁止新增重复实现
- **不简化不跳过**: 不要简化已有实现，不要跳过现有实现
- **直面问题不逃避**: 面对问题，分析根因，不逃避或绕过

### 信息不足处理原则
- **列举现象**: 详细描述遇到的问题和现象
- **分析根因**: 基于已有信息进行初步分析
- **请求协助**: 明确列出需要用户协助的信息点

### 结论推导原则
- **代码分析片段化**: 代码分析只是片段，不能完全依赖
- **查阅文档**: 必须查看相关文档和架构说明
- **真实查询**: 实际查询代码运行结果和数据流
- **提供路径**: 提供完整的分析路径和推导过程

### 任务管理原则
- **询问用户**: 遇到任务过多或优先级不明时，必须询问用户
- **不自作主张**: 禁止自作主张决定任务优先级或跳过任务
- **明确反馈**: 及时反馈进度和遇到的问题

## 🚨 个人开发工作流程

### 步骤1: 需求分析
- 深入理解需求，多角度提问
- 研究现有代码实现模式
- 使用codex完善分析计划

### 步骤2: 实施准备
- 获取代码原型 (unified diff patch)
- 确认符合9大架构原则
- 制定实施计划

### 步骤3: 代码实现
- 基于原型编写高质量代码
- 确保模块职责正确
- 避免重复实现功能

### 步骤4: 质量保证
- 自我测试功能正确性
- 使用codex review代码
- 验证不破坏现有功能

### 步骤5: 文档更新
- **修改确认**: 完成代码修改并确认功能正常后
- **README更新**: 必须同步更新README.md相关内容
- **文档同步**: 确保所有相关文档与代码实现保持一致
- **变更记录**: 在README中记录重要变更和影响

## 🚨 开发规范

### 错误处理 (Fail Fast)
```typescript
// ✅ 正确: 快速死亡
if (!request.model) {
  throw new ValidationError('Model is required');
}
return await externalServiceCall(request);

// ❌ 错误: 隐藏错误
try {
  return await riskyOperation();
} catch (error) {
  return defaultValue; // 隐藏真正问题
}
```

### 配置驱动
```typescript
// ✅ 正确: 配置驱动
interface ServiceConfig {
  baseUrl: string;
  timeout: number;
}

class ServiceClient {
  constructor(private config: ServiceConfig) {
    this.validateConfig(config);
  }
}

// ❌ 错误: 硬编码
class ServiceClient {
  private baseUrl = 'https://api.openai.com'; // 硬编码
}
```

### 功能分离
```typescript
// ✅ 正确: 功能分离
class RequestHandler {
  constructor(
    private auth: AuthService,
    private validator: RequestValidator,
    private business: BusinessService,
    private formatter: ResponseFormatter
  ) {}

  async handle(request: Request) {
    await this.auth.authenticate(request);
    const validated = await this.validator.validate(request);
    const result = await this.business.process(validated);
    return this.formatter.format(result);
  }
}

// ❌ 错误: 功能混合
class RequestHandler {
  async handle(request: Request) {
    this.authenticate(request);    // 认证逻辑
    this.validate(request);       // 验证逻辑
    this.processBusiness(request); // 业务逻辑
    this.formatResponse(result);   // 响应逻辑
  }
}
```

## 🚨 常用调试命令

```bash
# 验证配置
npm run config:validate:providers

# 测试协议兼容性
npm run test:protocol

# 调试工具参数
npm run verify:tools:offline

# 检查工具配对
npm run verify:pairing

# 验证构建顺序
npm run build:verify
```

## 🚨 调试路径

- **快照根目录**: `~/.routecodex/codex-samples/`
- **Chat端点**: `openai-chat/` 目录
- **Responses端点**: `openai-responses/` 目录
- **关键快照**: `*_provider-request.json`, `*_provider-response.json`

## 🚨 自查清单

### 开发时检查
- [ ] **责任归属**: 我是否准备好负责维护和验证这次修改？
- [ ] **修改定位**: 我是否阅读了相关模块的功能职责说明？
- [ ] **架构适配**: 修改是否符合当前架构设计？
- [ ] **现有实现**: 我是否检查了功能是否已经存在？
- [ ] **重复检查**: 我是否避免了新增重复实现？
- [ ] **架构原则**: 是否遵循9大架构原则？
- [ ] **工具处理**: 工具调用是否全部通过llmswitch-core？
- [ ] **兼容层**: 兼容层是否只处理provider特定功能？
- [ ] **错误处理**: 是否遵循快速死亡原则？
- [ ] **日志记录**: 错误信息是否完整且结构化？
- [ ] **模块分离**: 模块职责是否明确且不重叠？
- [ ] **配置管理**: 是否存在硬编码？
- [ ] **文件大小**: 文件是否超过500行？
- [ ] **文档更新**: 我是否准备好了修改完成后更新README？

### 代码审查检查
- [ ] **责任明确**: 修改者是否明确承担维护责任？
- [ ] **验证完成**: 修改是否经过充分验证？
- [ ] **架构合规**: 是否遵循9大架构原则？
- [ ] **职责边界**: 是否符合模块职责边界定义？
- [ ] **重复代码**: 是否有功能重叠或重复实现？
- [ ] **隐藏逻辑**: 是否有隐藏的fallback逻辑？
- [ ] **配置外部化**: 配置是否外部化且验证？
- [ ] **模块化设计**: 代码结构是否模块化可维护？
- [ ] **推导过程**: 是否提供完整的分析和推导过程？
- [ ] **README更新**: 修改完成后是否已同步更新README？

## 📦 安装与升级（dev / release）

### dev 包（routecodex，默认安装）

使用唯一的 dev 安装脚本完成从构建到全局安装的完整流程：

```bash
npm run install:global
```

脚本执行步骤：
- 构建 sharedmodule/llmswitch-core 与根包（TypeScript → dist）
- npm pack 生成 tgz 包
- 卸载全局旧版 routecodex（若存在）
- 使用 npm 默认全局路径执行 `npm install -g .` 安装新版本 dev 包（只导出 `routecodex` 命令）
- 验证安装（打印 `routecodex --version`）

注意：不修改 npm prefix、不使用自定义 cache，完全遵循 npm 默认全局安装路径。

### release 包（rcc，单独安装）

release 版 CLI 使用单独脚本，从当前源码生成 rcc 包并全局安装：

```bash
npm run install:release
```

脚本执行步骤（概览）：
- 基于当前源码运行一次完整构建
- 使用 `npm pack` 生成临时 routecodex tgz，并在临时目录重写 `package.json` 为：
  - `"name": "rcc"`
  - `"bin": { "rcc": "./dist/cli.js" }`
- 在临时目录再次 `npm pack` 生成 `rcc-<version>.tgz`
- 卸载已有全局 rcc（若存在），再对 `rcc-<version>.tgz` 执行 `npm install -g`
- 验证安装（打印 `rcc --version`）

约束与原则：
- 默认安装脚本 **只安装 dev 包 routecodex**，release `rcc` 必须显式执行 `npm run install:release`
- dev 包 `routecodex`：用于本地开发与调试，默认端口 5555（除非显式 `ROUTECODEX_PORT` / `RCC_PORT` 指定）
- release 包 `rcc`：严格按用户配置端口启动（`httpserver.port` / `server.port` / 顶层 `port`），不得复用 dev 默认 5555 逻辑

## 🚨 GRE错误治理流程

### 4xx/5xx错误处理
1. **判定来源**: 检查`provider-error.json`确认上游错误
2. **curl复现**: 用`provider-request.json.body`直打上游
3. **形状映射**: 仅修正请求形状，不拦截响应
4. **回归验证**: 确认修复生效且无副作用，先按分析修改`provider-request.json.body`再curl直打上游确认，然后落盘修改

### 修正原则
- 仅在兼容层做形状映射
- 禁止拦截请求/响应
- 禁止删除历史
- 最小可行修复

---

**最后更新**: 2025-11-14
**版本**: 0.81.23
