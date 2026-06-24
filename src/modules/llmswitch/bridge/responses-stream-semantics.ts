import { Readable, Transform } from 'node:stream';
import {
  buildResponsesTerminalSseFramesFromProbeNative,
  updateResponsesContractProbeFromSseChunkNative,
} from './native-exports.js';
import { deriveFinishReason } from '../../../server/utils/finish-reason.js';

const ASSISTANT_DONE_REPAIR_GRACE_MS = 75;

type ResponsesTerminalEventForHttp =
  | 'response.completed'
  | 'response.done'
  | 'response.error'
  | 'response.cancelled'
  | 'response.failed';

function normalizeResponsesTerminalEventForHttp(
  value: string | null | undefined
): ResponsesTerminalEventForHttp | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return value as ResponsesTerminalEventForHttp;
}

function assertResponsesTerminalEventForHttp(
  value: string | null | undefined
): asserts value is ResponsesTerminalEventForHttp | undefined {
  if (
    value === null ||
    value === undefined ||
    value === 'response.completed' ||
    value === 'response.done' ||
    value === 'response.error' ||
    value === 'response.cancelled' ||
    value === 'response.failed'
  ) {
    return;
  }
  throw new Error(`[responses-stream] invalid pending terminal event from native layer: ${value}`);
}

export function updateResponsesContractProbeFromSseChunkForHttp(
  chunk: unknown,
  probe?: Record<string, unknown>
): Record<string, unknown> | undefined {
  return updateResponsesContractProbeFromSseChunkNative(chunk, probe);
}

