import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  resetStopMessageRuntimeConfigCacheForTests,
  resolveStopMessageDefaultMaxRepeats
} from '../../sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/config.js';

describe('stop_message runtime config precedence', () => {
  const prevConfigPath = process.env.ROUTECODEX_STOPMESSAGE_CONFIG_PATH;
  let tempDir = '';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-stopmessage-config-'));
    resetStopMessageRuntimeConfigCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (prevConfigPath === undefined) {
      delete process.env.ROUTECODEX_STOPMESSAGE_CONFIG_PATH;
    } else {
      process.env.ROUTECODEX_STOPMESSAGE_CONFIG_PATH = prevConfigPath;
    }
    resetStopMessageRuntimeConfigCacheForTests();
  });

  test('uses config file maxRepeats as the highest-priority source', () => {
    const configPath = path.join(tempDir, 'stop-message.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        default: {
          enabled: true,
          text: '继续执行',
          maxRepeats: 3
        }
      }),
      'utf8'
    );
    process.env.ROUTECODEX_STOPMESSAGE_CONFIG_PATH = configPath;
    process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS = '2';
    resetStopMessageRuntimeConfigCacheForTests();

    expect(resolveStopMessageDefaultMaxRepeats()).toBe(3);
  });
});
