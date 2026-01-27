import fs from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const args = process.argv.slice(2);
const opts = new Set(args);

const direction = args.includes('--to-routecodex') ? 'ag-to-rc' : 'rc-to-ag';
const dryRun = opts.has('--dry-run');

const home = os.homedir();
const rcAuthDir = path.join(home, '.routecodex', 'auth');
const agDataDir = path.join(home, '.antigravity_tools');
const agAccountsDir = path.join(agDataDir, 'accounts');
const agIndexPath = path.join(agDataDir, 'accounts.json');

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function normalizeExpirySeconds(token) {
  const expiry = token.expiry_timestamp;
  if (typeof expiry === 'number') {
    return expiry > 10_000_000_000 ? Math.floor(expiry / 1000) : Math.floor(expiry);
  }
  const expiresAt = token.expires_at;
  if (typeof expiresAt === 'number') {
    return expiresAt > 10_000_000_000 ? Math.floor(expiresAt / 1000) : Math.floor(expiresAt);
  }
  const expiresIn = token.expires_in;
  if (typeof expiresIn === 'number') {
    return nowSeconds() + Math.max(0, Math.floor(expiresIn));
  }
  return nowSeconds() + 3600;
}

function normalizeRcToken(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (raw.token && typeof raw.token === 'object' && raw.token.access_token) {
    return { ...raw.token, ...raw };
  }
  return raw;
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

function pickEmail(token) {
  if (typeof token.email === 'string' && token.email.trim()) {
    return token.email.trim();
  }
  if (token.id_token && typeof token.id_token === 'string') {
    // avoid parsing JWT here to keep script simple
  }
  return '';
}

async function loadExistingAccounts() {
  if (!existsSync(agAccountsDir)) {
    return { byEmail: new Map(), accounts: [] };
  }
  const byEmail = new Map();
  const accounts = [];
  for (const name of readdirSync(agAccountsDir)) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const filePath = path.join(agAccountsDir, name);
    try {
      const raw = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      accounts.push({ filePath, data: raw });
      if (raw && typeof raw.email === 'string') {
        byEmail.set(raw.email, { filePath, data: raw });
      }
    } catch {
      // ignore malformed file
    }
  }
  return { byEmail, accounts };
}

async function loadAccountsIndex() {
  try {
    const raw = JSON.parse(await fs.readFile(agIndexPath, 'utf-8'));
    if (raw && typeof raw === 'object' && Array.isArray(raw.accounts)) {
      return raw;
    }
  } catch {
    // ignore
  }
  return { version: '2.0', accounts: [], current_account_id: null };
}

function upsertIndexEntry(index, account) {
  const idx = index.accounts.findIndex((item) => item.id === account.id);
  const summary = {
    id: account.id,
    email: account.email,
    name: account.name ?? null,
    disabled: !!account.disabled,
    proxy_disabled: !!account.proxy_disabled,
    created_at: account.created_at,
    last_used: account.last_used
  };
  if (idx >= 0) {
    index.accounts[idx] = summary;
  } else {
    index.accounts.push(summary);
  }
}

