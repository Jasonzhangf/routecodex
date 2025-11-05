# V2 Pipeline Architecture

## 🎯 Overview

V2 Pipeline Architecture introduces a hybrid approach that combines the performance benefits of static module instances with the flexibility of dynamic routing. This architecture supports seamless migration from V1 while enabling advanced features like dynamic routing, system hooks, and improved observability.

## 🏗️ Core Architecture

### Key Components

1. **StaticInstancePool** - Preloads module instances for all required configurations
2. **DynamicConnector** - Establishes temporary connections between static instances at runtime
3. **V2PipelineAssembler** - Validates configurations and prepares static instances
4. **HybridRouter** - Routes requests through dynamically connected static instances
5. **V1V2ModeSwitch** - Enables gradual migration between V1 and V2 modes

### Architecture Diagram

```
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

## 📁 Directory Structure

```
src/modules/pipeline/v2/
├── core/                          # Core V2 components
│   ├── static-instance-pool/      # Static instance management
│   ├── dynamic-connector/         # Runtime connection management
│   ├── hybrid-router/             # Dynamic routing with static instances
│   ├── warmup-manager/            # System startup and warmup
│   └── module-registry/           # Module factory and registration
├── config/                        # Configuration management
│   ├── migration/                 # V1 to V2 migration tools
│   ├── validation/                # Configuration validation
│   └── library/                   # Predefined configurations
├── monitoring/                    # V2 specific monitoring
├── tools/                         # Development and debugging tools
└── types/                         # V2 type definitions
```

## 🚀 Key Features

### 1. Static Instance Pool
- **Multi-Configuration Support**: Preload different configurations for the same module type
- **Instance Sharing**: Same configurations share instances to save memory
- **Lazy Loading**: Instances created on-demand and cached for reuse
- **Health Monitoring**: Continuous monitoring of instance health and performance

### 2. Dynamic Connection System
- **Runtime Routing**: Modules connected dynamically based on request characteristics
- **Lightweight Connections**: Only connection establishment/teardown overhead
- **Automatic Cleanup**: Connections automatically cleaned up after request processing
- **Error Isolation**: Connection failures don't affect other instances

### 3. Gradual Migration
- **V1/V2 Compatibility**: Seamless switching between architectures
- **Configuration Migration**: Automatic conversion from V1 to V2 format
- **Prerun Validation**: Validate V2 setup before switching
- **Rollback Capability**: Instant rollback to V1 if issues arise

### 4. System Hooks
- **Request Lifecycle**: Hooks for request processing stages
- **System Events**: Hooks for mode switches and system events
- **Custom Hooks**: Support for user-defined hooks
- **Performance Monitoring**: Built-in performance tracking

## 🔧 Usage Examples

### Basic V2 Setup

```typescript
// Initialize V2 assembler
const assembler = new V2PipelineAssembler(
  new StaticInstancePool(),
  new V2ConfigValidator()
);

// Assemble pipelines (prerun validation)
const assembled = await assembler.assemble(mergedConfig);

// Create dynamic connector
const connector = new DynamicConnector();

// Handle request
const response = await connector.handleRequest(
  request,
  assembled.v2Config,
  assembled.staticInstancePool
);
```

### V1 to V2 Migration

```typescript
// Migrate V1 configuration to V2
const v2Config = V1ToV2Migrator.migrate(v1Config);

// Validate V2 setup
const validator = new PreRunValidator();
const report = await validator.validateV2Setup(v2Config);

// Switch modes gradually
const modeSwitch = new V1V2ModeSwitch();
const switchReport = await modeSwitch.gradualSwitch('v2', {
  validateCompatibility: true,
  trafficShift: { percentage: 10 }
});
```

### Custom Module Configuration

```typescript
// Define custom route with multiple configurations
const customRoute: RouteDefinition = {
  id: 'glm-custom-route',
  pattern: { model: /^glm-/ },
  modules: [
    {
      type: 'provider',
      config: 'glm-provider-config' // Reference predefined config
    },
    {
      type: 'compatibility',
      config: {
        type: 'glm-compatibility',
        config: {
          providerType: 'glm',
          customSettings: { /* custom config */ }
        }
      }
    },
    {
      type: 'llmSwitch',
      config: 'conversion-router-config'
    }
  ]
};
```

## 📊 Performance Characteristics

### Memory Usage
- **Instance Sharing**: Same configurations share instances (30-50% memory reduction)
- **Lazy Loading**: Only required instances are loaded
- **Automatic Cleanup**: Idle instances are recycled automatically

### Latency
- **Connection Overhead**: < 1ms for connection establishment
- **Static Performance**: Equal to V1 for cached instances
- **Routing Time**: < 0.5ms for route matching and selection

### Throughput
- **Connection Pooling**: Multiple concurrent connections supported
- **Instance Reuse**: No instance creation overhead per request
- **Dynamic Scaling**: Can handle varying load patterns efficiently

## 🔄 Migration Guide

### Step 1: Preparation
1. Backup current V1 configuration
2. Review V2 feature compatibility
3. Plan migration strategy and timeline

### Step 2: Configuration Migration
1. Run automatic V1 to V2 migration
2. Review migration report
3. Manually adjust any custom configurations

### Step 3: Validation
1. Run prerun validation
2. Test with sample requests
3. Verify response consistency with V1

### Step 4: Gradual Switch
1. Enable V2 in shadow mode
2. Gradually shift traffic to V2
3. Monitor performance and errors
4. Complete migration or rollback as needed

## 🚨 Troubleshooting

### Common Issues

**Instance Not Found Error**
```
Error: Instance not found for compatibility:configHash
```
**Solution**: Check that all required module configurations are defined in the static instance pool.

**Connection Timeout**
```
Error: Module connection timeout after 5000ms
```
**Solution**: Verify module health and increase timeout if needed.

**Migration Validation Failed**
```
Error: V2 compatibility issue: response format mismatch
```
**Solution**: Review module configurations and ensure compatibility with V1 behavior.

### Debug Tools

```typescript
// Visualize dynamic routing
const visualization = await debugTools.visualizeRoute(request);

// Trace module chain execution
const chainTrace = await debugTools.traceModuleChain(chainId);

// Analyze performance
const perfReport = await debugTools.analyzePerformance(timeRange);

// Validate configuration
const validationReport = await debugTools.validateV2Config(config);
```

## 📚 Additional Documentation

- [Complete Architecture Design](../../../docs/v2-architecture/README.md)
- [Optimized Design Details](../../../docs/v2-architecture/OPTIMIZED-DESIGN.md)
- [Prerun and Connection Design](../../../docs/v2-architecture/PRERUN-CONNECTION-DESIGN.md)
- [Implementation Roadmap](../../../docs/v2-architecture/IMPLEMENTATION-ROADMAP.md)

---

*V2 Architecture provides a solid foundation for future enhancements while maintaining compatibility with existing V1 configurations.*