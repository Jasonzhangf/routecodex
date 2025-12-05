import type { ModuleDependencies } from '../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { ProviderRuntimeProfile } from '../providers/core/api/provider-types.js';
import type { ProviderRuntimeMetadata } from '../providers/core/runtime/provider-runtime-metadata.js';
import type { TargetMetadata } from '../modules/pipeline/orchestrator/pipeline-context.js';

export type DebugSessionMode = 'capture' | 'replay';

export interface DebugSession {
  id: string;
  mode: DebugSessionMode;
  label?: string;
  createdAt: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export type DebugNodeDirection = 'request' | 'response';

export interface NodeSnapshot {
  sessionId: string;
  nodeId: string;
  direction: DebugNodeDirection;
  stage?: string;
  payload: unknown;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface SnapshotQuery {
  nodeId?: string;
  direction?: DebugNodeDirection;
  limit?: number;
}

export interface SnapshotStore {
  save(snapshot: NodeSnapshot): Promise<void>;
  fetch(sessionId: string, query?: SnapshotQuery): Promise<NodeSnapshot[]>;
  clear(sessionId: string): Promise<void>;
  listSessions(): Promise<string[]>;
}

export interface HarnessExecuteContext {
  sessionId?: string;
  snapshotLabel?: string;
}

export interface ExecutionHarness<TInput = unknown, TResult = unknown> {
  readonly id: string;
  readonly description?: string;
  executeForward(input: TInput, context?: HarnessExecuteContext): Promise<TResult>;
  executeBackward?(output: TResult, context?: HarnessExecuteContext): Promise<TInput>;
}

export type ProviderHarnessRuntime = ProviderRuntimeProfile & Record<string, unknown>;

export interface ProviderHarnessMetadata extends ProviderRuntimeMetadata {
  requestId: string;
  providerId: string;
  providerKey: string;
  providerType: string;
  providerProtocol: string;
  routeName: string;
  target: TargetMetadata;
  runtime?: ProviderHarnessRuntime;
}

export interface ProviderHarnessExecuteInput {
  runtime: ProviderHarnessRuntime;
  request: Record<string, unknown>;
  metadata: ProviderHarnessMetadata;
  action?: 'preprocess' | 'postprocess';
  dependencies?: ModuleDependencies;
}

export interface ProviderHarnessResult {
  payload: unknown;
  context?: Record<string, unknown>;
}

export interface ProviderDryRunOptions {
  runtime: ProviderHarnessRuntime;
  request: Record<string, unknown>;
  metadata: ProviderHarnessMetadata;
  sessionId?: string;
  nodeId?: string;
}

export interface ProviderDryRunResult {
  processed: unknown;
  metadata: ProviderHarnessMetadata;
}
