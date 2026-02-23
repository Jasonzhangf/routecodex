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

function isFalsy(value) {
  if (!value) return false;
  const v = String(value).trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'no' || v === 'off';
}

function resolveIflowHeadlessMode(devMode) {
  if (devMode) {
    return false;
  }
  const raw = String(
    process.env.ROUTECODEX_CAMOUFOX_IFLOW_HEADLESS ||
    process.env.RCC_CAMOUFOX_IFLOW_HEADLESS ||
    ''
  ).trim();
  if (!raw) {
    return false;
  }
  if (isFalsy(raw)) {
    return false;
  }
  return isTruthy(raw);
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

function resolveGoogleLanguageHint() {
  const raw = String(
    process.env.ROUTECODEX_OAUTH_GOOGLE_HL ||
    process.env.RCC_OAUTH_GOOGLE_HL ||
    'en'
  ).trim();
  if (!raw) {
    return 'en';
  }
  const lowered = raw.toLowerCase();
  if (lowered === 'auto' || lowered === 'off' || lowered === 'none' || lowered === '0' || lowered === 'false') {
    return 'en';
  }
  return raw.replace(/_/g, '-');
}

function buildLocaleEnv() {
  const localeTag = resolveGoogleLanguageHint();
  const parts = String(localeTag || 'en').split('-').filter(Boolean);
  const language = (parts[0] || 'en').toLowerCase();
  const region = (parts[1] || (language === 'zh' ? 'CN' : language === 'ja' ? 'JP' : language === 'ko' ? 'KR' : 'US')).toUpperCase();
  const normalizedTag = `${language}-${region}`;
  const posixLocale = `${language}_${region}.UTF-8`;
  return {
    LANG: posixLocale,
    LC_ALL: posixLocale,
    LANGUAGE: normalizedTag
  };
}

function buildFirefoxUserPrefs() {
  const lang = resolveGoogleLanguageHint();
  const osFonts = process.platform === 'darwin'
    ? {
        sansCn: 'PingFang SC, Hiragino Sans GB, Heiti SC',
        serifCn: 'Songti SC, STSong',
        sansJa: 'Hiragino Sans, Yu Gothic, Osaka',
        sansKo: 'Apple SD Gothic Neo, Nanum Gothic'
      }
    : {
        sansCn: 'Noto Sans CJK SC, Microsoft YaHei, SimHei',
        serifCn: 'Noto Serif CJK SC, SimSun',
        sansJa: 'Noto Sans CJK JP, Yu Gothic',
        sansKo: 'Noto Sans CJK KR, Malgun Gothic'
      };

  return {
    'intl.accept_languages': lang,
    'javascript.use_us_english_locale': true,
    'intl.charset.fallback.override': 'UTF-8',
    'gfx.downloadable_fonts.enabled': true,
    'browser.startup.page': 0,
    'browser.sessionstore.resume_from_crash': false,
    'browser.sessionstore.resume_session_once': false,
    'browser.sessionstore.max_resumed_crashes': 0,
    'layers.acceleration.disabled': true,
    'gfx.webrender.all': false,
    'gfx.webrender.software': true,
    'media.hardware-video-decoding.enabled': false,
    'font.default.x-western': 'sans-serif',
    'font.name.sans-serif.x-western': 'Arial',
    'font.name.serif.x-western': 'Times New Roman',
    'font.name.sans-serif.zh-CN': osFonts.sansCn,
    'font.name.serif.zh-CN': osFonts.serifCn,
    'font.name.sans-serif.ja': osFonts.sansJa,
    'font.name.sans-serif.ko': osFonts.sansKo
  };
}

function buildCamoufoxLaunchEnv() {
  return {
    ...process.env,
    ...buildLocaleEnv()
  };
}

function quoteUserPrefValue(value) {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(String(value));
}

function buildManagedUserPrefBlock() {
  const start = '// ROUTECODEX_CAMOUFOX_PREFS_BEGIN';
  const end = '// ROUTECODEX_CAMOUFOX_PREFS_END';
  const prefs = buildFirefoxUserPrefs();
  const lines = [start];
  for (const [key, value] of Object.entries(prefs)) {
    lines.push('user_pref(' + JSON.stringify(key) + ', ' + quoteUserPrefValue(value) + ');');
  }
  lines.push(end);
  return lines.join('\n') + '\n';
}

function ensureManagedProfilePrefs(profileDir) {
  const userJsPath = path.join(profileDir, 'user.js');
  const start = '// ROUTECODEX_CAMOUFOX_PREFS_BEGIN';
  const end = '// ROUTECODEX_CAMOUFOX_PREFS_END';
  const managedBlock = buildManagedUserPrefBlock();
  let existing = '';
  try {
    existing = fs.readFileSync(userJsPath, 'utf8');
  } catch {
    existing = '';
  }

  let nextContent = managedBlock;
  if (existing && existing.includes(start) && existing.includes(end)) {
    const pattern = new RegExp(start + '[\\s\\S]*?' + end + '\n?', 'm');
    nextContent = existing.replace(pattern, managedBlock);
  } else if (existing.trim().length > 0) {
    nextContent = existing.trimEnd() + '\n\n' + managedBlock;
  }

  fs.writeFileSync(userJsPath, nextContent, 'utf8');
}

async function getCamoufoxCacheRoot() {
  const timeoutMs = Number(process.env.ROUTECODEX_CAMOUFOX_PATH_TIMEOUT_MS || 8000);
  return new Promise((resolve) => {
    const child = spawn('python3', ['-m', 'camoufox', 'path'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      console.warn(
        `[camoufox-launch-auth] camoufox path resolution timed out after ${timeoutMs}ms; falling back to PATH/override.`
      );
      resolve(null);
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
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
  // 清理已知进程，不使用 pkill 普杀
  // 使用 pgrep 查找匹配的进程，然后逐个验证后终止
  try {
    const probe = spawnSync('pgrep', ['-f', profileDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    
    if (probe.status === 0 && probe.stdout) {
      const selfPid = process.pid;
      const lines = String(probe.stdout).split(/\r?\n/).filter(Boolean);
      
      for (const line of lines) {
        const pid = Number.parseInt(line.trim(), 10);
        if (!Number.isFinite(pid) || pid <= 0 || pid === selfPid) {
          continue;
        }
        // 验证进程命令包含 camoufox
        try {
          const cmdProbe = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
          const cmd = String(cmdProbe.stdout || '').toLowerCase();
          if (cmd.includes('camoufox')) {
            console.log(`[camoufox-launch-auth] Stopping known Camoufox process PID ${pid}`);
            try {
              process.kill(pid, 'SIGTERM');
            } catch {
              // 忽略终止失败
            }
          }
        } catch {
          // 忽略 ps 查询失败
        }
      }
    }
  } catch {
    // pgrep 可能不存在，忽略
  }
  console.log('[camoufox-launch-auth] Ensuring Camoufox profile is clean before launch...');
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
  const volatileStatePaths = [
    'sessionstore.jsonlz4',
    'sessionstore-backups',
    'recovery.jsonlz4',
    'recovery.baklz4',
    'previous.jsonlz4',
    'sessionCheckpoints.json',
    'startupCache'
  ];
  for (const rel of volatileStatePaths) {
    const target = path.join(profileDir, rel);
    try {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    } catch {
      // ignore volatile state cleanup failure
    }
  }
}

function hasRunningCamoufoxForProfile(profileDir) {
  if (!profileDir) {
    return false;
  }
  try {
    const running = listRunningCamoufoxProcesses();
    return running.some((proc) => String(proc.command || '').includes(profileDir));
  } catch {
    return false;
  }
}

function hasAnyRunningCamoufox() {
  try {
    return listRunningCamoufoxProcesses().length > 0;
  } catch {
    return false;
  }
}

function listRunningCamoufoxProcesses() {
  const probe = spawnSync('pgrep', ['-fal', 'camoufox'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (!probe || probe.status !== 0) {
    return [];
  }

  const selfPid = process.pid;
  const lines = String(probe.stdout || '')
    .split(/\r?\n/)
    .map((line) => String(line || '').trim())
    .filter(Boolean);

  const result = [];
  for (const line of lines) {
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx <= 0) {
      continue;
    }
    const pid = Number(line.slice(0, spaceIdx));
    const command = line.slice(spaceIdx + 1).trim();
    if (!Number.isFinite(pid) || pid <= 0 || pid === selfPid) {
      continue;
    }
    const cmd = command.toLowerCase();
    if (!cmd) {
      continue;
    }
    if (cmd.includes('launch-auth.mjs')) {
      continue;
    }
    if (cmd.includes('pgrep -fal camoufox')) {
      continue;
    }
    const looksLikeCamoufox =
      cmd.includes('camoufox.app/contents/macos/camoufox') ||
      /(^|\/)camoufox(\s|$)/.test(cmd);
    if (!looksLikeCamoufox) {
      continue;
    }
    result.push({ pid, command });
  }
  return result;
}

async function main() {
  const { profile, url, autoMode, devMode } = parseArgs(process.argv);
  if (!url) {
    console.error('[camoufox-launch-auth] Missing --url');
    process.exit(1);
  }

  const profileId = profile || 'default';
  const profileDir = await ensureProfileDir(profileId);
  try {
    ensureManagedProfilePrefs(profileDir);
  } catch (error) {
    console.warn(
      '[camoufox-launch-auth] Failed to persist managed profile prefs:',
      error instanceof Error ? error.message : String(error)
    );
  }

  const urlPreview = String(url).length > 160 ? `${String(url).slice(0, 160)}…` : String(url);
  console.log(
    `[camoufox-launch-auth] start profileId=${profileId} devMode=${devMode ? '1' : '0'} autoMode=${autoMode || '-'}`
  );
  console.log(`[camoufox-launch-auth] url=${urlPreview}`);

  const binaryOverride = (process.env.ROUTECODEX_CAMOUFOX_BINARY || '').trim();
  if (binaryOverride) {
    console.log('[camoufox-launch-auth] ROUTECODEX_CAMOUFOX_BINARY is set; skipping python3 camoufox path lookup.');
  } else {
    console.log('[camoufox-launch-auth] Resolving Camoufox path via python3 -m camoufox path ...');
  }

  const cacheRoot = binaryOverride ? null : await getCamoufoxCacheRoot();
  if (!cacheRoot) {
    console.warn(
      '[camoufox-launch-auth] Failed to resolve Camoufox cache root via "python3 -m camoufox path"; falling back to PATH/override.'
    );
  }

  const camoufoxBinary = resolveCamoufoxBinary(cacheRoot);
  console.log(`[camoufox-launch-auth] binary=${camoufoxBinary}`);
  console.log(`[camoufox-launch-auth] profileDir=${profileDir}`);

  const openOnly = isTruthy(
    process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY || process.env.RCC_CAMOUFOX_OPEN_ONLY
  );
  if (openOnly) {
    console.log('[camoufox-launch-auth] open-only mode enabled; launching Camoufox and exiting (no automation/wait).');
    await launchCamoufoxDetached({ camoufoxBinary, profileDir, url });
    process.exit(0);
    return;
  }

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

  // Interactive CLI flows set devMode=true by default. In that case, prefer Playwright headed
  // "manual assist" mode so users always see a window and clear progress logs.
  if (devMode) {
    try {
      await runHeadedManualAssistFlow({
        url,
        profileDir,
        camoufoxBinary,
        timeoutMs: Number(process.env.ROUTECODEX_OAUTH_TIMEOUT_MS || 10 * 60_000),
        label: 'manual'
      });
      process.exit(0);
    } catch (error) {
      console.warn(
        '[camoufox-launch-auth] manual: headed assist failed, falling back to direct Camoufox launch:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  await launchManualCamoufox({ camoufoxBinary, profileDir, url });
}

main().catch((err) => {
  console.error('[camoufox-launch-auth] Unexpected error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

async function launchManualCamoufox({ camoufoxBinary, profileDir, url }) {
  console.log('[camoufox-launch-auth] Launching Camoufox (direct binary) for manual completion...');
  console.log(`[camoufox-launch-auth] binary=${camoufoxBinary}`);
  console.log(`[camoufox-launch-auth] profileDir=${profileDir}`);
  console.log(`[camoufox-launch-auth] url=${url}`);
  if (hasRunningCamoufoxForProfile(profileDir)) {
    console.log(
      '[camoufox-launch-auth] Same OAuth profile is already running; cleaning stale session state and relaunching isolated instance.'
    );
    cleanupExistingCamoufox(profileDir);
  } else if (hasAnyRunningCamoufox()) {
    console.log(
      '[camoufox-launch-auth] Detected other Camoufox instances with different profiles; launching isolated OAuth instance with -no-remote.'
    );
  }
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
    browser = spawn(camoufoxBinary, ['-no-remote', '-profile', profileDir, url], {
      detached: false,
      stdio: 'ignore',
      env: buildCamoufoxLaunchEnv()
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

async function launchCamoufoxDetached({ camoufoxBinary, profileDir, url }) {
  console.log('[camoufox-launch-auth] Launching Camoufox (detached) ...');
  if (hasRunningCamoufoxForProfile(profileDir)) {
    console.log(
      '[camoufox-launch-auth] Same OAuth profile is already running; cleaning stale session state and relaunching isolated instance.'
    );
    cleanupExistingCamoufox(profileDir);
  } else if (hasAnyRunningCamoufox()) {
    console.log(
      '[camoufox-launch-auth] Detected other Camoufox instances with different profiles; launching isolated OAuth instance with -no-remote.'
    );
  }
  try {
    const child = spawn(camoufoxBinary, ['-no-remote', '-profile', profileDir, url], {
      detached: true,
      stdio: 'ignore',
      env: buildCamoufoxLaunchEnv()
    });
    child.unref();
  } catch (error) {
    console.error(
      '[camoufox-launch-auth] Detached launch failed:',
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
}

function isSelectorOrTimeoutError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return (
    /timeout/i.test(message) ||
    /waiting for selector/i.test(message) ||
    /selector[^.\n]*not detected/i.test(message) ||
    /page\/account selector not detected/i.test(message) ||
    /not detected/i.test(message) ||
    /strict mode violation/i.test(message) ||
    /target page, context or browser has been closed/i.test(message) ||
    message.includes('未能定位') ||
    message.includes('无法定位') ||
    message.includes('未检测到')
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
    acceptDownloads: false,
    firefoxUserPrefs: buildFirefoxUserPrefs()
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
      if (mode === 'qwen') {
        await runHeadedQwenManualAssistFlow({
          url: options.url,
          profileDir: options.profileDir,
          camoufoxBinary: options.camoufoxBinary,
          timeoutMs: Number(process.env.ROUTECODEX_CAMOUFOX_QWEN_TIMEOUT_MS || 10 * 60_000)
        });
        return;
      }
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

async function runHeadedQwenManualAssistFlow({ url, profileDir, camoufoxBinary, timeoutMs }) {
  let firefox;
  try {
    ({ firefox } = await import('playwright-core'));
  } catch (error) {
    throw new Error(
      `playwright-core is required for headed qwen manual assist (${error instanceof Error ? error.message : String(error)})`
    );
  }

  console.warn(
    '[camoufox-launch-auth] qwen: falling back to headed mode for manual completion (no selector match).'
  );
  cleanupExistingCamoufox(profileDir);
  const context = await firefox.launchPersistentContext(profileDir, {
    executablePath: camoufoxBinary,
    headless: false,
    acceptDownloads: false,
    firefoxUserPrefs: buildFirefoxUserPrefs()
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
    console.log('[camoufox-launch-auth] Headed Qwen browser opened. Please complete Qwen authorization manually...');

    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const pages = context.pages();
      if (pages.length === 0) {
        console.log('[camoufox-launch-auth] Browser closed by user, exiting.');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    console.warn('[camoufox-launch-auth] Qwen manual assist timed out; exiting.');
  } finally {
    await shutdown();
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

  // iFlow OAuth has poor reliability under headless mode (often returns anti-bot/garbled pages).
  // Keep default headed to match camo CLI behavior; allow opt-in headless via env.
  const headless = resolveIflowHeadlessMode(devMode);
  const timeoutMs = Number(process.env.ROUTECODEX_CAMOUFOX_IFLOW_TIMEOUT_MS || 300_000);
  console.log(`[camoufox-launch-auth] Launching Camoufox in ${headless ? 'headless' : 'headed'} mode...`);
  cleanupExistingCamoufox(profileDir);
  const context = await firefox.launchPersistentContext(profileDir, {
    executablePath: camoufoxBinary,
    headless,
    acceptDownloads: false,
    firefoxUserPrefs: buildFirefoxUserPrefs()
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
    let iflowPage = popup ?? page;
    const selectors = [
      'span.accountName--ZKlffRBc',
      'span[class^="accountName--"]',
      'span[class*="accountName--"]',
      '.account-item span[class*="account"]',
      '.accountName span'
    ];
    const selectorQuery = selectors.join(', ');
    console.log('[camoufox-launch-auth] Waiting for iFlow OAuth URL or account DOM to load...');
    const waitForCallbackPromise = waitForCallback(context, iflowPage, 60000)
      .then((callbackPage) => ({ kind: 'callback', callbackPage }))
      .catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn('[camoufox-launch-auth] waitForCallback did not settle:', msg);
        return null;
      });
    const waitForUrlPromise = iflowPage
      .waitForURL((current) => typeof current === 'string' && current.includes('iflow.cn'), { timeout: 60000 })
      .then(() => ({ kind: 'url' }))
      .catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn('[camoufox-launch-auth] waitForURL did not settle:', msg);
        return null;
      });
    const waitForDomPromise = iflowPage
      .waitForSelector(selectorQuery, { timeout: 60000 })
      .then(() => ({ kind: 'dom' }))
      .catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn('[camoufox-launch-auth] waitForSelector did not settle:', msg);
        return null;
      });
    const raceResult = await Promise.race([waitForUrlPromise, waitForDomPromise, waitForCallbackPromise]);
    if (!raceResult) {
      const fallback = await waitForAnyElementInPages(context, selectors, 60000);
      if (fallback?.page) {
        iflowPage = fallback.page;
        console.log('[camoufox-launch-auth] Fallback page with account DOM detected, continuing...');
      } else {
        throw new Error('iFlow OAuth page/account selector not detected');
      }
    } else if (raceResult.kind === 'callback') {
      callbackObserved = true;
      await raceResult.callbackPage.waitForLoadState('load', { timeout: timeoutMs }).catch(() => {});
      console.log('[camoufox-launch-auth] OAuth callback detected before account selection, automation complete.');
      return;
    } else if (raceResult.kind === 'url') {
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

    const callbackPage = await waitForCallback(context, iflowPage, timeoutMs);
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

async function runGeminiAutoFlow({ url, profileDir, camoufoxBinary, devMode }) {
  let firefox;
  try {
    ({ firefox } = await import('playwright-core'));
  } catch (error) {
    throw new Error(
      `playwright-core is required for auto gemini auth (${error instanceof Error ? error.message : String(error)})`
    );
  }

  const timeoutMs = Number(process.env.ROUTECODEX_CAMOUFOX_GEMINI_TIMEOUT_MS || 300_000);
  const accountPreference = (process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT || '').trim();
  cleanupExistingCamoufox(profileDir);
  const context = await firefox.launchPersistentContext(profileDir, {
    executablePath: camoufoxBinary,
    headless: !devMode,
    acceptDownloads: false,
    firefoxUserPrefs: buildFirefoxUserPrefs()
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

    const activePage = confirmResult?.page || page;
    const callbackPage = await waitForCallback(context, activePage, timeoutMs);
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

  const timeoutMs = Number(process.env.ROUTECODEX_CAMOUFOX_GEMINI_TIMEOUT_MS || 300_000);
  const portalButtonTimeoutMs = Number(process.env.ROUTECODEX_CAMOUFOX_PORTAL_BUTTON_TIMEOUT_MS || 300_000);
  const portalPopupTimeoutMs = Number(process.env.ROUTECODEX_CAMOUFOX_PORTAL_POPUP_TIMEOUT_MS || 300_000);
  const pageLoadTimeoutMs = Number(process.env.ROUTECODEX_CAMOUFOX_PAGE_LOAD_TIMEOUT_MS || 300_000);
  const accountPreference = (process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT || '').trim();
  cleanupExistingCamoufox(profileDir);
  const context = await firefox.launchPersistentContext(profileDir, {
    executablePath: camoufoxBinary,
    headless: !devMode,
    acceptDownloads: false,
    firefoxUserPrefs: buildFirefoxUserPrefs()
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
      await button.waitFor({ timeout: portalButtonTimeoutMs });
      const popupPromise = context.waitForEvent('page', { timeout: portalPopupTimeoutMs }).catch(() => null);
      const navPromise = page
        .waitForURL((current) => typeof current === 'string' && !String(current).includes('token-auth'), {
          timeout: portalPopupTimeoutMs
        })
        .catch(() => null);
      try {
        await button.click({ timeout: portalButtonTimeoutMs });
      } catch {
        await page.evaluate(() => {
          const el = document.querySelector('#continue-btn');
          if (!el) return;
          const events = ['mouseenter', 'mouseover', 'mousemove', 'mousedown', 'mouseup', 'click'];
          for (const type of events) {
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
          }
        });
      }
      const popup = await popupPromise;
      if (popup) {
        authPage = popup;
      } else {
        await navPromise;
        authPage = page;
      }
      await authPage.waitForLoadState('domcontentloaded', { timeout: pageLoadTimeoutMs }).catch(() => {});
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

    // Google confirmation screens vary by locale/font/text; click by container/role instead of innerText.
    const confirmSelectors = [
      // Common primary action container on Google OAuth screens.
      'div.VfPpkd-RLmnJb',
      // Common button class.
      'button.VfPpkd-LgbsSe',
      // Alternate shape (sometimes rendered as div role=button).
      'div[role="button"].VfPpkd-LgbsSe'
    ];
    const confirmResult = await waitForAnyElementInPages(context, confirmSelectors, timeoutMs);
    if (confirmResult) {
      console.log(`[camoufox-launch-auth] Confirmation element detected (${confirmResult.selector}), clicking...`);
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
        }, confirmResult.selector);
      }
      console.log('[camoufox-launch-auth] Antigravity confirmation acknowledged, waiting for callback...');
    } else {
      console.log('[camoufox-launch-auth] No Antigravity confirmation button detected within 120s, continuing...');
    }

    const activePage = confirmResult?.page || authPage;
    const callbackPage = await waitForCallback(context, activePage, timeoutMs);
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
    acceptDownloads: false,
    firefoxUserPrefs: buildFirefoxUserPrefs()
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
      const portalButtonTimeoutMs = Number(process.env.ROUTECODEX_CAMOUFOX_PORTAL_BUTTON_TIMEOUT_MS || 300_000);
      const portalPopupTimeoutMs = Number(process.env.ROUTECODEX_CAMOUFOX_PORTAL_POPUP_TIMEOUT_MS || 300_000);
      const pageLoadTimeoutMs = Number(process.env.ROUTECODEX_CAMOUFOX_PAGE_LOAD_TIMEOUT_MS || 300_000);
      await button.waitFor({ timeout: portalButtonTimeoutMs });
      const popupPromise = context.waitForEvent('page', { timeout: portalPopupTimeoutMs }).catch(() => null);
      const navPromise = page
        .waitForURL((current) => typeof current === 'string' && !String(current).includes('token-auth'), {
          timeout: portalPopupTimeoutMs
        })
        .catch(() => null);
      try {
        await button.click({ timeout: portalButtonTimeoutMs });
      } catch {
        await page.evaluate(() => {
          const el = document.querySelector('#continue-btn');
          if (!el) return;
          const events = ['mouseenter', 'mouseover', 'mousemove', 'mousedown', 'mouseup', 'click'];
          for (const type of events) {
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
          }
        });
      }
      const popup = await popupPromise;
      if (popup) {
        authPage = popup;
      } else {
        await navPromise;
        authPage = page;
      }
      await authPage.waitForLoadState('domcontentloaded', { timeout: pageLoadTimeoutMs }).catch(() => {});
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
    console.log('[camoufox-launch-auth] Qwen confirm clicked. Waiting for authorization to settle...');
    // Heuristics (device-code flow): we don't get a localhost callback, so wait for either:
    // - confirm button disappears, or
    // - URL leaves /authorize, or
    // - a short settle window elapses.
    await Promise.race([
      confirmResult.page
        .locator(confirmSelector)
        .first()
        .waitFor({ state: 'detached', timeout: 30_000 })
        .catch(() => {}),
      confirmResult.page
        .waitForURL((current) => typeof current === 'string' && !String(current).includes('/authorize'), {
          timeout: 30_000
        })
        .catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 5000))
    ]);
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

async function waitForAnyElementInPages(context, selectors, timeoutMs) {
  const list = Array.isArray(selectors) ? selectors.filter(Boolean) : [];
  if (list.length === 0) {
    return null;
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const candidate of context.pages()) {
      for (const selector of list) {
        try {
          const locator = candidate.locator(selector);
          if ((await locator.count()) > 0) {
            return { page: candidate, locator, selector };
          }
        } catch {
          // ignore closed pages
        }
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

async function waitForCallback(context, _fallbackPage, timeoutMs = 120000) {
  const isCallbackUrl = (current) => {
    if (typeof current !== 'string' || !current) {
      return false;
    }
    try {
      const parsed = new URL(current);
      const host = parsed.hostname.toLowerCase();
      if (host !== '127.0.0.1' && host !== 'localhost') {
        return false;
      }
      const pathname = parsed.pathname.toLowerCase();
      const isOAuthCallback = pathname === '/oauth2callback' || /oauth.*callback/.test(pathname);
      if (!isOAuthCallback) {
        return false;
      }
      return parsed.searchParams.has('code') || parsed.searchParams.has('error');
    } catch {
      return false;
    }
  };

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const page of context.pages()) {
      try {
        if (isCallbackUrl(page.url())) {
          await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
          return page;
        }
      } catch {
        // ignore closed page races
      }
    }

    const elapsed = Date.now() - startedAt;
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

  throw new Error('Timed out waiting for OAuth callback URL (code/error not observed)');
}
