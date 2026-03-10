import type { NativeReqInboundSemanticLiftApplyInput } from '../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

export type BridgeContentPart = {
  type: string;
  text?: string;
  content?: unknown;
};

export type BridgeInputItem = {
  type: string;
  role?: string;
  content?: Array<BridgeContentPart> | null;
  name?: string;
  arguments?: unknown;
  call_id?: string;
  output?: unknown;
  function?: { name?: string; arguments?: unknown };
  message?: { role?: string; content?: Array<BridgeContentPart> };
  id?: string;
  tool_call_id?: string;
  tool_use_id?: string;
  text?: string;
};

export type BridgeToolDefinition = {
  type: string;
  name?: string;
  description?: string;
  strict?: boolean;
  parameters?: unknown;
  function?: {
    name?: string;
    description?: string;
    strict?: boolean;
    parameters?: unknown;
  };
};

export type BridgeNativeEnvelope = NativeReqInboundSemanticLiftApplyInput['chatEnvelope'];
