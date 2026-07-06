export interface ConversionProfile {
  id: string;
  incomingProtocol: string;
  outgoingProtocol: string;
  codec: string;
  inputSchema?: string;
  canonicalRequestSchema?: string;
  canonicalResponseSchema?: string;
  clientResponseSchema?: string;
  trace?: boolean;
}

export interface ConversionContext {
  requestId?: string;
  endpoint?: string;
  entryEndpoint?: string;
  targetProtocol?: string;
  stream?: boolean;
  metadata?: Record<string, unknown>;
}

interface ConversionResult {
  profile: ConversionProfile;
  payload: any;
}

export interface ConversionCodec {
  readonly id: string;
  initialize(): Promise<void>;
  convertRequest(payload: any, profile: ConversionProfile, context: ConversionContext): Promise<any>;
  convertResponse(payload: any, profile: ConversionProfile, context: ConversionContext): Promise<any>;
}
