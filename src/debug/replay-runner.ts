import { DebugSessionManager } from './session-manager.js';
import { HarnessRegistry } from './harness-registry.js';
import type {
  ProviderHarnessExecuteInput,
  ProviderHarnessMetadata,
  ProviderHarnessRuntime,
  ProviderDryRunResult,
  ProviderHarnessResult
} from './types.js';
import type { TargetMetadata } from '../modules/pipeline/orchestrator/pipeline-context.js';

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

  async replayProvider(
    options: ReplayOptions & { runtimeOverride?: ProviderHarnessRuntime }
  ): Promise<ProviderDryRunResult[]> {
    const harness = this.registry.require<ProviderHarnessExecuteInput, ProviderHarnessResult>('provider.preprocess');
    const snapshots = await this.listSnapshots(options);
    const results: ProviderDryRunResult[] = [];
    for (const snapshot of snapshots) {
      const metadata = toProviderMetadata(snapshot.metadata);
      if (!metadata) {
        continue;
      }
      const runtime = options.runtimeOverride ?? metadata.runtime;
      if (!runtime) {
        continue;
      }
      const payload = snapshot.payload;
      if (!payload || typeof payload !== 'object') {
        continue;
      }
      const processed = await harness.executeForward({
        runtime,
        request: payload as Record<string, unknown>,
        metadata
      });
      results.push({ processed: processed.payload, metadata });
    }
    return results;
  }
}

function toProviderMetadata(value: unknown): ProviderHarnessMetadata | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const requiredStrings = [
    'requestId',
    'providerId',
    'providerKey',
    'providerType',
    'providerProtocol',
    'routeName'
  ] as const;
  for (const key of requiredStrings) {
    if (typeof record[key] !== 'string') {
      return null;
    }
  }
  const target = record.target;
  if (!target || typeof target !== 'object' || typeof (target as TargetMetadata).providerKey !== 'string') {
    return null;
  }
  return {
    ...record,
    requestId: record.requestId as string,
    providerId: record.providerId as string,
    providerKey: record.providerKey as string,
    providerType: record.providerType as string,
    providerProtocol: record.providerProtocol as string,
    routeName: record.routeName as string,
    target: target as TargetMetadata,
    runtime: record.runtime as ProviderHarnessRuntime | undefined,
    metadata: record.metadata as Record<string, unknown> | undefined
  } as ProviderHarnessMetadata;
}
