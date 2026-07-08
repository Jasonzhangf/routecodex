import path from 'node:path';
import { createRequire } from 'node:module';
import { PassThrough, Readable } from 'node:stream';

// feature_id: sse.public_ts_lib_surface
// feature_id: sse.runtime_rust_dispatch
// canonical_builders: sse_public_ts_lib_surface_deleted_contract
// canonical_builders: build_sse_frames_from_json_json, build_json_from_sse_json
const nodeRequire = createRequire(import.meta.url);
const nativeBinding = nodeRequire(
  path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node')
) as Record<string, unknown>;

function nativeFn(name: string): (...args: unknown[]) => unknown {
  const fn = nativeBinding[name];
  if (typeof fn !== 'function') {
    throw new Error(`${name} native export is required`);
  }
  return fn as (...args: unknown[]) => unknown;
}

function parseNativeRecord(raw: unknown, capability: string): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`${capability} returned invalid payload`);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} returned non-object payload`);
  }
  return parsed as Record<string, unknown>;
}

export async function collectSseBodyText(source: AsyncIterable<string | Buffer>): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of source) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
  }
  return chunks.join('');
}

export function buildReadableFromSseFrames(frames: string[]): Readable {
  const stream = new PassThrough({ objectMode: false });
  queueMicrotask(() => {
    try {
      for (const frame of frames) {
        if (!stream.writable) break;
        stream.write(frame);
      }
      if (stream.writable) stream.end();
    } catch (error) {
      stream.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  return stream;
}

export function buildJsonFromSseDirectNative(input: {
  protocol: string;
  bodyText: string;
  requestId?: string;
  model?: string;
  config?: Record<string, unknown>;
}): Record<string, unknown> {
  return parseNativeRecord(nativeFn('buildJsonFromSseJson')(JSON.stringify({
    protocol: input.protocol,
    body_text: input.bodyText,
    request_id: input.requestId,
    model: input.model,
    config: input.config ?? {},
  })), 'buildJsonFromSseJson');
}

export function buildSseFramesFromJsonDirectNative(input: {
  protocol: string;
  response: unknown;
  requestId?: string;
  model?: string;
  config?: Record<string, unknown>;
}): { frames: string[]; stats?: Record<string, unknown> } {
  const parsed = parseNativeRecord(nativeFn('buildSseFramesFromJsonJson')(JSON.stringify({
    protocol: input.protocol,
    response: input.response,
    request_id: input.requestId,
    model: input.model,
    config: input.config ?? {},
  })), 'buildSseFramesFromJsonJson');
  if (!Array.isArray(parsed.frames) || parsed.frames.some((frame) => typeof frame !== 'string')) {
    throw new Error('buildSseFramesFromJsonJson returned invalid frames');
  }
  return {
    frames: parsed.frames as string[],
    ...(parsed.stats && typeof parsed.stats === 'object' && !Array.isArray(parsed.stats)
      ? { stats: parsed.stats as Record<string, unknown> }
      : {}),
  };
}
