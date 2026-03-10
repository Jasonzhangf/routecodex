import { buildProviderProtocolErrorWithNative } from '../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

export type ProviderProtocolErrorCode =
  | 'TOOL_PROTOCOL_ERROR'
  | 'SSE_DECODE_ERROR'
  | 'HTTP_502'
  | 'MALFORMED_RESPONSE'
  | 'MALFORMED_REQUEST'
  | 'SERVERTOOL_FOLLOWUP_FAILED'
  | 'SERVERTOOL_EMPTY_FOLLOWUP'
  | 'SERVERTOOL_TIMEOUT'
  | 'SERVERTOOL_HANDLER_FAILED';

export type ProviderErrorCategory = 'EXTERNAL_ERROR' | 'TOOL_ERROR' | 'INTERNAL_ERROR';

export interface ProviderProtocolErrorOptions {
  code: ProviderProtocolErrorCode;
  protocol?: string;
  providerType?: string;
  category?: ProviderErrorCategory;
  details?: Record<string, unknown>;
}

export class ProviderProtocolError extends Error {
  readonly code: ProviderProtocolErrorCode;
  readonly protocol?: string;
  readonly providerType?: string;
  readonly category: ProviderErrorCategory;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: ProviderProtocolErrorOptions) {
    super(message);
    this.name = 'ProviderProtocolError';
    const native = buildProviderProtocolErrorWithNative({
      message,
      code: options.code,
      protocol: options.protocol,
      providerType: options.providerType,
      category: options.category,
      details: options.details
    });
    this.code = options.code;
    this.protocol = typeof native.protocol === 'string' ? native.protocol : options.protocol;
    this.providerType = typeof native.providerType === 'string' ? native.providerType : options.providerType;
    this.category = (native.category as ProviderErrorCategory) || options.category || 'EXTERNAL_ERROR';
    this.details = (native.details as Record<string, unknown> | undefined) ?? options.details;
  }
}
