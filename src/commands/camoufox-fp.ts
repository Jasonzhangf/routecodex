import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import os from 'os';
import chalk from 'chalk';
import { TokenDaemon } from '../token-daemon/index.js';
import { buildTokenKey } from '../token-daemon/token-types.js';
import { ensureCamoufoxFingerprintForToken, getCamoufoxOsPolicy, getCamoufoxProfileDir } from '../providers/core/config/camoufox-launcher.js';
import { inferAntigravityUaSuffixFromFingerprint, loadAntigravityCamoufoxFingerprint } from '../providers/auth/antigravity-fingerprint.js';
import { markAntigravityReauthRequired } from '../providers/auth/antigravity-reauth-state.js';

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

  cmd
    .command('repair')
    .description('Repair Camoufox fingerprints (no Linux) and mark antigravity aliases for OAuth re-auth')
    .option('--provider <provider>', 'OAuth provider id (default: antigravity)', 'antigravity')
    .option('--all', 'Repair all aliases for this provider (from token snapshot)', false)
    .option('--alias <aliases>', 'Comma/space separated alias list (e.g. "antonsoltan,jasonqueque")')
    .option('--dry-run', 'Print planned actions without writing', false)
    .option('--allow-linux', 'Allow linux fingerprints (unsafe; disables rewrite)', false)
    .action(async (options: { provider?: string; all?: boolean; alias?: string; dryRun?: boolean; allowLinux?: boolean }) => {
      const provider = typeof options.provider === 'string' && options.provider.trim() ? options.provider.trim() : 'antigravity';
      const fixLinux = options.allowLinux !== true;
      const dryRun = options.dryRun === true;

      const snapshot = await TokenDaemon.getSnapshot();
      const byProvider = snapshot.providers.find((p) => p.provider === provider);
      const tokens = byProvider?.tokens ?? [];
      const tokenFileByAlias = new Map<string, string>();
      const tokenSeqByAlias = new Map<string, number>();
      for (const t of tokens) {
        const alias = typeof t.alias === 'string' ? t.alias.trim().toLowerCase() : '';
        if (!alias) {
          continue;
        }
        // Prefer the lowest sequence token (stable).
        const prevSeq = tokenSeqByAlias.get(alias);
        if (prevSeq === undefined || t.sequence < prevSeq) {
          tokenFileByAlias.set(alias, t.filePath);
          tokenSeqByAlias.set(alias, t.sequence);
        }
      }

      const aliasesFromFlag = typeof options.alias === 'string' && options.alias.trim()
        ? options.alias
          .split(/[,\s]+/)
          .map((a) => a.trim().toLowerCase())
          .filter(Boolean)
        : [];

      const aliases = options.all
        ? Array.from(new Set(Array.from(tokenFileByAlias.keys())))
        : aliasesFromFlag;

      if (!aliases.length) {
        console.error(chalk.red('✗'), 'No aliases selected.');
        console.error('   Use: `routecodex camoufox-fp repair --all` or `--alias <a,b,c>`');
        process.exitCode = 1;
        return;
      }

      let ok = 0;
      let fixed = 0;
      let failed = 0;

      console.log('');
      console.log(chalk.cyan('Camoufox fingerprint repair (no Linux):'));
      console.log(`  Provider : ${provider}`);
      console.log(`  Aliases  : ${aliases.length}`);
      console.log(`  Mode     : ${dryRun ? 'dry-run' : 'apply'}`);
      console.log(`  Policy   : ${fixLinux ? 'rewrite-linux' : 'allow-linux'}`);
      console.log('');

      for (const alias of aliases) {
        const profileDir = getCamoufoxProfileDir(provider, alias);
        const profileId = path.basename(profileDir);
        const fpPath = getFingerprintPath(profileId);
        const osPolicy = getCamoufoxOsPolicy(provider, alias) || 'windows';
        const tokenFile = tokenFileByAlias.get(alias);

        const fp = await loadAntigravityCamoufoxFingerprint(alias).catch(() => null);
        const suffix = fp ? inferAntigravityUaSuffixFromFingerprint(fp) : undefined;
        const isLinux = Boolean(suffix && suffix.startsWith('linux/'));

        if (!fixLinux || !isLinux) {
          ok += 1;
          console.log(`[camoufox-fp] ok alias=${alias} profile=${profileId} suffix=${suffix || 'unknown'} osPolicy=${osPolicy}`);
          continue;
        }

        const backupPath = `${fpPath}.bak.${Date.now()}`;
        console.warn(
          chalk.yellow('⚠'),
          `[camoufox-fp] repair alias=${alias} profile=${profileId} from=${suffix} -> policy=${osPolicy} (reauth required)`
        );
        if (dryRun) {
          fixed += 1;
          continue;
        }

        try {
          if (fs.existsSync(fpPath)) {
            fs.renameSync(fpPath, backupPath);
          }
        } catch (error) {
          failed += 1;
          console.error(chalk.red('✗'), `[camoufox-fp] failed to backup fingerprint file: ${fpPath}`);
          console.error('   ', error instanceof Error ? error.message : String(error));
          continue;
        }

        try {
          console.log(`[camoufox-fp] generating fingerprint alias=${alias} profile=${profileId} osPolicy=${osPolicy} ...`);
          ensureCamoufoxFingerprintForToken(provider, alias);
        } catch {
          // ensureCamoufoxFingerprintForToken is best-effort; verify via file existence below.
        }

        const newFp = await loadAntigravityCamoufoxFingerprint(alias).catch(() => null);
        const newSuffix = newFp ? inferAntigravityUaSuffixFromFingerprint(newFp) : undefined;

        if (!newSuffix || newSuffix.startsWith('linux/')) {
          // Restore backup to avoid leaving the alias without a fingerprint.
          try {
            if (fs.existsSync(backupPath)) {
              fs.renameSync(backupPath, fpPath);
            }
          } catch {
            // ignore restore failures
          }
          failed += 1;
          console.error(
            chalk.red('✗'),
            `[camoufox-fp] repair failed alias=${alias} profile=${profileId} newSuffix=${newSuffix || 'unknown'}`
          );
          continue;
        }

        fixed += 1;
        await markAntigravityReauthRequired({
          provider: provider === 'gemini-cli' ? 'gemini-cli' : 'antigravity',
          alias,
          tokenFile: tokenFile,
          profileId,
          fromSuffix: suffix,
          toSuffix: newSuffix
        });

        console.log(
          chalk.green('✓'),
          `[camoufox-fp] repaired alias=${alias} profile=${profileId} to=${newSuffix} backup=${path.basename(backupPath)}`
        );
        console.log(
          chalk.gray('  next:'),
          `routecodex oauth antigravity-auto ${tokenFile || `antigravity-oauth-*-` + alias + `.json`}`
        );
      }

      console.log('');
      console.log(`[camoufox-fp] summary ok=${ok} repaired=${fixed} failed=${failed} total=${aliases.length}`);
      if (failed > 0) {
        process.exitCode = 1;
      }
    });

  return cmd;
}
