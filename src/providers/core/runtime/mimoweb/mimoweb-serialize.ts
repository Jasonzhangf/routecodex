/**
 * MiMo Web Provider — Request serialization
 *
 * Converts Anthropic messages format into a single query string
 * for the MiMo Web chat endpoint.
 *
 * ONLY used inside mimoweb compat layer.
 */

import type { AnthropicToolDef } from './mimoweb-tool-guidance.js';
import { buildToolSystemPrompt } from './mimoweb-tool-guidance.js';

type ContentBlock = {
  type: string;
  text?: string;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
};

type ToolCallLike = {
  id?: string;
  call_id?: string;
  tool_call_id?: string;
  name?: string;
  arguments?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type Message = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string | ContentBlock[] | null;
  tool_calls?: ToolCallLike[];
  tool_call_id?: string;
  name?: string;
};

function formatToolCalls(toolCalls: ToolCallLike[] | undefined): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return '';
  }
  const parts: string[] = [];
  for (const call of toolCalls) {
    const name =
      (typeof call.function?.name === 'string' && call.function.name.trim())
      || (typeof call.name === 'string' && call.name.trim())
      || '';
    if (!name) {
      continue;
    }
    const rawArgs =
      (typeof call.function?.arguments === 'string' && call.function.arguments.trim())
      || (typeof call.arguments === 'string' && call.arguments.trim())
      || '{}';
    let parsedArgs: unknown = {};
    try {
      parsedArgs = JSON.parse(rawArgs);
    } catch {
      parsedArgs = {};
    }
    parts.push(
      '<tool_call>\n'
      + JSON.stringify({
        name,
        arguments:
          parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs)
            ? parsedArgs
            : {},
      })
      + '\n</tool_call>',
    );
  }
  return parts.join('\n');
}

function formatAssistantContent(message: Message): string {
  const { content } = message;
  if (!content) {
    return formatToolCalls(message.tool_calls);
  }
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    return formatToolCalls(message.tool_calls);
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      parts.push(
        '<tool_call>\n'
        + JSON.stringify({
          name: block.name,
          arguments: block.input ?? {},
        })
        + '\n</tool_call>',
      );
    }
  }
  const toolCallText = formatToolCalls(message.tool_calls);
  return [parts.join('\n'), toolCallText].filter(Boolean).join('\n');
}

function formatToolResultContent(message: Message): string {
  const { content } = message;
  if (!content) return '';
  if (message.role === 'tool' && typeof content === 'string') {
    return '[工具结果]\n' + content;
  }
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'tool_result') {
      const resultContent =
        typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content
              .filter((entry) => entry.type === 'text')
              .map((entry) => entry.text ?? '')
              .join('')
            : JSON.stringify(block.content ?? '');
      parts.push('[工具结果]\n' + resultContent);
    } else if (block.type === 'text' && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/**
 * Serialize Anthropic messages + tools into a query string for MiMo Web.
 */
export function serializeMessages(
  messages: Message[],
  tools?: AnthropicToolDef[],
): { query: string; systemPrompt: string } {
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');

  const systemParts: string[] = [];
  for (const s of systemMsgs) {
    if (typeof s.content === 'string') systemParts.push(s.content);
  }
  if (tools && tools.length > 0) {
    systemParts.push(buildToolSystemPrompt(tools));
  }
  const systemPrompt = systemParts.join('\n\n');
  const dialogParts: string[] = [];

  for (const msg of nonSystem) {
    if (msg.role === 'assistant') {
      const text = formatAssistantContent(msg);
      if (text) dialogParts.push('assistant: ' + text);
    } else if (msg.role === 'user' || msg.role === 'tool') {
      if (Array.isArray(msg.content)) {
        const text = formatToolResultContent(msg);
        if (text) dialogParts.push('user: ' + text);
      } else if (typeof msg.content === 'string' && msg.content) {
        const text = formatToolResultContent(msg);
        if (text) {
          dialogParts.push('user: ' + text);
        }
      }
    }
  }

  return { query: dialogParts.join('\n\n'), systemPrompt };
}
