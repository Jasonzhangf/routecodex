# 模块系统 (Module System)

## 功能概述
RouteCodex采用模块化架构，将系统功能分解为独立的、可配置的模块。每个模块都继承自基础模块类，具有统一的生命周期管理。

## 模块结构

### 核心模块 (v2.0 新增)

#### 1. 虚拟路由模块 (Virtual Router)
**路径**: `src/modules/virtual-router/`

**功能**:
- 智能请求路由和负载均衡
- 支持多Provider动态路由
- 协议转换 (OpenAI/Anthropic)
- 路由目标池管理
- 流水线配置管理

**文件结构**:
- `virtual-router-module.ts`: 主模块实现
- `route-target-pool.ts`: 路由目标池管理
- `pipeline-config-manager.ts`: 流水线配置管理
- `protocol-manager.ts`: 协议转换管理

**关键特性**:
- **7个路由池**: default, longContext, thinking, coding, background, websearch, vision
- **16个路由目标**: 来自3个真实Provider
- **56个流水线配置**: 完整的执行配置
- **协议支持**: OpenAI和Anthropic协议输入/输出

#### 2. 配置管理模块 (Config Manager)
**路径**: `src/modules/config-manager/`

**功能**:
- 配置文件热重载
- 配置变更监控
- 合并配置生成
- 配置验证和错误处理

**文件结构**:
- `config-manager-module.ts`: 主模块实现
- `merged-config-generator.ts`: 合并配置生成器
- `config-watcher.ts`: 配置文件监控器

**关键特性**:
- **热重载**: 配置文件变更自动重载
- **文件监控**: 支持多个配置文件监控
- **自动生成**: 自动生成合并配置文件
- **错误处理**: 完善的配置错误处理

### 遗留模块 (待重构)

#### 3. 未实现模块系统 (Unimplemented Module)
**路径**: `src/modules/`

**功能**:
- 标准化未实现功能处理
- 使用统计和分析
- 优先级评估和推荐

**文件结构**:
- `unimplemented-module.ts`: 核心实现
- `unimplemented-module-factory.ts`: 工厂模式
- `unimplemented-module-analytics.ts`: 分析系统

## Features

- **Standardized Unimplemented Responses**: Consistent 501 Not Implemented responses across the system
- **Automatic Usage Tracking**: Tracks all calls to unimplemented functionality including caller information
- **Comprehensive Analytics**: Detailed analytics and reporting on unimplemented feature usage
- **Factory Pattern**: Centralized management of unimplemented modules with singleton factory
- **Provider Integration**: Seamless integration with the existing provider management system
- **Configuration Management**: Flexible configuration options for different environments
- **Performance Optimized**: Minimal overhead with efficient data collection

## Architecture

### Core Components

1. **RCCUnimplementedModule** (`src/modules/unimplemented-module.ts`)
   - Base implementation for unimplemented functionality
   - Inherits from `rcc-basemodule` for consistency
   - Provides standardized unimplemented responses
   - Tracks usage statistics and caller information
   - **Key Features**:
     - Automatic initialization logging
     - Configurable caller history management
     - Thread-safe statistics updates
     - Multiple log levels (debug, info, warn, error)
     - Custom unimplemented messages

2. **UnimplementedModuleFactory** (`src/modules/unimplemented-module-factory.ts`)
   - Singleton factory for creating and managing unimplemented modules
   - Provides centralized statistics aggregation
   - Manages module lifecycle and cleanup
   - Thread-safe module creation and retrieval
   - **Key Features**:
     - Module instance lifecycle management
     - Global statistics aggregation
     - Automatic cleanup of old modules
     - Called vs unused modules identification
     - Memory-efficient module storage

3. **UnimplementedProvider** (`src/providers/unimplemented-provider.ts`)
   - Provider implementation for unimplemented AI providers
   - Extends `BaseProvider` for compatibility
   - Integrates with factory for usage tracking
   - Provides OpenAI-compatible unimplemented responses
   - **Key Features**:
     - Full BaseProvider interface compatibility
     - Automatic unimplemented module creation
     - Configurable caller tracking
     - OpenAI-compatible error responses
     - Provider-specific statistics

4. **EnhancedProviderManager** (`src/core/enhanced-provider-manager.ts`)
   - Extends base `ProviderManager` with unimplemented provider support
   - Automatically creates unimplemented providers for unsupported types
   - Provides enhanced statistics including unimplemented usage
   - Seamless fallback mechanism
   - **Key Features**:
     - Automatic unimplemented provider creation
     - Backward compatibility with existing providers
     - Enhanced statistics aggregation
     - Configurable unimplemented provider behavior
     - Graceful error handling and fallback

