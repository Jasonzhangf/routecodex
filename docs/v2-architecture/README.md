# V2 Pipeline Architecture Design

> **Status**: This blueprint is frozen. Current implementation follows AGENTS.md principles (single execution path, no bypasses). This doc is retained for historical reference only; do not use as current architecture guidance.

## 🎯 Design Objectives

This document outlines the V2 pipeline architecture design for RouteCodex, focusing on:

1. **Gradual Migration**: V2 refactoring with seamless V1/V2 switching
2. **Virtual Pipeline**: Dynamic routing replacing static assembly
3. **Unified Configuration**: Complete V2 configuration system
4. **System Integration Hooks**: Global hooks for request lifecycle management

## 🏗️ Overall Architecture

### Architecture Comparison

```
┌─────────────────────────────────────────────────────────────────┐
│                    V1/V2 Dual Mode Architecture                  │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │   Mode Switch   │  │   Route Selector│  │   Config Manager │  │
│  │  (Feature Flag) │  │ (Route Selector)│  │ (Config Manager) │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│           │                     │                     │          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │   V1 Static     │  │   V2 Virtual    │  │   System Hooks   │  │
│  │  (Static Build) │  │ (Dynamic Route) │  │ (System Hooks)   │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## 📋 Phase 1: V2 Virtual Pipeline Architecture

### 1.1 Core Design Concept

**V1 Static Assembly** (Current):
```
Request → Pre-assembled Pipeline → Static Module Chain → Response
         [Provider][Compatibility][LLMSwitch] (Pre-instantiated)
```

**V2 Virtual Pipeline** (New Design):
```
Request → Route Decision → Dynamic Module Connection → Response
         ↓
[Module Registry] → [Runtime Assembly] → [Temporary Connection] → [Request Process] → [Auto Cleanup]
```

### 1.2 V2 Core Components

#### A. Module Registry (ModuleRegistry)
```typescript
// src/modules/pipeline/v2/core/module-registry.ts
export class V2ModuleRegistry {
  private modules = new Map<string, ModuleFactory>();
  private instances = new Map<string, ModuleInstance>();

  // Register module factory (not instance)
  register(type: string, factory: ModuleFactory): void

  // Create module instance on demand (lazy loading)
  createInstance(type: string, config: ModuleConfig): Promise<ModuleInstance>

  // Get or create instance (singleton pattern)
  getOrCreateInstance(type: string, config: ModuleConfig): Promise<ModuleInstance>

  // Cleanup idle instances (memory management)
  cleanupIdleInstances(): void
}
```

#### B. Dynamic Router (DynamicRouter)
```typescript
// src/modules/pipeline/v2/core/dynamic-router.ts
export class DynamicRouter {
  constructor(
    private moduleRegistry: V2ModuleRegistry,
    private routeTable: RouteTable
  ) {}

  // Route request dynamically to module chain
  async route(request: PipelineRequest): Promise<ModuleChain>

  // Build temporary module connection
  private async buildModuleChain(route: Route): Promise<ModuleChain>

  // Execute module chain processing
  async executeChain(chain: ModuleChain, request: PipelineRequest): Promise<PipelineResponse>
}
```

#### C. Module Chain Manager (ChainManager)
```typescript
// src/modules/pipeline/v2/core/chain-manager.ts
export class ModuleChain {
  readonly id: string;
  readonly modules: ModuleInstance[];
  readonly connections: ModuleConnection[];

  // Execute chain processing
  async process(request: PipelineRequest): Promise<PipelineResponse>

  // Auto cleanup connections
  async cleanup(): Promise<void>
}

export class ModuleConnection {
  constructor(
    public from: ModuleInstance,
    public to: ModuleInstance,
    public transform?: (data: any) => any
  ) {}
}
```

### 1.3 Virtual Pipeline Lifecycle

```
1. Request Enter → 2. Route Analysis → 3. Module Lookup → 4. Instance Check → 5. Dynamic Connection
     ↓              ↓                   ↓                    ↓                    ↓
[Request Parse] → [Route Table Match] → [Module Registry] → [Instance Cache] → [Temporary Chain Build]
     ↓              ↓                   ↓                    ↓                    ↓
6. Chain Execute → 7. Response Return → 8. Connection Cleanup → 9. Instance Recycling → 10. Log Recording
[Data Processing] → [Result Return] → [Auto Disconnect] → [Cache Retention] → [Audit Trail]
```

## 📋 Phase 2: V2 Unified Configuration System

### 2.1 V2 Configuration Schema Design

```typescript
// src/config/v2-config-schema.ts
export interface V2SystemConfig {
  version: '2.0';

