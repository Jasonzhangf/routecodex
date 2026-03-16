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

/**
 * 从 metadata 解析工作目录
 */
export function resolveWorkingDirectory(metadata: Record<string, unknown>): string | undefined {
  const candidates = ['cwd'];
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
  const candidates = ['cwd'];
  for (const key of candidates) {
    const value = adapterContext[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
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
 * 从 response 提取 assistant 文本
 */
export function extractAssistantTextFromResponse(response: JsonObject): string {
  const choices = (response as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
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
  if (typeof content === 'string') {
    return content.trim();
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
  lines.push(`- [${dateStr} ${timeOnly}] role=${options.role}`);

  if (options.metadata?.model) {
    lines.push(`  model: ${options.metadata.model}`);
  }
  if (options.metadata?.providerProtocol) {
    lines.push(`  provider: ${options.metadata.providerProtocol}`);
  }
  if (options.metadata?.finishReason) {
    lines.push(`  finishReason: ${options.metadata.finishReason}`);
  }

  // 内容缩略（避免过长）
  const maxContentLength = 2000;
  let content = options.content;
  if (content.length > maxContentLength) {
    content = content.slice(0, maxContentLength) + '... [truncated]';
  }

  // 缩进内容
  const indentedContent = content.split('\n').map(line => `  ${line}`).join('\n');
  lines.push(`  content: |`);
  lines.push(indentedContent);

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
export function resolveWorkingDirectoryFromAdapterContextOrFallback(adapterContext: Record<string, unknown>): string {
  const fromContext = resolveWorkingDirectoryFromAdapterContext(adapterContext);
  if (fromContext) {
    return fromContext;
  }
  // CLI/TTY 模式：直接使用 process.cwd()
  return process.cwd();
}
