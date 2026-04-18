import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readRuntimeMetadata } from '../../../conversion/runtime-metadata.js';
import { extractTextFromMessageContent } from './blocked-report.js';
import { appendServerToolProgressFileEvent } from '../../log/progress-file.js';
import { sanitizeFollowupSnapshotText, sanitizeFollowupText } from '../followup-sanitize.js';
import {
  resolveStopMessageAiApprovedMarker as resolveStopMessageAiApprovedMarkerFromConfig,
  resolveStopMessageAiDoneMarker as resolveStopMessageAiDoneMarkerFromConfig,
  resolveStopMessageAiFollowupBackend as resolveStopMessageAiFollowupBackendFromConfig,
  resolveStopMessageAiFollowupCommand as resolveStopMessageAiFollowupCommandFromConfig,
  resolveStopMessageAiFollowupEnabled as resolveStopMessageAiFollowupEnabledFromConfig,
  resolveStopMessageAiFollowupOutputMaxChars as resolveStopMessageAiFollowupOutputMaxCharsFromConfig,
  resolveStopMessageAiFollowupTimeoutMs as resolveStopMessageAiFollowupTimeoutMsFromConfig,
  resolveStopMessageAiRequireEvidence,
  resolveStopMessageAiRequireNextTaskAfterDone,
  resolveStopMessageAiTraceEnabled as resolveStopMessageAiTraceEnabledFromConfig
} from './config.js';

export interface StopMessageAutoResponseSnapshot {
  providerProtocol?: string;
  finishReason?: string;
  assistantText?: string;
  reasoningText?: string;
  responseExcerpt?: string;
}

const DEFAULT_STOP_MESSAGE_AI_DONE_MARKER = '[STOPMESSAGE_DONE]';
const DEFAULT_STOP_MESSAGE_AI_APPROVED_MARKER = '[STOPMESSAGE_APPROVED]';
const STOP_MESSAGE_AUTOMESSAGE_FOLLOWUP_TIMEOUT_MS = 300_000;
const STOP_MESSAGE_AUTOMESSAGE_FOLLOWUP_TIMEOUT_MAX_MS = 300_000;
const STOP_MESSAGE_AUTOMESSAGE_FOLLOWUP_TIMEOUT_TEST_CAP_MS = 800;
const STOP_MESSAGE_AUTOMESSAGE_PROMPT_MAX_CHARS = 18_000;
const STOP_MESSAGE_AUTOMESSAGE_OUTPUT_MAX_CHARS = 1_600;
const STOP_MESSAGE_AUTOMESSAGE_LOG_SUMMARY_MAX_CHARS = 200;
const ANSI_ESCAPE_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;
type StopMessageAutoMessageBackend = 'codex' | 'iflow';
export type StopMessageAiFollowupHistoryEntry = {
  ts?: number;
  round?: number;
  assistantText?: string;
  reasoningText?: string;
  responseExcerpt?: string;
  followupText?: string;
};

type StopMessageAiFollowupArgs = {
  baseStopMessageText: string;
  candidateFollowupText: string;
  responseSnapshot: StopMessageAutoResponseSnapshot;
  requestId?: string;
  sessionId?: string;
  providerKey?: string;
  model?: string;
  workingDirectory?: string;
  usedRepeats: number;
  maxRepeats: number;
  doneMarker?: string;
  approvedMarker?: string;
  completionClaimed?: boolean;
  isFirstPrompt?: boolean;
  historyEntries?: StopMessageAiFollowupHistoryEntry[];
};

type StopMessageAutoMessageAsyncResult = {
  status: number;
  stdout: string;
  stderr: string;
  error?: string;
};