export function inspectResponsesTerminalStateFromSseChunkForHttp(input: {
  chunk: unknown;
  finishReason?: string;
  seenTerminalEvent?: boolean;
  sawTerminalChunk?: boolean;
  sawResponsesCompletedChunk?: boolean;
  sawResponsesDoneEvent?: boolean;
  sawAssistantMessageDoneTerminal?: boolean;
  requiresResponsesTerminalEvent?: boolean;
  terminalSource?: string;
  pendingTerminalEvent?: 'response.completed' | 'response.done' | 'response.error' | 'response.cancelled' | 'response.failed';
}): {
  finishReason: string | undefined;
  seenTerminalEvent: boolean;
  sawTerminalChunk: boolean;
  sawResponsesCompletedChunk: boolean;
  sawResponsesDoneEvent: boolean;
  sawAssistantMessageDoneTerminal: boolean;
  requiresResponsesTerminalEvent: boolean;
  terminalSource: string | undefined;
  pendingTerminalEvent: 'response.completed' | 'response.done' | 'response.error' | 'response.cancelled' | 'response.failed' | undefined;
} {
  const result = {
    finishReason: input.finishReason,
    seenTerminalEvent: input.seenTerminalEvent === true,
    sawTerminalChunk: input.sawTerminalChunk === true,
    sawResponsesCompletedChunk: input.sawResponsesCompletedChunk === true,
    sawResponsesDoneEvent: input.sawResponsesDoneEvent === true,
    sawAssistantMessageDoneTerminal: input.sawAssistantMessageDoneTerminal === true,
    requiresResponsesTerminalEvent: input.requiresResponsesTerminalEvent === true,
    terminalSource:
      typeof input.terminalSource === 'string' && input.terminalSource.trim()
        ? input.terminalSource.trim()
        : undefined,
    pendingTerminalEvent: normalizeResponsesTerminalEventForHttp(input.pendingTerminalEvent),
  };
  const text =
    typeof input.chunk === 'string'
      ? input.chunk
      : Buffer.isBuffer(input.chunk)
        ? input.chunk.toString('utf8')
        : input.chunk instanceof Uint8Array
          ? Buffer.from(input.chunk).toString('utf8')
          : '';
  if (!text) {
    return result;
  }
  if (text.includes('data: [DONE]') && !result.requiresResponsesTerminalEvent) {
    result.seenTerminalEvent = true;
    result.sawTerminalChunk = true;
    result.terminalSource = result.terminalSource ?? '[DONE]';
  }
  const blocks = text.split(/\n\n+/);
  for (const block of blocks) {
    if (!block) {
      continue;
    }
    const lines = block.split(/\n/);
    const eventName = lines
      .filter((line) => line.startsWith('event:'))
      .map((line) => line.slice('event:'.length).trim())
      .find(Boolean);
    if (
      eventName === 'response.completed'
      || eventName === 'response.done'
      || eventName === 'response.failed'
      || eventName === 'response.error'
      || eventName === 'response.cancelled'
    ) {
      result.pendingTerminalEvent = eventName;
    }
    const dataText = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('\n');
    if (!dataText || dataText === '[DONE]') {
      continue;
    }
    try {
      const parsed = JSON.parse(dataText) as Record<string, unknown>;
      const parsedType = typeof parsed.type === 'string' ? parsed.type.trim() : '';
      const parsedItem =
        parsed.item && typeof parsed.item === 'object' && !Array.isArray(parsed.item)
          ? (parsed.item as Record<string, unknown>)
          : undefined;
      if (
        parsedType === 'response.completed'
        || parsedType === 'response.done'
        || parsedType === 'response.failed'
        || parsedType === 'response.error'
        || parsedType === 'response.cancelled'
      ) {
        result.pendingTerminalEvent = parsedType as typeof result.pendingTerminalEvent;
      }
      const derived = deriveFinishReason(parsed);
      if (!derived) {
        const itemType = typeof parsedItem?.type === 'string' ? parsedItem.type.trim() : '';
        const itemRole = typeof parsedItem?.role === 'string' ? parsedItem.role.trim() : '';
        const itemStatus =
          typeof parsedItem?.status === 'string' ? parsedItem.status.trim().toLowerCase() : '';
        if (
          parsedType === 'response.output_item.done'
          && itemType === 'message'
          && itemRole === 'assistant'
          && itemStatus === 'completed'
        ) {
          result.sawTerminalChunk = true;
          result.sawAssistantMessageDoneTerminal = true;
          result.terminalSource = result.terminalSource ?? parsedType;
        }
        if (parsedType === 'message_stop') {
          result.seenTerminalEvent = true;
          result.sawTerminalChunk = true;
          result.terminalSource = result.terminalSource ?? parsedType;
        }
        continue;
      }
      result.finishReason = derived;
      if (parsedType === 'response.completed') {
        result.sawResponsesCompletedChunk = true;
      }
      if (parsedType === 'response.done') {
        result.sawResponsesDoneEvent = true;
      }
      const trueTerminal =
        parsedType === 'response.completed'
        || parsedType === 'response.done'
        || parsedType === 'response.error'
        || parsedType === 'response.cancelled'
        || parsedType === 'response.failed'
        || parsedType === 'message_stop';
      if (trueTerminal) {
        result.seenTerminalEvent = true;
        result.sawTerminalChunk = true;
        result.terminalSource = result.terminalSource ?? eventName ?? parsedType;
      }
      if (
        parsedType === 'response.output_item.done'
        && typeof parsedItem?.type === 'string'
        && parsedItem.type.trim() === 'message'
        && typeof parsedItem?.role === 'string'
        && parsedItem.role.trim() === 'assistant'
        && typeof parsedItem?.status === 'string'
        && parsedItem.status.trim().toLowerCase() === 'completed'
      ) {
        result.sawTerminalChunk = true;
        result.sawAssistantMessageDoneTerminal = true;
        result.terminalSource = result.terminalSource ?? parsedType;
      }
    } catch {
      // Ignore parse failure; explicit terminal event scanning below still applies.
    }
  }
  for (const block of blocks) {
    if (!block) {
      continue;
    }
    const lines = block.split(/\n/);
    const eventName = lines
      .filter((line) => line.startsWith('event:'))
      .map((line) => line.slice('event:'.length).trim())
      .find((name) =>
        name === 'response.completed'
        || name === 'response.done'
        || name === 'response.failed'
        || name === 'response.error'
        || name === 'response.cancelled'
        || name === 'message_stop'
      );
    const effectiveTerminalEvent = eventName ?? result.pendingTerminalEvent;
    if (!effectiveTerminalEvent) {
      continue;
    }
    if (!eventName) {
      result.pendingTerminalEvent = undefined;
    }
    const dataText = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('\n');
    let derived = result.finishReason;
    if (dataText && dataText !== '[DONE]') {
      try {
        const parsed = JSON.parse(dataText) as Record<string, unknown>;
        derived = deriveFinishReason(parsed) ?? derived;
      } catch {
        // Ignore parse failure; terminal event itself is enough.
      }
    }
    if (effectiveTerminalEvent === 'response.completed') {
      result.sawResponsesCompletedChunk = true;
    }
    if (effectiveTerminalEvent === 'response.done') {
      result.sawResponsesDoneEvent = true;
    }
    const trueTerminal =
      effectiveTerminalEvent === 'response.completed'
      || effectiveTerminalEvent === 'response.done'
      || effectiveTerminalEvent === 'response.error'
      || effectiveTerminalEvent === 'response.cancelled'
      || effectiveTerminalEvent === 'response.failed'
      || effectiveTerminalEvent === 'message_stop';
    if (trueTerminal) {
      result.seenTerminalEvent = true;
      result.sawTerminalChunk = true;
    }
    result.finishReason = derived ?? result.finishReason;
    result.terminalSource = effectiveTerminalEvent;
    result.pendingTerminalEvent = undefined;
  }
  assertResponsesTerminalEventForHttp(result.pendingTerminalEvent);
  return result;
}

