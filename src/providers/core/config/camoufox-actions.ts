import { spawnSync } from 'node:child_process';
import { logOAuthDebug } from '../../auth/oauth-logger.js';

export interface CamoActionContext {
  camoCommand: string;
  profileId: string;
  env: Record<string, string | undefined>;
}

export interface CamoClickTarget {
  key: string;
  selectors: string[];
}

export const CAMO_CLICK_TARGETS: Record<string, CamoClickTarget> = {
  tokenPortalContinue: {
    key: 'tokenPortalContinue',
    selectors: ['#continue-btn']
  },
  qwenAuthorizeConfirm: {
    key: 'qwenAuthorizeConfirm',
    selectors: [
      '.qwen-confirm-btn',
      "button[class*='qwen-confirm-btn']",
      'button.qwen-confirm-btn'
    ]
  },
  qwenGoogleContinue: {
    key: 'qwenGoogleContinue',
    selectors: [
      '.qwenchat-auth-pc-other-login-button',
      "button[class*='other-login-button']"
    ]
  },
  iflowAccountSelect: {
    key: 'iflowAccountSelect',
    selectors: [
      "div[class^='accountItem--']",
      "div[class*='accountItem--']",
      "div[class^='accountContent--']",
      "div[class*='accountContent--']"
    ]
  },
  googleAccountSelect: {
    key: 'googleAccountSelect',
    selectors: [
      'div[data-identifier]',
      '[data-profileindex]',
      '[data-identifier] [role="link"]'
    ]
  },
  googleNextStep: {
    key: 'googleNextStep',
    selectors: [
      '#identifierNext',
      '#idvPreregisteredPhoneNext'
    ]
  },
  googleConsentApprove: {
    key: 'googleConsentApprove',
    selectors: [
      '#submit_approve_access',
      "button[name='allow']",
      "button[id*='approve']"
    ]
  }
};

type CamoStdio = 'inherit' | 'ignore';

type CamoActionResult = {
  ok: boolean;
  status: number | null;
  errorText: string;
};

type CamoCaptureResult = {
  ok: boolean;
  status: number | null;
  errorText: string;
  stdout: string;
  stderr: string;
};

function resolveErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '');
}

function runCamoCliAction(
  context: CamoActionContext,
  args: string[],
  stdio: CamoStdio
): CamoActionResult {
  const result = spawnSync(context.camoCommand, args, {
    stdio,
    env: context.env
  });
  const status = typeof result.status === 'number' ? result.status : null;
  const errorText = resolveErrorText(result.error);
  return {
    ok: status === 0 && !result.error,
    status,
    errorText
  };
}

function runCamoCliCapture(context: CamoActionContext, args: string[]): CamoCaptureResult {
  const result = spawnSync(context.camoCommand, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: context.env,
    encoding: 'utf8'
  });
  const status = typeof result.status === 'number' ? result.status : null;
  const errorText = resolveErrorText(result.error);
  return {
    ok: status === 0 && !result.error,
    status,
    errorText,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : ''
  };
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const text = String(raw || '').trim();
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function listActiveProfiles(context: CamoActionContext): string[] {
  const list = runCamoCliCapture(context, ['list']);
  if (!list.ok) {
    return [];
  }
  const parsed = parseJsonObject(list.stdout);
  const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  const profiles: string[] = [];
  for (const session of sessions) {
    if (!session || typeof session !== 'object') {
      continue;
    }
    const profileId = typeof (session as Record<string, unknown>).profileId === 'string'
      ? String((session as Record<string, unknown>).profileId)
      : '';
    if (profileId) {
      profiles.push(profileId);
    }
  }
  return profiles;
}

function resolveActivePageUrlFromList(raw: string): string | null {
  const parsed = parseJsonObject(raw);
  const pages = Array.isArray(parsed?.pages) ? parsed.pages : [];
  if (pages.length === 0) {
    return null;
  }
  const activeIndex = typeof parsed?.activeIndex === 'number' ? parsed.activeIndex : null;
  if (activeIndex !== null) {
    for (const page of pages) {
      if (!page || typeof page !== 'object') {
        continue;
      }
      const node = page as Record<string, unknown>;
      if (node.index === activeIndex && typeof node.url === 'string' && node.url.trim()) {
        return node.url.trim();
      }
    }
  }
  for (const page of pages) {
    if (!page || typeof page !== 'object') {
      continue;
    }
    const node = page as Record<string, unknown>;
    if (node.active === true && typeof node.url === 'string' && node.url.trim()) {
      return node.url.trim();
    }
  }
  for (const page of pages) {
    if (!page || typeof page !== 'object') {
      continue;
    }
    const node = page as Record<string, unknown>;
    if (typeof node.url === 'string' && node.url.trim()) {
      return node.url.trim();
    }
  }
  return null;
}

function isTargetSessionActive(context: CamoActionContext): boolean {
  const profiles = listActiveProfiles(context);
  return profiles.includes(context.profileId);
}

function stopActiveProfile(context: CamoActionContext, profileId: string): void {
  const result = runCamoCliAction(context, ['stop', profileId], 'inherit');
  if (!result.ok) {
    logOAuthDebug(
      `[OAuth] camo-cli stop profile=${profileId} failed status=${result.status ?? 'n/a'} error=${result.errorText}`
    );
  }
}

