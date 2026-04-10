import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable, PassThrough } from 'node:stream';
import { ChatSseToJsonConverter } from '../../dist/sse/sse-to-json/chat-sse-to-json-converter.js';

export const DEFAULT_CHAT_EVENTS_DIR = path.join(
  os.homedir(),
  '.routecodex',
  'codex-samples',
  'openai-chat',
  'lmstudio-golden'
);

export async function resolveChatEventsFilePath(candidatePath) {
  if (candidatePath) {
    const abs = path.isAbsolute(candidatePath) ? candidatePath : path.resolve(candidatePath);
    await assertFileExists(abs);
    return abs;
  }
  const fallback = await findLatestChatEventsFile(DEFAULT_CHAT_EVENTS_DIR);
  if (!fallback) {
    throw new Error(`No Chat SSE samples found under ${DEFAULT_CHAT_EVENTS_DIR}`);
  }
  return fallback;
}

export async function loadChatChunks(filePath) {
  const text = await fs.readFile(filePath, 'utf-8');
  const lines = text.split('\n');
  const chunks = [];
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.chunk) {
        chunks.push(parsed.chunk);
      } else if (parsed?.event) {
        chunks.push(parsed.event);
      } else {
        chunks.push(parsed);
      }
    } catch (error) {
      console.warn(`[chat-sse-utils] Failed to parse line: ${line.slice(0, 80)}`, error);
    }
  }
  if (!chunks.length) {
    throw new Error(`No Chat SSE chunks found in ${filePath}`);
  }
  return chunks;
}

export async function convertChatChunksToJson(chunks, options = {}) {
  const converter = new ChatSseToJsonConverter();
  const requestId = options.requestId || `chat_bridge_${Date.now()}`;
  const model = options.model || deriveModelFromChunks(chunks);
  const readable = Readable.from([buildChatSseText(chunks)]);
  const response = await converter.convertSseToJson(readable, {
    requestId,
    model,
    onError: (err) => console.warn('[chat-sse-utils] SSE conversion error:', err?.message || err)
  });
  return {
    response,
    meta: {
      requestId,
      model,
      chunkCount: chunks.length
    }
  };
}

export function createChatSseReadableFromChunks(chunks) {
  const stream = new PassThrough();
  stream.write(buildChatSseText(chunks));
  stream.end();
  return stream;
}

function buildChatSseText(chunks) {
  const parts = [];
  for (const chunk of chunks) {
    parts.push('event: chat_chunk\n');
    parts.push(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  parts.push('event: chat.done\n');
  parts.push('data: "[DONE]"\n\n');
  return parts.join('');
}

function deriveModelFromChunks(chunks, fallback = 'unknown') {
  for (const chunk of chunks) {
    const model = chunk?.model || chunk?.data?.model;
    if (typeof model === 'string' && model.trim()) {
      return model;
    }
  }
  return fallback;
}

async function findLatestChatEventsFile(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.events.ndjson')) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const stats = await fs.stat(fullPath);
        candidates.push({ path: fullPath, mtime: stats.mtimeMs });
      } catch {
        // ignore stat errors
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0]?.path ?? null;
  } catch (error) {
    console.warn(`[chat-sse-utils] Unable to scan ${dir}:`, error?.message || error);
    return null;
  }
}

async function assertFileExists(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
}
