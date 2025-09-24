# AdvBaseModule - Native Dry-Run Support for RCC4

## Overview

AdvBaseModule is an advanced base module that extends the standard BaseModule with native dry-run capabilities. It provides seamless integration with the existing RCC4 pipeline architecture while adding powerful testing and debugging features.

## Features

- 🔧 **Native Dry-Run Support**: Built-in dry-run functionality without external dependencies
- 🔙 **Backward Compatible**: Drop-in replacement for BaseModule
- ⚙️ **Configurable**: Multiple execution modes and breakpoint behaviors
- 📊 **Performance Metrics**: Built-in performance estimation and validation
- 🚨 **Error Simulation**: Test error scenarios safely
- 🔒 **Security**: Automatic sensitive data redaction
- 🧪 **Testing Ready**: Comprehensive test utilities

## Quick Start

### Installation

```bash
npm install routecodex
```

### Basic Usage

```typescript
import { AdvBaseModule } from 'routecodex/adv-base-module';

class MyModule extends AdvBaseModule {
  async processIncoming(request: any): Promise<any> {
    return this.runWithDryRun(
      { opName: 'processIncoming', phase: 'request', direction: 'incoming' },
      request,
      async () => {
        // Your processing logic here
        return this.transformRequest(request);
      },
      { nodeId: this.id, nodeType: this.type }
    );
  }
}
```

### Enable Dry-Run

```typescript
const module = new MyModule();

// Enable dry-run
module.setDryRunMode(true);

// Configure dry-run behavior
module.setNodeDryRunConfig('my-module', {
  enabled: true,
  mode: 'full-analysis',
  breakpointBehavior: 'continue',
  verbosity: 'normal'
});
```

## Dry-Run Modes

### 1. Output Validation (`output-validation`)
Validates expected output against predefined rules.

```typescript
module.setNodeDryRunConfig('node-id', {
  mode: 'output-validation',
  validationRules: [
    { rule: 'required-field', field: 'id', severity: 'error' },
    { rule: 'format-check', field: 'timestamp', pattern: 'ISO8601', severity: 'warning' }
  ]
});
```

### 2. Full Analysis (`full-analysis`)
Complete dry-run with performance estimation and detailed logging.

```typescript
module.setNodeDryRunConfig('node-id', {
  mode: 'full-analysis',
  includePerformanceEstimate: true,
  verbosity: 'detailed'
});
```

### 3. Error Simulation (`error-simulation`)
Simulates error conditions for testing error handling.

```typescript
module.setNodeDryRunConfig('node-id', {
  mode: 'error-simulation',
  errorSimulation: {
    enabled: true,
    probability: 0.1, // 10% chance of simulated error
    errorTypes: ['network', 'timeout', 'validation']
  }
});
```

## Breakpoint Behaviors

### Continue (`continue`)
Executes dry-run, then continues with real operation.

```typescript
module.setNodeDryRunConfig('node-id', {
  breakpointBehavior: 'continue'
});
```

### No Propagation (`no-propagation`)
Only executes dry-run, skips real operation.

```typescript
module.setNodeDryRunConfig('node-id', {
  breakpointBehavior: 'no-propagation'
});
```

### Pause (`pause`)
Pauses execution for inspection.

```typescript
module.setNodeDryRunConfig('node-id', {
  breakpointBehavior: 'pause'
});
```

### Terminate (`terminate`)
Stops execution chain after dry-run.

```typescript
module.setNodeDryRunConfig('node-id', {
  breakpointBehavior: 'terminate'
});
```

## Advanced Usage

### Custom Dry-Run Logic

```typescript
class CustomModule extends AdvBaseModule {
  protected async executeNodeDryRun(input: any, ctx: DryRunContext): Promise<NodeDryRunResult> {
    // Custom dry-run implementation
    const expected = await this.generateExpectedOutput(input);
    const performance = await this.estimatePerformance(input);
    
    return this.createNodeDryRunResult(
      ctx,
      input,
      expected,
      'success',
      [],
      performance
    );
  }
  
  protected async validateOutput(output: any, rules: any[]): Promise<ValidationResult[]> {
    // Custom validation logic
    const validations = [];
    
    if (!output.valid) {
      validations.push({
        rule: 'custom-validation',
        severity: 'error',
        message: 'Custom validation failed'
      });
    }
    
    return validations;
  }
}
```

### Pipeline Configuration

```typescript
// Configure entire pipeline
const pipelineConfig = {
  'llm-switch': {
    enabled: true,
    mode: 'full-analysis',
    breakpointBehavior: 'continue'
  },
  'compatibility': {
    enabled: true,
    mode: 'output-validation',
    breakpointBehavior: 'continue'
  },
  'provider': {
    enabled: true,
    mode: 'full-analysis',
    breakpointBehavior: 'no-propagation'
  }
};

// Apply configuration
Object.entries(pipelineConfig).forEach(([nodeId, config]) => {
  module.setNodeDryRunConfig(nodeId, config);
});
```

### Error Handling

