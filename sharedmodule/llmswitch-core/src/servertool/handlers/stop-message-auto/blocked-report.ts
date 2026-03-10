import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface StopMessageBlockedReport {
  summary: string;
  blocker: string;
  impact?: string;
  nextAction?: string;
  evidence: string[];
}

export interface StopMessageBlockedIssueContext {
  requestId?: string;
  sessionId?: string;
}

const STOP_MESSAGE_BD_CREATE_TIMEOUT_MS = 2_000;
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

export function createBdIssueFromBlockedReport(
  blockedReport: StopMessageBlockedReport,
  context?: StopMessageBlockedIssueContext,
  cwdOverride?: string
): string | null {
  const cwd = resolveBdWorkingDirectoryForStopMessage(cwdOverride);
  const title = buildBlockedIssueTitle(blockedReport);
  const description = buildBlockedIssueDescription(blockedReport, context);
  const acceptance = buildBlockedIssueAcceptance(blockedReport);

  try {
    const result = childProcess.spawnSync(
      'bd',
      [
        '--no-db',
        'create',
        '--json',
        '-t',
        'bug',
        '-p',
        '0',
        '--title',
        title,
        '--description',
        description,
        '--acceptance',
        acceptance
      ],
      {
        cwd,
        encoding: 'utf8',
        timeout: STOP_MESSAGE_BD_CREATE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024
      }
    );

    if (result.error || result.status !== 0) {
      return null;
    }
    return parseCreatedIssueId(result.stdout);
  } catch {
    return null;
  }
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
    const fallbackText =
      toNonEmptyText(record.content) ||
      toNonEmptyText(record.value) ||
      extractUnknownText(record.input) ||
      extractUnknownText(record.arguments) ||
      extractUnknownText(record.args) ||
      extractUnknownText(record.patch) ||
      extractUnknownText(record.payload);
    if (fallbackText) {
      chunks.push(fallbackText);
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

function resolveBdWorkingDirectoryForStopMessage(cwdOverride?: string): string {
  const fromOverride = toNonEmptyText(cwdOverride);
  if (fromOverride) {
    return path.resolve(fromOverride);
  }
  const fromEnv = toNonEmptyText(process.env.ROUTECODEX_STOPMESSAGE_BD_WORKDIR);
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  const cwd = process.cwd();
  return findBdProjectRootForStopMessage(cwd) || cwd;
}

function findBdProjectRootForStopMessage(startDirectory: string): string | null {
  let current = path.resolve(startDirectory);
  while (true) {
    const beadFile = path.join(current, '.beads', 'issues.jsonl');
    if (fs.existsSync(beadFile)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function buildBlockedIssueTitle(report: StopMessageBlockedReport): string {
  const base = report.summary.trim() || report.blocker.trim() || 'stopMessage blocked';
  const cleaned = base.replace(/\s+/g, ' ').slice(0, 120);
  return `[stopMessage] ${cleaned}`.trim();
}

function buildBlockedIssueDescription(
  report: StopMessageBlockedReport,
  context?: StopMessageBlockedIssueContext
): string {
  const lines = [
    '自动建单来源：stop_message_auto 结构化 blocked 报告',
    '',
    `Summary: ${report.summary}`,
    `Blocker: ${report.blocker}`,
    `Impact: ${report.impact || 'n/a'}`,
    `Next Action: ${report.nextAction || 'n/a'}`,
    '',
    `RequestId: ${context?.requestId || 'n/a'}`,
    `SessionId: ${context?.sessionId || 'n/a'}`,
    '',
    'Evidence:',
    ...(report.evidence.length > 0 ? report.evidence.map((entry) => `- ${entry}`) : ['- n/a']),
    '',
    'Notes:',
    '- 本 issue 由系统在 stopMessage 检测到结构化阻塞后自动创建。',
    '- 请按 blocker/next action 先解除阻塞，再恢复执行。'
  ];
  return lines.join('\n');
}

function buildBlockedIssueAcceptance(report: StopMessageBlockedReport): string {
  const next = report.nextAction || '执行可验证的解阻动作并记录结果';
  return [
    `1. 明确并确认 blocker：${report.blocker}`,
    `2. 完成解阻动作：${next}`,
    '3. 验证 stopMessage followup 可继续推进'
  ].join('\n');
}

function parseCreatedIssueId(stdout: unknown): string | null {
  if (typeof stdout !== 'string') {
    return null;
  }
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    const id = toNonEmptyText((parsed as { id?: unknown }).id);
    return id || null;
  } catch {
    const match = trimmed.match(/\b[a-z]+-\d+(?:\.\d+)?\b/i);
    return match ? match[0] : null;
  }
}

function toNonEmptyText(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}
