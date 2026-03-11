import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  colorizeRequestLog,
  registerRequestLogContext,
  resolveRequestLogColorToken
} from '../../../src/server/utils/request-log-color.js';
import { resolveSessionAnsiColor } from '../../../src/utils/session-log-color.js';
import { ColoredLogger } from '../../../src/modules/pipeline/utils/colored-logger.js';

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

  it('does not hash request ids into ad-hoc colors when no session context exists', () => {
    const token = resolveRequestLogColorToken('req-without-session');
    const line = colorizeRequestLog('[usage] request req-without-session', 'req-without-session');

    expect(token).toBeUndefined();
    expect(line).toBe('[usage] request req-without-session');
  });

  it('uses explicit session context before request fallback', () => {
    registerRequestLogContext('req-color-2', { sessionId: 'session-a' });

    const explicitColor = resolveRequestLogColorToken('req-color-2', { sessionId: 'session-b' });
    const registeredColor = resolveRequestLogColorToken('req-color-2');

    expect(explicitColor).toBeDefined();
    expect(registeredColor).toBeDefined();
    expect(explicitColor).not.toBe(registeredColor);
  });

  it('aligns virtual-router-hit session color with request log color', () => {
    const sessionId = 'session-aligned';
    const expectedColor = resolveSessionAnsiColor(sessionId);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    registerRequestLogContext('req-color-3', { sessionId });
    const requestColor = resolveRequestLogColorToken('req-color-3');
    const logger = new ColoredLogger({ isDev: true });
    logger.logVirtualRouterHit('tools/tools-primary', 'provider.key1', 'model-a', sessionId);

    expect(expectedColor).toBeDefined();
    expect(requestColor).toBe(expectedColor);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`[virtual-router-hit] [${sessionId}]`));
    expect(String(logSpy.mock.calls[0]?.[0] ?? '').startsWith(String(expectedColor))).toBe(true);
  });

  it('separates current uuid-like session ids into different colors more reliably', () => {
    const colorA = resolveSessionAnsiColor('019cdb2b-c9f2-7d51-aa85-a62fd2a8fed0');
    const colorB = resolveSessionAnsiColor('019cae75-2560-78b3-bfe0-c39c4fa77a0e');
    const colorC = resolveSessionAnsiColor('019cd00b-eee3-77e1-b04f-716ebc1dcbb3');

    expect(colorA).toBeDefined();
    expect(colorB).toBeDefined();
    expect(colorC).toBeDefined();
    expect(new Set([colorA, colorB, colorC]).size).toBeGreaterThan(1);
  });

  it('colors completion logs with explicit session context when request id lacks prior registration', () => {
    const line = colorizeRequestLog('✅ [/v1/chat/completions] request openai-chat-demo completed', 'openai-chat-demo', {
      sessionId: 'session-response-colored'
    });

    expect(line.startsWith(String(resolveSessionAnsiColor('session-response-colored')))).toBe(true);
  });

  it('does not inject ansi color when console is not tty and force color is unset', () => {
    registerRequestLogContext('req-color-4', { sessionId: 'session-plain' });
    const line = colorizeRequestLog('[usage] request req-color-4', 'req-color-4');

    expect(line.startsWith(String(resolveSessionAnsiColor('session-plain')))).toBe(true);
  });

  it('allows explicit disable via routecodex force flag', () => {
    process.env.ROUTECODEX_FORCE_LOG_COLOR = '0';
    registerRequestLogContext('req-color-5', { sessionId: 'session-disabled' });

    const line = colorizeRequestLog('[usage] request req-color-5', 'req-color-5');

    expect(line).toBe('[usage] request req-color-5');
  });
});
