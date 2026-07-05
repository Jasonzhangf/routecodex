import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_BASELINE = 'sharedmodule/llmswitch-core/config/rustification-audit-baseline.json';
const ROOT = process.cwd();
const SRC_PREFIX = 'sharedmodule/llmswitch-core/src/';
const GENERATED_DIR_NAMES = new Set([
  'dist',
  'target',
  'coverage',
  'node_modules',
  '.mempalace',
  '.local-index',
  'mempalace',
  '__snapshots__',
  'snapshots',
  'reports',
]);

function parseArgs(argv) {
  const args = {
    baseline: DEFAULT_BASELINE,
    writeBaseline: false,
    json: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--write-baseline') {
      args.writeBaseline = true;
      continue;
    }
    if (token === '--json') {
      args.json = true;
      continue;
    }
    if (token === '--baseline') {
      const value = argv[i + 1];
      if (!value) throw new Error('--baseline requires a path');
      args.baseline = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown arg: ${token}`);
  }
  return args;
}

function readGitTrackedFiles() {
  const raw = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'buffer',
  });
  return raw
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((p) => p.split(path.sep).join('/'))
    .sort();
}

function isGeneratedOrLocalIndexPath(rel) {
  const parts = rel.split('/');
  if (parts.some((part) => GENERATED_DIR_NAMES.has(part))) return true;
  if (rel.endsWith('.html')) return true;
  if (/\.(bak|backup|orig|tmp)$/u.test(rel)) return true;
  if (rel.endsWith('~')) return true;
  if (/generated[-_/].*report|report[-_/].*generated/u.test(rel)) return true;
  return false;
}

function listAuditTsFiles() {
  return readGitTrackedFiles()
    .filter((rel) => rel.startsWith(SRC_PREFIX))
    .filter((rel) => !isGeneratedOrLocalIndexPath(rel))
    .filter((rel) => rel.endsWith('.ts'))
    .map((rel) => ({
      abs: path.join(ROOT, rel),
      rel,
    }))
    .filter((file) => fs.existsSync(file.abs));
}

function isProdTs(rel) {
  if (rel.endsWith('.d.ts')) return false;
  if (rel.endsWith('.spec.ts') || rel.endsWith('.test.ts')) return false;
  if (rel.includes('/tests/')) return false;
  if (rel.includes('/test/')) return false;
  if (rel.includes('/archive/')) return false;
  return true;
}

function readLineCount(content) {
  if (content.length === 0) return 0;
  return content.split('\n').length;
}

function isNativeLinked(content) {
  const patterns = [
    /native-router-hotpath/,
    /WithNative/,
    /loadNativeRouterHotpathBinding/,
    /router_hotpath_napi/,
  ];
  return patterns.some((p) => p.test(content));
}

function buildSnapshot() {
  const srcRoot = path.join(ROOT, SRC_PREFIX);
  if (!fs.existsSync(srcRoot)) {
    throw new Error(`missing source root: ${srcRoot}`);
  }
  const files = listAuditTsFiles().filter((x) => isProdTs(x.rel));

  const byTopDir = new Map();
  const prodTsFiles = [];
  let prodTsFileCount = 0;
  let prodTsLocTotal = 0;
  let nonNativeFileCount = 0;
  let nonNativeLocTotal = 0;

  for (const file of files) {
    const content = fs.readFileSync(file.abs, 'utf8');
    const loc = readLineCount(content);
    const nativeLinked = isNativeLinked(content);
    const relFromSrc = file.rel.replace('sharedmodule/llmswitch-core/src/', '');
    const topDir = relFromSrc.split('/')[0] || '.';

    prodTsFileCount += 1;
    prodTsLocTotal += loc;
    if (!nativeLinked) {
      nonNativeFileCount += 1;
      nonNativeLocTotal += loc;
    }

    const curr = byTopDir.get(topDir) || {
      prodTsFiles: 0,
      prodTsLoc: 0,
      nonNativeFiles: 0,
      nonNativeLoc: 0,
    };
    curr.prodTsFiles += 1;
    curr.prodTsLoc += loc;
    if (!nativeLinked) {
      curr.nonNativeFiles += 1;
      curr.nonNativeLoc += loc;
    }
    byTopDir.set(topDir, curr);

    prodTsFiles.push({
      path: file.rel,
      loc,
      nativeLinked,
      topDir,
    });
  }

  const byTopDirObj = {};
  for (const [k, v] of Array.from(byTopDir.entries()).sort((a, b) => b[1].prodTsLoc - a[1].prodTsLoc)) {
    byTopDirObj[k] = v;
  }

  return {
    generatedAt: new Date().toISOString(),
    scope: 'sharedmodule/llmswitch-core/src',
    metrics: {
      prodTsFileCount,
      prodTsLocTotal,
      nonNativeFileCount,
      nonNativeLocTotal,
    },
    byTopDir: byTopDirObj,
    prodTsFiles,
  };
}

function readBaseline(p) {
  if (!fs.existsSync(p)) {
    return null;
  }
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function parseAllowlistFromEnv() {
  const raw = process.env.LLMSWITCH_TS_NEW_ALLOW || '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function mapFilesByCanonicalPath(files) {
  const out = new Map();
  for (const file of files || []) {
    out.set(file.path, file);
  }
  return out;
}

function buildCanonicalTopDirStats(snapshot) {
  const out = {};
  for (const file of snapshot.prodTsFiles || []) {
    const relFromSrc = file.path.replace('sharedmodule/llmswitch-core/src/', '');
    const topDir = relFromSrc.split('/')[0] || '.';
    const curr = out[topDir] || {
      prodTsFiles: 0,
      prodTsLoc: 0,
      nonNativeFiles: 0,
      nonNativeLoc: 0,
    };
    curr.prodTsFiles += 1;
    curr.prodTsLoc += file.loc || 0;
    if (!file.nativeLinked) {
      curr.nonNativeFiles += 1;
      curr.nonNativeLoc += file.loc || 0;
    }
    out[topDir] = curr;
  }
  return out;
}

function compareSnapshot(current, baseline) {
  const errors = [];
  const allow = parseAllowlistFromEnv();

  if (current.metrics.nonNativeLocTotal > baseline.metrics.nonNativeLocTotal) {
    errors.push(
      `nonNativeLocTotal increased: baseline=${baseline.metrics.nonNativeLocTotal}, current=${current.metrics.nonNativeLocTotal}`,
    );
  }
  if (current.metrics.nonNativeFileCount > baseline.metrics.nonNativeFileCount) {
    errors.push(
      `nonNativeFileCount increased: baseline=${baseline.metrics.nonNativeFileCount}, current=${current.metrics.nonNativeFileCount}`,
    );
  }

  const baselineFiles = mapFilesByCanonicalPath(baseline.prodTsFiles);
  const currentFiles = mapFilesByCanonicalPath(current.prodTsFiles);

  const newProdTsFiles = Array.from(currentFiles.entries())
    .filter(([k]) => !baselineFiles.has(k))
    .map(([, file]) => file.path);
  const disallowedNewFiles = Array.from(currentFiles.entries())
    .filter(([k]) => !baselineFiles.has(k))
    .map(([k, file]) => ({ canonicalPath: k, path: file.path }))
    .filter((entry) => !allow.has(entry.path) && !allow.has(entry.canonicalPath))
    .map((entry) => entry.path);
  if (disallowedNewFiles.length > 0) {
    errors.push(
      `new prod TS files are blocked (set LLMSWITCH_TS_NEW_ALLOW for explicit exceptions): ${disallowedNewFiles.join(', ')}`,
    );
  }

  const baselineByTopDir = buildCanonicalTopDirStats(baseline);
  const currentByTopDir = buildCanonicalTopDirStats(current);
  const topDirs = new Set([
    ...Object.keys(baselineByTopDir),
    ...Object.keys(currentByTopDir),
  ]);
  for (const dir of topDirs) {
    const base = baselineByTopDir[dir]?.nonNativeLoc || 0;
    const now = currentByTopDir[dir]?.nonNativeLoc || 0;
    if (now > base) {
      errors.push(`nonNativeLoc increased in topDir=${dir}: baseline=${base}, current=${now}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    newProdTsFiles,
    disallowedNewFiles,
    allowlist: Array.from(allow.values()).sort(),
  };
}

