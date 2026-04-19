import { mapChatToolsToAnthropicTools } from './anthropic-message-utils-tool-schema.js';
import { ProviderProtocolError } from '../provider-protocol-error.js';
import { jsonClone, type JsonValue } from '../hub/types/json.js';
import { logHubStageTiming } from '../hub/pipeline/hub-stage-timing.js';
import { parseLenientJsonishWithNative } from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';
import {
  flattenAnthropicText,
  isObject,
  normalizeShellLikeToolInput,
  requireTrimmedString,
  sanitizeToolUseId
} from './anthropic-message-utils-core.js';
import { normalizeAnthropicToolChoice } from './anthropic-message-utils-openai-response.js';

type Unknown = Record<string, unknown>;
type UnknownArray = Unknown[];

const ANTHROPIC_TOP_LEVEL_FIELDS = new Set<string>([
  'model',
  'messages',
  'tools',
  'system',
  'stop_sequences',
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'max_output_tokens',
  'metadata',
  'stream',
  'tool_choice',
  'thinking'
]);

function hasVisibleText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function buildAnthropicRequestFromOpenAIChat(
  chatReq: unknown,
  options?: { requestId?: string },
): Unknown {
  const requestBody: Unknown = isObject(chatReq) ? chatReq : {};
  const requestId =
    typeof options?.requestId === 'string' && options.requestId.trim().length
      ? options.requestId.trim()
      : 'unknown';
  const model = String(requestBody?.model || 'unknown');
  const messages: UnknownArray = [];

  // IMPORTANT:
  // The request_outbound bridge-policy pipeline was previously executed here, but
  // its output state was never consumed by this builder. That made the whole pass
  // pure overhead (large-message O(n) scans/clones) with zero semantic effect.
  // To preserve payload semantics and stop latency bleed, we skip that no-op pass.

  const collectText = (val: unknown): string => {
    if (!val) return '';
    if (typeof val === 'string') return val;
    if (Array.isArray(val)) return val.map(collectText).join('');
    if (typeof val === 'object') {
      if (typeof (val as any).text === 'string') return String((val as any).text);
      if (Array.isArray((val as any).content)) return collectText((val as any).content);
    }
    return '';
  };

  const msgs = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  const mirrorShapes = extractMirrorShapesFromRequest(requestBody);
  let mirrorIndex = 0;
  const knownToolCallIds = new Set<string>();
  logHubStageTiming(requestId, 'req_outbound.anthropic.pre_scan_tool_calls', 'start');
  const preScanStart = Date.now();
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const role = String((m as any).role || 'user');
    if (role !== 'assistant') continue;
    const toolCalls = (m as any).tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== 'object') continue;
      const id = sanitizeToolUseId(requireTrimmedString((tc as any).id, 'chat.tool_call.id'));
      knownToolCallIds.add(id);
    }
  }
  logHubStageTiming(requestId, 'req_outbound.anthropic.pre_scan_tool_calls', 'completed', {
    elapsedMs: Date.now() - preScanStart
  });

  const systemBlocks: Array<{ type: 'text'; text: string }> = [];
  const pushSystemBlock = (text: string) => {
    if (hasVisibleText(text)) systemBlocks.push({ type: 'text', text });
  };
  try {
    const sys = requestBody.system;
    const ingestSystem = (val: unknown): void => {
      if (!val) return;
      if (typeof val === 'string') {
        if (!hasVisibleText(val)) {
          throw new ProviderProtocolError(
            'Anthropic bridge constraint violated: top-level system must contain text',
            {
              code: 'MALFORMED_REQUEST',
              protocol: 'anthropic-messages',
              providerType: 'anthropic',
              details: { context: 'top-level system' }
            }
          );
        }
        pushSystemBlock(val);
        return;
      }
      if (Array.isArray(val)) {
        for (const entry of val) ingestSystem(entry);
        return;
      }
      if (typeof val === 'object') {
        const text = flattenAnthropicText(val);
        if (!hasVisibleText(text)) {
          throw new ProviderProtocolError(
            'Anthropic bridge constraint violated: top-level system must contain text',
            {
              code: 'MALFORMED_REQUEST',
              protocol: 'anthropic-messages',
              providerType: 'anthropic',
              details: { context: 'top-level system' }
            }
          );
        }
        pushSystemBlock(text);
        return;
      }
      throw new ProviderProtocolError(
        'Anthropic bridge constraint violated: unsupported system payload type',
        {
          code: 'MALFORMED_REQUEST',
          protocol: 'anthropic-messages',
          providerType: 'anthropic',
          details: { context: 'top-level system', actualType: typeof val }
        }
      );
    };
    ingestSystem(sys);
  } catch {
    // ignore system pre-scan errors
  }
  logHubStageTiming(requestId, 'req_outbound.anthropic.map_messages', 'start');
  const mapMessagesStart = Date.now();
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const role = String((m as any).role || 'user');
    let targetShape: string | undefined;
    if (role !== 'system' && Array.isArray(mirrorShapes)) {
      targetShape = mirrorShapes[mirrorIndex];
      mirrorIndex += 1;
    }
    const contentNode = (m as any).content;
    const text = collectText(contentNode);
    const hasText = hasVisibleText(text);

    if (role === 'system') {
      if (!hasText) {
        throw new ProviderProtocolError(
          'Anthropic bridge constraint violated: Chat system message must contain text',
          {
            code: 'MALFORMED_REQUEST',
            protocol: 'anthropic-messages',
            providerType: 'anthropic',
            details: { context: 'chat.system', original: contentNode }
          }
        );
      }
      pushSystemBlock(text);
      continue;
    }

    if (role === 'tool') {
      const toolCallId = sanitizeToolUseId(
        requireTrimmedString(
          (m as any).tool_call_id ?? (m as any).call_id ?? (m as any).tool_use_id ?? (m as any).id,
          'tool_result.tool_call_id'
        )
      );
      if (!knownToolCallIds.has(toolCallId)) {
        throw new ProviderProtocolError(
          `Anthropic bridge constraint violated: tool result ${toolCallId} has no matching tool call`,
          {
            code: 'TOOL_PROTOCOL_ERROR',
            protocol: 'anthropic-messages',
            providerType: 'anthropic',
            details: { toolCallId }
          }
        );
      }
      const block: any = {
        type: 'tool_result',
        content: text
      };
      block.tool_use_id = toolCallId;
      messages.push({
        role: 'user',
        content: [block]
      });
      continue;
    }

    const blocks: any[] = [];
    if (Array.isArray(contentNode)) {
      for (const entry of contentNode) {
        if (!entry || typeof entry !== 'object') continue;
        const node = entry as Record<string, unknown>;
        const t = typeof node.type === 'string' ? node.type.toLowerCase() : '';
        if (t === 'image' && node.source && typeof node.source === 'object') {
          blocks.push({
            type: 'image',
            source: jsonClone(node.source as JsonValue)
          });
          continue;
        }
        if (t === 'image_url' || t === 'input_image') {
          let url = '';
          const imageUrl = node.image_url as unknown;
          if (typeof imageUrl === 'string') {
            url = imageUrl;
          } else if (imageUrl && typeof imageUrl === 'object' && typeof (imageUrl as Record<string, unknown>).url === 'string') {
            url = (imageUrl as Record<string, unknown>).url as string;
          }
          const trimmed = url.trim();
          if (!trimmed.length) continue;
          const source: Record<string, unknown> = {};
          if (trimmed.startsWith('data:')) {
            const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(trimmed);
            if (match) {
              const mediaType = (match[1] || '').trim() || 'image/png';
              source.type = 'base64';
              source.media_type = mediaType;
              source.data = match[2] || '';
            } else {
              source.type = 'url';
              source.url = trimmed;
            }
          } else {
            source.type = 'url';
            source.url = trimmed;
          }
          blocks.push({
            type: 'image',
            source
          });
        }
      }
    }
    if (hasText) {
      blocks.push({ type: 'text', text });
    }
    if (role === 'assistant') {
      const reasoningText =
        typeof (m as any).reasoning_content === 'string'
          ? String((m as any).reasoning_content)
          : typeof (m as any).reasoning === 'string'
            ? String((m as any).reasoning)
            : '';
      if (hasVisibleText(reasoningText)) {
        blocks.push({ type: 'thinking', text: reasoningText });
      }
    }

    const toolCalls = Array.isArray((m as any).tool_calls) ? (m as any).tool_calls : [];
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== 'object') continue;
      const id = sanitizeToolUseId(requireTrimmedString((tc as any).id, 'chat.tool_call.id'));
      const fn = (tc as any).function || {};
      const name = requireTrimmedString((fn as any).name, 'chat.tool_call.function.name');
      const argsRaw = (fn as any).arguments;
      let input: any;
      if (typeof argsRaw === 'string') {
        const parsed = parseLenientJsonishWithNative(argsRaw);
        input = parsed && typeof parsed === 'object' ? parsed : { _raw: argsRaw };
      } else {
        input = argsRaw ?? {};
      }
      input = normalizeShellLikeToolInput(name, input);
      blocks.push({ type: 'tool_use', id, name, input });
    }

    if (blocks.length > 0) {
      const hasStructuredBlocks = blocks.some((block) => block && typeof block === 'object' && (block as any).type !== 'text');
      let contentNode: unknown = blocks;
      if (!hasStructuredBlocks && (targetShape === 'string' || !targetShape)) {
        contentNode = text;
      }
      messages.push({ role, content: contentNode });
    }
  }
  logHubStageTiming(requestId, 'req_outbound.anthropic.map_messages', 'completed', {
    elapsedMs: Date.now() - mapMessagesStart
  });

  const out: any = { model };
  if (systemBlocks.length) {
    out.system = systemBlocks;
  }
  out.messages = messages;
  const anthropicTools = mapChatToolsToAnthropicTools((requestBody as Unknown).tools);
  if (anthropicTools !== undefined) {
    out.tools = anthropicTools;
  }

  const normalizedToolChoice = normalizeAnthropicToolChoice((requestBody as any).tool_choice);
  if (normalizedToolChoice !== undefined) {
    out.tool_choice = normalizedToolChoice;
  }

  if ((requestBody as any).thinking !== undefined) {
    try {
      out.thinking = JSON.parse(JSON.stringify((requestBody as any).thinking));
    } catch {
      out.thinking = (requestBody as any).thinking;
    }
  }

  try {
    if (requestBody.metadata && typeof requestBody.metadata === 'object') {
      out.metadata = JSON.parse(JSON.stringify(requestBody.metadata));
    }
  } catch {
    // best-effort metadata clone
  }

  const mt = Number(
    (requestBody as { max_tokens?: unknown; maxTokens?: unknown }).max_tokens ??
      (requestBody as { max_tokens?: unknown; maxTokens?: unknown }).maxTokens ??
      NaN
  );
  if (Number.isFinite(mt) && mt > 0) out.max_tokens = mt;
  if (typeof (requestBody as { temperature?: unknown }).temperature === 'number') {
    out.temperature = Number((requestBody as { temperature?: number }).temperature);
  }
  if (typeof (requestBody as { top_p?: unknown }).top_p === 'number') {
    out.top_p = Number((requestBody as { top_p?: number }).top_p);
  }
  if (typeof (requestBody as { stream?: unknown }).stream === 'boolean') {
    out.stream = Boolean((requestBody as { stream?: boolean }).stream);
  }
  const stop = (requestBody as { stop?: unknown }).stop;
  if (typeof stop === 'string' && stop.trim()) {
    out.stop_sequences = [stop.trim()];
  } else if (Array.isArray(stop) && stop.length > 0) {
    out.stop_sequences = stop.map((s: any) => String(s)).filter(Boolean);
  }

  return pruneAnthropicRequest(out);
}

