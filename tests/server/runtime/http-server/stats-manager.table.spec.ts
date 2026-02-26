import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { StatsManager } from '../../../../src/server/runtime/http-server/stats-manager.js';

describe('StatsManager provider summary table output', () => {
  const originalStatsEnabledEnv = process.env.ROUTECODEX_STATS_ENABLED;
  const originalStatsVerboseEnv = process.env.ROUTECODEX_STATS_VERBOSE;
  const originalStatsLogEnv = process.env.ROUTECODEX_STATS_LOG;
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-stats-table-'));
    process.env.ROUTECODEX_STATS_ENABLED = '1';
    process.env.ROUTECODEX_STATS_VERBOSE = '1';
    process.env.ROUTECODEX_STATS_LOG = path.join(tempDir, 'provider-stats.jsonl');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (originalStatsEnabledEnv === undefined) {
      delete process.env.ROUTECODEX_STATS_ENABLED;
    } else {
      process.env.ROUTECODEX_STATS_ENABLED = originalStatsEnabledEnv;
    }
    if (originalStatsVerboseEnv === undefined) {
      delete process.env.ROUTECODEX_STATS_VERBOSE;
    } else {
      process.env.ROUTECODEX_STATS_VERBOSE = originalStatsVerboseEnv;
    }
    if (originalStatsLogEnv === undefined) {
      delete process.env.ROUTECODEX_STATS_LOG;
    } else {
      process.env.ROUTECODEX_STATS_LOG = originalStatsLogEnv;
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('prints session summary as compact table rows', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const stats = new StatsManager();

    stats.recordRequestStart('req-1');
    stats.bindProvider('req-1', { providerKey: 'iflow.3-138.kimi-k2.5', model: 'kimi-k2.5' });
    stats.recordCompletion('req-1', {
      usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 }
    });

    stats.recordRequestStart('req-2');
    stats.bindProvider('req-2', { providerKey: 'tab.key1.gpt-5.2-codex', model: 'gpt-5.2-codex' });
    stats.recordCompletion('req-2', { error: true });

    stats.logSummary(12345);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('[Stats][session] Provider summary');
    expect(output).toContain('| providerKey');
    expect(output).toContain('| req');
    expect(output).toContain('avgTok(i/o/t)');
    expect(output).toContain('iflow.3-138.kimi-k2.5');
    expect(output).toContain('tab.key1.gpt-5.2-codex');
    expect(output).not.toContain('requests=');
    expect(output).not.toContain('totals tokens in/out/total=');
  });

  it('prints historical summary with window column in table', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const stats = new StatsManager();

    stats.recordRequestStart('req-h1');
    stats.bindProvider('req-h1', { providerKey: 'iflow.1-186.kimi-k2.5', model: 'kimi-k2.5' });
    stats.recordCompletion('req-h1', {
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 }
    });

    const snapshot = stats.logSummary(5678);
    await stats.persistSnapshot(snapshot, { reason: 'test' });
    await stats.logHistoricalSummary();

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('[Stats][historical] Provider summary');
    expect(output).toContain('| window');
    expect(output).toContain('→');
    expect(output).toContain('iflow.1-186.kimi-k2.5');
    expect(output).not.toContain('totals tokens in/out/total=');
  });

  it('prints compact final summary with session and historical provider token totals', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const stats = new StatsManager();

    stats.recordRequestStart('req-final-1');
    stats.bindProvider('req-final-1', { providerKey: 'iflow.2-173', model: 'kimi-k2.5' });
    stats.recordCompletion('req-final-1', {
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
    });

    stats.recordRequestStart('req-final-2');
    stats.bindProvider('req-final-2', { providerKey: 'qwen.1', model: 'qwen3.5-plus' });
    stats.recordCompletion('req-final-2', {
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }
    });

    stats.logFinalSummary(4321);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('[Stats][final][session]');
    expect(output).toContain('[Stats][final][historical]');
    expect(output).toContain('iflow.2-173 / kimi-k2.5 calls=1 tokens=10/4/14');
    expect(output).toContain('qwen.1 / qwen3.5-plus calls=1 tokens=8/2/10');
  });
});
