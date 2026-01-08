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

  return cmd;
}

