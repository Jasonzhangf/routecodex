#!/usr/bin/env node
/**
 * 黑盒对比：使用 codex-samples 中的一条样本，
 * 分别通过 RouteCodex(dev) 和 rccx(wasm 引擎) 重放，
 * 然后对比 HTTP 元数据和基础响应结构。
 *
 * 前提：
 * - 已经有 RouteCodex 服务在某个端口运行（默认 http://127.0.0.1:5555）；
 * - 已经有 rccx 服务在另一个端口运行（默认 http://127.0.0.1:5556）；
 * - codex 样本是由 RouteCodex 捕获的 client-request JSON（~/.routecodex/codex-samples/...）。
 *
 * 使用方式（示例）：
 *   node scripts/compare-codex-rccx.mjs \\
 *     --sample ~/.routecodex/codex-samples/openai-responses/xxx_client-request.json \\
 *     --route-base http://127.0.0.1:5555 \\
 *     --rccx-base http://127.0.0.1:5556
 *
 * 脚本会调用 scripts/replay-codex-sample.mjs 对同一条样本重放两次：
 * - label=routecodex，base = --route-base；
 * - label=rccx，     base = --rccx-base；
 *
 * 然后读取各自 runs/<requestId>/<label>/response.* 进行对比。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeErrorSampleJson } from './lib/errorsamples.mjs';

const DEFAULT_ROUTE_BASE = process.env.ROUTECODEX_BASE || 'http://127.0.0.1:5555';
const DEFAULT_RCCX_BASE = process.env.RCCX_BASE || 'http://127.0.0.1:5556';
const DEFAULT_API_KEY = process.env.ROUTECODEX_API_KEY || 'routecodex-test';

function usage() {
  console.log(`Usage:
  node scripts/compare-codex-rccx.mjs --sample <file> [--route-base URL] [--rccx-base URL] [--key TOKEN]

Environment:
  ROUTECODEX_BASE     默认 RouteCodex 基础 URL (默认 ${DEFAULT_ROUTE_BASE})
  RCCX_BASE           默认 rccx 基础 URL (默认 ${DEFAULT_RCCX_BASE})
  ROUTECODEX_API_KEY  默认 API key (默认 ${DEFAULT_API_KEY})
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    routeBase: DEFAULT_ROUTE_BASE,
    rccxBase: DEFAULT_RCCX_BASE,
    key: DEFAULT_API_KEY,
    routeLabel: 'routecodex',
    rccxLabel: 'rccx'
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--sample') opts.sample = args[++i];
    else if (a === '--route-base') opts.routeBase = args[++i];
    else if (a === '--rccx-base') opts.rccxBase = args[++i];
    else if (a === '--key') opts.key = args[++i];
    else if (a === '--route-label') opts.routeLabel = args[++i];
    else if (a === '--rccx-label') opts.rccxLabel = args[++i];
    else if (a === '--help' || a === '-h') {
      usage();
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      usage();
      process.exit(1);
    }
  }
  if (!opts.sample) {
    usage();
    process.exit(1);
  }
  return opts;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function computeRequestId(sample) {
  return (
    sample?.requestId ||
    sample?.data?.meta?.requestId ||
    sample?.meta?.requestId ||
    `sample_${Date.now()}`
  );
}

function computeRunDir(samplePath, requestId, label) {
  const baseDir = path.dirname(path.resolve(samplePath));
  return path.join(baseDir, 'runs', requestId, label);
}

function runReplay({ base, label, samplePath, key }) {
  return new Promise((resolve, reject) => {
    const args = [
      'scripts/replay-codex-sample.mjs',
      '--sample',
      samplePath,
      '--label',
      label,
      '--base',
      base,
      '--key',
      key
    ];
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      stdio: 'inherit'
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`replay-codex-sample failed for label=${label} (exit ${code})`));
    });
    child.on('error', (err) => reject(err));
  });
}

function loadRunResult(runDir) {
  const metaPath = path.join(runDir, 'response.meta.json');
  if (!fs.existsSync(metaPath)) {
    return { error: `missing response.meta.json in ${runDir}` };
  }
  const meta = readJson(metaPath);

  const jsonPath = path.join(runDir, 'response.json');
  const errorPath = path.join(runDir, 'response.error.txt');
  const ssePath = path.join(runDir, 'response.sse.ndjson');

  let bodyKind = 'none';
  let bodySample = null;

  if (fs.existsSync(jsonPath)) {
    bodyKind = 'json';
    try {
      bodySample = readJson(jsonPath);
    } catch {
      bodySample = null;
    }
  } else if (fs.existsSync(errorPath)) {
    bodyKind = 'error-text';
    try {
      const txt = fs.readFileSync(errorPath, 'utf8');
      bodySample = txt.slice(0, 1024);
    } catch {
      bodySample = null;
    }
  } else if (fs.existsSync(ssePath)) {
    bodyKind = 'sse';
    try {
      const txt = fs.readFileSync(ssePath, 'utf8');
      const lines = txt.split('\n').filter(Boolean);
      bodySample = lines.slice(0, 5);
    } catch {
      bodySample = null;
    }
  }

  return { meta, bodyKind, bodySample };
}

function stableSubset(meta) {
  if (!meta || typeof meta !== 'object') return null;
  return {
    status: meta.status,
    statusText: meta.statusText,
    endpoint: meta.endpoint,
    targetUrl: meta.targetUrl,
    wantsSse: meta.wantsSse,
    contentType: meta.headers && meta.headers['content-type'],
    routeHint:
      (meta.headers && (meta.headers['x-route-hint'] || meta.headers['X-Route-Hint'])) || undefined
  };
}

function stableStringify(value) {
  return JSON.stringify(
    value,
    (key, val) => {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const out = {};
        for (const k of Object.keys(val).sort()) {
          out[k] = val[k];
        }
        return out;
      }
      return val;
    }
  );
}

async function main() {
  const opts = parseArgs();
  const samplePath = path.resolve(opts.sample);
  const sample = readJson(samplePath);
  const requestId = computeRequestId(sample);

  console.log(
    `[compare-codex-rccx] sample=${samplePath} requestId=${requestId} routeBase=${opts.routeBase} rccxBase=${opts.rccxBase}`
  );

  // RouteCodex 路径
  console.log('[compare-codex-rccx] ▶ routecodex replay...');
  await runReplay({
    base: opts.routeBase,
    label: opts.routeLabel,
    samplePath,
    key: opts.key
  });
  const routeRunDir = computeRunDir(samplePath, requestId, opts.routeLabel);
  const routeResult = loadRunResult(routeRunDir);

  // rccx 路径
  console.log('[compare-codex-rccx] ▶ rccx replay...');
  await runReplay({
    base: opts.rccxBase,
    label: opts.rccxLabel,
    samplePath,
    key: opts.key
  });
  const rccxRunDir = computeRunDir(samplePath, requestId, opts.rccxLabel);
  const rccxResult = loadRunResult(rccxRunDir);

  if (routeResult.error || rccxResult.error) {
    console.error('[compare-codex-rccx] ❌ missing run artifacts:', {
      routeRunDir,
      routeError: routeResult.error || null,
      rccxRunDir,
      rccxError: rccxResult.error || null
    });
    try {
      const file = await writeErrorSampleJson({
        group: 'compare-codex-rccx',
        kind: 'missing-artifacts',
        payload: {
          kind: 'compare-codex-rccx-missing-artifacts',
          stamp: new Date().toISOString(),
          samplePath,
          requestId,
          routeBase: opts.routeBase,
          rccxBase: opts.rccxBase,
          routeLabel: opts.routeLabel,
          rccxLabel: opts.rccxLabel,
          routeRunDir,
          rccxRunDir,
          routeError: routeResult.error || null,
          rccxError: rccxResult.error || null
        }
      });
      console.error(`[compare-codex-rccx] wrote errorsample: ${file}`);
    } catch (err) {
      console.error('[compare-codex-rccx] failed to write errorsample:', err);
    }
    process.exitCode = 1;
    return;
  }

  const routeMeta = stableSubset(routeResult.meta);
  const rccxMeta = stableSubset(rccxResult.meta);

  const metaEqual = stableStringify(routeMeta) === stableStringify(rccxMeta);
  const bodyKindEqual = routeResult.bodyKind === rccxResult.bodyKind;

  console.log('[compare-codex-rccx] routecodex.meta =', routeMeta);
  console.log('[compare-codex-rccx] rccx.meta      =', rccxMeta);
  console.log('[compare-codex-rccx] routecodex.bodyKind =', routeResult.bodyKind);
  console.log('[compare-codex-rccx] rccx.bodyKind      =', rccxResult.bodyKind);

  if (!metaEqual || !bodyKindEqual) {
    console.log('[compare-codex-rccx] ❌ mismatch detected between RouteCodex and rccx');
    console.log('[compare-codex-rccx] routecodex runDir =', routeRunDir);
    console.log('[compare-codex-rccx] rccx runDir      =', rccxRunDir);
    // 为了调试 429 / 系列冷却问题，额外打印一小段 body 样本。
    console.log('[compare-codex-rccx] routecodex.bodySample =', routeResult.bodySample);
    console.log('[compare-codex-rccx] rccx.bodySample      =', rccxResult.bodySample);
    try {
      const file = await writeErrorSampleJson({
        group: 'compare-codex-rccx',
        kind: 'mismatch',
        payload: {
          kind: 'compare-codex-rccx-mismatch',
          stamp: new Date().toISOString(),
          samplePath,
          requestId,
          routeBase: opts.routeBase,
          rccxBase: opts.rccxBase,
          routeLabel: opts.routeLabel,
          rccxLabel: opts.rccxLabel,
          routeRunDir,
          rccxRunDir,
          routeMeta,
          rccxMeta,
          routeBodyKind: routeResult.bodyKind,
          rccxBodyKind: rccxResult.bodyKind,
          routeBodySample: routeResult.bodySample,
          rccxBodySample: rccxResult.bodySample
        }
      });
      console.error(`[compare-codex-rccx] wrote errorsample: ${file}`);
    } catch (err) {
      console.error('[compare-codex-rccx] failed to write errorsample:', err);
    }
    process.exitCode = 1;
    return;
  }

  console.log('[compare-codex-rccx] ✅ meta/bodyKind aligned for this sample');
  console.log('[compare-codex-rccx] routecodex runDir =', routeRunDir);
  console.log('[compare-codex-rccx] rccx runDir      =', rccxRunDir);
}

main().catch((err) => {
  console.error('[compare-codex-rccx] fatal error:', err);
  try {
    const root = path.join(os.homedir(), '.routecodex', 'errorsamples', 'compare-codex-rccx');
    const file = path.join(root, `fatal-${Date.now()}.txt`);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(file, String(err?.stack || err), 'utf8');
    console.error(`[compare-codex-rccx] wrote errorsample: ${file}`);
  } catch {}
  process.exitCode = 1;
});
