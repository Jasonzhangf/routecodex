# RouteCodex Advanced BaseModule (AdvBaseModule)

An advanced base module that extends the standard BaseModule with native dry-run capabilities for the RouteCodex pipeline architecture.

## Features

- 🔄 **Native Dry-Run Support**: Built-in dry-run functionality without external dependencies
- 🔒 **Backward Compatible**: Drop-in replacement for existing BaseModule
- ⚙️ **Highly Configurable**: Multiple execution modes and breakpoint behaviors
- 📊 **Performance Metrics**: Built-in performance estimation and validation
- 🚨 **Error Simulation**: Test error scenarios safely
- 🛡️ **Security**: Automatic sensitive data redaction
- 🧪 **Testing Ready**: Comprehensive test utilities and validation

## Installation

```bash
npm install rcc-basemodule-adv
```

## Quick Start

```typescript
import { AdvBaseModule } from 'rcc-basemodule-adv';

class MyModule extends AdvBaseModule {
  async processIncoming(request: any): Promise<any> {
    return this.runWithDryRun(
      { opName: 'processIncoming', phase: 'request', direction: 'incoming' },
      request,
      async () => {
        // Your processing logic
        return this.transformRequest(request);
      },
      { nodeId: this.id, nodeType: this.type }
    );
  }
}
```

## Configuration

```typescript
const module = new MyModule();

// Enable dry-run
module.setDryRunMode(true);

// Configure node behavior
module.setNodeDryRunConfig('my-module', {
  enabled: true,
  mode: 'full-analysis',
  breakpointBehavior: 'continue',
  verbosity: 'normal'
});
```

## Dry-Run Modes

- **output-validation**: Validates expected output against rules
- **full-analysis**: Complete dry-run with performance estimation
- **error-simulation**: Simulates error conditions for testing

## Breakpoint Behaviors

- **continue**: Execute dry-run, then continue with real operation
- **no-propagation**: Only execute dry-run, skip real operation
- **pause**: Pause execution for inspection
- **terminate**: Stop execution chain after dry-run

## API Reference

See the main routecodex documentation for detailed API reference and migration guide.

## License

MIT