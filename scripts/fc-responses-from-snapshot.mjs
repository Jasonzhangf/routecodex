#!/usr/bin/env node
// Use OpenAI Responses SDK to send an existing snapshot's originalData
// directly to an upstream /v1/responses endpoint, to verify whether the
// "correct" payload shape (as captured via monitor) succeeds.
//
// Usage:
//   FC_API_KEY=... node scripts/fc-responses-from-snapshot.mjs \
//     ~/.routecodex/codex-samples/openai-responses/req_xxx_request_1_validation_pre.json \
//     [baseUrl]
//
// baseUrl defaults to https://www.fakercode.top/v1

import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';

const snapshotPath = process.argv[2];
if (!snapshotPath) {
  console.error('Usage: node scripts/fc-responses-from-snapshot.mjs <snapshot.json> [baseUrl]');
  process.exit(1);
}

const baseURL = process.argv[3] || 'https://www.fakercode.top/v1';

const apiKey =
  process.env.FC_API_KEY ||
  process.env.OPENAI_API_KEY ||
  '';

if (!apiKey) {
  console.error('FC_API_KEY / OPENAI_API_KEY is required');
  process.exit(1);
}

async function loadOriginalData(p) {
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  const text = await fs.readFile(abs, 'utf-8');
  const json = JSON.parse(text);
  const data = json && typeof json === 'object' && json.data && typeof json.data === 'object'
    ? json.data
    : json;
  const original = data && typeof data === 'object' && data.originalData && typeof data.originalData === 'object'
    ? data.originalData
    : data;
  return original;
}

async function main() {
  const original = await loadOriginalData(snapshotPath);
  if (!original || typeof original !== 'object') {
    console.error('snapshot does not contain usable originalData');
    process.exit(2);
  }

  // Allow overriding model to gpt-5.1 via env, but keep everything else as-is.
  const modelOverride = process.env.FC_MODEL || process.env.OPENAI_MODEL;
  const payload = {
    ...original,
    ...(modelOverride ? { model: modelOverride } : {})
  };

  const client = new OpenAI({ apiKey, baseURL });

  console.log('[fc-snap] BASE_URL', baseURL);
  console.log('[fc-snap] MODEL', payload.model);

  try {
    const stream = await client.responses.stream(payload);
    console.log('[fc-snap] STREAM_OK');
    const eventCounts = {};
    let firstEvents = [];

    for await (const event of stream) {
      const t = event?.type || 'unknown';
      eventCounts[t] = (eventCounts[t] || 0) + 1;
      if (firstEvents.length < 5) {
        firstEvents.push(event);
      }
    }

    console.log('[fc-snap] EVENT_COUNTS', JSON.stringify(eventCounts, null, 2));
    console.log('[fc-snap] FIRST_EVENTS', JSON.stringify(firstEvents, null, 2));
  } catch (err) {
    console.log('[fc-snap] STREAM_ERROR');
    console.log(
      JSON.stringify(
        {
          name: err?.name,
          message: err?.message,
          status: err?.status,
          code: err?.code,
          type: err?.type,
          data: err?.response?.data
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[fc-snap] FATAL', e?.message || String(e));
  process.exit(3);
});

