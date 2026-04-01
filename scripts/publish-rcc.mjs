#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const pkgPath = path.join(PROJECT_ROOT, 'package.json');

function parseArgs(argv) {
  const out = { passthrough: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--llms-tgz') { out.llmsTgz = argv[++i]; continue; }
    if (a === '--llms-version') { out.llmsVersion = argv[++i]; continue; }
    if (a === '--tag') { out.tag = argv[++i]; continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    out.passthrough.push(a);
  }
  return out;
}

function run(command, args, options = {}) {
  const res = spawnSync(command, args, { stdio: 'inherit', cwd: PROJECT_ROOT, ...options });
  if ((res.status ?? 0) !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
}

function readPkgVersion() {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  return String(pkg.version || '').trim();
}

try {
  const args = parseArgs(process.argv);

  // 始终内联本地 llms，避免发布流程改动全局 llms link。
  const env = {
    ...process.env,
    RCC_LLMS_INLINE_LOCAL: process.env.RCC_LLMS_INLINE_LOCAL ?? '1'
  };

  const packArgs = ['run', 'pack:rcc', '--'];
  if (args.llmsTgz) {
    packArgs.push('--llms-tgz', String(args.llmsTgz));
  }
  if (args.llmsVersion) {
    packArgs.push('--llms-version', String(args.llmsVersion));
  }

  run('npm', packArgs, { env });

  const version = readPkgVersion();
  if (!version) {
    throw new Error('failed to read version from package.json after pack:rcc');
  }

  const tarballName = `jsonstudio-rcc-${version}.tgz`;
  const tarballPath = path.join(PROJECT_ROOT, tarballName);
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`tarball not found: ${tarballPath}`);
  }

  const publishArgs = ['publish', tarballName];
  if (args.tag) {
    publishArgs.push('--tag', String(args.tag));
  }
  if (args.dryRun) {
    publishArgs.push('--dry-run');
  }
  if (args.passthrough.length > 0) {
    publishArgs.push(...args.passthrough);
  }

  run('npm', publishArgs);
} catch (err) {
  console.error('[publish-rcc] failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}
