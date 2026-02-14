import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEEPSEEK_ERROR_CODES,
  type DeepSeekErrorCode
} from '../contracts/deepseek-provider-contract.js';

type DeepSeekSessionPowError = Error & {
  code?: string;
  statusCode?: number;
  status?: number;
  upstreamCode?: string;
  details?: Record<string, unknown>;
};

type DeepSeekSessionResponse = {
  code?: number;
  msg?: string;
  message?: string;
  data?: {
    biz_data?: {
      id?: string;
      challenge?: DeepSeekPowChallenge;
    };
  };
};

type DeepSeekPowChallenge = {
  algorithm?: string;
  challenge?: string;
  salt?: string;
  difficulty?: number;
  expire_at?: number;
  signature?: string;
  target_path?: string;
};

type DeepSeekSessionCache = {
  sessionId: string;
  expiresAt: number;
};

type FetchLike = typeof fetch;

export interface DeepSeekSessionPowManagerOptions {
  baseUrl: string;
  createSessionEndpoint?: string;
  createPowEndpoint?: string;
  completionTargetPath?: string;
  timeoutMs?: number;
  powTimeoutMs?: number;
  powMaxAttempts?: number;
  sessionReuseTtlMs?: number;
  solverPath?: string;
  wasmPath?: string;
  fetchImpl?: FetchLike;
  solvePow?: (input: {
    algorithm: string;
    challenge: string;
    salt: string;
    difficulty: number;
    expireAt: number;
    signature: string;
    targetPath: string;
  }) => Promise<number>;
  logger?: {
    logModule?: (id: string, stage: string, details?: Record<string, unknown>) => void;
  };
  logId?: string;
}

const DEFAULT_CREATE_SESSION_ENDPOINT = '/api/v0/chat_session/create';
const DEFAULT_CREATE_POW_ENDPOINT = '/api/v0/chat/create_pow_challenge';
const DEFAULT_COMPLETION_TARGET_PATH = '/api/v0/chat/completion';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POW_TIMEOUT_MS = 15_000;
const DEFAULT_POW_MAX_ATTEMPTS = 2;
const DEFAULT_SESSION_REUSE_TTL_MS = 30 * 60 * 1000;

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const floored = Math.floor(parsed);
  if (floored < min) {
    return min;
  }
  if (floored > max) {
    return max;
  }
  return floored;
}

function createDeepSeekSessionPowError(params: {
  code: DeepSeekErrorCode;
  message: string;
  statusCode?: number;
  upstreamCode?: string;
  details?: Record<string, unknown>;
}): DeepSeekSessionPowError {
  const error = new Error(params.message) as DeepSeekSessionPowError;
  error.code = params.code;
  if (typeof params.statusCode === 'number') {
    error.statusCode = params.statusCode;
    error.status = params.statusCode;
  }
  if (typeof params.upstreamCode === 'string' && params.upstreamCode.trim()) {
    error.upstreamCode = params.upstreamCode.trim();
  }
  if (params.details) {
    error.details = params.details;
  }
  return error;
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function resolveBuiltInPowSolverPath(): string | undefined {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, '../../../scripts/deepseek/pow-solver.mjs'),
    path.resolve(currentDir, '../../../../scripts/deepseek/pow-solver.mjs'),
    path.resolve(process.cwd(), 'dist/scripts/deepseek/pow-solver.mjs'),
    path.resolve(process.cwd(), 'scripts/deepseek/pow-solver.mjs')
  ];
  return firstExistingPath(candidates);
}

function resolveBuiltInPowWasmPath(): string | undefined {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, '../../../scripts/deepseek/sha3_wasm_bg.7b9ca65ddd.wasm'),
    path.resolve(currentDir, '../../../../scripts/deepseek/sha3_wasm_bg.7b9ca65ddd.wasm'),
    path.resolve(process.cwd(), 'dist/scripts/deepseek/sha3_wasm_bg.7b9ca65ddd.wasm'),
    path.resolve(process.cwd(), 'scripts/deepseek/sha3_wasm_bg.7b9ca65ddd.wasm')
  ];
  return firstExistingPath(candidates);
}

