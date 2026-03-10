import type { JsonObject } from '../../hub/types/json.js';
import type { CanonicalChatRequest, CanonicalChatResponse } from '../schema/index.js';
import type { ConversionMetaBag, ConversionMetaRecord } from '../meta/meta-bag.js';

export interface ProtocolPipelineContext {
  requestId?: string;
  entryEndpoint?: string;
  profileId?: string;
  providerProtocol?: string;
  targetProtocol?: string;
  stream?: boolean;
  metadata?: Record<string, unknown>;
}

export interface InboundHookArgs<TWire = JsonObject> {
  wire: TWire;
  meta: ConversionMetaBag;
  context: ProtocolPipelineContext;
}

export interface CanonicalHookArgs<TCanonical> {
  canonical: TCanonical;
  meta: ConversionMetaBag;
  context: ProtocolPipelineContext;
}

export interface OutboundWireHookArgs<TWire = JsonObject> {
  wire: TWire;
  meta: ConversionMetaBag;
  context: ProtocolPipelineContext;
}

export interface CanonicalParseResult<TCanonical> {
  canonical: TCanonical;
  meta?: ConversionMetaRecord;
}

export type ProtocolParserHook<TWire, TCanonical> = (
  args: InboundHookArgs<TWire>
) => Promise<CanonicalParseResult<TCanonical>> | CanonicalParseResult<TCanonical>;

export type ProtocolCleanupHook<TCanonical> = (
  args: CanonicalHookArgs<TCanonical>
) => Promise<void> | void;

export interface ProtocolSerializationResult<TWire> {
  payload: TWire;
  meta?: ConversionMetaRecord;
}

export type ProtocolSerializerHook<TCanonical, TWire> = (
  args: CanonicalHookArgs<TCanonical>
) => Promise<ProtocolSerializationResult<TWire>> | ProtocolSerializationResult<TWire>;

export type ProtocolAugmentationHook<TCanonical> = (
  args: CanonicalHookArgs<TCanonical>
) => Promise<void> | void;

export interface ProtocolValidationErrorDetail {
  path?: string;
  message: string;
  code?: string;
}

export interface ProtocolValidationResult {
  ok: boolean;
  errors?: ProtocolValidationErrorDetail[];
}

export type ProtocolValidationHook<TArgs> = (
  args: TArgs
) => Promise<void | ProtocolValidationResult> | void | ProtocolValidationResult;

export type InboundValidationHook<TWire> = ProtocolValidationHook<InboundHookArgs<TWire>>;
export type OutboundValidationHook<TWire> = ProtocolValidationHook<OutboundWireHookArgs<TWire>>;

export interface ProtocolInboundHooks<
  TInboundWire = JsonObject,
  TCanonical = CanonicalChatRequest
> {
  preValidate?: InboundValidationHook<TInboundWire>;
  parse: ProtocolParserHook<TInboundWire, TCanonical>;
  cleanup?: ProtocolCleanupHook<TCanonical>;
}

export interface ProtocolOutboundHooks<
  TCanonical = CanonicalChatResponse,
  TOutboundWire = JsonObject
> {
  augment?: ProtocolAugmentationHook<TCanonical>;
  serialize: ProtocolSerializerHook<TCanonical, TOutboundWire>;
  postValidate?: OutboundValidationHook<TOutboundWire>;
}

export interface ProtocolPipelineHooks<
  TInboundWire = JsonObject,
  TOutboundWire = JsonObject,
  TCanonicalInbound = CanonicalChatRequest,
  TCanonicalOutbound = CanonicalChatResponse
> {
  id: string;
  protocol: string;
  inbound: ProtocolInboundHooks<TInboundWire, TCanonicalInbound>;
  outbound: ProtocolOutboundHooks<TCanonicalOutbound, TOutboundWire>;
}
