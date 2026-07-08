import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const nativeBinding = nodeRequire(
  path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node')
) as Record<string, unknown>;

export interface NativeReqProcessToolGovernanceInput {
  request: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  entryEndpoint: string;
  requestId: string;
  hasActiveStopMessageForContinueExecution?: boolean;
  metadataCenterSnapshot?: Record<string, unknown>;
}

export interface NativeReqProcessToolGovernanceOutput {
  processedRequest: Record<string, unknown>;
  metadata: Record<string, unknown>;
  nodeResult: Record<string, unknown>;
}

function nativeFn(name: string): (...args: unknown[]) => unknown {
  const fn = nativeBinding[name];
  if (typeof fn !== 'function') {
    throw new Error(`${name} native export is required`);
  }
  return fn as (...args: unknown[]) => unknown;
}

function parseNativeJson<T>(raw: unknown, capability: string): T {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`${capability} returned invalid payload`);
  }
  return JSON.parse(raw) as T;
}

export function applyReqProcessToolGovernanceDirectNative(
  input: NativeReqProcessToolGovernanceInput
): NativeReqProcessToolGovernanceOutput {
  return parseNativeJson<NativeReqProcessToolGovernanceOutput>(
    nativeFn('applyReqProcessToolGovernanceJson')(JSON.stringify(input)),
    'applyReqProcessToolGovernanceJson'
  );
}
