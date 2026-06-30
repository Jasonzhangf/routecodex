import fs from 'node:fs/promises';
import path from 'node:path';
import { redactSensitiveData } from '../../utils/sensitive-redaction.js';
import type { InternalDebugErrorEnvelope } from '../internal-error/envelope.js';
import type { ExternalErrorLink } from '../internal-error/external-link.js';

export interface DebugErrorDiagArtifactRecord {
  endpoint: string;
  requestId: string;
  requestBody: unknown;
  message: string;
  code?: string;
  statusCode?: number;
  status?: number;
  details?: unknown;
  stack?: string;
  internalError?: InternalDebugErrorEnvelope;
  externalError?: ExternalErrorLink;
  timestamp: string;
}

function sanitizeRequestId(requestId: string): string {
  const trimmed = String(requestId || '').trim();
  const safe = trimmed.replace(/[^A-Za-z0-9_.-]/g, '_');
  return safe || `request_${Date.now()}`;
}

function resolveDiagRoot(rootDir?: string): string {
  if (rootDir && rootDir.trim()) {
    return path.resolve(rootDir);
  }
  return path.join(process.env.HOME || '/tmp', '.rcc', 'diag');
}

function toErrorShape(error: unknown): { message: string; code?: string; statusCode?: number; status?: number; details?: unknown; stack?: string } {
  const record = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : undefined;
  return {
    message: error instanceof Error ? error.message : String(error),
    code: typeof record?.code === 'string' ? record.code : undefined,
    statusCode: typeof record?.statusCode === 'number' ? record.statusCode : undefined,
    status: typeof record?.status === 'number' ? record.status : undefined,
    details: record?.details,
    stack: error instanceof Error ? error.stack : undefined,
  };
}

export function buildDebugErrorDiagArtifactRecord(input: {
  endpoint: string;
  requestId: string;
  requestBody: unknown;
  error: unknown;
  internalError?: InternalDebugErrorEnvelope;
  externalError?: ExternalErrorLink;
  timestamp?: string;
}): DebugErrorDiagArtifactRecord {
  const errorShape = toErrorShape(input.error);
  return {
    endpoint: input.endpoint,
    requestId: input.requestId,
    requestBody: redactSensitiveData(input.requestBody),
    message: errorShape.message,
    code: errorShape.code,
    statusCode: errorShape.statusCode,
    status: errorShape.status,
    details: redactSensitiveData(errorShape.details),
    stack: errorShape.stack,
    ...(input.internalError ? { internalError: redactSensitiveData(input.internalError) as InternalDebugErrorEnvelope } : {}),
    ...(input.externalError ? { externalError: redactSensitiveData(input.externalError) as ExternalErrorLink } : {}),
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
}

export async function writeDebugErrorDiagArtifactInternal(input: {
  endpoint: string;
  requestId: string;
  requestBody: unknown;
  error: unknown;
  internalError?: InternalDebugErrorEnvelope;
  externalError?: ExternalErrorLink;
  rootDir?: string;
}): Promise<string> {
  const rootDir = resolveDiagRoot(input.rootDir);
  const filePath = path.join(rootDir, `error-${sanitizeRequestId(input.requestId)}.json`);
  const record = buildDebugErrorDiagArtifactRecord(input);
  await fs.mkdir(rootDir, { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return filePath;
}

export async function readDebugErrorDiagArtifactInternal(filePath: string): Promise<DebugErrorDiagArtifactRecord> {
  const resolved = path.resolve(filePath);
  const raw = await fs.readFile(resolved, 'utf8');
  return JSON.parse(raw) as DebugErrorDiagArtifactRecord;
}
