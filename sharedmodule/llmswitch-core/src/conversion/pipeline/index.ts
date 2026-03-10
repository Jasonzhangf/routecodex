import {
  type CanonicalChatRequest,
  type CanonicalChatResponse
} from './schema/index.js';
import {
  type ProtocolPipelineHooks,
  type ProtocolPipelineContext,
  type ProtocolValidationErrorDetail,
  type ProtocolValidationHook
} from './hooks/protocol-hooks.js';
import { ConversionMetaBag, type ConversionMetaInput } from './meta/meta-bag.js';

export interface ProtocolInboundPipelineOptions<TWire> {
  payload: TWire;
  context?: ProtocolPipelineContext;
  meta?: ConversionMetaInput;
}

export interface ProtocolOutboundPipelineOptions<TCanonical> {
  canonical: TCanonical;
  context?: ProtocolPipelineContext;
  meta?: ConversionMetaInput;
}

export interface ProtocolInboundPipelineResult<TCanonical> {
  canonical: TCanonical;
  meta: ConversionMetaBag;
  context: ProtocolPipelineContext;
}

export interface ProtocolOutboundPipelineResult<TWire> {
  payload: TWire;
  meta: ConversionMetaBag;
  context: ProtocolPipelineContext;
}

export class PipelineValidationError extends Error {
  readonly stage: string;
  readonly errors: ProtocolValidationErrorDetail[];

  constructor(stage: string, errors: ProtocolValidationErrorDetail[]) {
    super(errors[0]?.message ?? `Validation failed during ${stage}`);
    this.name = 'PipelineValidationError';
    this.stage = stage;
    this.errors = errors;
  }
}

function normalizeContext(
  hooks: ProtocolPipelineHooks<any, any, any, any>,
  ctx?: ProtocolPipelineContext
): ProtocolPipelineContext {
  return {
    profileId: ctx?.profileId ?? hooks.id,
    providerProtocol: ctx?.providerProtocol ?? hooks.protocol,
    targetProtocol: ctx?.targetProtocol ?? ctx?.providerProtocol ?? hooks.protocol,
    entryEndpoint: ctx?.entryEndpoint,
    requestId: ctx?.requestId,
    stream: ctx?.stream,
    metadata: ctx?.metadata ?? {}
  };
}

function ingestMeta(target: ConversionMetaBag, incoming?: ConversionMetaInput): void {
  if (!incoming) {
    return;
  }
  target.ingest(incoming);
}

export class ProtocolConversionPipeline<
  TInboundWire = Record<string, unknown>,
  TOutboundWire = Record<string, unknown>,
  TCanonicalInbound = CanonicalChatRequest,
  TCanonicalOutbound = CanonicalChatResponse
> {
  private readonly hooks: ProtocolPipelineHooks<TInboundWire, TOutboundWire, TCanonicalInbound, TCanonicalOutbound>;

  constructor(hooks: ProtocolPipelineHooks<TInboundWire, TOutboundWire, TCanonicalInbound, TCanonicalOutbound>) {
    if (!hooks?.inbound?.parse) {
      throw new Error('ProtocolConversionPipeline requires an inbound.parse hook');
    }
    if (!hooks?.outbound?.serialize) {
      throw new Error('ProtocolConversionPipeline requires an outbound.serialize hook');
    }
    this.hooks = hooks;
  }

  async convertInbound(
    options: ProtocolInboundPipelineOptions<TInboundWire>
  ): Promise<ProtocolInboundPipelineResult<TCanonicalInbound>> {
    const context = normalizeContext(this.hooks, options.context);
    const meta = new ConversionMetaBag(options.meta);
    await this.runValidation('inbound.preValidate', this.hooks.inbound.preValidate, {
      wire: options.payload,
      meta,
      context
    });
    const parseResult = await this.hooks.inbound.parse({
      wire: options.payload,
      meta,
      context
    });
    ingestMeta(meta, parseResult.meta);
    const canonical = parseResult.canonical;
    if (!canonical) {
      throw new Error('ProtocolConversionPipeline inbound.parse returned an empty canonical payload');
    }
    if (this.hooks.inbound.cleanup) {
      await this.hooks.inbound.cleanup({
        canonical,
        meta,
        context
      });
    }
    return { canonical, meta, context };
  }

  async convertOutbound(
    options: ProtocolOutboundPipelineOptions<TCanonicalOutbound>
  ): Promise<ProtocolOutboundPipelineResult<TOutboundWire>> {
    const context = normalizeContext(this.hooks, options.context);
    const meta = new ConversionMetaBag(options.meta);
    if (this.hooks.outbound.augment) {
      await this.hooks.outbound.augment({
        canonical: options.canonical,
        meta,
        context
      });
    }
    const serialized = await this.hooks.outbound.serialize({
      canonical: options.canonical,
      meta,
      context
    });
    ingestMeta(meta, serialized.meta);
    await this.runValidation('outbound.postValidate', this.hooks.outbound.postValidate, {
      wire: serialized.payload,
      meta,
      context
    });
    return { payload: serialized.payload, meta, context };
  }

  private async runValidation<TArgs>(
    stage: string,
    hook: ProtocolValidationHook<TArgs> | undefined,
    args: TArgs
  ): Promise<void> {
    if (!hook) {
      return;
    }
    const result = await hook(args);
    if (!result) {
      return;
    }
    const errors = result.errors ?? [];
    if (result.ok === false || errors.length > 0) {
      throw new PipelineValidationError(stage, errors.length ? errors : [{ message: 'Unknown validation error' }]);
    }
  }
}
