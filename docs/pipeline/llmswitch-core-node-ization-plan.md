# RouteCodex V2 llmswitch-core 节点化改造计划

## 概述

本文档描述 RouteCodex V2 llmswitch-core 的完整节点化改造计划，旨在将三个核心模块（conversion层、endpoints层、hooks层）统一改造为标准 PipelineNode 接口。

### 改造目标

- **统一编排**：所有模块通过 PipelineContext 传递数据
- **配置驱动**：节点链完全由配置文件决定
- **消除耦合**：移除运行时推断逻辑
- **标准化接口**：所有模块实现相同的 PipelineNode 接口

### Codex Review 关键改进

基于 codex 的专业 review，设计方案包含以下关键改进：

1. **契约完整性**：明确处理生命周期钩子、流式语义、错误传播
2. **工具治理强制**：节点能力契约 + 图验证 + 运行时权限检查
3. **混合流式处理**：适配器明确支持 SSE/JSON/Hybrid 模式
4. **配置验证**：前置验证 + 运行时检查 + 依赖管理
5. **职责边界**：明确 llmswitch-core vs host 侧职责
6. **Hook 迁移**：系统化的迁移映射和验证工具
7. **风险优先**：ToolsGovernanceNode POC 优先，降低核心风险

## 阶段实施计划

### Phase 1a: 完整 PipelineContext 接口 + 验证机制（3天）

**目标**：建立严格对齐 `pipeline-node-interface.md` 的完整接口

**任务**：
1. 实现 `standards/pipeline-context.ts` - 包含所有契约的完整接口
2. 实现 `standards/node-capabilities.ts` - 节点能力契约系统
3. 实现 `standards/pipeline-node.ts` - 标准 PipelineNode 接口
4. 实现 `validations/node-graph-validator.ts` - 节点图验证器
5. 单元测试覆盖所有接口

**关键文件**：
```
src/v2/conversion/conversion-v3/standards/
├── pipeline-context.ts          # 完整 PipelineContext 接口
├── node-capabilities.ts         # 节点能力契约
├── pipeline-node.ts             # 标准 PipelineNode 接口
└── base-pipeline-node.ts        # 基类实现

src/v2/conversion/conversion-v3/validations/
├── node-graph-validator.ts      # 节点图验证器
└── tool-governance-enforcer.ts  # 工具治理强制器
```

**验收标准**：
- [ ] PipelineContext 接口完全对齐 `pipeline-node-interface.md`
- [ ] 节点能力契约系统能正确验证工具修改权限
- [ ] 单元测试覆盖率 > 90%

### Phase 1b: 适配器 + 混合流式模式处理（2天）

**目标**：实现 V3 NodeContext ↔ PipelineContext 双向适配，支持混合流式模式

**任务**：
1. 实现 `standards/context-adapter.ts` - 双向适配器
2. 实现 `adapters/v3-to-standard-adapter.ts` - V3 节点适配包装器
3. 支持混合流式模式（SSE/JSON/Hybrid）
4. 生命周期钩子映射
5. 错误传播上下文处理

**关键设计**：
```typescript
// 流式语义处理
private static handleStreamingSemantics(v3Context: NodeContext) {
  const hasSSE = v3Context.request?.stream === true;
  const isResponsesEndpoint = v3Context.request?.endpoint?.includes('responses');

  if (isResponsesEndpoint && hasSSE) {
    return { mode: 'sse', buffer: [], eventId: `sse_${Date.now()}` };
  }

  if (hasSSE) {
    return { mode: 'hybrid', buffer: [], eventId: `hybrid_${Date.now()}` };
  }

  return { mode: 'json', buffer: [], eventId: `json_${Date.now()}` };
}
```

**验收标准**：
- [ ] 适配器能处理所有流式模式（SSE/JSON/Hybrid）
- [ ] 生命周期钩子正确映射
- [ ] 错误传播上下文完整保留

### Phase 2a: ToolsGovernanceNode POC（5天）

