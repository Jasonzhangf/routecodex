import {
  apiFetch,
  extractRoutingTargets,
  formatDurationMs,
  formatEpochWithDelta,
  formatInt,
  formatTs,
  parseJsonObject,
  prettyJson,
  resolveRoutedProviderKeys,
  resolveTargetToProviderKeys,
  readSessionValue,
  statusClass,
  textOf,
  writeSessionValue,
  type QuotaProvider
} from '../../webui/src/App';

describe('webui App utilities', () => {
  afterEach(() => {
    // @ts-expect-error test cleanup
    delete globalThis.sessionStorage;
    // @ts-expect-error test cleanup
    delete globalThis.fetch;
  });

  it('textOf and formatInt handle edge values', () => {
    expect(textOf(null)).toBe('');
    expect(textOf(undefined)).toBe('');
    expect(textOf(0)).toBe('0');
    expect(textOf('abc')).toBe('abc');

    expect(formatInt(1234)).toBe('1,234');
    expect(formatInt('not-a-number')).toBe('0');
  });

  it('formatTs and duration helpers are stable', () => {
    expect(formatTs(undefined)).toBe('—');
    expect(formatTs(-1)).toBe('—');
    expect(formatDurationMs(1000)).toBe('1s');
    expect(formatDurationMs(60_000)).toBe('1m');
    expect(formatDurationMs(3_600_000)).toBe('1h');

    const future = Date.now() + 60_000;
    const text = formatEpochWithDelta(future);
    expect(text).toContain('in ');
  });

  it('JSON helpers validate objects only', () => {
    const ok = parseJsonObject('{"a":1}');
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value).toEqual({ a: 1 });
    }

    const bad = parseJsonObject('[1,2,3]');
    expect(bad.ok).toBe(false);

    expect(prettyJson({ a: 1 })).toContain('"a": 1');
  });

  it('extractRoutingTargets and resolver map targets to provider keys', () => {
    const routing = {
      default: [
        { targets: ['qwen', 'antigravity.work.gpt-4'] },
        { targets: ['tab'] }
      ],
      tools: [{ targets: ['mock.provider.model-a'] }]
    };

    const targets = extractRoutingTargets(routing);
    expect(Array.from(targets).sort()).toEqual([
      'antigravity.work.gpt-4',
      'mock.provider.model-a',
      'qwen',
      'tab'
    ]);

    const providers: QuotaProvider[] = [
      { providerKey: 'qwen.default.qwen-max' },
      { providerKey: 'qwen.work.qwen-plus' },
      { providerKey: 'tab.key1.gpt-5' },
      { providerKey: 'antigravity.work.gpt-4' },
      { providerKey: 'mock.provider.model-a' }
    ];

    expect(resolveTargetToProviderKeys('qwen', providers).sort()).toEqual([
      'qwen.default.qwen-max',
      'qwen.work.qwen-plus'
    ]);

    const resolved = resolveRoutedProviderKeys(targets, providers);
    expect(Array.from(resolved).sort()).toEqual([
      'antigravity.work.gpt-4',
      'mock.provider.model-a',
      'qwen.default.qwen-max',
      'qwen.work.qwen-plus',
      'tab.key1.gpt-5'
    ]);
  });

  it('statusClass maps status to semantic classes', () => {
    expect(statusClass('valid')).toBe('ok');
    expect(statusClass('connected')).toBe('ok');
    expect(statusClass('invalid')).toBe('err');
    expect(statusClass('error')).toBe('err');
    expect(statusClass('unknown')).toBe('warn');
  });

  it('sessionStorage helpers read/write safely', () => {
    const map = new Map<string, string>();
    // @ts-expect-error test stub
    globalThis.sessionStorage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => map.set(key, value),
      removeItem: (key: string) => map.delete(key)
    };

    expect(readSessionValue('x')).toBe('');
    writeSessionValue('x', '1');
    expect(readSessionValue('x')).toBe('1');
    writeSessionValue('x', '');
    expect(readSessionValue('x')).toBe('');
  });

  it('apiFetch handles success and error payloads', async () => {
    // @ts-expect-error test stub
    globalThis.fetch = async () =>
      ({
        ok: true,
        text: async () => JSON.stringify({ ok: true, data: { a: 1 } })
      }) as Response;

    const ok = await apiFetch<{ ok: boolean; data: { a: number } }>('/any');
    expect(ok).toEqual({ ok: true, data: { a: 1 } });

    // @ts-expect-error test stub
    globalThis.fetch = async () =>
      ({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => JSON.stringify({ error: { message: 'boom' } })
      }) as Response;

    await expect(apiFetch('/bad')).rejects.toMatchObject({ message: 'boom', status: 400, path: '/bad' });
  });
});
