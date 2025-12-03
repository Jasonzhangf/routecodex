import type { CompatAdapter } from '../provider-composite.js';

export const anthropicCompat: CompatAdapter<'anthropic-messages'> = {
  protocol: 'anthropic-messages',
  request: (b) => b,
  response: (r) => r
};

export default anthropicCompat;