export function planResponsesStreamEndRepairForHttp(args: {
  entryEndpoint?: string;
  probe: Record<string, unknown> | undefined;
  sawResponsesCompletedChunk: boolean;
  sawResponsesDoneEvent: boolean;
  sawTerminalEvent: boolean;
}): {
  shouldRepairTerminalFrames: boolean;
  shouldRepairContinuationTerminal: boolean;
  shouldProjectIncompleteError: boolean;
} {
  const shouldRepairTerminalFrames = !args.sawResponsesCompletedChunk || !args.sawResponsesDoneEvent;
  const shouldRepairContinuationTerminal =
    !args.sawTerminalEvent
    && Boolean(args.probe)
    && (
      args.entryEndpoint === '/v1/responses'
      || args.entryEndpoint === '/v1/responses.submit_tool_outputs'
    );
  return {
    shouldRepairTerminalFrames,
    shouldRepairContinuationTerminal,
    shouldProjectIncompleteError: !args.sawTerminalEvent && !shouldRepairContinuationTerminal,
  };
}

function buildResponsesStreamIncompleteErrorFrameForHttp(requestLabel: string): string {
  return `event: error\ndata: ${JSON.stringify({
    type: 'error',
    status: 502,
    error: {
      message: 'stream closed before response.completed',
      code: 'upstream_stream_incomplete',
      request_id: requestLabel,
    },
  })}\n\n`;
}

