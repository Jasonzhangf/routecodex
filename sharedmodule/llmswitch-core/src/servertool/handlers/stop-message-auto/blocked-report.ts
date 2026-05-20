export interface StopMessageBlockedReport {
  summary: string;
  blocker: string;
  impact?: string;
  nextAction?: string;
  evidence: string[];
}
const STOP_MESSAGE_BLOCKED_TEXT_SCAN_LIMIT = 12;
const STOP_MESSAGE_BLOCKED_CANDIDATE_MAX_LENGTH = 12_000;

export function extractBlockedReportFromMessages(messages: unknown[]): StopMessageBlockedReport | null {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }
  const start = Math.max(0, messages.length - STOP_MESSAGE_BLOCKED_TEXT_SCAN_LIMIT);
  for (let idx = messages.length - 1; idx >= start; idx -= 1) {
    const text = extractCapturedMessageText(messages[idx]);
    if (!text) {
      continue;
    }
    const blockedReport = extractBlockedReportFromText(text);
    if (blockedReport) {
      return blockedReport;
    }
  }
  return null;
}

export function extractBlockedReportFromMessagesForTests(messages: unknown[]): StopMessageBlockedReport | null {
  return extractBlockedReportFromMessages(messages);
}

export function extractCapturedMessageText(message: unknown): string {
  if (!message) {
    return '';
  }
  if (typeof message === 'string') {
    return message.trim();
  }
  if (typeof message !== 'object' || Array.isArray(message)) {
    return '';
  }
  const record = message as Record<string, unknown>;
  const contentText = extractTextFromMessageContent(record.content);
  if (contentText) {
    return contentText;
  }
  const inputText = extractTextFromMessageContent(record.input);
  if (inputText) {
    return inputText;
  }
  const outputText = extractTextFromMessageContent(record.output);
  if (outputText) {
    return outputText;
  }
  const argumentsText = toNonEmptyText(record.arguments);
  return argumentsText;
}

export function extractTextFromMessageContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const chunks: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      if (item.trim()) chunks.push(item.trim());
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const type = toNonEmptyText(record.type).toLowerCase();
    if (type === 'text' || type === 'output_text' || type === 'input_text' || !type) {
      const text = toNonEmptyText(record.text);
      if (text) {
        chunks.push(text);
      }
      continue;
    }
    const blockedText =
      toNonEmptyText(record.content) ||
      toNonEmptyText(record.value) ||
      extractUnknownText(record.input) ||
      extractUnknownText(record.arguments) ||
      extractUnknownText(record.args) ||
      extractUnknownText(record.patch) ||
      extractUnknownText(record.payload);
    if (blockedText) {
      chunks.push(blockedText);
    }
  }
  return chunks.join('\n').trim();
}

function extractUnknownText(value: unknown, depth = 0): string {
  if (depth > 4 || value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractUnknownText(entry, depth + 1))
      .filter((entry) => entry.length > 0);
    return dedupeAndJoinTexts(parts);
  }
  if (typeof value !== 'object') {
    return '';
  }
  const record = value as Record<string, unknown>;
  const priorityKeys = [
    'text',
    'content',
    'value',
    'input',
    'arguments',
    'args',
    'patch',
    'payload',
    'summary',
    'reasoning',
    'thinking',
    'analysis'
  ];
  const parts: string[] = [];
  for (const key of priorityKeys) {
    if (!(key in record)) {
      continue;
    }
    const text = extractUnknownText(record[key], depth + 1);
    if (text) {
      parts.push(text);
    }
  }
  return dedupeAndJoinTexts(parts);
}

function dedupeAndJoinTexts(parts: string[]): string {
  const unique = Array.from(
    new Set(
      parts
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0)
    )
  );
  return unique.join('\n').trim();
}

function extractBlockedReportFromText(text: string): StopMessageBlockedReport | null {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) {
    return null;
  }

  const candidates: string[] = [];
  const pushCandidate = (candidate: string): void => {
    const normalized = candidate.trim();
    if (!normalized || normalized.length > STOP_MESSAGE_BLOCKED_CANDIDATE_MAX_LENGTH) {
      return;
    }
    if (candidates.includes(normalized)) {
      return;
    }
    candidates.push(normalized);
  };

  pushCandidate(trimmed);
  for (const codeBlock of extractJsonCodeBlocks(trimmed)) {
    pushCandidate(codeBlock);
  }
  for (const objectText of extractBalancedJsonObjectStrings(trimmed)) {
    if (objectText.includes('"type"') && objectText.toLowerCase().includes('"blocked"')) {
      pushCandidate(objectText);
    }
  }

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const report = normalizeBlockedReport(parsed);
    if (report) {
      return report;
    }
  }
  return null;
}

function normalizeBlockedReport(value: unknown): StopMessageBlockedReport | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const report = normalizeBlockedReport(entry);
      if (report) {
        return report;
      }
    }
    return null;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const type = toNonEmptyText(record.type).toLowerCase();
  if (type !== 'blocked') {
    return null;
  }

  const summary =
    toNonEmptyText(record.summary) ||
    toNonEmptyText(record.title) ||
    toNonEmptyText(record.problem);
  const blocker =
    toNonEmptyText(record.blocker) ||
    toNonEmptyText(record.reason) ||
    toNonEmptyText(record.blocked_by);
  if (!summary || !blocker) {
    return null;
  }

  const impact = toNonEmptyText(record.impact) || toNonEmptyText(record.effect);
  const nextAction =
    toNonEmptyText(record.next_action) ||
    toNonEmptyText(record.nextAction) ||
    toNonEmptyText(record.next_step);
  const evidence = normalizeBlockedEvidence(record.evidence);

  return {
    summary: summary.slice(0, 1_000),
    blocker: blocker.slice(0, 1_000),
    ...(impact ? { impact: impact.slice(0, 1_000) } : {}),
    ...(nextAction ? { nextAction: nextAction.slice(0, 1_000) } : {}),
    evidence
  };
}

function normalizeBlockedEvidence(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    const normalized = raw
      .map((entry) => toNonEmptyText(entry))
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.slice(0, 800));
    return normalized.slice(0, 8);
  }
  const single = toNonEmptyText(raw);
  return single ? [single.slice(0, 800)] : [];
}

function extractJsonCodeBlocks(text: string): string[] {
  const candidates: string[] = [];
  const regex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const body = (match[1] || '').trim();
    if (!body) {
      continue;
    }
    candidates.push(body);
  }
  return candidates;
}

function extractBalancedJsonObjectStrings(text: string): string[] {
  const results: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let idx = 0; idx < text.length; idx += 1) {
    const ch = text[idx];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) {
        start = idx;
      }
      depth += 1;
      continue;
    }

    if (ch === '}') {
      if (depth <= 0) {
        continue;
      }
      depth -= 1;
      if (depth === 0 && start >= 0) {
        results.push(text.slice(start, idx + 1));
        start = -1;
      }
    }
  }
  return results;
}

function toNonEmptyText(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}
