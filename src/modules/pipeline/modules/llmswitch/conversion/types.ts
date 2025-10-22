import type { ModuleDependencies } from '../../../interfaces/pipeline-interfaces.js';

export interface ConversionProfileDefinition {
  id: string;
  incomingProtocol: string;
  outgoingProtocol: string;
  codec: string;
  inputSchema?: string;
  canonicalRequestSchema?: string;
  canonicalResponseSchema?: string;
  providerResponseSchema?: string;
  clientResponseSchema?: string;
  trace?: boolean;
  options?: Record<string, unknown>;
}

export interface ConversionConfigFile {
  profiles: Record<string, Omit<ConversionProfileDefinition, 'id'>>;
  endpointBindings?: Record<string, string>;
}

export interface ConversionProfile extends ConversionProfileDefinition {
  id: string;
}

export interface ConversionContext {
  requestId?: string;
  endpoint?: string;
  entryEndpoint?: string;
  targetProtocol?: string;
  stream?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ConversionResult {
  profile: ConversionProfile;
  payload: any;
  metadata?: Record<string, unknown>;
}

export interface ConversionCodec {
  readonly id: string;
  initialize?(): Promise<void>;
  convertRequest(payload: any, profile: ConversionProfile, context: ConversionContext): Promise<any>;
  convertResponse(payload: any, profile: ConversionProfile, context: ConversionContext): Promise<any>;
}

export type CodecFactory = (deps: ModuleDependencies) => ConversionCodec;
