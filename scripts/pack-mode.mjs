#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') { out.name = argv[++i]; continue; }
    if (a === '--bin') { out.bin = argv[++i]; continue; }
    if (a === '--tag') { out.tag = argv[++i]; continue; }
  }
  return out;
}

const projectRoot = process.cwd();
const args = parseArgs(process.argv);
if (!args.name || !args.bin) {
  console.error('Usage: node scripts/pack-mode.mjs --name <packageName> --bin <binName>');
  process.exit(1);
}

const pkgPath = path.join(projectRoot, 'package.json');
const backupPath = pkgPath + '.bak.pack';
const ensureScriptPath = path.join(projectRoot, 'scripts', 'ensure-llmswitch-mode.mjs');
const linkScriptPath = path.join(projectRoot, 'scripts', 'link-llmswitch.mjs');
const llmsPath = path.join(projectRoot, 'node_modules', '@jsonstudio', 'llms');
const localLlmsDir = path.join(projectRoot, 'sharedmodule', 'llmswitch-core');
const localLlmsPkgPath = path.join(projectRoot, 'sharedmodule', 'llmswitch-core', 'package.json');

function runEnsureMode(mode) {
  const env = { ...process.env, BUILD_MODE: mode };
  const res = spawnSync(process.execPath, [ensureScriptPath], { stdio: 'inherit', env });
  if ((res.status ?? 0) !== 0) {
    throw new Error(`ensure-llmswitch-mode failed for ${mode}`);
  }
}

function runNodeScript(scriptPath, args = []) {
  const res = spawnSync(process.execPath, [scriptPath, ...args], { stdio: 'inherit' });
  if ((res.status ?? 0) !== 0) {
    throw new Error(`${path.basename(scriptPath)} ${args.join(' ')} failed`);
  }
}

function runNpm(args) {
  const res = spawnSync('npm', args, { stdio: 'inherit', cwd: projectRoot });
  if ((res.status ?? 0) !== 0) {
    throw new Error(`npm ${args.join(' ')} failed`);
  }
}

function installLocalLlmsFromTarball() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-inline-llms-'));
  try {
    const pack = spawnSync('npm', ['pack', localLlmsDir, '--silent'], {
      cwd: tmpDir,
      encoding: 'utf8'
    });
    if ((pack.status ?? 0) !== 0) {
      throw new Error(`npm pack ${localLlmsDir} failed`);
    }

    const streamText = `${String(pack.stdout || '')}\n${String(pack.stderr || '')}`;
    const candidates = Array.from(
      new Set(
        streamText
          .split(/\s+/)
          .map((token) => token.trim())
          .filter((token) => token.endsWith('.tgz'))
      )
    );

    const tarballsInTmp = (() => {
      try {
        return fs.readdirSync(tmpDir)
          .filter((name) => name.endsWith('.tgz'))
          .map((name) => path.join(tmpDir, name));
      } catch {
        return [];
      }
    })();

    const resolvedCandidates = candidates
      .map((token) => (path.isAbsolute(token) ? token : path.join(tmpDir, token)))
      .filter((candidatePath) => exists(candidatePath));

    const tarballPath = resolvedCandidates[0] || tarballsInTmp[0] || '';
    if (!tarballPath) {
      throw new Error(`local llms tarball missing (stdout=${JSON.stringify(String(pack.stdout || '').trim())})`);
    }

    runNpm(['install', '--no-audit', '--no-fund', '--no-save', tarballPath]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function readLocalLlmsVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(localLlmsPkgPath, 'utf-8'));
    return String(pkg.version || '').trim();
  } catch {
    return '';
  }
}

const isDevPkg = args.name === 'routecodex';
const isRcc = args.name === 'rcc' || args.name === '@jsonstudio/rcc';

let hadDevLink = false;
hadDevLink = isSymlink(llmsPath);
runEnsureMode('release');

const original = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
fs.writeFileSync(backupPath, JSON.stringify(original, null, 2));

