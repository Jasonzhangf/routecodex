import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import {
  colorizeRequestLog,
  registerRequestLogContext,
  resolveRequestLogColorToken
} from '../../../src/server/utils/request-log-color.js';

describe('request log color registry', () => {
  const originalForceColor = process.env.FORCE_COLOR;
  const originalNoColor = process.env.NO_COLOR;
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  beforeEach(() => {
    process.env.FORCE_COLOR = '1';
    delete process.env.NO_COLOR;
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true
    });
  });

  afterEach(() => {
    if (originalForceColor === undefined) {
      delete process.env.FORCE_COLOR;
    } else {
      process.env.FORCE_COLOR = originalForceColor;
    }
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
    if (stdoutDescriptor) {
      Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
    } else {
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });

  it('reuses registered session color for continued request ids', () => {
    registerRequestLogContext('req-color-1', { sessionId: 'session-a' });

    const baseColor = resolveRequestLogColorToken('req-color-1');
    const continueColor = resolveRequestLogColorToken('req-color-1:continue');
    const baseLine = colorizeRequestLog('[usage] request req-color-1', 'req-color-1');
    const continueLine = colorizeRequestLog('✅ [/v1/responses] request req-color-1:continue completed', 'req-color-1:continue');

    expect(baseColor).toBeDefined();
    expect(baseColor).toBe(continueColor);
    expect(baseLine.startsWith(String(baseColor))).toBe(true);
    expect(continueLine.startsWith(String(baseColor))).toBe(true);
  });

  it('uses explicit session context before request fallback', () => {
    registerRequestLogContext('req-color-2', { sessionId: 'session-a' });

    const explicitColor = resolveRequestLogColorToken('req-color-2', { sessionId: 'session-b' });
    const registeredColor = resolveRequestLogColorToken('req-color-2');

    expect(explicitColor).toBeDefined();
    expect(registeredColor).toBeDefined();
    expect(explicitColor).not.toBe(registeredColor);
  });
});
