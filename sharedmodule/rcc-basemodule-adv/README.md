# RCC BaseModule Advanced (with native Dry-Run)

This shared module provides a drop-in, migration-friendly advanced base class that extends the project’s existing BaseModule and adds native dry-run capabilities. It is designed to be adopted module-by-module without breaking the current code.

Goals
- Native dry-run support at the base-class level, without changing the upstream rcc-basemodule package.
- Minimal, safe integration: existing modules can gradually migrate by extending AdvBaseModule instead of BaseModule.
- RCC4-aligned: Provider layer keeps zero transformation; dry-run only wraps execution and recording.

Key Features
- Module-level dry-run config (enable/disable, verbosity, sensitive fields)
- Operation wrapper `runWithDryRun` for request/response/internal phases
- Breakpoint behaviors: continue | pause | terminate | no-propagation
- Hooks for children to override:
  - `executeNodeDryRun` | `validateOutput` | `estimatePerformance` | `simulateError` | `generateExpectedOutput`
- Debug/Recording integration hooks (publish events, write logs, redact sensitive data)

Usage
1) Import and extend:
```ts
import { AdvBaseModule } from '../../sharedmodule/rcc-basemodule-adv/index.js';

export class MyModule extends AdvBaseModule {
  async initialize() {
    await super.initialize();
    this.setDryRunMode(true, { verbosity: 'normal' });
  }

  async processIncoming(request: any) {
    return this.runWithDryRun({
      opName: 'processIncoming',
      phase: 'process',
      direction: 'incoming'
    }, request, async () => {
      // Existing logic here
      return { ok: true };
    });
  }
}
```

2) Optional: override hooks to provide richer dry-run outputs
```ts
protected async executeNodeDryRun(input: any, ctx: DryRunContext) {
  const expected = await this.generateExpectedOutput(input, this.getModuleType());
  const perf = await this.estimatePerformance(input);
  return this.createNodeDryRunResult(ctx, input, expected, 'success', [], perf);
}
```

3) Migrate module-by-module to replace BaseModule inheritance with AdvBaseModule.

