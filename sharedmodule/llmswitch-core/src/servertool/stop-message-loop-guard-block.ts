import { evaluateLoopGuardWithNative, type LoopGuardOutput, type LoopGuardInput } from '../router/virtual-router/engine-selection/native-servertool-core-semantics.js';

type StopMessageLoopStateLike = {
  startedAtMs?: number;
  stopPairRepeatCount?: number;
  stopPairWarned?: boolean;
};

export function evaluateStopMessageLoopGuard(args: {
  loopState: StopMessageLoopStateLike | null;
  nowMs?: number;
  warnThreshold: number;
  failThreshold: number;
  onLoopLimit: (elapsedMs: number, repeatCount: number) => never;
}): { shouldInjectWarning: boolean } {
  if (!args.loopState) {
    return { shouldInjectWarning: false };
  }

  try {
    const result = evaluateLoopGuardWithNative({
      started_at_ms: args.loopState.startedAtMs,
      stop_pair_repeat_count: args.loopState.stopPairRepeatCount,
      stop_pair_warned: args.loopState.stopPairWarned,
      now_ms: args.nowMs,
      warn_threshold: args.warnThreshold,
      fail_threshold: args.failThreshold,
    });

    if (result.hit_limit) {
      return args.onLoopLimit(result.elapsed_ms, result.repeat_count);
    }

    if (result.stop_pair_warned !== undefined) {
      args.loopState.stopPairWarned = result.stop_pair_warned;
    }

    return { shouldInjectWarning: result.should_inject_warning };
  } catch {
    // Fallback: pure TS
    const elapsedMs =
      typeof args.loopState.startedAtMs === 'number' && Number.isFinite(args.loopState.startedAtMs)
        ? Math.max(0, (args.nowMs ?? Date.now()) - args.loopState.startedAtMs)
        : 0;
    const pairRepeatCount =
      typeof args.loopState.stopPairRepeatCount === 'number' && Number.isFinite(args.loopState.stopPairRepeatCount)
        ? Math.max(0, Math.floor(args.loopState.stopPairRepeatCount))
        : 0;
    if (elapsedMs >= 900_000 || pairRepeatCount >= args.failThreshold) {
      return args.onLoopLimit(elapsedMs, pairRepeatCount);
    }
    if (pairRepeatCount >= args.warnThreshold && !args.loopState.stopPairWarned) {
      args.loopState.stopPairWarned = true;
      return { shouldInjectWarning: true };
    }
    return { shouldInjectWarning: false };
  }
}
