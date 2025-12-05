import type { CompatAdapter } from '../provider-composite.js';
import type { UnknownObject } from '../../../../types/common-types.js';

export const geminiCompat: CompatAdapter<'gemini-chat'> = {
  protocol: 'gemini-chat',
  request: async (body: UnknownObject) => body,
  response: async (response) => response
};

export default geminiCompat;
