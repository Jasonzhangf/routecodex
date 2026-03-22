/**
 * CACHE.md 写入工具（全局唯一真源）
 *
 * 职责：
 * - 解析请求/响应数据
 * - 生成写入 payload
 * - 处理路径（cwd - 全局唯一真源）
 * - 写入 CACHE.md
 *
 * 不依赖 host / server / provider，纯逻辑层
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { JsonObject } from '../../../conversion/hub/types/json.js';

export interface CacheWriteOptions {
  /** 写入类型：request | response */
  type: 'request' | 'response';
  /** 工作目录（cwd / workdir / workingDirectory） */
  workingDirectory?: string;
  /** 请求 ID */
  requestId: string;
  /** 会话 ID（可选） */
  sessionId?: string;
  /** 时间戳（毫秒） */
  timestampMs: number;
  /** 角色：user | assistant */
  role: 'user' | 'assistant';
  /** 文本内容 */
  content: string;
  /** 额外元数据（可选） */
  metadata?: {
    model?: string;
    providerProtocol?: string;
    finishReason?: string;
    [key: string]: unknown;
  };
}

export type CacheWriteResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

interface ParsedCacheEntry {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * 从 metadata 解析工作目录
 */
export function resolveWorkingDirectory(metadata: Record<string, unknown>): string | undefined {
  const candidates = ['cwd', 'workdir', 'workingDirectory', 'clientWorkdir'];
  for (const key of candidates) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * 从 adapterContext 解析工作目录
 */
export function resolveWorkingDirectoryFromAdapterContext(adapterContext: Record<string, unknown>): string | undefined {
  const candidates = ['cwd', 'workdir', 'workingDirectory', 'clientWorkdir'];
  for (const key of candidates) {
    const value = adapterContext[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  const rt = (adapterContext as { __rt?: unknown }).__rt;
  if (rt && typeof rt === 'object' && !Array.isArray(rt)) {
    for (const key of candidates) {
      const value = (rt as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
  }
  return undefined;
}

function extractTextFromAssistantMessageContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const row = content as Record<string, unknown>;
    const directText = row.text;
    if (typeof directText === 'string' && directText.trim()) {
      return directText.trim();
    }
    if (directText && typeof directText === 'object' && !Array.isArray(directText)) {
      const value = (directText as Record<string, unknown>).value;
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    const directValue = row.value;
    if (typeof directValue === 'string' && directValue.trim()) {
      return directValue.trim();
    }
    if (typeof row.content === 'string' && row.content.trim()) {
      return row.content.trim();
    }
    return '';
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part.trim()) {
        texts.push(part.trim());
      }
      continue;
    }
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      continue;
    }
    const row = part as Record<string, unknown>;
    const type = typeof row.type === 'string' ? row.type.trim().toLowerCase() : '';
    const textField = row.text;
    if (typeof textField === 'string' && textField.trim()) {
      texts.push(textField.trim());
      continue;
    }
    if (
      textField &&
      typeof textField === 'object' &&
      !Array.isArray(textField)
    ) {
      const value = (textField as Record<string, unknown>).value;
      if (typeof value === 'string' && value.trim()) {
        texts.push(value.trim());
        continue;
      }
    }
    if ((type === 'text' || type === 'input_text' || type === 'output_text') && typeof row.content === 'string' && row.content.trim()) {
      texts.push(row.content.trim());
    }
  }
  return texts.join('\n').trim();
}

/**
 * 提取最后一条 user message 的文本
 */
export function extractLastUserMessageText(messages: JsonObject[]): string {
  if (!Array.isArray(messages) || messages.length === 0) {
    return '';
  }

  // 从后向前扫描，找到最后一条 user message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      continue;
    }
    const role = (msg as { role?: unknown }).role;
    if (typeof role !== 'string' || role.trim().toLowerCase() !== 'user') {
      continue;
    }
    return extractMessageText(msg);
  }
  return '';
}

/**
 * 从 message 对象提取文本
 */
