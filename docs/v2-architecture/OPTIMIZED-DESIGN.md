# V2 Virtual Pipeline Optimization Design
## (Support for Multi-Configuration Module Static Loading)

## 🎯 Core Optimization Concept

Based on requirements, V2 architecture is adjusted to **Hybrid Mode**:
- **Static Instances**: Modules requiring multiple configurations (like compatibility) preload all variants
- **Virtual Connections**: Runtime dynamic selection of already instantiated modules for connection
- **Performance Priority**: Avoid module initialization overhead during request processing

## 🏗️ Optimized Architecture Design

### Architecture Comparison Diagram

```
V1 Static Assembly (Current):
┌─────────────────────────────────────────────────┐
│ Pipeline1: [ProviderA][CompatA][LLMSwitchA]    │ ← Complete static instances
│ Pipeline2: [ProviderB][CompatB][LLMSwitchB]    │ ← Complete static instances
│ Pipeline3: [ProviderC][CompatA][LLMSwitchC]    │ ← Complete static instances
└─────────────────────────────────────────────────┘

V2 Optimized Hybrid Architecture (New Design):
┌─────────────────────────────────────────────────────────────────┐
│                    Static Module Instance Pool                    │
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐│
│ │ ProviderA   │ │ ProviderB   │ │ CompatGLM   │ │ CompatQwen  ││
│ │ (single)    │ │ (single)    │ │ (single)    │ │ (single)    ││
│ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘│
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐│
│ │ LLMSwitchA  │ │ LLMSwitchB  │ │ CompatOpenAI│ │ WorkflowA   ││
│ │ (single)    │ │ (single)    │ │ (single)    │ │ (single)    ││
│ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              ↓ Dynamic routing selection
┌─────────────────────────────────────────────────────────────────┐
│                   Virtual Pipeline Connection Layer                │
│  RequestA → ProviderA ─→ CompatGLM ─→ LLMSwitchA ─→ ResponseA  │
│  RequestB → ProviderB ─→ CompatQwen ─→ LLMSwitchB ─→ ResponseB │
│  RequestC → ProviderA ─→ CompatOpenAI ─→ LLMSwitchA ─→ ResponseC│
└─────────────────────────────────────────────────────────────────┘
```

## 📋 Optimized Design Detailed Plan

### 1. Static Module Instance Pool Design

#### 1.1 Multi-Configuration Module Preload Mechanism

```typescript
// src/modules/pipeline/v2/core/static-instance-pool.ts
export class StaticInstancePool {
  // Store instances by module type and config hash
  private instances = new Map<string, Map<string, ModuleInstance>>();

  // Preload all configuration variants
  async preloadInstances(config: V2SystemConfig): Promise<void> {
    const moduleConfigs = this.extractModuleConfigs(config);

    for (const [moduleType, configs] of moduleConfigs) {
      await this.preloadModuleType(moduleType, configs);
    }
  }

  // Preload specific module type's all configurations
  private async preloadModuleType(
    moduleType: string,
    configs: ModuleConfig[]
  ): Promise<void> {
    const typeInstances = new Map<string, ModuleInstance>();

    for (const config of configs) {
      const configHash = this.hashConfig(config);
      const instance = await this.createInstance(moduleType, config);
      typeInstances.set(configHash, instance);
    }

    this.instances.set(moduleType, typeInstances);
  }

  // Get instance of specific configuration
  getInstance(moduleType: string, config: ModuleConfig): ModuleInstance {
    const configHash = this.hashConfig(config);
    const typeInstances = this.instances.get(moduleType);

    if (!typeInstances?.has(configHash)) {
      throw new Error(`Instance not found for ${moduleType}:${configHash}`);
    }

    return typeInstances.get(configHash)!;
  }

  // Configuration hash algorithm (ensure same config maps to same instance)
  private hashConfig(config: ModuleConfig): string {
    const normalized = this.normalizeConfig(config);
    return crypto.createHash('md5').update(JSON.stringify(normalized)).digest('hex');
  }
}
```

#### 1.2 Module Configuration Extractor

