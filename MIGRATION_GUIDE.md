# AdvBaseModule Migration Guide

## Overview

AdvBaseModule is a drop-in replacement for BaseModule that adds native dry-run capabilities to your modules. This guide provides step-by-step instructions for migrating existing modules from BaseModule to AdvBaseModule.

## Key Benefits

- **Native Dry-Run Support**: Built-in dry-run functionality without external dependencies
- **Backward Compatible**: Existing code continues to work without changes
- **Configurable**: Per-node dry-run configuration with multiple execution modes
- **Performance Metrics**: Built-in performance estimation and validation
- **Error Simulation**: Test error scenarios without affecting production

## Quick Start

### 1. Import AdvBaseModule

```typescript
import { AdvBaseModule } from 'routecodex/adv-base-module';
```

### 2. Change Parent Class

**Before:**
```typescript
import { BaseModule } from 'rcc-basemodule';

export class MyModule extends BaseModule {
  // Your existing code
}
```

**After:**
```typescript
import { AdvBaseModule } from 'routecodex/adv-base-module';

export class MyModule extends AdvBaseModule {
  // Your existing code (no changes needed)
}
```

### 3. Wrap Operations with Dry-Run

**Before:**
```typescript
async processIncoming(request: any): Promise<any> {
  // Your existing logic
  const result = await this.transformRequest(request);
  return result;
}
```

**After:**
```typescript
async processIncoming(request: any): Promise<any> {
  return this.runWithDryRun(
    { opName: 'processIncoming', phase: 'request', direction: 'incoming' },
    request,
    async () => {
      // Your existing logic (unchanged)
      const result = await this.transformRequest(request);
      return result;
    },
    { nodeId: this.id, nodeType: this.type }
  );
}
```

## Detailed Migration Steps

### Phase 1: Basic Migration

1. **Update Imports**
   ```typescript
   // Change from
   import { BaseModule } from 'rcc-basemodule';
   
   // To
   import { AdvBaseModule } from 'routecodex/adv-base-module';
   ```

2. **Change Class Declaration**
   ```typescript
   // Change from
   export class MyModule extends BaseModule
   
   // To
   export class MyModule extends AdvBaseModule
   ```

3. **Wrap Core Operations**
   Identify your main processing methods and wrap them with `runWithDryRun`:
   
   ```typescript
   async processIncoming(request: any): Promise<any> {
     return this.runWithDryRun(
       { opName: 'processIncoming', phase: 'request', direction: 'incoming' },
       request,
       async () => {
         // Your existing logic here
         return this.doProcessing(request);
       },
       { nodeId: this.id, nodeType: this.type }
     );
   }
   ```

### Phase 2: Configuration

1. **Set Dry-Run Mode**
   ```typescript
   // Enable dry-run globally
   module.setDryRunMode(true);
   
   // Or with custom configuration
   module.setDryRunMode(true, {
     mode: 'full-analysis',
     verbosity: 'detailed',
     includePerformanceEstimate: true
   });
   ```

2. **Configure Individual Nodes**
   ```typescript
   module.setNodeDryRunConfig('node-id', {
     enabled: true,
     mode: 'output-validation',
     breakpointBehavior: 'continue',
     verbosity: 'normal'
   });
   ```

### Phase 3: Advanced Features

1. **Custom Dry-Run Logic**
   Override dry-run methods for custom behavior:
   
   ```typescript
   protected async executeNodeDryRun(input: any, ctx: DryRunContext): Promise<NodeDryRunResult> {
     // Custom dry-run logic
     const expected = await this.generateCustomOutput(input);
     const perf = await this.estimateCustomPerformance(input);
     
     return this.createNodeDryRunResult(
       ctx,
       input,
       expected,
       'success',
       [],
       perf
     );
   }
   ```

2. **Output Validation**
   ```typescript
   protected async validateOutput(output: any, rules: any[]): Promise<ValidationResult[]> {
     const validations = [];
     
     // Add custom validation logic
     if (!output.requiredField) {
       validations.push({
         rule: 'required-field',
         severity: 'error',
         message: 'Required field missing'
       });
     }
     
     return validations;
   }
   ```

## Dry-Run Modes

### 1. Output Validation (`output-validation`)
- Validates expected output against rules
- Minimal performance overhead
- Best for: Quick validation and format checking

### 2. Full Analysis (`full-analysis`)
- Complete dry-run with performance estimation
- Detailed execution logs
- Best for: Comprehensive testing and debugging

### 3. Error Simulation (`error-simulation`)
- Simulates error conditions
- Tests error handling paths
- Best for: Error scenario testing

## Breakpoint Behaviors

### Continue (`continue`)
- Executes dry-run, then continues with real operation
- Default behavior for backward compatibility
- Use when: You want dry-run data but need real execution

### No Propagation (`no-propagation`)
- Only executes dry-run, skips real operation
- Returns dry-run result directly
- Use when: Testing without side effects

### Pause (`pause`)
- Pauses execution for inspection
- Useful for debugging complex scenarios
- Use when: Step-by-step debugging needed

