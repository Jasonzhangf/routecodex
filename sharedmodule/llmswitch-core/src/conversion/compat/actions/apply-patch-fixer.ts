import { BridgeAction, registerBridgeAction } from '../../bridge-actions.js';
import { fixApplyPatchToolCallsWithNative } from '../../../router/virtual-router/engine-selection/native-compat-action-semantics.js';

const fixApplyPatchAction: BridgeAction = (ctx) => {
  const state = ctx.state as unknown as {
    messages?: Array<Record<string, unknown>>;
    input?: Array<Record<string, unknown>>;
  };
  const messages = Array.isArray(state.messages) ? state.messages : [];
  if (!Array.isArray(state.messages)) {
    state.messages = messages;
  }
  const input = Array.isArray(state.input) ? state.input : undefined;
  const fixed = fixApplyPatchToolCallsWithNative({
    messages,
    ...(input ? { input } : {})
  });
  state.messages = fixed.messages;
  if (Array.isArray(fixed.input)) {
    state.input = fixed.input;
  }
};

registerBridgeAction('compat.fix-apply-patch', fixApplyPatchAction);