```typescript
// Handle dry-run errors
try {
  const result = await module.processIncoming(request);
  
  if (result.status === 'error') {
    console.error('Dry-run validation failed:', result.validationResults);
  } else if (result.status === 'simulated-error') {
    console.error('Simulated error:', result.error);
  }
} catch (error) {
  console.error('Dry-run execution failed:', error);
}
```

## Testing

### Unit Tests

```typescript
import { describe, test, expect } from '@jest/globals';
import { AdvBaseModule } from 'routecodex/adv-base-module';

describe('MyModule Tests', () => {
  test('should work with dry-run disabled', async () => {
    const module = new MyModule();
    module.setDryRunMode(false);
    
    const result = await module.processIncoming({ test: 'data' });
    expect(result).toBeDefined();
  });
  
  test('should provide dry-run results when enabled', async () => {
    const module = new MyModule();
    module.setDryRunMode(true);
    module.setNodeDryRunConfig('my-module', {
      enabled: true,
      mode: 'full-analysis',
      breakpointBehavior: 'no-propagation'
    });
    
    const result = await module.processIncoming({ test: 'data' });
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('inputData');
    expect(result).toHaveProperty('expectedOutput');
  });
});
```

### Integration Tests

```typescript
test('should work in pipeline', async () => {
  const llmSwitch = new LLMSwitch();
  const compatibility = new Compatibility();
  const provider = new Provider();
  
  // Configure dry-run modes
  llmSwitch.setDryRunMode(true);
  compatibility.setDryRunMode(true);
  provider.setDryRunMode(false);
  
  // Execute pipeline
  const request = { model: 'test-model', messages: [] };
  const result1 = await llmSwitch.processIncoming(request);
  const result2 = await compatibility.processIncoming(result1);
  const result3 = await provider.processIncoming(result2);
  
  // Verify results
  expect(result1).toBeDefined();
  expect(result2).toBeDefined();
  expect(result3).toBeDefined();
});
```

## Migration from BaseModule

### Step 1: Change Import

```typescript
// From
import { BaseModule } from 'rcc-basemodule';

// To
import { AdvBaseModule } from 'routecodex/adv-base-module';
```

### Step 2: Change Parent Class

```typescript
// From
export class MyModule extends BaseModule

// To
export class MyModule extends AdvBaseModule
```

### Step 3: Wrap Operations

```typescript
// From
async processIncoming(request: any): Promise<any> {
  return this.doProcessing(request);
}

// To
async processIncoming(request: any): Promise<any> {
  return this.runWithDryRun(
    { opName: 'processIncoming', phase: 'request', direction: 'incoming' },
    request,
    async () => {
      return this.doProcessing(request);
    },
    { nodeId: this.id, nodeType: this.type }
  );
}
```

See [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md) for detailed migration instructions.

## API Reference

### Classes

#### AdvBaseModule

The main class that extends BaseModule with dry-run capabilities.

**Methods:**
- `setDryRunMode(enabled: boolean, config?: Partial<DryRunConfig>): void`
- `getDryRunConfig(): DryRunConfig`
- `setNodeDryRunConfig(nodeId: string, config: NodeDryRunConfig): void`
- `getNodeDryRunConfig(nodeId: string): NodeDryRunConfig | undefined`
- `runWithDryRun<T>(op: OperationDescriptor, input: any, exec: () => Promise<T>, options?: any): Promise<T | NodeDryRunResult>`

### Interfaces

#### DryRunConfig

```typescript
interface DryRunConfig {
  enabled: boolean;
  mode: 'partial' | 'full';
  verbosity: 'minimal' | 'normal' | 'detailed';
  includePerformanceEstimate: boolean;
  includeConfigValidation: boolean;
  sensitiveFields: string[];
}
```

#### NodeDryRunConfig

```typescript
interface NodeDryRunConfig {
  enabled: boolean;
  mode: 'output-validation' | 'full-analysis' | 'error-simulation';
  breakpointBehavior: 'continue' | 'no-propagation' | 'pause' | 'terminate';
  verbosity: 'minimal' | 'normal' | 'detailed';
  validationRules?: any[];
  errorSimulation?: {
    enabled: boolean;
    probability: number;
    errorTypes?: string[];
  };
}
```

#### NodeDryRunResult

```typescript
interface NodeDryRunResult {
  nodeId: string;
  nodeType: string;
  status: 'success' | 'warning' | 'error' | 'simulated-error';
  inputData: any;
  expectedOutput: any;
  validationResults: ValidationResult[];
  performanceMetrics: PerformanceMetrics;
  executionLog: ExecutionLogEntry[];
  error?: any;
}
```

## Examples

See the [test files](./tests/) for comprehensive examples:
- [adv-base-module-dry-run.test.js](./tests/adv-base-module-dry-run.test.js) - Basic functionality tests
- [adv-base-module-integration.test.js](./tests/adv-base-module-integration.test.js) - Integration tests
- [adv-base-module-migration.test.js](./tests/adv-base-module-migration.test.js) - Migration examples

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

## License

This project is licensed under the same terms as the main routecodex project.

## Support

For support and questions:
- Check the [documentation](./docs/)
- Review the [migration guide](./MIGRATION_GUIDE.md)
- File an issue on the project repository
- Run tests: `npm run test:adv-module`