import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

describe('snapshot payload copy budget', () => {
  // Locks canonical builders enqueue_snapshot_job and write_snapshot_via_hooks_sync.
  it('moves full diagnostic payload ownership through queue and sync writer', () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_snapshot_hooks.rs',
      ),
      'utf8',
    );

    expect(source).not.toMatch(
      /#\[derive\([^\]]*\bClone\b[^\]]*\)\]\s*#\[serde\(rename_all = "camelCase"\)\]\s*struct SnapshotHookOptions/,
    );
    expect(source).not.toContain('try_send(options.clone())');
    expect(source).not.toContain('let mut normal = options.clone()');
  });

  it('bounds queued diagnostic payloads by bytes as well as item count', () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_snapshot_hooks.rs',
      ),
      'utf8',
    );

    expect(source).toContain('DEFAULT_SNAPSHOT_QUEUE_MEMORY_BUDGET_BYTES');
    expect(source).toContain('struct SnapshotWriterJob');
    expect(source).toContain('estimated_bytes: usize');
    expect(source).toContain('SNAPSHOT_QUEUED_BYTES');
    expect(source).toContain('"queue_memory_budget"');
  });

  it('does not serialize stage payload when trace payload capture is disabled', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/llmswitch/bridge/snapshot-recorder.ts'),
      'utf8',
    );
    const start = source.indexOf('function appendStageTrace(');
    const end = source.indexOf('\nfunction cloneStageTraceSummary(', start);
    const body = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain('if (capturePayload)');
    expect(body.indexOf('JSON.stringify(payload)')).toBeGreaterThan(body.indexOf('if (capturePayload)'));
  });
});