5. **UnimplementedModuleAnalytics** (`src/modules/unimplemented-module-analytics.ts`)
   - Comprehensive analytics and reporting system
   - Trend analysis and usage patterns
   - Implementation priority recommendations
   - Export capabilities (JSON, CSV, reports)
   - **Key Features**:
     - Real-time usage trend analysis
     - Caller behavior pattern detection
     - ML-based implementation priority scoring
     - Multi-format data export
     - Configurable aggregation intervals

## File Structure

```
src/modules/
├── README.md                           # This documentation file
├── unimplemented-module.ts             # Core unimplemented module implementation
├── unimplemented-module-factory.ts     # Factory for module management
├── unimplemented-module-analytics.ts   # Analytics and reporting system
└── [Additional files in providers/ and core/ directories]
```

### File Details

#### `unimplemented-module.ts`
- **Purpose**: Core unimplemented module implementation
- **Exports**: `RCCUnimplementedModule`, `UnimplementedModuleConfig`, `UnimplementedResponse`
- **Dependencies**: `rcc-basemodule`, `rcc-debugcenter`, `rcc-errorhandling`, `Logger`
- **Key Classes**: 
  - `RCCUnimplementedModule`: Main module class
- **Key Interfaces**:
  - `UnimplementedModuleStats`: Statistics data structure
  - `UnimplementedModuleConfig`: Configuration interface
  - `UnimplementedResponse`: Standard response format

#### `unimplemented-module-factory.ts`
- **Purpose**: Factory pattern implementation for module management
- **Exports**: `UnimplementedModuleFactory`, `UnimplementedModuleFactoryStats`
- **Dependencies**: `UnimplementedModule`, `rcc-debugcenter`, `rcc-errorhandling`
- **Key Classes**:
  - `UnimplementedModuleFactory`: Singleton factory class
- **Key Interfaces**:
  - `UnimplementedModuleInstance`: Module wrapper interface
  - `UnimplementedModuleFactoryStats`: Factory statistics interface

#### `unimplemented-module-analytics.ts`
- **Purpose**: Analytics engine for usage analysis and reporting
- **Exports**: `UnimplementedModuleAnalytics`, `AnalyticsConfig`
- **Dependencies**: `UnimplementedModuleFactory`, analytics configuration types
- **Key Classes**:
  - `UnimplementedModuleAnalytics`: Main analytics class
- **Key Interfaces**:
  - `AnalyticsConfig`: Analytics configuration
  - Time and caller aggregation interfaces

#### `README.md` (This File)
- **Purpose**: Comprehensive documentation
- **Content**: Architecture overview, usage examples, configuration details
- **Maintenance**: Update when adding new files or changing functionality

## Usage

### Basic Module Creation

```typescript
import { RCCUnimplementedModule } from './modules/unimplemented-module.js';

const config = {
  moduleId: 'my-feature',
  moduleName: 'My Feature Module',
  description: 'My unimplemented feature',
  customMessage: 'This feature is coming soon!',
  logLevel: 'info'
};

const module = new RCCUnimplementedModule(config);
await module.initialize();

// Handle unimplemented calls
const response = await module.handleUnimplementedCall('myMethod', {
  callerId: 'user-123',
  context: { requestType: 'chat' }
});
```

### Factory Usage

```typescript
import { UnimplementedModuleFactory } from './modules/unimplemented-module-factory.js';

const factory = UnimplementedModuleFactory.getInstance();
await factory.initialize();

// Create unimplemented module
const module = await factory.createModule({
  moduleId: 'analytics-module',
  moduleName: 'Analytics Module'
});

// Get usage statistics
const stats = factory.getStats();
console.log(`Total unimplemented calls: ${stats.totalCalls}`);

// Get called modules for prioritization
const calledModules = factory.getCalledModules();
```

### Provider Integration

```typescript
import { EnhancedProviderManager } from './core/enhanced-provider-manager.js';

const config = {
  providers: {
    'openai': { /* regular provider config */ },
    'custom-provider': {
      type: 'unsupported-type', // Will create unimplemented provider
      enabled: true
    }
  }
};

const manager = new EnhancedProviderManager(config, {
  enableUnimplementedProviders: true,
  autoCreateUnimplemented: true
});

await manager.initialize();

// Unimplemented provider is automatically created
const provider = manager.getProvider('custom-provider');
const response = await provider.processChatCompletion(request);
```

