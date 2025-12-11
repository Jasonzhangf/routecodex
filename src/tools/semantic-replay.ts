import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SemanticTracker, stableStringify } from '../monitoring/semantic-tracker.js';
import type { SemanticSnapshotInput, SemanticReplayResult } from '../monitoring/semantic-tracker.js';
import { loadSemanticFieldSpecs } from '../monitoring/semantic-config-loader.js';
import type { DebugNodeDirection } from '../debug/types.js';

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

  let snapshots: SemanticSnapshotInput[];
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

async function loadSnapshots(file: string, limit?: number): Promise<SemanticSnapshotInput[]> {
  const raw = await fs.readFile(file, 'utf-8');
  const trimmed = raw.trim();
  let records: unknown[] = [];
  if (trimmed.startsWith('[')) {
    try {
      records = JSON.parse(trimmed);
    } catch (error) {
      console.warn('[semantic-replay] failed to parse JSON array, falling back to JSONL', error);
      records = parseJsonLines(raw);
    }
  } else {
    records = parseJsonLines(raw);
  }
  const snapshots: SemanticSnapshotInput[] = [];
  let fallbackTimestamp = Date.now();
  for (const record of records) {
    if (!record || typeof record !== 'object') {
      continue;
    }
    const snap = record as Record<string, unknown>;
    const metadata =
      snap.metadata && typeof snap.metadata === 'object' ? (snap.metadata as Record<string, unknown>) : undefined;
    const rawDirection = typeof snap.direction === 'string' ? snap.direction.toLowerCase() : undefined;
    const direction: DebugNodeDirection = rawDirection === 'response' ? 'response' : 'request';
    const resolvedTimestamp =
      typeof snap.timestamp === 'number'
        ? snap.timestamp
        : typeof metadata?.timestamp === 'number'
          ? (metadata.timestamp as number)
          : fallbackTimestamp++;
    snapshots.push({
      nodeId: typeof snap.nodeId === 'string' && snap.nodeId.trim().length ? snap.nodeId : 'unknown',
      direction,
      stage: typeof snap.stage === 'string' && snap.stage.trim().length ? snap.stage : 'unknown',
      payload: snap.payload,
      metadata,
      timestamp: resolvedTimestamp,
      source: typeof snap.source === 'string' ? snap.source : undefined,
      protocol: typeof snap.protocol === 'string' ? snap.protocol : undefined,
      entryEndpoint:
        typeof snap.entryEndpoint === 'string'
          ? snap.entryEndpoint
          : typeof metadata?.entryEndpoint === 'string'
            ? (metadata.entryEndpoint as string)
            : undefined
    });
  }
  if (typeof limit === 'number' && limit > 0) {
    return snapshots.slice(-limit);
  }
  return snapshots;
}

function parseJsonLines(raw: string): unknown[] {
  const records: unknown[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // ignore invalid lines
    }
  }
  return records;
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

const DEFAULT_SAMPLES_ROOT = process.env.ROUTECODEX_SAMPLES_DIR
  ? path.resolve(process.env.ROUTECODEX_SAMPLES_DIR)
  : path.join(os.homedir(), '.routecodex', 'codex-samples');

async function loadSnapshotsForRequest(
  requestId: string,
  protocolHint: string | undefined,
  samplesRoot: string
): Promise<SemanticSnapshotInput[]> {
  const protocolDir = resolveProtocolDir(requestId, protocolHint);
  const dirPath = path.join(samplesRoot, protocolDir);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dirPath);
  } catch (error) {
    console.error('[semantic-replay] Failed to read codex-samples directory', dirPath, error);
    return [];
  }
  const searchTokens = buildSearchTokens(requestId);
  const matchingFiles = entries.filter((file) => searchTokens.some((token) => file.includes(token)));
  if (!matchingFiles.length) {
    console.warn(`[semantic-replay] No files matched request ${requestId} under ${protocolDir}`);
  }
  const snapshots: SemanticSnapshotInput[] = [];
  for (const file of matchingFiles) {
    const snap = await parseSnapshotFile(path.join(dirPath, file), { protocolHint, requestId });
    if (snap) {
      snapshots.push(snap);
    }
  }
  if (protocolDir === 'anthropic-messages') {
    const contextSnaps = await loadAnthropicContextSnapshots(requestId, dirPath, entries, snapshots);
    snapshots.push(...contextSnaps);
  }
  return snapshots;
}

