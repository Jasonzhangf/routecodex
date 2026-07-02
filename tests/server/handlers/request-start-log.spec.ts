import { jest } from '@jest/globals';

import { logRequestStart } from '../../../src/server/handlers/handler-utils.js';

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
});
