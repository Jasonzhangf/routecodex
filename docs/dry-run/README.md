# Dry-Run System Documentation

The RouteCodex Dry-Run System is a comprehensive debugging and testing framework that enables detailed analysis of pipeline execution without actual processing. It supports node-level dry-run execution, intelligent input simulation, bidirectional pipeline processing, and advanced error recovery mechanisms.

## 🏗️ Architecture Overview

The dry-run system consists of several interconnected components that work together to provide a complete debugging experience:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Dry-Run System Architecture                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │   Pipeline Dry-  │  │   Input         │  │   Bidirectional │  │
│  │   Run Executor   │  │   Simulator     │  │   Pipeline      │  │
│  │                 │  │                 │  │                 │  │
│  │ • Node-level    │  │ • Mock data     │  │ • Request &    │  │
│  │   dry-run       │  │   generation    │  │   response      │  │
│  │ • Pipeline break │  │ • Context       │  │   pipelines     │  │
│  │ • Event         │  │   propagation   │  │ • Driver        │  │
│  │   handling      │  │ • Quality        │  │   feedback      │  │
│  │ • Mixed modes   │  │   assessment     │  │ • Real response │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │   Memory        │  │   Error         │  │   Pipeline      │  │
│  │   Management    │  │   Boundaries    │  │   Dry-Run       │  │
│  │                 │  │                 │  │   Framework     │  │
│  │ • Resource      │  │ • Multi-level    │  │ • Dry-run       │  │
│  │   tracking      │  │   error         │  │   configs       │  │
│  │ • Auto cleanup  │  │   handling      │  │ • Validation     │  │
│  │ • Memory        │  │ • Recovery       │  │   rules         │  │
│  │   monitoring    │  │   strategies     │  │ • Performance   │  │
│  │ • Cleanup       │  │ • Circuit        │  │   estimation     │  │
│  │   strategies    │  │   breakers       │  │                 │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## 📁 File Structure

### Core Framework Files

| File | Description | Key Features |
|------|-------------|--------------|
| **`pipeline-dry-run-framework.ts`** | Core dry-run framework and interfaces | Node-level configurations, validation rules, error simulation |
| **`dry-run-pipeline-executor.ts`** | Main pipeline execution engine | Node registration, execution order, event handling, mixed modes |
| **`input-simulator.ts`** | Intelligent input simulation system | Multiple simulation strategies, context propagation, quality assessment |
| **`bidirectional-pipeline-dry-run.ts`** | Bidirectional pipeline support | Request/response pipelines, driver feedback, real response integration |
| **`memory-management.ts`** | Memory and resource management | Resource tracking, cleanup strategies, memory monitoring |
| **`error-boundaries.ts`** | Error handling and recovery | Multi-level error boundaries, circuit breakers, graceful degradation |
| **`memory-interface.ts`** | Memory management interfaces | Type definitions, resource interfaces, monitoring interfaces |
| **`pipeline-dry-run-examples.ts`** | Usage examples and demonstrations | Configuration examples, test scenarios, best practices |

### Test Files

| File | Description | Test Coverage |
|------|-------------|---------------|
| **`test-all-nodes-dry-run.mjs`** | All-nodes dry-run functionality | Input simulation, complete pipeline dry-run |
| **`test-bidirectional-pipeline-dry-run.mjs`** | Bidirectional pipeline testing | Mixed modes, response sources, feedback analysis |

## 🔧 Core Components

### 1. Pipeline Dry-Run Framework (`pipeline-dry-run-framework.ts`)

**Purpose**: Provides the foundation for node-level dry-run execution with "pipeline break" debugging capabilities.

**Key Interfaces**:
- `NodeDryRunConfig`: Configuration for individual node dry-run behavior
- `NodeDryRunResult`: Standardized result format for dry-run execution
- `PipelineDryRunResponse`: Comprehensive response format for pipeline dry-run
- `OutputValidationRule`: Validation rules for expected outputs