function resolveProtocolDir(requestId: string, protocolHint?: string): string {
  if (protocolHint) {
    return protocolHint;
  }
  if (requestId.includes('anthropic')) {
    return 'anthropic-messages';
  }
  if (requestId.includes('openai-chat')) {
    return 'openai-chat';
  }
  if (requestId.includes('responses') || requestId.includes('openai-responses')) {
    return 'openai-responses';
  }
  return 'anthropic-messages';
}

function buildSearchTokens(requestId: string): string[] {
  const tokens = new Set<string>();
  tokens.add(requestId);
  if (requestId.startsWith('anthropic-messages-')) {
    const suffix = requestId.replace('anthropic-messages-', '');
    tokens.add(suffix);
    tokens.add(`anthropic-messages-router-${suffix}`);
  }
  const timeMatch = requestId.match(/T\d{6,}-\d+/);
  if (timeMatch) {
    tokens.add(timeMatch[0]);
  }
  return [...tokens];
}

interface SnapshotParseOptions {
  protocolHint?: string;
  requestId?: string;
}

async function parseSnapshotFile(filePath: string, options: SnapshotParseOptions = {}): Promise<SemanticSnapshotInput | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    console.warn('[semantic-replay] Failed to read snapshot file', filePath, error);
    return null;
  }
  let record: Record<string, unknown> | null = tryParseJson(raw);
  if (!record) {
    console.warn('[semantic-replay] Failed to parse snapshot', filePath);
    return null;
  }
  const meta = (record.meta || record.summary || {}) as Record<string, unknown>;
  const body = (record.body || record.payload || record) as Record<string, unknown>;
  const directionRaw = body.direction || meta.direction || inferDirectionFromFilename(filePath);
  const direction: DebugNodeDirection = String(directionRaw).toLowerCase() === 'response' ? 'response' : 'request';
  const stage = String(meta.stage || body.stage || inferStageFromFilename(filePath) || 'unknown');
  const entryEndpoint = (meta.entryEndpoint || meta.endpoint || body.entryEndpoint || undefined) as string | undefined;
  const timestamp = normalizeTimestamp(meta.timestamp, meta.buildTime) ?? Date.now();
  const metadata = { ...meta } as Record<string, unknown>;
  metadata.sourceFile = filePath;
  if (options.requestId) {
    metadata.requestId = options.requestId;
  }
  const metaNodeIdRaw = metadata['nodeId'];
  const bodyNodeIdRaw = body['nodeId'];
  const nodeId =
    typeof metaNodeIdRaw === 'string' && metaNodeIdRaw.trim().length
      ? metaNodeIdRaw.trim()
      : typeof bodyNodeIdRaw === 'string' && bodyNodeIdRaw.trim().length
        ? bodyNodeIdRaw.trim()
        : stage || 'snapshot';
  const snapshot: SemanticSnapshotInput = {
    nodeId,
    stage,
    direction,
    payload: record,
    metadata,
    timestamp,
    entryEndpoint,
    protocol: (body.protocol || meta.protocol || options.protocolHint || inferProtocolFromFilename(filePath)) as string | undefined,
    source: path.relative(process.cwd(), filePath)
  };
  return snapshot;
}

function inferStageFromFilename(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath));
  const parts = base.split('_');
  if (parts.length >= 3) {
    return parts.slice(-2).join('_');
  }
  return base;
}

function inferDirectionFromFilename(filePath: string): DebugNodeDirection {
  const lower = filePath.toLowerCase();
  if (lower.includes('response') || lower.includes('resp_')) {
    return 'response';
  }
  return 'request';
}

function inferProtocolFromFilename(filePath: string): string | undefined {
  if (filePath.includes('anthropic')) {
    return 'anthropic-messages';
  }
  if (filePath.includes('openai-chat')) {
    return 'openai-chat';
  }
  if (filePath.includes('openai-responses')) {
    return 'openai-responses';
  }
  return undefined;
}

