import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  colorizeVirtualRouterHitLogLine,
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

    expect(token).toBe('\x1b[36m');
    expect(line).toBe('\x1b[36m[usage] request req-without-session\x1b[0m');
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

  it('does not color virtual-router-hit lines from request context when sid is absent', () => {
    const sessionId = 'session-vr-hit-context';
    const requestId = 'req-vr-hit-context';

    registerRequestLogContext(requestId, { sessionId });
    const line = colorizeVirtualRouterHitLogLine(
      `\x1b[38;5;208m[virtual-router-hit]\x1b[0m \x1b[90m19:42:25\x1b[0m req=${requestId} \x1b[36mtools/pool -> provider.model reason=tools\x1b[0m`
    );

    expect(line).toContain('\x1b[38;5;208m[virtual-router-hit]\x1b[0m');
    expect(line).toContain(`req=${requestId} \x1b[36mtools/pool -> provider.model`);
  });

  it('does not recolor virtual-router-hit lines without an explicit session key', () => {
    const line = colorizeVirtualRouterHitLogLine(
      `\x1b[38;5;208m[virtual-router-hit]\x1b[0m \x1b[90m19:42:25\x1b[0m req=req-vr-hit-no-session \x1b[36mtools/pool -> provider.model reason=tools\x1b[0m`
    );

    expect(line).toContain('\x1b[38;5;208m[virtual-router-hit]\x1b[0m');
    expect(line).not.toContain('\x1b[90m[virtual-router-hit]\x1b[0m');
  });

  it('uses stable tmux session color across different request/session ids', () => {
    const tmuxSessionId = 'tmux-stable-color-1';
    const expectedColor = resolveSessionAnsiColor(tmuxSessionId);

    registerRequestLogContext('req-stable-color-a', {
      clientTmuxSessionId: tmuxSessionId,
      sessionId: 'request-session-a'
    });
    registerRequestLogContext('req-stable-color-b', {
      clientTmuxSessionId: tmuxSessionId,
      sessionId: 'request-session-b'
    });

    expect(resolveRequestLogColorToken('req-stable-color-a')).toBe(expectedColor);
    expect(resolveRequestLogColorToken('req-stable-color-b')).toBe(expectedColor);
    expect(resolveRequestLogColorToken('req-stable-color-c', {
      clientTmuxSessionId: tmuxSessionId,
      sessionId: 'request-session-c'
    })).toBe(expectedColor);
  });

  it('uses one registered tmux color for request, response, and usage lines', () => {
    const tmuxSessionId = 'tmux-same-color-log-family';
    const expectedColor = resolveSessionAnsiColor(tmuxSessionId);
    let requestSessionId = 'request-specific-session';
    for (let index = 0; index < 64 && resolveSessionAnsiColor(requestSessionId) === expectedColor; index += 1) {
      requestSessionId = `request-specific-session-${index}`;
    }
    const requestSessionColor = resolveSessionAnsiColor(requestSessionId);

    registerRequestLogContext('req-same-color', {
      clientTmuxSessionId: tmuxSessionId,
      sessionId: requestSessionId
    });

    const requestLine = colorizeRequestLog('▶ [/v1/responses] request req-same-color started', 'req-same-color');
    const responseLine = colorizeRequestLog('✅ [/v1/responses] request req-same-color completed', 'req-same-color');
    const usageLine = colorizeRequestLog('[usage] req=req-same-color', 'req-same-color');

    expect(expectedColor).toBeDefined();
    expect(requestSessionColor).toBeDefined();
    expect(requestSessionColor).not.toBe(expectedColor);
    expect(requestLine.startsWith(String(expectedColor))).toBe(true);
    expect(responseLine.startsWith(String(expectedColor))).toBe(true);
    expect(usageLine.startsWith(String(expectedColor))).toBe(true);
    expect(requestLine.startsWith(String(requestSessionColor))).toBe(false);
    expect(responseLine.startsWith(String(requestSessionColor))).toBe(false);
    expect(usageLine.startsWith(String(requestSessionColor))).toBe(false);
  });

  it('colors virtual-router-hit lines from sid without request context', () => {
    const sessionId = 'session-vr-hit-direct-sid';
    const expectedColor = resolveSessionAnsiColor(sessionId);
    const line = colorizeVirtualRouterHitLogLine(
      `[virtual-router-hit] 19:42:25 req=req-vr-hit-direct sid=${sessionId} search/pool -> provider.model reason=search`
    );

    expect(expectedColor).toBeDefined();
    expect(line).toContain(`${expectedColor}[virtual-router-hit]\x1b[0m`);
    expect(line).toContain(`sid=${sessionId} ${expectedColor}search/pool -> provider.model`);
  });

  it('colors virtual-router-hit lines from bracket session without request context', () => {
    const sessionId = 'session-vr-hit-bracket';
    const expectedColor = resolveSessionAnsiColor(sessionId);
    const line = colorizeVirtualRouterHitLogLine(
      `[virtual-router-hit] [${sessionId}] tools/pool -> provider.model`
    );

    expect(expectedColor).toBeDefined();
    expect(line).toContain(`${expectedColor}[virtual-router-hit]\x1b[0m`);
    expect(line).toContain(`[${sessionId}] ${expectedColor}tools/pool -> provider.model`);
  });

  it('uses different virtual-router-hit colors for different session ids', () => {
    const firstSessionId = 'session-vr-hit-color-a';
    const secondSessionId = 'session-vr-hit-color-b';
    const firstColor = resolveSessionAnsiColor(firstSessionId);
    const secondColor = resolveSessionAnsiColor(secondSessionId);
    const firstLine = colorizeVirtualRouterHitLogLine(
      `[virtual-router-hit] 19:42:25 req=req-vr-hit-a sid=${firstSessionId} tools/pool -> provider.model`
    );
    const secondLine = colorizeVirtualRouterHitLogLine(
      `[virtual-router-hit] 19:42:25 req=req-vr-hit-b sid=${secondSessionId} tools/pool -> provider.model`
    );

    expect(firstColor).toBeDefined();
    expect(secondColor).toBeDefined();
    expect(firstColor).not.toBe(secondColor);
    expect(firstLine).toContain(`${firstColor}[virtual-router-hit]\x1b[0m`);
    expect(secondLine).toContain(`${secondColor}[virtual-router-hit]\x1b[0m`);
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

  it('uses the shared virtual-router session color owner', () => {
    const sessionIds = [
      '019cdb2b-c9f2-7d51-aa85-a62fd2a8fed0',
      '019cae75-2560-78b3-bfe0-c39c4fa77a0e',
      '019cd00b-eee3-77e1-b04f-716ebc1dcbb3'
    ];

    for (const sessionId of sessionIds) {
      expect(resolveSessionAnsiColor(sessionId)).toBe(resolveSessionAnsiColor(sessionId));
    }
  });

  it('does not assign red, white, black, or gray ansi colors to session logs', () => {
    const blocked = new Set(['\x1b[30m', '\x1b[31m', '\x1b[37m', '\x1b[90m', '\x1b[91m', '\x1b[97m']);

    for (let i = 0; i < 512; i += 1) {
      const color = resolveSessionAnsiColor(`session-palette-${i}`);
      expect(color).toBeDefined();
      expect(blocked.has(String(color))).toBe(false);
    }
  });

  it('colors completion logs with explicit session context when request id lacks prior registration', () => {
    const line = colorizeRequestLog('✅ [/v1/chat/completions] request openai-chat-demo completed', 'openai-chat-demo', {
      sessionId: 'session-response-colored'
    });

    expect(line.startsWith(String(resolveSessionAnsiColor('session-response-colored')))).toBe(true);
  });

  it('keeps outer request color when the line already contains embedded ansi highlight', () => {
    const sessionId = 'session-highlighted-finish';
    const outerColor = resolveSessionAnsiColor(sessionId);
    const line = colorizeRequestLog(
      '✅ [/v1/responses] request req-highlight completed (status=200, finish_reason=tool_calls)',
      'req-highlight',
      { sessionId }
    );

    expect(line.startsWith(String(outerColor))).toBe(true);
    expect(line).toContain('finish_reason=tool_calls');
    expect(line).toContain('status=\x1b[97m200\x1b[0m');
  });

  it('colors error request logs red', () => {
    const sessionId = 'session-error-log';
    const line = colorizeRequestLog(
      '❌ [/v1/responses] 21:05:22 request req-error failed: upstream 503',
      'req-error',
      { sessionId },
      { isError: true }
    );

    expect(line.startsWith('\x1b[31m')).toBe(true);
    expect(line).toContain('503');
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