function extractMessageText(msg: JsonObject): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') {
        texts.push(part);
      } else if (part && typeof part === 'object' && !Array.isArray(part)) {
        const type = (part as { type?: unknown }).type;
        if (typeof type === 'string' && type.toLowerCase() === 'text') {
          const text = (part as { text?: unknown }).text;
          if (typeof text === 'string') {
            texts.push(text);
          }
        }
      }
    }
    return texts.join('\n').trim();
  }
  return '';
}

/**
 * 从 OpenAI Responses input 提取用户文本
 */
function extractUserTextFromResponsesInput(input: unknown): string {
  if (typeof input === 'string') {
    return input.trim();
  }
  if (!input) {
    return '';
  }
  if (Array.isArray(input)) {
    for (let i = input.length - 1; i >= 0; i -= 1) {
      const text = extractUserTextFromResponsesInputItem(input[i]);
      if (text) {
        return text;
      }
    }
    return '';
  }
  if (typeof input === 'object') {
    return extractUserTextFromResponsesInputItem(input);
  }
  return '';
}

function extractUserTextFromResponsesInputItem(item: unknown): string {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return '';
  }
  const row = item as Record<string, unknown>;
  const type = typeof row.type === 'string' ? row.type.trim().toLowerCase() : '';
  const role = typeof row.role === 'string' ? row.role.trim().toLowerCase() : '';
  if (type === 'message') {
    if (role && role !== 'user') {
      return '';
    }
    return extractMessageTextFromResponsesContent(row.content);
  }
  if (role && role !== 'user') {
    return '';
  }
  return extractMessageTextFromResponsesContent(row.content ?? row);
}

function extractMessageTextFromResponsesContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      texts.push(part);
      continue;
    }
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      continue;
    }
    const entry = part as Record<string, unknown>;
    const type = typeof entry.type === 'string' ? entry.type.trim().toLowerCase() : '';
    if (type === 'input_text' || type === 'text') {
      const text = entry.text;
      if (typeof text === 'string' && text.trim()) {
        texts.push(text.trim());
      }
    }
  }
  return texts.join('\n').trim();
}

/**
 * 从 rawRequest 提取用户文本（兼容 chat / responses）
 */
export function extractUserTextFromRequest(rawRequest: JsonObject): string {
  if (!rawRequest || typeof rawRequest !== 'object' || Array.isArray(rawRequest)) {
    return '';
  }
  const row = rawRequest as Record<string, unknown>;
  const messages = Array.isArray(row.messages) ? (row.messages as JsonObject[]) : undefined;
  if (messages && messages.length) {
    return extractLastUserMessageText(messages);
  }
  if (typeof row.prompt === 'string') {
    return row.prompt.trim();
  }
  if (row.input) {
    return extractUserTextFromResponsesInput(row.input);
  }
  return '';
}

/**
 * 从 response 提取 assistant 文本
 */
export function extractAssistantTextFromResponse(response: JsonObject): string {
  // 优先支持 chat-completions 结构
  const choices = (response as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    // 尝试从 responses 结构提取
    const outputs = (response as { output?: unknown }).output;
    if (!Array.isArray(outputs) || outputs.length === 0) {
      return '';
    }
    // responses: output[].content[].text
    for (const item of outputs) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        continue;
      }
      const content = (item as { content?: unknown; text?: unknown }).content ?? (item as { text?: unknown }).text;
      const extracted = extractTextFromAssistantMessageContent(content);
      if (extracted) {
        return extracted;
      }
    }
    return '';
  }
  const first = choices[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    return '';
  }
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return '';
  }
  const content = (message as { content?: unknown }).content;
  const extracted = extractTextFromAssistantMessageContent(content);
  if (extracted) {
    return extracted;
  }
  const refusal = (message as { refusal?: unknown }).refusal;
  if (typeof refusal === 'string' && refusal.trim()) {
    return refusal.trim();
  }
  return '';
}

/**
 * 提取 finish_reason
 */
