import { writeSnapshotViaHooks } from '../../snapshot-utils.js';

type Phase = 'compat-pre' | 'compat-post';

const SNAPSHOT_FLAG = String(process.env.ROUTECODEX_SNAPSHOT ?? '').toLowerCase();
const SNAPSHOT_ENABLED = SNAPSHOT_FLAG === '1' || SNAPSHOT_FLAG === 'true';

export async function writeCompatSnapshot(options: {
  phase: Phase;
  requestId?: string;
  entryEndpoint?: string;
  data: unknown;
}): Promise<void> {
  if (!SNAPSHOT_ENABLED) {
    return;
  }
  try {
    const endpoint = options.entryEndpoint || '/v1/chat/completions';
    await writeSnapshotViaHooks({
      endpoint,
      stage: options.phase,
      requestId: options.requestId || 'unknown',
      data: options.data,
      verbosity: 'verbose'
    });
  } catch {
    // snapshots are best-effort
  }
}