function printIfAny(text: string): void {
  if (text && text.trim()) {
    console.log(text.trim());
  }
}

export function startCamoSession(context: CamoActionContext, headless: boolean): boolean {
  const startArgs = ['start', context.profileId];
  if (headless) {
    startArgs.push('--headless');
  }
  const idleTimeout = String(
    context.env.ROUTECODEX_OAUTH_CAMO_IDLE_TIMEOUT ||
    context.env.RCC_OAUTH_CAMO_IDLE_TIMEOUT ||
    '30m'
  ).trim();
  if (idleTimeout) {
    startArgs.push('--idle-timeout', idleTimeout);
  }

  // OAuth flow requires fresh callback state. Reusing an existing session can keep
  // stale portal URLs (old state/redirect port) and break callback delivery.
  const activeBeforeStart = listActiveProfiles(context);
  if (activeBeforeStart.includes(context.profileId)) {
    logOAuthDebug(
      `[OAuth] camo-cli target profile already active; reusing active session profile=${context.profileId} headless=${headless ? '1' : '0'}`
    );
    return true;
  }

  const firstStart = runCamoCliCapture(context, startArgs);
  printIfAny(firstStart.stdout);
  printIfAny(firstStart.stderr);
  if (!firstStart.ok) {
    logOAuthDebug(
      `[OAuth] camo-cli start failed profile=${context.profileId} status=${firstStart.status ?? 'n/a'} error=${firstStart.errorText}`
    );
    return false;
  }
  if (isTargetSessionActive(context)) {
    return true;
  }

  const activeProfiles = listActiveProfiles(context);
  const conflictingProfiles = activeProfiles.filter((profileId) => profileId && profileId !== context.profileId);
  if (conflictingProfiles.length > 0) {
    logOAuthDebug(
      `[OAuth] camo-cli start profile mismatch; keep other sessions active=${conflictingProfiles.join(',')}`
    );
  }

  const secondStart = runCamoCliCapture(context, startArgs);
  printIfAny(secondStart.stdout);
  printIfAny(secondStart.stderr);
  if (!secondStart.ok) {
    logOAuthDebug(
      `[OAuth] camo-cli restart failed profile=${context.profileId} status=${secondStart.status ?? 'n/a'} error=${secondStart.errorText}`
    );
    return false;
  }
  return isTargetSessionActive(context);
}

export function ensureCamoProfile(context: CamoActionContext): boolean {
  const create = runCamoCliCapture(context, ['profile', 'create', context.profileId]);
  if (create.ok) {
    printIfAny(create.stdout);
    return true;
  }
  const combined = `${create.stdout}\n${create.stderr}\n${create.errorText}`.toLowerCase();
  if (combined.includes('already exists')) {
    return true;
  }
  logOAuthDebug(
    `[OAuth] camo-cli profile create failed profile=${context.profileId} status=${create.status ?? 'n/a'} error=${create.errorText}`
  );
  printIfAny(create.stdout);
  printIfAny(create.stderr);
  return false;
}

export function setDefaultCamoProfile(context: CamoActionContext): boolean {
  const result = runCamoCliAction(context, ['profile', 'default', context.profileId], 'ignore');
  if (!result.ok) {
    logOAuthDebug(
      `[OAuth] camo-cli profile default set failed - status=${result.status ?? 'n/a'} error=${result.errorText}`
    );
  }
  return result.ok;
}

export function gotoCamoUrl(context: CamoActionContext, url: string): boolean {
  const result = runCamoCliAction(context, ['goto', context.profileId, url], 'inherit');
  if (!result.ok) {
    logOAuthDebug(
      `[OAuth] camo-cli goto failed url=${url} status=${result.status ?? 'n/a'} error=${result.errorText}`
    );
  }
  return result.ok;
}

export function getActiveCamoPageUrl(context: CamoActionContext): string | null {
  const result = runCamoCliCapture(context, ['list-pages', context.profileId]);
  if (!result.ok) {
    return null;
  }
  return resolveActivePageUrlFromList(result.stdout);
}

export async function clickCamoTarget(
  context: CamoActionContext,
  target: CamoClickTarget,
  options: { retries: number; retryDelayMs: number; required: boolean }
): Promise<boolean> {
  const retries = options.retries > 0 ? options.retries : 1;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    for (const selector of target.selectors) {
      const args = ['click', context.profileId, selector, '--no-highlight'];
      const result = runCamoCliAction(context, args, 'inherit');
      if (result.ok) {
        logOAuthDebug(
          `[OAuth] camo-cli click target=${target.key} selector=${selector} ok attempt=${attempt}/${retries}`
        );
        return true;
      }
      logOAuthDebug(
        `[OAuth] camo-cli click target=${target.key} selector=${selector} failed attempt=${attempt}/${retries} status=${
          result.status ?? 'n/a'
        } error=${result.errorText}`
      );
    }
    if (attempt < retries && options.retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs));
    }
  }
  if (options.required) {
    logOAuthDebug(`[OAuth] camo-cli click target=${target.key} required but not matched`);
    return false;
  }
  logOAuthDebug(`[OAuth] camo-cli click target=${target.key} not matched (non-required)`);
  return true;
}
