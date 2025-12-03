import { DebugSessionManager } from './session-manager.js';
import { HarnessRegistry } from './harness-registry.js';
import type { ProviderDryRunOptions, ProviderDryRunResult } from './types.js';
import type { ProviderPreprocessHarness } from './harnesses/provider-harness.js';

export class DryRunRunner {
  constructor(private readonly sessions: DebugSessionManager, private readonly registry: HarnessRegistry) {}

  async runProviderPreprocess(options: ProviderDryRunOptions): Promise<ProviderDryRunResult> {
    const harness = this.registry.require('provider.preprocess') as ProviderPreprocessHarness;
    const result = await harness.executeForward({
      runtime: options.runtime,
      request: options.request,
      metadata: options.metadata
    });
    if (options.sessionId) {
      await this.sessions.recordSnapshot(options.sessionId, {
        nodeId: options.nodeId || harness.id,
        direction: 'request',
        payload: result.payload,
        metadata: {
          providerKey: options.runtime.providerKey,
          providerId: options.runtime.providerId,
          requestId: options.metadata.requestId,
          runtime: options.runtime,
          harness: harness.id
        }
      });
    }
    return {
      processed: result.payload,
      metadata: options.metadata
    };
  }
}
