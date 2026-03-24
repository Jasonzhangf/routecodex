import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BASELINE = 'sharedmodule/llmswitch-core/config/rustification-audit-baseline.json';
const ROOT = process.cwd();
const SRC_ROOT = path.join(ROOT, 'sharedmodule/llmswitch-core/src');

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

function walkTsFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && full.endsWith('.ts')) {
        out.push(full);
      }
    }
  }
  out.sort();
  return out;
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
  if (!fs.existsSync(SRC_ROOT)) {
    throw new Error(`missing source root: ${SRC_ROOT}`);
  }
  const files = walkTsFiles(SRC_ROOT)
    .map((abs) => ({
      abs,
      rel: path.relative(ROOT, abs).split(path.sep).join('/'),
    }))
    .filter((x) => isProdTs(x.rel));

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

  const baselineFiles = new Map((baseline.prodTsFiles || []).map((f) => [f.path, f]));
  const currentFiles = new Map((current.prodTsFiles || []).map((f) => [f.path, f]));

  const newProdTsFiles = Array.from(currentFiles.keys()).filter((k) => !baselineFiles.has(k));
  const disallowedNewFiles = newProdTsFiles.filter((k) => !allow.has(k));
  if (disallowedNewFiles.length > 0) {
    errors.push(
      `new prod TS files are blocked (set LLMSWITCH_TS_NEW_ALLOW for explicit exceptions): ${disallowedNewFiles.join(', ')}`,
    );
  }

  const topDirs = new Set([
    ...Object.keys(baseline.byTopDir || {}),
    ...Object.keys(current.byTopDir || {}),
  ]);
  for (const dir of topDirs) {
    const base = (baseline.byTopDir || {})[dir]?.nonNativeLoc || 0;
    const now = (current.byTopDir || {})[dir]?.nonNativeLoc || 0;
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
