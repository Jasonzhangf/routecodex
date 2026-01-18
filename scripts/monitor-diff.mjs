import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const args = {
    intervalMs: 1000,
    errorsRoot: process.env.ROUTECODEX_ERRORSAMPLES_DIR || path.join(os.homedir(), '.routecodex', 'errorsamples'),
    once: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--once') args.once = true;
    else if (a === '--interval' || a === '--intervalMs') {
      const v = argv[i + 1];
      i += 1;
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) args.intervalMs = n;
    } else if (a === '--errorsRoot') {
      const v = argv[i + 1];
      i += 1;
      if (v && String(v).trim()) args.errorsRoot = path.resolve(String(v).trim());
    }
  }
  return args;
}

function safeJsonRead(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function listJsonFiles(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => path.join(dirPath, e.name));
  } catch {
    return [];
  }
}

function summarizeRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const kind = record.kind || 'unknown';
  const timestamp = record.timestamp || record.time || null;

  if (String(kind).includes('shadow') || String(kind).includes('diff')) {
    return {
      kind,
      timestamp,
      requestId: record.requestId,
      entryEndpoint: record.entryEndpoint,
      baselineMode: record.baselineMode,
      candidateMode: record.candidateMode,
      diffCount: record.diffCount,
      diffPaths: Array.isArray(record.diffPaths) ? record.diffPaths.slice(0, 12) : undefined,
      runtime: record.runtime
    };
  }
  if (String(kind).includes('hub_policy') || String(kind).includes('policy')) {
    return {
      kind,
      timestamp,
      stage: record.stage,
      requestId: record.requestId,
      endpoint: record.endpoint,
      providerProtocol: record.providerProtocol,
      violationCount: Array.isArray(record.observation?.violations) ? record.observation.violations.length : undefined,
      runtime: record.runtime
    };
  }
  return { kind, timestamp };
}

function printNewFile(filePath) {
  const record = safeJsonRead(filePath);
  const summary = summarizeRecord(record);
  const rel = filePath;
  if (!summary) {
    // eslint-disable-next-line no-console
    console.log(`[errorsamples] ${rel}`);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`[errorsamples] ${rel} -> ${JSON.stringify(summary)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const dirs = [
    path.join(args.errorsRoot, 'unified-hub-shadow-runtime'),
    path.join(args.errorsRoot, 'unified-hub-shadow-runtime-routing'),
    path.join(args.errorsRoot, 'policy')
  ];

  // eslint-disable-next-line no-console
  console.log('[monitor:diff] watching:', dirs.join(', '));
  // eslint-disable-next-line no-console
  console.log('[monitor:diff] intervalMs=', args.intervalMs, 'errorsRoot=', args.errorsRoot);

  const seen = new Set();
  const scanOnce = () => {
    for (const dir of dirs) {
      const files = listJsonFiles(dir);
      for (const f of files) {
        if (seen.has(f)) continue;
        seen.add(f);
        printNewFile(f);
      }
    }
  };

  scanOnce();
  if (args.once) return;
  setInterval(scanOnce, args.intervalMs);
}

await main();