function firstExistingPath(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

function resolvePathWithFallback(
  preferredPath: string | undefined,
  builtInPath: string | undefined
): string | undefined {
  const preferred = normalizeString(preferredPath);
  if (preferred) {
    try {
      if (fs.existsSync(preferred)) {
        return preferred;
      }
    } catch {
      // ignore
    }
  }
  return builtInPath;
}

export class DeepSeekSessionPowManager {
  private readonly baseUrl: string;
  private readonly createSessionEndpoint: string;
  private readonly createPowEndpoint: string;
  private readonly completionTargetPath: string;
  private readonly timeoutMs: number;
  private readonly powTimeoutMs: number;
  private readonly powMaxAttempts: number;
  private readonly sessionReuseTtlMs: number;
  private readonly solverPath?: string;
  private readonly wasmPath?: string;
  private readonly fetchImpl: FetchLike;
  private readonly solvePowOverride?: DeepSeekSessionPowManagerOptions['solvePow'];
  private readonly logger?: DeepSeekSessionPowManagerOptions['logger'];
  private readonly logId: string;

  private cachedSession: DeepSeekSessionCache | null = null;

  constructor(options: DeepSeekSessionPowManagerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.createSessionEndpoint = normalizeString(options.createSessionEndpoint) || DEFAULT_CREATE_SESSION_ENDPOINT;
    this.createPowEndpoint = normalizeString(options.createPowEndpoint) || DEFAULT_CREATE_POW_ENDPOINT;
    this.completionTargetPath = normalizeString(options.completionTargetPath) || DEFAULT_COMPLETION_TARGET_PATH;
    this.timeoutMs = normalizeInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 300_000);
    this.powTimeoutMs = normalizeInteger(options.powTimeoutMs, DEFAULT_POW_TIMEOUT_MS, 1_000, 300_000);
    this.powMaxAttempts = normalizeInteger(options.powMaxAttempts, DEFAULT_POW_MAX_ATTEMPTS, 1, 10);
    this.sessionReuseTtlMs = normalizeInteger(
      options.sessionReuseTtlMs,
      DEFAULT_SESSION_REUSE_TTL_MS,
      1_000,
      24 * 60 * 60 * 1000
    );
    const preferredSolverPath =
      normalizeString(options.solverPath) ||
      normalizeString(process.env.ROUTECODEX_DEEPSEEK_POW_SOLVER);
    const preferredWasmPath =
      normalizeString(options.wasmPath) ||
      normalizeString(process.env.ROUTECODEX_DEEPSEEK_POW_WASM);
    this.solverPath = resolvePathWithFallback(preferredSolverPath, resolveBuiltInPowSolverPath());
    this.wasmPath = resolvePathWithFallback(preferredWasmPath, resolveBuiltInPowWasmPath());
    this.fetchImpl = options.fetchImpl || fetch;
    this.solvePowOverride = options.solvePow;
    this.logger = options.logger;
    this.logId = normalizeString(options.logId) || 'provider:deepseek';
  }

  async ensureChatSession(authHeaders: Record<string, string>): Promise<string> {
    const now = Date.now();
    if (this.cachedSession && this.cachedSession.expiresAt > now) {
      return this.cachedSession.sessionId;
    }

    const response = await this.postJson(
      this.createSessionEndpoint,
      {
        agent: 'chat'
      },
      authHeaders,
      DEEPSEEK_ERROR_CODES.SESSION_CREATE_FAILED
    );

    const sessionId = normalizeString(response.data?.biz_data?.id);
    if (!sessionId) {
      throw createDeepSeekSessionPowError({
        code: DEEPSEEK_ERROR_CODES.SESSION_CREATE_FAILED,
        message: 'DeepSeek session create returned empty session id',
        statusCode: 502,
        details: {
          response
        }
      });
    }

    this.cachedSession = {
      sessionId,
      expiresAt: now + this.sessionReuseTtlMs
    };
    return sessionId;
  }

  async createPowResponse(authHeaders: Record<string, string>): Promise<string> {
    let lastError: unknown = undefined;

    for (let attempt = 1; attempt <= this.powMaxAttempts; attempt += 1) {
      try {
        const challengeResponse = await this.postJson(
          this.createPowEndpoint,
          {
            target_path: this.completionTargetPath
          },
          authHeaders,
          DEEPSEEK_ERROR_CODES.POW_CHALLENGE_FAILED
        );

        const challenge = challengeResponse.data?.biz_data?.challenge;
        const normalizedChallenge = this.normalizeChallenge(challenge);
        const answer = await this.solvePowChallenge(normalizedChallenge);

        const payload = {
          algorithm: normalizedChallenge.algorithm,
          challenge: normalizedChallenge.challenge,
          salt: normalizedChallenge.salt,
          answer,
          signature: normalizedChallenge.signature,
          target_path: normalizedChallenge.targetPath
        };

        return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64').trim();
      } catch (error) {
        lastError = error;
        this.log('deepseek-pow-attempt-failed', {
          attempt,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (lastError instanceof Error && (lastError as DeepSeekSessionPowError).code) {
      throw lastError;
    }

    throw createDeepSeekSessionPowError({
      code: DEEPSEEK_ERROR_CODES.POW_SOLVE_FAILED,
      message: `DeepSeek PoW failed after ${this.powMaxAttempts} attempts`,
      statusCode: 502,
      details: {
        error: lastError instanceof Error ? lastError.message : String(lastError)
      }
    });
  }

  async cleanup(): Promise<void> {
    this.cachedSession = null;
  }

  private normalizeChallenge(challenge: DeepSeekPowChallenge | undefined): {
    algorithm: string;
    challenge: string;
    salt: string;
    difficulty: number;
    expireAt: number;
    signature: string;
    targetPath: string;
  } {
    const algorithm = normalizeString(challenge?.algorithm);
    const challengeToken = normalizeString(challenge?.challenge);
    const salt = normalizeString(challenge?.salt);
    const signature = normalizeString(challenge?.signature);
    const targetPath = normalizeString(challenge?.target_path) || this.completionTargetPath;
    const difficulty = normalizeInteger(challenge?.difficulty, 144_000, 1, 10_000_000);
    const expireAt = normalizeInteger(challenge?.expire_at, Date.now() + 3_600_000, 1, 99_999_999_999_999);

    if (!algorithm || !challengeToken || !salt || !signature) {
      throw createDeepSeekSessionPowError({
        code: DEEPSEEK_ERROR_CODES.POW_CHALLENGE_FAILED,
        message: 'DeepSeek PoW challenge payload is invalid',
        statusCode: 502,
        details: {
          challenge
        }
      });
    }

    return {
      algorithm,
      challenge: challengeToken,
      salt,
      difficulty,
      expireAt,
      signature,
      targetPath
    };
  }

  private async postJson(
    endpoint: string,
    body: Record<string, unknown>,
    authHeaders: Record<string, string>,
    errorCode: DeepSeekErrorCode
  ): Promise<DeepSeekSessionResponse> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.joinUrl(endpoint), {
        method: 'POST',
        headers: {
          ...authHeaders,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const responseText = await response.text();
      const parsed = safeParseJson(responseText) as DeepSeekSessionResponse | undefined;

      if (!response.ok) {
        throw createDeepSeekSessionPowError({
          code: errorCode,
          message: `DeepSeek endpoint ${endpoint} failed with HTTP ${response.status}`,
          statusCode: response.status,
          upstreamCode: parsed?.code !== undefined ? String(parsed.code) : undefined,
          details: {
            endpoint,
            response: parsed,
            responseText: responseText.slice(0, 500)
          }
        });
      }

      const apiCode = typeof parsed?.code === 'number' ? parsed.code : 0;
      if (apiCode !== 0) {
        throw createDeepSeekSessionPowError({
          code: errorCode,
          message: `DeepSeek endpoint ${endpoint} returned code=${apiCode}`,
          statusCode: 502,
          upstreamCode: String(apiCode),
          details: {
            endpoint,
            response: parsed,
            responseText: responseText.slice(0, 500)
          }
        });
      }

      return parsed || {};
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw createDeepSeekSessionPowError({
          code: errorCode,
          message: `DeepSeek endpoint ${endpoint} timeout (${this.timeoutMs}ms)`,
          statusCode: 408
        });
      }

      if (error instanceof Error && (error as DeepSeekSessionPowError).code) {
        throw error;
      }

      throw createDeepSeekSessionPowError({
        code: errorCode,
        message: `DeepSeek endpoint ${endpoint} request failed: ${error instanceof Error ? error.message : String(error)}`,
        statusCode: 502
      });
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async solvePowChallenge(input: {
    algorithm: string;
    challenge: string;
    salt: string;
    difficulty: number;
    expireAt: number;
    signature: string;
    targetPath: string;
  }): Promise<number> {
    if (this.solvePowOverride) {
      return await this.solvePowOverride(input);
    }

    const solverPath = resolvePathWithFallback(this.solverPath, resolveBuiltInPowSolverPath());
    const wasmPath = resolvePathWithFallback(this.wasmPath, resolveBuiltInPowWasmPath());

    if (!solverPath) {
      throw createDeepSeekSessionPowError({
        code: DEEPSEEK_ERROR_CODES.POW_SOLVE_FAILED,
        message: 'DeepSeek pow solver path is not configured',
        statusCode: 500
      });
    }

    const payload: Record<string, unknown> = {
      algorithm: input.algorithm,
      challenge: input.challenge,
      salt: input.salt,
      difficulty: input.difficulty,
      expireAt: input.expireAt
    };
    if (wasmPath) {
      payload.wasmPath = wasmPath;
    }

    return await this.spawnPowSolver(payload, solverPath, wasmPath);
  }

  private async spawnPowSolver(
    payload: Record<string, unknown>,
    solverPath: string,
    wasmPath?: string
  ): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [solverPath], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (error?: unknown, value?: number): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (error) {
          reject(error);
          return;
        }
        resolve(value as number);
      };

      const timeoutHandle = setTimeout(() => {
        child.kill('SIGKILL');
        finish(
          createDeepSeekSessionPowError({
            code: DEEPSEEK_ERROR_CODES.POW_SOLVE_FAILED,
            message: `DeepSeek PoW solver timeout (${this.powTimeoutMs}ms)`,
            statusCode: 408
          })
        );
      }, this.powTimeoutMs);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      child.on('error', (error) => {
        finish(
          createDeepSeekSessionPowError({
            code: DEEPSEEK_ERROR_CODES.POW_SOLVE_FAILED,
            message: `DeepSeek PoW solver spawn failed: ${error.message}`,
            statusCode: 500
          })
        );
      });

      child.on('close', (code) => {
        if (code !== 0) {
          const stderrSnippet = stderr.trim().slice(0, 500);
          const stdoutSnippet = stdout.trim().slice(0, 200);
          finish(
            createDeepSeekSessionPowError({
              code: DEEPSEEK_ERROR_CODES.POW_SOLVE_FAILED,
              message:
                `DeepSeek PoW solver failed (code=${code})` +
                (stderrSnippet ? `: ${stderrSnippet}` : ''),
              statusCode: 502,
              details: {
                solverPath,
                wasmPath,
                stderr: stderrSnippet,
                stdout: stdoutSnippet
              }
            })
          );
          return;
        }

        const parsed = safeParseJson(stdout.trim()) as { ok?: boolean; answer?: unknown } | undefined;
        const answer =
          typeof parsed?.answer === 'number'
            ? parsed.answer
            : typeof parsed?.answer === 'string'
              ? Number.parseInt(parsed.answer, 10)
              : NaN;

        if (!Number.isFinite(answer)) {
          finish(
            createDeepSeekSessionPowError({
              code: DEEPSEEK_ERROR_CODES.POW_SOLVE_FAILED,
              message: 'DeepSeek PoW solver returned invalid answer',
              statusCode: 502,
              details: {
                stdout: stdout.slice(0, 500),
                stderr: stderr.slice(0, 500)
              }
            })
          );
          return;
        }

        finish(undefined, Math.trunc(answer));
      });

      try {
        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
      } catch (error) {
        finish(
          createDeepSeekSessionPowError({
            code: DEEPSEEK_ERROR_CODES.POW_SOLVE_FAILED,
            message: `DeepSeek PoW solver stdin failed: ${error instanceof Error ? error.message : String(error)}`,
            statusCode: 500
          })
        );
      }
    });
  }

  private joinUrl(endpoint: string): string {
    const suffix = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    return `${this.baseUrl}${suffix}`;
  }

  private log(stage: string, details?: Record<string, unknown>): void {
    this.logger?.logModule?.(this.logId, stage, details);
  }
}
