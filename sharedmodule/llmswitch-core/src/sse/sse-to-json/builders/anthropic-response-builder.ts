import type {
  AnthropicMessageResponse,
  AnthropicContentBlock,
  AnthropicSseEvent
} from '../../types/index.js';
import type { ChatReasoningMode } from '../../types/chat-types.js';
import { dispatchReasoning } from '../../shared/reasoning-dispatcher.js';

interface BuilderOptions {
  reasoningMode?: ChatReasoningMode;
  reasoningTextPrefix?: string;
}

interface BuilderState {
  id?: string;
  model?: string;
  role: 'assistant' | 'user';
  content: AnthropicContentBlock[];
  stopReason?: AnthropicMessageResponse['stop_reason'];
  stopSequence?: AnthropicMessageResponse['stop_sequence'];
  usage?: AnthropicMessageResponse['usage'];
  currentBlock?:
    | { kind: 'text'; buffer: string; index: number }
    | { kind: 'thinking'; buffer: string; signature?: string; index: number }
    | { kind: 'redacted_thinking'; data: string; index: number }
    | { kind: 'tool_use'; id: string; name: string; buffer: string; index: number }
    | { kind: 'tool_result'; tool_use_id: string; content?: unknown; is_error?: boolean; index: number };
  completed: boolean;
}

export interface AnthropicBuilderResult {
  success: boolean;
  response?: AnthropicMessageResponse;
  error?: Error;
}

function mergeAnthropicUsage(
  current: AnthropicMessageResponse['usage'] | undefined,
  incoming: unknown
): AnthropicMessageResponse['usage'] | undefined {
  if (!incoming || typeof incoming !== 'object') {
    return current;
  }
  const incomingRecord = incoming as Record<string, unknown>;
  const base = current && typeof current === 'object' ? { ...(current as Record<string, unknown>) } : {};
  for (const [key, value] of Object.entries(incomingRecord)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const prev = base[key];
      base[key] = {
        ...(prev && typeof prev === 'object' && !Array.isArray(prev) ? (prev as Record<string, unknown>) : {}),
        ...(value as Record<string, unknown>)
      };
      continue;
    }
    base[key] = value;
  }
  return base as AnthropicMessageResponse['usage'];
}

