import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type OAuthRepairCooldownReason = 'google_verify' | 'generic';

export type OAuthRepairCooldownRecord = {
  providerType: string;
  tokenFile: string;
  reason: OAuthRepairCooldownReason;
  attemptCount: number;
  updatedAt: number;
};

type CooldownStateFile = {
  version: 1;
  updatedAt: number;
  records: Record<string, OAuthRepairCooldownRecord>;
};

function getStateFilePath(): string {
  const home = (process.env.HOME || '').trim() || os.homedir();
  return path.join(home, '.routecodex', 'state', 'oauth-repair-cooldown.json');
}

function normalizeProviderType(providerType: string): string {
  return typeof providerType === 'string' ? providerType.trim().toLowerCase() : '';
}

function normalizeTokenFile(tokenFile: string): string {
  return typeof tokenFile === 'string' ? tokenFile.trim() : '';
}

function buildKey(providerType: string, tokenFile: string): string {
  const pt = normalizeProviderType(providerType);
  const tf = normalizeTokenFile(tokenFile);
  return `${pt}::${tf}`;
}

async function readState(): Promise<CooldownStateFile> {
  const filePath = getStateFilePath();
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = raw.trim() ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { version: 1, updatedAt: Date.now(), records: {} };
    }
    const obj = parsed as any;
    const records = obj.records && typeof obj.records === 'object' && !Array.isArray(obj.records) ? obj.records : {};
    return {
      version: 1,
      updatedAt: typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) ? obj.updatedAt : Date.now(),
      records: records as Record<string, OAuthRepairCooldownRecord>
    };
  } catch {
    return { version: 1, updatedAt: Date.now(), records: {} };
  }
}

async function writeState(next: CooldownStateFile): Promise<void> {
  const filePath = getStateFilePath();
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
    // best-effort: cooldown is a guardrail, should never block requests
  }
}

function resolveCooldownMs(reason: OAuthRepairCooldownReason): number {
  if (reason === 'google_verify') {
    const raw = String(
      process.env.ROUTECODEX_OAUTH_GOOGLE_VERIFY_COOLDOWN_MS ||
        process.env.RCC_OAUTH_GOOGLE_VERIFY_COOLDOWN_MS ||
        '1800000'
    ).trim();
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60_000;
  }
  const raw = String(
    process.env.ROUTECODEX_OAUTH_INTERACTIVE_COOLDOWN_MS ||
      process.env.RCC_OAUTH_INTERACTIVE_COOLDOWN_MS ||
      // 默认 30 分钟：避免“持续 401/403 导致无限弹窗/无限认证”。
      '1800000'
  ).trim();
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60_000;
}

function resolveMaxAttempts(): number {
  const raw = String(
    process.env.ROUTECODEX_OAUTH_INTERACTIVE_MAX_ATTEMPTS ||
      process.env.RCC_OAUTH_INTERACTIVE_MAX_ATTEMPTS ||
      '3'
  ).trim();
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}

export async function shouldSkipInteractiveOAuthRepair(args: {
  providerType: string;
  tokenFile: string;
  reason: OAuthRepairCooldownReason;
}): Promise<{ skip: boolean; msLeft?: number; record?: OAuthRepairCooldownRecord | null }> {
  const pt = normalizeProviderType(args.providerType);
  const tokenFile = normalizeTokenFile(args.tokenFile);
  if (!pt || !tokenFile) {
    return { skip: false };
  }
  const key = buildKey(pt, tokenFile);
  const state = await readState();
  const record = state.records[key];
  if (!record || typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) {
    return { skip: false, record: null };
  }
  const maxAttempts = resolveMaxAttempts();
  const attemptCount =
    typeof record.attemptCount === 'number' && Number.isFinite(record.attemptCount) && record.attemptCount > 0
      ? Math.floor(record.attemptCount)
      : 0;
  const cooldownMs = resolveCooldownMs(args.reason);
  const elapsed = Date.now() - record.updatedAt;
  if (attemptCount >= maxAttempts) {
    // Do not permanently lock interactive repair.
    // Once cooldown window passes, allow retry attempts again.
    if (elapsed < cooldownMs) {
      return { skip: true, msLeft: Math.max(0, cooldownMs - elapsed), record };
    }
    return { skip: false, record };
  }
  // Generic token-invalid errors should retry interactive flow until max attempts is reached.
  // Do not apply long cooldown windows here, otherwise reauth may never be surfaced in practice.
  if (args.reason === 'generic') {
    return { skip: false, record };
  }
  if (elapsed < cooldownMs) {
    return { skip: true, msLeft: Math.max(0, cooldownMs - elapsed), record };
  }
  return { skip: false, record };
}

export async function markInteractiveOAuthRepairAttempt(args: {
  providerType: string;
  tokenFile: string;
  reason: OAuthRepairCooldownReason;
}): Promise<void> {
  const pt = normalizeProviderType(args.providerType);
  const tokenFile = normalizeTokenFile(args.tokenFile);
  if (!pt || !tokenFile) {
    return;
  }
  const key = buildKey(pt, tokenFile);
  const state = await readState();
  const existing = state.records[key];
  const prevAttempts =
    existing && typeof existing.attemptCount === 'number' && Number.isFinite(existing.attemptCount) && existing.attemptCount > 0
      ? Math.floor(existing.attemptCount)
      : 0;
  state.records[key] = {
    providerType: pt,
    tokenFile,
    reason: args.reason,
    attemptCount: prevAttempts + 1,
    updatedAt: Date.now()
  };
  state.updatedAt = Date.now();
  await writeState(state);
}

export async function markInteractiveOAuthRepairSuccess(args: {
  providerType: string;
  tokenFile: string;
}): Promise<void> {
  const pt = normalizeProviderType(args.providerType);
  const tokenFile = normalizeTokenFile(args.tokenFile);
  if (!pt || !tokenFile) {
    return;
  }
  const key = buildKey(pt, tokenFile);
  const state = await readState();
  if (!state.records[key]) {
    return;
  }
  delete state.records[key];
  state.updatedAt = Date.now();
  await writeState(state);
}
