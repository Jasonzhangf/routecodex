import type { StandardizedMessage } from '../../../conversion/hub/types/standardized.js';
import { ROUTING_INSTRUCTION_MARKER_GLOBAL_PATTERN } from './types.js';

export function stripCodeSegments(text: string): string {
  if (!text) {
    return '';
  }
  // Remove fenced code blocks ```...``` or ~~~...~~~
  let sanitized = text.replace(/```[\s\S]*?```/g, ' ');
  sanitized = sanitized.replace(/~~~[\s\S]*?~~~/g, ' ');
  // Remove inline code `...`
  sanitized = sanitized.replace(/`[^`]*`/g, ' ');
  return sanitized;
}

export function cleanMessagesFromRoutingInstructions(messages: StandardizedMessage[]): StandardizedMessage[] {
  return messages
    .map((message) => {
      if (message.role !== 'user' || typeof message.content !== 'string') {
        return message;
      }

      const cleanedContent = message.content.replace(ROUTING_INSTRUCTION_MARKER_GLOBAL_PATTERN, '').trim();
      return {
        ...message,
        content: cleanedContent
      };
    })
    .filter((message) => {
      if (message.role !== 'user') {
        return true;
      }
      if (typeof message.content !== 'string') {
        return true;
      }
      return message.content.trim().length > 0;
    });
}
