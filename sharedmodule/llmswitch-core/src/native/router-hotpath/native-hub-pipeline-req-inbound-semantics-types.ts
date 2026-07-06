export type {
  NativeContextToolOutput
} from './native-hub-pipeline-inbound-outbound-semantics.js';

export type NativeProviderProtocolToken = string;

export interface NativeReqInboundChatToStandardizedInput {
  chatEnvelope: Record<string, unknown>;
  adapterContext: Record<string, unknown>;
  endpoint: string;
  requestId?: string;
}
