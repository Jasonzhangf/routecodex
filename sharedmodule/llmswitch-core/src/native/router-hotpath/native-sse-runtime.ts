import { PassThrough, Readable } from 'node:stream';
import {
  extractNativeErrorMessage,
  failNative,
  isNativeDisabledByEnv,
  readNativeFunction
} from './native-hub-pipeline-resp-semantics-shared.js';

// feature_id: sse.runtime_rust_dispatch
// feature_id: sse.public_ts_lib_surface
// Retired public SSE TS shell owner: src/sse/index.ts stays deleted; use this native bridge directly.
export type NativeSseRuntimeProtocol =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'gemini-chat';

export interface NativeSseFramesInput {
  protocol: NativeSseRuntimeProtocol | string;
  response: unknown;
  requestId?: string;
  model?: string;
  config?: Record<string, unknown>;
}

export interface NativeSseFramesOutput {
  frames: string[];
  stats: Record<string, unknown>;
}

export interface NativeSseJsonInput {
  protocol: NativeSseRuntimeProtocol | string;
  bodyText: string;
  requestId?: string;
  model?: string;
  config?: Record<string, unknown>;
}

function callNativeSseJson<T>(
  capability: string,
  input: Record<string, unknown>,
  parse: (raw: string) => T | null,
): T {
  const fail = (reason?: string) => failNative<T>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let inputJson: string;
  try {
    inputJson = JSON.stringify(input);
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      throw new Error(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parse(raw);
    if (!parsed) {
      return fail('invalid result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export function buildSseFramesFromJsonWithNative(input: NativeSseFramesInput): NativeSseFramesOutput {
  return callNativeSseJson(
    'buildSseFramesFromJsonJson',
    {
      protocol: input.protocol,
      response: input.response,
      request_id: input.requestId,
      model: input.model,
      config: input.config ?? {}
    },
    (raw) => {
      const parsed = JSON.parse(raw) as { frames?: unknown; stats?: unknown };
      if (
        !parsed
        || !Array.isArray(parsed.frames)
        || parsed.frames.some((frame) => typeof frame !== 'string')
        || !parsed.stats
        || typeof parsed.stats !== 'object'
        || Array.isArray(parsed.stats)
      ) {
        return null;
      }
      return {
        frames: parsed.frames,
        stats: parsed.stats as Record<string, unknown>
      };
    },
  );
}

export function buildJsonFromSseWithNative(input: NativeSseJsonInput): Record<string, unknown> {
  return callNativeSseJson(
    'buildJsonFromSseJson',
    {
      protocol: input.protocol,
      body_text: input.bodyText,
      request_id: input.requestId,
      model: input.model,
      config: input.config ?? {}
    },
    (raw) => {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    },
  );
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
        if (!stream.writable) {
          break;
        }
        stream.write(frame);
      }
      if (stream.writable) {
        stream.end();
      }
    } catch (error) {
      stream.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  return stream;
}
