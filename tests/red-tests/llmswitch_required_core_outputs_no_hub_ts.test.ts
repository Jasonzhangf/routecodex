import { describe, expect, it } from '@jest/globals';

import { createRequiredCoreOutputs } from '../../scripts/lib/build-core-utils.mjs';

describe('llmswitch required core dist output boundary', () => {
  it('does not keep Hub Pipeline TS runtime shells as required dist outputs', () => {
    const requiredOutputs = createRequiredCoreOutputs('/tmp/rcc-dist')
      .map((entry) => entry.replaceAll('\\', '/'));

    expect(requiredOutputs).not.toContain('/tmp/rcc-dist/conversion/hub/response/provider-response.js');
    expect(requiredOutputs).not.toContain('/tmp/rcc-dist/conversion/shared/responses-conversation-store.js');
  });
});