export function extractFinishReason(response: JsonObject): string | undefined {
  const choices = (response as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }
  const first = choices[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    return undefined;
  }
  const finishReason = (first as { finish_reason?: unknown }).finish_reason;
  if (typeof finishReason === 'string') {
    return finishReason.trim();
  }
  return undefined;
}

/**
 * 生成 CACHE.md 条目
 */
function buildCacheEntry(options: CacheWriteOptions): string {
  const timestamp = new Date(options.timestampMs);
  const dateStr = timestamp.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const timeOnly = timestamp.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  const lines: string[] = [];
  const roleLabel = options.role === 'user' ? 'User' : 'Assistant';
  lines.push(`### ${roleLabel} · ${dateStr} ${timeOnly}`);

  // 内容缩略（避免过长）
  const maxContentLength = 2000;
  let content = options.content;
  if (content.length > maxContentLength) {
    content = content.slice(0, maxContentLength) + '... [truncated]';
  }

  lines.push('');
  lines.push(content);
  lines.push('');
  lines.push('<!-- cache-meta');
  lines.push(`requestId: ${options.requestId}`);
  if (options.sessionId) {
    lines.push(`sessionId: ${options.sessionId}`);
  }
  if (options.metadata?.model) {
    lines.push(`model: ${options.metadata.model}`);
  }
  if (options.metadata?.providerProtocol) {
    lines.push(`provider: ${options.metadata.providerProtocol}`);
  }
  if (options.metadata?.finishReason) {
    lines.push(`finishReason: ${options.metadata.finishReason}`);
  }
  lines.push('-->');

  return lines.join('\n');
}

/**
 * 确保目录存在
 */
function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // 忽略 mkdir 失败
  }
}

