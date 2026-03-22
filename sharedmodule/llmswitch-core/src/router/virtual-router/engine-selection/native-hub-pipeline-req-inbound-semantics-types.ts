export type {
  NativeContextToolOutput,
  NativeResumeToolOutput
} from './native-hub-pipeline-inbound-outbound-semantics.js';

export interface NativeReqInboundSemanticLiftApplyInput {
  chatEnvelope: Record<string, unknown>;
  payload?: Record<string, unknown>;
  protocol?: string;
  entryEndpoint?: string;
  responsesResume?: Record<string, unknown>;
}
export type NativeProviderProtocolToken =
  NonNullable<NativeReqInboundSemanticLiftApplyInput['protocol']>;

export interface NativeReqInboundChatToStandardizedInput {
  chatEnvelope: Record<string, unknown>;
  adapterContext: Record<string, unknown>;
  endpoint: string;
  requestId?: string;
}

export interface NativeReqInboundReasoningNormalizeInput {
  payload: Record<string, unknown>;
  protocol: string;
}