```typescript
// src/modules/pipeline/v2/config/module-config-extractor.ts
export class ModuleConfigExtractor {
  // Extract all required module configurations from route table
  extractModuleConfigs(routeTable: RouteTableConfig): Map<string, ModuleConfig[]> {
    const configs = new Map<string, ModuleConfig[]>();

    // Collect module configurations used in all routes
    for (const route of routeTable.routes) {
      for (const moduleSpec of route.modules) {
        const moduleType = moduleSpec.type;
        const moduleConfig = moduleSpec.config;

        if (!configs.has(moduleType)) {
          configs.set(moduleType, []);
        }

        // Check if same configuration already exists
        const existing = configs.get(moduleType)!;
        if (!this.hasSameConfig(existing, moduleConfig)) {
          existing.push(moduleConfig);
        }
      }
    }

    return configs;
  }

  // Check if configuration already exists (avoid duplicate instances)
  private hasSameConfig(existing: ModuleConfig[], newConfig: ModuleConfig): boolean {
    return existing.some(config =>
      JSON.stringify(this.normalizeConfig(config)) ===
      JSON.stringify(this.normalizeConfig(newConfig))
    );
  }
}
```

### 2. Optimized V2 Configuration Schema

#### 2.1 Route Definition Supporting Multiple Configurations

```typescript
// src/config/v2-config-schema.ts (Optimized version)
export interface V2SystemConfig {
  version: '2.0';

  // Static instance pool configuration
  staticInstances: {
    // Module types list that need preloading
    preloadModules: string[];
    // Instance pool configuration
    poolConfig: {
      maxInstancesPerType: number;
      warmupInstances: number;
      idleTimeout: number;
    };
  };

  // Virtual routing table
  virtualPipelines: {
    routeTable: RouteTableConfig;
    moduleRegistry: ModuleRegistryConfig;
  };

  // Other configurations remain unchanged...
}

export interface RouteDefinition {
  id: string;
  pattern: RequestPattern;

  // Module chain definition (support configuration reference)
  modules: ModuleSpecification[];

  // Route priority
  priority: number;
}

export interface ModuleSpecification {
  // Module type
  type: string;

  // Configuration reference or inline configuration
  config?: ModuleConfig | string; // Support configuration ID reference

  // Conditional selection (based on request features) - Must match explicitly
  condition?: RequestCondition;

  // Note: No fallback - fail fast when condition not met
}

// Usage example
export const exampleRoute: RouteDefinition = {
  id: 'glm-standard-route',
  pattern: { model: /^glm-/ },
  modules: [
    {
      type: 'provider',
      config: { type: 'glm-http-provider', providerType: 'glm' }
    },
    {
      type: 'compatibility',
      config: 'glm-compatibility-config' // Reference predefined configuration
    },
    {
      type: 'llmSwitch',
      config: { type: 'llmswitch-conversion-router' }
    }
  ]
};
```

#### 2.2 Configuration Library Design