function normalizeTimestamp(value?: unknown, fallback?: unknown): number | undefined {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof fallback === 'string') {
    const parsed = Date.parse(fallback);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function tryParseJson(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const trimmed = raw.trimStart();
    const envelope = extractTopLevelJson(trimmed);
    if (!envelope) {
      return null;
    }
    try {
      return JSON.parse(envelope) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function extractTopLevelJson(raw: string): string | null {
  const startMatch = raw.match(/[\[{]/);
  if (!startMatch || startMatch.index === undefined) {
    return null;
  }
  const startIndex = startMatch.index;
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (let i = startIndex; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === '{') {
      stack.push('}');
      continue;
    }
    if (ch === '[') {
      stack.push(']');
      continue;
    }
    if ((ch === '}' || ch === ']') && stack.length) {
      const expected = stack.pop();
      if (expected !== ch) {
        return null;
      }
      if (!stack.length) {
        return raw.slice(startIndex, i + 1);
      }
    }
  }
  return null;
}

async function loadAnthropicContextSnapshots(
  requestId: string,
  dirPath: string,
  entries: string[],
  snapshots: SemanticSnapshotInput[]
): Promise<SemanticSnapshotInput[]> {
  const router = snapshots.find((snap) => typeof snap.stage === 'string' && snap.stage.includes('client-request'));
  if (!router) {
    return [];
  }
  const routerPayload = (router.payload || {}) as Record<string, unknown>;
  const rootBodyCandidate = (routerPayload.body ?? routerPayload.payload) as unknown;
  const body =
    rootBodyCandidate && typeof rootBodyCandidate === 'object'
      ? (rootBodyCandidate as Record<string, unknown>)
      : routerPayload;
  const nestedBody =
    body.body && typeof body.body === 'object' ? (body.body as Record<string, unknown>) : undefined;
  const clientRequestId =
    typeof body.clientRequestId === 'string'
      ? (body.clientRequestId as string)
      : typeof nestedBody?.clientRequestId === 'string'
        ? (nestedBody.clientRequestId as string)
        : undefined;
  const messageSeed =
    Array.isArray(nestedBody?.messages) ? nestedBody?.messages : Array.isArray(body.messages) ? (body.messages as unknown[]) : undefined;
  if (!clientRequestId || !Array.isArray(messageSeed)) {
    return [];
  }
  const matchedPrefix = await findMatchingReqPrefix(dirPath, entries, clientRequestId, messageSeed);
  if (!matchedPrefix) {
    console.warn('[semantic-replay] No context snapshots matched for', clientRequestId);
    return [];
  }
  console.log(`[semantic-replay] Attached context snapshots prefix=${matchedPrefix}`);
  const files = entries.filter((file) => file.startsWith(matchedPrefix));
  const out: SemanticSnapshotInput[] = [];
  for (const file of files) {
    const snap = await parseSnapshotFile(path.join(dirPath, file), { protocolHint: 'anthropic-messages', requestId });
    if (snap) {
      out.push(snap);
    }
  }
  return out;
}

async function findMatchingReqPrefix(
  dirPath: string,
  entries: string[],
  clientRequestId: string,
  referenceMessages: unknown
): Promise<string | null> {
  const match = clientRequestId.match(/^req_(\d+)/);
  const targetNumber = match ? Number(match[1]) : null;
  if (!targetNumber) {
    return null;
  }
  const normalizedReference = stableStringify(referenceMessages);
  const candidatePrefixes = new Set<string>();
  for (const entry of entries) {
    if (!entry.startsWith('req_')) {
      continue;
    }
    const prefixMatch = entry.match(/^req_(\d+)_/);
    if (!prefixMatch) {
      continue;
    }
    const num = Number(prefixMatch[1]);
    if (!Number.isFinite(num) || Math.abs(num - targetNumber) > 2000) {
      continue;
    }
    candidatePrefixes.add(`req_${prefixMatch[1]}_`);
  }
  for (const prefix of candidatePrefixes) {
    const stage1 = path.join(dirPath, `${prefix}req_inbound_stage1_format_parse.json`);
    try {
      await fs.access(stage1);
    } catch {
      continue;
    }
    let data: Record<string, unknown> | undefined;
    try {
      data = JSON.parse(await fs.readFile(stage1, 'utf-8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const dataBody = data && typeof data.body === 'object' ? (data.body as Record<string, unknown>) : undefined;
    const payloadNode =
      dataBody && typeof dataBody.payload === 'object' ? (dataBody.payload as Record<string, unknown>) : undefined;
    const directPayload = data.payload && typeof data.payload === 'object' ? (data.payload as Record<string, unknown>) : undefined;
    const messages =
      Array.isArray(payloadNode?.messages) ? payloadNode?.messages : Array.isArray(directPayload?.messages) ? directPayload?.messages : undefined;
    if (messages && stableStringify(messages) === normalizedReference) {
      return prefix;
    }
  }
  return null;
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