export function createAnthropicResponseBuilder(options?: BuilderOptions) {
  const state: BuilderState = {
    content: [],
    role: 'assistant',
    completed: false
  };

  const inferStopReason = (): AnthropicMessageResponse['stop_reason'] => {
    if (state.stopReason) {
      return state.stopReason;
    }
    const currentKind = state.currentBlock?.kind;
    if (currentKind === 'tool_use' || state.content.some((block) => block.type === 'tool_use')) {
      return 'tool_use';
    }
    return 'end_turn';
  };

  const flushCurrent = () => {
    if (!state.currentBlock) return;
    const block = state.currentBlock;
    if (block.kind === 'text' && block.buffer) {
      state.content.push({ type: 'text', text: block.buffer });
    } else if (block.kind === 'thinking' && block.buffer) {
      const decision = dispatchReasoning(block.buffer, {
        mode: options?.reasoningMode,
        prefix: options?.reasoningTextPrefix
      });
      if (decision.appendToContent) {
        state.content.push({ type: 'text', text: decision.appendToContent });
      }
      if (decision.channel) {
        state.content.push({
          type: 'thinking',
          text: decision.channel,
          ...(typeof block.signature === 'string' && block.signature.trim().length
            ? { signature: block.signature.trim() }
            : {})
        });
      }
      if (typeof block.signature === 'string' && block.signature.trim().length) {
        state.content.push({ type: 'redacted_thinking', data: block.signature.trim() });
      }
    } else if (block.kind === 'thinking' && typeof block.signature === 'string' && block.signature.trim().length) {
      state.content.push({ type: 'redacted_thinking', data: block.signature.trim() });
    } else if (block.kind === 'redacted_thinking' && block.data.trim().length) {
      state.content.push({ type: 'redacted_thinking', data: block.data.trim() });
    } else if (block.kind === 'tool_use') {
      let input: Record<string, unknown> = {};
      try {
        input = block.buffer ? JSON.parse(block.buffer) : {};
      } catch {
        input = { _raw: block.buffer };
      }
      state.content.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input
      });
    } else if (block.kind === 'tool_result') {
      state.content.push({
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error
      });
    }
    state.currentBlock = undefined;
  };

  return {
    processEvent(event: AnthropicSseEvent): boolean {
      switch (event.type) {
        case 'message_start': {
          const payload = (event.data as any)?.message;
          if (payload) {
            state.id = payload.id || state.id;
            state.model = payload.model || state.model;
            state.role = payload.role || state.role;
            state.usage = mergeAnthropicUsage(state.usage, payload.usage);
          }
          break;
        }
        case 'content_block_start': {
          const payload = (event.data as any)?.content_block;
          const index = (event.data as any)?.index ?? 0;
          if (!payload) break;
          if (payload.type === 'text') {
            state.currentBlock = { kind: 'text', buffer: '', index };
          } else if (payload.type === 'thinking') {
            state.currentBlock = {
              kind: 'thinking',
              buffer: '',
              index,
              signature: typeof payload.signature === 'string' ? payload.signature : undefined
            };
          } else if (payload.type === 'redacted_thinking') {
            state.currentBlock = {
              kind: 'redacted_thinking',
              data: typeof payload.data === 'string' ? payload.data : '',
              index
            };
          } else if (payload.type === 'tool_use') {
            state.currentBlock = {
              kind: 'tool_use',
              id: payload.id,
              name: payload.name,
              buffer: '',
              index
            };
          } else if (payload.type === 'tool_result') {
            state.currentBlock = {
              kind: 'tool_result',
              tool_use_id: payload.tool_use_id,
              content: payload.content,
              is_error: payload.is_error,
              index
            };
          }
          break;
        }
        case 'content_block_delta': {
          if (!state.currentBlock) break;
          const delta = (event.data as any)?.delta;
          if (!delta) break;
          if (state.currentBlock.kind === 'text' && typeof delta.text === 'string') {
            state.currentBlock.buffer += delta.text;
          } else if (state.currentBlock.kind === 'thinking') {
            if (typeof delta.text === 'string') {
              state.currentBlock.buffer += delta.text;
            }
            if (typeof delta.thinking === 'string') {
              state.currentBlock.buffer += delta.thinking;
            }
            if (typeof delta.signature === 'string' && delta.signature.trim().length) {
              state.currentBlock.signature = delta.signature;
            }
          } else if (state.currentBlock.kind === 'tool_use' && typeof delta.partial_json === 'string') {
            state.currentBlock.buffer += delta.partial_json;
          } else if (state.currentBlock.kind === 'redacted_thinking') {
            if (typeof delta.signature === 'string' && delta.signature.trim().length) {
              state.currentBlock.data += delta.signature;
            } else if (typeof delta.thinking === 'string' && delta.thinking.trim().length) {
              state.currentBlock.data += delta.thinking;
            } else if (typeof delta.text === 'string' && delta.text.trim().length) {
              state.currentBlock.data += delta.text;
            }
          }
          break;
        }
        case 'content_block_stop': {
          flushCurrent();
          break;
        }
        case 'message_delta': {
          const data = (event.data as any) ?? {};
          const delta = data?.delta;
          if (delta?.stop_reason) {
            state.stopReason = delta.stop_reason;
          }
          if (typeof delta?.stop_sequence === 'string' || delta?.stop_sequence === null) {
            state.stopSequence = delta.stop_sequence;
          }
          // 部分实现将 usage 挂在 delta.usage，部分实现挂在顶层 event.data.usage，
          // 这里统一优先读取 delta.usage，缺失时回退到 data.usage。
          const usageNode = (delta && (delta as any).usage) ?? (data as any).usage;
          if (usageNode) {
            state.usage = mergeAnthropicUsage(state.usage, usageNode);
          }
          break;
        }
        case 'message_stop': {
          state.completed = true;
          flushCurrent();
          break;
        }
        default:
          break;
      }
      return true;
    },

    getResult(): AnthropicBuilderResult {
      if (!state.completed) {
        // 网络提前断开时可能缺失 content_block_stop/message_stop，
        // 先尝试 flush 当前 block，尽最大努力还原已接收内容。
        flushCurrent();
        // 对部分实现（或网络提前关闭）导致缺失 message_stop 的 SSE 流，
        // 只要已经累计到可用内容，就以最佳努力方式返回结果，而不是直接抛错。
        if (state.content.length > 0) {
          return {
            success: true,
            response: {
              id: state.id || `msg_${Date.now()}`,
              type: 'message',
              role: state.role || 'assistant',
              model: state.model || 'unknown',
              content: state.content,
              usage: state.usage,
              stop_reason: inferStopReason(),
              stop_sequence: state.stopSequence
            }
          };
        }
        return { success: false, error: new Error('Anthropic SSE stream incomplete') };
      }
      return {
        success: true,
        response: {
          id: state.id || `msg_${Date.now()}`,
          type: 'message',
          role: state.role || 'assistant',
          model: state.model || 'unknown',
          content: state.content,
          usage: state.usage,
          stop_reason: inferStopReason(),
          stop_sequence: state.stopSequence
        }
      };
    }
  };
}