```typescript
// src/config/v2-config-library.ts
export class V2ConfigLibrary {
  private static readonly COMPATIBILITY_CONFIGS = {
    'glm-compatibility-config': {
      type: 'glm-compatibility',
      config: {
        providerType: 'glm',
        // 字段映射配置 - 将GLM特定字段映射到OpenAI标准格式
        fieldMappings: {
          request: {
            // GLM -> OpenAI 映射规则
            'model': 'model',
            'messages': 'messages',
            'temperature': 'temperature',
            'max_tokens': 'max_tokens',
            // GLM特有字段映射
            'top_p': 'top_p',
            'stream': 'stream'
          },
          response: {
            // OpenAI <- GLM 映射规则
            'choices': 'choices',
            'usage': 'usage',
            'created': 'created',
            // GLM特有字段清理
            'request_id': null, // 移除GLM特有字段
            'task_id': null,    // 移除GLM特有字段
            'thought': null     // 移除GLM特有字段字段
          }
        },
        // 格式转换配置
        formatConversions: {
          // GLM的reasoning_content字段转换
          reasoningContent: {
            source: 'thought',
            target: 'reasoning_content',
            transform: 'extract_and_format'
          },
          // GLM的使用统计格式标准化
          usage: {
            source: 'usage',
            target: 'usage',
            transform: 'standardize_format'
          }
        },
        // 供应商特定处理
        providerSpecificProcessing: {
          // GLM特有的清理逻辑
          cleanup: [
            { field: 'model_id', action: 'remove' },
            { field: 'session_id', action: 'remove' },
            { field: 'task_status', action: 'remove' }
          ],
          // GLM特有的格式转换
          conversions: [
            {
              from: 'thought',
              to: 'reasoning_content',
              when: { field: 'thought', exists: true }
            }
          ]
        },
        // Hooks配置 - 字段映射前后挂载特殊处理
        hooks: {
          beforeFieldMapping: [
            {
              name: 'glm-request-preprocessor',
              enabled: true,
              config: {
                // GLM特有的请求预处理
                normalizeModelName: true,
                addGLMHeaders: true
              }
            }
          ],
          afterFieldMapping: [
            {
              name: 'glm-response-postprocessor',
              enabled: true,
              config: {
                // GLM特有的响应后处理
                extractThoughtContent: true,
                standardizeUsage: true
              }
            }
          ]
        }
      }
    },
    'openai-compatibility-config': {
      type: 'passthrough-compatibility',
      config: {
        providerType: 'openai',
        // OpenAI已经是标准格式，最小化处理
        fieldMappings: {
          request: {
            // OpenAI -> OpenAI 直接映射
            'model': 'model',
            'messages': 'messages',
            'temperature': 'temperature'
          },
          response: {
            // OpenAI <- OpenAI 直接映射
            'choices': 'choices',
            'usage': 'usage'
          }
        },
        // 格式转换配置 - OpenAI无需转换
        formatConversions: {},
        // 供应商特定处理 - OpenAI无需特殊处理
        providerSpecificProcessing: {
          cleanup: [],
          conversions: []
        },
        // Hooks配置 - OpenAI的hooks可选
        hooks: {
          beforeFieldMapping: [
            {
              name: 'openai-request-validator',
              enabled: false, // 默认关闭
              config: {
                validateOpenAIFormat: true
              }
            }
          ],
          afterFieldMapping: [
            {
              name: 'openai-response-enhancer',
              enabled: false, // 默认关闭
              config: {
                addOpenAIMetadata: true
              }
            }
          ]
        }
      }
    }
  };

  private static readonly PROVIDER_CONFIGS = {
    'glm-provider-config': {
      type: 'openai-standard',
      config: {
        providerType: 'glm',
        baseUrl: '${GLM_BASE_URL:https://open.bigmodel.cn/api/paas/v4}', // Config-driven, no hardcoded URLs
        auth: { type: 'apikey', apiKey: '${GLM_API_KEY}' },
        validation: {
          requiredEnvVars: ['GLM_API_KEY'],
          optionalEnvVars: ['GLM_BASE_URL']
        }
      }
    }
    // ... Other predefined configurations
  };

  static getAllConfigs(): Record<string, ModuleConfig> {
    return {
      ...this.COMPATIBILITY_CONFIGS,
      ...this.PROVIDER_CONFIGS,
      ...this.LLMSWITCH_CONFIGS
    };
  }
}
```

### 3. Optimized Dynamic Router

#### 3.1 Hybrid Router Implementation

```typescript
// src/modules/pipeline/v2/core/hybrid-router.ts
export class HybridDynamicRouter {
  constructor(
    private staticInstancePool: StaticInstancePool,
    private routeTable: RouteTableConfig
  ) {}

  // Route request (main entry point)
  async route(request: PipelineRequest): Promise<PipelineResponse> {
    // 1. Match best route
    const route = this.matchRoute(request);

    // 2. Build virtual module chain
    const moduleChain = await this.buildModuleChain(route, request);

    // 3. Execute chain processing
    const response = await this.executeChain(moduleChain, request);

    // 4. Cleanup temporary connections (keep instances)
    await moduleChain.cleanupConnections();

    return response;
  }

  // Build module chain (use static instances)
  private async buildModuleChain(
    route: RouteDefinition,
    request: PipelineRequest
  ): Promise<VirtualModuleChain> {
    const modules: ModuleInstance[] = [];

    for (const moduleSpec of route.modules) {
      // Select configuration based on request conditions
      const config = this.resolveConfig(moduleSpec, request);

      // Get instance from static pool (don't create new instance)
      const instance = this.staticInstancePool.getInstance(
        moduleSpec.type,
        config
      );

      modules.push(instance);
    }

    return new VirtualModuleChain(modules);
  }

  // Resolve module configuration (fail fast on condition mismatch)
  private resolveConfig(
    moduleSpec: ModuleSpecification,
    request: PipelineRequest
  ): ModuleConfig {
    // Check conditional selection - must match explicitly
    if (moduleSpec.condition && !this.evaluateCondition(moduleSpec.condition, request)) {
      throw new Error(`Condition failed for module ${moduleSpec.type}. No fallback allowed - fail fast.`);
    }

    // Resolve configuration reference
    if (typeof moduleSpec.config === 'string') {
      return V2ConfigLibrary.getConfig(moduleSpec.config);
    }

    return moduleSpec.config!;
  }
}
```