  // System switch configuration
  system: {
    mode: 'v1' | 'v2' | 'hybrid';
    featureFlags: Record<string, boolean>;
  };

  // Global hooks configuration
  hooks: SystemHooksConfig;

  // V2 virtual pipeline configuration
  virtualPipelines: {
    routeTable: RouteTableConfig;
    moduleRegistry: ModuleRegistryConfig;
    chainManagement: ChainManagementConfig;
  };

  // V1 configuration compatibility (auto convert)
  legacy?: V1Config;
}

export interface RouteTableConfig {
  routes: RouteDefinition[];
  defaultRoute: string;
  // Note: No fallback strategies - fail fast when routing fails
}

export interface RouteDefinition {
  id: string;
  pattern: RequestPattern;
  modules: string[]; // Module type array, not instances
  config: RouteConfig;
  priority: number;
}
```

### 2.2 Configuration Migration Adapter

```typescript
// src/config/v2-migration-adapter.ts
export class V2MigrationAdapter {
  // Auto convert V1 configuration to V2 format
  static migrateV1Config(v1Config: V1Config): V2SystemConfig {
    return {
      version: '2.0',
      system: { mode: 'v2', featureFlags: {} },
      hooks: this.extractHooksFromV1(v1Config),
      virtualPipelines: this.convertPipelinesToVirtual(v1Config),
      legacy: v1Config // Keep original config for rollback
    };
  }

  // Generate migration report
  static generateMigrationReport(v1Config: V1Config): MigrationReport {
    return {
      breakingChanges: [],
      newFeatures: [],
      manualSteps: [],
      estimatedEffort: 'low'
    };
  }
}
```

## 📋 Phase 3: V1/V2 Dual Mode Switch System

### 3.1 Switch Design

```typescript
// src/core/system-mode-switch.ts
export class SystemModeSwitch {
  private currentMode: 'v1' | 'v2' = 'v1';
  private v1Assembler?: V1PipelineAssembler;
  private v2Router?: V2DynamicRouter;

  // Runtime mode switching
  async switchMode(mode: 'v1' | 'v2'): Promise<void> {
    if (mode === this.currentMode) return;

    // 1. Stop current mode
    await this.stopCurrentMode();

    // 2. Start target mode
    await this.startTargetMode(mode);

    // 3. Validate switch success
    await this.validateModeSwitch(mode);

    this.currentMode = mode;
  }

  // Handle request (auto route to current mode)
  async handleRequest(request: PipelineRequest): Promise<PipelineResponse> {
    return this.currentMode === 'v1'
      ? this.v1Assembler!.process(request)
      : this.v2Router!.route(request);
  }
}
```

### 3.2 Hybrid Mode Design

```typescript
// src/core/hybrid-mode-manager.ts
export class HybridModeManager {
  // Select V1 or V2 based on request characteristics
  selectMode(request: PipelineRequest): 'v1' | 'v2' {
    // Decision based on request features, config flags, runtime state
    if (this.shouldUseV2(request)) return 'v2';
    return 'v1';
  }

  // Gradual traffic switching
  async gradualTransition(percentage: number): Promise<void> {
    // Gradually increase V2 traffic ratio
    // Monitor key metrics
    // Auto rollback mechanism
  }
}
```

## 📋 Phase 4: System Integration Hooks

### 4.1 Hooks Architecture Design

```typescript
// src/hooks/system-hooks.ts
export interface SystemHooks {
  // Request lifecycle hooks
  onRequest?: (request: PipelineRequest) => PipelineRequest | Promise<PipelineRequest>;
  beforeRoute?: (request: PipelineRequest) => void | Promise<void>;
  afterRoute?: (route: Route) => void | Promise<void>;
  beforeModule?: (module: ModuleInstance, data: any) => any | Promise<any>;
  afterModule?: (module: ModuleInstance, result: any) => any | Promise<any>;
  onResponse?: (response: PipelineResponse) => PipelineResponse | Promise<PipelineResponse>;

  // System lifecycle hooks
  onModeSwitch?: (from: string, to: string) => void | Promise<void>;
  onError?: (error: Error, context: any) => void | Promise<void>;
  onMetric?: (metric: SystemMetric) => void | Promise<void>;
}

export class SystemHookManager {
  private hooks = new Map<string, SystemHook[]>();

  // Register hook
  register(event: string, hook: SystemHook): void

  // Execute hook chain
  async execute(event: string, data: any): Promise<any>