**目标**：实现核心工具治理节点，验证设计可行性

**任务**：
1. 实现 `nodes/process/tool-governance-node.ts` - 专用工具治理节点
2. 集成现有 tool-canonicalizer、tool-harvester
3. 实现节点能力权限验证
4. 验证工具调用集中化
5. 性能基准测试

**关键设计**：
```typescript
export class ToolGovernanceNode extends BasePipelineNode {
  constructor(id: string, options?: Record<string, unknown>) {
    super(id, 'process', 'tool-governance', options);
    // 声明工具修改能力
    this.capabilities = {
      canModifyTools: true,
      canAccessProvider: false,
      canModifyMetadata: false,
      canHandleStreaming: false
    };
  }

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    // 权限验证
    ToolGovernanceEnforcer.validateNodeExecution(this.id, this.kind, this.capabilities);

    // 工具治理逻辑
    if (!ctx.request) return ctx;

    // 调用现有工具治理核心
    const canonicalizer = new ToolCanonicalizer();
    const harvester = new ToolHarvester();

    if (ctx.request.tools) {
      ctx.request.tools = await canonicalizer.canonicalizeTools(ctx.request.tools);
    }

    if (ctx.request.messages) {
      ctx.request.messages = await harvester.harvestFromMessages(ctx.request.messages);
    }

    return ctx;
  }
}
```

**验收标准**：
- [ ] 工具治理逻辑完全集中化
- [ ] 节点权限验证正确工作
- [ ] 性能不低于现有实现的 110%

### Phase 2b: 其他核心模块节点化 + 适配器集成（7天）

**目标**：将其他核心模块转换为标准节点，集成适配器

**任务**：
1. 改造现有 V3 节点为标准 PipelineNode
2. 实现端点处理器节点化
3. 集成 V3ToStandardNodeAdapter
4. 保持向后兼容
5. 集成测试

**改造模块**：
- Input 节点：openai-chat-input, responses-input, anthropic-messages-input
- Process 节点：chat-process, passthrough-process, response-process
- Output 节点：openai-chat-output, responses-output, anthropic-messages-output
- SSE 节点：sse-input, sse-output
- Response 节点：response-inbound, response-output

**验收标准**：
- [ ] 所有核心模块成功节点化
- [ ] 适配器确保向后兼容
- [ ] 现有功能完全保留

### Phase 3: Workflow + Compatibility（复用适配器模式）（10天）

**目标**：实现 Workflow 和 Compatibility 节点，复用适配器模式

**任务**：
1. 实现 Workflow 节点：streaming-control, monitoring
2. 实现 Compatibility 节点：minimal-field-mapping
3. 职责边界明确划分
4. 复用适配器模式
5. Hook 迁移支持

**职责边界**：
```typescript
export const NODE_RESPONSIBILITIES = {
  // llmswitch-core 内部职责
  LLM_SWITCH_CORE: [
    'tool-governance',
    'chat-process',
    'response-process',
    'sse-input',
    'sse-output',
    'streaming-control'
  ] as const,

  // Host 侧职责
  HOST_SIDE: [
    'compatibility-process',
    'provider-http',
    'workflow-monitoring'
  ] as const
} as const;
```

**验收标准**：
- [ ] Workflow 节点正确处理流控
- [ ] Compatibility 节点遵循最小化原则
- [ ] 职责边界清晰明确

### Phase 4: 集成测试 + 移除适配器（5天）

**目标**：完整集成测试，移除适配器，使用原生标准接口

**任务**：
1. 端到端功能测试
2. 性能基准测试
3. 移除 V3ToStandardNodeAdapter
4. 清理旧代码
5. 文档更新

**测试覆盖**：
- 所有协议：OpenAI Chat, Responses, Anthropic Messages
- 所有流式模式：JSON, SSE, Hybrid
- 工具调用完整流程
- 错误处理和传播

**验收标准**：
- [ ] 所有功能测试通过
- [ ] 性能指标达标
- [ ] 适配器成功移除
- [ ] 代码清理完成