**Features**:
- **Node-Level Configuration**: Each pipeline node can be independently configured for dry-run
- **Multiple Dry-Run Modes**: Output validation, full analysis, error simulation
- **Validation Rules**: Comprehensive output validation with customizable rules
- **Error Simulation**: Controlled error simulation for testing error handling
- **Performance Estimation**: Detailed performance metrics and estimates
- **Breakpoint Support**: Debug breakpoints for detailed inspection

**Usage Example**:
```typescript
import { pipelineDryRunManager, type NodeDryRunConfig } from './src/modules/pipeline/dry-run/pipeline-dry-run-framework.js';

const config: NodeDryRunConfig = {
  enabled: true,
  mode: 'full-analysis',
  breakpointBehavior: 'pause',
  verbosity: 'detailed',
  validationRules: [
    {
      id: 'schema-validation',
      type: 'schema',
      condition: { required: ['_metadata'] },
      errorMessage: 'Missing required metadata',
      severity: 'error'
    }
  ]
};

pipelineDryRunManager.configureNodeDryRun('llm-switch', config);
```

### 2. Dry-Run Pipeline Executor (`dry-run-pipeline-executor.ts`)

**Purpose**: Orchestrates the execution of dry-run pipelines with support for mixed execution modes and intelligent input simulation.

**Key Classes**:
- `DryRunPipelineExecutor`: Main execution engine for dry-run pipelines
- `PipelineNodeInfo`: Node information and configuration
- `ExecutionContext`: Complete execution context with metadata
- `BreakpointEvent`: Event system for debugging and monitoring

**Features**:
- **Mixed Execution Modes**: Support for partial dry-run (some nodes normal, some dry-run)
- **All-Nodes Dry-Run**: Intelligent handling when all nodes are configured for dry-run
- **Event System**: Comprehensive event handling for debugging
- **Execution Plans**: Detailed execution plans with time estimates
- **Breakpoint Handling**: Configurable breakpoint behavior (continue, pause, terminate)
- **Performance Tracking**: Real-time performance metrics and statistics

**Usage Example**:
```typescript
import { dryRunPipelineExecutor } from './src/modules/pipeline/dry-run/dry-run-pipeline-executor.js';

// Register nodes with mixed dry-run configuration
dryRunPipelineExecutor.registerNodes([
  {
    id: 'llm-switch',
    type: 'llm-switch',
    module: llmSwitchModule,
    isDryRun: true,
    config: { enabled: true, mode: 'full-analysis' }
  },
  {
    id: 'provider',
    type: 'provider',
    module: providerModule,
    isDryRun: false // Normal execution
  }
]);

// Execute in mixed mode
const result = await dryRunPipelineExecutor.executePipeline(
  request,
  'test-pipeline',
  'mixed'
);
```

### 3. Input Simulator (`input-simulator.ts`)

**Purpose**: Solves the "all nodes dry-run" problem by generating intelligent mock input data for pipeline execution.

**Key Classes**:
- `InputSimulator`: Main simulation engine with multiple strategies
- `InputSimulationConfig`: Configuration for simulation behavior
- `SimulatedInput`: Result of input simulation with quality metrics
- `ContextPropagationData`: Data propagation context for pipeline simulation

**Simulation Strategies**:
- **Historical Data**: Uses historical request/response data
- **Schema Inference**: Generates data based on node schema definitions
- **Rule-Based**: Uses predefined rules and templates
- **AI Generation**: AI-powered data generation
- **Request Propagation**: Propagates original request with modifications

**Features**:
- **Multiple Fallback Strategies**: Automatic strategy selection with fallbacks
- **Quality Assessment**: Quality scoring and confidence metrics
- **Context Propagation**: Maintains context across pipeline nodes
- **Performance Estimation**: Time and memory usage estimates
- **Historical Learning**: Learns from actual execution data

**Usage Example**:
```typescript
import { inputSimulator } from './src/modules/pipeline/dry-run/input-simulator.js';

const simulatedInput = await inputSimulator.simulateInput(
  originalRequest,
  'llm-switch',
  'llm-switch',
  contextData,
  {
    enabled: true,
    primaryStrategy: 'historical-data',
    fallbackStrategies: ['schema-inference', 'rule-based'],
    qualityRequirement: 'medium'
  }
);
```

