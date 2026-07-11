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
  summarizeRoutingTargetChain,
  readSessionValue,
  statusClass,
  textOf,
  writeSessionValue,
  type ProviderRuntimeKeyItem
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

  it('extractRoutingTargets and resolver map config targets, not route names, to provider keys', () => {
    const routing = {
      default: [
        { targets: ['demo', 'tab.work.gpt-4'] },
        { targets: ['tab'] }
      ],
      thinking: [{ targets: [{ target: 'fwd.gpt.gpt-5.5', priority: 200 }] }],
      tools: [{ targets: ['mock.provider.model-a'] }]
    };

    const targets = extractRoutingTargets(routing);
    expect(Array.from(targets).sort()).toEqual([
      'demo',
      'fwd.gpt.gpt-5.5',
      'mock.provider.model-a',
      'tab',
      'tab.work.gpt-4'
    ]);
    expect(targets.has('thinking')).toBe(false);

    expect(summarizeRoutingTargetChain(routing)).toEqual([
      expect.objectContaining({
        routeName: 'default',
        targets: ['demo', 'tab.work.gpt-4']
      }),
      expect.objectContaining({
        routeName: 'default',
        targets: ['tab']
      }),
      expect.objectContaining({
        routeName: 'thinking',
        targets: ['fwd.gpt.gpt-5.5']
      }),
      expect.objectContaining({
        routeName: 'tools',
        targets: ['mock.provider.model-a']
      })
    ]);

    const providers: ProviderRuntimeKeyItem[] = [
      { providerKey: 'demo.default.demo-max' },
      { providerKey: 'demo.work.demo-plus' },
      { providerKey: 'tab.key1.gpt-5' },
      { providerKey: 'tab.work.gpt-4' },
      { providerKey: 'mock.provider.model-a' }
    ];

    expect(resolveTargetToProviderKeys('demo', providers).sort()).toEqual([
      'demo.default.demo-max',
      'demo.work.demo-plus'
    ]);

    const resolved = resolveRoutedProviderKeys(targets, providers);
    expect(Array.from(resolved).sort()).toEqual([
      'demo.default.demo-max',
      'demo.work.demo-plus',
      'mock.provider.model-a',
      'tab.key1.gpt-5',
      'tab.work.gpt-4'
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
