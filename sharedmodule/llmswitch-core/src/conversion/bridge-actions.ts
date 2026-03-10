import {
  runBridgeActionPipelineWithNative,
  type NativeBridgeActionState
} from '../router/virtual-router/engine-selection/native-hub-bridge-action-semantics.js';

type UnknownRecord = Record<string, unknown>;

export type BridgeActionStage =
  | 'request_inbound'
  | 'request_outbound'
  | 'response_inbound'
  | 'response_outbound';

export interface BridgeActionDescriptor {
  name: string;
  options?: Record<string, unknown>;
}

export interface BridgeActionState {
  messages: Array<UnknownRecord>;
  requiredAction?: UnknownRecord;
  capturedToolResults?: Array<{ tool_call_id?: string; call_id?: string; output?: unknown; name?: string }>;
  rawRequest?: UnknownRecord;
  rawResponse?: UnknownRecord;
  metadata?: Record<string, unknown>;
}

export interface BridgeActionContext {
  stage: BridgeActionStage;
  protocol?: string;
  moduleType?: string;
  requestId?: string;
  descriptor: BridgeActionDescriptor;
  state: BridgeActionState;
}

export type BridgeAction = (context: BridgeActionContext) => void;

const registry = new Map<string, BridgeAction>();

export function registerBridgeAction(name: string, action: BridgeAction): void {
  registry.set(name, action);
}

export function createBridgeActionState(seed?: Partial<BridgeActionState>): BridgeActionState {
  const state: BridgeActionState = {
    messages: Array.isArray(seed?.messages) ? (seed.messages as Array<UnknownRecord>) : []
  };
  if (seed?.requiredAction) state.requiredAction = seed.requiredAction;
  if (seed?.capturedToolResults) state.capturedToolResults = seed.capturedToolResults;
  if (seed?.rawRequest) state.rawRequest = seed.rawRequest;
  if (seed?.rawResponse) state.rawResponse = seed.rawResponse;
  if (seed?.metadata) state.metadata = seed.metadata;
  return state;
}

export function runBridgeActionPipeline(options: {
  stage: BridgeActionStage;
  actions?: BridgeActionDescriptor[];
  protocol?: string;
  moduleType?: string;
  requestId?: string;
  state: BridgeActionState;
}): void {
  const { stage, actions, protocol, moduleType, requestId, state } = options;
  if (!actions?.length) return;

  const output: NativeBridgeActionState | null = runBridgeActionPipelineWithNative({
    stage,
    actions: actions.map((entry) => ({
      name: entry.name,
      options: entry.options
    })),
    protocol,
    moduleType,
    requestId,
    state: state as unknown as NativeBridgeActionState
  });

  if (!output) {
    return;
  }
  if (output && typeof output === 'object') {
    const next = output as NativeBridgeActionState;
    const patch: BridgeActionState = {
      messages: Array.isArray(next.messages) ? (next.messages as Array<UnknownRecord>) : state.messages,
      ...(next.requiredAction && typeof next.requiredAction === 'object' && !Array.isArray(next.requiredAction)
        ? { requiredAction: next.requiredAction as UnknownRecord }
        : {}),
      ...(Array.isArray(next.capturedToolResults)
        ? { capturedToolResults: next.capturedToolResults as BridgeActionState['capturedToolResults'] }
        : {}),
      ...(next.rawRequest && typeof next.rawRequest === 'object' && !Array.isArray(next.rawRequest)
        ? { rawRequest: next.rawRequest as UnknownRecord }
        : {}),
      ...(next.rawResponse && typeof next.rawResponse === 'object' && !Array.isArray(next.rawResponse)
        ? { rawResponse: next.rawResponse as UnknownRecord }
        : {}),
      ...(next.metadata && typeof next.metadata === 'object' && !Array.isArray(next.metadata)
        ? { metadata: next.metadata as UnknownRecord }
        : {})
    };
    Object.assign(state, patch);
  }

  for (const descriptor of actions) {
    if (!descriptor || typeof descriptor !== 'object') continue;
    const action = registry.get(descriptor.name);
    if (!action) continue;
    try {
      action({
        stage,
        protocol,
        moduleType,
        requestId,
        descriptor,
        state
      });
    } catch {
      // Ignore action failures to preserve core flow; telemetry hooks can be added later.
    }
  }
}
