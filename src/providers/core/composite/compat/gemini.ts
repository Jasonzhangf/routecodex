import type { CompatAdapter } from '../provider-composite.js';

export const geminiCompat: CompatAdapter<'gemini-chat'> = {
  protocol: 'gemini-chat',
  request: (b) => b,
  response: (r) => r
};

export default geminiCompat;

