import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

describe('SSE index public surface retired boundary', () => {
  it('keeps the old public index shell physically deleted', () => {
    const sourcePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/sse/index.ts'
    );

    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it('native SSE runtime remains the script/library entrypoint', async () => {
    const mod = await import('../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-sse-runtime.js');

    expect(typeof mod.buildJsonFromSseWithNative).toBe('function');
    expect(typeof mod.buildSseFramesFromJsonWithNative).toBe('function');
    expect(mod.defaultSseCodecRegistry).toBeUndefined();
  });

  it('deleted runtime TS surfaces stay absent from SSE registry indirection path', () => {
    const deletedRuntimeFiles = [
      path.join('sharedmodule/llmswitch-core/src/conversion/hub/pipeline', 'hub-pipeline' + '.ts'),
      path.join('sharedmodule/llmswitch-core/src/conversion/hub/response', 'provider-response' + '.ts'),
    ];

    for (const file of deletedRuntimeFiles) {
      expect(fs.existsSync(path.join(process.cwd(), file))).toBe(false);
    }
  });
});