  // Dynamic enable/disable hook
  toggle(event: string, enabled: boolean): void
}
```

### 4.2 Built-in System Hooks

```typescript
// src/hooks/builtin-hooks.ts
export class BuiltinHooks {
  // Request tracking hook
  static requestTracer: SystemHook = {
    onRequest: async (request) => {
      request.traceId = generateTraceId();
      request.startTime = Date.now();
      return request;
    },
    onResponse: async (response) => {
      const duration = Date.now() - response.request.startTime;
      metrics.record('request.duration', duration);
      return response;
    }
  };

  // Mode switch hook
  static modeSwitchLogger: SystemHook = {
    onModeSwitch: async (from, to) => {
      logger.info(`System mode switched from ${from} to ${to}`, {
        timestamp: new Date().toISOString(),
        trigger: 'manual'
      });
    }
  };

  // Error logging hook (NO auto fallback - fail fast)
  static errorLogger: SystemHook = {
    onError: async (error, context) => {
      // Log detailed error information for manual intervention
      logger.error('V2 error detected', {
        error: error.message,
        stack: error.stack,
        context: {
          mode: context.mode,
          requestId: context.requestId,
          routeId: context.routeId,
          timestamp: new Date().toISOString()
        }
      });

      // Emit metrics for monitoring
      metrics.increment('v2.errors.total', {
        errorType: error.constructor.name,
        mode: context.mode
      });
    }
  };
}
```

## 📋 Phase 5: Monitoring and Observability

### 5.1 V2 Specific Monitoring Metrics

```typescript
// src/monitoring/v2-metrics.ts
export class V2Metrics {
  // Dynamic routing metrics
  routeCacheHitRate: Gauge;
  moduleChainBuildTime: Histogram;
  activeConnections: Gauge;

  // Module instance metrics
  moduleInstanceCount: Gauge;
  moduleInstanceMemoryUsage: Gauge;
  moduleIdleTime: Histogram;

  // Mode switching metrics
  modeSwitchCount: Counter;
  modeSwitchLatency: Histogram;
  v1VsV2RequestRatio: Gauge;
}
```

### 5.2 Debug Tools

```typescript
// src/debugging/v2-debug-tools.ts
export class V2DebugTools {
  // Visualize dynamic routing
  async visualizeRoute(request: PipelineRequest): Promise<RouteVisualization>

  // Module chain tracing
  async traceModuleChain(chainId: string): Promise<ChainTrace>

  // Performance analysis
  async analyzePerformance(timeRange: TimeRange): Promise<PerformanceReport>

