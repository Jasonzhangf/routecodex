import type { Readable } from 'node:stream';
import type { PipelineExecutionInput } from '../../handlers/types.js';
import type { ProviderRuntimeProfile } from '../../../providers/core/api/provider-types.js';

export interface ServerConfigV2 {
  server: {
    port: number;
    host: string;
    timeout?: number;
    useV2?: boolean;
  };
  pipeline?: {
    useHubPipeline?: boolean; // legacy flag (hub is always enabled)
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

export type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat' | 'gemini-cli-chat';

export interface ProviderHandle {
  runtimeKey: string;
  providerId: string;
  providerType: string;
  providerFamily: string;
  providerProtocol: ProviderProtocol;
  runtime: ProviderRuntimeProfile;
  instance: {
    initialize(): Promise<void>;
    cleanup(): Promise<void>;
    processIncoming(payload: Record<string, unknown>): Promise<unknown>;
  };
}

export interface VirtualRouterArtifacts {
  config: unknown;
  targetRuntime?: Record<string, ProviderRuntimeProfile>;
}

export interface HubPipelineExecutionResult {
  requestId?: string;
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

export type HubPipelineCtor = new (config: { virtualRouter: unknown; [key: string]: unknown }) => HubPipeline;