#### 3.2 Virtual Module Chain Implementation

```typescript
// src/modules/pipeline/v2/core/virtual-module-chain.ts
export class VirtualModuleChain {
  private connections: ModuleConnection[] = [];

  constructor(public modules: ModuleInstance[]) {
    this.buildConnections();
  }

  // Build temporary connections (don't create new instances)
  private buildConnections(): void {
    for (let i = 0; i < this.modules.length - 1; i++) {
      const from = this.modules[i];
      const to = this.modules[i + 1];

      // Create virtual connection (reference existing instances)
      const connection = new VirtualModuleConnection(from, to);
      this.connections.push(connection);
    }
  }

  // Execute chain processing
  async process(request: PipelineRequest): Promise<PipelineResponse> {
    let currentData = request;

    for (let i = 0; i < this.modules.length; i++) {
      const module = this.modules[i];
      const connection = this.connections[i];

      // Process data
      const result = await module.processIncoming(currentData, {
        moduleId: module.id,
        chainPosition: i,
        totalModules: this.modules.length
      });

      // Pass data through connection
      if (connection) {
        currentData = await connection.transform(result);
      } else {
        currentData = result;
      }
    }

    return currentData as PipelineResponse;
  }

  // Only cleanup connections, keep instances
  async cleanupConnections(): Promise<void> {
    for (const connection of this.connections) {
      await connection.cleanup();
    }
    this.connections = [];
  }
}

// Virtual connection (don't hold instance ownership)
export class VirtualModuleConnection {
  constructor(
    private from: ModuleInstance,
    private to: ModuleInstance
  ) {}

  async transform(data: any): Promise<any> {
    // Lightweight data transformation, no instance initialization involved
    return this.to.processIncoming(data, {
      fromModule: this.from.id,
      toModule: this.to.id
    });
  }

  async cleanup(): Promise<void> {
    // Cleanup connection state, but keep instances
    // Instances managed uniformly by StaticInstancePool
  }
}
```

### 4. System Startup and Warmup Mechanism

#### 4.1 Intelligent Warmup Strategy

```typescript
// src/modules/pipeline/v2/core/warmup-manager.ts
export class WarmupManager {
  constructor(
    private staticInstancePool: StaticInstancePool,
    private metrics: V2Metrics
  ) {}

  // Warmup system at startup
  async warmupSystem(config: V2SystemConfig): Promise<WarmupReport> {
    const report: WarmupReport = {
      startTime: Date.now(),
      preloadedInstances: 0,
      failedInstances: [],
      warnings: []
    };

    try {
      // 1. Analyze configuration, determine instances need preloading
      const preloadPlan = this.analyzePreloadRequirements(config);

      // 2. Load instances by priority order
      await this.preloadByPriority(preloadPlan, report);

      // 3. Verify instance availability
      await this.validateInstances(report);

      // 4. Record warmup metrics
      this.recordWarmupMetrics(report);

    } catch (error) {
      report.failedInstances.push({
        module: 'system',
        error: error.message,
        recoverable: false
      });
    }

    report.endTime = Date.now();
    report.duration = report.endTime - report.startTime;

    return report;
  }

  // Analyze preload requirements
  private analyzePreloadRequirements(config: V2SystemConfig): PreloadPlan {
    const extractor = new ModuleConfigExtractor();
    const moduleConfigs = extractor.extractModuleConfigs(config.virtualPipelines.routeTable);

    const plan: PreloadPlan = {
      critical: [],    // Core modules (provider, compatibility)
      important: [],  // Important modules (llmSwitch)
      optional: []    // Optional modules (workflow, monitoring)
    };

    // Classify by module type
    for (const [type, configs] of moduleConfigs) {
      const priority = this.getModulePriority(type);
      plan[priority].push({ type, configs });
    }

    return plan;
  }

  // Preload by priority
  private async preloadByPriority(plan: PreloadPlan, report: WarmupReport): Promise<void> {
    const phases = ['critical', 'important', 'optional'] as const;

    for (const phase of phases) {
      for (const { type, configs } of plan[phase]) {
        try {
          await this.staticInstancePool.preloadModuleType(type, configs);
          report.preloadedInstances += configs.length;
        } catch (error) {
          report.failedInstances.push({
            module: type,
            error: error.message,
            recoverable: phase !== 'critical'
          });
        }
      }
    }
  }
}
```

