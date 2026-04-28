import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Block real disk I/O — all state verification is in-memory only
jest.unstable_mockModule('node:fs', () => ({
  default: {
    existsSync: jest.fn().mockReturnValue(false),
    readFileSync: jest.fn().mockReturnValue('{}'),
    mkdirSync: jest.fn(),
    writeFileSync: jest.fn(),
    renameSync: jest.fn(),
  },
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn().mockReturnValue('{}'),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
}));

jest.unstable_mockModule('node:fs/promises', () => ({
  default: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
    rename: jest.fn().mockResolvedValue(undefined),
  },
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
  rename: jest.fn().mockResolvedValue(undefined),
}));

let recordTokens: any;
let getTokenTotals: any;
let getTokenStatsSnapshot: any;
let __resetTokenStatsForTest: any;

beforeEach(async () => {
  const mod = await import('../../../src/server/runtime/http-server/executor/token-stats-store.js');
  recordTokens = mod.recordTokens;
  getTokenTotals = mod.getTokenTotals;
  getTokenStatsSnapshot = mod.getTokenStatsSnapshot;
  __resetTokenStatsForTest = mod.__resetTokenStatsForTest;
  __resetTokenStatsForTest();
});

afterEach(() => {
  __resetTokenStatsForTest();
});

describe('token-stats-store', () => {
  it('records tokens and returns correct totals', () => {
    recordTokens('provider1', 'model-a', 100, 50, 150);
    const totals = getTokenTotals();
    expect(totals.alltimeTokens).toBe(150);
    expect(totals.dailyTokens).toBe(150);
  });

  it('accumulates multiple records', () => {
    recordTokens('p1', 'm1', 100, 50, 150);
    recordTokens('p1', 'm1', 200, 100, 300);
    const totals = getTokenTotals();
    expect(totals.alltimeTokens).toBe(450);
    expect(totals.dailyTokens).toBe(450);
  });

  it('falls back to prompt+completion when totalTokens is 0', () => {
    recordTokens('p1', 'm1', 100, 50, 0);
    const totals = getTokenTotals();
    expect(totals.alltimeTokens).toBe(150);
  });

  it('skips zero-zero-zero records', () => {
    recordTokens('p1', 'm1', 0, 0, 0);
    const totals = getTokenTotals();
    expect(totals.alltimeTokens).toBe(0);
  });

  it('normalizes empty provider key to unknown-provider', () => {
    recordTokens('', 'model', 10, 5, 15);
    const snapshot = getTokenStatsSnapshot();
    expect(snapshot.providers.length).toBe(1);
    expect(snapshot.providers[0].providerKey).toBe('unknown-provider');
  });

  it('tracks per-provider breakdown sorted by totalTokens desc', () => {
    recordTokens('p1', 'm1', 100, 50, 150);
    recordTokens('p2', 'm2', 200, 100, 300);
    const snapshot = getTokenStatsSnapshot();
    expect(snapshot.providers.length).toBe(2);
    expect(snapshot.providers[0].totalTokens).toBe(300);
    expect(snapshot.providers[1].totalTokens).toBe(150);
  });

  it('uses today date key for daily tracking', () => {
    recordTokens('p1', 'm1', 10, 5, 15);
    const snapshot = getTokenStatsSnapshot();
    const today = new Date();
    const expectedKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(snapshot.dailyDate).toBe(expectedKey);
    expect(snapshot.daily.totalTokens).toBe(15);
  });

  it('resets all state via __resetTokenStatsForTest', () => {
    recordTokens('p1', 'm1', 100, 50, 150);
    __resetTokenStatsForTest();
    const totals = getTokenTotals();
    expect(totals.alltimeTokens).toBe(0);
    expect(totals.dailyTokens).toBe(0);
    const snapshot = getTokenStatsSnapshot();
    expect(snapshot.providers.length).toBe(0);
  });
});
