type QwenChatProviderError = Error & {
  code?: string;
  statusCode?: number;
  status?: number;
  details?: Record<string, unknown>;
};

export type QwenAttachment = {
  source: string;
  filename?: string;
  mimeType?: string;
  explicitType?: string;
};

export type ParsedIncomingMessages = {
  content: string;
  attachments: QwenAttachment[];
  chatType: 't2t' | 'search';
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function normalizeInputString(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  const lowered = trimmed.toLowerCase();
  if (lowered === '[undefined]' || lowered === 'undefined' || lowered === '[null]' || lowered === 'null') {
    return '';
  }
  return trimmed;
}

export function createQwenChatProviderError(
  code: string,
  message: string,
  statusCode: number,
  details?: Record<string, unknown>
): QwenChatProviderError {
  const error = new Error(message) as QwenChatProviderError;
  error.code = code;
  error.statusCode = statusCode;
  error.status = statusCode;
  if (details) {
    error.details = details;
  }
  return error;
}

function normalizeContentParts(content: unknown): { text: string; attachments: QwenAttachment[] } {
  if (typeof content === 'string') {
    return { text: normalizeInputString(content), attachments: [] };
  }
  if (!Array.isArray(content)) {
    return { text: '', attachments: [] };
  }

  const textParts: string[] = [];
  const attachments: QwenAttachment[] = [];
  for (const part of content) {
    if (!part) {
      continue;
    }
    if (typeof part === 'string') {
      const text = normalizeInputString(part);
      if (text) {
        textParts.push(text);
      }
      continue;
    }
    if (!isRecord(part)) {
      continue;
    }
    const type = normalizeInputString(part.type);
    if (type === 'text' || type === 'input_text') {
      const text = normalizeInputString(part.text || part.input_text);
      if (text) {
        textParts.push(text);
      }
      continue;
    }
    if (type === 'image_url' || type === 'input_image') {
      const source = normalizeInputString(
        (isRecord(part.image_url) ? part.image_url.url : part.image_url)
        || part.url
        || part.file_url
        || part.file_data
      );
      if (source) {
        attachments.push({
          source,
          filename: normalizeInputString(part.filename) || normalizeInputString(part.name),
          mimeType: normalizeInputString(part.mime_type) || normalizeInputString(part.content_type),
          explicitType: 'image'
        });
      }
      continue;
    }
    if (type === 'file' || type === 'input_file' || type === 'audio' || type === 'input_audio' || type === 'video' || type === 'input_video') {
      const source = normalizeInputString(part.file_data || part.url || part.file_url || part.data);
      if (source) {
        attachments.push({
          source,
          filename: normalizeInputString(part.filename) || normalizeInputString(part.name),
          mimeType: normalizeInputString(part.mime_type) || normalizeInputString(part.content_type),
          explicitType: type.includes('audio') ? 'audio' : (type.includes('video') ? 'video' : undefined)
        });
      }
    }
  }

  return {
    text: textParts.join('\n'),
    attachments
  };
}

function normalizeLegacyFiles(message: Record<string, unknown>): QwenAttachment[] {
  const result: QwenAttachment[] = [];
  const candidates = [
    ...(Array.isArray(message.attachments) ? message.attachments : []),
    ...(Array.isArray(message.files) ? message.files : [])
  ];
  for (const item of candidates) {
    if (!isRecord(item)) {
      continue;
    }
    const source = normalizeInputString(item.data || item.file_data || item.url || item.file_url);
    if (!source) {
      continue;
    }
    result.push({
      source,
      filename: normalizeInputString(item.filename) || normalizeInputString(item.name),
      mimeType: normalizeInputString(item.mime_type) || normalizeInputString(item.content_type) || normalizeInputString(item.type),
      explicitType: normalizeInputString(item.type)
    });
  }
  return result;
}

export function parseIncomingMessagesForQwenChat(request: Record<string, unknown>): ParsedIncomingMessages {
  const safeMessages = Array.isArray(request.messages) ? request.messages : [];
  const normalized = safeMessages.map((message) => {
    const record = isRecord(message) ? message : {};
    const parsed = normalizeContentParts(record.content);
    return {
      role: normalizeInputString(record.role) || 'user',
      text: parsed.text,
      attachments: [...parsed.attachments, ...normalizeLegacyFiles(record)]
    };
  });

  if (normalized.length === 0) {
    throw createQwenChatProviderError(
      'QWENCHAT_GUEST_EMPTY_PROMPT',
      'QwenChat guest runtime requires at least one message',
      400
    );
  }

  const last = normalized[normalized.length - 1];
  const history = normalized.slice(0, -1)
    .map((message) => {
      if (!message.text) {
        return '';
      }
      const role = message.role === 'assistant' ? 'Assistant' : message.role === 'system' ? 'System' : 'User';
      return `[${role}]: ${message.text}`;
    })
    .filter(Boolean)
    .join('\n\n');

  const lastText = last.text || (last.attachments.length > 0 ? '请结合附件内容回答。' : '');
  const content = history ? `${history}\n\n[User]: ${lastText}` : lastText;
  if (!content) {
    throw createQwenChatProviderError(
      'QWENCHAT_GUEST_EMPTY_PROMPT',
      'QwenChat guest runtime requires the latest user text message or attachment',
      400
    );
  }

  const hasImageAttachment = last.attachments.some((attachment) => {
    const explicit = normalizeInputString(attachment.explicitType).toLowerCase();
    if (explicit === 'image') {
      return true;
    }
    const mime = normalizeInputString(attachment.mimeType).toLowerCase();
    return mime.startsWith('image/');
  });

  return {
    content,
    attachments: last.attachments,
    chatType: hasImageAttachment ? 't2t' : 't2t'
  };
}

export function isQwenWafHtmlPayload(rawPayload: string): boolean {
  const normalized = rawPayload.slice(0, 4096).toLowerCase().replace(/\s+/g, '');
  return normalized.includes('<!doctypehtml>')
    || normalized.includes('aliyun_waf')
    || normalized.includes('aliyuncaptcha')
    || normalized.includes('renderdata');
}