function hasStandaloneMarkerLine(text: string, marker: string): boolean {
  const content = typeof text === 'string' ? text.trim() : '';
  const normalizedMarker = typeof marker === 'string' ? marker.trim() : '';
  if (!content || !normalizedMarker) {
    return false;
  }
  const escapedMarker = normalizedMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\n)\\s*${escapedMarker}\\s*(?=\\n|$)`).test(content);
}

function runStopMessageAutoMessageCommandAsync(options: {
  command: string;
  args: string[];
  timeoutMs: number;
  maxBuffer: number;
  cwd?: string;
}): Promise<StopMessageAutoMessageAsyncResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let bufferExceeded = false;
    let timer: NodeJS.Timeout | undefined;

    const finalize = (result: StopMessageAutoMessageAsyncResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      resolve(result);
    };

    const appendChunk = (stream: 'stdout' | 'stderr', chunk: unknown) => {
      const raw = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      if (!raw) {
        return;
      }
      if (stream === 'stdout') {
        stdout += raw;
      } else {
        stderr += raw;
      }
      if (stdout.length + stderr.length > options.maxBuffer) {
        bufferExceeded = true;
      }
    };

    let child: childProcess.ChildProcessWithoutNullStreams;
    try {
      child = childProcess.spawn(options.command, options.args, {
        ...(options.cwd ? { cwd: options.cwd } : {})
      });
    } catch (error) {
      finalize({
        status: -1,
        stdout,
        stderr,
        error: error instanceof Error ? error.message : String(error ?? 'spawn_failed')
      });
      return;
    }

    const safeTerminate = () => {
      try {
        if (!child.killed) {
          child.kill('SIGTERM');
        }
      } catch {
        // best-effort only
      }
      setTimeout(() => {
        try {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        } catch {
          // best-effort only
        }
      }, 120).unref?.();
    };

    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        safeTerminate();
      }, options.timeoutMs);
      timer.unref?.();
    }

    child.stdout?.on('data', (chunk) => {
      appendChunk('stdout', chunk);
      if (bufferExceeded) {
        safeTerminate();
      }
    });
    child.stderr?.on('data', (chunk) => {
      appendChunk('stderr', chunk);
      if (bufferExceeded) {
        safeTerminate();
      }
    });
    child.on('error', (error) => {
      finalize({
        status: -1,
        stdout,
        stderr,
        error: error instanceof Error ? error.message : String(error ?? 'spawn_error')
      });
    });
    child.on('close', (code) => {
      if (timedOut) {
        finalize({
          status: typeof code === 'number' ? code : -1,
          stdout,
          stderr,
          error: 'timeout'
        });
        return;
      }
      if (bufferExceeded) {
        finalize({
          status: typeof code === 'number' ? code : -1,
          stdout,
          stderr,
          error: 'max_buffer_exceeded'
        });
        return;
      }
      finalize({
        status: typeof code === 'number' ? code : -1,
        stdout,
        stderr
      });
    });
  });
}

export function renderStopMessageAutoFollowupViaAi(args: StopMessageAiFollowupArgs): string | null {
  if (!isStopMessageAutoMessageEnabled()) {
    return null;
  }
  const backendOrder = resolveStopMessageAutoMessageBackendOrder();
  const maxOutputChars = resolveStopMessageAutoMessageOutputMaxChars();
  const workingDirectory = resolveStopMessageAutoMessageWorkingDirectory(args.workingDirectory);
  for (const backend of backendOrder) {
    const command = resolveStopMessageAutoMessageCommand(backend);
    if (!command) {
      continue;
    }
    const prompt = buildStopMessageAutoMessagePrompt(args, backend);
    if (!prompt) {
      continue;
    }
    const timeoutMs = resolveStopMessageAutoMessageTimeoutMs(backend);
    const profileOrder = backend === 'codex' ? resolveStopMessageAutoMessageCodexProfileOrder() : [undefined];
    for (const codexProfile of profileOrder) {
      const invocation = createStopMessageAutoMessageInvocation(backend, prompt, codexProfile);
      const backendLabel = backend === 'codex' ? `codex:${codexProfile || 'default'}` : backend;
      const requestSummary = summarizeStopMessageAutoMessageLog(
        [
          `base=${args.baseStopMessageText || ''}`,
          `candidate=${args.candidateFollowupText || ''}`,
          `assistant=${args.responseSnapshot.assistantText || ''}`,
          `reasoning=${args.responseSnapshot.reasoningText || ''}`,
          `completionClaimed=${args.completionClaimed === true ? 'yes' : 'no'}`,
          `backend=${backendLabel}`,
          `cwd=${workingDirectory || 'n/a'}`
        ].join(' | '),
        STOP_MESSAGE_AUTOMESSAGE_LOG_SUMMARY_MAX_CHARS
      );
      logStopMessageAutoMessage({
        requestId: args.requestId,
        stage: 'request',
        requestSummary
      });
      try {
        const result = childProcess.spawnSync(
          command,
          invocation.args,
          {
            encoding: 'utf8',
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024,
            ...(workingDirectory ? { cwd: workingDirectory } : {})
          }
        );

        if (result.error || result.status !== 0) {
          const responseSummary = summarizeStopMessageAutoMessageLog(
            sanitizeStopMessageAutoMessageOutput(result.stderr || result.stdout, STOP_MESSAGE_AUTOMESSAGE_OUTPUT_MAX_CHARS),
            STOP_MESSAGE_AUTOMESSAGE_LOG_SUMMARY_MAX_CHARS
          );
          logStopMessageAutoMessage({
            requestId: args.requestId,
            stage: 'response',
            status: result.status ?? -1,
            requestSummary,
            responseSummary,
            error: result.error ? String(result.error) : 'non_zero_exit'
          });
          continue;
        }

        const backendOutput =
          backend === 'codex'
            ? sanitizeStopMessageAutoMessageOutput(readStopMessageAutoMessageCodexOutput(invocation.outputFilePath), maxOutputChars)
            : '';
        const stdout = backendOutput || sanitizeStopMessageAutoMessageOutput(result.stdout, maxOutputChars);
        if (stdout) {
          const approvedMarker = resolveStopMessageAiApprovedMarker(args.approvedMarker);
          const normalizedOutput =
            backend === 'iflow' && !hasStandaloneMarkerLine(stdout, approvedMarker)
              ? sanitizeFollowupText(args.candidateFollowupText || args.baseStopMessageText || stdout) || stdout
              : stdout;
          logStopMessageAutoMessage({
            requestId: args.requestId,
            stage: 'response',
            status: result.status ?? 0,
            requestSummary,
            responseSummary: summarizeStopMessageAutoMessageLog(normalizedOutput, STOP_MESSAGE_AUTOMESSAGE_LOG_SUMMARY_MAX_CHARS)
          });
          return normalizedOutput;
        }
        const stderr = sanitizeStopMessageAutoMessageOutput(result.stderr, maxOutputChars);
        logStopMessageAutoMessage({
          requestId: args.requestId,
          stage: 'response',
          status: result.status ?? 0,
          requestSummary,
          responseSummary: summarizeStopMessageAutoMessageLog(stderr, STOP_MESSAGE_AUTOMESSAGE_LOG_SUMMARY_MAX_CHARS)
        });
        if (stderr) {
          return stderr;
        }
      } catch (error) {
        logStopMessageAutoMessage({
          requestId: args.requestId,
          stage: 'response',
          status: -1,
          requestSummary,
          error: error instanceof Error ? error.message : String(error ?? 'unknown_error')
        });
      } finally {
        invocation.cleanup();
      }
    }
  }
  return null;
}

export async function renderStopMessageAutoFollowupViaAiAsync(args: StopMessageAiFollowupArgs): Promise<string | null> {
  if (!isStopMessageAutoMessageEnabled()) {
    return null;
  }
  const backendOrder = resolveStopMessageAutoMessageBackendOrder();
  const maxOutputChars = resolveStopMessageAutoMessageOutputMaxChars();
  const workingDirectory = resolveStopMessageAutoMessageWorkingDirectory(args.workingDirectory);
  for (const backend of backendOrder) {
    const command = resolveStopMessageAutoMessageCommand(backend);
    if (!command) {
      continue;
    }
    const prompt = buildStopMessageAutoMessagePrompt(args, backend);
    if (!prompt) {
      continue;
    }
    const timeoutMs = resolveStopMessageAutoMessageTimeoutMs(backend);
    const profileOrder = backend === 'codex' ? resolveStopMessageAutoMessageCodexProfileOrder() : [undefined];
    for (const codexProfile of profileOrder) {
      const invocation = createStopMessageAutoMessageInvocation(backend, prompt, codexProfile);
      const backendLabel = backend === 'codex' ? `codex:${codexProfile || 'default'}` : backend;
      const requestSummary = summarizeStopMessageAutoMessageLog(
        [
          `base=${args.baseStopMessageText || ''}`,
          `candidate=${args.candidateFollowupText || ''}`,
          `assistant=${args.responseSnapshot.assistantText || ''}`,
          `reasoning=${args.responseSnapshot.reasoningText || ''}`,
          `completionClaimed=${args.completionClaimed === true ? 'yes' : 'no'}`,
          `backend=${backendLabel}`,
          `cwd=${workingDirectory || 'n/a'}`
        ].join(' | '),
        STOP_MESSAGE_AUTOMESSAGE_LOG_SUMMARY_MAX_CHARS
      );
      logStopMessageAutoMessage({
        requestId: args.requestId,
        stage: 'request',
        requestSummary
      });
      try {
        const result = await runStopMessageAutoMessageCommandAsync({
          command,
          args: invocation.args,
          timeoutMs,
          maxBuffer: 1024 * 1024,
          ...(workingDirectory ? { cwd: workingDirectory } : {})
        });

        if (result.error || result.status !== 0) {
          const responseSummary = summarizeStopMessageAutoMessageLog(
            sanitizeStopMessageAutoMessageOutput(result.stderr || result.stdout, STOP_MESSAGE_AUTOMESSAGE_OUTPUT_MAX_CHARS),
            STOP_MESSAGE_AUTOMESSAGE_LOG_SUMMARY_MAX_CHARS
          );
          logStopMessageAutoMessage({
            requestId: args.requestId,
            stage: 'response',
            status: result.status ?? -1,
            requestSummary,
            responseSummary,
            error: result.error ? String(result.error) : 'non_zero_exit'
          });
          continue;
        }

        const backendOutput =
          backend === 'codex'
            ? sanitizeStopMessageAutoMessageOutput(readStopMessageAutoMessageCodexOutput(invocation.outputFilePath), maxOutputChars)
            : '';
        const stdout = backendOutput || sanitizeStopMessageAutoMessageOutput(result.stdout, maxOutputChars);
        if (stdout) {
          const approvedMarker = resolveStopMessageAiApprovedMarker(args.approvedMarker);
          const normalizedOutput =
            backend === 'iflow' && !hasStandaloneMarkerLine(stdout, approvedMarker)
              ? sanitizeFollowupText(args.candidateFollowupText || args.baseStopMessageText || stdout) || stdout
              : stdout;
          logStopMessageAutoMessage({
            requestId: args.requestId,
            stage: 'response',
            status: result.status ?? 0,
            requestSummary,
            responseSummary: summarizeStopMessageAutoMessageLog(normalizedOutput, STOP_MESSAGE_AUTOMESSAGE_LOG_SUMMARY_MAX_CHARS)
          });
          return normalizedOutput;
        }
        const stderr = sanitizeStopMessageAutoMessageOutput(result.stderr, maxOutputChars);
        logStopMessageAutoMessage({
          requestId: args.requestId,
          stage: 'response',
          status: result.status ?? 0,
          requestSummary,
          responseSummary: summarizeStopMessageAutoMessageLog(stderr, STOP_MESSAGE_AUTOMESSAGE_LOG_SUMMARY_MAX_CHARS)
        });
        if (stderr) {
          return stderr;
        }
      } catch (error) {
        logStopMessageAutoMessage({
          requestId: args.requestId,
          stage: 'response',
          status: -1,
          requestSummary,
          error: error instanceof Error ? error.message : String(error ?? 'unknown_error')
        });
      } finally {
        invocation.cleanup();
      }
    }
  }
  return null;
}

export function renderStopMessageAutoFollowupViaAiFollowup(args: StopMessageAiFollowupArgs): string | null {
  return renderStopMessageAutoFollowupViaAi(args);
}

export function extractStopMessageAutoResponseSnapshot(base: unknown, adapterContext: unknown): StopMessageAutoResponseSnapshot {
  const providerProtocol = extractStopMessageProviderProtocol(adapterContext);
  if (!base || typeof base !== 'object' || Array.isArray(base)) {
    return { ...(providerProtocol ? { providerProtocol } : {}) };
  }

  const payload = base as Record<string, unknown>;
  const choices = Array.isArray(payload.choices) ? (payload.choices as unknown[]) : [];
  if (choices.length > 0) {
    const targetChoice =
      choices.find((choice) => toNonEmptyText(asRecord(choice)?.finish_reason).toLowerCase() === 'stop') || choices[0];
    const choiceRecord = asRecord(targetChoice);
    const message = asRecord(choiceRecord?.message);
    const finishReason = toNonEmptyText(choiceRecord?.finish_reason).toLowerCase() || undefined;
    const assistantText = message ? extractStopMessageAssistantText(message) : '';
    const reasoningText = message ? extractStopMessageReasoningText(message) : '';
    return {
      ...(providerProtocol ? { providerProtocol } : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(assistantText ? { assistantText } : {}),
      ...(reasoningText ? { reasoningText } : {}),
      responseExcerpt: buildStopMessageResponseExcerpt(choiceRecord || payload)
    };
  }

  const anthropicContent = extractTextFromMessageContent(payload.content);
  const anthropicReasoning = extractStopMessageReasoningFromContent(payload.content);
  const anthropicFinishReason = toNonEmptyText(payload.stop_reason).toLowerCase() || undefined;

  const responsesText = extractResponsesOutputText(payload);
  const responsesReasoning = extractResponsesReasoningText(payload);
  const responseFinishReason =
    anthropicFinishReason ||
    toNonEmptyText(payload.finish_reason).toLowerCase() ||
    toNonEmptyText(payload.status).toLowerCase() ||
    undefined;

  const assistantText = dedupeAndJoinTexts([responsesText, anthropicContent]);
  const reasoningText = dedupeAndJoinTexts([responsesReasoning, anthropicReasoning]);

  return {
    ...(providerProtocol ? { providerProtocol } : {}),
    ...(responseFinishReason ? { finishReason: responseFinishReason } : {}),
    ...(assistantText ? { assistantText } : {}),
    ...(reasoningText ? { reasoningText } : {}),
    responseExcerpt: buildStopMessageResponseExcerpt(payload)
  };
}

export function extractResponsesOutputText(base: { [key: string]: unknown }): string {
  const raw = (base as { output_text?: unknown }).output_text;
  if (typeof raw === 'string') {
    return raw.trim();
  }
  if (Array.isArray(raw)) {
    const texts = raw
      .map((entry) => (typeof entry === 'string' ? entry : ''))
      .filter((entry) => entry.trim().length > 0);
    if (texts.length > 0) {
      return texts.join('\n').trim();
    }
  }
  const output = Array.isArray((base as { output?: unknown }).output) ? ((base as { output: unknown[] }).output) : [];
  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (typeof (item as { type?: unknown }).type !== 'string') continue;
    const type = String((item as { type: unknown }).type).trim().toLowerCase();
    if (type.includes('tool') || type.includes('function') || type.includes('call')) {
      const toolText =
        extractUnknownText((item as { input?: unknown }).input) ||
        extractUnknownText((item as { arguments?: unknown }).arguments) ||
        extractUnknownText((item as { args?: unknown }).args) ||
        extractUnknownText((item as { patch?: unknown }).patch) ||
        extractUnknownText(item);
      if (toolText) {
        chunks.push(toolText);
      }
      continue;
    }
    if (type !== 'message') continue;
    const content = Array.isArray((item as { content?: unknown }).content) ? ((item as { content: unknown[] }).content) : [];
    for (const part of content) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
      const pType = typeof (part as { type?: unknown }).type === 'string'
        ? String((part as { type: unknown }).type).trim().toLowerCase()
        : '';
      if (pType === 'output_text' || pType === 'text' || pType === 'input_text') {
        const text = typeof (part as { text?: unknown }).text === 'string' ? String((part as { text: unknown }).text) : '';
        if (text.trim().length) chunks.push(text.trim());
        continue;
      }
      const fallback =
        extractUnknownText((part as { text?: unknown }).text) ||
        extractUnknownText((part as { input?: unknown }).input) ||
        extractUnknownText((part as { arguments?: unknown }).arguments) ||
        extractUnknownText((part as { args?: unknown }).args) ||
        extractUnknownText((part as { patch?: unknown }).patch) ||
        extractUnknownText((part as { content?: unknown }).content) ||
        extractUnknownText((part as { value?: unknown }).value);
      if (fallback) {
        chunks.push(fallback);
      }
    }
  }
  return chunks.join('\n').trim();
}

export function hasToolLikeOutput(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const typeRaw = (value as { type?: unknown }).type;
  const type = typeof typeRaw === 'string' ? typeRaw.trim().toLowerCase() : '';
  if (!type) {
    return false;
  }
  return (
    type === 'tool_call' ||
    type === 'tool_use' ||
    type === 'function_call' ||
    type.includes('tool')
  );
}

function isStopMessageAutoMessageEnabled(): boolean {
  const raw = String(
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED ??
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_ENABLED ??
      ''
  )
    .trim()
    .toLowerCase();
  if (!raw) {
    // 默认关闭：只有显式配置/环境变量开启才启用 ai-followup。
    return false;
  }
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') {
    return false;
  }
  if (raw) {
    return true;
  }
  const fromConfig = resolveStopMessageAiFollowupEnabledFromConfig();
  if (typeof fromConfig === 'boolean') {
    return fromConfig;
  }
  return false;
}

function resolveStopMessageAutoMessageBackendOrder(): StopMessageAutoMessageBackend[] {
  const preferred = resolveStopMessageAutoMessageBackend();
  return [preferred];
}

function resolveStopMessageAutoMessageBackend(): StopMessageAutoMessageBackend {
  const raw = String(
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND ??
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_BACKEND ??
      ''
  ).trim().toLowerCase();
  if (raw === 'iflow') {
    return 'iflow';
  }
  if (raw === 'codex') {
    return 'codex';
  }
  const fromConfig = resolveStopMessageAiFollowupBackendFromConfig();
  if (fromConfig === 'iflow') {
    return 'iflow';
  }
  if (fromConfig === 'codex') {
    return 'codex';
  }
  return 'codex';
}

function normalizeCodexProfileToken(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.toLowerCase() === 'default' ? undefined : trimmed;
}

function resolveStopMessageAutoMessageCodexProfileOrder(): Array<string | undefined> {
  const primary = normalizeCodexProfileToken(
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_PROFILE ??
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_PROFILE ??
      ''
  );
  const backup =
    normalizeCodexProfileToken(
      process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BACKUP_PROFILE ??
        process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BACKUP_PROFILE ??
        ''
    ) ?? 'crsa';

  const seen = new Set<string>();
  const out: Array<string | undefined> = [];
  for (const profile of [primary, backup]) {
    const key = profile ?? '__default__';
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(profile);
  }
  return out.length > 0 ? out : [undefined];
}

function resolveStopMessageAutoMessageCommand(backend: StopMessageAutoMessageBackend): string {
  if (backend === 'iflow') {
    const iflowRaw = String(
      process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN ??
        process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN ??
        ''
    ).trim();
    if (iflowRaw) {
      return iflowRaw;
    }
    const fromConfig = resolveStopMessageAiFollowupCommandFromConfig(backend);
    return fromConfig && fromConfig.trim() ? fromConfig.trim() : '';
  }
  const codexRawFromEnv = String(
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN ??
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN ??
      ''
  ).trim();
  if (codexRawFromEnv) {
    return codexRawFromEnv;
  }
  const fromConfig = resolveStopMessageAiFollowupCommandFromConfig(backend);
  if (fromConfig && fromConfig.trim()) {
    return fromConfig.trim();
  }
  const codexRaw = String(
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN ??
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN ??
      ''
  ).trim();
  return codexRaw || 'codex';
}

function resolveStopMessageAutoMessageWorkingDirectory(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resolveStopMessageAutoMessageTimeoutMs(backend: StopMessageAutoMessageBackend): number {
  const timeoutFromConfig = resolveStopMessageAiFollowupTimeoutMsFromConfig();
  const raw = String(
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_TIMEOUT_MS ??
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_TIMEOUT_MS ??
      ''
  ).trim();
  const parsed = Number(raw);
  const explicitTimeoutRaw = Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : Number.isFinite(timeoutFromConfig) && Number(timeoutFromConfig) > 0
      ? Math.floor(Number(timeoutFromConfig))
      : STOP_MESSAGE_AUTOMESSAGE_FOLLOWUP_TIMEOUT_MS;
  const explicitTimeout = Math.max(200, Math.min(STOP_MESSAGE_AUTOMESSAGE_FOLLOWUP_TIMEOUT_MAX_MS, explicitTimeoutRaw));
  let resolvedTimeout = explicitTimeout;

  const explicitCommand = String(
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN ??
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN ??
      ''
  ).trim();
  const defaultCommand = 'codex';
  const usingDefaultCommand = !explicitCommand || explicitCommand === defaultCommand;
  if (process.env.JEST_WORKER_ID && usingDefaultCommand) {
    resolvedTimeout = Math.min(resolvedTimeout, STOP_MESSAGE_AUTOMESSAGE_FOLLOWUP_TIMEOUT_TEST_CAP_MS);
  }

  const followupTimeoutRaw = String(process.env.ROUTECODEX_SERVERTOOL_FOLLOWUP_TIMEOUT_MS || '').trim();
  const followupTimeoutParsed = Number(followupTimeoutRaw);
  if (Number.isFinite(followupTimeoutParsed) && followupTimeoutParsed > 0) {
    const boundedFollowupTimeout = Math.max(100, Math.min(STOP_MESSAGE_AUTOMESSAGE_FOLLOWUP_TIMEOUT_MAX_MS, Math.floor(followupTimeoutParsed)));
    resolvedTimeout = Math.min(resolvedTimeout, boundedFollowupTimeout);
  }
  return resolvedTimeout;
}

function createStopMessageAutoMessageInvocation(
  backend: StopMessageAutoMessageBackend,
  prompt: string,
  codexProfile?: string
): {
  args: string[];
  outputFilePath?: string;
  cleanup: () => void;
} {
  if (backend === 'iflow') {
    return {
      args: ['-p', prompt],
      cleanup: () => {
        // no-op
      }
    };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-stopmessage-codex-'));
  const outputFilePath = path.join(dir, 'last-message.txt');
  return {
    args: [
      'exec',
      '--color',
      'never',
      '--skip-git-repo-check',
      ...(codexProfile ? ['--profile', codexProfile] : []),
      '--output-last-message',
      outputFilePath,
      prompt
    ],
    outputFilePath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  };
}

function readStopMessageAutoMessageCodexOutput(outputFilePath: string | undefined): string {
  if (!outputFilePath) {
    return '';
  }
  try {
    return fs.readFileSync(outputFilePath, 'utf8');
  } catch {
    return '';
  }
}

function resolveStopMessageAutoMessageOutputMaxChars(): number {
  const outputMaxCharsFromConfig = resolveStopMessageAiFollowupOutputMaxCharsFromConfig();
  const raw = String(
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_OUTPUT_MAX_CHARS ??
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_OUTPUT_MAX_CHARS ??
      ''
  ).trim();
  const parsed = Number(raw);
  const resolved = Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : Number.isFinite(outputMaxCharsFromConfig) && Number(outputMaxCharsFromConfig) > 0
      ? Math.floor(Number(outputMaxCharsFromConfig))
      : STOP_MESSAGE_AUTOMESSAGE_OUTPUT_MAX_CHARS;
  return Math.max(128, Math.min(8_000, resolved));
}

function sanitizeStopMessageAutoMessageOutput(raw: unknown, maxChars: number): string {
  const text = typeof raw === 'string' ? raw : '';
  if (!text.trim()) {
    return '';
  }
  const withoutAnsi = text.replace(ANSI_ESCAPE_PATTERN, '');
  const withoutCodeFence = withoutAnsi
    .replace(/^```[a-zA-Z0-9_-]*\s*/g, '')
    .replace(/\s*```$/g, '');
  const cleaned = withoutCodeFence.trim();
  if (!cleaned) {
    return '';
  }
  const sanitized = sanitizeFollowupText(cleaned);
  if (!sanitized) {
    return '';
  }
  return sanitized.length > maxChars ? sanitized.slice(0, maxChars).trim() : sanitized;
}

function truncateStopMessageAutoMessagePrompt(value: string, maxChars: number): string {
  const text = sanitizeFollowupSnapshotText(value);
  if (!text) {
    return '';
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}...`;
}

