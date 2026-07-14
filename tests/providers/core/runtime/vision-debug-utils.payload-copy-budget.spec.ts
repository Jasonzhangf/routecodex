import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { buildSnapshotPayload } from '../../../../src/debug/snapshot/provider-utils.ts';
import { buildVisionSnapshotPayload } from '../../../../src/providers/core/runtime/vision-debug-utils.ts';

describe('vision debug payload copy budget', () => {
  it('borrows the pre-writer payload while the snapshot writer creates the independent redacted graph', () => {
    const payload: Record<string, unknown> = {
      messages: [{ role: 'user', content: 'hello' }]
    };
    payload.self = payload;
    const extras = { wantsSse: true };

    const projection = buildVisionSnapshotPayload(payload, extras);

    expect(projection.payload).toBe(payload);
    expect(projection.extras).toBe(extras);

    const materialized = buildSnapshotPayload({
      stage: 'provider-body-debug',
      data: projection
    }) as Record<string, unknown>;
    const body = materialized.body as Record<string, unknown>;
    const materializedPayload = body.payload as Record<string, unknown>;
    expect(body).not.toBe(projection);
    expect(materializedPayload).not.toBe(payload);
    expect(materializedPayload.self).toBe('[CIRCULAR]');
    expect(materializedPayload).toMatchObject({
      messages: [{ role: 'user', content: 'hello' }]
    });

    ((payload.messages as Array<Record<string, unknown>>)[0]!).content = 'mutated later';
    expect(materializedPayload).toMatchObject({
      messages: [{ role: 'user', content: 'hello' }]
    });
  });

  it('does not reintroduce a pre-writer JSON deep clone', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/providers/core/runtime/vision-debug-utils.ts'),
      'utf8'
    );
    expect(source).not.toContain('function safeClone');
    expect(source).not.toContain('JSON.parse(JSON.stringify');
  });
});