function pruneAnthropicRequest(payload: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(payload)) {
    if (!ANTHROPIC_TOP_LEVEL_FIELDS.has(key)) {
      delete payload[key];
    }
  }
  return payload;
}

function extractMirrorShapesFromRequest(source: Unknown): string[] | undefined {
  const directMirror =
    source &&
    typeof source === 'object' &&
    (source as Record<string, unknown>).__anthropicMirror &&
    typeof (source as Record<string, unknown>).__anthropicMirror === 'object'
      ? ((source as Record<string, unknown>).__anthropicMirror as Record<string, unknown>)
      : extractMirrorFromMetadata(source);
  if (!directMirror) {
    return undefined;
  }
  const shapes = directMirror.messageContentShape;
  if (!Array.isArray(shapes)) {
    return undefined;
  }
  return shapes.map((entry) => (typeof entry === 'string' ? entry : String(entry ?? '')));
}

function extractMirrorFromMetadata(source: Unknown): Record<string, unknown> | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  const metadata = (source as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const extraFields = (metadata as Record<string, unknown>).extraFields;
  if (!extraFields || typeof extraFields !== 'object') {
    return undefined;
  }
  const mirror = (extraFields as Record<string, unknown>).anthropicMirror;
  return mirror && typeof mirror === 'object' ? (mirror as Record<string, unknown>) : undefined;
}
