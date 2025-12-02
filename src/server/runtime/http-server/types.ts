import type { Readable } from 'node:stream';
import type { PipelineExecutionInput, PipelineExecutionResult } from '../../handlers/types.js';
import type { ProviderRuntimeProfile } from '../../../modules/pipeline/modules/provider/v2/api/provider-types.js';

export interface ServerConfigV2 {
  server: {
    port: number;
    host: string;
    timeout?: number;
    useV2?: boolean;
  };
  pipeline?: {
    useHubPipeline?: boolean;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    enableConsole?: boolean;
    enableFile?: boolean;
    filePath?: string;
  };
  providers: Record<string, unknown>;
  v2Config?: {
    enableHooks?: boolean;
    hookStages?: string[];
  };
}

export interface ServerStatusV2 {
  initialized: boolean;
  running: boolean;
  port: number;
  host: string;
  uptime: number;
  memory: NodeJS.MemoryUsage;
  version: 'v2';
}

export interface RequestContextV2 {
  requestId: string;
  timestamp: number;
  method: string;
  url: string;
  userAgent?: string;
  ip?: string;
  endpoint: string;
}

export type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat';

export interface ProviderHandle {
  runtimeKey: string;
  providerId: string;
  providerType: string;
  providerProtocol: ProviderProtocol;
  runtime: ProviderRuntimeProfile;
  instance: {
    initialize(): Promise<void>;
    cleanup(): Promise<void>;
    processIncoming(payload: Record<string, unknown>): Promise<unknown>;
  };
}

export type SuperPipelineExecuteResult = PipelineExecutionResult & {
  providerPayload?: Record<string, unknown>;
  target?: {
    providerKey: string;
    runtimeKey?: string;
    providerType: string;
    outboundProfile: string;
    compatibilityProfile?: string;
    defaultModel?: string;
  };
  routingDecision?: { routeName?: string };
};

export interface SuperPipeline {
  execute(request: PipelineExecutionInput & { payload: unknown }): Promise<SuperPipelineExecuteResult>;
  updateVirtualRouterConfig(config: unknown): void;
  getProviderRuntimeMap(): Record<string, ProviderRuntimeProfile>;
}

export type SuperPipelineCtor = new (config: { virtualRouter: unknown }) => SuperPipeline;

export interface VirtualRouterArtifacts {
  config: unknown;
  targetRuntime?: Record<string, ProviderRuntimeProfile>;
}

export interface HubPipelineExecutionResult {
  providerPayload?: Record<string, unknown>;
  target?: {
    providerKey: string;
    providerType: string;
    outboundProfile: string;
    runtimeKey?: string;
    processMode?: string;
  };
  routingDecision?: { routeName?: string };
  metadata: Record<string, unknown>;
}

export interface HubPipeline {
  execute(
    request: PipelineExecutionInput & { payload: Record<string, unknown> | { readable?: Readable } | Readable }
  ): Promise<HubPipelineExecutionResult>;
  updateVirtualRouterConfig(config: unknown): void;
}

export type HubPipelineCtor = new (config: { virtualRouter: unknown }) => HubPipeline;
