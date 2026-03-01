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
      'button.qwen-confirm-btn',
      'button.qwen-chat-btn',
      "button[class*='qwen-chat-btn']",
      '.authorize-actions button'
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
      'div[data-email]',
      'div.yAlK0b',
      'div[role="link"][data-identifier]',
      'div[role="button"][data-identifier]',
      '[data-profileindex]',
      '[data-identifier] [role="link"]'
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
type CamoEvalResult = {
  ok: boolean;
  value: string;
  status: number | null;
  errorText: string;
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

function runCamoDevtoolsEval(context: CamoActionContext, expression: string): CamoEvalResult {
  const capture = runCamoCliCapture(context, ['devtools', 'eval', context.profileId, expression]);
  if (!capture.ok) {
    return {
      ok: false,
      value: '',
      status: capture.status,
      errorText: capture.errorText || capture.stderr
    };
  }
  try {
    const parsed = JSON.parse(capture.stdout);
    const value = parsed?.result?.value;
    return {
      ok: true,
      value: typeof value === 'string' ? value : String(value ?? ''),
      status: capture.status,
      errorText: ''
    };
  } catch (error) {
    return {
      ok: false,
      value: '',
      status: capture.status,
      errorText: resolveErrorText(error)
    };
  }
}

function resolveVisibleSelector(context: CamoActionContext, selectors: string[]): string | null {
  const normalizedSelectors = selectors.map((s) => String(s || '').trim()).filter(Boolean);
  if (normalizedSelectors.length === 0) {
    return null;
  }
  const expression =
    `(() => {
      const selectors = ${JSON.stringify(normalizedSelectors)};
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        if (rect.bottom < 0 || rect.right < 0) return false;
        if (rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
        return true;
      };
      for (const selector of selectors) {
        let nodes = [];
        try { nodes = Array.from(document.querySelectorAll(selector)); } catch { nodes = []; }
        const matched = nodes.find((node) => isVisible(node));
        if (matched) return selector;
      }
      return '';
    })()`;
  const evalResult = runCamoDevtoolsEval(context, expression);
  if (!evalResult.ok) {
    return null;
  }
  const selected = String(evalResult.value || '').trim();
  return selected || null;
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

function printIfAny(text: string): void {
  if (text && text.trim()) {
    console.log(text.trim());
  }
}

function shouldRestartActiveSession(context: CamoActionContext): boolean {
  const explicit = String(context.env.ROUTECODEX_CAMOUFOX_FORCE_FRESH_SESSION ?? context.env.RCC_CAMOUFOX_FORCE_FRESH_SESSION ?? '').trim().toLowerCase();
  if (explicit) {
    return explicit === '1' || explicit === 'true' || explicit === 'yes' || explicit === 'on';
  }
  const profileId = String(context.profileId || '').toLowerCase();
  const isQwenProfile = profileId.startsWith('rc-qwen');
  const autoMode = String(context.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || '').trim();
  if (autoMode.length > 0) {
    // Qwen auto mode should reuse the same profile session to preserve login cookies.
    return !isQwenProfile;
  }
  return false;
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

  const activeBeforeStart = listActiveProfiles(context);
  if (activeBeforeStart.includes(context.profileId)) {
    if (shouldRestartActiveSession(context)) {
      logOAuthDebug(
        `[OAuth] camo-cli target profile already active; restarting for fresh oauth state profile=${context.profileId}`
      );
      const stopResult = runCamoCliAction(context, ['stop', context.profileId], 'inherit');
      if (!stopResult.ok) {
        logOAuthDebug(
          `[OAuth] camo-cli stop profile=${context.profileId} failed status=${stopResult.status ?? 'n/a'} error=${stopResult.errorText}`
        );
      }
    } else {
      logOAuthDebug(
        `[OAuth] camo-cli target profile already active; reusing active session profile=${context.profileId} headless=${headless ? '1' : '0'}`
      );
      return true;
    }
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
    const preferredSelector = resolveVisibleSelector(context, target.selectors);
    const selectorsToTry = preferredSelector ? [preferredSelector] : target.selectors;
    for (const selector of selectorsToTry) {
      const result = runCamoCliAction(context, ['click', context.profileId, selector, '--no-highlight'], 'inherit');
      if (result.ok) {
        logOAuthDebug(`[OAuth] camo-cli click target=${target.key} selector=${selector} ok attempt=${attempt}/${retries}`);
        return true;
      }
      logOAuthDebug(`[OAuth] camo-cli click target=${target.key} selector=${selector} failed attempt=${attempt}/${retries} status=${result.status ?? 'n/a'} error=${result.errorText}`);
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

export async function clickCamoGoogleSignInBySelector(
  context: CamoActionContext,
  options: { retries: number; retryDelayMs: number; required: boolean }
): Promise<boolean> {
  const retries = options.retries > 0 ? options.retries : 1;
  const selectors = ['[data-rcx-signin="1"]'];
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const markResult = runCamoDevtoolsEval(
      context,
      `(() => {
        const vis = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || '1') !== 0;
        };
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const isSignInText = (value) => /sign\\s*in|登录|登入/.test(normalize(value));
        for (const el of Array.from(document.querySelectorAll('[data-rcx-signin]'))) el.removeAttribute('data-rcx-signin');
        const buttons = Array.from(document.querySelectorAll('button,[role="button"],div[role="button"]')).filter(vis);
        const target = buttons.find((button) => isSignInText(button.innerText || button.textContent || '')) || null;
        if (!target) return 'not_found';
        const clickable = target.closest('button,[role="button"],div[role="button"]') || target;
        clickable.setAttribute('data-rcx-signin', '1');
        return 'ok:' + normalize(clickable.innerText || clickable.textContent || '');
      })()`
    );
    const markValue = String(markResult.value || '').trim();
    if (!markResult.ok || markValue === 'not_found') {
      logOAuthDebug(
        `[OAuth] camo-cli click-google-sign-in-selector sign-in prompt not ready attempt=${attempt}/${retries} status=${markResult.status ?? 'n/a'} error=${markResult.errorText || markValue}`
      );
      if (attempt < retries && options.retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs));
      }
      continue;
    }
    const preferredSelector = resolveVisibleSelector(context, selectors);
    for (const selector of (preferredSelector ? [preferredSelector] : selectors)) {
      const result = runCamoCliAction(context, ['click', context.profileId, selector, '--no-highlight'], 'inherit');
      if (result.ok) {
        logOAuthDebug(
          `[OAuth] camo-cli click-google-sign-in-selector ok selector=${selector} target=${markValue} attempt=${attempt}/${retries}`
        );
        return true;
      }
      const err = String(result.errorText || '').toLowerCase();
      if (err.includes('execution context was destroyed')) return true;
      if (err.includes('session for profile') && err.includes('not started')) return !options.required;
      logOAuthDebug(`[OAuth] camo-cli click-google-sign-in-selector failed selector=${selector} attempt=${attempt}/${retries} status=${result.status ?? 'n/a'} error=${result.errorText}`);
    }
    if (attempt < retries && options.retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs));
  }
  if (options.required) { logOAuthDebug('[OAuth] camo-cli click-google-sign-in-selector required but not matched'); return false; }
  return true;
}

export function hasCamoGoogleSignInPrompt(context: CamoActionContext): boolean {
  const evalResult = runCamoDevtoolsEval(
    context,
    `(() => {
      const vis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || '1') !== 0;
      };
      const buttons = Array.from(document.querySelectorAll('button,[role="button"],div[role="button"]')).filter(vis);
      return buttons.some((b) => /sign\\s*in|登录|登入/i.test(String(b.innerText || b.textContent || ''))) ? '1' : '0';
    })()`
  );
  if (!evalResult.ok) {
    return false;
  }
  return String(evalResult.value || '').trim() === '1';
}
export async function clickCamoGoogleAccountByHint(context: CamoActionContext, hint: string, options: { retries: number; retryDelayMs: number; required: boolean }): Promise<boolean> {
  const normalizedHint = String(hint || '').trim().toLowerCase();
  if (!normalizedHint) return !options.required;
  const retries = options.retries > 0 ? options.retries : 1;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const expression =
      `(() => {
        const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const hint = ${JSON.stringify(normalizedHint)};
        const emailNodes = Array.from(document.querySelectorAll('div.yAlK0b[data-email], [data-email], [data-identifier]'));
        emailNodes.forEach((node) => node.removeAttribute('data-rcx-account-hit'));
        for (const node of emailNodes) {
          const attr = normalize(node.getAttribute('data-email') || node.getAttribute('data-identifier') || '');
          const text = normalize(node.textContent || '');
          if (!(attr === hint || text === hint || attr.includes(hint) || text.includes(hint))) continue;
          const clickable = node.closest('div.L6LTWe, [jsname], [role="link"], [role="button"], button, a') || node;
          if (typeof clickable.scrollIntoView === 'function') clickable.scrollIntoView({ block: 'center', inline: 'center' });
          clickable.setAttribute('data-rcx-account-hit', '1');
          return 'selected:' + (attr || text);
        }
        return 'not_found';
      })()`;
    const result = runCamoDevtoolsEval(context, expression);
    if (result.ok && String(result.value).startsWith('selected:')) {
      const preferredSelector = resolveVisibleSelector(context, ['div.yAlK0b[data-rcx-account-hit="1"]', '[data-rcx-account-hit="1"]']);
      if (preferredSelector) {
        const clickResult = runCamoCliAction(context, ['click', context.profileId, preferredSelector, '--no-highlight'], 'inherit');
        if (clickResult.ok) {
          if (!isTargetSessionActive(context)) { logOAuthDebug(`[OAuth] camo-cli click-google-account-hint session lost after click hint=${normalizedHint} selector=${preferredSelector}`); return false; }
          logOAuthDebug(`[OAuth] camo-cli click-google-account-hint ok hint=${normalizedHint} selector=${preferredSelector} attempt=${attempt}/${retries}`);
          return true;
        }
        const clickErr = String(clickResult.errorText || '').toLowerCase();
        if (clickErr.includes('target page, context or browser has been closed') && isTargetSessionActive(context)) {
          logOAuthDebug(`[OAuth] camo-cli click-google-account-hint treat-as-ok after context switch hint=${normalizedHint} selector=${preferredSelector}`);
          return true;
        }
        logOAuthDebug(`[OAuth] camo-cli click-google-account-hint click failed hint=${normalizedHint} selector=${preferredSelector} status=${clickResult.status ?? 'n/a'} error=${clickResult.errorText}`);
      }
    }
    logOAuthDebug(`[OAuth] camo-cli click-google-account-hint failed hint=${normalizedHint} attempt=${attempt}/${retries} status=${result.status ?? 'n/a'} error=${result.errorText || result.value}`);
    if (attempt < retries && options.retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs));
  }
  if (options.required) { logOAuthDebug(`[OAuth] camo-cli click-google-account-hint required but not matched hint=${normalizedHint}`); return false; }
  logOAuthDebug(`[OAuth] camo-cli click-google-account-hint not matched (non-required) hint=${normalizedHint}`); return true;
}
