type StopMessageLoopStateLike = {
  startedAtMs?: number;
  stopPairRepeatCount?: number;
  stopPairWarned?: boolean;
};

export function evaluateStopMessageLoopGuard(args: {
  loopState: StopMessageLoopStateLike | null;
  nowMs?: number;
  stageTimeoutMs: number;
  warnThreshold: number;
  failThreshold: number;
  onStageTimeout: (elapsedMs: number) => never;
  onLoopLimit: (elapsedMs: number, repeatCount: number) => never;
}): { shouldInjectWarning: boolean } {
  if (!args.loopState) {
    return { shouldInjectWarning: false };
  }
  const elapsedMs =
    typeof args.loopState.startedAtMs === 'number' && Number.isFinite(args.loopState.startedAtMs)
      ? Math.max(0, (args.nowMs ?? Date.now()) - args.loopState.startedAtMs)
      : 0;
  if (elapsedMs >= args.stageTimeoutMs) {
    return args.onStageTimeout(elapsedMs);
  }

  const pairRepeatCount =
    typeof args.loopState.stopPairRepeatCount === 'number' && Number.isFinite(args.loopState.stopPairRepeatCount)
      ? Math.max(0, Math.floor(args.loopState.stopPairRepeatCount))
      : 0;
  if (pairRepeatCount >= args.failThreshold) {
    return args.onLoopLimit(elapsedMs, pairRepeatCount);
  }
  if (pairRepeatCount >= args.warnThreshold && !args.loopState.stopPairWarned) {
    args.loopState.stopPairWarned = true;
    return { shouldInjectWarning: true };
  }
  return { shouldInjectWarning: false };
}