### 4. Bidirectional Pipeline Dry-Run (`bidirectional-pipeline-dry-run.ts`)

**Purpose**: Extends dry-run capabilities to bidirectional pipelines with request/response processing and driver feedback.

**Key Classes**:
- `BidirectionalPipelineManager`: Manages bidirectional pipeline execution
- `BidirectionalPipelineConfig`: Configuration for bidirectional behavior
- `ResponseDryRunConfig**: Response-specific dry-run configuration
- `DriverFeedbackAnalysis**: Comprehensive feedback analysis

**Features**:
- **Bidirectional Processing**: Separate request and response pipeline handling
- **Real Response Integration**: Use actual server responses as dry-run input
- **Driver Feedback**: Performance and quality analysis across pipeline stages
- **Response Input Sources**: Multiple response data sources (real, simulated, cached)
- **Transformation Rules**: Configurable response transformation and validation
- **Performance Analytics**: Detailed performance metrics and optimization suggestions

**Response Input Sources**:
- **Real Response**: Use actual server responses
- **Simulated Response**: AI-generated mock responses
- **Cached Response**: Use cached historical responses

**Usage Example**:
```typescript
import { bidirectionalPipelineManager } from './src/modules/pipeline/dry-run/bidirectional-pipeline-dry-run.js';

const result = await bidirectionalPipelineManager.executeBidirectionalPipeline(
  request,
  'bidirectional-test',
  realServerResponse
);

console.log('Request result:', result.requestResult);
console.log('Response result:', result.responseResult);
console.log('Driver feedback:', result.driverFeedbackAnalysis);
```

### 5. Memory Management (`memory-management.ts`)

**Purpose**: Provides comprehensive memory management, resource cleanup, and leak prevention for dry-run operations.

**Key Classes**:
- `MemoryManager`: Centralized memory and resource management
- `ResourceInfo`: Detailed resource tracking information
- `MemoryStats`: Comprehensive memory usage statistics
- `CleanupResult**: Results of cleanup operations

**Features**:
- **Resource Tracking**: Automatic registration and tracking of all resources
- **Multiple Cleanup Strategies**: LRU, LFU, FIFO, TTL, hybrid strategies
- **Memory Monitoring**: Real-time memory usage monitoring with thresholds
- **Automatic Cleanup**: Configurable automatic resource cleanup
- **Performance Optimization**: Memory optimization and leak prevention
- **Statistics and Reporting**: Detailed memory usage reports and analytics

**Cleanup Strategies**:
- **LRU (Least Recently Used)**: Clean least recently used resources first
- **LFU (Least Frequently Used)**: Clean least frequently used resources first
- **FIFO (First In First Out)**: Clean resources in creation order
- **TTL-Based**: Clean resources based on time-to-live
- **Size-Based**: Clean largest resources first
- **Hybrid**: Intelligent combination of multiple strategies

**Usage Example**:
```typescript
import { memoryManager, ResourceType } from './src/modules/pipeline/dry-run/memory-management.js';

// Register a resource for tracking
memoryManager.registerResource(
  'resource-123',
  ResourceType.EXECUTION_CONTEXT,
  resourceData,
  1024, // Estimated size in bytes
  ['execution', 'dry-run'],
  { pipelineId: 'test-pipeline' }
);

// Get resource with automatic access tracking
const resource = memoryManager.getResource('resource-123');