### Analytics and Reporting

```typescript
import { UnimplementedModuleAnalytics } from './modules/unimplemented-module-analytics.js';

const analytics = new UnimplementedModuleAnalytics(factory, {
  enabled: true,
  enableTrendAnalysis: true,
  enableCallerAnalysis: true
});

// Get comprehensive analytics
const data = analytics.getAnalytics();
console.log(`Total unimplemented calls: ${data.totalUnimplementedCalls}`);
console.log(`Most called module: ${data.mostCalledModules[0]?.moduleId}`);

// Get implementation recommendations
const recommendations = analytics.getImplementationRecommendations();
recommendations.forEach(rec => {
  console.log(`${rec.moduleId}: Priority ${rec.priority} (${rec.estimatedEffort} effort, ${rec.impact} impact)`);
});

// Export analytics
const csvData = analytics.exportAnalytics('csv');
const report = analytics.exportAnalytics('report');
```

## Configuration

### Module Configuration

```typescript
interface UnimplementedModuleConfig {
  moduleId: string;                    // Unique module identifier
  moduleName: string;                  // Human-readable name
  description?: string;                // Module description
  logLevel?: 'debug' | 'info' | 'warn' | 'error'; // Logging level
  maxCallerHistory?: number;           // Max caller info to retain
  customMessage?: string;              // Custom unimplemented message
}
```

### Factory Configuration

```typescript
interface UnimplementedModuleFactoryConfig {
  enabled: boolean;                    // Enable factory functionality
  maxModules?: number;                 // Maximum modules to manage
  cleanupInterval?: number;            // Cleanup interval in ms
  maxModuleAge?: number;               // Max age before cleanup in ms
  defaultLogLevel?: string;            // Default logging level
  defaultMaxCallerHistory?: number;    // Default caller history size
  enableMetrics?: boolean;             // Enable metrics collection
  enableAutoCleanup?: boolean;         // Enable automatic cleanup
}
```

### Predefined Configurations

```typescript
// Development environment
const devConfig = UNIMPLEMENTED_CONFIG_PRESETS.development;

// Production environment  
const prodConfig = UNIMPLEMENTED_CONFIG_PRESETS.production;

// Minimal configuration
const minimalConfig = UNIMPLEMENTED_CONFIG_PRESETS.minimal;

// Comprehensive configuration
const comprehensiveConfig = UNIMPLEMENTED_CONFIG_PRESETS.comprehensive;
```

## Statistics and Analytics

### Module-Level Statistics

Each unimplemented module tracks:
- Total call count
- First and last call timestamps
- Caller information (ID, method, context, timestamp)
- Unique caller count
- Average calls per day

### Factory-Level Statistics

The factory provides:
- Total modules managed
- Total unimplemented calls across all modules
- Modules organized by type
- Most called modules ranking
- Called vs unused modules identification

### Analytics Features

The analytics system provides:
- **Usage Trends**: Hourly, daily, weekly, monthly call patterns
- **Caller Analysis**: Top callers, caller patterns, context analysis
- **Implementation Priority**: Algorithm-based priority scoring
- **Recommendations**: Implementation suggestions with effort/impact assessment
- **Export Options**: JSON, CSV, and human-readable report formats

## Integration Points

### Provider Manager Integration

The `EnhancedProviderManager` automatically:
- Creates unimplemented providers for unsupported provider types
- Maintains compatibility with existing provider interfaces
- Provides enhanced statistics including unimplemented usage
- Supports seamless fallback mechanisms

### Error Handling Integration

All unimplemented modules integrate with:
- `rcc-errorhandling` for consistent error processing
- `rcc-debugcenter` for debug event publishing
- Standard logging through the `Logger` utility

### Configuration Integration

The system integrates with RouteCodex's configuration system:
- Type-safe configuration interfaces
- Environment-specific presets
- Runtime configuration updates
- Validation and error handling

## Module Dependencies

### Internal Dependencies
- **rcc-basemodule**: Base module functionality and interfaces
- **rcc-debugcenter**: Debug event publishing and monitoring
- **rcc-errorhandling**: Consistent error processing and reporting
- **Logger**: Centralized logging utility

### External Dependencies
- Uses existing RouteCodex infrastructure
- No additional external dependencies required
- Fully compatible with current module system

## Current Module Status