function buildStopMessageAutoMessagePrompt(args: {
  baseStopMessageText: string;
  candidateFollowupText: string;
  responseSnapshot: StopMessageAutoResponseSnapshot;
  requestId?: string;
  sessionId?: string;
  providerKey?: string;
  model?: string;
  workingDirectory?: string;
  usedRepeats: number;
  maxRepeats: number;
  doneMarker?: string;
  approvedMarker?: string;
  completionClaimed?: boolean;
  isFirstPrompt?: boolean;
  historyEntries?: StopMessageAiFollowupHistoryEntry[];
}, backend: StopMessageAutoMessageBackend): string {
  const usedRepeats = Math.max(0, Math.floor(args.usedRepeats));
  const maxRepeats = Math.max(0, Math.floor(args.maxRepeats));
  const nextRound = usedRepeats + 1;
  const roundsLabel = maxRepeats > 0 ? `${nextRound}/${maxRepeats}` : `${nextRound}/n/a`;
  const remaining = maxRepeats > 0 ? Math.max(0, maxRepeats - nextRound) : 0;
  const overallGoal =
    (typeof args.candidateFollowupText === 'string' && args.candidateFollowupText.trim()) ||
    (typeof args.baseStopMessageText === 'string' && args.baseStopMessageText.trim()) ||
    '继续执行';
  const approvedMarker = resolveStopMessageAiApprovedMarker(args.approvedMarker);
  const completionClaimed = args.completionClaimed === true;
  const isFirstPrompt = Boolean(args.isFirstPrompt);
  const historyBlock = renderStopMessageAiHistoryEntries(args.historyEntries);
  const requireEvidence = resolveStopMessageAiRequireEvidence();
  const requireNextTaskAfterDone = resolveStopMessageAiRequireNextTaskAfterDone();
  const lines: string[] = [
    isFirstPrompt
      ? '你是 RouteCodex 的 ai-followup 生成器（首次引导）。'
      : '你是 RouteCodex 的 ai-followup 生成器（续轮系统约束）。',
    '角色定位：你是“执行审稿人（reviewer）”，默认做审慎核验但不要吹毛求疵，仍以证据驱动判断。',
    '任务：根据“短期目标（用户输入） + 当前执行进度 + 模型反馈消息内容 + 历史记录（xxx）”，生成下一步用户 followup 消息。',
    isFirstPrompt ? '首次提示词（完整规则）:' : '续轮系统提示词（延续同一目标）:',
    '1) 只输出一段可直接注入的用户消息文本；不要解释、不要 JSON、不要代码块。',
    '1.1) 输出目标固定为：根据当前状态调整后的下一步 followup 消息文本。',
    '2) 模型反馈=消息内容（assistantText/reasoningText/responseExcerpt）；你的指令必须基于这些实际内容，不得凭空编造状态。',
    ...(requireEvidence
      ? ['2.1) 默认要求主模型给出可核验的证据（文件/命令/日志/测试），你只允许基于证据判断下一步。']
      : []),
    '3) 先做代码 review（最多一句），再给指令：必须结合 workingDirectory 下当前实现/测试/构建状态给出建议；不能只做抽象建议。',
    '3.1) 主模型若声明“完成了某项”，优先核验与 overallGoal 直接相关的关键项；非关键分支/小目标可记录为后续补充验证，不必阻塞推进。',
    '3.2) 通过标准以“总体目标是否达成”为主；当主目标证据充分时，允许次要项暂未验证，并给出后续补测建议。',
    '3.3) 若主模型声称“无法完成/被阻塞”，你必须要求其提供阻塞证据，并判断是否存在可继续推进的最小可执行动作。',
    '3.4) 必要时必须要求其打开并检查已改代码（明确到文件），再给出具体修改建议，不允许停留在抽象层面。',
    '3.5) 必须先根据本次请求逐条核验（目标/范围/约束）后再给建议：至少引用一个代码证据（文件路径+关键实现点），若涉及行为变更还要引用测试/命令证据或明确说明未执行原因。',
    '3.6) 禁止“先给建议、后补证据”；核验结论必须先于建议给出，且每条建议都要可追溯到对应证据。',
    '4) 必须包含至少一个可执行动作（具体文件、命令、检查点或验证目标），并尽量最小化下一步范围；优先“写动作”（改代码/补测试）。',
    '5) 禁止输出空泛短答：如“继续”“继续执行”“好的”“收到”“ok”。',
    '6) 禁止把回复做成纯状态汇总；默认是推进执行，直到阶段目标或总体目标完成。',
    '7) 只有在消息内容或历史记录里存在明确证据时，才允许判断“偏离目标”；否则按同轨推进，不要泛化指责偏离。',
    '8) 若判定偏离，必须在指令里点明证据来源（来自消息内容或历史记录）并给出回轨的最小动作；若无证据，直接给下一步动作。',
    '9) 禁止把 review 责任交回主模型（例如“请你先自己 review/自查代码”）；review 必须由你（ai-followup）先完成。',
    '10) 禁止连续安排纯只读/纯汇报命令（如 cargo llvm-cov report、cat/head/tail/rg/git status）；若上一轮没有代码修改证据，本轮必须先给出写动作（修改文件或新增测试），再允许验证命令。',
    '11) 覆盖率类命令只能作为写动作后的验证步骤，不能作为本轮唯一或首要动作。',
    completionClaimed
      ? '12) 参考信号：主模型本轮声称“已完成”，但你必须独立核验，不能直接采信。'
      : '12) 主模型未显式声称完成；你仍可基于证据独立判断是否达成总体目标。',
    `13) 当关键路径证据充分且确认已完成总体目标时，允许只输出 ${approvedMarker} 作为完成信号；若仅剩非关键小项未验证，也可判定通过并建议后续补齐。`,
    ...(requireNextTaskAfterDone
      ? ['13.1) 一旦确认当前任务完成，必须要求主模型明确“下一步任务”并继续执行，不允许停在完成口播。']
      : []),
    `14) 若证据不足或主目标未达成，严禁输出 ${approvedMarker}。`,
    '',
    '本轮注入上下文（必须参考）：',
    `overallGoal(短期目标): ${overallGoal}`,
    '',
    `baseStopMessage: ${args.baseStopMessageText || 'n/a'}`,
    `candidateFollowup: ${args.candidateFollowupText || 'n/a'}`,
    `repeat: ${roundsLabel}`,
    `progress: used=${usedRepeats} next=${nextRound} max=${maxRepeats > 0 ? maxRepeats : 'n/a'} remaining=${maxRepeats > 0 ? remaining : 'n/a'}`,
    `requestId: ${args.requestId || 'n/a'}`,
    `sessionId: ${args.sessionId || 'n/a'}`,
    `providerKey: ${args.providerKey || 'n/a'}`,
    `model: ${args.model || 'n/a'}`,
    `workingDirectory: ${args.workingDirectory || 'n/a'}`,
    `completionClaimedByMainModel: ${completionClaimed ? 'yes' : 'no'}`,
    `reviewApprovedMarker: ${approvedMarker}`,
    'historyRecord(xxx): 见下方 stopMessage 历史轨迹',
    'modelFeedback(消息内容): 见下方 assistantText/reasoningText/responseExcerpt',
    '',
    'stopMessage 历史轨迹（最近轮次，按时间升序）：',
    historyBlock,
    '',
    '当前模型反馈（结构化摘录）：',
    `responseProtocol: ${args.responseSnapshot.providerProtocol || 'n/a'}`,
    `finishReason: ${args.responseSnapshot.finishReason || 'n/a'}`,
    '',
    'assistantText:',
    truncateStopMessageAutoMessagePrompt(args.responseSnapshot.assistantText || 'n/a', 3_600),
    '',
    'reasoningText:',
    truncateStopMessageAutoMessagePrompt(args.responseSnapshot.reasoningText || 'n/a', 3_600),
    '',
    'responseExcerpt:',
    truncateStopMessageAutoMessagePrompt(args.responseSnapshot.responseExcerpt || 'n/a', 6_000)
  ];

  const closingInstruction =
    `现在做完成校验：若确认已完成，仅输出 ${approvedMarker}；否则输出“根据当前状态调整后的下一步 followup 消息文本”。`;
  lines.push('', closingInstruction);
  const prompt = lines.join('\n').trim();
  if (prompt.length <= STOP_MESSAGE_AUTOMESSAGE_PROMPT_MAX_CHARS) {
    return prompt;
  }
  const reserve = closingInstruction.length + 4;
  if (STOP_MESSAGE_AUTOMESSAGE_PROMPT_MAX_CHARS <= reserve + 32) {
    return truncateStopMessageAutoMessagePrompt(prompt, STOP_MESSAGE_AUTOMESSAGE_PROMPT_MAX_CHARS);
  }
  const headLimit = STOP_MESSAGE_AUTOMESSAGE_PROMPT_MAX_CHARS - reserve - 3;
  const head = prompt.slice(0, headLimit).trimEnd();
  return `${head}...\n\n${closingInstruction}`;
}