// Manual cleanup
const cleanupResult = await memoryManager.cleanup();
console.log(`Freed ${cleanupResult.freedMemory} bytes`);
```

### 6. Error Boundaries (`error-boundaries.ts`)

**Purpose**: Provides comprehensive error handling, recovery mechanisms, and fault tolerance for dry-run operations.

**Key Classes**:
- `ErrorBoundaryManager`: Centralized error boundary management
- `ErrorBoundary`: Individual error boundary for protected operations
- `SystemError**: Standardized error representation
- `CircuitBreakerState**: Circuit breaker state management

**Features**:
- **Multi-Level Error Handling**: Global and local error boundaries
- **Intelligent Recovery Strategies**: Automatic recovery with multiple strategies
- **Circuit Breaker Pattern**: Prevents cascading failures
- **Graceful Degradation**: Maintains system availability during errors
- **Error Isolation**: Contains errors within boundaries
- **Comprehensive Statistics**: Detailed error tracking and analysis

**Recovery Strategies**:
- **Retry Immediate**: Immediate retry for transient errors
- **Retry Delayed**: Delayed retry with configurable delays
- **Retry Exponential**: Exponential backoff for persistent errors
- **Fallback Primary/Secondary**: Fallback to alternative implementations
- **Circuit Breaker**: Temporarily stop operations on repeated failures
- **Graceful Degradation**: Degrade functionality gracefully
- **Skip Operation**: Skip non-critical operations
- **Terminate**: Stop operations on critical errors

**Usage Example**:
```typescript
import { errorBoundaryManager, defaultErrorBoundaryConfig } from './src/modules/pipeline/dry-run/error-boundaries.js';

// Create an error boundary
const boundary = errorBoundaryManager.createBoundary({
  ...defaultErrorBoundaryConfig,
  boundaryId: 'dry-run-boundary',
  maxRetries: 3,
  enableCircuitBreaker: true,
  enableGracefulDegradation: true
});

// Execute protected operation
const result = await boundary.execute(
  async () => {
    // Your dry-run operation here
    return await performDryRunOperation();
  },
  async () => {
    // Fallback operation
    return await performFallbackOperation();
  }
);
```

### 7. Memory Interface (`memory-interface.ts`)

**Purpose**: Defines comprehensive interfaces for memory management, resource handling, and system monitoring.

**Key Interfaces**:
- `Disposable`: Standard interface for disposable resources
- `ResourceUsage`: System resource usage information
- `MemoryEvent`: Memory-related event data
- `MemoryAnalyzer`: Memory analysis and leak detection
- `MemoryMonitor`: Real-time memory monitoring
- `ResourcePool`: Resource pooling interface

**Features**:
- **Type Safety**: Comprehensive TypeScript type definitions
- **Extensibility**: Well-defined interfaces for extension
- **Monitoring**: Standardized monitoring capabilities
- **Analysis**: Memory analysis and leak detection interfaces
- **Resource Management**: Standardized resource lifecycle management

## 🚀 Usage Patterns

### 1. Basic Node-Level Dry-Run

```typescript
// Configure individual nodes for dry-run
pipelineDryRunManager.configureNodesDryRun({
  'llm-switch': {
    enabled: true,
    mode: 'output-validation',
    breakpointBehavior: 'continue',
    verbosity: 'normal'
  },
  'compatibility': {
    enabled: true,
    mode: 'full-analysis',
    breakpointBehavior: 'pause',
    verbosity: 'detailed'
  }
});

// Execute with mixed modes
const result = await dryRunPipelineExecutor.executePipeline(
  request,
  'test-pipeline',
  'mixed'
);
```

### 2. All-Nodes Dry-Run with Input Simulation

```typescript
// Configure all nodes for dry-run
const allNodesConfig = {
  'llm-switch': { enabled: true, mode: 'full-analysis' },
  'compatibility': { enabled: true, mode: 'full-analysis' },
  'provider': { enabled: true, mode: 'full-analysis' }
};

pipelineDryRunManager.configureNodesDryRun(allNodesConfig);

// Execute - input simulator will automatically generate mock data
const result = await dryRunPipelineExecutor.executePipeline(
  request,
  'all-nodes-test',
  'dry-run'
);
```

### 3. Bidirectional Pipeline Dry-Run

```typescript
// Configure bidirectional pipeline
const bidirectionalConfig = {
  requestConfig: {
    dryRunMode: 'full',
    nodeConfigs: {
      'llm-switch': { enabled: true, mode: 'full-analysis' },
      'compatibility': { enabled: false, mode: 'output-validation' }
    }
  },
  responseConfig: {
    dryRunMode: 'partial',
    responseDryRun: {
      enabled: true,
      inputSource: 'real-response',
      performanceAnalysis: true
    }
  },
  driverFeedback: {
    enabled: true,
    analysisLevel: 'detailed'
  }
};

