import { jest } from '@jest/globals';

import {
  buildHandlerLogMetadata,
  logRequestStart
} from '../../../src/server/handlers/handler-utils.js';

describe('logRequestStart', () => {
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

  beforeEach(() => {
    warnSpy.mockClear();
  });

  afterAll(() => {
    warnSpy.mockRestore();
  });

  it('does not print raw/prepared input shape by default', () => {
    logRequestStart('/v1/responses', 'req-start-shape', {
      inboundStream: true,
      clientAcceptsSse: true,
      timeoutMs: 900000,
      rawInputItems: 833,
      preparedInputItems: 790,
      rawInputShape: {
        inputKind: 'array',
        typeCounts: {
          message: 45,
          reasoning: 41,
          function_call: 373,
          function_call_output: 373,
        },
        roleCounts: {
          user: 34,
          developer: 3,
          assistant: 8,
        },
        estimatedTextChars: 1686072,
      },
      preparedInputShape: {
        inputKind: 'array',
        typeCounts: {
          message: 45,
          reasoning: 41,
          function_call: 350,
          function_call_output: 350,
        },
        estimatedTextChars: 877507,
      },
      plannedEntryMode: 'none',
    });

    const rendered = warnSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
    expect(rendered).toContain('rawInputItems=833');
    expect(rendered).toContain('preparedInputItems=790');
    expect(rendered).not.toContain('rawInputShape=');
    expect(rendered).not.toContain('preparedInputShape=');
    expect(rendered).not.toContain('typeCounts');
    expect(rendered).not.toContain('roleCounts');
    expect(rendered).not.toContain('estimatedTextChars');
  });

  it('registers request start color from tmux session metadata', async () => {
    const { resolveSessionAnsiColor } = await import('../../../src/utils/session-log-color.js');
    const expectedColor = resolveSessionAnsiColor('request-start-tmux');

    logRequestStart('/v1/responses', 'req-start-session-color', {
      sessionId: 'request-start-session',
      clientTmuxSessionId: 'request-start-tmux',
      inboundStream: true
    });

    const rendered = String(warnSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(expectedColor).toBeDefined();
    expect(rendered.startsWith(String(expectedColor))).toBe(true);
  });

  it('builds request start color from inbound codex session scope', async () => {
    const { resolveSessionAnsiColor } = await import('../../../src/utils/session-log-color.js');
    const turnMetadata = JSON.stringify({
      scope: { tmux_session: 'tmux-start-log-scope' },
      cwd: '/tmp/start-log-project'
    });
    const logMetadata = buildHandlerLogMetadata({
      entryEndpoint: '/v1/responses',
      headers: {
        'user-agent': 'codex-cli',
        'x-codex-turn-metadata': encodeURIComponent(turnMetadata)
      }
    });
    const expectedSessionId = 'rcc-session:codex:tmux-start-log-scope:tmp_start-log-project';
    const expectedColor = resolveSessionAnsiColor('tmux-start-log-scope');

    logRequestStart('/v1/responses', 'req-start-codex-scope-color', {
      clientRequestId: 'client-start-codex-scope',
      ...logMetadata,
      inboundStream: true
    });

    const rendered = String(warnSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(logMetadata.sessionId).toBe(expectedSessionId);
    expect(logMetadata.conversationId).toBe(expectedSessionId);
    expect(logMetadata.logSessionColorKey).toBe(expectedSessionId);
    expect(expectedColor).toBeDefined();
    expect(rendered.startsWith(String(expectedColor))).toBe(true);
  });
});