  // Configuration validation
  async validateV2Config(config: V2SystemConfig): Promise<ValidationReport>
}
```

## 🔧 Compatibility Layer Responsibilities

### Field Mapping + Format Conversion + Provider-Specific Processing

**Compatibility层核心职责**：将特定Provider的响应格式转换为标准OpenAI格式，支持配置驱动的字段映射、格式转换和清理。

#### 核心功能组件

1. **字段映射 (Field Mappings)**
   - 将Provider特有字段映射到OpenAI标准字段
   - 清理Provider特有的多余字段
   - 保持字段语义的一致性

2. **格式转换 (Format Conversions)**
   - 标准化日期时间格式
   - 转换使用统计格式
   - 处理特殊字段的格式要求

3. **供应商特定处理 (Provider-Specific Processing)**
   - Provider特有的清理逻辑
   - Provider特有的格式转换
   - 基于配置的条件处理

4. **Hooks机制**
   - **beforeFieldMapping**: 字段映射前的预处理
   - **afterFieldMapping**: 字段映射后的后处理
   - 只处理字段映射相关的逻辑，不涉及工具处理

#### 配置驱动示例

```typescript
'glm-compatibility-config': {
  fieldMappings: {
    request: { 'model': 'model', 'messages': 'messages' },
    response: {
      'choices': 'choices',
      'usage': 'usage',
      'thought': null  // 清理GLM特有字段
    }
  },
  formatConversions: {
    reasoningContent: {
      source: 'thought',
      target: 'reasoning_content',
      transform: 'extract_and_format'
    }
  },
  hooks: {
    beforeFieldMapping: ['glm-request-preprocessor'],
    afterFieldMapping: ['glm-response-postprocessor']
  }
}
```

## 🔧 Tools Unique Entrance (Principle 1-3)

### Mandatory Tool Processing Contract

**V2 enforces llmswitch-core as the ONLY module that can touch tool calls**. This is non-negotiable and enforced at schema validation time.

#### Required Module Order
```
provider → compatibility → llmswitch (final) → response
```

#### llmswitch-core Exclusive Responsibilities
Only `llmswitch-core` modules may perform:

1. **Tool Calls Canonicalization**: Normalize tool_calls structure
   - Implementation: Rust Chat Process tool governance / codec owners under `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src`
   - Historical TS `sharedmodule/llmswitch-core/src/conversion/shared/tool-canonicalizer.ts` is deleted and must not be restored
2. **Argument Stringification**: Convert tool arguments to proper string format
   - Implementation: Rust request/response tool governance blocks under `router-hotpath-napi/src/req_process_stage1_tool_governance_blocks` and `router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks`
3. **Result Envelope Stripping**: Remove tool result wrapper envelopes
   - Implementation: Rust `responses_openai_codec.rs` plus direct native helper/test surfaces
   - Historical TS `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts` is deleted and must not be restored
4. **Schema Augmentation**: Normalize/augment tool schemas (and inject tool guidance when enabled)
   - Implementation: Rust request/response tool governance owners; historical TS `tool-governor.ts` and `guidance/index.ts` are deleted
5. **finish_reason=tool_calls Patching**: Set correct finish reason for tool calls
   - Implementation: Rust response parsing / outbound projection owners, not the deleted TS Responses bridge

#### V2 Guardrails
- Any chain where non-llmswitch module references tool handling is rejected
- Compatibility modules can only perform field mappings and format conversions (no tool logic)
- Server/hook layers cannot modify tool calls directly
- Tool validation must use llmswitch-core validators only
- Compatibility层的hooks只处理字段映射相关的供应商特定逻辑，不涉及工具处理

#### Schema-Level Validation Enforcement
```typescript
// Schema validation at assembly time
export class V2SchemaValidator {
  static validateModuleOrder(route: RouteDefinition): ValidationResult {
    // Required order: provider → compatibility → llmswitch (must be last)
    const moduleTypes = route.modules.map(m => m.type);

    if (moduleTypes[moduleTypes.length - 1] !== 'llmswitch') {
      throw new ConfigValidationError(
        `Route ${route.id} violates ToolsUniqueEntrance: llmswitch must be last module`,
        ['routes', route.id, 'modules', 'order']
      );
    }

    return { isValid: true, errors: [] };
  }
}
```

All configurations must pass schema validation at assembly time, with violations resulting in `ConfigValidationError` that exposes the exact config path for debugging.

## 🚀 Implementation Roadmap

### Phase 1: V2 Basic Architecture (3-4 days)
- [ ] Implement V2ModuleRegistry
- [ ] Implement DynamicRouter and ModuleChain
- [ ] Create V2 configuration schema
- [ ] Implement V2MigrationAdapter

### Phase 2: Switch Mechanism (2-3 days)
- [ ] Implement SystemModeSwitch
- [ ] Implement HybridModeManager
- [ ] Add mode switching API
- [ ] Implement auto rollback mechanism

### Phase 3: System Hooks (2 days)
- [ ] Implement SystemHookManager
- [ ] Create BuiltinHooks collection
- [ ] Integrate into request lifecycle
- [ ] Add hook configuration management

### Phase 4: Monitoring & Debugging (1-2 days)
- [ ] Implement V2Metrics
- [ ] Create V2DebugTools
- [ ] Integrate into existing monitoring system
- [ ] Add debugging API endpoints

### Phase 5: Testing & Validation (2-3 days)
- [ ] Unit test coverage
- [ ] Integration test validation
- [ ] Performance benchmark testing
- [ ] Stress test validation

## 🎯 Key Advantages

1. **Zero Risk Migration**: Switch back to V1 anytime, ensure business continuity
2. **Resource Optimization**: Virtual pipeline avoids large number of pre-built instances
3. **Flexible Routing**: Support dynamic routing decisions based on request characteristics
4. **System Observability**: Global hooks provide complete request lifecycle intervention capability
5. **Configuration Unification**: V2 configuration backward compatible, smooth migration

## 📊 Risk Assessment

| Risk Item | Level | Mitigation Measures |
|-----------|-------|---------------------|
| Performance Regression | Medium | Instance caching + warmup mechanism + performance monitoring |
| Switch Failure | Low | Auto rollback + health check + state validation |
| Configuration Compatibility | Medium | Auto migration + configuration validation + manual adjustment tools |
| Memory Leaks | Medium | Auto cleanup + instance pool management + memory monitoring |

---

*This design document serves as the blueprint for V2 architecture implementation. All components should follow these design principles and interfaces.*
