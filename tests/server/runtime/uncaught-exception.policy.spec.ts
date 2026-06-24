import { describe, expect, it, jest } from '@jest/globals';

import {
  buildUncaughtExceptionDetails,
  extractErrorTopFrame,
  handleRuntimeUncaughtException
} from '../../../src/index.js';

describe('runtime uncaught exception policy', () => {
  it('extracts top stack frame file and line for traceability', () => {
    const error = new Error('boom');
    error.stack = [
      'Error: boom',
      '    at doThing (/tmp/routecodex/foo.ts:12:34)',
      '    at main (/tmp/routecodex/main.ts:56:78)'
    ].join('\n');

    expect(extractErrorTopFrame(error)).toEqual({
      frame: 'at doThing (/tmp/routecodex/foo.ts:12:34)',
      file: '/tmp/routecodex/foo.ts',
      line: 12,
      column: 34,
    });
    expect(buildUncaughtExceptionDetails(error)).toEqual(expect.objectContaining({
      message: 'boom',
      file: '/tmp/routecodex/foo.ts',
      line: 12,
      column: 34,
      action: 'continue_without_shutdown'
    }));
  });

  it('reports uncaught exceptions with file line and keeps runtime alive', () => {
    const logLifecycle = jest.fn();
    const report = jest.fn();
    const consoleError = jest.fn();
    const error = new Error('kaboom');
    error.stack = [
      'Error: kaboom',
      '    at worker (/srv/routecodex/runtime.ts:88:9)'
    ].join('\n');

    handleRuntimeUncaughtException(error, {
      logLifecycle: logLifecycle as any,
      report: report as any,
      consoleError
    });

    expect(logLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      event: 'uncaught_exception',
      details: expect.objectContaining({
        message: 'kaboom',
        file: '/srv/routecodex/runtime.ts',
        line: 88,
        column: 9,
        action: 'continue_without_shutdown'
      })
    }));
    expect(report).toHaveBeenCalledWith(
      'UNCAUGHT_EXCEPTION',
      'Uncaught Exception',
      error,
      'critical',
      expect.objectContaining({
        file: '/srv/routecodex/runtime.ts',
        line: 88,
        column: 9,
        action: 'continue_without_shutdown'
      })
    );
    expect(consoleError).toHaveBeenCalledWith(
      '❌ Uncaught Exception @ /srv/routecodex/runtime.ts:88:9:',
      error
    );
  });
});
