import { Command } from 'commander';
import {
  interactiveRefresh
} from '../token-daemon/index.js';

export function createOauthCommand(): Command {
  const cmd = new Command('oauth');

  cmd
    .description('Force OAuth re-authentication for a specific token (opens browser / Camoufox when enabled)')
    .argument(
      '<selector>',
      'Token selector: file basename, full path, or provider id (e.g. "iflow-oauth-1-186.json" or "iflow")'
    )
    .action(async (selector: string) => {
      await interactiveRefresh(selector);
    });

  cmd
    .command('iflow-auto')
    .description('Trigger iFlow OAuth re-auth using Camoufox automation (auto portal + account selection)')
    .argument(
      '<selector>',
      'Token selector: file basename, full path, or provider id (e.g. "iflow-oauth-1-186.json" or "iflow")'
    )
    .option('--dev', 'Run Camoufox automation in headed debug mode (default headless)')
    .action(async (selector: string, options: { dev?: boolean }) => {
      const prevBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
      const prevAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
      const prevDevMode = process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      process.env.ROUTECODEX_OAUTH_BROWSER = 'camoufox';
      process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'iflow';
      process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = '1';
      if (options?.dev) {
        process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = '1';
      } else {
        delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      }
      try {
        await interactiveRefresh(selector);
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
    .option('--account-text <text>', 'Preferred Gemini account display text to auto-select')
    .action(async (selector: string, options: { dev?: boolean; accountText?: string }) => {
      const prevBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
      const prevAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
      const prevDevMode = process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      const prevAccountText = process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT;
      process.env.ROUTECODEX_OAUTH_BROWSER = 'camoufox';
      process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'gemini';
      process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = '1';
      if (options?.dev) {
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
        await interactiveRefresh(selector);
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
    .command('antigravity-auto')
    .description('Trigger Antigravity OAuth re-auth using Camoufox automation (auto account selection + confirmation)')
    .argument(
      '<selector>',
      'Token selector: file basename, full path, or provider id (e.g. "antigravity-oauth-1-foo.json" or "antigravity")'
    )
    .option('--dev', 'Run Camoufox automation in headed debug mode (default headless)')
    .option('--account-text <text>', 'Preferred Antigravity account display text/email to auto-select')
    .action(async (selector: string, options: { dev?: boolean; accountText?: string }) => {
      const prevBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
      const prevAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
      const prevDevMode = process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      const prevAccountText = process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT;
      process.env.ROUTECODEX_OAUTH_BROWSER = 'camoufox';
      process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'antigravity';
      process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM = '1';
      if (options?.dev) {
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
        await interactiveRefresh(selector);
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