function printHuman(current, baseline, result) {
  console.log('[llmswitch-rustification-audit] current metrics:');
  console.log(`- prodTsFileCount=${current.metrics.prodTsFileCount}`);
  console.log(`- prodTsLocTotal=${current.metrics.prodTsLocTotal}`);
  console.log(`- nonNativeFileCount=${current.metrics.nonNativeFileCount}`);
  console.log(`- nonNativeLocTotal=${current.metrics.nonNativeLocTotal}`);

  if (baseline) {
    console.log('[llmswitch-rustification-audit] baseline metrics:');
    console.log(`- prodTsFileCount=${baseline.metrics.prodTsFileCount}`);
    console.log(`- prodTsLocTotal=${baseline.metrics.prodTsLocTotal}`);
    console.log(`- nonNativeFileCount=${baseline.metrics.nonNativeFileCount}`);
    console.log(`- nonNativeLocTotal=${baseline.metrics.nonNativeLocTotal}`);
  }

  if (result) {
    if (result.newProdTsFiles.length > 0) {
      console.log(`[llmswitch-rustification-audit] new prod ts files=${result.newProdTsFiles.length}`);
      for (const p of result.newProdTsFiles.slice(0, 40)) {
        console.log(`  + ${p}`);
      }
      if (result.newProdTsFiles.length > 40) {
        console.log(`  ... (${result.newProdTsFiles.length - 40} more)`);
      }
    }
    if (!result.ok) {
      console.error('[llmswitch-rustification-audit] FAILED');
      for (const err of result.errors) {
        console.error(`- ${err}`);
      }
      return;
    }
    console.log('[llmswitch-rustification-audit] OK');
  }
}

function main() {
  const args = parseArgs(process.argv);
  const baselinePath = path.resolve(ROOT, args.baseline);
  const current = buildSnapshot();

  if (args.writeBaseline) {
    ensureDirForFile(baselinePath);
    fs.writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    if (args.json) {
      console.log(JSON.stringify({ mode: 'write-baseline', baselinePath, metrics: current.metrics }));
    } else {
      console.log(`[llmswitch-rustification-audit] baseline written: ${path.relative(ROOT, baselinePath)}`);
      printHuman(current, null, null);
    }
    return;
  }

  const baseline = readBaseline(baselinePath);
  if (!baseline) {
    throw new Error(
      `baseline not found at ${path.relative(ROOT, baselinePath)}; run: node scripts/ci/llmswitch-rustification-audit.mjs --write-baseline`,
    );
  }

  const result = compareSnapshot(current, baseline);
  if (args.json) {
    console.log(
      JSON.stringify({
        mode: 'compare',
        baselinePath: path.relative(ROOT, baselinePath),
        metrics: current.metrics,
        baselineMetrics: baseline.metrics,
        result,
      }),
    );
  } else {
    printHuman(current, baseline, result);
  }
  if (!result.ok) {
    process.exit(2);
  }
}

main();
