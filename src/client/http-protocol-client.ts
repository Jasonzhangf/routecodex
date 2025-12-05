import type { UnknownObject } from '../types/common-types.js';

export type ProtocolRequestPayload = UnknownObject;

export interface HttpProtocolClient<TPayload extends ProtocolRequestPayload = ProtocolRequestPayload> {
  buildRequestBody(request: TPayload): Record<string, unknown>;
  resolveEndpoint(request: TPayload, defaultEndpoint: string): string;
  finalizeHeaders(
    headers: Record<string, string>,
    request: TPayload
  ): Promise<Record<string, string>> | Record<string, string>;
}
