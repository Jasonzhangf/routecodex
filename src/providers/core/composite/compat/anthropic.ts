import type { CompatAdapter } from '../provider-composite.js';
import type { UnknownObject } from '../../../../types/common-types.js';

export const anthropicCompat: CompatAdapter<'anthropic-messages'> = {
  protocol: 'anthropic-messages',
  request: async (body: UnknownObject) => body,
  response: async (response) => response
};

export default anthropicCompat;