try {
  const inlineLocalLlmsForRcc =
    isRcc &&
    exists(localLlmsPkgPath) &&
    String(process.env.RCC_LLMS_INLINE_LOCAL ?? process.env.ROUTECODEX_RCC_INLINE_LOCAL ?? '1').trim() !== '0';

  if (inlineLocalLlmsForRcc) {
    // For rcc release packing, inline local llms as a real dependency tree under node_modules
    // so npm pack can bundle it into the tarball (no external registry dependency at install time).
    if (isSymlink(llmsPath)) {
      runNodeScript(linkScriptPath, ['unlink']);
    }
    installLocalLlmsFromTarball();
  }

  const mutated = { ...original };
  mutated.name = args.name;
  mutated.bin = { [args.bin]: 'dist/cli.js' };
  // Ensure description mentions mode
  const suffix = isRcc ? ' (release)' : ' (dev)';
  mutated.description = String(original.description || 'RouteCodex')
    .replace(/\s*\((dev|release)\)$/, '')
    .concat(suffix);
  // Prefer real dependencies over bundled to avoid missing build artifacts (e.g., ajv/dist)

  if (isDevPkg || isRcc) {
    const inlineLocalLlmsForRcc =
      isRcc &&
      exists(localLlmsPkgPath) &&
      String(process.env.RCC_LLMS_INLINE_LOCAL ?? process.env.ROUTECODEX_RCC_INLINE_LOCAL ?? '1').trim() !== '0';
    if (inlineLocalLlmsForRcc) {
      mutated.bundledDependencies = ['@jsonstudio/llms'];
      mutated.bundleDependencies = ['@jsonstudio/llms'];
      console.log('[pack-mode] inline local @jsonstudio/llms into rcc tarball');
    } else {
      mutated.bundledDependencies = [];
      mutated.bundleDependencies = [];
    }
    const llmsOverride = String(process.env.RCC_LLMS_VERSION || process.env.ROUTECODEX_PACK_LLMS_VERSION || '').trim();
    const localLlmsVersion = readLocalLlmsVersion();
    const llmsVersion = (isRcc && llmsOverride)
      ? llmsOverride
      : (localLlmsVersion || original.dependencies?.['@jsonstudio/llms'] || '^0.6.230');
    if (isRcc && llmsOverride) {
      console.log(`[pack-mode] using RCC_LLMS_VERSION override: @jsonstudio/llms=${llmsVersion}`);
    }
    const deps = {
      ...(original.dependencies || {})
    };
    // Avoid recursive self-dependency when packing @jsonstudio/rcc.
    if (isRcc && deps['@jsonstudio/rcc']) {
      delete deps['@jsonstudio/rcc'];
    }
    mutated.dependencies = {
      ...deps,
      ajv: original.dependencies?.ajv || '^8.17.1',
      zod: original.dependencies?.zod || '^3.23.8',
      '@jsonstudio/llms': llmsVersion
    };
    // Ensure rcc ships bundled docs (copied to ~/.routecodex/docs by `rcc init`).
    if (isRcc) {
      const baseFiles = Array.isArray(original.files) ? [...original.files] : [];
      if (!baseFiles.includes('docs/')) {
        baseFiles.push('docs/');
      }
      if (!baseFiles.includes('configsamples/')) {
        baseFiles.push('configsamples/');
      }
      mutated.files = baseFiles;
    }
  }
  fs.writeFileSync(pkgPath, JSON.stringify(mutated, null, 2));

  // pack
  const r = spawnSync('npm', ['pack'], { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error('npm pack failed');
  }
} finally {
  // restore
  fs.writeFileSync(pkgPath, fs.readFileSync(backupPath, 'utf-8'));
  fs.unlinkSync(backupPath);
  if (hadDevLink) {
    try {
      runEnsureMode('dev');
    } catch (err) {
      console.warn('[pack-mode] failed to restore dev llms link:', err);
    }
  }
}
