import fs from 'node:fs/promises';
import path from 'node:path';
import { SemanticTracker } from '../monitoring/semantic-tracker.js';
import type { SemanticReplayResult } from '../monitoring/semantic-tracker.js';
import { loadSemanticFieldSpecs } from '../monitoring/semantic-config-loader.js';
import {
  DEFAULT_SAMPLES_ROOT,
  loadSnapshots,
  loadSnapshotsForRequest
} from './semantic-replay-snapshot-loader.js';

interface CliOptions {
  input?: string;
  config?: string;
  json?: string;
  limit?: number;
  request?: string;
  protocol?: string;
  samplesDir?: string;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input && !options.request) {
    console.error('Usage: tsx src/tools/semantic-replay.ts (--input <snapshots.jsonl> | --request <sampleId>) [--config file] [--json out.json] [--limit N]');
    process.exit(1);
  }

  let snapshots;
  const samplesRoot = options.samplesDir ? path.resolve(options.samplesDir) : DEFAULT_SAMPLES_ROOT;

  if (options.request) {
    snapshots = await loadSnapshotsForRequest(options.request, options.protocol, samplesRoot);
  } else {
    const absInput = path.resolve(options.input as string);
    snapshots = await loadSnapshots(absInput, options.limit);
  }
  if (!snapshots.length) {
    console.error('[semantic-replay] No snapshots found');
    process.exit(2);
  }

  const fields = await loadSemanticFieldSpecs(options.config ? { path: options.config } : undefined);
  const tracker = new SemanticTracker({ fields });
  const result = tracker.track(snapshots);

  console.log(`[semantic-replay] Loaded ${snapshots.length} snapshots`);

  renderTimeline(result.points, fields.map((field) => field.id));
  renderChanges(result.changes);

  if (options.json) {
    const outPath = path.resolve(options.json);
    await fs.writeFile(outPath, JSON.stringify(result, null, 2), 'utf-8');
    console.log('\n[semantic-replay] wrote JSON report to', outPath);
  }
}

function parseArgs(args: string[]): CliOptions {
  const out: CliOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--input' || arg === '-i') && i + 1 < args.length) {
      out.input = args[++i];
      continue;
    }
    if ((arg === '--config' || arg === '-c') && i + 1 < args.length) {
      out.config = args[++i];
      continue;
    }
    if ((arg === '--json' || arg === '-j') && i + 1 < args.length) {
      out.json = args[++i];
      continue;
    }
    if ((arg === '--limit' || arg === '-l') && i + 1 < args.length) {
      const parsed = Number(args[++i]);
      if (!Number.isNaN(parsed)) {
        out.limit = parsed;
      }
      continue;
    }
    if ((arg === '--request' || arg === '-r') && i + 1 < args.length) {
      out.request = args[++i];
      continue;
    }
    if ((arg === '--protocol' || arg === '-p') && i + 1 < args.length) {
      out.protocol = args[++i];
      continue;
    }
    if ((arg === '--samples' || arg === '-s') && i + 1 < args.length) {
      out.samplesDir = args[++i];
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: tsx src/tools/semantic-replay.ts (--input <snapshots.jsonl> | --request <sampleId>)');
      process.exit(0);
    }
  }
  return out;
}

function renderTimeline(points: SemanticReplayResult['points'], fieldOrder: string[]): void {
  console.log('\n=== Semantic Timeline ===');
  points.forEach((point, index) => {
    const ts = point.timestamp ? new Date(point.timestamp).toISOString() : 'n/a';
    console.log(`\n[${index}] stage=${point.stage} node=${point.nodeId ?? '-'} time=${ts}`);
    if (point.source) {
      console.log(`    file=${point.source}`);
    }
    fieldOrder.forEach((fieldId) => {
      const value = point.values[fieldId];
      if (!value || (!value.present && value.summary === null)) {
        return;
      }
      const changedMark = value.changed ? '*' : ' ';
      const summary = value.summary ?? '(empty)';
      console.log(`  ${changedMark} ${fieldId}: ${summary}`);
    });
  });
}

function renderChanges(changes: SemanticReplayResult['changes']): void {
  console.log('\n=== Semantic Changes ===');
  if (!changes.length) {
    console.log('  (none)');
    return;
  }
  changes.forEach((change, idx) => {
    console.log(`  [${idx}] ${change.specId} @ ${change.stage} (#${change.index}) ${change.description ?? ''}`.trim());
  });
}

main().catch((error) => {
  console.error('[semantic-replay] failed:', error);
  process.exit(99);
});
