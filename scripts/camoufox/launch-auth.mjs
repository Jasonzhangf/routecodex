#!/usr/bin/env node
// Camoufox OAuth launcher for RouteCodex
// Usage: node launch-auth.mjs --profile <profileId> --url <oauth_or_portal_url>

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function isTruthy(value) {
  if (!value) return false;
  const v = String(value).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function parseArgs(argv) {
  const args = { profile: 'default', url: '', autoMode: '', devMode: false };
  const list = argv.slice(2);
  for (let i = 0; i < list.length; i += 1) {
    const key = list[i];
    if (key === '--dev') {
      args.devMode = true;
      continue;
    }
    const val = list[i + 1] ?? '';
    if (key === '--profile' && val) {
      args.profile = String(val);
      i += 1;
    } else if (key === '--url' && val) {
      args.url = String(val);
      i += 1;
    } else if (key === '--auto-mode' && val) {
      args.autoMode = String(val);
      i += 1;
    }
  }
  if (!args.autoMode) {
    const envMode = (process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || '').trim();
    if (envMode) {
      args.autoMode = envMode;
    }
  }
  if (!args.devMode) {
    const envDev = (process.env.ROUTECODEX_CAMOUFOX_DEV_MODE || '').trim();
    if (envDev && envDev !== '0' && envDev.toLowerCase() !== 'false') {
      args.devMode = true;
    }
  }
  return args;
}

function stripAnsi(input) {
  return input.replace(/\u001b\[[0-9;]*m/g, '');
}

async function getCamoufoxCacheRoot() {
  return new Promise((resolve) => {
    const child = spawn('python3', ['-m', 'camoufox', 'path'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const cleaned = stripAnsi(out).trim();
      const line = cleaned.split(/\r?\n/).filter((l) => l.trim()).pop() || '';
      resolve(line || null);
    });
  });
}

function resolveCamoufoxBinary(cacheRoot) {
  const override = (process.env.ROUTECODEX_CAMOUFOX_BINARY || '').trim();
  if (override) {
    return override;
  }

  const isMac = process.platform === 'darwin';
  if (!cacheRoot && isMac) {
    // Best-effort fallback when python3 is unavailable/broken:
    // Camoufox's packaged app is commonly placed under ~/Library/Caches/camoufox/Camoufox.app.
    const guessed = path.join(os.homedir(), 'Library', 'Caches', 'camoufox');
    if (fs.existsSync(path.join(guessed, 'Camoufox.app'))) {
      cacheRoot = guessed;
    }
  }
  if (cacheRoot && isMac) {
    const appPath = path.join(cacheRoot, 'Camoufox.app');
    const macBinary = path.join(appPath, 'Contents', 'MacOS', 'camoufox');
    if (fs.existsSync(macBinary)) {
      return macBinary;
    }
  }

  try {
    const located = spawnSync('which', ['camoufox'], { encoding: 'utf-8' });
    if (located.status === 0) {
      const resolved = String(located.stdout || '').trim();
      if (resolved) {
        return resolved;
      }
    }
  } catch {
    // ignore lookup failure
  }

  return 'camoufox';
}

async function ensureProfileDir(profileId) {
  const root = path.join(os.homedir(), '.routecodex', 'camoufox-profiles');
  const dir = path.join(root, profileId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupExistingCamoufox(profileDir) {
  if (!profileDir) {
    return;
  }
  console.log('[camoufox-launch-auth] Ensuring Camoufox profile is clean before launch...');
  const pkillArgs = ['-f', profileDir];
  try {
    spawnSync('pkill', pkillArgs, { stdio: 'ignore' });
  } catch {
    // pkill may not exist; ignore
  }
  const lockNames = ['.parentlock', 'parent.lock', 'lock'];
  for (const name of lockNames) {
    const target = path.join(profileDir, name);
    try {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { force: true });
      }
    } catch {
      // ignore lock cleanup failure
    }
  }
}

async function main() {
  const { profile, url, autoMode, devMode } = parseArgs(process.argv);
  if (!url) {
    console.error('[camoufox-launch-auth] Missing --url');
    process.exit(1);
  }

  const profileId = profile || 'default';
  const profileDir = await ensureProfileDir(profileId);

  const cacheRoot = await getCamoufoxCacheRoot();
  if (!cacheRoot) {
    console.warn(
      '[camoufox-launch-auth] Failed to resolve Camoufox cache root via "python3 -m camoufox path"; falling back to PATH/override.'
    );
  }

  const camoufoxBinary = resolveCamoufoxBinary(cacheRoot);

  if (autoMode && autoMode.trim().toLowerCase() === 'iflow') {
    try {
      await runAutoFlowWithFallback('iflow', { url, profileDir, profileId, camoufoxBinary, devMode });
      process.exit(0);
    } catch (error) {
      console.error(
        '[camoufox-launch-auth] Auto iflow auth failed:',
        error instanceof Error ? error.message : String(error)
      );
      process.exit(1);
    }
    return;
  }

  if (autoMode && autoMode.trim().toLowerCase() === 'gemini') {
    try {
      await runAutoFlowWithFallback('gemini', { url, profileDir, profileId, camoufoxBinary, devMode });
      process.exit(0);
    } catch (error) {
      console.error(
        '[camoufox-launch-auth] Auto gemini auth failed:',
        error instanceof Error ? error.message : String(error)
      );
      process.exit(1);
    }
    return;
  }

  if (autoMode && autoMode.trim().toLowerCase() === 'antigravity') {
    try {
      await runAutoFlowWithFallback('antigravity', { url, profileDir, profileId, camoufoxBinary, devMode });
      process.exit(0);
    } catch (error) {
      console.error(
        '[camoufox-launch-auth] Auto antigravity auth failed:',
        error instanceof Error ? error.message : String(error)
      );
      process.exit(1);
    }
    return;
  }

  if (autoMode && autoMode.trim().toLowerCase() === 'qwen') {
    try {
      await runAutoFlowWithFallback('qwen', { url, profileDir, profileId, camoufoxBinary, devMode });
      process.exit(0);
    } catch (error) {
      console.error(
        '[camoufox-launch-auth] Auto qwen auth failed:',
        error instanceof Error ? error.message : String(error)
      );
      process.exit(1);
    }
    return;
  }

  await launchManualCamoufox({ camoufoxBinary, profileDir, url });
}

main().catch((err) => {
  console.error('[camoufox-launch-auth] Unexpected error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

async function launchManualCamoufox({ camoufoxBinary, profileDir, url }) {
  let browserExitCode = 0;
  let browser = null;
  const shutdownBrowser = (signal = 'SIGTERM') => {
    try {
      if (!browser) {
        return;
      }
      browser.kill(signal);
    } catch {
      // ignore
    }
  };
  ['SIGTERM', 'SIGINT', 'SIGHUP'].forEach((signal) => {
    process.on(signal, () => shutdownBrowser(signal));
  });

  try {
    browser = spawn(camoufoxBinary, ['-profile', profileDir, url], {
      detached: false,
      stdio: 'ignore'
    });

    browserExitCode = await new Promise((resolve) => {
      browser.on('exit', (code) => resolve(code ?? 0));
      browser.on('error', () => resolve(1));
    });
  } catch (error) {
    console.error(
      '[camoufox-launch-auth] Failed to launch Camoufox:',
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }

  process.exit(browserExitCode);
}

function isSelectorOrTimeoutError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return (
    /timeout/i.test(message) ||
    /waiting for selector/i.test(message) ||
    /strict mode violation/i.test(message) ||
    message.includes('未能定位') ||
    message.includes('无法定位')
  );
}

async function runHeadedManualAssistFlow({ url, profileDir, camoufoxBinary, timeoutMs, label }) {
  let firefox;
  try {
    ({ firefox } = await import('playwright-core'));
  } catch (error) {
    throw new Error(
      `playwright-core is required for headed manual assist (${error instanceof Error ? error.message : String(error)})`
    );
  }

  console.warn(
    `[camoufox-launch-auth] ${label}: falling back to headed mode for manual completion (no selector match).`
  );
  cleanupExistingCamoufox(profileDir);
  const context = await firefox.launchPersistentContext(profileDir, {
    executablePath: camoufoxBinary,
    headless: false,
    acceptDownloads: false
  });

  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    await context.close().catch(() => {});
  };
  ['SIGTERM', 'SIGINT', 'SIGHUP'].forEach((signal) => {
    process.on(signal, () => {
      void shutdown().finally(() => process.exit(0));
    });
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    console.log('[camoufox-launch-auth] Headed browser opened. Please complete OAuth manually...');
    const callbackPage = await waitForCallback(context, page, timeoutMs);
    await callbackPage.waitForLoadState('load', { timeout: 120000 }).catch(() => {});
    console.log('[camoufox-launch-auth] OAuth callback detected, manual completion finished.');
  } finally {
    await shutdown();
  }
}

async function runAutoFlowWithFallback(kind, options) {
  const mode = String(kind || '').trim().toLowerCase();
  const label = mode || 'auto';
  const timeoutMs = Number(process.env.ROUTECODEX_CAMOUFOX_GEMINI_TIMEOUT_MS || 120_000);

  try {
    if (mode === 'iflow') {
      await runIflowAutoFlow(options);
      return;
    }
    if (mode === 'gemini') {
      await runGeminiAutoFlow(options);
      return;
    }
    if (mode === 'antigravity') {
      await runAntigravityAutoFlow(options);
      return;
    }
    if (mode === 'qwen') {
      await runQwenAutoFlow(options);
      return;
    }
    throw new Error(`Unknown auto mode: ${mode}`);
  } catch (error) {
    if (!options.devMode && isSelectorOrTimeoutError(error)) {
      await runHeadedManualAssistFlow({
        url: options.url,
        profileDir: options.profileDir,
        camoufoxBinary: options.camoufoxBinary,
        timeoutMs: Number(process.env.ROUTECODEX_OAUTH_TIMEOUT_MS || 10 * 60_000),
        label
      });
      return;
    }
    throw error;
  }
}

async function runIflowAutoFlow({ url, profileDir, profileId, camoufoxBinary, devMode }) {
  let firefox;
  try {
    ({ firefox } = await import('playwright-core'));
  } catch (error) {
    throw new Error(
      `playwright-core is required for auto iflow auth (${error instanceof Error ? error.message : String(error)})`
    );
  }

  const headless = !devMode;
  console.log(`[camoufox-launch-auth] Launching Camoufox in ${headless ? 'headless' : 'headed'} mode...`);
  cleanupExistingCamoufox(profileDir);
  const context = await firefox.launchPersistentContext(profileDir, {
    executablePath: camoufoxBinary,
    headless,
    acceptDownloads: false
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await context.close().catch(() => {});
  };
  ['SIGTERM', 'SIGINT', 'SIGHUP'].forEach((signal) => {
    process.on(signal, () => {
      void shutdown().finally(() => process.exit(0));
    });
  });

  let callbackObserved = false;
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('[camoufox-launch-auth] Portal loaded, auto-clicking continue button...');
    const button = page.locator('#continue-btn');
    await button.waitFor({ timeout: 20000 });
    console.log('[camoufox-launch-auth] Continue button located, preparing to click...');
    const popupPromise = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
    await button.click();
    console.log('[camoufox-launch-auth] Continue button clicked, waiting for iFlow window...');
    const popup = await popupPromise;
    const iflowPage = popup ?? page;
    const selectors = [
      'span.accountName--ZKlffRBc',
      'span[class^="accountName--"]',
      'span[class*="accountName--"]',
      '.account-item span[class*="account"]',
      '.accountName span'
    ];
    const selectorQuery = selectors.join(', ');
    console.log('[camoufox-launch-auth] Waiting for iFlow OAuth URL or account DOM to load...');
    const waitForUrlPromise = iflowPage
      .waitForURL((current) => typeof current === 'string' && current.includes('iflow.cn'), { timeout: 60000 })
      .then(() => 'url');
    const waitForDomPromise = iflowPage
      .waitForSelector(selectorQuery, { timeout: 60000 })
      .then(() => 'dom');
    const raceResult = await Promise.race([waitForUrlPromise, waitForDomPromise]);
    waitForUrlPromise.catch(() => {});
    waitForDomPromise.catch(() => {});
    if (raceResult === 'url') {
      console.log(`[camoufox-launch-auth] iFlow URL detected: ${await iflowPage.url()}`);
      await iflowPage.waitForSelector(selectorQuery, { timeout: 60000 });
    } else {
      console.log('[camoufox-launch-auth] Account DOM detected before URL change, continuing...');
    }
    console.log('[camoufox-launch-auth] iFlow OAuth page detected, selecting account...');
    const account = iflowPage.locator(selectorQuery).first();
    await account.waitFor({ timeout: 60000 });
    const matches = await iflowPage.locator(selectors.join(', ')).count().catch(() => 0);
    console.log(`[camoufox-launch-auth] Account locator candidates: ${matches}`);
    console.log('[camoufox-launch-auth] Account element located, preparing to click...');
    await account.scrollIntoViewIfNeeded().catch(() => {});
    await account.hover({ force: true }).catch(() => {});
    const handle = await account.elementHandle();
    const fallbackClicked = await iflowPage.evaluate((el) => {
      if (!el) {
        return false;
      }
      const log = (...args) => console.log('[camoufox-launch-auth][in-page]', ...args);
      const findClickableAncestor = (node) => {
        let current = node;
        let depth = 0;
        while (current && depth < 6) {
          if (current instanceof HTMLElement) {
            const className = current.className || '';
            if (/account/i.test(className) || current.tagName === 'BUTTON') {
              log('clickable ancestor found', current.className);
              return current;
            }
          }
          current = current.parentElement;
          depth += 1;
        }
        return node instanceof HTMLElement ? node : null;
      };
      const target = findClickableAncestor(el);
      if (!target) {
        log('no clickable ancestor located for account span');
        return false;
      }
      log('dispatching events to target element');
      const events = ['mouseenter', 'mouseover', 'mousemove', 'mousedown', 'mouseup', 'click'];
      for (const type of events) {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    }, handle);
    console.log(
      '[camoufox-launch-auth] Account click evaluation result:',
      fallbackClicked ? 'success' : 'failed'
    );
    if (!fallbackClicked) {
      throw new Error('未能定位到可点击的账号元素');
    }
    console.log('[camoufox-launch-auth] Account clicked, waiting for callback...');

    const callbackPage = await waitForCallback(context, iflowPage);
    callbackObserved = true;
    await callbackPage.waitForLoadState('load', { timeout: 120000 }).catch(() => {});
    console.log('[camoufox-launch-auth] OAuth callback detected, automation complete.');
  } catch (error) {
    if (callbackObserved && isBrowserClosedError(error)) {
      console.warn('[camoufox-launch-auth] Browser closed after callback; continuing.');
      return;
    }
    throw error;
  } finally {
    await shutdown();
  }
}

async function runGeminiAutoFlow({ url, profileDir, camoufoxBinary, devMode }) {
  let firefox;
  try {
    ({ firefox } = await import('playwright-core'));
  } catch (error) {
    throw new Error(
      `playwright-core is required for auto gemini auth (${error instanceof Error ? error.message : String(error)})`
    );
  }

  const timeoutMs = Number(process.env.ROUTECODEX_CAMOUFOX_GEMINI_TIMEOUT_MS || 120_000);
  const accountPreference = (process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT || '').trim();
  cleanupExistingCamoufox(profileDir);
  const context = await firefox.launchPersistentContext(profileDir, {
    executablePath: camoufoxBinary,
    headless: !devMode,
    acceptDownloads: false
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await context.close().catch(() => {});
  };
  ['SIGTERM', 'SIGINT', 'SIGHUP'].forEach((signal) => {
    process.on(signal, () => {
      void shutdown().finally(() => process.exit(0));
    });
  });

  let callbackObserved = false;
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    console.log('[camoufox-launch-auth] Gemini portal loaded, waiting for account selector (<=120s)...');
    const accountSelector = 'div.pGzURd[jsname="V1ur5d"]';
    const accounts = page.locator(accountSelector);
    await accounts.first().waitFor({ timeout: timeoutMs });
    const totalAccounts = await accounts.count();
    console.log(`[camoufox-launch-auth] Gemini accounts detected: ${totalAccounts}`);

    let targetAccount = accounts.first();
    if (accountPreference) {
      const preferred = accounts.filter({ hasText: accountPreference });
      if (await preferred.count()) {
        console.log(`[camoufox-launch-auth] Selecting account matching preference "${accountPreference}"`);
        targetAccount = preferred.first();
      } else {
        console.warn(
          `[camoufox-launch-auth] Preferred account text "${accountPreference}" not found; falling back to first account`
        );
      }
    }

    await targetAccount.scrollIntoViewIfNeeded().catch(() => {});
    await targetAccount.hover({ force: true }).catch(() => {});
    const handle = await targetAccount.elementHandle();
    if (!handle) {
      throw new Error('无法定位 Gemini 账号元素用于点击');
    }
    const accountText = await targetAccount.innerText().catch(() => '');
    console.log(`[camoufox-launch-auth] Gemini account element located (${accountText || 'unknown label'}), clicking...`);
    await page.evaluate((el) => {
      const events = ['mouseenter', 'mouseover', 'mousemove', 'mousedown', 'mouseup', 'click'];
      for (const type of events) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
    }, handle);

    const confirmSelector = 'div.VfPpkd-RLmnJb';
    const confirmResult = await waitForElementInPages(context, confirmSelector, timeoutMs);
    if (confirmResult) {
      console.log('[camoufox-launch-auth] Confirmation button detected, clicking...');
      try {
        await confirmResult.locator.first().click({ timeout: timeoutMs });
      } catch {
        await confirmResult.page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return;
          const events = ['mouseenter', 'mouseover', 'mousemove', 'mousedown', 'mouseup', 'click'];
          for (const type of events) {
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
          }
        }, confirmSelector);
      }
      console.log('[camoufox-launch-auth] Confirmation acknowledged, waiting for callback...');
    } else {
      console.log('[camoufox-launch-auth] No confirmation button detected within 120s, continuing...');
    }

    const activePage = confirmResult?.page || authPage;
    const callbackPage = await waitForCallback(context, activePage);
    await callbackPage.waitForLoadState('load', { timeout: timeoutMs }).catch(() => {});
    console.log('[camoufox-launch-auth] OAuth callback detected, automation complete.');
  } finally {
    await shutdown();
  }
}

async function runAntigravityAutoFlow({ url, profileDir, camoufoxBinary, devMode }) {
  let firefox;
  try {
    ({ firefox } = await import('playwright-core'));
  } catch (error) {
    throw new Error(
      `playwright-core is required for auto antigravity auth (${error instanceof Error ? error.message : String(error)})`
    );
  }

  const timeoutMs = Number(process.env.ROUTECODEX_CAMOUFOX_GEMINI_TIMEOUT_MS || 120_000);
  const accountPreference = (process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT || '').trim();
  cleanupExistingCamoufox(profileDir);
  const context = await firefox.launchPersistentContext(profileDir, {
    executablePath: camoufoxBinary,
    headless: !devMode,
    acceptDownloads: false
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await context.close().catch(() => {});
  };
  ['SIGTERM', 'SIGINT', 'SIGHUP'].forEach((signal) => {
    process.on(signal, () => {
      void shutdown().finally(() => process.exit(0));
    });
  });

  let callbackObserved = false;
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    let authPage = page;
    if (page.url().includes('token-auth')) {
      console.log('[camoufox-launch-auth] Portal detected, auto-clicking continue button...');
      const button = page.locator('#continue-btn');
      await button.waitFor({ timeout: 20000 });
      const popupPromise = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
      await button.click();
      const popup = await popupPromise;
      authPage = popup ?? page;
      await authPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    }

    console.log('[camoufox-launch-auth] Antigravity OAuth page loaded, waiting for account selector (<=120s)...');
    const accountSelector = 'div.yAlK0b[jsname="bQIQze"]';
    const accounts = authPage.locator(accountSelector);
    await accounts.first().waitFor({ timeout: timeoutMs });
    const totalAccounts = await accounts.count();
    console.log(`[camoufox-launch-auth] Antigravity accounts detected: ${totalAccounts}`);

    let targetAccount = accounts.first();
    if (accountPreference) {
      const preferred = accounts.filter({ hasText: accountPreference });
      if (await preferred.count()) {
        console.log(`[camoufox-launch-auth] Selecting account matching preference "${accountPreference}"`);
        targetAccount = preferred.first();
      } else {
        console.warn(
          `[camoufox-launch-auth] Preferred account text "${accountPreference}" not found; falling back to first account`
        );
      }
    }

    await targetAccount.scrollIntoViewIfNeeded().catch(() => {});
    await targetAccount.hover({ force: true }).catch(() => {});
    const handle = await targetAccount.elementHandle();
    if (!handle) {
      throw new Error('无法定位 Antigravity 账号元素用于点击');
    }
    const accountText = await targetAccount.innerText().catch(() => '');
    console.log(
      `[camoufox-launch-auth] Antigravity account element located (${accountText || 'unknown label'}), clicking...`
    );
    await authPage.evaluate((el) => {
      const events = ['mouseenter', 'mouseover', 'mousemove', 'mousedown', 'mouseup', 'click'];
      for (const type of events) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
    }, handle);

    const confirmSelector = 'span.VfPpkd-vQzf8d[jsname="V67aGc"]';
    const confirmResult = await waitForElementInPages(context, confirmSelector, timeoutMs);
    if (confirmResult) {
      const signIn = confirmResult.locator.filter({ hasText: 'Sign in' });
      if ((await signIn.count().catch(() => 0)) > 0) {
        console.log('[camoufox-launch-auth] Sign-in confirmation span located (jsname=V67aGc), clicking...');
        await signIn.first().click({ timeout: timeoutMs }).catch(() => {});
        console.log('[camoufox-launch-auth] Antigravity confirmation acknowledged, waiting for callback...');
      } else {
        console.warn('[camoufox-launch-auth] Confirmation element present but text mismatch; skipping auto-click.');
      }
    } else {
      console.log('[camoufox-launch-auth] No Antigravity confirmation button detected within 120s, continuing...');
    }

    const activePage = confirmResult?.page || authPage;
    const callbackPage = await waitForCallback(context, activePage);
    callbackObserved = true;
    await callbackPage.waitForLoadState('load', { timeout: timeoutMs }).catch(() => {});
    console.log('[camoufox-launch-auth] OAuth callback detected, automation complete.');
  } catch (error) {
    if (callbackObserved && isBrowserClosedError(error)) {
      console.warn('[camoufox-launch-auth] Browser closed after callback; continuing.');
      return;
    }
    throw error;
  } finally {
    await shutdown();
  }
}

async function runQwenAutoFlow({ url, profileDir, camoufoxBinary, devMode }) {
  let firefox;
  try {
    ({ firefox } = await import('playwright-core'));
  } catch (error) {
    throw new Error(
      `playwright-core is required for auto qwen auth (${error instanceof Error ? error.message : String(error)})`
    );
  }

  const timeoutMs = Number(process.env.ROUTECODEX_CAMOUFOX_QWEN_TIMEOUT_MS || 120_000);
  cleanupExistingCamoufox(profileDir);
  const context = await firefox.launchPersistentContext(profileDir, {
    executablePath: camoufoxBinary,
    headless: !devMode,
    acceptDownloads: false
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await context.close().catch(() => {});
  };
  ['SIGTERM', 'SIGINT', 'SIGHUP'].forEach((signal) => {
    process.on(signal, () => {
      void shutdown().finally(() => process.exit(0));
    });
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    let authPage = page;
    if (page.url().includes('token-auth')) {
      console.log('[camoufox-launch-auth] Portal detected, auto-clicking continue button...');
      const button = page.locator('#continue-btn');
      await button.waitFor({ timeout: 20000 });
      const popupPromise = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
      await button.click();
      const popup = await popupPromise;
      authPage = popup ?? page;
      await authPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    }

    console.log('[camoufox-launch-auth] Qwen authorize page loaded, waiting for confirm button...');
    const confirmSelector = 'button.qwen-confirm-btn';
    const confirmResult = await waitForElementInPages(context, confirmSelector, timeoutMs);
    if (!confirmResult) {
      throw new Error('未能定位 Qwen Confirm 按钮');
    }
    console.log('[camoufox-launch-auth] Qwen confirm button detected, clicking...');
    try {
      await confirmResult.locator.first().click({ timeout: timeoutMs });
    } catch {
      await confirmResult.page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return;
        const events = ['mouseenter', 'mouseover', 'mousemove', 'mousedown', 'mouseup', 'click'];
        for (const type of events) {
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
      }, confirmSelector);
    }
    console.log('[camoufox-launch-auth] Qwen confirm clicked. Waiting briefly for authorization to settle...');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } finally {
    await shutdown();
  }
}

function isBrowserClosedError(error) {
  if (!error) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Target page, context or browser has been closed');
}

async function waitForElementInPages(context, selector, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const candidate of context.pages()) {
      try {
        const locator = candidate.locator(selector);
        if ((await locator.count()) > 0) {
          return { page: candidate, locator };
        }
      } catch {
        // ignore closed pages
      }
    }
    const elapsed = Date.now() - start;
    const remaining = timeoutMs - elapsed;
    const waitSlice = Math.min(1000, remaining);
    if (waitSlice <= 0) {
      break;
    }
    try {
      await context.waitForEvent('page', { timeout: waitSlice });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, waitSlice));
    }
  }
  return null;
}

async function waitForCallback(context, fallbackPage, timeoutMs = 120000) {
  const isCallbackUrl = (current) => {
    if (typeof current !== 'string') {
      return false;
    }
    const lower = current.toLowerCase();
    return (
      lower.startsWith('http://127.0.0.1') ||
      lower.startsWith('http://localhost') ||
      lower.startsWith('https://127.0.0.1')
    );
  };

  const currentPages = context.pages();
  for (const page of currentPages) {
    if (isCallbackUrl(page.url())) {
      return page;
    }
  }

  try {
    await fallbackPage.waitForURL((current) => isCallbackUrl(current), { timeout: timeoutMs });
    return fallbackPage;
  } catch {
    // ignore and wait for popup
  }

  const callback = await context.waitForEvent('page', { timeout: timeoutMs });
  await callback.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  return callback;
}
