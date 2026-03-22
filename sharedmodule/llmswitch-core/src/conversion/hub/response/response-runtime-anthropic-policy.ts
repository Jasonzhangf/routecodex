import { createBridgeActionState, runBridgeActionPipeline } from '../../bridge-actions.js';
import { resolveBridgePolicy, resolvePolicyActions } from '../../bridge-policies.js';

type BridgeStage = 'response_inbound' | 'response_outbound';

interface AnthropicBridgePolicyOptions {
  stage: BridgeStage;
  message: Record<string, unknown>;
  requestId?: string;
  rawResponse?: Record<string, unknown>;
}

function applyAnthropicBridgePolicy(options: AnthropicBridgePolicyOptions): void {
  try {
    const bridgePolicy = resolveBridgePolicy({ protocol: 'anthropic-messages' });
    const actions = resolvePolicyActions(bridgePolicy, options.stage);
    if (!actions?.length) {
      return;
    }
    const actionState = createBridgeActionState({
      messages: [options.message],
      rawResponse: options.rawResponse
    });
    runBridgeActionPipeline({
      stage: options.stage,
      actions,
      protocol: bridgePolicy?.protocol ?? 'anthropic-messages',
      moduleType: bridgePolicy?.moduleType ?? 'anthropic-messages',
      requestId: options.requestId,
      state: actionState
    });
  } catch {
    // ignore policy failures
  }
}

export function applyAnthropicResponseInboundBridgePolicy(
  message: Record<string, unknown>,
  payload: Record<string, unknown>
): void {
  applyAnthropicBridgePolicy({
    stage: 'response_inbound',
    message,
    requestId: typeof payload.id === 'string' ? payload.id : undefined,
    rawResponse: payload
  });
}

export function applyAnthropicResponseOutboundBridgePolicy(
  message: Record<string, unknown>,
  chatResponse: Record<string, unknown>
): void {
  applyAnthropicBridgePolicy({
    stage: 'response_outbound',
    message,
    requestId: typeof chatResponse.id === 'string' ? chatResponse.id : undefined
  });
}