export function attachResponsesStreamSemanticsForHttp(args: {
  stream: Readable;
  entryEndpoint?: string;
  requestLabel: string;
  onNonBlockingError?: (operation: string, error: unknown) => void;
}): Readable {
  if (
    args.entryEndpoint !== '/v1/responses'
    && args.entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    return args.stream;
  }

  let pending = '';
  let probe: Record<string, unknown> | undefined;
  let sealed = false;
  let sourceClosed = false;
  let transformRef: Transform | undefined;
  let assistantDoneRepairTimer: NodeJS.Timeout | undefined;
  let terminalState = {
    finishReason: undefined as string | undefined,
    seenTerminalEvent: false,
    sawTerminalChunk: false,
    sawResponsesCompletedChunk: false,
    sawResponsesDoneEvent: false,
    sawAssistantMessageDoneTerminal: false,
    requiresResponsesTerminalEvent: false,
    terminalSource: undefined as string | undefined,
    pendingTerminalEvent: undefined as ResponsesTerminalEventForHttp | undefined,
  };

  const inspectFrame = (frame: string): void => {
    probe = updateResponsesContractProbeFromSseChunkForHttp(frame, probe);
    terminalState = inspectResponsesTerminalStateFromSseChunkForHttp({
      chunk: frame,
      finishReason: terminalState.finishReason,
      seenTerminalEvent: terminalState.seenTerminalEvent,
      sawTerminalChunk: terminalState.sawTerminalChunk,
      sawResponsesCompletedChunk: terminalState.sawResponsesCompletedChunk,
      sawResponsesDoneEvent: terminalState.sawResponsesDoneEvent,
      sawAssistantMessageDoneTerminal: terminalState.sawAssistantMessageDoneTerminal,
      requiresResponsesTerminalEvent: terminalState.requiresResponsesTerminalEvent,
      terminalSource: terminalState.terminalSource,
      pendingTerminalEvent: terminalState.pendingTerminalEvent,
    });
  };

  const closeSourceStream = (): void => {
    if (sourceClosed) {
      return;
    }
    sourceClosed = true;
    try {
      args.stream.destroy?.();
    } catch (error) {
      args.onNonBlockingError?.(`responses-stream-semantics:destroy:${args.requestLabel}`, error);
    }
  };

  const clearAssistantDoneRepairTimer = (): void => {
    if (!assistantDoneRepairTimer) {
      return;
    }
    clearTimeout(assistantDoneRepairTimer);
    assistantDoneRepairTimer = undefined;
  };

  const sealWithRepairedTerminalFrames = (): void => {
    if (sealed || terminalState.seenTerminalEvent || !transformRef) {
      return;
    }
    const repairFrames = buildResponsesTerminalSseFramesFromProbeNative(probe, args.requestLabel);
    for (const repairFrame of repairFrames) {
      transformRef.push(repairFrame);
    }
    sealed = true;
    pending = '';
    clearAssistantDoneRepairTimer();
    try {
      args.stream.unpipe(transformRef);
    } catch (error) {
      args.onNonBlockingError?.(`responses-stream-semantics:unpipe:${args.requestLabel}`, error);
    }
    closeSourceStream();
    queueMicrotask(() => {
      try {
        transformRef?.end();
      } catch (error) {
        args.onNonBlockingError?.(`responses-stream-semantics:end:${args.requestLabel}`, error);
      }
    });
  };

  const scheduleAssistantDoneRepair = (): void => {
    if (
      sealed
      || terminalState.seenTerminalEvent
      || !terminalState.sawAssistantMessageDoneTerminal
    ) {
      return;
    }
    clearAssistantDoneRepairTimer();
    assistantDoneRepairTimer = setTimeout(() => {
      assistantDoneRepairTimer = undefined;
      if (
        sealed
        || terminalState.seenTerminalEvent
        || !terminalState.sawAssistantMessageDoneTerminal
      ) {
        return;
      }
      sealWithRepairedTerminalFrames();
    }, ASSISTANT_DONE_REPAIR_GRACE_MS);
  };

  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      if (sealed) {
        callback();
        return;
      }
      try {
        const text = typeof chunk === 'string'
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString('utf8')
            : chunk instanceof Uint8Array
              ? Buffer.from(chunk).toString('utf8')
              : String(chunk ?? '');
        clearAssistantDoneRepairTimer();
        pending += text;
        let boundary = /\r?\n\r?\n/.exec(pending);
        while (boundary) {
          const frameEnd = boundary.index + boundary[0].length;
          const frame = pending.slice(0, frameEnd);
          pending = pending.slice(frameEnd);
          inspectFrame(frame);
          this.push(frame);
          if (
            !sealed
            && terminalState.sawAssistantMessageDoneTerminal
            && !terminalState.seenTerminalEvent
          ) {
            scheduleAssistantDoneRepair();
          }
          boundary = /\r?\n\r?\n/.exec(pending);
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      if (sealed) {
        callback();
        return;
      }
      try {
        clearAssistantDoneRepairTimer();
        if (pending.trim()) {
          const frame = `${pending}\n\n`;
          inspectFrame(frame);
          this.push(frame);
          pending = '';
        }
        const repairPlan = planResponsesStreamEndRepairForHttp({
          entryEndpoint: args.entryEndpoint,
          probe,
          sawResponsesCompletedChunk: terminalState.sawResponsesCompletedChunk,
          sawResponsesDoneEvent: terminalState.sawResponsesDoneEvent,
          sawTerminalEvent: terminalState.seenTerminalEvent,
        });
        let emittedRepairFrames = false;
        if (repairPlan.shouldRepairTerminalFrames) {
          const frames = buildResponsesTerminalSseFramesFromProbeNative(probe, args.requestLabel);
          for (const frame of frames) {
            this.push(frame);
          }
          emittedRepairFrames = frames.length > 0;
        }
        if (
          !repairPlan.shouldProjectIncompleteError
          && !emittedRepairFrames
          && !terminalState.seenTerminalEvent
        ) {
          this.push(buildResponsesStreamIncompleteErrorFrameForHttp(args.requestLabel));
        }
        if (repairPlan.shouldProjectIncompleteError && !emittedRepairFrames) {
          this.push(buildResponsesStreamIncompleteErrorFrameForHttp(args.requestLabel));
        }
        callback();
      } catch (error) {
        args.onNonBlockingError?.(`responses-stream-semantics:${args.requestLabel}`, error);
        callback(error as Error);
      }
    },
  });
  transformRef = transform;
  return args.stream.pipe(transform);
}
