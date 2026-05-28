import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, jest } from '@jest/globals';

describe('RouteCodexApp.stop responses continuation retention', () => {
  const clearAllMock = jest.fn(async () => undefined);

  beforeEach(() => {
    jest.resetModules();
    clearAllMock.mockClear();
  });

  it('RED: stop must not clear responses continuation store (preserve for client continuation after restart)', async () => {
    await jest.unstable_mockModule('../../src/modules/llmswitch/bridge.js', async () => {
      const actual = await import('../../src/modules/llmswitch/bridge.js');
      return {
        ...actual,
        clearAllResponsesConversationState: clearAllMock
      };
    });

    const mod = await import('../../src/index.js');
    const { RouteCodexApp } = mod as unknown as { RouteCodexApp: new (p?: string) => any };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-stop-retain-'));
    const modulesPath = path.join(tmpDir, 'modules.json');
    fs.writeFileSync(modulesPath, JSON.stringify({ modules: {} }), 'utf8');

    const app = new RouteCodexApp(modulesPath) as any;
    app._isRunning = true;
    app.httpServer = { stop: jest.fn(async () => undefined) };

    await app.stop();

    expect(app.httpServer.stop).toHaveBeenCalledTimes(1);
    expect(clearAllMock).not.toHaveBeenCalled();
  });
});
