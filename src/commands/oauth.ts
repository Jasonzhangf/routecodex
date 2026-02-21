import { Command } from 'commander';
import {
  interactiveRefresh,
  TokenDaemon,
  validateOAuthTokens
} from '../token-daemon/index.js';
import { clearAntigravityReauthRequired, readAntigravityReauthRequiredState } from '../providers/auth/antigravity-reauth-state.js';

async function safeInteractiveRefresh(
  selector: string,
  options: { force?: boolean; mode?: 'manual' | 'auto'; noAutoFallback?: boolean }
): Promise<boolean> {
  try {
    await interactiveRefresh(selector, options);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`✗ OAuth failed: ${msg}`);
    process.exitCode = 1;
    return false;
  }
}

function resolveAutoModeByProvider(provider?: string | null): 'iflow' | 'gemini' | 'qwen' | 'antigravity' | null {
  const raw = String(provider || '').trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (raw === 'iflow') {
    return 'iflow';
  }
  if (raw === 'gemini-cli') {
    return 'gemini';
  }
  if (raw === 'qwen') {
    return 'qwen';
  }
  if (raw === 'antigravity') {
    return 'antigravity';
  }
  return null;
}

export function createOauthCommand(): Command {
  const cmd = new Command('oauth').enablePositionalOptions();

  cmd
    .description('OAuth tools: refresh token or validate tokens without opening a browser')
    .argument(
      '[args...]',
      'Usage: "oauth <selector>" or "oauth validate <selector|all> [--json]"'
    )
    .option('--json', 'Output JSON result (only for validate)', false)
    .option('--force', 'Force re-authorize in browser even if token is still valid (default for oauth <selector>)', false)
    .option('--soft', 'Do not force re-authorize when token is still valid', false)
    .option('--headful', 'Open Camoufox in headed mode (OAuth refresh only)', false)
    .action(async (args: string[], options: { json?: boolean; force?: boolean; soft?: boolean; headful?: boolean }) => {
      const list = Array.isArray(args) ? args : [];
      const first = list[0];
      if (!first) {
        cmd.help();
        return;
      }
      if (first === 'validate') {
        const selector = list[1] || 'all';
        const ok = await validateOAuthTokens(selector, Boolean(options?.json));
        if (!ok) {
          process.exit(1);
        }
        return;
      }
      const prevDevMode = process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      const prevBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
      const prevAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
      const prevAutoConfirm = process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
      const prevAccountText = process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT;
      delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
      delete process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
      delete process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT;
      process.env.ROUTECODEX_OAUTH_BROWSER = 'camoufox';
      if (options?.headful) {
        process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = '1';
      }
      try {
        const token = await TokenDaemon.findTokenBySelector(first).catch(() => null);
        const autoMode = resolveAutoModeByProvider(token?.provider);
        if (autoMode) {
          process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = autoMode;
          process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = '1';
        }
        // Keep legacy `--soft` for users who want token-valid short-circuit behavior.
        const forceReauth = options?.soft ? Boolean(options?.force) : true;
        await safeInteractiveRefresh(first, { force: forceReauth, mode: autoMode ? 'auto' : 'manual' });
      } finally {
        if (prevDevMode === undefined) {
          delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
        } else {
          process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = prevDevMode;
        }
        if (prevBrowser === undefined) {
          delete process.env.ROUTECODEX_OAUTH_BROWSER;
        } else {
          process.env.ROUTECODEX_OAUTH_BROWSER = prevBrowser;
        }
        if (prevAutoMode === undefined) {
          delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
        } else {
          process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = prevAutoMode;
        }
        if (prevAutoConfirm === undefined) {
          delete process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
        } else {
          process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = prevAutoConfirm;
        }
        if (prevAccountText === undefined) {
          delete process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT;
        } else {
          process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT = prevAccountText;
        }
      }
    });

  cmd
    .command('reauth-required')
    .description('Re-auth all Antigravity aliases marked as reauth-required (Camoufox automation)')
    .option('--dev', 'Run Camoufox automation in headed debug mode (default headless)')
    .option('--headful', 'Open Camoufox in headed mode (alias of --dev)')
    .option('--account-text <text>', 'Preferred Antigravity account display text/email to auto-select')
    .action(async (options: { dev?: boolean; headful?: boolean; accountText?: string }) => {
      const state = await readAntigravityReauthRequiredState();
      const aliases = Object.keys(state).sort();
      if (!aliases.length) {
        console.log('No antigravity reauth-required aliases.');
        return;
      }

      const prevBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
      const prevAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
      const prevDevMode = process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      const prevAccountText = process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT;
      process.env.ROUTECODEX_OAUTH_BROWSER = 'camoufox';
      process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'antigravity';
      process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = '1';
      if (options?.dev || options?.headful) {
        process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = '1';
      } else {
        delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      }
      if (options?.accountText) {
        process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT = options.accountText;
      } else {
        delete process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT;
      }

      try {
        for (const alias of aliases) {
          const rec = state[alias];
          const selector = rec?.tokenFile || `antigravity-oauth-*-` + alias + `.json`;
          console.log(`Re-auth required: alias=${alias}${rec?.fromSuffix ? ` from=${rec.fromSuffix}` : ''}${rec?.toSuffix ? ` to=${rec.toSuffix}` : ''}`);
          const ok = await safeInteractiveRefresh(selector, { force: true, mode: 'auto', noAutoFallback: true });
          if (!ok) {
            return;
          }
          await clearAntigravityReauthRequired(alias);
        }
      } finally {
        if (prevBrowser === undefined) {
          delete process.env.ROUTECODEX_OAUTH_BROWSER;
        } else {
          process.env.ROUTECODEX_OAUTH_BROWSER = prevBrowser;
        }
        if (prevAutoMode === undefined) {
          delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
        } else {
          process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = prevAutoMode;
        }
        if (prevDevMode === undefined) {
          delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
        } else {
          process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = prevDevMode;
        }
        if (prevAccountText === undefined) {
          delete process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT;
        } else {
          process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT = prevAccountText;
        }
        delete process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
      }
    });

  cmd
    .command('iflow-auto')
    .description('Trigger iFlow OAuth re-auth using Camoufox automation (auto portal + account selection)')
    .argument(
      '<selector>',
      'Token selector: file basename, full path, or provider id (e.g. "iflow-oauth-1-186.json" or "iflow")'
    )
    .option('--dev', 'Run Camoufox automation in headed debug mode (default headless)')
    .option('--headful', 'Open Camoufox in headed mode (alias of --dev)')
    .action(async (selector: string, options: { dev?: boolean; headful?: boolean }) => {
      const prevBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
      const prevAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
      const prevDevMode = process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      process.env.ROUTECODEX_OAUTH_BROWSER = 'camoufox';
      process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'iflow';
      process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = '1';
      if (options?.dev || options?.headful) {
        process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = '1';
      } else {
        delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      }
      try {
        await safeInteractiveRefresh(selector, { force: true, mode: 'auto', noAutoFallback: true });
      } finally {
        if (prevBrowser === undefined) {
          delete process.env.ROUTECODEX_OAUTH_BROWSER;
        } else {
          process.env.ROUTECODEX_OAUTH_BROWSER = prevBrowser;
        }
        if (prevAutoMode === undefined) {
          delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
        } else {
          process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = prevAutoMode;
        }
        if (prevDevMode === undefined) {
          delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
        } else {
          process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = prevDevMode;
        }
        delete process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
      }
    });

  cmd
    .command('gemini-auto')
    .description('Trigger Gemini OAuth re-auth using Camoufox automation (auto account selection + confirmation)')
    .argument(
      '<selector>',
      'Token selector: file basename, full path, or provider id (e.g. "gemini-oauth-1-foo.json" or "gemini-cli")'
    )
    .option('--dev', 'Run Camoufox automation in headed debug mode (default headless)')
    .option('--headful', 'Open Camoufox in headed mode (alias of --dev)')
    .option('--account-text <text>', 'Preferred Gemini account display text to auto-select')
    .action(async (selector: string, options: { dev?: boolean; headful?: boolean; accountText?: string }) => {
      const token = await TokenDaemon.findTokenBySelector(selector).catch(() => null);
      if (token?.provider === 'antigravity') {
        // User often calls gemini-auto with an antigravity token file; route to the correct mode.
        console.warn(
          `⚠ gemini-auto received an antigravity token (${token.displayName}); switching to antigravity auto mode. ` +
            `Use: "oauth antigravity-auto ${selector}" for clarity.`
        );
        const prevBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
        const prevAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
        const prevDevMode = process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
        const prevAccountText = process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT;
        process.env.ROUTECODEX_OAUTH_BROWSER = 'camoufox';
        process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'antigravity';
        process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = '1';
        if (options?.dev || options?.headful) {
          process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = '1';
        } else {
          delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
        }
        if (options?.accountText) {
          process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT = options.accountText;
        } else {
          delete process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT;
        }
        try {
          const ok = await safeInteractiveRefresh(selector, { force: true, mode: 'auto', noAutoFallback: true });
          if (!ok) {
            return;
          }
          if (token.alias && token.alias !== 'static') {
            await clearAntigravityReauthRequired(token.alias);
          }
        } finally {
          if (prevBrowser === undefined) {
            delete process.env.ROUTECODEX_OAUTH_BROWSER;
          } else {
            process.env.ROUTECODEX_OAUTH_BROWSER = prevBrowser;
          }
          if (prevAutoMode === undefined) {
            delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
          } else {
            process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = prevAutoMode;
          }
          if (prevDevMode === undefined) {
            delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
          } else {
            process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = prevDevMode;
          }
          if (prevAccountText === undefined) {
            delete process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT;
          } else {
            process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT = prevAccountText;
          }
          delete process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
        }
        return;
      }
      const prevBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
      const prevAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
      const prevDevMode = process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      const prevAccountText = process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT;
      process.env.ROUTECODEX_OAUTH_BROWSER = 'camoufox';
      process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'gemini';
      process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = '1';
      if (options?.dev || options?.headful) {
        process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = '1';
      } else {
        delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      }
      if (options?.accountText) {
        process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT = options.accountText;
      } else {
        delete process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT;
      }
      try {
        await safeInteractiveRefresh(selector, { force: true, mode: 'auto', noAutoFallback: true });
        if (token && token.provider === 'gemini-cli' && token.alias && token.alias !== 'static') {
          await clearAntigravityReauthRequired(token.alias);
        }
      } finally {
        if (prevBrowser === undefined) {
          delete process.env.ROUTECODEX_OAUTH_BROWSER;
        } else {
          process.env.ROUTECODEX_OAUTH_BROWSER = prevBrowser;
        }
        if (prevAutoMode === undefined) {
          delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
        } else {
          process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = prevAutoMode;
        }
        if (prevDevMode === undefined) {
          delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
        } else {
          process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = prevDevMode;
        }
        if (prevAccountText === undefined) {
          delete process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT;
        } else {
          process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT = prevAccountText;
        }
        delete process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
      }
    });

  cmd
    .command('qwen-auto')
    .description('Trigger Qwen OAuth re-auth using Camoufox automation (auto confirm on authorize page)')
    .argument(
      '<selector>',
      'Token selector: file basename, full path, or provider id (e.g. "qwen-oauth-1-default.json" or "qwen")'
    )
    .option('--dev', 'Run Camoufox automation in headed debug mode (default headless)')
    .option('--headful', 'Open Camoufox in headed mode (alias of --dev)')
    .action(async (selector: string, options: { dev?: boolean; headful?: boolean }) => {
      const prevBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
      const prevAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
      const prevDevMode = process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      process.env.ROUTECODEX_OAUTH_BROWSER = 'camoufox';
      process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'qwen';
      process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = '1';
      if (options?.dev || options?.headful) {
        process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = '1';
      } else {
        delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      }
      try {
        await safeInteractiveRefresh(selector, { force: true, mode: 'auto', noAutoFallback: true });
      } finally {
        if (prevBrowser === undefined) {
          delete process.env.ROUTECODEX_OAUTH_BROWSER;
        } else {
          process.env.ROUTECODEX_OAUTH_BROWSER = prevBrowser;
        }
        if (prevAutoMode === undefined) {
          delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
        } else {
          process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = prevAutoMode;
        }
        if (prevDevMode === undefined) {
          delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
        } else {
          process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = prevDevMode;
        }
        delete process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
      }
    });

  cmd
    .command('antigravity-auto')
    .description('Trigger Antigravity OAuth re-auth using Camoufox automation (auto account selection + confirmation)')
    .argument(
      '<selector>',
      'Token selector: file basename, full path, or provider id (e.g. "antigravity-oauth-1-foo.json" or "antigravity")'
    )
    .option('--dev', 'Run Camoufox automation in headed debug mode (default headless)')
    .option('--headful', 'Open Camoufox in headed mode (alias of --dev)')
    .option('--account-text <text>', 'Preferred Antigravity account display text/email to auto-select')
    .action(async (selector: string, options: { dev?: boolean; headful?: boolean; accountText?: string }) => {
      const token = await TokenDaemon.findTokenBySelector(selector).catch(() => null);
      const prevBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
      const prevAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
      const prevDevMode = process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      const prevAccountText = process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT;
      process.env.ROUTECODEX_OAUTH_BROWSER = 'camoufox';
      process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'antigravity';
      process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = '1';
      if (options?.dev || options?.headful) {
        process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = '1';
      } else {
        delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      }
      if (options?.accountText) {
        process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT = options.accountText;
      } else {
        delete process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT;
      }
      try {
        await safeInteractiveRefresh(selector, { force: true, mode: 'auto', noAutoFallback: true });
        if (token && token.provider === 'antigravity' && token.alias && token.alias !== 'static') {
          await clearAntigravityReauthRequired(token.alias);
        }
      } finally {
        if (prevBrowser === undefined) {
          delete process.env.ROUTECODEX_OAUTH_BROWSER;
        } else {
          process.env.ROUTECODEX_OAUTH_BROWSER = prevBrowser;
        }
        if (prevAutoMode === undefined) {
          delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
        } else {
          process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = prevAutoMode;
        }
        if (prevDevMode === undefined) {
          delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
        } else {
          process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = prevDevMode;
        }
        if (prevAccountText === undefined) {
          delete process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT;
        } else {
          process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT = prevAccountText;
        }
        delete process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM;
      }
    });

  return cmd;
}
