export type ProtocolType = 'openai' | 'anthropic' | 'unknown';

export interface MonitorMeta {
  reqId: string;
  timestamp: number;
  protocol: ProtocolType;
  endpoint: string;
  userAgent?: string;
  remoteAddr?: string;
  entryProtocol?: ProtocolType;
  outputProtocol?: ProtocolType;
  flags?: { streaming?: boolean; tools?: boolean; vision?: boolean };
  routing?: {
    route?: string;
    pipelineId?: string;
    providerType?: string;
    targets?: string[];
    confidence?: number;
    factors?: Record<string, unknown>;
    alternativeRoutes?: Array<{ route: string; confidence?: number; reasoning?: string }>;
  };
  provider?: { vendor?: string; model?: string; baseUrl?: string };
  storage?: { path: string; hasStream?: boolean; sizeBytes?: number };
  redaction?: { authMasked?: boolean; contentMasked?: boolean };
}

export interface MonitorRequestRecord<T = unknown> {
  meta: MonitorMeta;
  request: T;
  summary?: Record<string, unknown>;
}

export interface MonitorResponseRecord<T = unknown> {
  meta: MonitorMeta;
  response: T;
}

export interface StreamEventRecord {
  type: string;
  data: unknown;
  at: number;
}

