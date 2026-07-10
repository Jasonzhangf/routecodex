import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

describe('virtual router bootstrap wrapper residue', () => {
  it('keeps retired production bootstrap wrapper absent', () => {
    const retiredPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-bootstrap-config.ts',
    );

    expect(fs.existsSync(retiredPath)).toBe(false);
  });
});
