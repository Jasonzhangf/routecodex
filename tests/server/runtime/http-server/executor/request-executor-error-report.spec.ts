import { describe, expect, test } from '@jest/globals';

import { cloneErrorForReporting } from '../../../../../src/server/runtime/http-server/executor/request-executor-error-report.js';

describe('request executor error report cloning', () => {
  test('preserves provider error reported marker on executor report clone', () => {
    const providerErrorReportedMarker = Symbol.for('routecodex.provider.errorReported');
    const original = Object.assign(new Error('HTTP 503: upstream unavailable'), {
      code: 'HTTP_503',
      statusCode: 503,
      [providerErrorReportedMarker]: true
    });

    const cloned = cloneErrorForReporting(original);

    expect(cloned).toBeInstanceOf(Error);
    expect((cloned as { code?: unknown }).code).toBe('HTTP_503');
    expect((cloned as { statusCode?: unknown }).statusCode).toBe(503);
    expect((cloned as { [providerErrorReportedMarker]?: unknown })[providerErrorReportedMarker]).toBe(true);
  });
});
