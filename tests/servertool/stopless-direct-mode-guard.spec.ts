import * as fs from 'node:fs';
import { describe, expect, test } from '@jest/globals';

const DELETED_ENGINE_SHELL = 'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts';
const DELETED_RESPONSE_STAGE_SHELL = 'sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts';

describe('stopless direct mode guard removal', () => {
  test('retired TS response-stage shells stay deleted', () => {
    expect(fs.existsSync(DELETED_ENGINE_SHELL)).toBe(false);
    expect(fs.existsSync(DELETED_RESPONSE_STAGE_SHELL)).toBe(false);
  });

  test('active servertool sources do not restore direct-mode no-followup branch', () => {
    const servertoolRoot = 'sharedmodule/llmswitch-core/src/servertool';
    const source = fs.readdirSync(servertoolRoot, { recursive: true })
      .map((entry) => `${servertoolRoot}/${String(entry)}`)
      .filter((entry) => /\.(?:ts|js)$/.test(entry) && fs.statSync(entry).isFile())
      .map((entry) => fs.readFileSync(entry, 'utf8'))
      .join('\n');

    expect(source).not.toContain('direct_mode_no_followup');
    expect(source).not.toContain('allowFollowup === false');
  });
});
