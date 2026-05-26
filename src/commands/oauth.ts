import { Command } from 'commander';
import {
  interactiveRefresh,
  validateOAuthTokens
} from '../token-daemon/index.js';

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
        const forceReauth = options?.soft ? Boolean(options?.force) : true;
        await safeInteractiveRefresh(first, { force: forceReauth, mode: 'manual' });
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


  return cmd;
}
