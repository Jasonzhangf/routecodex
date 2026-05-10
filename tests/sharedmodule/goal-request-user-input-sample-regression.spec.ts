import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';

const SAMPLE_DIR = path.join(
  '/Volumes/extension/.rcc/codex-samples/openai-responses/mimo.key1.mimo-v2.5-pro',
  'req_1778308938522_7c9bd7e6'
);

const hasSample = fs.existsSync(path.join(SAMPLE_DIR, 'provider-request.json'));

describe('goal request_user_input sample regression', () => {
  test(hasSample ? 'captured bad sample shows schema was flattened before fix' : 'sample missing; skip', () => {
    if (!hasSample) {
      expect(true).toBe(true);
      return;
    }

    const requestDoc = JSON.parse(
      fs.readFileSync(path.join(SAMPLE_DIR, 'provider-request.json'), 'utf8')
    ) as Record<string, any>;

    const tools = requestDoc?.body?.tools;
    expect(Array.isArray(tools)).toBe(true);

    const requestUserInput = tools.find((tool: any) => tool?.name === 'request_user_input');
    expect(requestUserInput).toBeDefined();
    expect(requestUserInput.input_schema?.properties?.questions?.items).toEqual({ type: 'object' });
    expect(requestUserInput.input_schema?.properties?.questions?.items?.properties).toBeUndefined();
  });
});