const result = await bidirectionalPipelineManager.executeBidirectionalPipeline(
  request,
  'bidirectional-test',
  realServerResponse
);
```

### 4. Memory Management Integration

```typescript
// Register resources for automatic cleanup
memoryManager.registerResource(
  'dry-run-context',
  ResourceType.EXECUTION_CONTEXT,
  contextData,
  2048,
  ['dry-run', 'execution'],
  { pipelineId: 'test-pipeline' }
);

// Execute with memory monitoring
const stats = memoryManager.getStats();
console.log(`Memory usage: ${stats.totalUsage} bytes (${(stats.memoryUsageRatio * 100).toFixed(1)}%)`);
```

### 5. Error Boundary Protection

```typescript
// Create protected execution boundary
const boundary = errorBoundaryManager.createBoundary({
  boundaryId: 'dry-run-protection',
  maxRetries: 3,
  enableCircuitBreaker: true,
  enableGracefulDegradation: true
});

// Execute with error protection
const result = await boundary.execute(
  async () => {
    return await performComplexDryRunOperation();
  },
  async () => {
    return await performGracefulFallback();
  }
);
```

## 🧪 Testing

### Running Tests

```bash
# Test all-nodes dry-run functionality
node test-all-nodes-dry-run.mjs

# Test bidirectional pipeline dry-run
node test-bidirectional-pipeline-dry-run.mjs

# Run with specific configurations
node test-all-nodes-dry-run.mjs --mode=full-analysis
node test-bidirectional-pipeline-dry-run.mjs --response-source=real-response
```

### Test Coverage

The test suite covers:

- **All-Nodes Dry-Run**: Input simulation, context propagation, complete pipeline analysis
- **Mixed Execution Modes**: Partial dry-run with normal execution nodes
- **Bidirectional Processing**: Request/response pipeline coordination
- **Response Input Sources**: Real, simulated, and cached response handling
- **Driver Feedback Analysis**: Performance and quality analytics
- **Memory Management**: Resource tracking, cleanup strategies, leak prevention
- **Error Boundaries**: Error handling, recovery mechanisms, circuit breakers
- **Performance Monitoring**: Memory usage, execution time, resource optimization

## 🔧 Configuration

### Dry-Run Configuration Structure

```json
{
  "dryRun": {
    "global": {
      "enabled": true,
      "defaultMode": "output-validation",
      "verbosity": "normal",
      "autoCleanup": true
    },
    "nodes": {
      "llm-switch": {
        "enabled": true,
        "mode": "full-analysis",
        "breakpointBehavior": "continue",
        "validationRules": [...],
        "errorSimulation": {...}
      },
      "compatibility": {
        "enabled": false,
        "mode": "output-validation"
      }
    },
    "inputSimulation": {
      "enabled": true,
      "primaryStrategy": "historical-data",
      "fallbackStrategies": ["schema-inference", "rule-based"],
      "qualityRequirement": "medium"
    },
    "memory": {
      "maxMemoryUsage": 536870912,
      "cleanupInterval": 60000,
      "enableMonitoring": true,
      "cleanupStrategy": "hybrid"
    },
    "errorHandling": {
      "maxRetries": 3,
      "enableCircuitBreaker": true,
      "enableGracefulDegradation": true
    }
  }
}
```

## 📊 Monitoring and Analytics

### Memory Usage Monitoring

```typescript
// Get current memory statistics
const stats = memoryManager.getStats();
console.log(`Memory Usage: ${stats.totalUsage} bytes`);
console.log(`Active Resources: ${stats.activeResources}`);
console.log(`Cache Hit Rate: ${stats.cacheHitRate}`);

// Set up memory monitoring callbacks
memoryManager.setCallbacks({
  onMemoryWarning: (stats) => {
    console.warn(`Memory usage warning: ${(stats.memoryUsageRatio * 100).toFixed(1)}%`);
  },
  onMemoryCritical: (stats) => {
    console.error(`Memory usage critical: ${(stats.memoryUsageRatio * 100).toFixed(1)}%`);
  }
});
```

### Error Analytics

```typescript
// Get error statistics
const errorStats = errorBoundaryManager.getStats();
console.log(`Total Errors: ${errorStats.totalErrors}`);
console.log(`Successful Recoveries: ${errorStats.successfulRecoveries}`);
console.log(`Average Recovery Time: ${errorStats.averageRecoveryTime}ms`);

