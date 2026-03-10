type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

type Direction = 'request' | 'response';
type Stage = 'inbound' | 'outbound';

type ProviderType = 'openai' | 'anthropic' | 'responses' | 'gemini';

export interface AdapterOptions {
  baseDir?: string;
  processMode?: 'passthrough' | 'chat' | string;
  providerProtocol?: string;
  providerType?: ProviderType;
  entryEndpoint?: string;
  direction?: Direction;
  stage?: Stage;
}

interface BridgeContext {
  requestId: string;
  endpoint: string;
  entryEndpoint: string;
  metadata: JsonObject;
}

interface ConversionEnvelope {
  id: string;
  timestamp: number;
  endpoint: string;
  payload: JsonValue;
  metadata: JsonObject;
  options: {
    providerProtocol: string;
    providerType: ProviderType;
    processMode?: string;
    streamingFormat: 'sse' | 'json';
    stage?: Stage;
    direction?: Direction;
  };
}

const DEFAULT_ENDPOINT = '/v1/chat/completions';
function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asJsonObject(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function readString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

function normalizeEndpoint(candidate?: string): string {
  if (candidate && candidate.trim()) {
    return candidate.trim();
  }
  return DEFAULT_ENDPOINT;
}

function inferProviderType(protocol?: string): ProviderType {
  const value = (protocol ?? '').toLowerCase();
  if (value.includes('anthropic')) {
    return 'anthropic';
  }
  if (value.includes('responses')) {
    return 'responses';
  }
  if (value.includes('gemini')) {
    return 'gemini';
  }
  return 'openai';
}

function buildContext(input: JsonObject | undefined): BridgeContext {
  const envelope = input ?? {};
  const route = asJsonObject(envelope.route);
  const metadata = { ...(asJsonObject(envelope.metadata) ?? {}) };
  const rootEntry = readString(envelope.entryEndpoint);
  const routeId = readString(route?.requestId);

  const dataWrapper = asJsonObject(envelope.data);
  const dataEntry = readString(dataWrapper?.entryEndpoint);
  const dataMeta = asJsonObject(dataWrapper?.metadata);
  const metaEntry = readString(metadata.entryEndpoint);
  const metaEndpoint = readString(metadata.endpoint);
  const dataMetaEntry = readString(dataMeta?.entryEndpoint);

  const endpoint =
    metaEndpoint ??
    metaEntry ??
    dataMetaEntry ??
    dataEntry ??
    rootEntry ??
    DEFAULT_ENDPOINT;

  const entryEndpoint =
    metaEntry ??
    dataEntry ??
    dataMetaEntry ??
    rootEntry ??
    endpoint;

  const requestId = routeId ?? readString(metadata.requestId) ?? generateRequestId();

  metadata.requestId = requestId;
  metadata.endpoint = endpoint;
  metadata.entryEndpoint = entryEndpoint;

  return {
    requestId,
    endpoint: normalizeEndpoint(endpoint),
    entryEndpoint: normalizeEndpoint(entryEndpoint),
    metadata
  };
}

function extractPayload(subject: JsonObject | undefined): JsonValue {
  if (!subject) {
    return {};
  }
  if ('data' in subject && subject.data !== undefined) {
    return subject.data as JsonValue;
  }
  if ('payload' in subject && subject.payload !== undefined) {
    return subject.payload as JsonValue;
  }
  return subject;
}

function buildConversionEnvelope(
  payload: JsonValue,
  ctx: BridgeContext,
  options?: AdapterOptions,
  overrides?: {
    endpoint?: string;
    metadata?: JsonObject;
    stage?: Stage;
    direction?: Direction;
  }
): ConversionEnvelope {
  const endpoint = normalizeEndpoint(
    overrides?.endpoint ??
      options?.entryEndpoint ??
      ctx.entryEndpoint ??
      ctx.endpoint
  );
  const metadata: JsonObject = { ...ctx.metadata };
  metadata.entryEndpoint = ctx.entryEndpoint || endpoint;
  if (options?.processMode) {
    metadata.processMode = options.processMode;
  }
  if (overrides?.metadata) {
    Object.assign(metadata, overrides.metadata);
  }

  const providerProtocol = options?.providerProtocol ?? 'openai-chat';
  const providerType = options?.providerType ?? inferProviderType(providerProtocol);

  const streamSetting = metadata.stream;
  const streamingFormat: 'sse' | 'json' =
    streamSetting === true ? 'sse' : 'json';

  return {
    id: ctx.requestId || generateRequestId(),
    timestamp: Date.now(),
    endpoint,
    payload,
    metadata,
    options: {
      providerProtocol,
      providerType,
      processMode: options?.processMode,
      streamingFormat,
      stage: overrides?.stage ?? options?.stage,
      direction: overrides?.direction ?? options?.direction
    }
  };
}

function prepareReturnPayload(envelope: ConversionEnvelope) {
  return {
    data: envelope.payload,
    metadata: {
      ...envelope.metadata,
      conversionId: envelope.id,
      conversionEndpoint: envelope.endpoint,
      conversionStage: envelope.options.stage
    }
  };
}

class CoreAdapter {
  private options?: AdapterOptions;
  private readonly lastRequests = new Map<string, JsonValue>();

  constructor(opts?: AdapterOptions) {
    this.options = opts;
  }

  private mergeOptions(opts?: AdapterOptions): void {
    if (opts) {
      this.options = { ...(this.options ?? {}), ...opts };
    }
  }

  async processInboundRequest(request: JsonObject, opts?: AdapterOptions) {
    this.mergeOptions(opts);
    const ctx = buildContext(request);
    const body = extractPayload(request);
    const entryEndpoint = opts?.entryEndpoint ?? ctx.entryEndpoint ?? ctx.endpoint;
    const result = prepareReturnPayload(
      buildConversionEnvelope(
        body,
        ctx,
        { ...this.options, stage: 'inbound', direction: 'request' },
        {
          metadata: { direction: 'request' },
          endpoint: entryEndpoint,
          stage: 'inbound',
          direction: 'request'
        }
      )
    );
    this.lastRequests.set(ctx.requestId, body);
    return result;
  }

  async processInboundResponse(response: JsonObject, opts?: AdapterOptions) {
    this.mergeOptions(opts);
    const ctx = buildContext(response);
    const body = extractPayload(response);
    const entryEndpoint = opts?.entryEndpoint ?? ctx.entryEndpoint ?? ctx.endpoint;
    const targetEndpoint = entryEndpoint.includes('#response')
      ? entryEndpoint
      : `${entryEndpoint}#response`;
    return prepareReturnPayload(
      buildConversionEnvelope(
        body,
        ctx,
        { ...this.options, stage: 'inbound', direction: 'response' },
        {
          metadata: { direction: 'response' },
          endpoint: targetEndpoint,
          stage: 'inbound',
          direction: 'response'
        }
      )
    );
  }

  async processOutboundRequest(request: JsonObject, opts?: AdapterOptions) {
    this.mergeOptions(opts);
    const ctx = buildContext(request);
    const body = extractPayload(request);
    const entryEndpoint = opts?.entryEndpoint ?? ctx.entryEndpoint ?? ctx.endpoint;
    return prepareReturnPayload(
      buildConversionEnvelope(
        body,
        ctx,
        { ...this.options, stage: 'outbound', direction: 'request' },
        {
          metadata: { direction: 'request' },
          endpoint: entryEndpoint,
          stage: 'outbound',
          direction: 'request'
        }
      )
    );
  }

  async processOutboundResponse(response: JsonObject, opts?: AdapterOptions) {
    this.mergeOptions(opts);
    const ctx = buildContext(response);
    const body = extractPayload(response);
    const entryEndpoint = opts?.entryEndpoint ?? ctx.entryEndpoint ?? ctx.endpoint;
    const targetEndpoint = entryEndpoint.includes('#response')
      ? entryEndpoint
      : `${entryEndpoint}#response`;
    const result = prepareReturnPayload(
      buildConversionEnvelope(
        body,
        ctx,
        { ...this.options, stage: 'outbound', direction: 'response' },
        {
          endpoint: targetEndpoint,
          metadata: {
            direction: 'response',
            originalRequest: this.lastRequests.get(ctx.requestId) ?? {}
          },
          stage: 'outbound',
          direction: 'response'
        }
      )
    );
    return result;
  }

  async processIncoming(request: JsonObject, opts?: AdapterOptions) {
    return this.processInboundRequest(request, opts);
  }

  async processOutgoing(response: JsonObject, opts?: AdapterOptions) {
    const dto = await this.processOutboundResponse(response, opts);
    return dto;
  }
}

const singleton = new CoreAdapter();

export async function processIncoming(request: JsonObject, options?: AdapterOptions) {
  return singleton.processIncoming(request, options);
}

export async function processOutgoing(response: JsonObject, options?: AdapterOptions) {
  return singleton.processOutgoing(response, options);
}

export async function processInboundRequest(request: JsonObject, options?: AdapterOptions) {
  return singleton.processInboundRequest(request, options);
}

export async function processInboundResponse(response: JsonObject, options?: AdapterOptions) {
  return singleton.processInboundResponse(response, options);
}

export async function processOutboundRequest(request: JsonObject, options?: AdapterOptions) {
  return singleton.processOutboundRequest(request, options);
}

export async function processOutboundResponse(response: JsonObject, options?: AdapterOptions) {
  const dto = await singleton.processOutboundResponse(response, options);
  return dto;
}

export default {
  processIncoming,
  processOutgoing,
  processInboundRequest,
  processInboundResponse,
  processOutboundRequest,
  processOutboundResponse
};