### 5. Performance Monitoring and Optimization

#### 5.1 Instance Pool Monitoring

```typescript
// src/monitoring/instance-pool-metrics.ts
export class InstancePoolMetrics {
  // Instance utilization monitoring
  trackInstanceUtilization(): void {
    // Record usage frequency of each instance
    // Identify idle instances and hotspot instances
    // Provide pool size adjustment recommendations
  }

  // Memory usage monitoring
  trackMemoryUsage(): void {
    // Monitor instance pool memory usage
    // Detect memory leaks
    // Trigger garbage collection recommendations
  }

  // Warmup effectiveness evaluation
  evaluateWarmupEffectiveness(): WarmupReport {
    // Evaluate warmup strategy effectiveness
    // Calculate latency reduction from warmup
    // Optimize warmup configuration
  }
}
```

## 🔧 Configuration Validation and Hygiene

### Config-Driven Values Only
All configuration must be externalized - no hardcoded values in code:

```typescript
// Correct: Config-driven with validation
'provider-config': {
  config: {
    baseUrl: '${PROVIDER_BASE_URL:https://api.provider.com/v1}', // Env var with default
    timeout: parseInt('${PROVIDER_TIMEOUT:30000}'), // Parsed env var
    validation: {
      requiredEnvVars: ['PROVIDER_API_KEY'],
      optionalEnvVars: ['PROVIDER_BASE_URL', 'PROVIDER_TIMEOUT']
    }
  }
}

// Incorrect: Hardcoded values
'provider-config': {
  config: {
    baseUrl: 'https://hardcoded-url.com/v1', // ❌ Hardcoded
    timeout: 30000 // ❌ Hardcoded
  }
}
```

### Stable Configuration Hashing
To prevent config hash collisions and ensure deterministic instance mapping:

```typescript
private hashConfig(config: ModuleConfig): string {
  // Use stable stringify with consistent key ordering
  const normalized = this.normalizeConfig(config);
  const stableString = this.stableStringify(normalized);
  return crypto.createHash('sha256').update(stableString).digest('hex');
}

private stableStringify(obj: any): string {
  // Recursive stable stringify to handle nested objects consistently
  const seen = new WeakSet();

  const stringify = (value: any): string => {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'object') {
      if (seen.has(value)) return '"[Circular]"';
      seen.add(value);

      if (Array.isArray(value)) {
        const arrayStr = '[' + value.map(stringify).join(',') + ']';
        seen.delete(value);
        return arrayStr;
      }

      const keys = Object.keys(value).sort();
      const objStr = '{' + keys.map(key =>
        JSON.stringify(key) + ':' + stringify(value[key])
      ).join(',') + '}';
      seen.delete(value);
      return objStr;
    }
    return 'null';
  };

  return stringify(obj);
}
```

## 🎯 Key Advantages

### Performance Advantages
1. **Zero Cold Start**: All module instances preloaded, directly used during requests
2. **Memory Efficient**: Same configuration shares instances, avoiding duplication
3. **Lightweight Connections**: Only create temporary connections, no instance initialization involved
4. **Intelligent Warmup**: Preload key modules by priority

### Architecture Advantages
1. **Flexible Routing**: Support dynamic module selection based on request characteristics
2. **Configuration Reuse**: Same configuration instances shared between different routes
3. **Gradual Migration**: V1/V2 dual mode seamless switching
4. **Observability**: Complete instance pool and routing monitoring

### Operations Advantages
1. **Warmup Report**: Detailed system startup status report
2. **Performance Insight**: Instance utilization and memory usage monitoring
3. **Fault Isolation**: Single instance failure doesn't affect overall system
4. **Dynamic Adjustment**: Support runtime instance pool configuration adjustment

This optimized design maintains the flexibility of V2 virtual pipelines while ensuring high performance through static instance pools, meeting the requirement for multi-configuration module preloading.
