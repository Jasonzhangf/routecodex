import type { ChatMessageContentPart } from '../hub/types/chat-envelope.js';
import type { StandardizedMessage, StandardizedRequest } from '../hub/types/standardized.js';

export interface MarkerSyntaxMatch<T = unknown> {
  raw: string;
  body: string;
  start: number;
  end: number;
  terminated: boolean;
  parsed?: T;
}

export interface StripMarkerSyntaxResult<T = unknown> {
  text: string;
  markers: MarkerSyntaxMatch<T>[];
}

function compactMarkerWhitespace(raw: string): string {
  return raw
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripMarkerSyntaxFromText<T = unknown>(
  raw: string,
  options?: {
    parse?: (body: string, marker: Omit<MarkerSyntaxMatch<T>, 'parsed'>) => T | undefined;
  }
): StripMarkerSyntaxResult<T> {
  const source = String(raw || '');
  if (!source.includes('<**')) {
    return { text: source, markers: [] };
  }

  const markers: MarkerSyntaxMatch<T>[] = [];
  let output = '';
  let cursor = 0;

  while (cursor < source.length) {
    const markerStart = source.indexOf('<**', cursor);
    if (markerStart < 0) {
      output += source.slice(cursor);
      break;
    }

    output += source.slice(cursor, markerStart);

    const closeIndex = source.indexOf('**>', markerStart + 3);
    const newlineIndex = source.indexOf('\n', markerStart + 3);
    const hasClosedMarker = closeIndex >= 0 && (newlineIndex < 0 || closeIndex < newlineIndex);
    const markerEnd = hasClosedMarker
      ? closeIndex + 3
      : (newlineIndex >= 0 ? newlineIndex : source.length);
    const rawMarker = source.slice(markerStart, markerEnd);
    const body = hasClosedMarker
      ? source.slice(markerStart + 3, closeIndex)
      : source.slice(markerStart + 3, markerEnd);
    const baseMarker: Omit<MarkerSyntaxMatch<T>, 'parsed'> = {
      raw: rawMarker,
      body,
      start: markerStart,
      end: markerEnd,
      terminated: hasClosedMarker
    };
    const parsed = options?.parse?.(body, baseMarker);
    markers.push(parsed === undefined ? baseMarker : { ...baseMarker, parsed });
    cursor = markerEnd;
  }

  return {
    text: compactMarkerWhitespace(output),
    markers
  };
}

function stripMarkerSyntaxField<T = unknown>(
  record: Record<string, unknown>,
  key: 'text' | 'content',
  options?: {
    parse?: (body: string, marker: Omit<MarkerSyntaxMatch<T>, 'parsed'>) => T | undefined;
  }
): { changed: boolean; markers: MarkerSyntaxMatch<T>[] } {
  const value = record[key];
  if (typeof value !== 'string' || !value.includes('<**')) {
    return { changed: false, markers: [] };
  }
  const stripped = stripMarkerSyntaxFromText(value, options);
  if (stripped.markers.length < 1) {
    return { changed: false, markers: [] };
  }
  record[key] = stripped.text;
  return { changed: true, markers: stripped.markers };
}

export function stripMarkerSyntaxFromContent<T = unknown>(
  content: StandardizedMessage['content'],
  options?: {
    parse?: (body: string, marker: Omit<MarkerSyntaxMatch<T>, 'parsed'>) => T | undefined;
  }
): {
  content: StandardizedMessage['content'];
  markers: MarkerSyntaxMatch<T>[];
} {
  if (typeof content === 'string') {
    const stripped = stripMarkerSyntaxFromText(content, options);
    return {
      content: stripped.text,
      markers: stripped.markers
    };
  }

  if (!Array.isArray(content)) {
    return { content, markers: [] };
  }

  const markers: MarkerSyntaxMatch<T>[] = [];
  let changed = false;
  const nextParts = content.map((part) => {
    if (typeof part === 'string') {
      const stripped = stripMarkerSyntaxFromText(part, options);
      if (stripped.markers.length > 0) {
        changed = true;
        markers.push(...stripped.markers);
        return stripped.text;
      }
      return part;
    }
    if (!part || typeof part !== 'object') {
      return part;
    }

    const nextPart = { ...(part as Record<string, unknown>) } as ChatMessageContentPart & Record<string, unknown>;
    const textResult = stripMarkerSyntaxField(nextPart, 'text', options);
    const contentResult = stripMarkerSyntaxField(nextPart, 'content', options);
    if (textResult.changed || contentResult.changed) {
      changed = true;
      markers.push(...textResult.markers, ...contentResult.markers);
      return nextPart as typeof part;
    }
    return part;
  });

  return {
    content: changed ? (nextParts as StandardizedMessage['content']) : content,
    markers
  };
}

export function stripMarkerSyntaxFromMessages<T = unknown>(
  messages: StandardizedMessage[],
  options?: {
    parse?: (body: string, marker: Omit<MarkerSyntaxMatch<T>, 'parsed'>) => T | undefined;
  }
): {
  messages: StandardizedMessage[];
  markers: MarkerSyntaxMatch<T>[];
  changed: boolean;
} {
  const markers: MarkerSyntaxMatch<T>[] = [];
  let changed = false;
  const nextMessages = messages.map((message) => {
    const stripped = stripMarkerSyntaxFromContent(message.content, options);
    if (stripped.markers.length < 1) {
      return message;
    }
    changed = true;
    markers.push(...stripped.markers);
    return {
      ...message,
      content: stripped.content
    };
  });

  return {
    messages: changed ? nextMessages : messages,
    markers,
    changed
  };
}

export function stripMarkerSyntaxFromRequest(
  request: StandardizedRequest
): StandardizedRequest {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const stripped = stripMarkerSyntaxFromMessages(messages);
  if (!stripped.changed) {
    return request;
  }
  return {
    ...request,
    messages: stripped.messages
  };
}

export function cleanMarkerSyntaxInPlace(record: Record<string, unknown>): void {
  const messages = Array.isArray((record as { messages?: unknown }).messages)
    ? ((record as { messages?: StandardizedMessage[] }).messages ?? [])
    : [];
  if (messages.length > 0) {
    const stripped = stripMarkerSyntaxFromMessages(messages);
    if (stripped.changed) {
      record.messages = stripped.messages as unknown;
    }
  }

  const semantics =
    record.semantics && typeof record.semantics === 'object' && !Array.isArray(record.semantics)
      ? (record.semantics as Record<string, unknown>)
      : null;
  const responses =
    semantics?.responses && typeof semantics.responses === 'object' && !Array.isArray(semantics.responses)
      ? (semantics.responses as Record<string, unknown>)
      : null;
  const context =
    responses?.context && typeof responses.context === 'object' && !Array.isArray(responses.context)
      ? (responses.context as Record<string, unknown>)
      : null;
  const inputMessages = Array.isArray(context?.input) ? (context.input as StandardizedMessage[]) : null;
  if (inputMessages && inputMessages.length > 0) {
    const stripped = stripMarkerSyntaxFromMessages(inputMessages);
    if (stripped.changed && semantics && responses && context) {
      context.input = stripped.messages as unknown;
      responses.context = context;
      semantics.responses = responses;
      record.semantics = semantics;
    }
  }
}

export function hasMarkerSyntax(raw: string): boolean {
  return String(raw || '').includes('<**');
}
