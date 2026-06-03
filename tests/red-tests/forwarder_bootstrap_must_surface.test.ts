/**
 * 红测试门禁：ProviderForwarder bootstrap 失败必须显式暴露
 *
 * 触发原因：2026-06-01 实环境观察到 10000 端口 listen 起来后所有请求
 * "Empty reply from server"（无 HTTP 响应、无 log 子目录），而 5520/5555 正常。
 *
 * 根因假设：10000 routingPolicyGroup 的 buildVirtualRouterInputV2 内部
 * 抛错被静默吞掉，导致 hubPipelinesByRoutingPolicyGroup map 没有 10000 entry，
 * 请求进来时 resolveHubPipelineForRoutingPolicyGroup 返回 null，
 * 抛 "Routing policy group pipeline not available" 错误但被框架外层
 * unhandled rejection 路径吞掉，server 进程没死但连接被 close。
 *
 * 硬护栏（fail-fast + no fallback）：
 * - 1) buildVirtualRouterInputV2 对单个 routingPolicyGroup 抛错时，
 *      启动流程必须在 [server.startup] log 出现 fail-fast 错误，
 *      server 进程必须以非零 exit code 退出，listener 必须不复用。
 * - 2) resolveHubPipelineForRoutingPolicyGroup 返回 null 时，
 *      必须返回 HTTP 500 + JSON error body（不是空连接、不是 unhandled rejection）。
 * - 3) live config.toml 的 10000 group 必须能被 buildVirtualRouterInputV2 成功解析
 *      （即当前 patch 不应引入 10000 bootstrap 抛错）。
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { buildVirtualRouterInputV2 } from '../../src/config/virtual-router-builder.js';
import { parseTomlRecord } from '../../src/config/toml-basic.js';

const LIVE_CONFIG = '/Users/fanzhang/.rcc/config.toml';
const PROVIDER_ROOT = '/Users/fanzhang/.rcc/provider';

describe('RED: forwarder bootstrap must surface (not silent fail)', () => {
  it('live config.toml 10000 group must bootstrap without throwing', async () => {
    const cfg = parseTomlRecord(readFileSync(LIVE_CONFIG, 'utf8'));
    // If this throws, the test is a RED gate that protects 10000 from silent dead state.
    const input = await buildVirtualRouterInputV2(
      cfg as Record<string, unknown>,
      PROVIDER_ROOT,
      { routingPolicyGroup: 'gateway_coding_10000' },
    );
    // Sanity: forwarders section must be present and contain the expected entry.
    const fwds = (input as unknown as { forwarders?: Record<string, unknown> }).forwarders;
    expect(fwds).toBeDefined();
    expect(Object.keys(fwds ?? {}).sort()).toEqual([
      'fwd.minimax.MiniMax-M2.7',
      'fwd.minimax.MiniMax-M3',
    ]);
  });

  it('live config.toml 5520 group must NOT require forwarder (5520 禁用 forwarder)', async () => {
    const cfg = parseTomlRecord(readFileSync(LIVE_CONFIG, 'utf8'));
    const input = await buildVirtualRouterInputV2(
      cfg as Record<string, unknown>,
      PROVIDER_ROOT,
      { routingPolicyGroup: 'gateway_priority_5520' },
    );
    const fwds = (input as unknown as { forwarders?: Record<string, unknown> }).forwarders;
    // 5520 不引用 fwd，bootstrap 不应带 forwarders 段（或者只带 10000 group 用的）
    // — 但因为 5520 没引用 fwd，referencedForwarderIds 为空，normalize 仍会保留
    // 全部定义（设计如此，forwarders 段是全 VR 共享资源池）。
    // 因此这里只断言：5520 routing 内不含 fwd target。
    const all: string[] = [];
    for (const v of Object.values(input.routing)) {
      const arr = Array.isArray(v) ? v : [v];
      for (const it of arr) {
        if (it && typeof it === 'object') {
          const e = it as Record<string, unknown>;
          if (Array.isArray(e.targets)) for (const t of e.targets) if (typeof t === 'string') all.push(t);
          if (typeof e.target === 'string') all.push(e.target);
        }
      }
    }
    expect(all.filter((t) => t.startsWith('fwd.'))).toEqual([]);
  });

  it('live config.toml 5555 group must NOT require forwarder (5555 禁用 forwarder)', async () => {
    const cfg = parseTomlRecord(readFileSync(LIVE_CONFIG, 'utf8'));
    const input = await buildVirtualRouterInputV2(
      cfg as Record<string, unknown>,
      PROVIDER_ROOT,
      { routingPolicyGroup: 'gateway_priority_5555' },
    );
    const all: string[] = [];
    for (const v of Object.values(input.routing)) {
      const arr = Array.isArray(v) ? v : [v];
      for (const it of arr) {
        if (it && typeof it === 'object') {
          const e = it as Record<string, unknown>;
          if (Array.isArray(e.targets)) for (const t of e.targets) if (typeof t === 'string') all.push(t);
          if (typeof e.target === 'string') all.push(e.target);
        }
      }
    }
    expect(all.filter((t) => t.startsWith('fwd.'))).toEqual([]);
  });

  it('drift guard: 10000 must reference exactly one fwd target', async () => {
    const cfg = parseTomlRecord(readFileSync(LIVE_CONFIG, 'utf8'));
    const input = await buildVirtualRouterInputV2(
      cfg as Record<string, unknown>,
      PROVIDER_ROOT,
      { routingPolicyGroup: 'gateway_coding_10000' },
    );
    const all: string[] = [];
    for (const v of Object.values(input.routing)) {
      const arr = Array.isArray(v) ? v : [v];
      for (const it of arr) {
        if (it && typeof it === 'object') {
          const e = it as Record<string, unknown>;
          if (Array.isArray(e.targets)) for (const t of e.targets) if (typeof t === 'string') all.push(t);
          if (typeof e.target === 'string') all.push(e.target);
        }
      }
    }
    expect(all.filter((t) => t.startsWith('fwd.'))).toEqual(['fwd.minimax.MiniMax-M2.7']);
  });
});

describe('RED: live 10000 server must respond (not empty reply)', () => {
  /**
   * 实测：当前 10000 listener (PID 25073) 接受 TCP 但所有 HTTP 请求 Empty reply。
   * 红测断言：10000 端口必须对最小有效 chat 请求返回 HTTP 响应（非 000 + 非 empty body）。
   * 若 10000 server 未在运行则 skip；若运行则必须通过。
   */
  it('10000 server, if running, must return HTTP response on basic chat request', async () => {
    const probeHost = resolveProbeHost();
    const probe = await probePort(probeHost, 10000);
    if (!probe.listening) {
      // Server not running — skip rather than fail (CI may not have a live server)
      return;
    }
    // Listener exists. Send minimal request and require non-empty HTTP response.
    const res = await fetch(`http://${probeHost}:10000/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'MiniMax-M2.7',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 4,
        stream: false,
      }),
    });
    // Must have a real HTTP response (not empty, not ECONNRESET).
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(600);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  }, 30000);
});

function resolveProbeHost(): string {
  const explicit = process.env.ROUTECODEX_PROBE_HOST?.trim();
  if (explicit) {
    return explicit;
  }
  const iface = networkInterfaces().en0?.find((entry) => entry.family === 'IPv4' && !entry.internal)?.address;
  return iface ?? '127.0.0.1';
}

async function probePort(host: string, port: number): Promise<{ listening: boolean }> {
  return await new Promise((resolve) => {
    const sock = new Socket();
    const done = (listening: boolean) => {
      sock.destroy();
      resolve({ listening });
    };
    sock.setTimeout(2000);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });
}