export function buildStopMessageAutoMessagePromptForTests(
  args: StopMessageAiFollowupArgs,
  backend: StopMessageAutoMessageBackend = 'codex'
): string {
  return buildStopMessageAutoMessagePrompt(args, backend);
}

function renderStopMessageAiHistoryEntries(
  entries: StopMessageAiFollowupHistoryEntry[] | undefined
): string {
  if (!Array.isArray(entries) || entries.length === 0) {
    return '- (empty)';
  }
  const normalized = entries
    .slice(-8)
    .map((entry) => {
      const round = Number.isFinite(entry?.round as number) ? Math.max(0, Math.floor(entry.round as number)) : 0;
      const assistant = truncateStopMessageAutoMessagePrompt(String(entry?.assistantText || ''), 280);
      const followup = truncateStopMessageAutoMessagePrompt(String(entry?.followupText || ''), 280);
      const reasoning = truncateStopMessageAutoMessagePrompt(String(entry?.reasoningText || ''), 220);
      const parts = [
        `round=${round || 'n/a'}`,
        assistant ? `assistant=${assistant}` : '',
        reasoning ? `reasoning=${reasoning}` : '',
        followup ? `followup=${followup}` : ''
      ].filter(Boolean);
      return `- ${parts.join(' | ')}`;
    })
    .filter((line) => line.trim().length > 0);
  return normalized.length > 0 ? normalized.join('\n') : '- (empty)';
}

