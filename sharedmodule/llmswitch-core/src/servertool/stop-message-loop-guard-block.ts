import { evaluateLoopGuardWithNative } from '../native/router-hotpath/native-servertool-core-semantics.js';

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
}
