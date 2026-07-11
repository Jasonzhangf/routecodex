import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

describe('apply_patch legacy removal contract', () => {
  it('physically removes the old TS structured apply_patch implementation files', () => {
    const removedPaths = [
      'sharedmodule/llmswitch-core/src/tools/apply-patch/structured.js',
      'sharedmodule/llmswitch-core/src/tools/apply-patch/structured/coercion.js',
    ];

    expect(removedPaths.filter((relativePath) => fs.existsSync(path.join(process.cwd(), relativePath)))).toEqual([]);
  });
});