async function rcToAg() {
  if (!existsSync(rcAuthDir)) {
    throw new Error(`RouteCodex auth dir not found: ${rcAuthDir}`);
  }
  await ensureDir(agAccountsDir);

  const { byEmail } = await loadExistingAccounts();
  const index = await loadAccountsIndex();

  const files = readdirSync(rcAuthDir).filter((name) => /^antigravity-oauth-.*\.json$/i.test(name));
  if (!files.length) {
    console.log('No antigravity token files found in ~/.routecodex/auth');
    return;
  }

  for (const name of files) {
    const filePath = path.join(rcAuthDir, name);
    let tokenRaw;
    try {
      tokenRaw = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    } catch {
      console.log(`Skip unreadable token: ${filePath}`);
      continue;
    }
    const token = normalizeRcToken(tokenRaw);
    if (!token || typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string') {
      console.log(`Skip invalid token (missing access/refresh): ${filePath}`);
      continue;
    }

    const email = pickEmail(token);
    if (!email) {
      console.log(`Skip token without email: ${filePath}`);
      continue;
    }

    const now = nowSeconds();
    const expiryTimestamp = normalizeExpirySeconds(token);
    const projectId = typeof token.project_id === 'string' ? token.project_id : (typeof token.projectId === 'string' ? token.projectId : undefined);

    const baseAccount = {
      created_at: now,
      disabled: token.disabled === true,
      email,
      id: crypto.randomUUID(),
      last_used: now,
      name: typeof token.name === 'string' ? token.name : null,
      proxy_disabled: token.proxy_disabled === true || token.proxyDisabled === true,
      proxy_disabled_at: token.proxy_disabled_at ?? null,
      proxy_disabled_reason: token.proxy_disabled_reason ?? null,
      quota: null,
      protected_models: Array.isArray(token.protected_models)
        ? token.protected_models
        : Array.isArray(token.protectedModels)
          ? token.protectedModels
          : [],
      disabled_reason: token.disabled_reason ?? null,
      disabled_at: token.disabled_at ?? null,
      token: {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_in: typeof token.expires_in === 'number' ? token.expires_in : 3600,
        expiry_timestamp: expiryTimestamp,
        token_type: typeof token.token_type === 'string' ? token.token_type : 'Bearer',
        email,
        project_id: projectId
      }
    };

    const existing = byEmail.get(email);
    let account = baseAccount;
    let targetPath;
    if (existing) {
      account = { ...existing.data, ...baseAccount };
      account.id = existing.data.id || baseAccount.id;
      account.created_at = existing.data.created_at || baseAccount.created_at;
      account.last_used = now;
      account.token = { ...(existing.data.token || {}), ...(baseAccount.token || {}) };
      targetPath = existing.filePath;
    } else {
      targetPath = path.join(agAccountsDir, `${account.id}.json`);
    }

    if (dryRun) {
      console.log(`[dry-run] write ${targetPath}`);
    } else {
      await fs.writeFile(targetPath, `${JSON.stringify(account, null, 2)}\n`, 'utf-8');
      upsertIndexEntry(index, account);
      console.log(`Wrote ${targetPath}`);
    }
  }

  if (!dryRun) {
    await fs.writeFile(agIndexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
    console.log(`Updated ${agIndexPath}`);
  }
}

async function agToRc() {
  if (!existsSync(agAccountsDir)) {
    throw new Error(`Antigravity accounts dir not found: ${agAccountsDir}`);
  }
  await ensureDir(rcAuthDir);

  const files = readdirSync(agAccountsDir).filter((name) => name.endsWith('.json'));
  if (!files.length) {
    console.log('No antigravity account files found in ~/.antigravity_tools/accounts');
    return;
  }

  let seq = 1;
  for (const name of files) {
    const filePath = path.join(agAccountsDir, name);
    let account;
    try {
      account = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    } catch {
      console.log(`Skip unreadable account: ${filePath}`);
      continue;
    }
    const token = account?.token;
    if (!token || typeof token.access_token !== 'string') {
      console.log(`Skip account without token: ${filePath}`);
      continue;
    }
    const alias = typeof account.email === 'string' ? account.email.split('@')[0] : 'imported';
    const rcPath = path.join(rcAuthDir, `antigravity-oauth-${seq}-${alias}.json`);
    seq += 1;

    const payload = {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      token_type: token.token_type || 'Bearer',
      expires_in: token.expires_in,
      expires_at: typeof token.expiry_timestamp === 'number' ? token.expiry_timestamp * 1000 : undefined,
      email: account.email,
      name: account.name ?? undefined,
      project_id: token.project_id || account.project_id || account.projectId,
      projectId: token.project_id || account.projectId || account.project_id,
      disabled: account.disabled === true,
      disabled_reason: account.disabled_reason ?? undefined,
      disabled_at: account.disabled_at ?? undefined,
      proxy_disabled: account.proxy_disabled === true,
      proxy_disabled_reason: account.proxy_disabled_reason ?? undefined,
      proxy_disabled_at: account.proxy_disabled_at ?? undefined,
      protected_models: Array.isArray(account.protected_models) ? account.protected_models : undefined
    };

    if (dryRun) {
      console.log(`[dry-run] write ${rcPath}`);
    } else {
      await fs.writeFile(rcPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
      console.log(`Wrote ${rcPath}`);
    }
  }
}

try {
  if (direction === 'ag-to-rc') {
    await agToRc();
  } else {
    await rcToAg();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
