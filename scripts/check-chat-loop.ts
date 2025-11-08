import fs from 'fs';
import path from 'path';

function readJson(p: string): any { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
function hostPortOfUrl(u: string): string | null { try { const { host } = new URL(u); return host; } catch { return null; } }

function main() {
  const mergedPath = process.argv[2] || path.join(process.cwd(), 'config', 'merged-config.json');
  if (!fs.existsSync(mergedPath)) { console.error('[loop-check] merged config not found:', mergedPath); process.exit(2); }
  const m = readJson(mergedPath);
  const http = m.httpserver || (m.modules?.httpserver?.config) || {};
  const selfHost = String(http.host || '0.0.0.0');
  const selfPort = Number(http.port || 0);
  const selfKey = selfPort ? `${selfHost}:${selfPort}` : null;
  const issues: Array<{ providerId: string; baseUrl: string; reason: string }>
    = [];

  const providers = m.providers || {};
  for (const [pid, p] of Object.entries<any>(providers)) {
    const baseUrl = String(p.baseUrl || p.baseURL || '');
    if (!baseUrl) continue;
    const hp = hostPortOfUrl(baseUrl);
    if (hp && selfKey && (hp === selfKey || hp.startsWith('127.0.0.1:') || hp.startsWith('localhost:'))) {
      issues.push({ providerId: pid, baseUrl, reason: 'provider baseUrl points to local host/port (potential recursion)' });
    }
  }

  console.log('[loop-check] server:', { host: selfHost, port: selfPort });
  if (issues.length) {
    console.log('[loop-check] potential recursion risks:', issues);
    process.exit(1);
  } else {
    console.log('[loop-check] no loop risk detected based on baseUrl/port heuristic');
  }
}

main();

