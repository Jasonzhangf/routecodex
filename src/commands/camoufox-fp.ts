import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import os from 'os';
import chalk from 'chalk';
import { TokenDaemon } from '../token-daemon/index.js';
import { buildTokenKey } from '../token-daemon/token-types.js';
import { getCamoufoxProfileDir } from '../providers/core/config/camoufox-launcher.js';

function getFingerprintRoot(): string {
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.routecodex', 'camoufox-fp');
}

function getFingerprintPath(profileId: string): string {
  return path.join(getFingerprintRoot(), `${profileId}.json`);
}

export function createCamoufoxFpCommand(): Command {
  const cmd = new Command('camoufox-fp');

  cmd
    .description('Inspect Camoufox fingerprint/profile mapping for a token selector')
    .argument(
      '<selector>',
      'Token selector: file basename, full path, or provider id (e.g. "iflow-oauth-1-186.json" or "gemini")'
    )
    .option('-j, --json', 'Output raw JSON fingerprint payload')
    .action(async (selector: string, options: { json?: boolean }) => {
      const token = await TokenDaemon.findTokenBySelector(selector);
      if (!token) {
        console.error(chalk.red('✗'), `No token found for selector: ${selector}`);
        process.exitCode = 1;
        return;
      }

      const profileDir = getCamoufoxProfileDir(token.provider, token.alias || null);
      const profileId = path.basename(profileDir);
      const fpPath = getFingerprintPath(profileId);

      if (!fs.existsSync(fpPath)) {
        console.error(chalk.red('✗'), `No fingerprint file found for profile: ${profileId}`);
        console.error('   Path:', fpPath);
        console.error(
          chalk.gray(
            '   Hint: run "routecodex oauth <selector>" once to trigger Camoufox-based OAuth and fingerprint generation.'
          )
        );
        process.exitCode = 1;
        return;
      }

      let payload: unknown;
      try {
        const raw = fs.readFileSync(fpPath, 'utf-8');
        payload = JSON.parse(raw);
      } catch {
        console.error(chalk.red('✗'), `Failed to parse fingerprint JSON: ${fpPath}`);
        process.exitCode = 1;
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      const tokenKey = buildTokenKey(token);
      console.log('');
      console.log(chalk.cyan('Camoufox fingerprint mapping:'));
      console.log(`  Token      : ${tokenKey}`);
      console.log(`  Provider   : ${token.provider}`);
      console.log(`  Sequence   : ${token.sequence}`);
      console.log(`  Alias      : ${token.alias || 'default'}`);
      console.log(`  Profile ID : ${profileId}`);
      console.log(`  Profile Dir: ${profileDir}`);
      console.log(`  FP File    : ${fpPath}`);

      if (!payload || typeof payload !== 'object' || !(payload as any).env) {
        console.log('');
        console.log(chalk.yellow('⚠'), 'Fingerprint file does not contain an "env" map.');
        return;
      }

      const env = (payload as { env: Record<string, string> }).env;
      const keys = Object.keys(env).sort();
      const previewKeys = keys.filter((k) => k.startsWith('CAMOU_CONFIG_') || k.startsWith('BROWSERFORGE_'));

      console.log('');
      console.log(chalk.cyan('Fingerprint env keys (summary):'));
      console.log(`  Total keys : ${keys.length}`);
      if (previewKeys.length) {
        console.log(`  CAMOU/BROWSERFORGE keys:`);
        for (const k of previewKeys) {
          console.log(`    - ${k}`);
        }
      } else {
        console.log('  (no CAMOU_CONFIG_* or BROWSERFORGE_* keys detected)');
      }
    });

  return cmd;
}

