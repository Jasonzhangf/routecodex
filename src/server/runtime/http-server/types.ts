import type { ProviderRuntimeProfile } from '../../../providers/core/api/provider-types.js';
import type { PortConfig } from './port-config-types.js';

export interface ServerConfigV2 {
  /**
   * The config file path used to bootstrap this server instance.
   * When present, daemon-admin restart should reload from the same file.
   */
  configPath?: string;
  server: {
    port: number;
    host: string;
    apikey?: string;
    timeout?: number;
    bodyLimit?: string;
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
  /**
   * Multi-port configuration.
   * When present, the server manages multiple listeners independently.
   * Each port can be either 'router' (full routing) or 'provider' (direct binding).
   * Backward compat: if absent, httpserver.port is used as a single router-mode port.
   */
  ports?: PortConfig[];
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
  providerFamily: string;
  providerProtocol: ProviderProtocol;
  runtime: ProviderRuntimeProfile;
  instance: {
    initialize(): Promise<void>;
    cleanup(): Promise<void>;
    processIncoming(payload: Record<string, unknown>): Promise<unknown>;
    processIncomingDirect?(payload: Record<string, unknown>): Promise<unknown>;
  };
}

export interface VirtualRouterArtifacts {
  config: unknown;
  runtime?: Record<string, ProviderRuntimeProfile>;
  targetRuntime?: Record<string, ProviderRuntimeProfile>;
}

export interface HubPipelineExecutionResult {
  requestId?: string;
  providerPayload?: Record<string, unknown>;
  standardizedRequest?: Record<string, unknown>;
  processedRequest?: Record<string, unknown>;
  target?: {
    providerKey: string;
    providerType: string;
    outboundProfile: string;
    runtimeKey?: string;
    concurrencyScopeKey?: string;
    processMode?: string;
    compatibilityProfile?: string;
  };
  routingDecision?: { routeName?: string; [key: string]: unknown };
  routingDiagnostics?: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export type { HubPipelineHandle } from './hub-pipeline-handle.js';

// HubPipelineConfig replaced by Record<string,unknown> - config goes directly via NAPI
export type HubPipelineConfig = Record<string, unknown>;
