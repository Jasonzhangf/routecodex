import { describe, expect, it } from '@jest/globals';

import fs from 'node:fs';
import path from 'node:path';

describe('state-integrations continuation context extraction', () => {
  it('keeps the removed continuation-context session helper absent', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/llmswitch/bridge/state-integrations.ts'),
      'utf8'
    );
    expect(source).not.toContain('extractContinuationContextSessionIdentifiersFromMetadata');
    expect(source).not.toContain('session_identifiers.extract_continuation.invoke');
  });
});