## 关键设计原则

### 1. 工具治理集中化
- 只有 process 阶段的授权节点能触碰工具调用
- ToolGovernanceNode 作为唯一工具修改入口
- 运行时权限验证 + 图验证

### 2. 配置驱动
- 节点行为完全由外部配置决定
- 前置配置验证 + 运行时检查
- 消除所有硬编码

### 3. 向后兼容
- 适配器确保现有流程继续工作
- 渐进式移除适配器
- 每个阶段都可回滚

### 4. 职责分离
- 明确 llmswitch-core vs host 侧职责
- Compatibility 节点最小化处理
- Provider 特定逻辑隔离

## 风险控制

### 技术风险
1. **流式模式复杂性**：通过适配器统一处理
2. **性能影响**：基准测试 + 监控
3. **配置错误**：多层验证机制

### 实施风险
1. **功能回归**：完整测试覆盖
2. **依赖关系**：依赖管理 + 初始化顺序
3. **时间延期**：风险优先 + POC 验证

## 成功标准

### 功能完整性
- [ ] 所有现有功能正常工作
- [ ] 工具治理逻辑保持集中化
- [ ] 流式处理功能完整
- [ ] 错误处理正确传播

### 架构合规性
- [ ] 所有模块实现 PipelineNode 接口
- [ ] 完全配置驱动，无硬编码
- [ ] 统一的 PipelineContext 数据传递
- [ ] 节点能力权限验证正确

### 性能指标
- [ ] 请求处理延迟 ≤ 现有实现的 110%
- [ ] 内存使用 ≤ 现有实现的 120%
- [ ] 支持 1000+ 并发请求

## 附录

### A. 关键接口定义

```typescript
export interface PipelineContext {
  request?: CanonicalRequest;
  response?: CanonicalResponse;
  metadata: {
    requestId: string;
    entryEndpoint: string;
    providerProtocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat' | string;
    processMode: 'chat' | 'passthrough';
    streaming: 'always' | 'never' | 'auto';
    routeName: string;
    pipelineId: string;
    providerId?: string;
    modelId?: string;
    providerType?: string;
    hookPhase?: 'inbound' | 'outbound' | 'pre-process' | 'post-process';
    errorContext?: {
      originalError: Error;
      stage: string;
      nodeId: string;
      timestamp: number;
    };
  };
  debug: {
    traceEnabled: boolean;
    stages: Record<string, unknown>;
    streamingContext?: {
      mode: 'sse' | 'json' | 'hybrid';
      buffer: unknown[];
      eventId: string;
    };
  };
  snapshots: SnapshotHandles | null;
  extra: Record<string, unknown>;
  nodeContracts: {
    [nodeId: string]: {
      capabilities: string[];
      requirements: string[];
      permissions: string[];
    };
  };
}

export interface PipelineNode {
  readonly id: string;
  readonly kind: 'sse-input' | 'input' | 'process' | 'workflow' | 'compatibility' | 'provider' | 'output' | 'sse-output';
  readonly implementation: string;
  readonly options?: Record<string, unknown>;
  readonly capabilities?: NodeCapabilities;

  execute(ctx: PipelineContext): Promise<PipelineContext>;
  validate?(config: Record<string, unknown>): Promise<boolean>;
  cleanup?(): Promise<void>;
}

export interface NodeCapabilities {
  canModifyTools: boolean;
  canAccessProvider: boolean;
  canModifyMetadata: boolean;
  canHandleStreaming: boolean;
}
```

### B. Hook 迁移映射

完整的 Hook 到 Node 迁移映射表，详见 `src/v2/conversion/conversion-v3/migrations/hook-migration.ts`。

### C. 配置验证

完整的节点配置验证规则，详见 `src/v2/conversion/conversion-v3/validations/node-graph-validator.ts`。

---

**文档版本**: 1.0.0
**创建日期**: 2025-11-24
**最后更新**: 2025-11-24
**负责人**: Claude Code