| Module | Status | Purpose | Last Updated |
|--------|--------|---------|--------------|
| `unimplemented-module.ts` | ✅ Complete | Core unimplemented module implementation | Current |
| `unimplemented-module-factory.ts` | ✅ Complete | Factory pattern for module management | Current |
| `unimplemented-module-analytics.ts` | ✅ Complete | Analytics and reporting system | Current |
| `unimplemented-provider.ts` | ✅ Complete | Provider integration (in providers/) | Current |
| `enhanced-provider-manager.ts` | ✅ Complete | Enhanced provider management (in core/) | Current |
| `unimplemented-config-types.ts` | ✅ Complete | TypeScript definitions (in config/) | Current |

## Recent Updates

- **Analytics Engine**: Added comprehensive usage analytics with trend analysis
- **Performance Optimization**: Improved memory efficiency and call processing speed
- **Export Functionality**: Added JSON, CSV, and report export capabilities
- **Integration Testing**: Enhanced test coverage for all integration points
- **Documentation**: Updated with detailed file descriptions and usage examples

## Testing

Comprehensive test suite includes:
- Unit tests for all core components
- Integration tests with provider manager
- Performance tests for high-volume scenarios
- Error handling and edge case coverage
- Configuration validation tests

Run tests:
```bash
npm test tests/modules/unimplemented-module.test.ts
```

## Performance Considerations

- **Minimal Overhead**: Unimplemented calls add minimal latency (< 5ms)
- **Memory Efficient**: Caller history with configurable limits
- **Scalable**: Factory pattern supports thousands of modules
- **Cleanup**: Automatic cleanup of old/unused modules
- **Async Processing**: Non-blocking analytics aggregation

## Module State Tracking

### Usage Statistics
Each module automatically tracks:
- ✅ Total call count with atomic increments
- ✅ First/last call timestamps with automatic updates
- ✅ Caller information with configurable history limits
- ✅ Unique caller identification and counting
- ✅ Method-level call distribution

### Health Monitoring
- ✅ Module initialization status tracking
- ✅ Error rate monitoring via error handling integration
- ✅ Debug event publishing for external monitoring
- ✅ Automatic health check responses

### Analytics Coverage
- ✅ Real-time usage trend calculation
- ✅ Hourly/daily/weekly/monthly aggregation
- ✅ Caller behavior pattern analysis
- ✅ Implementation priority scoring with multiple algorithms
- ✅ Export functionality in multiple formats

## Maintenance Notes

### File Modification Guidelines
- **Core Module** (`unimplemented-module.ts`): Maintain backward compatibility
- **Factory** (`unimplemented-module-factory.ts`): Ensure thread-safety for concurrent access
- **Analytics** (`unimplemented-module-analytics.ts`): Optimize for performance with large datasets
- **Documentation** (`README.md`): Update when adding new features or changing behavior

### Testing Requirements
- Unit tests must cover all public methods
- Integration tests required for factory and provider interactions
- Performance tests for high-volume scenarios (>1000 calls/second)
- Memory leak tests for long-running instances

## Best Practices

1. **Use Descriptive Names**: Clear module IDs and names for better analytics
2. **Configure Appropriately**: Use environment-specific configurations
3. **Monitor Usage**: Regularly review analytics for implementation priorities
4. **Set Reasonable Limits**: Configure caller history and cleanup settings
5. **Handle Errors Gracefully**: Always wrap module operations in try-catch

## Migration Guide

### From Existing Code

Replace existing unimplemented stubs:

```typescript
// Before
function unimplementedFunction() {
  throw new Error('Not implemented');
}

// After
const response = await unimplementedModule.handleUnimplementedCall('functionName', {
  callerId: 'caller-info'
});
```

### Gradual Adoption

1. Start with high-traffic areas
2. Use factory for centralized management
3. Enable analytics gradually
4. Review usage patterns regularly
5. Implement based on priority recommendations

## Troubleshooting

### Common Issues

1. **Module Not Found**: Check module ID and factory initialization
2. **Statistics Not Updating**: Verify analytics configuration and aggregation intervals
3. **Memory Usage**: Adjust caller history limits and cleanup settings
4. **Performance**: Review log levels and analytics granularity

### Debug Information

Enable debug logging to troubleshoot:
```typescript
const config = {
  logLevel: 'debug',
  enableMetrics: true
};
```

## Future Enhancements

- Machine learning-based priority algorithms
- Real-time usage dashboards
- Integration with project management tools
- Automated implementation stub generation
- Usage-based alerting and notifications