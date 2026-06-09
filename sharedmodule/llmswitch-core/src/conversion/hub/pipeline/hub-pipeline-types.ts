import { Readable } from "node:stream";
import type { StandardizedRequest, ProcessedRequest } from "../types/standardized.js";
import type { JsonObject } from "../types/json.js";
import type { StageRecorder } from "../format-adapters/index.js";
import type {
  VirtualRouterConfig,
  RoutingDecision,
  RoutingDiagnostics,
  TargetMetadata,
  VirtualRouterHealthStore,
} from "../../../native/router-hotpath/virtual-router-contracts.js";

type HubPolicyMode = "off" | "observe" | "enforce";

interface HubPolicyConfig {
  mode?: HubPolicyMode;
  sampleRate?: number;
}

type HubShadowCompareRequestConfig = {
  baselineMode: HubPolicyMode;
};

type HubToolSurfaceMode = "off" | "observe" | "shadow" | "enforce";

interface HubToolSurfaceConfig {
  mode: HubToolSurfaceMode;
  sampleRate?: number;
}

export interface HubPipelineConfig {
  virtualRouter: VirtualRouterConfig;
  policy?: HubPolicyConfig;
  toolSurface?: HubToolSurfaceConfig;
  healthStore?: VirtualRouterHealthStore;
  routingStateStore?: {
    loadSync(key: string): unknown;
    saveAsync(key: string, state: unknown): void;
  };
}

interface HubPipelineRequestMetadata extends Record<string, unknown> {
  entryEndpoint?: string;
  providerProtocol?: string;
  processMode?: "chat";
  stage?: "inbound" | "outbound";
  direction?: "request" | "response";
  stream?: boolean;
  routeHint?: string;
}

export interface HubPipelineRequest {
  id?: string;
  endpoint: string;
  payload: Record<string, unknown> | { readable?: Readable } | Readable;
  metadata?: HubPipelineRequestMetadata;
}

type HubPipelineNodeMetadata =
  | {
      node: string;
      executionTime: number;
      startTime: number;
      endTime: number;
    }
  | Record<string, unknown>;

export interface HubPipelineNodeResult {
  id: string;
  success: boolean;
  metadata: HubPipelineNodeMetadata;
  error?: JsonObject;
}

export interface HubPipelineResult {
  requestId: string;
  providerPayload?: Record<string, unknown>;
  standardizedRequest?: StandardizedRequest;
  entryOriginRequest?: Record<string, unknown>;
  processedRequest?: ProcessedRequest;
  routingDecision?: RoutingDecision;
  routingDiagnostics?: RoutingDiagnostics;
  target?: TargetMetadata;
  metadata: Record<string, unknown>;
  nodeResults: HubPipelineNodeResult[];
}

export type ProviderProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "gemini-chat";

export interface NormalizedRequest {
  id: string;
  endpoint: string;
  entryEndpoint: string;
  providerProtocol: ProviderProtocol;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  policyOverride?: HubPolicyConfig;
  shadowCompare?: HubShadowCompareRequestConfig;
  disableSnapshots?: boolean;
  externalStageRecorder?: StageRecorder;
  processMode: "chat";
  direction: "request" | "response";
  stage: "inbound" | "outbound";
  stream: boolean;
  routeHint?: string;
  hubEntryMode?: "chat_process";
}
