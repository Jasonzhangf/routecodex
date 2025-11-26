import type { CompatAdapter } from '../provider-composite.js';

export const responsesCompat: CompatAdapter<'openai-responses'> = {
  protocol: 'openai-responses',
  request: (b) => b,
  response: (r) => r
};

export default responsesCompat;

