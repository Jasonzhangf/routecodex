import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveRccPath } from '../../../../config/user-data-paths.js';

export const ACCOUNT_STORE_VERSION = 1;
export const DEFAULT_ACCOUNT_STORE_PATH = 'state/windsurf/accounts.json';

export type AccountAuthState = {
  status: 'ready' | 'refreshing' | 'invalid' | 'backoff';
  lastLoginAt: number | null;
  lastAuthFailureAt: number | null;
  lastAuthFailureReason: string | null;
  backoffUntil: number | null;
};

export type AccountQuotaState = {
  status: 'ready' | 'cooldown';
  cooldownUntil: number | null;
  lastQuotaFailureAt: number | null;
  lastQuotaFailureReason: string | null;
};

export type AccountRuntimeState = {
  status: 'ready' | 'backoff' | 'resetting';
  lastRuntimeFailureAt: number | null;
  lastRuntimeFailureReason: string | null;
  backoffUntil: number | null;
};

export type WindsurfPersistedAccount = {
  keyAlias: string;
  email: string;
  accountId: string | null;
  passwordRef: string | null;
  devinSessionToken: string | null;
  auth: AccountAuthState;
  quota: AccountQuotaState;
  runtime: AccountRuntimeState;
  routing: {
    stickyScore: number;
    lastSelectedAt: number | null;
    lastSuccessAt: number | null;
    consecutiveFailures: number;
  };
};

export type WindsurfAccountStoreData = {
  version: number;
  accounts: WindsurfPersistedAccount[];
};

function createDefaultAccount(keyAlias: string, emailOrAlias: string): WindsurfPersistedAccount {
  const now = Date.now();
  return {
    keyAlias,
    email: emailOrAlias,
    accountId: null,
    passwordRef: null,
    devinSessionToken: null,
    auth: { status: 'ready', lastLoginAt: null, lastAuthFailureAt: null, lastAuthFailureReason: null, backoffUntil: null },
    quota: { status: 'ready', cooldownUntil: null, lastQuotaFailureAt: null, lastQuotaFailureReason: null },
    runtime: { status: 'ready', lastRuntimeFailureAt: null, lastRuntimeFailureReason: null, backoffUntil: null },
    routing: { stickyScore: 0, lastSelectedAt: null, lastSuccessAt: null, consecutiveFailures: 0 },
  };
}

function applyEnvOverrides(data: WindsurfAccountStoreData): WindsurfAccountStoreData {
  const raw = process.env.ROUTECODEX_WINDSURF_ACCOUNT_FORCE_STATE;
  if (!raw || typeof raw !== 'string') return data;
  try {
    const override = JSON.parse(raw) as { keyAlias?: string; quotaStatus?: string; authStatus?: string };
    if (!override.keyAlias) return data;
    const account = data.accounts.find((a) => a.keyAlias === override.keyAlias);
    if (!account) return data;
    if (override.quotaStatus === 'cooldown') {
      account.quota.status = 'cooldown';
      account.quota.cooldownUntil = Date.now() + 86400000;
    }
    if (override.authStatus === 'invalid') {
      account.auth.status = 'invalid';
    }
    return data;
  } catch {
    return data;
  }
}

export class WindsurfAccountStore {
  private data: WindsurfAccountStoreData | null = null;
  private filePath: string;
  private dirtyInternal = false;
  private savePromise: Promise<void> | null = null;

  constructor(filePath?: string) {
    const envOverride = process.env.ROUTECODEX_WINDSURF_ACCOUNT_STORE_PATH;
    this.filePath = filePath || envOverride || resolveRccPath(DEFAULT_ACCOUNT_STORE_PATH);
  }

  get isLoaded(): boolean {
    return this.data !== null;
  }

  async load(): Promise<WindsurfAccountStoreData> {
    if (this.data) return this.data;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as WindsurfAccountStoreData;
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.accounts)) {
        this.data = applyEnvOverrides(parsed);
        return this.data;
      }
    } catch {
      // file not found or invalid — start fresh
    }
    this.data = { version: ACCOUNT_STORE_VERSION, accounts: [] };
    return this.data;
  }

  async ensureAccount(keyAlias: string, emailOrAlias: string): Promise<WindsurfPersistedAccount> {
    await this.load();
    const existing = this.data!.accounts.find((a) => a.keyAlias === keyAlias);
    if (existing) return existing;
    const account = createDefaultAccount(keyAlias, emailOrAlias);
    this.data!.accounts.push(account);
    this.dirtyInternal = true;
    return account;
  }

  getAccount(keyAlias: string): WindsurfPersistedAccount | null {
    if (!this.data) return null;
    return this.data.accounts.find((a) => a.keyAlias === keyAlias) ?? null;
  }

  getAllAccounts(): WindsurfPersistedAccount[] {
    if (!this.data) return [];
    return [...this.data.accounts];
  }

  updateAccount(keyAlias: string, updater: (account: WindsurfPersistedAccount) => WindsurfPersistedAccount): void {
    if (!this.data) return;
    const index = this.data.accounts.findIndex((a) => a.keyAlias === keyAlias);
    if (index === -1) return;
    this.data.accounts[index] = updater(this.data.accounts[index]);
    this.dirtyInternal = true;
  }

  removeAccount(keyAlias: string): void {
    if (!this.data) return;
    const index = this.data.accounts.findIndex((a) => a.keyAlias === keyAlias);
    if (index === -1) return;
    this.data.accounts.splice(index, 1);
    this.dirtyInternal = true;
  }

  async save(): Promise<void> {
    if (!this.dirtyInternal || !this.data) return;
    if (this.savePromise) return this.savePromise;

    this.savePromise = this.doSave().finally(() => {
      this.savePromise = null;
    });
    return this.savePromise;
  }

  private async doSave(): Promise<void> {
    try {
      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });
      const tmp = this.filePath + '.tmp.' + Date.now();
      const serialized = JSON.stringify(this.data, null, 2);
      await fs.writeFile(tmp, serialized, 'utf8');
      await fs.rename(tmp, this.filePath);
      this.dirtyInternal = false;
    } catch {
      // best-effort persistence — never throw
    }
  }
}
