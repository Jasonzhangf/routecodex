import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { aggregateOpenAIChatSSEToJSON } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/openai-chat-sse-to-json.js';
import { createChatSSEStreamFromChatJson } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/json-to-chat-sse.js';
import { bridgeOpenAIChatUpstreamToEvents } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/openai-chat-upstream-bridge.js';
import { assertEquivalent } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/stream-equivalence.js';

// Disable snapshots during tests
process.env.ROUTECODEX_SNAPSHOT_ENABLE = '0';

function readFixtureLines(file: string): string[] {
  const raw = fs.readFileSync(file, 'utf-8');
  // Normalize line endings and ensure each line ends with \n
  return raw.replace(/\r\n/g, '\n').split('\n').map(line => line.trimEnd());
}

function toReadable(lines: string[]): Readable {
  const r = new Readable({ read() {} });
  setImmediate(() => {
    for (const l of lines) r.push(l + '\n');
    r.push(null);
  });
  return r;
}

function isOpenAIChunk(obj: any): obj is ChatCompletionChunk {
  return obj && obj.object === 'chat.completion.chunk' && Array.isArray(obj.choices);
}

describe('OpenAI SDK loopback: openai-sse out → our in → chat json → our out → openai-sse in', () => {
  const fixturesDir = path.join(process.cwd(), 'src', '__tests__', 'fixtures', 'openai-chat-sse');
  const files = fs.existsSync(fixturesDir) ? fs.readdirSync(fixturesDir).filter(f => f.endsWith('.sse')) : [];

  if (files.length === 0) {
    test('no fixtures found; skipping SDK loopback suite', () => {
      expect(true).toBe(true);
    });
    return;
  }

  for (const fname of files) {
    test(`loopback ${fname}`, async () => {
      const full = path.join(fixturesDir, fname);
      const lines = readFixtureLines(full);
      const upstreamReadable = toReadable(lines);

      // Validate input frames look like OpenAI chunks
      const chunks = lines.filter(l => l.startsWith('data: ') && !l.includes('[DONE]')).map(l => {
        try { return JSON.parse(l.slice(6)); } catch { return null; }
      }).filter(Boolean) as any[];
      expect(chunks.every(isOpenAIChunk)).toBe(true);

      // our sse in → chat json
      const aggregated = await aggregateOpenAIChatSSEToJSON(upstreamReadable);

      // chat json → our sse out
      const synthSSE = createChatSSEStreamFromChatJson(aggregated, { requestId: `sdk_rt_${Date.now()}` });

      // openaisdk chat sse in (simulate by validating chunk shape + event equivalence)
      const A = bridgeOpenAIChatUpstreamToEvents(toReadable(lines));
      const B = bridgeOpenAIChatUpstreamToEvents(synthSSE as unknown as Readable);
      const eq = await assertEquivalent(A, B);
      expect(eq.equal).toBe(true);
    });
  }
});

