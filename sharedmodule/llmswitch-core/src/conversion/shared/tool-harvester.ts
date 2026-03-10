import {
  harvestToolsWithNative
} from '../../router/virtual-router/engine-selection/native-hub-bridge-action-semantics.js';

type Unknown = Record<string, unknown>;

export interface HarvestContext {
  requestId?: string;
  idPrefix?: string;
  chunkSize?: number;
  source?: 'chat' | 'responses' | 'messages';
}

export interface HarvestSignal {
  type: 'delta' | 'final' | 'compat';
  payload: Unknown;
}

export interface DeltaEvent {
  tool_calls?: Array<{ index: number; id: string; type: 'function'; function: { name?: string; arguments?: string } }>;
  content?: string;
  role?: string;
}

export interface HarvestResult {
  deltaEvents: DeltaEvent[];
  normalized?: Unknown;
  stats?: Unknown;
}

function assertToolHarvesterNativeAvailable(): void {
  if (typeof harvestToolsWithNative !== 'function') {
    throw new Error('[tool-harvester] native bindings are required');
  }
}

export function harvestTools(signal: HarvestSignal, ctx?: HarvestContext): HarvestResult {
  assertToolHarvesterNativeAvailable();
  const result = harvestToolsWithNative({
    signal: signal as unknown as Record<string, unknown>,
    context: ctx as unknown as Record<string, unknown> | undefined
  });
  const normalized = result?.normalized;
  if (normalized && signal?.payload && typeof signal.payload === 'object') {
    const target = signal.payload as Record<string, unknown>;
    const next = normalized as Record<string, unknown>;
    for (const key of Object.keys(target)) {
      delete target[key];
    }
    Object.assign(target, next);
  }
  return result;
}
