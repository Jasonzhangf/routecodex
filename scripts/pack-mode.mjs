#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureRepoPackOutputDir } from './lib/repo-output-paths.mjs';

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
const llmsPath = path.join(projectRoot, 'node_modules', 'rcc-llmswitch-core');
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

    runNpm([
      'install',
      '--no-audit',
      '--no-fund',
      '--no-save',
      '--omit=optional',
      '--ignore-scripts',
      '--offline',
      '--progress=false',
      '--loglevel=warn',
      tarballPath,
    ]);
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

const isRouteCodex = args.name === 'routecodex';
const isRcc = args.name === 'rcc';

function resolveBundledReleaseDependencies(pkg) {
  return Object.keys(pkg.dependencies || {}).sort();
}

let hadDevLink = false;
hadDevLink = isSymlink(llmsPath);
runEnsureMode('release');

const original = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
fs.writeFileSync(backupPath, JSON.stringify(original, null, 2));

try {
  const inlineLocalLlmsForRelease =
    (isRouteCodex || isRcc) &&
    exists(localLlmsPkgPath) &&
    String(process.env.RCC_LLMS_INLINE_LOCAL ?? process.env.ROUTECODEX_RCC_INLINE_LOCAL ?? '1').trim() !== '0';

  if (inlineLocalLlmsForRelease) {
    // For release packing, inline local llms as a real dependency tree under node_modules
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
  const suffix = (isRcc || isRouteCodex) ? ' (release)' : ' (dev)';
  mutated.description = String(original.description || 'RouteCodex')
    .replace(/\s*\((dev|release)\)$/, '')
    .concat(suffix);
  // Prefer real dependencies over bundled to avoid missing build artifacts (e.g., ajv/dist)

  if (isRouteCodex || isRcc) {
    const inlineLocalLlmsForRelease =
      (isRouteCodex || isRcc) &&
      exists(localLlmsPkgPath) &&
      String(process.env.RCC_LLMS_INLINE_LOCAL ?? process.env.ROUTECODEX_RCC_INLINE_LOCAL ?? '1').trim() !== '0';
    if (inlineLocalLlmsForRelease) {
      const bundledReleaseDependencies = resolveBundledReleaseDependencies(original);
      mutated.bundledDependencies = bundledReleaseDependencies;
      mutated.bundleDependencies = bundledReleaseDependencies;
      console.log(`[pack-mode] inline local rcc-llmswitch-core into ${args.name} tarball`);
      console.log(`[pack-mode] bundle ${args.name} production dependencies: ${bundledReleaseDependencies.join(', ')}`);
    } else {
      mutated.bundledDependencies = [];
      mutated.bundleDependencies = [];
    }
    const llmsOverride = String(process.env.RCC_LLMS_VERSION || process.env.ROUTECODEX_PACK_LLMS_VERSION || '').trim();
    const localLlmsVersion = readLocalLlmsVersion();
    const llmsVersion = ((isRcc || isRouteCodex) && llmsOverride)
      ? llmsOverride
      : (localLlmsVersion || original.dependencies?.['rcc-llmswitch-core'] || 'file:sharedmodule/llmswitch-core');
    if ((isRcc || isRouteCodex) && llmsOverride) {
      console.log(`[pack-mode] using RCC_LLMS_VERSION override: rcc-llmswitch-core=${llmsVersion}`);
    }
    const deps = {
      ...(original.dependencies || {})
    };
    mutated.dependencies = {
      ...deps,
      ajv: original.dependencies?.ajv || '^8.17.1',
      zod: original.dependencies?.zod || '^3.23.8',
      'rcc-llmswitch-core': llmsVersion
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
  const packDestination = ensureRepoPackOutputDir(projectRoot);
  const r = spawnSync('npm', ['pack', '--pack-destination', packDestination], {
    stdio: 'inherit',
    cwd: projectRoot,
  });
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
