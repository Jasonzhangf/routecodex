import { BridgeAction, registerBridgeAction } from '../../bridge-actions.js';
import { ensureMessagesArray } from '../../bridge-message-utils.js';
import { validateToolCall } from '../../../tools/tool-registry.js';

const fixApplyPatchAction: BridgeAction = (ctx) => {
  const messages = ensureMessagesArray(ctx.state);
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    if (!Array.isArray(message.tool_calls)) continue;

    for (const toolCall of message.tool_calls) {
      if (toolCall.type !== 'function') continue;
      const fn = toolCall.function;
      if (!fn || fn.name !== 'apply_patch') continue;

      const rawArgs = fn.arguments;
      if (typeof rawArgs !== 'string') continue;

      const validation = validateToolCall('apply_patch', rawArgs);
      if (validation?.ok && typeof validation.normalizedArgs === 'string') {
        if (validation.normalizedArgs !== rawArgs) {
          fn.arguments = validation.normalizedArgs;
          (toolCall as any)._fixed_apply_patch = true;
        }
      }
    }
  }
};

registerBridgeAction('compat.fix-apply-patch', fixApplyPatchAction);
