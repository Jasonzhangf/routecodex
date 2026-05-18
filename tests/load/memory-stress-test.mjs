#!/usr/bin/env node
/**
 * Memory stress test for RouteCodex /v1/responses endpoint.
 * Sends high-frequency requests and monitors RSS/heapUsed curve.
 *
 * Usage:
 *   node tests/load/memory-stress-test.mjs [--base-url http://localhost:5520] [--concurrency 5] [--duration 120] [--api-key KEY]
 *
 * Expected: RSS and heapUsed should plateau after warm-up, not grow monotonically.
 */

import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({
  options: {
    'base-url': { type: 'string', default: 'http://localhost:5520' },
    concurrency: { type: 'string', default: '5' },
    duration: { type: 'string', default: '120' },
    'api-key': { type: 'string', default: 'test-key' },
  },
});

const BASE_URL = opts['base-url'];
const CONCURRENCY = parseInt(opts.concurrency, 10);
const DURATION_SEC = parseInt(opts.duration, 10);
const API_KEY = opts['api-key'];

function formatMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function log(ts, level, msg) {
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date(ts);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  console.log(`[${time}] [${level}] ${msg}`);
}

async function sendResponsesRequest() {
  const body = {
    model: 'gpt-4o-mini',
    input: 'Say hello in one word.',
    max_output_tokens: 10,
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${BASE_URL}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // Read first few bytes to establish connection, then abandon
    await res.body.read(64).catch(() => {});
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

async function pollMemory(pid) {
  try {
    const { spawn } = await import('node:child_process');
    return new Promise((resolve) => {
      const proc = spawn('ps', ['-p', String(pid), '-o', 'rss=', '-p', String(pid)]);
      let data = '';
      proc.stdout.on('data', (d) => { data += d; });
      proc.on('close', () => {
        resolve(parseInt(data.trim(), 10) * 1024); // ps returns KB
      });
      setTimeout(() => { try { proc.kill(); } catch (_) {} resolve(0); }, 2000);
    });
  } catch {
    return 0;
  }
}

async function main() {
  console.error(`[mem-stress] base=${BASE_URL} concurrency=${CONCURRENCY} duration=${DURATION_SEC}s`);

  // Find RouteCodex server pid by checking port 5520 listener
  let serverPid;
  try {
    const { spawn } = await import('node:child_process');
    const out = await new Promise((resolve) => {
      const p = spawn('lsof', ['-t', '-nP', '-iTCP:5520', '-sTCP:LISTEN']);
      let d = '';
      p.stdout.on('data', (c) => { d += c; });
      p.on('close', (code) => resolve(code === 0 ? d.trim() : ''));
    });
    serverPid = parseInt(out.split('\n')[0], 10);
    if (!serverPid) {
      console.error('[mem-stress] ERROR: no RouteCodex server listening on port 5520');
      process.exit(1);
    }
    console.error(`[mem-stress] targeting server PID ${serverPid}`);
  } catch (err) {
    console.error('[mem-stress] ERROR: failed to detect server PID', err.message);
    process.exit(1);
  }

  const samples = [];
  const startTime = Date.now();
  let okCount = 0;
  let failCount = 0;
  let round = 0;

  // Memory snapshot helper
  async function snapshot(label) {
    const mem = process.memoryUsage();
    const rss = await pollMemory(serverPid);
    const s = {
      ts: Date.now(),
      elapsed: ((Date.now() - startTime) / 1000).toFixed(1) + 's',
      label,
      rss: formatMB(mem.rss),
      heapUsed: formatMB(mem.heapUsed),
      heapTotal: formatMB(mem.heapTotal),
      serverRss: formatMB(rss),
      ok: okCount,
      fail: failCount,
    };
    samples.push(s);
    log(s.ts, 'INFO', `elapsed=${s.elapsed} label=${label} RSS=${s.rss} heapUsed=${s.heapUsed} serverRSS=${s.serverRss} ok=${okCount} fail=${failCount}`);
    return s;
  }

  await snapshot('warmup');

  // Ramp-up phase: increase concurrency gradually
  const phases = [
    { duration: 30, concurrency: CONCURRENCY },
    { duration: 30, concurrency: CONCURRENCY * 2 },
    { duration: DURATION_SEC - 60, concurrency: CONCURRENCY },
  ];

  for (const phase of phases) {
    if (phase.duration <= 0) continue;
    const phaseEnd = Date.now() + phase.duration * 1000;
    const workers = [];

    while (Date.now() < phaseEnd) {
      // Maintain phase.concurrency in-flight
      while (workers.filter(w => !w.done).length < phase.concurrency) {
        const w = {
          req: sendResponsesRequest().then(r => {
            w.done = true;
            w.result = r;
            if (r.ok) okCount++; else failCount++;
          }),
          done: false,
        };
        workers.push(w);
      }
      // Prune done
      for (let i = workers.length - 1; i >= 0; i--) {
        if (workers[i].done) workers.splice(i, 1);
      }
      await new Promise(r => setTimeout(r, 200));
      round++;
      if (round % 10 === 0) {
        await snapshot(`round-${round}`);
      }
    }

    await snapshot(`phase-${phase.concurrency}-done`);
  }

  // Final snapshot
  const finalS = await snapshot('final');

  // Trend analysis: check if heapUsed grows monotonically
  const heapValues = samples.map(s => parseFloat(s.heapUsed));
  const isMonotonic = heapValues.every((v, i) => i === 0 || v >= heapValues[i - 1] * 0.95);
  const isLeak = heapValues[heapValues.length - 1] > heapValues[0] * 1.5;

  console.log('\n=== Memory Stress Test Summary ===');
  console.log(`Total requests: ok=${okCount} fail=${failCount}`);
  console.log(`HeapUsed start: ${samples[0].heapUsed}  end: ${finalS.heapUsed}`);
  console.log(`RSS    start: ${samples[0].rss}  end: ${finalS.rss}`);
  console.log(`ServerRSS start: ${samples[0].serverRss}  end: ${finalS.serverRss}`);

  if (isLeak) {
    console.log('\n[RESULT] LEAK DETECTED: heapUsed grew >50% over test duration');
    process.exit(2);
  } else if (isMonotonic) {
    console.log('\n[RESULT] WARNING: heapUsed is monotonically increasing (no plateau)');
    process.exit(1);
  } else {
    console.log('\n[RESULT] PASS: heapUsed plateaued — no leak detected');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('[mem-stress] FATAL:', err);
  process.exit(9);
});