// Get active errors
const activeErrors = errorBoundaryManager.getActiveErrors();
```

### Performance Analytics

```typescript
// Driver feedback analysis provides detailed performance metrics
if (result.driverFeedbackAnalysis) {
  const analysis = result.driverFeedbackAnalysis;
  console.log(`Request-Response Correlation: ${analysis.requestResponseCorrelation.similarity}`);
  console.log(`Total Processing Time: ${analysis.performanceAnalysis.totalOverhead}ms`);
  console.log(`Overall Quality Score: ${analysis.qualityAnalysis.overallQuality}`);
}
```

## 🎯 Best Practices

### 1. Configuration Management
- Use consistent configuration across all dry-run nodes
- Configure appropriate verbosity levels for different environments
- Enable memory monitoring in production environments

### 2. Memory Management
- Always register resources with the memory manager
- Use appropriate cleanup strategies for your use case
- Monitor memory usage and set appropriate thresholds

### 3. Error Handling
- Create appropriate error boundaries for critical operations
- Configure sensible retry strategies for different error types
- Enable graceful degradation for non-critical operations

### 4. Performance Optimization
- Use input simulation for all-nodes dry-run scenarios
- Leverage caching for frequently used response data
- Monitor performance metrics and optimize accordingly

### 5. Testing Strategy
- Test both individual nodes and complete pipelines
- Validate mixed execution modes thoroughly
- Test error scenarios and recovery mechanisms

## 🔍 Troubleshooting

### Common Issues

**Memory Leaks**
- Ensure all resources are properly registered with memory manager
- Check for missing cleanup operations
- Monitor memory usage trends over time

**Slow Performance**
- Optimize input simulation strategies
- Use caching for frequently accessed data
- Adjust cleanup intervals based on load

**Error Recovery Failures**
- Verify error boundary configurations
- Check fallback operation implementations
- Monitor circuit breaker states

**Input Simulation Issues**
- Validate simulation strategy configurations
- Check historical data availability
- Ensure appropriate fallback strategies are configured

### Debug Tools

```typescript
// Enable detailed logging
console.log('Memory Stats:', memoryManager.getStats());
console.log('Error Stats:', errorBoundaryManager.getStats());

// Get detailed resource information
const resources = memoryManager.getAllResources();
resources.forEach(resource => {
  console.log(`${resource.id}: ${resource.estimatedSize} bytes`);
});

// Check circuit breaker states
dryRunPipelineExecutor.getRegisteredNodes().forEach(node => {
  const boundary = errorBoundaryManager.getBoundary(node.id);
  if (boundary) {
    console.log(`${node.id} circuit breaker:`, boundary.getCircuitBreakerState());
  }
});
```

## 📈 Advanced Features

### Custom Simulation Strategies

```typescript
// Add custom simulation strategy
inputSimulator.addStrategy('custom-strategy', async (input, context) => {
  // Custom simulation logic
  return {
    source: 'custom',
    data: customGenerateData(input, context),
    quality: 0.9,
    confidence: 0.85,
    strategy: 'custom-strategy',
    metadata: { /* Custom metadata */ }
  };
});
```

### Custom Error Handlers

```typescript
// Add custom error handlers
const boundary = errorBoundaryManager.createBoundary({
  ...defaultErrorBoundaryConfig,
  customHandlers: {
    [ErrorType.NETWORK_ERROR]: async (error) => {
      // Custom network error handling
      return await handleNetworkError(error);
    }
  }
});
```

### Custom Recovery Strategies

```typescript
// Implement custom recovery logic
const customRecovery = async (error: SystemError) => {
  // Custom recovery logic
  return {
    success: true,
    resolved: true,
    action: 'custom-recovery',
    result: await performCustomRecovery(error)
  };
};
```

This comprehensive dry-run system provides powerful debugging and testing capabilities for the RouteCodex pipeline, enabling detailed analysis, performance optimization, and reliable error handling across all execution scenarios.