function normalizeCacheContentForDedup(value: string): string {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function extractLastCacheEntry(existingContent: string): ParsedCacheEntry | undefined {
  const source = String(existingContent || '');
  if (!source.trim()) {
    return undefined;
  }

  const marker = '\n### ';
  const lastMarkerIndex = source.lastIndexOf(marker);
  const block =
    lastMarkerIndex >= 0
      ? source.slice(lastMarkerIndex + 1).trim()
      : source.trimStart().startsWith('### ')
        ? source.trim()
        : '';
  if (!block) {
    return undefined;
  }

  const lines = block.split('\n');
  const header = String(lines[0] || '').trim();
  const role =
    header.startsWith('### User')
      ? 'user'
      : header.startsWith('### Assistant')
        ? 'assistant'
        : undefined;
  if (!role) {
    return undefined;
  }

  const blankLineIndex = lines.findIndex((line, index) => index > 0 && !String(line).trim());
  let content =
    blankLineIndex >= 0
      ? lines.slice(blankLineIndex + 1).join('\n').trim()
      : '';
  const metaCommentIndex = content.indexOf('\n<!-- cache-meta');
  if (metaCommentIndex >= 0) {
    content = content.slice(0, metaCommentIndex).trimEnd();
  } else if (content.startsWith('<!-- cache-meta')) {
    content = '';
  }
  return {
    role,
    content
  };
}

function shouldSkipDuplicateRequestWrite(existingContent: string, nextContent: string): boolean {
  const lastEntry = extractLastCacheEntry(existingContent);
  if (!lastEntry || lastEntry.role !== 'user') {
    return false;
  }
  return normalizeCacheContentForDedup(lastEntry.content) === normalizeCacheContentForDedup(nextContent);
}

/**
 * 写入 CACHE.md
 *
 * 错误处理：console.error 报告，返回失败结果，不抛异常
 */
export function writeCacheEntry(options: CacheWriteOptions): CacheWriteResult {
  try {
    // 1. 验证必填字段
    if (!options.workingDirectory) {
      console.error(`[cache-writer] skip: no workingDirectory for requestId=${options.requestId}`);
      return { ok: false, reason: 'no_working_directory' };
    }

    if (!options.content || !options.content.trim()) {
      console.error(`[cache-writer] skip: no content for requestId=${options.requestId}`);
      return { ok: false, reason: 'no_content' };
    }

    // 2. 构建路径
    const cachePath = path.join(options.workingDirectory, 'CACHE.md');

    // 3. 生成条目
    const entry = buildCacheEntry(options);

    // 4. 读取现有内容（如果存在）
    let existingContent = '';
    try {
      existingContent = fs.readFileSync(cachePath, 'utf-8');
    } catch {
      // 文件不存在，正常
    }

    if (options.type === 'request' && options.role === 'user') {
      if (shouldSkipDuplicateRequestWrite(existingContent, options.content)) {
        return { ok: true, path: cachePath };
      }
    }

    // 5. 确保头部存在
    let finalContent = existingContent;
    if (!existingContent.includes('# Conversation Cache')) {
      finalContent = `# Conversation Cache\n\n## Short-term Memory\n\n` + existingContent;
    }

    // 6. 追加条目
    finalContent = finalContent.trimEnd() + '\n\n' + entry + '\n';

    // 7. 确保目录存在
    ensureDir(path.dirname(cachePath));

    // 8. 写入文件
    fs.writeFileSync(cachePath, finalContent, 'utf-8');

    return { ok: true, path: cachePath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[cache-writer] write failed for requestId=${options.requestId}: ${message}`);
    return { ok: false, reason: `write_error: ${message}` };
  }
}

/**
 * 从 adapterContext 解析工作目录，失败时回退到 process.cwd()
 * CLI/TTY 模式直接使用 process.cwd()，不需要 metadata 注入
 */
export function resolveWorkingDirectoryFromAdapterContextOrFallback(adapterContext: Record<string, unknown>): string | undefined {
  return resolveWorkingDirectoryFromAdapterContext(adapterContext);
}

function readTrimmed(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  return undefined;
}

/**
 * 是否应该输出“no workingDirectory”告警日志
 *
 * 默认仅在“看起来是 tmux/session 注入链路请求”时打印，避免对普通 API 请求产生噪音。
 * 可通过环境变量强制开启：ROUTECODEX_LOG_CACHE_NO_WORKDIR_SKIP=1 / RCC_LOG_CACHE_NO_WORKDIR_SKIP=1
 */
export function shouldLogNoWorkingDirectorySkip(adapterContext: Record<string, unknown>): boolean {
  const forceRaw = String(
    process.env.ROUTECODEX_LOG_CACHE_NO_WORKDIR_SKIP
      ?? process.env.RCC_LOG_CACHE_NO_WORKDIR_SKIP
      ?? ''
  ).trim().toLowerCase();
  if (forceRaw === '1' || forceRaw === 'true' || forceRaw === 'yes' || forceRaw === 'on') {
    return true;
  }

  const candidates = [
    'tmuxSessionId',
    'clientTmuxSessionId',
    'tmux_session_id',
    'client_tmux_session_id',
    'stopMessageClientInjectSessionScope'
  ];
  for (const key of candidates) {
    const value = readTrimmed(adapterContext[key]);
    if (!value) {
      continue;
    }
    if (key === 'stopMessageClientInjectSessionScope') {
      if (value.startsWith('tmux:')) {
        return true;
      }
      continue;
    }
    return true;
  }

  const injectReady = readBoolean((adapterContext as { clientInjectReady?: unknown }).clientInjectReady);
  if (injectReady === true) {
    return true;
  }

  const rt = (adapterContext as { __rt?: unknown }).__rt;
  if (rt && typeof rt === 'object' && !Array.isArray(rt)) {
    const rtRecord = rt as Record<string, unknown>;
    for (const key of candidates) {
      const value = readTrimmed(rtRecord[key]);
      if (!value) {
        continue;
      }
      if (key === 'stopMessageClientInjectSessionScope') {
        if (value.startsWith('tmux:')) {
          return true;
        }
        continue;
      }
      return true;
    }
    const rtInjectReady = readBoolean((rtRecord as { clientInjectReady?: unknown }).clientInjectReady);
    if (rtInjectReady === true) {
      return true;
    }
  }

  return false;
}