### Terminate (`terminate`)
- Stops execution chain after dry-run
- Prevents further processing
- Use when: Early termination testing

## Configuration Examples

### Basic Configuration
```typescript
module.setDryRunMode(true, {
  enabled: true,
  mode: 'full-analysis',
  verbosity: 'normal',
  includePerformanceEstimate: true
});
```

### Per-Node Configuration
```typescript
// Configure different behaviors for different nodes
module.setNodeDryRunConfig('llm-switch', {
  enabled: true,
  mode: 'output-validation',
  breakpointBehavior: 'continue',
  verbosity: 'minimal'
});

module.setNodeDryRunConfig('compatibility', {
  enabled: true,
  mode: 'full-analysis',
  breakpointBehavior: 'no-propagation',
  verbosity: 'detailed'
});

module.setNodeDryRunConfig('provider', {
  enabled: true,
  mode: 'error-simulation',
  breakpointBehavior: 'terminate',
  verbosity: 'normal',
  errorSimulation: {
    enabled: true,
    probability: 0.1
  }
});
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

Object.entries(pipelineConfig).forEach(([nodeId, config]) => {
  module.setNodeDryRunConfig(nodeId, config);
});
```

## Testing Your Migration

### 1. Unit Tests
```typescript
describe('MyModule Dry-Run Tests', () => {
  let module: MyModule;
  
  beforeEach(() => {
    module = new MyModule();
  });
  
  test('should work with dry-run disabled', async () => {
    module.setDryRunMode(false);
    const result = await module.processIncoming({ test: 'data' });
    expect(result).toBeDefined();
  });
  
  test('should provide dry-run results when enabled', async () => {
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

### 2. Integration Tests
```typescript
test('should work in pipeline with mixed dry-run modes', async () => {
  const llmSwitch = new LLMSwitch();
  const compatibility = new Compatibility();
  const provider = new Provider();
  
  // Configure mixed modes
  llmSwitch.setDryRunMode(true);
  llmSwitch.setNodeDryRunConfig('llm-switch', {
    enabled: true,
    mode: 'output-validation',
    breakpointBehavior: 'continue'
  });
  
  compatibility.setDryRunMode(true);
  compatibility.setNodeDryRunConfig('compatibility', {
    enabled: true,
    mode: 'full-analysis',
    breakpointBehavior: 'no-propagation'
  });
  
  provider.setDryRunMode(false); // Real execution
  
  // Execute pipeline
  const request = { model: 'test-model', messages: [] };
  const result1 = await llmSwitch.processIncoming(request);
  const result2 = await compatibility.processIncoming(result1);
  const result3 = await provider.processIncoming(result2);
  
  // Verify results
  expect(result1).toBeDefined();
  expect(result2).toHaveProperty('status');
  expect(result3).toBeDefined();
});
```

## Best Practices

### 1. Gradual Migration
- Start with non-critical modules
- Test thoroughly before production deployment
- Use feature flags for gradual rollout

### 2. Configuration Management
- Use environment variables for dry-run settings
- Implement configuration validation
- Document dry-run configurations

### 3. Performance Considerations
- Use `output-validation` mode for quick checks
- Reserve `full-analysis` for debugging
- Monitor dry-run overhead in production

### 4. Error Handling
- Always test error simulation scenarios
- Implement proper error recovery
- Log dry-run results for analysis

## Troubleshooting

### Common Issues

1. **Dry-run not working**
   - Check if dry-run is enabled: `module.getDryRunConfig()`
   - Verify node configuration: `module.getNodeDryRunConfig(nodeId)`
   - Ensure proper operation descriptor format

2. **Performance issues**
   - Use appropriate dry-run mode
   - Consider disabling performance estimation
   - Optimize custom dry-run implementations

3. **Migration conflicts**
   - Check for method name collisions
   - Ensure proper TypeScript types
   - Verify backward compatibility

### Debug Tips

1. Enable detailed logging:
   ```typescript
   module.setDryRunMode(true, { verbosity: 'detailed' });
   ```

2. Check dry-run results:
   ```typescript
   console.log('Dry-run result:', result);
   console.log('Performance metrics:', result.performanceMetrics);
   console.log('Validation results:', result.validationResults);
   ```

3. Monitor execution logs:
   ```typescript
   console.log('Execution log:', result.executionLog);
   ```

## Support

For issues and questions:
- Check the [documentation](./README.md)
- Review the [test examples](./tests/adv-base-module-migration.test.js)
- File an issue on the project repository

## Migration Checklist

- [ ] Update imports from `rcc-basemodule` to `routecodex/adv-base-module`
- [ ] Change class inheritance from `BaseModule` to `AdvBaseModule`
- [ ] Wrap core operations with `runWithDryRun`
- [ ] Configure dry-run settings per module
- [ ] Add unit tests for dry-run functionality
- [ ] Test backward compatibility
- [ ] Validate performance impact
- [ ] Update documentation
- [ ] Deploy with monitoring