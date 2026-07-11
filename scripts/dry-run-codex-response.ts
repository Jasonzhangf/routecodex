#!/usr/bin/env tsx
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  convertProviderResponseIfNeeded,
} from '../src/server/runtime/http-server/executor/provider-response-converter.js';
import { MetadataCenter } from '../src/server/runtime/http-server/metadata-center/metadata-center.js';
import { writeMetadataCenterSlot } from '../src/server/runtime/http-server/metadata-center/dualwrite-api.js';

type Options = {
  sample?: string;
  outDir?: string;
  entryEndpoint?: string;
  providerProtocol?: string;
  providerKey?: string;
  providerType?: string;
  providerFamily?: string;
  requestId?: string;
};

const RESPONSE_DRY_RUN_WRITER = {
  module: 'scripts/dry-run-codex-response.ts',
  symbol: 'main',
  stage: 'response_dry_run_runtime_control'
} as const;

function usage(): void {
  console.log(`Usage:
  npm run dry-run:codex-response -- --sample <provider-response.json> [--out-dir DIR] [--entry-endpoint /v1/responses] [--provider-protocol openai-responses]
`);
}

function parseArgs(argv = process.argv.slice(2)): Options {
  const options: Options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--sample') options.sample = argv[++index];
    else if (arg === '--out-dir') options.outDir = argv[++index];
    else if (arg === '--entry-endpoint') options.entryEndpoint = argv[++index];
    else if (arg === '--provider-protocol') options.providerProtocol = argv[++index];
    else if (arg === '--provider-key') options.providerKey = argv[++index];
    else if (arg === '--provider-type') options.providerType = argv[++index];
    else if (arg === '--provider-family') options.providerFamily = argv[++index];
    else if (arg === '--request-id') options.requestId = argv[++index];
    else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${arg}`);
    }
  }
  if (!options.sample) {
    usage();
    throw new Error('--sample is required');
  }
  return options;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  const text = await fs.readFile(file, 'utf8');
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`JSON root must be an object: ${file}`);
  }
  return parsed as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function inferEntryEndpoint(samplePath: string, doc: Record<string, unknown>, options: Options): string {
  const meta = asRecord(doc.meta);
  const explicit = readString(options.entryEndpoint, meta?.entryEndpoint, doc.entryEndpoint, doc.endpoint);
  if (explicit) {
    return explicit;
  }
  const normalizedPath = samplePath.replace(/\\/g, '/').toLowerCase();
  if (normalizedPath.includes('/anthropic') || normalizedPath.includes('/messages')) return '/v1/messages';
  if (normalizedPath.includes('/chat')) return '/v1/chat/completions';
  return '/v1/responses';
}

function inferProviderProtocol(samplePath: string, entryEndpoint: string, doc: Record<string, unknown>, options: Options): string {
  const meta = asRecord(doc.meta);
  const explicit = readString(options.providerProtocol, meta?.providerProtocol, doc.providerProtocol);
  if (explicit) {
    return explicit;
  }
  const normalizedPath = samplePath.replace(/\\/g, '/').toLowerCase();
  if (entryEndpoint.includes('/messages') || normalizedPath.includes('anthropic')) return 'anthropic-messages';
  if (entryEndpoint.includes('/chat/completions') || normalizedPath.includes('openai-chat')) return 'openai-chat';
  return 'openai-responses';
}

function inferProviderType(providerProtocol: string, options: Options): string {
  const explicit = readString(options.providerType);
  if (explicit) {
    return explicit;
  }
  if (providerProtocol === 'anthropic-messages') return 'anthropic';
  if (providerProtocol === 'openai-responses') return 'responses';
  if (providerProtocol === 'gemini-chat') return 'gemini';
  return 'openai';
}

function extractProviderResponse(doc: Record<string, unknown>): {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
} {
  const bodyRecord = asRecord(doc.body);
  const dataRecord = asRecord(doc.data);
  const rawStatus = doc.status ?? bodyRecord?.status ?? dataRecord?.status;
  const status = typeof rawStatus === 'number' && Number.isFinite(rawStatus) ? rawStatus : undefined;
  const headersSource = asRecord(doc.headers) ?? asRecord(bodyRecord?.headers) ?? asRecord(dataRecord?.headers);
  const headers: Record<string, string> = {};
  if (headersSource) {
    for (const [key, value] of Object.entries(headersSource)) {
      if (typeof value === 'string') {
        headers[key] = value;
      }
    }
  }
  const body = normalizeProviderResponseBody(bodyRecord, dataRecord, doc);
  if (body === undefined) {
    throw new Error('provider response sample does not contain body/data');
  }
  return {
    ...(status ? { status } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    body
  };
}

function hasOwn(record: Record<string, unknown> | undefined, key: string): boolean {
  return Boolean(record && Object.prototype.hasOwnProperty.call(record, key));
}

function readBodyTextFromRecord(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of ['bodyText', 'raw', 'text', 'sseBodyText']) {
    const value = record[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

function isSerializedReadable(value: unknown): boolean {
  const record = asRecord(value);
  return Boolean(
    record
    && (
      asRecord(record._readableState)
      || asRecord(record._writableState)
      || typeof record.readable === 'boolean'
      || typeof record.readableEnded === 'boolean'
      || typeof record.readableFlowing === 'boolean'
    )
  );
}

function maybeWrapSseBody(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!record) {
    return undefined;
  }
  const bodyText = readBodyTextFromRecord(record);
  if (bodyText !== undefined) {
    return {
      ...record,
      sseStream: Readable.from([bodyText])
    };
  }
  if (isSerializedReadable(record.sseStream)) {
    throw new Error(
      'provider-response sample contains a serialized sseStream but no bodyText/raw/text field.\n'
      + 'This snapshot was captured as a live Readable and cannot be replayed offline.\n'
      + 'Re-capture with snapshots enabled (ROUTECODEX_CAPTURE_STREAM_SNAPSHOTS=1) or '
      + 'point --sample at a provider-response file whose body.bodyText is a complete SSE log '
      + '(see attachProviderSseSnapshotStream in src/debug/snapshot/provider-sse.ts).'
    );
  }
  return undefined;
}

function normalizeProviderResponseBody(
  bodyRecord: Record<string, unknown> | undefined,
  dataRecord: Record<string, unknown> | undefined,
  doc: Record<string, unknown>
): unknown {
  const directSse = maybeWrapSseBody(bodyRecord) ?? maybeWrapSseBody(dataRecord);
  if (directSse) {
    return directSse;
  }
  if (hasOwn(bodyRecord, 'body')) {
    return bodyRecord?.body;
  }
  if (hasOwn(bodyRecord, 'data')) {
    return bodyRecord?.data;
  }
  if (hasOwn(dataRecord, 'body')) {
    return dataRecord?.body;
  }
  if (hasOwn(dataRecord, 'data')) {
    return dataRecord?.data;
  }
  return doc.body ?? doc.data;
}

async function main(): Promise<void> {
  const options = parseArgs();
  const samplePath = path.resolve(options.sample as string);
  const doc = await readJson(samplePath);
  const meta = asRecord(doc.meta);
  const entryEndpoint = inferEntryEndpoint(samplePath, doc, options);
  const providerProtocol = inferProviderProtocol(samplePath, entryEndpoint, doc, options);
  const providerKey = readString(options.providerKey, meta?.providerKey, doc.providerKey);
  const providerFamily = readString(options.providerFamily, meta?.providerId, doc.providerFamily);
  const requestId = readString(options.requestId, meta?.clientRequestId, meta?.requestId, doc.requestId)
    ?? `response_dry_run_${Date.now()}`;
  const providerResponse = extractProviderResponse(doc);
  const pipelineMetadata: Record<string, unknown> = {
    requestId,
    entryEndpoint,
    ...(providerKey ? { providerKey } : {}),
    ...(providerFamily ? { providerFamily } : {})
  };
  MetadataCenter.attach(pipelineMetadata);
  writeMetadataCenterSlot({
    target: pipelineMetadata,
    family: 'runtime_control',
    key: 'providerProtocol',
    value: providerProtocol,
    writer: RESPONSE_DRY_RUN_WRITER,
    reason: 'response dry-run provider protocol'
  });

  const converted = await convertProviderResponseIfNeeded({
    entryEndpoint,
    providerProtocol,
    providerType: inferProviderType(providerProtocol, options),
    providerFamily,
    providerKey,
    requestId,
    serverToolsEnabled: true,
    wantsStream: false,
    response: {
      status: providerResponse.status ?? 200,
      headers: providerResponse.headers,
      body: providerResponse.body
    },
    pipelineMetadata
  }, {
    runtimeManager: {
      resolveRuntimeKey: () => undefined,
      getHandleByRuntimeKey: () => undefined
    },
    executeNested: async () => {
      throw new Error('response dry-run must not execute nested live pipeline');
    }
  });

  const outDir = path.resolve(options.outDir ?? path.join(path.dirname(samplePath), 'runs', requestId, 'response-dry-run'));
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'response-dry-run.json');
  await fs.writeFile(outPath, JSON.stringify({
    ok: true,
    sample: samplePath,
    entryEndpoint,
    providerProtocol,
    providerKey,
    requestId,
    converted
  }, null, 2), 'utf8');
  console.log(`[dry-run-codex-response] wrote ${outPath}`);
}

main().catch((error) => {
  console.error('[dry-run-codex-response] failed:', error);
  process.exit(1);
});