function summarizeStopMessageAutoMessageLog(value: unknown, maxChars: number): string {
  const text = typeof value === 'string' ? value : '';
  if (!text.trim()) {
    return '';
  }
  const singleLine = text
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (singleLine.length <= maxChars) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxChars)}...`;
}

export function resolveStopMessageAiDoneMarker(value?: string): string {
  const explicit = typeof value === 'string' && value.trim() ? value.trim() : '';
  if (explicit) {
    return explicit;
  }
  const fromConfig = resolveStopMessageAiDoneMarkerFromConfig();
  if (fromConfig && fromConfig.trim()) {
    return fromConfig.trim();
  }
  const envValue = String(process.env.ROUTECODEX_STOPMESSAGE_AI_DONE_MARKER || '').trim();
  if (envValue) {
    return envValue;
  }
  return DEFAULT_STOP_MESSAGE_AI_DONE_MARKER;
}

export function resolveStopMessageAiApprovedMarker(value?: string): string {
  const explicit = typeof value === 'string' && value.trim() ? value.trim() : '';
  if (explicit) {
    return explicit;
  }
  const fromConfig = resolveStopMessageAiApprovedMarkerFromConfig();
  if (fromConfig && fromConfig.trim()) {
    return fromConfig.trim();
  }
  const envValue = String(process.env.ROUTECODEX_STOPMESSAGE_AI_APPROVED_MARKER || '').trim();
  if (envValue) {
    return envValue;
  }
  return DEFAULT_STOP_MESSAGE_AI_APPROVED_MARKER;
}

function isStopMessageAutoMessageTraceEnabled(): boolean {
  const fromConfig = resolveStopMessageAiTraceEnabledFromConfig();
  if (typeof fromConfig === 'boolean') {
    return fromConfig;
  }
  const raw = String(
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_TRACE ??
      ''
  ).trim().toLowerCase();
  if (!raw) {
    return true;
  }
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') {
    return false;
  }
  return true;
}

function logStopMessageAutoMessage(args: {
  requestId?: string;
  stage: 'request' | 'response';
  requestSummary?: string;
  responseSummary?: string;
  status?: number;
  error?: string;
}): void {
  const requestId = args.requestId && args.requestId.trim() ? args.requestId.trim() : 'unknown';
  const stage = args.stage;
  const statusToken = typeof args.status === 'number' ? ` status=${args.status}` : '';
  const errorToken = args.error ? ` error=${args.error}` : '';
  const requestSummary = args.requestSummary || '';
  const responseSummary = args.responseSummary || '';
  const eventMessage =
    stage === 'request'
      ? requestSummary
      : `${requestSummary}${requestSummary && (responseSummary || statusToken || errorToken) ? ' | ' : ''}${responseSummary}${statusToken}${errorToken}`.trim();
  const eventResult =
    stage === 'request'
      ? 'sent'
      : args.error || (typeof args.status === 'number' && args.status !== 0)
        ? 'failed'
        : 'completed';
  appendServerToolProgressFileEvent({
    requestId,
    flowId: 'stop_message_flow',
    tool: 'ai_followup',
    stage,
    result: eventResult,
    message: eventMessage,
    step: stage === 'request' ? 3 : 4
  });

  if (!isStopMessageAutoMessageTraceEnabled()) {
    return;
  }
  const requestIdPart = args.requestId ? ` requestId=${args.requestId}` : '';
  try {
    if (args.stage === 'request') {
      const request = args.requestSummary || '';
      // cyan: outbound request summary
      // eslint-disable-next-line no-console
      console.log(`\x1b[38;5;45m[servertool][ai-followup] SEND${requestIdPart} ${request}\x1b[0m`);
      return;
    }

    const response = args.responseSummary || '';
    if (args.error || (typeof args.status === 'number' && args.status !== 0)) {
      const statusPart = typeof args.status === 'number' ? ` status=${args.status}` : '';
      const errorPart = args.error ? ` error=${args.error}` : '';
      // red: failed response summary
      // eslint-disable-next-line no-console
      console.log(`\x1b[38;5;196m[servertool][ai-followup] RECV${requestIdPart}${statusPart}${errorPart} ${response}\x1b[0m`);
      return;
    }

    // green: successful response summary
    // eslint-disable-next-line no-console
    console.log(`\x1b[38;5;46m[servertool][ai-followup] RECV${requestIdPart} ${response}\x1b[0m`);
  } catch {
    // ignore logging failures
  }
}

function extractStopMessageProviderProtocol(adapterContext: unknown): string | undefined {
  const direct = toNonEmptyText(asRecord(adapterContext)?.providerProtocol);
  if (direct) {
    return direct;
  }
  const runtime = readRuntimeMetadata(asRecord(adapterContext) || {});
  const fromRuntime = toNonEmptyText(asRecord(runtime)?.providerProtocol);
  return fromRuntime || undefined;
}

function extractStopMessageAssistantText(message: Record<string, unknown>): string {
  const chunks: string[] = [];
  const contentText = extractTextFromMessageContent(message.content);
  if (contentText) {
    chunks.push(contentText);
  }
  const directKeys = [
    'text',
    'output_text',
    'response',
    'summary',
    'message',
    'result',
    'command',
    'patch'
  ];
  for (const key of directKeys) {
    const text = extractUnknownText(message[key]);
    if (text) {
      chunks.push(text);
    }
  }
  const toolLikeKeys = [
    'tool_calls',
    'tool_call',
    'function_call',
    'tool_use',
    'input',
    'arguments',
    'args',
    'payload'
  ];
  for (const key of toolLikeKeys) {
    const text = extractUnknownText(message[key]);
    if (text) {
      chunks.push(text);
    }
  }
  return sanitizeFollowupSnapshotText(dedupeAndJoinTexts(chunks));
}

function extractStopMessageReasoningText(message: Record<string, unknown>): string {
  const explicitKeys = [
    'reasoning_content',
    'reasoning',
    'reasoning_text',
    'thinking',
    'thought',
    'analysis'
  ];
  const chunks: string[] = [];
  for (const key of explicitKeys) {
    const text = extractUnknownText(message[key]);
    if (text) {
      chunks.push(text);
    }
  }

  const contentReasoning = extractStopMessageReasoningFromContent(message.content);
  if (contentReasoning) {
    chunks.push(contentReasoning);
  }

  return sanitizeFollowupSnapshotText(dedupeAndJoinTexts(chunks));
}

function extractResponsesReasoningText(payload: Record<string, unknown>): string {
  const chunks: string[] = [];
  const directReasoning = extractUnknownText(payload.reasoning);
  if (directReasoning) {
    chunks.push(directReasoning);
  }

  const output = Array.isArray(payload.output) ? (payload.output as unknown[]) : [];
  for (const item of output) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const type = toNonEmptyText(record.type).toLowerCase();
    if (type.includes('reason') || type.includes('think') || type.includes('analysis')) {
      const text = extractUnknownText(record.summary) || extractUnknownText(record.content) || extractUnknownText(record.text);
      if (text) {
        chunks.push(text);
      }
      continue;
    }
    if (type === 'message') {
      const contentReasoning = extractStopMessageReasoningFromContent(record.content);
      if (contentReasoning) {
        chunks.push(contentReasoning);
      }
    }
  }

  return sanitizeFollowupSnapshotText(dedupeAndJoinTexts(chunks));
}

function extractStopMessageReasoningFromContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  const chunks: string[] = [];
  for (const item of content) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const type = toNonEmptyText(record.type).toLowerCase();
    if (!type.includes('reason') && !type.includes('think') && !type.includes('analysis')) {
      continue;
    }
    const text =
      extractUnknownText(record.text) ||
      extractUnknownText(record.summary) ||
      extractUnknownText(record.content) ||
      extractUnknownText(record.value);
    if (text) {
      chunks.push(text);
    }
  }
  return sanitizeFollowupSnapshotText(dedupeAndJoinTexts(chunks));
}

function extractUnknownText(value: unknown, depth = 0): string {
  if (depth > 4 || value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return sanitizeFollowupSnapshotText(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return sanitizeFollowupSnapshotText(String(value));
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
    'summary',
    'reasoning',
    'thinking',
    'analysis',
    'function',
    'input',
    'arguments',
    'args',
    'patch',
    'payload',
    'result',
    'command',
    'message',
    'output_text',
    'name'
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

  if (parts.length === 0) {
    for (const raw of Object.values(record)) {
      if (typeof raw !== 'string') {
        continue;
      }
      const text = raw.trim();
      if (text) {
        parts.push(text);
      }
    }
  }

  return sanitizeFollowupSnapshotText(dedupeAndJoinTexts(parts));
}

function dedupeAndJoinTexts(parts: string[]): string {
  const unique = Array.from(
    new Set(
      parts
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0)
    )
  );
  return sanitizeFollowupSnapshotText(unique.join('\n').trim());
}

function buildStopMessageResponseExcerpt(value: unknown): string {
  try {
    const raw = JSON.stringify(value);
    if (!raw) {
      return '';
    }
    if (raw.length <= 3_000) {
      return sanitizeFollowupSnapshotText(raw);
    }
    return sanitizeFollowupSnapshotText(`${raw.slice(0, 3_000)}...`);
  } catch {
    return '';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toNonEmptyText(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}
