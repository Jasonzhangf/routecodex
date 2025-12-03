import { DebugSessionManager } from './session-manager.js';
import { HarnessRegistry } from './harness-registry.js';
import type { ProviderPreprocessHarness } from './harnesses/provider-harness.js';
import type { ProviderDryRunResult } from './types.js';

export interface ReplayOptions {
  sessionId: string;
  nodeId?: string;
  direction?: 'request' | 'response';
  limit?: number;
}

export class ReplayRunner {
  constructor(private readonly sessions: DebugSessionManager, private readonly registry: HarnessRegistry) {}

  async listSnapshots(options: ReplayOptions) {
    return await this.sessions.fetchSnapshots(options.sessionId, {
      nodeId: options.nodeId,
      direction: options.direction,
      limit: options.limit
    });
  }

  async replayProvider(options: ReplayOptions & { runtimeOverride?: Record<string, unknown> }): Promise<ProviderDryRunResult[]> {
    const harness = this.registry.require('provider.preprocess') as ProviderPreprocessHarness;
    const snapshots = await this.listSnapshots(options);
    const results: ProviderDryRunResult[] = [];
    for (const snapshot of snapshots) {
      const metadata = (snapshot.metadata || {}) as any;
      const runtime = options.runtimeOverride || metadata.runtime;
      if (!runtime) continue;
      const payload = snapshot.payload as Record<string, unknown>;
      const processed = await harness.executeForward({
        runtime: runtime as any,
        request: payload as Record<string, unknown>,
        metadata: metadata as any
      });
      results.push({ processed: processed.payload, metadata });
    }
    return results;
  }
}
